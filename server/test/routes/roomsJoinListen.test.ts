import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { banGuestByIdentity, recordGuestIp, isGuestBanned, clearRoomBans } from '../../src/lib/guestBans.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(), listParticipants: vi.fn().mockResolvedValue([]), createRoom: vi.fn(),
    removeParticipant: vi.fn(), updateParticipant: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-jl'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

vi.mock('../../src/lib/streamStats.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/streamStats.js')>()),
  recordViewerJoin: vi.fn(),
}));

const ROOM = 'alice-jl';
function room(meta: Record<string, unknown>) {
  return [{ name: ROOM, metadata: JSON.stringify({ title: 't', host: 'alice', visibility: 'public', ...meta }) }];
}

let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};
// /listen is rate limited per IP (60 / 5 min): give each request its own address.
let ipCounter = 0;
const nextIp = () => `10.30.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

beforeAll(async () => {
  app = await buildApp();
  for (const u of ['alice', 'bob', 'carol']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

beforeEach(async () => {
  vi.clearAllMocks();
  clearRoomBans(ROOM);
  const { roomService } = await import('../../src/lib/livekit.js');
  vi.mocked(roomService.listParticipants).mockResolvedValue([]);
  const users = await import('../../src/lib/users.js');
  vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: false });
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
});

const join = (who: string) => app.inject({ method: 'POST', url: `/rooms/${ROOM}/join`, headers: auth[who] });

describe('POST /rooms/:name/join', () => {
  it('a viewer of a conference room gets a non-publishing token that can still send data', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'conference' }) as never);
    const res = await join('bob');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: 'mock-token', roomName: ROOM, identity: 'bob', isHost: false, isPremium: false });
    expect(createLivekitToken).toHaveBeenCalledWith(ROOM, 'bob', { canPublish: false, canPublishData: true, premium: false, name: undefined });
    // Only the host or the collab guest are checked for a second device.
    expect(roomService.listParticipants).not.toHaveBeenCalled();
  });

  it('passes the caller\'s Pro status through to the token and the response', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    const users = await import('../../src/lib/users.js');
    vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: true });
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    const res = await join('alice');
    expect(res.json()).toMatchObject({ isHost: true, isPremium: true });
    expect(vi.mocked(createLivekitToken).mock.calls[0][2]).toMatchObject({ canPublish: true, premium: true });
  });

  it('the approved collab guest joining fresh (no other device) gets publish rights back', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'standalone', collabGuest: 'bob' }) as never);
    vi.mocked(roomService.listParticipants).mockResolvedValue([{ identity: 'alice', state: 2 }] as never);
    const res = await join('bob');
    expect(res.json()).toMatchObject({ identity: 'bob', isHost: false });
    expect(res.json().liveElsewhere).toBeUndefined();
    expect(vi.mocked(createLivekitToken).mock.calls[0][2]).toMatchObject({ canPublish: true });
  });

  it('the host of a headless stream never triggers the second-device check', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ headless: true }) as never);
    const res = await join('alice');
    expect(res.json()).toMatchObject({ identity: 'alice~watch', isHost: false });
    expect(res.json().liveElsewhere).toBeUndefined();
    expect(roomService.listParticipants).not.toHaveBeenCalled();
  });

  it('broken room metadata makes everyone a plain viewer', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([{ name: ROOM, metadata: '{oops' }] as never);
    expect((await join('alice')).json()).toMatchObject({ identity: 'alice', isHost: false });
  });

  it('returns 404 for a room that does not exist', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([] as never);
    expect((await join('alice')).statusCode).toBe(404);
  });

  it('requires a session (401)', async () => {
    const res = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/join` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid session token (401)', async () => {
    const res = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/join`, headers: { authorization: 'Bearer not-a-jwt' } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a suspended account (403) before looking up the room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const users = await import('../../src/lib/users.js');
    vi.mocked(users.isUserBanned).mockResolvedValueOnce(true);
    expect((await join('bob')).statusCode).toBe(403);
    expect(roomService.listRooms).not.toHaveBeenCalled();
  });
});

function listen(opts: { payload?: unknown; who?: string; headers?: Record<string, string>; ip?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: `/rooms/${ROOM}/listen`,
    headers: { ...(opts.who ? auth[opts.who] : {}), ...(opts.headers ?? {}) },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
    remoteAddress: opts.ip ?? nextIp(),
  });
}

describe('POST /rooms/:name/listen', () => {
  it('an anonymous guest gets a guest identity, a 6h data-only token, and their IP is recorded', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'conference' }) as never);
    const res = await listen({ payload: {}, ip: '10.40.0.1' });
    const body = res.json();
    expect(body).toMatchObject({ roomName: ROOM, isHost: false, isGuest: true, isPremium: false });
    expect(body.identity).toMatch(/^guest-[a-z0-9]{12}$/);
    expect(vi.mocked(createLivekitToken).mock.calls[0][2]).toEqual({
      canPublish: false, canPublishData: true, premium: false, ttl: '6h', name: undefined,
    });
    // The recorded IP is what a later ban acts on.
    banGuestByIdentity(ROOM, body.identity);
    expect(isGuestBanned(ROOM, '10.40.0.1')).toBe(true);
  });

  it('works with no request body at all', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    const res = await listen();
    expect(res.statusCode).toBe(200);
    expect(res.json().isGuest).toBe(true);
  });

  it('uses the trimmed display name as the chat name', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    await listen({ payload: { displayName: '  Zed  ' } });
    expect(vi.mocked(createLivekitToken).mock.calls[0][2]).toMatchObject({ name: 'Zed' });
  });

  it('a signed-in viewer listens as themselves, is not a guest, and their IP is not recorded', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'conference' }) as never);
    const res = await listen({ who: 'bob', payload: {}, ip: '10.40.0.2' });
    expect(res.json()).toMatchObject({ identity: 'bob', isGuest: false });
    expect(vi.mocked(createLivekitToken).mock.calls[0][2]).toMatchObject({ name: 'bob', canPublish: false });
    banGuestByIdentity(ROOM, 'bob');
    expect(isGuestBanned(ROOM, '10.40.0.2')).toBe(false);
  });

  it('an expired or bogus bearer token falls back to guest listening', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    const res = await listen({ headers: { authorization: 'Bearer garbage' }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isGuest: true });
    expect(res.json().identity).toMatch(/^guest-/);
  });

  it('the on-air collab guest listening watches as ~watch and is not counted as a viewer', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const stats = await import('../../src/lib/streamStats.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'standalone', collabGuest: 'bob' }) as never);
    const res = await listen({ who: 'bob', payload: {} });
    expect(res.json()).toMatchObject({ identity: 'bob~watch', isGuest: false });
    expect(stats.recordViewerJoin).not.toHaveBeenCalled();
  });

  it('a viewer joining a standalone stream is recorded for the leaderboard under the lowercased host', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const stats = await import('../../src/lib/streamStats.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'standalone', host: 'Alice' }) as never);
    await listen({ who: 'carol', payload: {} });
    expect(stats.recordViewerJoin).toHaveBeenCalledWith(ROOM, 'alice');
  });

  it('joining a conference room is not a stream view', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const stats = await import('../../src/lib/streamStats.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'conference' }) as never);
    await listen({ payload: {} });
    expect(stats.recordViewerJoin).not.toHaveBeenCalled();
  });

  it('a standalone stream ignores the legacy allowGuests=false flag', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'standalone', allowGuests: false }) as never);
    expect((await listen({ payload: {} })).statusCode).toBe(200);
  });

  it('hive-internal is enforced for standalone streams too', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'standalone', visibility: 'hive-internal' }) as never);
    expect((await listen({ payload: {} })).statusCode).toBe(403);
  });

  it('the guest cap counts only guest identities, not signed-in users', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    const parts = [
      ...Array.from({ length: 49 }, (_, i) => ({ identity: `guest-${i}` })),
      ...Array.from({ length: 20 }, (_, i) => ({ identity: `user${i}` })),
    ];
    vi.mocked(roomService.listParticipants).mockResolvedValue(parts as never);
    expect((await listen({ payload: {} })).statusCode).toBe(200);
    vi.mocked(roomService.listParticipants).mockResolvedValue([...parts, { identity: 'guest-49' }] as never);
    const full = await listen({ payload: {} });
    expect(full.statusCode).toBe(409);
    expect(full.json().message).toContain('(50)');
  });

  it('lets the guest in when LiveKit cannot list participants (fails open)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    vi.mocked(roomService.listParticipants).mockRejectedValue(new Error('twirp down'));
    expect((await listen({ payload: {} })).statusCode).toBe(200);
  });

  // Was a bug, fixed (rooms.ts:534-550 vs the comment at rooms.ts:589): "Guest caps
  // and IP bans apply to actual guests, not signed-in users", but both checks run
  // before the bearer token is read. A signed-in Hive viewer (who reaches /listen
  // for every standalone stream) is refused once 50 guests are in, and is refused
  // when they share a NAT address with a banned guest. These pin the documented
  // intent and currently fail; flip them to it() once the checks are moved.
  it('a signed-in viewer is not held to the guest cap', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'standalone' }) as never);
    vi.mocked(roomService.listParticipants).mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ identity: `guest-${i}` })) as never,
    );
    expect((await listen({ who: 'bob', payload: {} })).statusCode).toBe(200);
  });

  it('a signed-in viewer is not refused for sharing an IP with a banned guest', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    recordGuestIp(ROOM, 'guest-old', '10.40.0.9');
    banGuestByIdentity(ROOM, 'guest-old');
    expect((await listen({ who: 'bob', payload: {}, ip: '10.40.0.9' })).statusCode).toBe(200);
  });

  it('an anonymous guest on a banned IP is refused (403)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    recordGuestIp(ROOM, 'guest-old', '10.40.0.11');
    banGuestByIdentity(ROOM, 'guest-old');
    expect((await listen({ payload: {}, ip: '10.40.0.11' })).statusCode).toBe(403);
  });

  it('a silent OBS observer gets a read-only obs- identity for 12h, skipping bans and the guest cap', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    const stats = await import('../../src/lib/streamStats.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ mode: 'standalone' }) as never);
    vi.mocked(roomService.listParticipants).mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({ identity: `guest-${i}` })) as never,
    );
    recordGuestIp(ROOM, 'guest-old', '10.40.0.10');
    banGuestByIdentity(ROOM, 'guest-old');

    const res = await listen({ payload: { silent: true }, ip: '10.40.0.10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identity).toMatch(/^obs-[a-z0-9]{8}$/);
    expect(body.isGuest).toBe(false);
    expect(vi.mocked(createLivekitToken).mock.calls[0][2]).toMatchObject({ canPublish: false, canPublishData: false, ttl: '12h' });
    expect(roomService.listParticipants).not.toHaveBeenCalled();
    expect(stats.recordViewerJoin).not.toHaveBeenCalled();
  });

  it('a silent observer ignores the bearer token, so it never takes the host\'s identity', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    const res = await listen({ who: 'alice', payload: { silent: true } });
    expect(res.json().identity).toMatch(/^obs-/);
  });

  it('rejects a display name over 32 characters (400)', async () => {
    expect((await listen({ payload: { displayName: 'x'.repeat(33) } })).statusCode).toBe(400);
  });
});
