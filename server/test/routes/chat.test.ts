import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { addBacklogMessage, getBacklog, resetBacklogs, setBacklogStore } from '../../src/lib/chatBacklog.js';
import { banGuestByIdentity, clearRoomBans, recordGuestIp } from '../../src/lib/guestBans.js';
import { resetKnownRooms } from '../../src/routes/chat.js';

const lk = vi.hoisted(() => ({ rooms: new Map<string, { name: string; metadata: string }>() }));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()].filter((r) => !names || names.includes(r.name))),
    listParticipants: vi.fn().mockResolvedValue([]),
    removeParticipant: vi.fn().mockResolvedValue(undefined),
    updateRoomMetadata: vi.fn(),
    sendData: vi.fn().mockResolvedValue(undefined),
  },
  generateRoomName: vi.fn().mockReturnValue('test-room'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn(async (u: string) => u === 'suspended'),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

const ROOM = 'badadib-chat1';
const setRoom = (meta: Record<string, unknown> = {}) => lk.rooms.set(ROOM, {
  name: ROOM, metadata: JSON.stringify({ host: 'badadib', mode: 'standalone', visibility: 'public', mods: ['mod1'], ...meta }),
});

async function guestToken(room = ROOM, identity = 'guest-abc', canPublishData = true) {
  const at = new AccessToken('test-key', 'test-secret', { identity });
  at.addGrant({ roomJoin: true, room, canPublishData });
  return at.toJwt();
}

let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};

beforeAll(async () => {
  app = await buildApp();
  for (const u of ['badadib', 'fan', 'mod1', 'suspended']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

beforeEach(() => {
  lk.rooms.clear();
  resetBacklogs();
  resetKnownRooms();
  setBacklogStore(null);
  clearRoomBans(ROOM);
  setRoom();
});

const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: `/rooms/${ROOM}/chat`, headers, payload,
});

describe('POST /rooms/:name/chat', () => {
  it('keeps a signed-in viewer line under the id the clients use', async () => {
    const res = await post({ text: ' hi there ', timestamp: Date.now(), name: 'Fan' }, auth.fan);
    expect(res.statusCode).toBe(201);
    const [line] = await getBacklog(ROOM);
    expect(line).toMatchObject({ identity: 'fan', name: 'Fan', text: 'hi there' });
    expect(line.id).toMatch(/^fan-\d+$/);
    // The same line posted twice is kept once.
    const again = await post({ text: 'hi there', timestamp: Number(line.id.split('-')[1]) }, auth.fan);
    expect(again.statusCode).toBe(200);
    expect(await getBacklog(ROOM)).toHaveLength(1);
  });

  it('counts each new line once towards the highlight moments (H13), the second device as the host', async () => {
    const hl = await import('../../src/lib/streamHighlights.js');
    const spy = vi.spyOn(hl, 'noteChat');
    const ts = Date.now();
    await post({ text: 'one', timestamp: ts }, auth.fan);
    await post({ text: 'one', timestamp: ts }, auth.fan);
    await post({ text: 'from my phone', identity: 'badadib~watch' }, auth.badadib);
    expect(spy.mock.calls.map((c) => c.slice(0, 2))).toEqual([[ROOM, 'u:fan'], [ROOM, 'u:badadib']]);
    spy.mockRestore();
  });

  it('lets the host chat as their second-device identity but not as someone else', async () => {
    expect((await post({ text: 'from my phone', identity: 'badadib~watch' }, auth.badadib)).statusCode).toBe(201);
    expect((await post({ text: 'spoof', identity: 'fan' }, auth.badadib)).statusCode).toBe(403);
  });

  it('refuses a suspended account', async () => {
    expect((await post({ text: 'hello' }, auth.suspended)).statusCode).toBe(403);
  });

  it('takes a guest line with that room token, and refuses a token of another room', async () => {
    const ok = await post({ text: 'guest hello', livekitToken: await guestToken() });
    expect(ok.statusCode).toBe(201);
    expect((await getBacklog(ROOM))[0].identity).toBe('guest-abc');
    expect((await post({ text: 'x', livekitToken: await guestToken('other-room') })).statusCode).toBe(401);
    expect((await post({ text: 'x', livekitToken: await guestToken(ROOM, 'guest-ro', false) })).statusCode).toBe(401);
    expect((await post({ text: 'x', livekitToken: 'not-a-token-at-all-really' })).statusCode).toBe(401);
    expect((await post({ text: 'x' })).statusCode).toBe(401);
  });

  it('takes a line from an HLS viewer: no media rights, but data', async () => {
    const at = new AccessToken('test-key', 'test-secret', { identity: 'guest-hls' });
    at.addGrant({ roomJoin: true, room: ROOM, canSubscribe: false, canPublishData: true });
    const res = await post({ text: 'watching on HLS', livekitToken: await at.toJwt() });
    expect(res.statusCode).toBe(201);
    expect((await getBacklog(ROOM))[0].identity).toBe('guest-hls');
  });

  it('refuses a banned guest', async () => {
    recordGuestIp(ROOM, 'guest-abc', '127.0.0.1');
    banGuestByIdentity(ROOM, 'guest-abc');
    expect((await post({ text: 'x', livekitToken: await guestToken() })).statusCode).toBe(403);
  });

  it('looks the room up once, not for every line', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockClear();
    await post({ text: 'one' }, auth.fan);
    await post({ text: 'two' }, auth.fan);
    expect(vi.mocked(roomService.listRooms)).toHaveBeenCalledTimes(1);
  });

  it('404 for a room that does not exist, 400 for blank text', async () => {
    lk.rooms.clear();
    expect((await post({ text: 'x' }, auth.fan)).statusCode).toBe(404);
    setRoom();
    expect((await post({ text: '   ' }, auth.fan)).statusCode).toBe(400);
  });
});

