import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(),
    listParticipants: vi.fn(),
    createRoom: vi.fn(),
    removeParticipant: vi.fn(),
    updateParticipant: vi.fn(),
    updateRoomMetadata: vi.fn(),
    deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('test-room'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

const ROOM = 'test-room-perms';
const HOST = 'alice';

function makeRoom(host = HOST) {
  return [{
    name: ROOM,
    metadata: JSON.stringify({
      title: 'Test Room',
      host,
      createdAt: new Date().toISOString(),
      visibility: 'public',
    }),
    numParticipants: 2,
    maxParticipants: 500,
  }];
}

function makeUpdatedParticipant(identity: string, canPublish: boolean) {
  return { identity, permission: { canPublish, canSubscribe: true, canPublishData: true } };
}

let app: FastifyInstance;
let hostToken: string;

beforeAll(async () => {
  app = await buildApp();
  hostToken = await makeToken(HOST);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /rooms/:name/participants/:identity/permissions', () => {
  it('host can promote a Hive user to speaker', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.updateParticipant).mockResolvedValue(
      makeUpdatedParticipant('bob', true) as any,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${ROOM}/participants/bob/permissions`,
      headers: { Authorization: `Bearer ${hostToken}` },
      payload: { canPublish: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().canPublish).toBe(true);
    expect(vi.mocked(roomService.updateParticipant)).toHaveBeenCalledWith(
      ROOM,
      'bob',
      undefined,
      expect.objectContaining({ canPublish: true }),
    );
  });

  it('host can promote a guest (guest- prefix no longer blocked)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.updateParticipant).mockResolvedValue(
      makeUpdatedParticipant('guest-abc', true) as any,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${ROOM}/participants/guest-abc/permissions`,
      headers: { Authorization: `Bearer ${hostToken}` },
      payload: { canPublish: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().canPublish).toBe(true);
  });

  it('host can demote a speaker back to listener', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.updateParticipant).mockResolvedValue(
      makeUpdatedParticipant('bob', false) as any,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${ROOM}/participants/bob/permissions`,
      headers: { Authorization: `Bearer ${hostToken}` },
      payload: { canPublish: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().canPublish).toBe(false);
  });

  it('returns 403 when the caller is not the host', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);

    const notHostToken = await makeToken('charlie');
    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${ROOM}/participants/bob/permissions`,
      headers: { Authorization: `Bearer ${notHostToken}` },
      payload: { canPublish: true },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when the room does not exist', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/rooms/${ROOM}/participants/bob/permissions`,
      headers: { Authorization: `Bearer ${hostToken}` },
      payload: { canPublish: true },
    });

    expect(res.statusCode).toBe(404);
  });
});
