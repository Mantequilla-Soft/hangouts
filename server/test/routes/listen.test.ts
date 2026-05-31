import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { recordGuestIp, banGuestByIdentity, clearRoomBans } from '../../src/lib/guestBans.js';

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
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

const ROOM = 'test-room-listen';

/** Minimal LiveKit room object with metadata */
function makeRoom(meta: Record<string, unknown> = {}) {
  return [{
    name: ROOM,
    metadata: JSON.stringify({
      title: 'Test Room',
      host: 'alice',
      createdAt: new Date().toISOString(),
      visibility: 'public',
      allowGuests: true,
      ...meta,
    }),
    numParticipants: 0,
    maxParticipants: 500,
  }];
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  clearRoomBans(ROOM);
  vi.clearAllMocks();
});

describe('POST /rooms/:name/listen', () => {
  it('returns 200 with isGuest:true and a guest identity for a public room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isGuest).toBe(true);
    expect(body.identity).toMatch(/^guest-/);
    expect(typeof body.token).toBe('string');
  });

  it('returns 200 when displayName is provided', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: { displayName: 'Alice' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when the room does not exist', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for a hive-internal room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom({ visibility: 'hive-internal' }) as any);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for a legacy room with allowGuests:false', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom({ allowGuests: false }) as any);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for a banned IP', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);

    // Simulate a prior ban: record the IP then ban it
    recordGuestIp(ROOM, 'guest-prev', '127.0.0.1');
    banGuestByIdentity(ROOM, 'guest-prev');

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
      remoteAddress: '127.0.0.1',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/removed/i);
  });

  it('returns 409 when the guest cap is reached', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    const guests = Array.from({ length: 100 }, (_, i) => ({ identity: `guest-${i}` }));
    vi.mocked(roomService.listParticipants).mockResolvedValue(guests as any);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when displayName is too short (schema validation)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: { displayName: 'X' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('records the guest IP after a successful join', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(makeRoom() as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: `/rooms/${ROOM}/listen`,
      payload: {},
      remoteAddress: '10.0.0.1',
    });

    expect(res.statusCode).toBe(200);
    // The identity was recorded — banning it should now work (returns true)
    const { identity } = res.json();
    expect(banGuestByIdentity(ROOM, identity)).toBe(true);
  });
});
