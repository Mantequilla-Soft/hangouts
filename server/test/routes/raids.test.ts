import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { getBacklog, resetBacklogs, setBacklogStore } from '../../src/lib/chatBacklog.js';
import {
  RAID_COOLDOWN_MS, RAID_COUNTDOWN_SEC, acceptsRaids, memoryRaidPrefs, raidCooldownUntil, resetRaids,
  setRaidPrefStore, startRaid, sweepRaids, pendingRaid,
} from '../../src/lib/raids.js';
import { resetRaidScan } from '../../src/routes/raids.js';

const lk = vi.hoisted(() => ({
  rooms: new Map<string, { name: string; metadata: string }>(),
  parts: new Map<string, Array<{ identity: string }>>(),
}));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()].filter((r) => !names || names.includes(r.name))),
    listParticipants: vi.fn(async (room: string) => lk.parts.get(room) ?? []),
    updateRoomMetadata: vi.fn(),
    sendData: vi.fn().mockResolvedValue(undefined),
  },
  generateRoomName: vi.fn().mockReturnValue('test-room'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

function stream(name: string, host: string, extra: Record<string, unknown> = {}, viewers: string[] = []) {
  lk.rooms.set(name, { name, metadata: JSON.stringify({ host, mode: 'standalone', broadcasting: true, title: `${host} live`, ...extra }) });
  lk.parts.set(name, [{ identity: host }, ...viewers.map((identity) => ({ identity }))]);
}

let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};

