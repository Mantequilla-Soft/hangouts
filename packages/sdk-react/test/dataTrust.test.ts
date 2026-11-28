import { describe, expect, it } from 'vitest';
import {
  DATA_TOPIC_TRUST, decodeData, hostFromMetadata, isSentBy, isServerSent,
  readBoostPacket, readCaptionPacket, readChatPacket, readDrawPacket, readGamePacket,
  readHandRaisePacket, readPollPacket, readRaidPacket, readViewStatePacket, readVolumePacket,
} from '../src/lib/dataTrust.js';
import { encodeCaption } from '../src/lib/liveCaptions.js';
import { parsePoll } from '../src/lib/polls.js';
import { parseRaid } from '../src/hooks/useRaid.js';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
/** What LiveKit gives for a server send (RoomService.sendData). */
const SERVER = undefined;
const HOST = 'badadib';
const host = { identity: HOST, name: HOST };
const fan = { identity: 'fan', name: 'fan' };
const guest = { identity: 'guest-x1', name: 'Zed' };
const NOW = 1_700_000_000_000;

describe('sender basics', () => {
  it('a packet with no participant is the server; a participant is not', () => {
    expect(isServerSent(undefined)).toBe(true);
    expect(isServerSent(null)).toBe(true);
    expect(isServerSent(fan)).toBe(false);
    expect(isServerSent({})).toBe(false);
  });

  it('isSentBy needs a real identity on both sides', () => {
    expect(isSentBy(host, HOST)).toBe(true);
    expect(isSentBy(fan, HOST)).toBe(false);
    expect(isSentBy(undefined, HOST)).toBe(false);
    expect(isSentBy({ identity: '' }, '')).toBe(false);
    expect(isSentBy(host, null)).toBe(false);
  });

  it('reads the host from room metadata, and decodes only JSON objects', () => {
    expect(hostFromMetadata(JSON.stringify({ host: HOST }))).toBe(HOST);
    expect(hostFromMetadata('{bad')).toBe('');
    expect(hostFromMetadata(undefined)).toBe('');
    expect(hostFromMetadata(JSON.stringify({ host: 5 }))).toBe('');
    expect(decodeData(enc([1, 2]))).toBeNull();
    expect(decodeData(new TextEncoder().encode('nope'))).toBeNull();
    expect(decodeData(enc({ a: 1 }))).toEqual({ a: 1 });
  });

  it('names a trust class for every topic the SDK listens to', () => {
    expect(DATA_TOPIC_TRUST).toEqual({
      boost: 'server', poll: 'server', raid: 'server', game: 'server', rewards: 'server', bounty: 'server',
      chat: 'participant', 'hand-raise': 'participant',
      captions: 'host', 'view-state': 'host', volume: 'host', draw: 'drawer',
    });
  });
});

describe('chat', () => {
  const line = { type: 'chat', identity: 'badadib', name: 'badadib', isHost: true, text: ' hi ', timestamp: NOW - 1000 };

  it('takes identity and name from the LiveKit sender, never the payload', () => {
    const got = readChatPacket(enc(line), fan, NOW);
    expect(got).toEqual({ kind: 'line', line: { id: `fan-${NOW - 1000}`, identity: 'fan', name: 'fan', text: 'hi', timestamp: NOW - 1000 } });
    expect(readChatPacket(enc(line), guest, NOW)).toMatchObject({ line: { identity: 'guest-x1', name: 'Zed' } });
    // No display name: the identity.
    expect(readChatPacket(enc(line), { identity: 'fan' }, NOW)).toMatchObject({ line: { name: 'fan' } });
    expect((readChatPacket(enc(line), fan, NOW) as { line: Record<string, unknown> }).line.isHost).toBeUndefined();
  });

  it('clamps a line dated into the future but keeps the id the backlog uses', () => {
    const got = readChatPacket(enc({ ...line, timestamp: NOW + 3_600_000 }), fan, NOW);
    expect(got).toMatchObject({ line: { id: `fan-${NOW + 3_600_000}`, timestamp: NOW + 5000 } });
    expect(readChatPacket(enc({ type: 'chat', text: 'x' }), fan, NOW)).toMatchObject({ line: { id: `fan-${NOW}`, timestamp: NOW } });
  });

  it('drops empty or non-text lines, and a "chat" line the server never sends', () => {
    expect(readChatPacket(enc({ ...line, text: '   ' }), fan, NOW)).toBeNull();
    expect(readChatPacket(enc({ ...line, text: 5 }), fan, NOW)).toBeNull();
    expect(readChatPacket(enc(line), { identity: '' }, NOW)).toBeNull();
    expect(readChatPacket(enc(line), SERVER, NOW)).toBeNull();
    expect(readChatPacket(new TextEncoder().encode('{'), fan, NOW)).toBeNull();
  });

  it('a delete or purge counts only from the server', () => {
    expect(readChatPacket(enc({ type: 'chat-delete', id: 'fan-1' }), SERVER)).toEqual({ kind: 'delete', id: 'fan-1' });
    expect(readChatPacket(enc({ type: 'chat-purge', identity: 'guest-bad' }), SERVER)).toEqual({ kind: 'purge', identity: 'guest-bad' });
    expect(readChatPacket(enc({ type: 'chat-delete', id: 'fan-1' }), guest)).toBeNull();
    expect(readChatPacket(enc({ type: 'chat-purge', identity: 'fan' }), host)).toBeNull();
  });

  it('a system line (a raid arriving) counts only from the server', () => {
    const sys = { type: 'system', id: 'raid-1', identity: 'badadib', name: 'badadib', text: 'raid!', timestamp: NOW, system: { kind: 'raid', from: 'badadib', viewers: 12 } };
    expect(readChatPacket(enc(sys), SERVER, NOW)).toEqual({
      kind: 'line',
      line: { id: 'raid-1', identity: 'badadib', name: 'badadib', text: 'raid!', timestamp: NOW, system: { kind: 'raid', from: 'badadib', viewers: 12 } },
    });
    expect(readChatPacket(enc(sys), fan, NOW)).toBeNull();
  });
});

