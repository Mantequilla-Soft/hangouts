// The OBS dock's control link: a resettable dock key, traded for a dock session
// that runs the owner's live controls (polls, raids, boost settings) and
// nothing else, ends the moment the key is reset, and never moves the payout.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { memoryPointsStore, memoryPollArchive, resetPolls, setPollStores } from '../../src/lib/polls.js';
import { resetPollBroadcasts } from '../../src/routes/polls.js';
import { verifySessionToken } from '../../src/lib/session.js';
import { memoryClipStore, setClipStore, clipStore, type StreamClip } from '../../src/lib/streamClips.js';

const lk = vi.hoisted(() => ({ rooms: new Map<string, { name: string; metadata: string }>() }));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()].filter((r) => !names || names.includes(r.name)).map((r) => ({ ...r }))),
    listParticipants: vi.fn().mockResolvedValue([]),
    updateRoomMetadata: vi.fn(async (name: string, metadata: string) => {
      const r = lk.rooms.get(name);
      if (r) r.metadata = metadata;
    }),
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

vi.mock('../../src/lib/streamTemplates.js', async () => {
  const { createFakeStore } = await import('../helpers/fakeTemplateStore.js');
  return createFakeStore();
});

const ROOM = 'badadib-dock1';
let app: FastifyInstance;
let login: { authorization: string };
let n = 0;
const ip = () => `10.9.${Math.floor(++n / 250)}.${n % 250 + 1}`;

beforeAll(async () => {
  app = await buildApp();
  login = { authorization: `Bearer ${await makeToken('badadib')}` };
});

beforeEach(async () => {
  lk.rooms.clear();
  lk.rooms.set(ROOM, { name: ROOM, metadata: JSON.stringify({ host: 'badadib', mode: 'standalone', boost: { enabled: true, minBoostUsd: 0, creatorPayoutAccount: 'badadib' } }) });
  resetPolls();
  resetPollBroadcasts();
  setPollStores({ points: memoryPointsStore(), archive: memoryPollArchive() });
  setClipStore(memoryClipStore());
  const store = await import('../../src/lib/streamTemplates.js') as unknown as { _dockKeys: Map<string, unknown> };
  store._dockKeys.clear();
});

const dockKey = async () => (await app.inject({ method: 'GET', url: '/dock-key', headers: login, remoteAddress: ip() })).json().key as string;
const dockSession = async (key: string) => app.inject({ method: 'POST', url: '/dock/session', payload: { key }, remoteAddress: ip() });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const startPoll = (headers: { authorization: string }) => app.inject({
  method: 'POST', url: `/rooms/${ROOM}/polls`, headers, payload: { question: 'Next game?', options: ['Chess', 'Draw'], durationSec: 60 }, remoteAddress: ip(),
});

describe('the dock key', () => {
  it('is the owner\'s, stays the same until reset, and needs a login to read', async () => {
    const a = await dockKey();
    expect(a).toMatch(/^badadib\./);
    expect(await dockKey()).toBe(a);
    const reset = await app.inject({ method: 'POST', url: '/dock-key/reset', headers: login, remoteAddress: ip() });
    expect(reset.json().key).not.toBe(a);
    expect((await app.inject({ method: 'GET', url: '/dock-key', remoteAddress: ip() })).statusCode).toBe(401);
  });

  it('trades for a dock session; a wrong or old key does not', async () => {
    const key = await dockKey();
    const ok = await dockSession(key);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ username: 'badadib' });
    expect((await dockSession(`${key}x`)).statusCode).toBe(401);
    expect((await dockSession('nodot')).statusCode).toBe(401);
  });
});

