import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(),
    listParticipants: vi.fn(),
    createRoom: vi.fn(),
    removeParticipant: vi.fn(),
    updateParticipant: vi.fn(),
    updateRoomMetadata: vi.fn(),
    deleteRoom: vi.fn(),
    sendData: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('test-room'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

vi.mock('../../src/lib/boostPayout.js', () => ({
  sendBoostPayout: vi.fn().mockResolvedValue(undefined),
}));

describe('POST /boosts/ingest', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([{
      name: 'alice-room-abc123',
      metadata: JSON.stringify({
        host: 'alice',
        boost: { enabled: true, minBoostUsd: 1, creatorPayoutAccount: 'alice' },
      }),
      numParticipants: 0,
      maxParticipants: 500,
    }] as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([]);
    vi.mocked(roomService.sendData).mockResolvedValue(undefined as any);
  });

  it('returns 503 when BOOSTS_ENABLED is false (default in test env)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/boosts/ingest',
      payload: {
        txId: 'tx-000001',
        opIndex: 1,
        blockNum: 10,
        timestamp: Date.now(),
        to: 'boostwallet',
        amount: '2.000 HBD',
        memo: JSON.stringify({
          version: 1,
          room: 'alice-room-abc123',
          message: 'Hello host',
          sender: 'bob',
          nonce: 'nonce-123456',
        }),
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ message: 'Boosts are disabled' });
  });

  it('returns 400 for invalid ingest payloads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/boosts/ingest',
      payload: { txId: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /boosts/ledger', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });

  it('returns an empty array when no boosts have been ingested', async () => {
    const res = await app.inject({ method: 'GET', url: '/boosts/ledger' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('accepts an optional room query parameter without error', async () => {
    const res = await app.inject({ method: 'GET', url: '/boosts/ledger?room=some-room-abc123' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('POST /rooms/:name/boosts/points', () => {
  let app: FastifyInstance;
  let store: Awaited<ReturnType<typeof import('../../src/lib/points.js')['memoryPointsStore']>>;
  const auth: Record<string, { authorization: string }> = {};
  const ROOM = 'alice-room-abc123';

  beforeAll(async () => {
    app = await buildApp();
    const { makeToken } = await import('../setup.js');
    for (const u of ['alice', 'fan']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([{
      name: ROOM,
      metadata: JSON.stringify({ host: 'alice', boost: { enabled: true, minBoostUsd: 0.5 } }),
    }] as any);
    vi.mocked(roomService.sendData).mockResolvedValue(undefined as any);
    const points = await import('../../src/lib/points.js');
    store = points.memoryPointsStore();
    store.balances.set('fan', 6000);
    points.setPointsStore(store);
  });

  const send = (payload: Record<string, unknown>, who = 'fan') => app.inject({
    method: 'POST', url: `/rooms/${ROOM}/boosts/points`, headers: auth[who], payload,
  });

  it('spends the points and shows the boost, worth 1 HBD per 10,000 points', async () => {
    const res = await send({ amount: 5000, message: '  Great   stream! ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ balance: 1000, boost: { asset: 'POINTS', amount: '5000', usdAmount: 0.5, sender: 'fan', recipient: 'alice', message: 'Great stream!' } });
    expect(res.json().boost.belowMinimum).toBeUndefined();
    expect(store.balances.get('fan')).toBe(1000);
    const { roomService } = await import('../../src/lib/livekit.js');
    const [call] = vi.mocked(roomService.sendData).mock.calls;
    expect(call[3]).toMatchObject({ topic: 'boost' });
  });

  it('flags a points boost under the host minimum like any other', async () => {
    const res = await send({ amount: 2500, message: 'hi' });
    expect(res.json().boost.belowMinimum).toBe(true);
  });

  it('refuses too few points, too small a boost, your own stream and boosts switched off', async () => {
    expect((await send({ amount: 7000, message: 'hi' })).statusCode).toBe(400);
    expect((await send({ amount: 100, message: 'hi' })).json().message).toContain('2,500');
    expect((await send({ amount: 2500, message: 'hi' }, 'alice')).statusCode).toBe(403);
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([{ name: ROOM, metadata: JSON.stringify({ host: 'alice', boost: { enabled: false } }) }] as any);
    expect((await send({ amount: 2500, message: 'hi' })).statusCode).toBe(409);
    expect(store.balances.get('fan')).toBe(6000);
  });

  it('gives the points back when the boost cannot reach the stream', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.sendData).mockRejectedValue(new Error('down'));
    expect((await send({ amount: 3000, message: 'hi' })).statusCode).toBe(503);
    expect(store.balances.get('fan')).toBe(6000);
  });

  it('needs a signed-in account', async () => {
    const res = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/boosts/points`, payload: { amount: 2500, message: 'hi' } });
    expect(res.statusCode).toBe(401);
  });
});