describe('server topics', () => {
  const boost = { type: 'boost', id: 'b1', room: 'r', sender: 'fan', message: 'gg', amount: '5.000', asset: 'HBD', usdAmount: 5, txId: 't', timestamp: NOW };

  it('boost: the server card is accepted, a participant-made card is not', () => {
    expect(readBoostPacket(enc(boost), SERVER)).toMatchObject({ id: 'b1', usdAmount: 5 });
    expect(readBoostPacket(enc(boost), fan)).toBeNull();
    expect(readBoostPacket(enc(boost), host)).toBeNull();
    expect(readBoostPacket(enc({ ...boost, usdAmount: 'lots' }), SERVER)).toBeNull();
    expect(readBoostPacket(enc({ ...boost, type: 'other' }), SERVER)).toBeNull();
  });

  it('poll: server updates only', () => {
    const poll = { id: 'p1', kind: 'prediction', question: 'Who wins?', options: [], status: 'open', host: HOST };
    expect(parsePoll(readPollPacket(enc({ type: 'poll', poll }), SERVER))).toMatchObject({ id: 'p1' });
    expect(readPollPacket(enc({ type: 'poll', poll }), guest)).toBeNull();
    expect(readPollPacket(enc({ type: 'poll' }), SERVER)).toBeNull();
    expect(parsePoll(null)).toBeNull();
  });

  it('raid: start, go and cancel from the server; a forged raid-go to another page is dropped', () => {
    const raid = { id: 'r1', from: HOST, target: { roomName: 'fan-room', host: 'fan', title: 'Hi' }, viewers: 3, endsInMs: 0 };
    for (const type of ['raid-start', 'raid-go', 'raid-cancel'] as const) {
      expect(readRaidPacket(enc({ type, raid }), SERVER)).toEqual({ type, raid });
    }
    expect(parseRaid(readRaidPacket(enc({ type: 'raid-go', raid }), SERVER)?.raid)).toMatchObject({ id: 'r1' });
    const evil = { ...raid, target: { roomName: '../../phish', host: 'x', title: 'Free HIVE' } };
    expect(readRaidPacket(enc({ type: 'raid-go', raid: evil }), guest)).toBeNull();
    expect(readRaidPacket(enc({ type: 'raid-go', raid }), host)).toBeNull();
    expect(readRaidPacket(enc({ type: 'raid-other', raid }), SERVER)).toBeNull();
  });

  it('game: server messages only', () => {
    const ended = { type: 'game:ended', gameId: 'chess', result: { winner: 'fan' } };
    expect(readGamePacket(enc(ended), SERVER)).toMatchObject({ type: 'game:ended', gameId: 'chess' });
    expect(readGamePacket(enc(ended), fan)).toBeNull();
    expect(readGamePacket(enc({ type: 'game:broadcast', payload: { type: 'chess_move' } }), host)).toBeNull();
    expect(readGamePacket(enc({ type: 'chat' }), SERVER)).toBeNull();
  });
});

