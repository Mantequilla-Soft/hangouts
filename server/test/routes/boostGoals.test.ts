import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';


// Stateful room fake: what updateRoomMetadata writes, listRooms returns.
const lk = vi.hoisted(() => ({
  rooms: new Map<string, { name: string; metadata: string }>(),
}));

const ingress = vi.hoisted(() => ({
  listIngress: vi.fn(),
  createIngress: vi.fn(),
  deleteIngress: vi.fn(),
}));

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('livekit-server-sdk')>();
  class FakeIngressClient {
    listIngress = ingress.listIngress;
    createIngress = ingress.createIngress;
    deleteIngress = ingress.deleteIngress;
  }
  return { ...orig, IngressClient: FakeIngressClient };
});

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()]
      .filter((r) => !names || names.includes(r.name))
      .map((r) => ({ ...r }))),
    listParticipants: vi.fn().mockResolvedValue([]),
    createRoom: vi.fn(),
    removeParticipant: vi.fn(),
    updateParticipant: vi.fn().mockResolvedValue({}),
    updateRoomMetadata: vi.fn(async (name: string, metadata: string) => {
      const r = lk.rooms.get(name);
      if (r) r.metadata = metadata;
    }),
    deleteRoom: vi.fn(async (name: string) => { lk.rooms.delete(name); }),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-hc'),
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

const ROOM = 'alice-hc';

function setRoom(meta: Record<string, unknown>) {
  lk.rooms.set(ROOM, { name: ROOM, metadata: JSON.stringify({ title: 't', host: 'alice', visibility: 'public', ...meta }) });
}
function roomMeta(): Record<string, unknown> {
  return JSON.parse(lk.rooms.get(ROOM)!.metadata);
}

let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};