describe('GET /rooms/:name/chat', () => {
  it('returns the newest lines, without those of a suspended account', async () => {
    addBacklogMessage(ROOM, { id: 'fan-1', identity: 'fan', name: 'fan', text: 'one', timestamp: 1 });
    addBacklogMessage(ROOM, { id: 'suspended-2', identity: 'suspended', name: 'x', text: 'bad', timestamp: 2 });
    addBacklogMessage(ROOM, { id: 'guest-a-3', identity: 'guest-a', name: 'Guest', text: 'three', timestamp: 3 });
    const res = await app.inject({ method: 'GET', url: `/rooms/${ROOM}/chat` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().messages.map((m: { text: string }) => m.text)).toEqual(['one', 'three']);
    const one = await app.inject({ method: 'GET', url: `/rooms/${ROOM}/chat?limit=1` });
    expect(one.json().messages.map((m: { text: string }) => m.text)).toEqual(['three']);
  });

  it('asks for a session on a Hive-only room, and 404s an unknown one', async () => {
    setRoom({ visibility: 'hive-internal' });
    expect((await app.inject({ method: 'GET', url: `/rooms/${ROOM}/chat` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/rooms/${ROOM}/chat`, headers: auth.fan })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/rooms/nope/chat' })).statusCode).toBe(404);
  });
});

describe('DELETE /rooms/:name/chat/:id', () => {
  it('the host or a moderator takes a line down for everyone', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    addBacklogMessage(ROOM, { id: 'fan-1', identity: 'fan', name: 'fan', text: 'one', timestamp: 1 });
    addBacklogMessage(ROOM, { id: 'fan-2', identity: 'fan', name: 'fan', text: 'two', timestamp: 2 });
    expect((await app.inject({ method: 'DELETE', url: `/rooms/${ROOM}/chat/fan-1`, headers: auth.badadib })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/rooms/${ROOM}/chat/fan-2`, headers: auth.mod1 })).statusCode).toBe(204);
    expect(await getBacklog(ROOM)).toEqual([]);
    const sent = vi.mocked(roomService.sendData).mock.calls.map((c) => [JSON.parse(new TextDecoder().decode(c[1] as Uint8Array)), c[3]]);
    expect(sent).toContainEqual([{ type: 'chat-delete', id: 'fan-1' }, { topic: 'chat' }]);
  });

  it('refuses viewers, anonymous callers and unknown rooms', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/rooms/${ROOM}/chat/x`, headers: auth.fan })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/rooms/${ROOM}/chat/x` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/rooms/nope/chat/x', headers: auth.badadib })).statusCode).toBe(404);
  });
});

describe('banning a guest', () => {
  it('purges their lines from the backlog and tells the room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    recordGuestIp(ROOM, 'guest-bad', '10.0.0.9');
    addBacklogMessage(ROOM, { id: 'guest-bad-1', identity: 'guest-bad', name: 'Bad', text: 'spam', timestamp: 1 });
    addBacklogMessage(ROOM, { id: 'fan-2', identity: 'fan', name: 'fan', text: 'ok', timestamp: 2 });
    const res = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/participants/guest-bad/ban`, headers: auth.badadib });
    expect(res.statusCode).toBe(204);
    expect((await getBacklog(ROOM)).map((m) => m.identity)).toEqual(['fan']);
    const payloads = vi.mocked(roomService.sendData).mock.calls.map((c) => JSON.parse(new TextDecoder().decode(c[1] as Uint8Array)));
    expect(payloads).toContainEqual({ type: 'chat-purge', identity: 'guest-bad' });
  });
});