describe('host topics', () => {
  it('captions: from the host only', () => {
    const cap = encodeCaption({ t: 'cap', id: 1, text: 'hello there', final: true, lang: 'en' });
    expect(readCaptionPacket(cap, host, HOST)).toMatchObject({ text: 'hello there', final: true });
    expect(readCaptionPacket(cap, fan, HOST)).toBeNull();
    expect(readCaptionPacket(cap, SERVER, HOST)).toBeNull();
    expect(readCaptionPacket(cap, host, '')).toBeNull();
  });

  it('view-state: from the host only', () => {
    const vs = { type: 'view-state', focusedIdentity: 'fan', suppressScreenAutoFocus: true, timestamp: NOW };
    expect(readViewStatePacket(enc(vs), host, HOST)).toEqual(vs);
    expect(readViewStatePacket(enc(vs), fan, HOST)).toBeNull();
    expect(readViewStatePacket(enc({ type: 'view-state' }), host, HOST))
      .toEqual({ type: 'view-state', focusedIdentity: null, suppressScreenAutoFocus: false, timestamp: 0 });
  });

  it('volume: from the host only, clamped to 0..1', () => {
    const v = { type: 'volume', identity: 'fan', volume: 0.4, timestamp: NOW };
    expect(readVolumePacket(enc(v), host, HOST)).toEqual(v);
    expect(readVolumePacket(enc({ ...v, identity: HOST, volume: 0 }), guest, HOST)).toBeNull();
    expect(readVolumePacket(enc({ ...v, volume: 9 }), host, HOST)).toMatchObject({ volume: 1 });
    expect(readVolumePacket(enc({ ...v, volume: 'x' }), host, HOST)).toBeNull();
  });
});

describe('hand-raise', () => {
  it('your own hand: the identity is the sender', () => {
    expect(readHandRaisePacket(enc({ type: 'hand_raise', raised: true, identity: 'fan', timestamp: NOW }), fan, HOST))
      .toEqual({ type: 'hand_raise', raised: true, identity: 'fan', timestamp: NOW });
    // No identity in the payload: still the sender's hand.
    expect(readHandRaisePacket(enc({ type: 'hand_raise', raised: false }), fan, HOST))
      .toEqual({ type: 'hand_raise', raised: false, identity: 'fan', timestamp: 0 });
  });

  it('only the host lowers someone else, and nobody raises someone else', () => {
    const lower = { type: 'hand_raise', raised: false, identity: 'fan', timestamp: NOW };
    expect(readHandRaisePacket(enc(lower), host, HOST)).toEqual(lower);
    expect(readHandRaisePacket(enc(lower), guest, HOST)).toBeNull();
    expect(readHandRaisePacket(enc({ ...lower, raised: true }), host, HOST)).toBeNull();
    expect(readHandRaisePacket(enc({ ...lower, raised: true }), guest, HOST)).toBeNull();
    expect(readHandRaisePacket(enc(lower), SERVER, HOST)).toBeNull();
    expect(readHandRaisePacket(enc({ type: 'hand_raise', raised: 'yes' }), fan, HOST)).toBeNull();
  });
});

describe('draw', () => {
  const stroke = { id: 's1', points: [[0.1, 0.2], [0.3, 0.4]], color: '#1a1a1a', width: 4 };
  it('strokes and clears from the current drawer only', () => {
    expect(readDrawPacket(enc({ type: 'draw_stroke', stroke }), fan, 'fan')).toEqual({ type: 'draw_stroke', stroke });
    expect(readDrawPacket(enc({ type: 'draw_clear' }), fan, 'fan')).toEqual({ type: 'draw_clear' });
    expect(readDrawPacket(enc({ type: 'draw_clear' }), guest, 'fan')).toBeNull();
    expect(readDrawPacket(enc({ type: 'draw_stroke', stroke }), SERVER, 'fan')).toBeNull();
  });

  it('drops a malformed stroke', () => {
    expect(readDrawPacket(enc({ type: 'draw_stroke', stroke: { ...stroke, points: [['a', 1]] } }), fan, 'fan')).toBeNull();
    expect(readDrawPacket(enc({ type: 'draw_stroke', stroke: { ...stroke, width: 'big' } }), fan, 'fan')).toBeNull();
    expect(readDrawPacket(enc({ type: 'draw_stroke' }), fan, 'fan')).toBeNull();
    expect(readDrawPacket(enc({ type: 'other' }), fan, 'fan')).toBeNull();
  });
});
