import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { recordGuestIp, isGuestBanned, clearRoomBans } from '../../src/lib/guestBans.js';

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

const ROOM = 'test-room-ban';
const GUEST_IDENTITY = 'guest-abc123';
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
    numParticipants: 1,
    maxParticipants: 500,
  }];
}

let app: FastifyInstance;
let hostToken: string;

beforeAll(async () => {
  app = await buildApp();
  hostToken = await makeToken(HOST);
});

beforeEach(() => {
  clearRoomBans(ROOM);
  vi.clearAllMocks();
});

describe('POST /rooms/:name/participants/:identity/ban', () => {
  it('returns 204 and kicks the guest when called by the host', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.removeParticipant).mockResolvedValue(undefined as any);

    recordGuestIp(ROOM, GUEST_IDENTITY, '5.5.5.5');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/participants/${GUEST_IDENTITY}/ban`,
      headers: { Authorization: `Bearer ${hostToken}` },
    });

    expect(res.statusCode).toBe(204);
    expect(vi.mocked(roomService.removeParticipant)).toHaveBeenCalledWith(ROOM, GUEST_IDENTITY);
  });

  it('returns 403 when the caller is not the host', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);

    const notHostToken = await makeToken('bob');
    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/participants/${GUEST_IDENTITY}/ban`,
      headers: { Authorization: `Bearer ${notHostToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when the identity is not a guest (no guest- prefix)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/participants/alice/ban`,
      headers: { Authorization: `Bearer ${hostToken}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the room does not exist', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/participants/${GUEST_IDENTITY}/ban`,
      headers: { Authorization: `Bearer ${hostToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 204 even when the guest has already left the room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.removeParticipant).mockRejectedValue(new Error('Participant not found'));

    recordGuestIp(ROOM, GUEST_IDENTITY, '5.5.5.5');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/participants/${GUEST_IDENTITY}/ban`,
      headers: { Authorization: `Bearer ${hostToken}` },
    });

    expect(res.statusCode).toBe(204);
  });

  it('E2E: banned guest cannot rejoin via /listen', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([]);
    vi.mocked(roomService.removeParticipant).mockResolvedValue(undefined as any);

    const GUEST_IP = '9.9.9.9';

    // Guest joins and IP gets recorded
    const joinRes = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
      remoteAddress: GUEST_IP,
    });
    expect(joinRes.statusCode).toBe(200);
    const { identity } = joinRes.json();

    // Host bans the guest
    const banRes = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/participants/${identity}/ban`,
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    expect(banRes.statusCode).toBe(204);

    // Banned guest tries to rejoin from the same IP
    const rejoinRes = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
      remoteAddress: GUEST_IP,
    });
    expect(rejoinRes.statusCode).toBe(403);
    expect(isGuestBanned(ROOM, GUEST_IP)).toBe(true);
  });
});
