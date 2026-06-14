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