beforeAll(async () => {
  app = await buildApp();
  for (const u of ['badadib', 'fan', 'other']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

beforeEach(() => {
  vi.clearAllMocks();
  lk.rooms.clear();
  lk.parts.clear();
  resetRaids();
  resetRaidScan();
  resetBacklogs();
  setBacklogStore(null);
  setRaidPrefStore(memoryRaidPrefs());
  stream('badadib-src', 'badadib', {}, ['fan', 'guest-1', 'obs-x', 'badadib~watch']);
  stream('other-live', 'other', { post: { title: 'Other show', thumbnail: 'https://x/t.jpg' } }, ['v1']);
});
afterEach(() => { vi.useRealTimers(); });

async function sent(topic: string) {
  const { roomService } = await import('../../src/lib/livekit.js');
  return vi.mocked(roomService.sendData).mock.calls
    .filter((c) => (c[3] as { topic: string }).topic === topic)
    .map((c) => ({ room: c[0], payload: JSON.parse(new TextDecoder().decode(c[1] as Uint8Array)) }));
}

describe('raid targets', () => {
  it('lists public live streams except your own, unlisted, Hive-only, offline and opted-out ones', async () => {
    stream('hidden', 'h1', { visibility: 'unlisted' });
    stream('hiveonly', 'h2', { visibility: 'hive-internal' });
    stream('notlive', 'h3', { broadcasting: false });
    stream('hostgone', 'h4');
    lk.parts.set('hostgone', [{ identity: 'someone' }]);
    stream('optout', 'h5');
    stream('badadib-other', 'badadib');
    await app.inject({ method: 'PUT', url: '/raids/settings', headers: auth.other, payload: { acceptRaids: true } });
    const h5 = { authorization: `Bearer ${await makeToken('h5')}` };
    await app.inject({ method: 'PUT', url: '/raids/settings', headers: h5, payload: { acceptRaids: false } });

    const res = await app.inject({ method: 'GET', url: '/rooms/badadib-src/raid/targets', headers: auth.badadib });
    expect(res.statusCode).toBe(200);
    expect(res.json().targets).toEqual([
      { roomName: 'other-live', host: 'other', title: 'Other show', viewers: 1, thumbnail: 'https://x/t.jpg' },
    ]);
    expect(res.json().cooldownUntil).toBeNull();
  });

  it('only the host may list targets', async () => {
    expect((await app.inject({ method: 'GET', url: '/rooms/badadib-src/raid/targets', headers: auth.fan })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/rooms/nope/raid/targets', headers: auth.fan })).statusCode).toBe(404);
  });
});

describe('a raid', () => {
  it('counts down in the source room, then lands a chat line in the target and sends viewers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const res = await app.inject({ method: 'POST', url: '/rooms/badadib-src/raid', headers: auth.badadib, payload: { target: 'other-live' } });
    expect(res.statusCode).toBe(201);
    // fan and the guest; not the OBS overlay or the host's own second device.
    expect(res.json().raid).toMatchObject({ from: 'badadib', viewers: 2, target: { roomName: 'other-live', host: 'other', title: 'Other show' } });
    expect((await sent('raid'))[0]).toMatchObject({ room: 'badadib-src', payload: { type: 'raid-start' } });

    const late = await app.inject({ method: 'GET', url: '/rooms/badadib-src/raid' });
    expect(late.json().raid.id).toBe(res.json().raid.id);

    await vi.advanceTimersByTimeAsync(RAID_COUNTDOWN_SEC * 1000 + 10);
    const chat = await sent('chat');
    expect(chat[0]).toMatchObject({ room: 'other-live', payload: { type: 'system', system: { kind: 'raid', from: 'badadib', viewers: 2 } } });
    expect((await sent('raid')).map((s) => s.payload.type)).toEqual(['raid-start', 'raid-go']);
    const [line] = await getBacklog('other-live');
    expect(line.text).toBe('badadib is raiding with 2 viewers');
    expect((await app.inject({ method: 'GET', url: '/rooms/badadib-src/raid' })).json().raid).toBeNull();
  });

  it('rate-limits: one countdown at a time, then the host cooldown', async () => {
    const first = await app.inject({ method: 'POST', url: '/rooms/badadib-src/raid', headers: auth.badadib, payload: { target: 'other-live' } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/rooms/badadib-src/raid', headers: auth.badadib, payload: { target: 'other-live' } });
    expect(second.statusCode).toBe(409);
    resetRaids();
    startRaid({ from: 'badadib', fromRoom: 'elsewhere', target: { roomName: 'x', host: 'x', title: 'x' }, viewers: 0 }, () => {});
    const third = await app.inject({ method: 'POST', url: '/rooms/badadib-src/raid', headers: auth.badadib, payload: { target: 'other-live' } });
    expect(third.statusCode).toBe(429);
  });

  it('the host can call it off during the countdown, which gives the cooldown back', async () => {
    await app.inject({ method: 'POST', url: '/rooms/badadib-src/raid', headers: auth.badadib, payload: { target: 'other-live' } });
    expect((await app.inject({ method: 'DELETE', url: '/rooms/badadib-src/raid', headers: auth.fan })).statusCode).toBe(403);
    const res = await app.inject({ method: 'DELETE', url: '/rooms/badadib-src/raid', headers: auth.badadib });
    expect(res.statusCode).toBe(204);
    expect((await sent('raid')).map((s) => s.payload.type)).toEqual(['raid-start', 'raid-cancel']);
    expect(raidCooldownUntil('badadib')).toBe(0);
    expect((await app.inject({ method: 'DELETE', url: '/rooms/badadib-src/raid', headers: auth.badadib })).statusCode).toBe(404);
  });

  it('refuses: not the host, a conference, itself, a target gone or opted out', async () => {
    const post = (target: string, who = 'badadib', room = 'badadib-src') => app.inject({ method: 'POST', url: `/rooms/${room}/raid`, headers: auth[who], payload: { target } });
    expect((await post('other-live', 'fan')).statusCode).toBe(403);
    expect((await post('badadib-src')).statusCode).toBe(400);
    expect((await post('missing')).statusCode).toBe(404);
    expect((await post('other-live', 'badadib', 'nope')).statusCode).toBe(404);
    lk.rooms.set('badadib-conf', { name: 'badadib-conf', metadata: JSON.stringify({ host: 'badadib', mode: 'conference' }) });
    expect((await post('other-live', 'badadib', 'badadib-conf')).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/raids/settings', headers: auth.other, payload: { acceptRaids: false } });
    expect((await post('other-live')).statusCode).toBe(403);
    const s = await app.inject({ method: 'GET', url: '/raids/settings', headers: auth.other });
    expect(s.json()).toEqual({ acceptRaids: false });
  });
});

describe('raid limits', () => {
  it('a stream receives one raid per gap, and the sweep forgets old limits', () => {
    const now = 1_000_000;
    startRaid({ from: 'a', fromRoom: 'ra', target: { roomName: 't', host: 't', title: 't' }, viewers: 1 }, () => {}, now);
    expect(() => startRaid({ from: 'b', fromRoom: 'rb', target: { roomName: 't', host: 't', title: 't' }, viewers: 1 }, () => {}, now + 1000)).toThrow(/raided a moment ago/);
    sweepRaids(new Set(['ra']), now + RAID_COOLDOWN_MS + 1);
    expect(raidCooldownUntil('a', now + RAID_COOLDOWN_MS + 1)).toBe(0);
    expect(pendingRaid('ra')).not.toBeNull();
    sweepRaids(new Set(), now + RAID_COOLDOWN_MS + 1);
    expect(pendingRaid('ra')).toBeNull();
  });

  it('the setting fails open when its store cannot answer', async () => {
    setRaidPrefStore({ get: async () => { throw new Error('down'); }, set: async () => {} });
    expect(await acceptsRaids('someone')).toBe(true);
  });
});