describe('a dock session', () => {
  it('runs the live controls: a poll, the raid list and settings, the boost settings', async () => {
    const token = (await dockSession(await dockKey())).json().token;
    expect((await startPoll(bearer(token))).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/raids/settings', headers: bearer(token), remoteAddress: ip() })).statusCode).toBe(200);
    const boost = await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/boost`, headers: bearer(token), payload: { minBoostUsd: 2, creatorPayoutAccount: 'badadib' }, remoteAddress: ip() });
    expect(boost.statusCode).toBe(200);
    expect(boost.json().boost).toMatchObject({ minBoostUsd: 2, creatorPayoutAccount: 'badadib' });
  });

  it('never changes where boost money goes', async () => {
    const token = (await dockSession(await dockKey())).json().token;
    const res = await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/boost`, headers: bearer(token), payload: { creatorPayoutAccount: 'thief' }, remoteAddress: ip() });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(lk.rooms.get(ROOM)!.metadata).boost.creatorPayoutAccount).toBe('badadib');
    // A real login still can.
    const owner = await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/boost`, headers: login, payload: { creatorPayoutAccount: 'badadib.fund' }, remoteAddress: ip() });
    expect(owner.statusCode).toBe(200);
  });

  it('is not a login anywhere else', async () => {
    const token = (await dockSession(await dockKey())).json().token;
    for (const [method, url] of [['GET', '/stream-secret'], ['GET', '/dock-key'], ['GET', '/templates']] as const) {
      expect((await app.inject({ method, url, headers: bearer(token), remoteAddress: ip() })).statusCode).toBe(401);
    }
    await expect(verifySessionToken(token)).rejects.toThrow();
  });

  it('ends when the key is reset', async () => {
    const token = (await dockSession(await dockKey())).json().token;
    await app.inject({ method: 'POST', url: '/dock-key/reset', headers: login, remoteAddress: ip() });
    expect((await startPoll(bearer(token))).statusCode).toBe(401);
  });

  it('only on the owner\'s own room', async () => {
    lk.rooms.set('alice-room', { name: 'alice-room', metadata: JSON.stringify({ host: 'alice', mode: 'standalone' }) });
    const token = (await dockSession(await dockKey())).json().token;
    const res = await app.inject({ method: 'POST', url: '/rooms/alice-room/polls', headers: bearer(token), payload: { question: 'x?', options: ['a', 'b'], durationSec: 60 }, remoteAddress: ip() });
    expect(res.statusCode).toBe(403);
  });
});

describe('the dock\'s clip suggestions', () => {
  let seq = 0;
  const clip = (over: Partial<StreamClip>): StreamClip => ({
    id: `c${++seq}`, room: 'badadib-old', host: 'badadib', clipper: 'viewer1', source: 'viewer', file: `c${seq}.mp4`,
    offsetSec: 60, durationSec: 30, status: 'ready',
    createdAt: new Date(Date.now() - 60_000 + seq), expiresAt: new Date(Date.now() + 3_600_000), ...over,
  });
  const ask = (headers: { authorization: string }) => app.inject({ method: 'GET', url: '/dock/clips', headers, remoteAddress: ip() });

  it('counts the ready clips viewers made of the host\'s newest clipped stream', async () => {
    const store = await clipStore();
    await store.insert(clip({ room: 'badadib-older', createdAt: new Date(Date.now() - 600_000) }));
    await store.insert(clip({}));
    await store.insert(clip({ clipper: 'viewer2' }));
    await store.insert(clip({ clipper: 'viewer2', status: 'pending' }));
    await store.insert(clip({ clipper: 'badadib', source: 'host' }));
    await store.insert(clip({ clipper: null, source: 'auto' }));
    const token = (await dockSession(await dockKey())).json().token;
    const res = await ask(bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ room: 'badadib-old', count: 2, clippers: 2 });
  });

  it('says none when no viewer clipped, and needs the dock session or a login', async () => {
    expect((await ask(login)).json()).toEqual({ room: null, count: 0, clippers: 0 });
    expect((await app.inject({ method: 'GET', url: '/dock/clips', remoteAddress: ip() })).statusCode).toBe(401);
  });
});
