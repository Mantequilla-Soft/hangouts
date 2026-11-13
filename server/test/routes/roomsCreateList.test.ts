import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn().mockResolvedValue([]),
    listParticipants: vi.fn().mockResolvedValue([]),
    createRoom: vi.fn(async (o: { name: string }) => ({ name: o.name })),
    removeParticipant: vi.fn(), updateParticipant: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-new1'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

vi.mock('../../src/lib/streamQuota.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/streamQuota.js')>()),
  nextFreeStreamAt: vi.fn().mockResolvedValue(null),
  recordGoLive: vi.fn().mockResolvedValue(undefined),
}));

let app: FastifyInstance;
let aliceAuth: { authorization: string };
// POST /rooms is rate limited per IP (12 / 5 min): every create gets its own address.
let ipCounter = 0;
const nextIp = () => `10.20.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

beforeAll(async () => {
  app = await buildApp();
  aliceAuth = { authorization: `Bearer ${await makeToken('alice')}` };
});

beforeEach(async () => {
  vi.clearAllMocks();
  const users = await import('../../src/lib/users.js');
  vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: false });
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
  const quota = await import('../../src/lib/streamQuota.js');
  vi.mocked(quota.nextFreeStreamAt).mockResolvedValue(null);
});

afterEach(() => { vi.useRealTimers(); });

function create(payload: unknown, headers: Record<string, string> = {}, remoteAddress = nextIp()) {
  return app.inject({ method: 'POST', url: '/rooms', headers: { ...aliceAuth, ...headers }, payload: payload as object, remoteAddress });
}

async function createdMetadata() {
  const { roomService } = await import('../../src/lib/livekit.js');
  const arg = vi.mocked(roomService.createRoom).mock.calls[0][0] as { metadata: string };
  return JSON.parse(arg.metadata);
}

describe('POST /rooms (create)', () => {
  it('creates a conference room for a free host with an audio-only host token and no quota check', async () => {
    const { createLivekitToken } = await import('../../src/lib/livekit.js');
    const quota = await import('../../src/lib/streamQuota.js');
    const res = await create({ title: 'Morning chat' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      token: 'mock-token', isPremium: false,
      room: { name: 'alice-new1', title: 'Morning chat', host: 'alice', visibility: 'public', mode: 'conference' },
    });
    expect(createLivekitToken).toHaveBeenCalledWith('alice-new1', 'alice', { canPublish: true, canPublishData: true, premium: false });
    expect(quota.nextFreeStreamAt).not.toHaveBeenCalled();
  });

  it('writes default metadata: public, guests allowed, boost on and paid to the host, post seeded from the inputs', async () => {
    await create({ title: 'T', description: 'D', backgroundImage: 'https://img/x.png', tags: ['a', 'b'] });
    const meta = await createdMetadata();
    expect(meta).toMatchObject({
      title: 'T', host: 'alice', visibility: 'public', allowGuests: true, mode: 'conference',
      boost: { enabled: true, minBoostUsd: 0, creatorPayoutAccount: 'alice' },
      post: { title: 'T', description: 'D', thumbnail: 'https://img/x.png', tags: ['a', 'b'] },
    });
  });

  it('a hive-internal room disallows guests and keeps a valid language tag', async () => {
    await create({ title: 'T', visibility: 'hive-internal', language: 'pt-BR' });
    expect(await createdMetadata()).toMatchObject({ visibility: 'hive-internal', allowGuests: false, language: 'pt-BR' });
  });

  it('drops a language that is not a language tag', async () => {
    await create({ title: 'T', language: '!!' });
    expect((await createdMetadata()).language).toBeUndefined();
  });

  it('stores the boost settings sent with the create, normalising the payout account', async () => {
    await create({ title: 'T', boost: { enabled: false, minBoostUsd: 2.5, creatorPayoutAccount: ' Treasury ' } });
    expect((await createdMetadata()).boost).toEqual({ enabled: false, minBoostUsd: 2.5, creatorPayoutAccount: 'treasury' });
  });

  it('records only the hostname of the Origin header', async () => {
    const res = await create({ title: 'T' }, { origin: 'https://3speak.tv/some/path?session=secret' });
    expect(res.json().room.origin).toBe('3speak.tv');
  });

  it('falls back to the Referer hostname when there is no Origin', async () => {
    const res = await create({ title: 'T' }, { referer: 'https://studio.example.org/x?y=1' });
    expect(res.json().room.origin).toBe('studio.example.org');
  });

  it('ignores a malformed Origin header instead of failing the create', async () => {
    const res = await create({ title: 'T' }, { origin: 'not a url' });
    expect(res.statusCode).toBe(201);
    expect(res.json().room.origin).toBeUndefined();
  });

  it('refuses a free host\'s second stream of the day with 429 daily_stream_limit, before any room exists', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const quota = await import('../../src/lib/streamQuota.js');
    const retryAt = new Date('2026-11-14T09:30:00Z');
    vi.mocked(quota.nextFreeStreamAt).mockResolvedValueOnce(retryAt);
    const res = await create({ title: 'Stream', mode: 'standalone' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'daily_stream_limit', retryAt: retryAt.toISOString() });
    expect(res.json().message).toContain('09:30 UTC');
    expect(quota.nextFreeStreamAt).toHaveBeenCalledWith('alice');
    expect(roomService.createRoom).not.toHaveBeenCalled();
  });

  it('lets a free host open a stream when the quota allows it', async () => {
    const quota = await import('../../src/lib/streamQuota.js');
    const res = await create({ title: 'Stream', mode: 'standalone' });
    expect(res.statusCode).toBe(201);
    expect(res.json().room.mode).toBe('standalone');
    expect(quota.nextFreeStreamAt).toHaveBeenCalledTimes(1);
  });

  it('a Pro host skips the daily limit and gets a premium (video) token', async () => {
    const users = await import('../../src/lib/users.js');
    const quota = await import('../../src/lib/streamQuota.js');
    const { createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: true });
    const res = await create({ title: 'Stream', mode: 'standalone' });
    expect(res.statusCode).toBe(201);
    expect(res.json().isPremium).toBe(true);
    expect(quota.nextFreeStreamAt).not.toHaveBeenCalled();
    expect(vi.mocked(createLivekitToken).mock.calls[0][2]).toMatchObject({ premium: true });
  });

  it.each([
    ['a missing title', {}],
    ['an empty title', { title: '' }],
    ['a title over 64 characters', { title: 'x'.repeat(65) }],
    ['an unknown visibility', { title: 'T', visibility: 'secret' }],
    ['an unknown mode', { title: 'T', mode: 'theatre' }],
    ['a negative minimum boost', { title: 'T', boost: { minBoostUsd: -1 } }],
    ['a payout account shorter than 3 characters', { title: 'T', boost: { creatorPayoutAccount: 'ab' } }],
    ['more than 10 tags', { title: 'T', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ['a description over 5000 characters', { title: 'T', description: 'x'.repeat(5001) }],
  ])('rejects %s with 400', async (_label, payload) => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const res = await create(payload);
    expect(res.statusCode).toBe(400);
    expect(roomService.createRoom).not.toHaveBeenCalled();
  });

  it('accepts a full 5000 character markdown description', async () => {
    expect((await create({ title: 'T', description: 'x'.repeat(5000) })).statusCode).toBe(201);
  });

  it('requires a session (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/rooms', payload: { title: 'T' }, remoteAddress: nextIp() });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a suspended account (403)', async () => {
    const users = await import('../../src/lib/users.js');
    vi.mocked(users.isUserBanned).mockResolvedValueOnce(true);
    expect((await create({ title: 'T' })).statusCode).toBe(403);
  });

  it('rate limits room creation to 12 per IP per 5 minutes', async () => {
    const ip = '10.99.99.99';
    for (let i = 0; i < 12; i++) expect((await create({ title: `T${i}` }, {}, ip)).statusCode).toBe(201);
    expect((await create({ title: 'one too many' }, {}, ip)).statusCode).toBe(429);
    expect((await create({ title: 'other ip' })).statusCode).toBe(201);
  });
});

function lkRoom(name: string, meta: Record<string, unknown> | string, extra: Record<string, unknown> = {}) {
  return {
    name,
    metadata: typeof meta === 'string' ? meta : JSON.stringify(meta),
    numParticipants: 3,
    maxParticipants: 500,
    creationTime: BigInt(1_700_000_000),
    ...extra,
  };
}

describe('GET /rooms (lobby)', () => {
  // The list cache lives in the plugin, so each test gets a fresh app.
  let lobbyApp: FastifyInstance;
  beforeEach(async () => { lobbyApp = await buildApp(); });

  it('hides unlisted rooms and does not count OBS overlay connections as listeners', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([
      lkRoom('pub', { title: 'Public', host: 'alice', visibility: 'public', mode: 'conference', createdAt: '2026-11-13T10:00:00Z' }),
      lkRoom('hidden', { title: 'Hidden', host: 'bob', visibility: 'unlisted' }),
    ] as never);
    vi.mocked(roomService.listParticipants).mockResolvedValue([
      { identity: 'alice' }, { identity: 'guest-x' }, { identity: 'obs-abc' },
    ] as never);
    const res = await lobbyApp.inject({ method: 'GET', url: '/rooms' });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'pub', title: 'Public', host: 'alice', numParticipants: 2, maxParticipants: 500, createdAt: '2026-11-13T10:00:00Z' });
  });

  it('falls back to the room name, an unknown host and the LiveKit creation time when metadata is missing or broken', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([
      lkRoom('broken', '{oops', { numParticipants: 0 }),
      lkRoom('empty', '', { numParticipants: 0 }),
    ] as never);
    const list = (await lobbyApp.inject({ method: 'GET', url: '/rooms' })).json();
    expect(list[0]).toMatchObject({ name: 'broken', title: 'broken', host: 'unknown', createdAt: new Date(1_700_000_000_000).toISOString() });
    expect(list[1]).toMatchObject({ name: 'empty', title: 'empty', host: 'unknown' });
    // An empty room is not scanned for participants.
    expect(roomService.listParticipants).not.toHaveBeenCalled();
  });

  it('uses the raw participant count when LiveKit cannot list participants', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('r', { host: 'a' }, { numParticipants: 7 })] as never);
    vi.mocked(roomService.listParticipants).mockRejectedValue(new Error('gone'));
    expect((await lobbyApp.inject({ method: 'GET', url: '/rooms' })).json()[0].numParticipants).toBe(7);
  });

  it('shares one scan between requests for 3 seconds, then scans again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('r', { host: 'a' }, { numParticipants: 0 })] as never);

    await lobbyApp.inject({ method: 'GET', url: '/rooms' });
    await lobbyApp.inject({ method: 'GET', url: '/rooms' });
    expect(roomService.listRooms).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-13T12:00:04Z'));
    await lobbyApp.inject({ method: 'GET', url: '/rooms' });
    expect(roomService.listRooms).toHaveBeenCalledTimes(2);
  });

  it('concurrent cache misses wait on a single scan', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    let release!: (v: unknown) => void;
    vi.mocked(roomService.listRooms).mockReturnValueOnce(new Promise((r) => { release = r; }) as never);
    const a = lobbyApp.inject({ method: 'GET', url: '/rooms' });
    const b = lobbyApp.inject({ method: 'GET', url: '/rooms' });
    await new Promise((r) => setTimeout(r, 20));
    release([lkRoom('r', { host: 'a' }, { numParticipants: 0 })]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.json()).toEqual(rb.json());
    expect(roomService.listRooms).toHaveBeenCalledTimes(1);
  });

  it('a failed scan is not cached: the next request scans again', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockRejectedValueOnce(new Error('livekit down'));
    expect((await lobbyApp.inject({ method: 'GET', url: '/rooms' })).statusCode).toBe(500);
    vi.mocked(roomService.listRooms).mockResolvedValueOnce([] as never);
    const res = await lobbyApp.inject({ method: 'GET', url: '/rooms' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('GET /streams (discover feed)', () => {
  let feedApp: FastifyInstance;
  beforeEach(async () => { feedApp = await buildApp(); });

  it('lists streams and rooms (not unlisted, not mode-less), live first, with viewer counts', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([
      lkRoom('stream-idle', { host: 'carol', mode: 'standalone', createdAt: '2026-11-13T11:00:00Z' }),
      lkRoom('stream-live', {
        host: 'alice', mode: 'standalone', broadcasting: true, createdAt: '2026-11-13T09:00:00Z',
        title: 'Room title', post: { title: 'Post title', description: 'pd', thumbnail: 'th', tags: ['x'] },
      }),
      lkRoom('conf', { host: 'bob', mode: 'conference', title: 'Conf', createdAt: '2026-11-13T10:00:00Z' }),
      lkRoom('unlisted', { host: 'dan', mode: 'standalone', visibility: 'unlisted', broadcasting: true }),
      lkRoom('legacy', { host: 'eve' }),
    ] as never);
    vi.mocked(roomService.listParticipants).mockImplementation(async (name: string) => ({
      'stream-live': [{ identity: 'alice' }, { identity: 'v1' }, { identity: 'guest-2' }, { identity: 'obs-ingress-x' }],
      'stream-idle': [{ identity: 'v9' }],
      conf: [{ identity: 'bob' }, { identity: 'obs-1' }],
    } as Record<string, unknown[]>)[name] as never ?? []);

    const res = await feedApp.inject({ method: 'GET', url: '/streams' });
    expect(res.headers['cache-control']).toBe('no-store');
    const list = res.json();
    expect(list.map((s: { name: string }) => s.name)).toEqual(['conf', 'stream-live', 'stream-idle']);
    const live = list.find((s: { name: string }) => s.name === 'stream-live');
    expect(live).toMatchObject({ live: true, viewers: 2, title: 'Post title', description: 'pd', thumbnail: 'th', tags: ['x'] });
    expect(list.find((s: { name: string }) => s.name === 'conf')).toMatchObject({ live: true, viewers: 1, title: 'Conf', tags: [] });
    expect(list.find((s: { name: string }) => s.name === 'stream-idle')).toMatchObject({ live: false, viewers: 1 });
  });

  it('a stale broadcasting flag is not live once the host has left', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('s', { host: 'alice', mode: 'standalone', broadcasting: true })] as never);
    vi.mocked(roomService.listParticipants).mockResolvedValue([{ identity: 'v1' }] as never);
    expect((await feedApp.inject({ method: 'GET', url: '/streams' })).json()[0]).toMatchObject({ live: false, viewers: 1 });
  });

  it('treats a stream as not live with no viewers when LiveKit cannot list its participants', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('s', { host: 'alice', mode: 'standalone', broadcasting: true })] as never);
    vi.mocked(roomService.listParticipants).mockRejectedValue(new Error('gone'));
    expect((await feedApp.inject({ method: 'GET', url: '/streams' })).json()[0]).toMatchObject({ live: false, viewers: 0 });
  });
});

describe('GET /health', () => {
  let healthApp: FastifyInstance;
  beforeEach(async () => { healthApp = await buildApp(); });

  it('reports aggregate session and viewer counts only', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([
      lkRoom('s1', { host: 'alice', mode: 'standalone', broadcasting: true }),
      lkRoom('s2', { host: 'bob', mode: 'standalone', broadcasting: true }),
      lkRoom('c1', { host: 'carol', mode: 'conference' }),
      lkRoom('bad', '{nope'),
    ] as never);
    vi.mocked(roomService.listParticipants).mockImplementation(async (name: string) => {
      if (name === 'bad') throw new Error('vanished');
      return ({
        s1: [{ identity: 'alice' }, { identity: 'v1' }, { identity: 'obs-x' }],
        s2: [{ identity: 'v2' }],
        c1: [{ identity: 'carol' }, { identity: 'dan' }],
      } as Record<string, unknown[]>)[name] as never;
    });
    const res = await healthApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      sessions: { total: 4, conference: 2, standalone: 2, live: 1 },
      viewers: 3,
    });
    expect(typeof body.uptime).toBe('number');
    expect(JSON.stringify(body)).not.toContain('alice');
  });

  it('is cached for 5 seconds so a polling monitor cannot hammer LiveKit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([] as never);
    await healthApp.inject({ method: 'GET', url: '/health' });
    await healthApp.inject({ method: 'GET', url: '/health' });
    expect(roomService.listRooms).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-13T12:00:06Z'));
    await healthApp.inject({ method: 'GET', url: '/health' });
    expect(roomService.listRooms).toHaveBeenCalledTimes(2);
  });

  it('answers 503 when LiveKit is unavailable', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await healthApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, error: 'LiveKit unavailable' });
  });
});

describe('GET /rooms/:name', () => {
  it('returns the public room details', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('r1', {
      title: 'Hello', host: 'alice', mode: 'standalone', visibility: 'public', broadcasting: true,
      collabGuest: 'bob', liveAt: '2026-11-13T10:00:00Z', portrait: true, createdAt: '2026-11-13T09:00:00Z',
    })] as never);
    const res = await app.inject({ method: 'GET', url: '/rooms/r1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      name: 'r1', title: 'Hello', host: 'alice', mode: 'standalone', broadcasting: true,
      collabGuest: 'bob', liveAt: '2026-11-13T10:00:00Z', portrait: true, numParticipants: 3,
    });
    expect(body.headless).toBeUndefined();
    expect(body.watermark).toBeUndefined();
  });

  it('flags a headless (OBS) stream and whether it carries the non-Pro watermark', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('r1', { host: 'alice', headless: true })] as never);
    expect((await app.inject({ method: 'GET', url: '/rooms/r1' })).json()).toMatchObject({ headless: true, watermark: false });
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('r1', { host: 'alice', headless: true, watermark: true })] as never);
    expect((await app.inject({ method: 'GET', url: '/rooms/r1' })).json()).toMatchObject({ headless: true, watermark: true });
  });

  it('falls back to defaults for broken metadata', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([lkRoom('r1', 'garbage')] as never);
    expect((await app.inject({ method: 'GET', url: '/rooms/r1' })).json()).toMatchObject({ title: 'r1', host: 'unknown' });
  });

  it('returns 404 for a room that does not exist', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([] as never);
    expect((await app.inject({ method: 'GET', url: '/rooms/nope' })).statusCode).toBe(404);
  });
});
