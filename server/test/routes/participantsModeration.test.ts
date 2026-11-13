import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { recordGuestIp, isGuestBanned, clearRoomBans } from '../../src/lib/guestBans.js';

// Stateful room fake: mutateRoomMetadata reads back what updateRoomMetadata wrote.
const lk = vi.hoisted(() => ({
  rooms: new Map<string, { name: string; metadata: string }>(),
}));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()].filter((r) => !names || names.includes(r.name))),
    listParticipants: vi.fn().mockResolvedValue([]),
    createRoom: vi.fn(),
    removeParticipant: vi.fn().mockResolvedValue(undefined),
    updateParticipant: vi.fn(async (_room: string, identity: string, _md: unknown, perm: { canPublish: boolean }) => (
      { identity, permission: { canPublish: perm.canPublish } }
    )),
    updateRoomMetadata: vi.fn(async (name: string, metadata: string) => {
      const r = lk.rooms.get(name);
      if (r) r.metadata = metadata;
    }),
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

const ROOM = 'alice-mod-room';

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
  for (const u of ['alice', 'bob', 'mod1', 'eve']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

beforeEach(async () => {
  vi.clearAllMocks();
  lk.rooms.clear();
  clearRoomBans(ROOM);
  const { roomService } = await import('../../src/lib/livekit.js');
  vi.mocked(roomService.listParticipants).mockResolvedValue([]);
  vi.mocked(roomService.removeParticipant).mockResolvedValue(undefined as never);
});

const promote = (identity: string, canPublish: boolean, who = 'alice') => app.inject({
  method: 'PATCH', url: `/rooms/${ROOM}/participants/${identity}/permissions`,
  headers: auth[who], payload: { canPublish },
});

describe('PATCH permissions on a standalone stream (single collab slot)', () => {
  it('promoting the first guest records them as the collab guest', async () => {
    setRoom({ mode: 'standalone' });
    const res = await promote('bob', true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identity: 'bob', canPublish: true });
    expect(roomMeta().collabGuest).toBe('bob');
  });

  it('refuses a second guest with 409 while the current collab guest is still connected', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'standalone', collabGuest: 'bob' });
    vi.mocked(roomService.listParticipants).mockResolvedValue([{ identity: 'bob' }] as never);
    const res = await promote('carol', true);
    expect(res.statusCode).toBe(409);
    expect(roomService.updateParticipant).not.toHaveBeenCalled();
    expect(roomMeta().collabGuest).toBe('bob');
  });

  it('frees the slot of a collab guest who has left and gives it to the new guest', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'standalone', collabGuest: 'bob' });
    vi.mocked(roomService.listParticipants).mockResolvedValue([{ identity: 'alice' }] as never);
    const res = await promote('carol', true);
    expect(res.statusCode).toBe(200);
    expect(roomMeta().collabGuest).toBe('carol');
  });

  it('lets the new guest in when LiveKit cannot list participants (fails open, no deadlock)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'standalone', collabGuest: 'bob' });
    vi.mocked(roomService.listParticipants).mockRejectedValue(new Error('twirp down'));
    const res = await promote('carol', true);
    expect(res.statusCode).toBe(200);
    expect(roomMeta().collabGuest).toBe('carol');
  });

  it('re-promoting the current collab guest does not check presence', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'standalone', collabGuest: 'bob' });
    const res = await promote('bob', true);
    expect(res.statusCode).toBe(200);
    expect(roomService.listParticipants).not.toHaveBeenCalled();
    expect(roomMeta().collabGuest).toBe('bob');
  });

  it('demoting the collab guest clears the slot', async () => {
    setRoom({ mode: 'standalone', collabGuest: 'bob', broadcasting: true });
    const res = await promote('bob', false);
    expect(res.statusCode).toBe(200);
    expect(res.json().canPublish).toBe(false);
    const meta = roomMeta();
    expect(meta.collabGuest).toBeUndefined();
    expect(meta.broadcasting).toBe(true);
  });

  it('demoting someone else leaves the collab slot alone', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'standalone', collabGuest: 'bob' });
    const res = await promote('carol', false);
    expect(res.statusCode).toBe(200);
    expect(roomMeta().collabGuest).toBe('bob');
    expect(roomService.updateRoomMetadata).not.toHaveBeenCalled();
  });

  it('a conference room has no collab slot: promotions never touch metadata', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'conference', collabGuest: 'bob' });
    vi.mocked(roomService.listParticipants).mockResolvedValue([{ identity: 'bob' }] as never);
    const res = await promote('carol', true);
    expect(res.statusCode).toBe(200);
    expect(roomService.updateRoomMetadata).not.toHaveBeenCalled();
  });

  it('a moderator cannot change publish permissions (host only)', async () => {
    setRoom({ mode: 'conference', mods: ['mod1'] });
    expect((await promote('bob', true, 'mod1')).statusCode).toBe(403);
  });

  it('reports canPublish false when LiveKit returns no permission block', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'conference' });
    vi.mocked(roomService.updateParticipant).mockResolvedValueOnce({ identity: 'bob' } as never);
    const res = await promote('bob', true);
    expect(res.json()).toEqual({ identity: 'bob', canPublish: false });
  });

  it('treats unreadable room metadata as having no host (403)', async () => {
    lk.rooms.set(ROOM, { name: ROOM, metadata: '{not json' });
    expect((await promote('bob', true)).statusCode).toBe(403);
  });

  it('requires a session (401) and a boolean canPublish (400)', async () => {
    setRoom({});
    const noAuth = await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/participants/bob/permissions`, payload: { canPublish: true } });
    expect(noAuth.statusCode).toBe(401);
    const badBody = await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/participants/bob/permissions`, headers: auth.alice, payload: {} });
    expect(badBody.statusCode).toBe(400);
  });
});

