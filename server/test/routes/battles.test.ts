import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ParticipantInfo_State } from '@livekit/protocol';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';

const lk = vi.hoisted(() => ({
  rooms: new Map<string, { name: string; metadata: string }>(),
  present: new Map<string, string[]>(),
}));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()]
      .filter((r) => !names || names.includes(r.name)).map((r) => ({ ...r }))),
    listParticipants: vi.fn(async (name: string) => (lk.present.get(name) ?? [])
      .map((identity) => ({ identity, state: ParticipantInfo_State.ACTIVE }))),
    updateRoomMetadata: vi.fn(async (name: string, metadata: string) => {
      const r = lk.rooms.get(name);
      if (!r) throw new Error('Room not found');
      r.metadata = metadata;
    }),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('x'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

function stream(name: string, host: string, extra: Record<string, unknown> = {}) {
  lk.rooms.set(name, { name, metadata: JSON.stringify({ host, mode: 'standalone', broadcasting: true, title: `${host} live`, ...extra }) });
  lk.present.set(name, [host]);
}
const battleIn = (name: string) => JSON.parse(lk.rooms.get(name)!.metadata).battle;

let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};

beforeAll(async () => {
  app = await buildApp();
  for (const u of ['badadib', 'fan', 'third']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

beforeEach(() => {
  lk.rooms.clear();
  lk.present.clear();
  stream('badadib-aaa', 'badadib');
  stream('fan-bbb', 'fan');
});

describe('battle routes', () => {
  it('needs a session for every host action', async () => {
    for (const url of ['/battles/badadib-aaa/invite', '/battles/badadib-aaa/respond', '/battles/badadib-aaa/end', '/battles/badadib-aaa/settle', '/battles/badadib-aaa/link']) {
      const res = await app.inject({ method: 'POST', url, payload: { opponent: 'fan', durationSec: 180, accept: true } });
      expect(res.statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/battles/candidates' })).statusCode).toBe(401);
  });

  it('runs an invite, accept, link and early end', async () => {
    const list = await app.inject({ method: 'GET', url: '/battles/candidates', headers: auth.badadib });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ streams: [{ room: 'fan-bbb', host: 'fan', title: 'fan live' }], durations: [180, 300, 600] });

    const inv = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/invite', headers: auth.badadib, payload: { opponent: 'fan', durationSec: 300 } });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().battle).toMatchObject({ state: 'invited', b: { room: 'fan-bbb' } });

    const pub = await app.inject({ method: 'GET', url: '/battles/fan-bbb' });
    expect(pub.json().battle.state).toBe('invited');

    const wrong = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/respond', headers: auth.badadib, payload: { accept: true } });
    expect(wrong.statusCode).toBe(403);

    const acc = await app.inject({ method: 'POST', url: '/battles/fan-bbb/respond', headers: auth.fan, payload: { accept: true } });
    expect(acc.statusCode).toBe(200);
    expect(battleIn('badadib-aaa').state).toBe('live');

    const link = await app.inject({ method: 'POST', url: '/battles/fan-bbb/link', headers: auth.fan, payload: {} });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({ room: 'badadib-aaa', host: 'badadib', identity: 'obs-battle-fan' });

    const early = await app.inject({ method: 'POST', url: '/battles/fan-bbb/settle', headers: auth.fan, payload: {} });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('not_yet');

    const dropped = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/end', headers: auth.badadib, payload: { reason: 'dropped' } });
    expect(dropped.statusCode).toBe(409);

    const end = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/end', headers: auth.badadib, payload: { reason: 'ended' } });
    expect(end.statusCode).toBe(200);
    expect(end.json().battle).toMatchObject({ state: 'ended', winner: null, endReason: 'ended' });
    expect(battleIn('fan-bbb').state).toBe('ended');
  });

  it('end works with an empty body; errors map to status codes', async () => {
    await app.inject({ method: 'POST', url: '/battles/badadib-aaa/invite', headers: auth.badadib, payload: { opponent: 'fan-bbb', durationSec: 180 } });
    const res = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/end', headers: auth.badadib, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().battle.endReason).toBe('cancelled');

    expect((await app.inject({ method: 'GET', url: '/battles/nope' })).statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/invite', headers: auth.badadib, payload: { opponent: 'fan', durationSec: 7 } });
    expect(bad.statusCode).toBe(400);
    const none = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/invite', headers: auth.badadib, payload: { opponent: 'nobody', durationSec: 180 } });
    expect(none.statusCode).toBe(404);
    const notMine = await app.inject({ method: 'POST', url: '/battles/badadib-aaa/link', headers: auth.third, payload: {} });
    expect(notMine.statusCode).toBe(403);
  });

  it('maps a LiveKit room-not-found error to 404 and rethrows anything else', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    await app.inject({ method: 'POST', url: '/battles/badadib-aaa/invite', headers: auth.badadib, payload: { opponent: 'fan', durationSec: 180 } });
    vi.mocked(roomService.listRooms).mockRejectedValueOnce(new Error('Room not found'));
    const gone = await app.inject({ method: 'GET', url: '/battles/badadib-aaa' });
    expect(gone.statusCode).toBe(404);
    vi.mocked(roomService.listRooms).mockRejectedValueOnce(new Error('boom'));
    const boom = await app.inject({ method: 'GET', url: '/battles/badadib-aaa' });
    expect(boom.statusCode).toBe(500);
  });

  it('shares the candidate scan between callers for a few seconds', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    await new Promise((r) => setTimeout(r, 3100));
    vi.mocked(roomService.listRooms).mockClear();
    const a = await app.inject({ method: 'GET', url: '/battles/candidates', headers: auth.fan });
    const b = await app.inject({ method: 'GET', url: '/battles/candidates', headers: auth.third });
    expect(a.json().streams.map((s: { host: string }) => s.host)).toEqual(['badadib']);
    expect(b.json().streams.map((s: { host: string }) => s.host).sort()).toEqual(['badadib', 'fan']);
    expect(vi.mocked(roomService.listRooms)).toHaveBeenCalledTimes(1);
  });
});