beforeAll(async () => {
  app = await buildApp();
  for (const u of ['alice', 'bob']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

beforeEach(async () => {
  vi.clearAllMocks();
  lk.rooms.clear();
  const users = await import('../../src/lib/users.js');
  vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: false });
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
  const quota = await import('../../src/lib/streamQuota.js');
  vi.mocked(quota.nextFreeStreamAt).mockResolvedValue(null);
  const { roomService } = await import('../../src/lib/livekit.js');
  vi.mocked(roomService.listParticipants).mockResolvedValue([]);
  ingress.listIngress.mockResolvedValue([]);
  ingress.createIngress.mockResolvedValue({ ingressId: 'IN_new', streamKey: 'newkey' });
  ingress.deleteIngress.mockResolvedValue(undefined);
});

const req = (method: 'PATCH' | 'POST' | 'DELETE', path: string, who: string | null, payload?: unknown) => app.inject({
  method,
  url: `/rooms/${ROOM}${path}`,
  headers: who ? auth[who] : {},
  ...(payload === undefined ? {} : { payload: payload as object }),
});
const get = (path: string) => app.inject({ method: 'GET', url: `/rooms/${ROOM}${path}` });

describe('PATCH /rooms/:name/boost: goal, tiers, alerts, presets', () => {
  it('stores all four and returns the merged settings', async () => {
    setRoom({ boost: { enabled: true, minBoostUsd: 1 } });
    const res = await req('PATCH', '/boost', 'alice', {
      goal: { title: 'A new mic', targetHbd: 50 },
      tiers: false,
      alerts: { sound: true, tts: true, ttsMinHbd: 5 },
      presets: [10, 1, 5],
    });
    expect(res.statusCode).toBe(200);
    const boost = {
      enabled: true, minBoostUsd: 1,
      goal: { title: 'A new mic', targetHbd: 50 },
      tiers: false,
      alerts: { sound: true, tts: true, ttsMinHbd: 5 },
      presets: [1, 5, 10],
    };
    expect(res.json()).toEqual({ boost });
    expect(roomMeta().boost).toEqual(boost);
  });

  it('a later partial update keeps the goal; goal null removes it', async () => {
    setRoom({ boost: { enabled: true, minBoostUsd: 0, goal: { title: 'mic', targetHbd: 5 } } });
    await req('PATCH', '/boost', 'alice', { minBoostUsd: 2 });
    expect(roomMeta().boost.goal).toEqual({ title: 'mic', targetHbd: 5 });
    await req('PATCH', '/boost', 'alice', { goal: null });
    expect(roomMeta().boost.goal).toBeUndefined();
  });

  it('refuses bad values with 400 and changes nothing', async () => {
    setRoom({ boost: { enabled: true, minBoostUsd: 0 } });
    for (const payload of [
      { goal: { title: 'mic', targetHbd: 0 } },
      { goal: { title: 'mic' } },
      { goal: { title: 'x'.repeat(81), targetHbd: 5 } },
      { presets: [1, 2, 3, 4, 5, 6, 7] },
      { presets: [-1] },
      { alerts: { ttsMinHbd: -3 } },
      { tiers: 'yes' },
    ]) {
      const res = await req('PATCH', '/boost', 'alice', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(roomMeta().boost).toEqual({ enabled: true, minBoostUsd: 0 });
  });

  it('only the host can set a goal', async () => {
    setRoom({});
    expect((await req('PATCH', '/boost', 'bob', { goal: { title: 'x', targetHbd: 1 } })).statusCode).toBe(403);
  });

  it('raising the goal past the progress clears "reached"; a covered target counts as reached', async () => {
    setRoom({
      boost: { enabled: true, minBoostUsd: 0, goal: { title: 'mic', targetHbd: 10 } },
      boostStats: { count: 3, totalHbd: 12, goalHbd: 12, supporters: [], goalReachedAt: '2026-11-15T10:00:00.000Z', goalReachedFor: 10 },
    });
    await req('PATCH', '/boost', 'alice', { goal: { title: 'mic', targetHbd: 20 } });
    expect(roomMeta().boostStats.goalReachedAt).toBeUndefined();
    expect(roomMeta().boostStats.count).toBe(3);
    await req('PATCH', '/boost', 'alice', { goal: { title: 'mic', targetHbd: 12 } });
    expect(roomMeta().boostStats.goalReachedFor).toBe(12);
  });

  it('a goal on a stream with no boosts yet does not create a tally', async () => {
    setRoom({ boost: { enabled: true, minBoostUsd: 0 } });
    await req('PATCH', '/boost', 'alice', { goal: { title: 'mic', targetHbd: 10 } });
    expect(roomMeta().boostStats).toBeUndefined();
  });
});

describe('boost summary', () => {
  const stats = {
    count: 6, totalHbd: 21, goalHbd: 20,
    supporters: [
      { account: 'fan', hbd: 6, count: 2 }, { account: 'badadib', hbd: 5, count: 1 }, { account: 'fan2', hbd: 4, count: 1 },
      { account: 'fan3', hbd: 3, count: 1 }, { account: 'fan4', hbd: 2, count: 1 }, { account: 'fan5', hbd: 1, count: 1 },
    ],
  };

  it('GET /rooms/:name/boost/summary gives the goal progress, totals and the top 5', async () => {
    setRoom({ boost: { enabled: true, minBoostUsd: 0, goal: { title: 'mic', targetHbd: 50 } }, boostStats: stats });
    const res = await get('/boost/summary');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      goal: { title: 'mic', targetHbd: 50, progressHbd: 20, reached: false },
      count: 6,
      totalHbd: 21,
      top: stats.supporters.slice(0, 5),
    });
  });

  it('the summary needs no session and 404s for a missing room', async () => {
    expect((await get('/boost/summary')).statusCode).toBe(404);
    setRoom({});
    expect((await get('/boost/summary')).json()).toEqual({ goal: null, count: 0, totalHbd: 0, top: [] });
  });

  it('GET /rooms/:name carries the same summary', async () => {
    setRoom({ boost: { enabled: true, minBoostUsd: 0 }, boostStats: stats, createdAt: '2026-11-15T10:00:00.000Z' });
    const res = await get('');
    expect(res.json().boostSummary).toMatchObject({ goal: null, count: 6, totalHbd: 21 });
  });
});