describe('DELETE /rooms/:name/participants/:identity (kick)', () => {
  const kick = (identity: string, who: string) => app.inject({
    method: 'DELETE', url: `/rooms/${ROOM}/participants/${identity}`, headers: auth[who],
  });

  it('the host can remove a participant', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({});
    const res = await kick('bob', 'alice');
    expect(res.statusCode).toBe(204);
    expect(roomService.removeParticipant).toHaveBeenCalledWith(ROOM, 'bob');
  });

  it('a moderator can remove a participant', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mods: ['mod1'] });
    const res = await kick('bob', 'mod1');
    expect(res.statusCode).toBe(204);
    expect(roomService.removeParticipant).toHaveBeenCalledWith(ROOM, 'bob');
  });

  it('anyone else gets 403 and nobody is removed', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mods: ['mod1'] });
    expect((await kick('bob', 'eve')).statusCode).toBe(403);
    expect(roomService.removeParticipant).not.toHaveBeenCalled();
  });

  it('a malformed mods field grants nobody moderation', async () => {
    setRoom({ mods: 'eve' });
    expect((await kick('bob', 'eve')).statusCode).toBe(403);
  });

  it('returns 404 for a room that does not exist', async () => {
    expect((await kick('bob', 'alice')).statusCode).toBe(404);
  });

  it('a LiveKit failure on removal surfaces as a 500', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({});
    vi.mocked(roomService.removeParticipant).mockRejectedValueOnce(new Error('participant not found'));
    expect((await kick('bob', 'alice')).statusCode).toBe(500);
  });

  it('a banned account cannot moderate (checkBan runs before the handler)', async () => {
    const users = await import('../../src/lib/users.js');
    setRoom({});
    vi.mocked(users.isUserBanned).mockResolvedValueOnce(true);
    expect((await kick('bob', 'alice')).statusCode).toBe(403);
  });
});

describe('POST /rooms/:name/participants/:identity/ban (guest ban)', () => {
  const ban = (identity: string, who: string) => app.inject({
    method: 'POST', url: `/rooms/${ROOM}/participants/${identity}/ban`, headers: auth[who],
  });

  it('a moderator can ban a guest: their IP is banned and they are kicked', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mods: ['mod1'] });
    recordGuestIp(ROOM, 'guest-abc', '10.1.2.3');
    const res = await ban('guest-abc', 'mod1');
    expect(res.statusCode).toBe(204);
    expect(isGuestBanned(ROOM, '10.1.2.3')).toBe(true);
    expect(roomService.removeParticipant).toHaveBeenCalledWith(ROOM, 'guest-abc');
  });

  it('the ban still stands when the guest already left (removal fails)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({});
    recordGuestIp(ROOM, 'guest-gone', '10.9.9.9');
    vi.mocked(roomService.removeParticipant).mockRejectedValueOnce(new Error('not found'));
    const res = await ban('guest-gone', 'alice');
    expect(res.statusCode).toBe(204);
    expect(isGuestBanned(ROOM, '10.9.9.9')).toBe(true);
  });
});

describe('PATCH /rooms/:name/mods/:username', () => {
  const setMod = (target: string, isMod: boolean, who = 'alice') => app.inject({
    method: 'PATCH', url: `/rooms/${ROOM}/mods/${encodeURIComponent(target)}`, headers: auth[who], payload: { isMod },
  });

  it('the host can grant moderator, and the name is stored lowercased', async () => {
    setRoom({});
    const res = await setMod('Mod1', true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mods: ['mod1'] });
    expect(roomMeta().mods).toEqual(['mod1']);
  });

  it('granting twice keeps one entry, and existing mods are kept', async () => {
    setRoom({ mods: ['Other'] });
    await setMod('mod1', true);
    const res = await setMod('mod1', true);
    expect(res.json().mods.sort()).toEqual(['mod1', 'other']);
  });

  it('the host can revoke moderator', async () => {
    setRoom({ mods: ['mod1', 'other'] });
    const res = await setMod('mod1', false);
    expect(res.json()).toEqual({ mods: ['other'] });
  });

  it('refuses a guest identity as moderator (400)', async () => {
    setRoom({});
    expect((await setMod('guest-abc', true)).statusCode).toBe(400);
  });

  it('refuses a blank name as moderator (400)', async () => {
    setRoom({});
    expect((await setMod('  ', true)).statusCode).toBe(400);
  });

  it('refuses to make the host a moderator (400)', async () => {
    setRoom({});
    expect((await setMod('alice', true)).statusCode).toBe(400);
  });

  it('a moderator cannot mint other moderators (403)', async () => {
    setRoom({ mods: ['mod1'] });
    expect((await setMod('bob', true, 'mod1')).statusCode).toBe(403);
  });

  it('returns 404 for a room that does not exist', async () => {
    expect((await setMod('bob', true)).statusCode).toBe(404);
  });

  it('requires a boolean isMod (400)', async () => {
    setRoom({});
    const res = await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/mods/bob`, headers: auth.alice, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
