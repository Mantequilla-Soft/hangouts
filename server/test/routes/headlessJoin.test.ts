import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(), listParticipants: vi.fn().mockResolvedValue([]), createRoom: vi.fn(),
    removeParticipant: vi.fn(), updateParticipant: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-abc1234'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));
vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));
vi.mock('../../src/lib/headlessStreams.js', () => ({
  isTemplateBusy: vi.fn(), getHeadlessStatus: vi.fn(), streamCapMs: () => 3600_000,
  capCooldownRemaining: vi.fn(), startHeadlessStream: vi.fn(), forwardWhipPatch: vi.fn(),
  endWhipSession: vi.fn(), getSessionByToken: vi.fn(),
  endHeadlessStreamForRoom: vi.fn().mockResolvedValue(undefined),
  headlessViewerIdentity: (h: string) => `${h}~watch`,
}));

const ROOM = 'alice-abc1234';
function room(meta: Record<string, unknown>) {
  return [{ name: ROOM, metadata: JSON.stringify({ title: 't', host: 'alice', mode: 'standalone', visibility: 'public', ...meta }) }];
}

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
beforeEach(() => { vi.clearAllMocks(); });

describe('headless host identity', () => {
  it('/join gives the host of a headless stream a distinct, non-publishing identity', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ headless: true }) as never);
    const res = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/join`, headers: { authorization: `Bearer ${await makeToken('alice')}` } });
    expect(res.json()).toMatchObject({ identity: 'alice~watch', isHost: false });
    expect(createLivekitToken).toHaveBeenCalledWith(ROOM, 'alice~watch', expect.objectContaining({ canPublish: false, name: 'alice' }));
  });

  it('/join is unchanged for a studio (non-headless) host and for other viewers', async () => {
    const { roomService, createLivekitToken } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({}) as never);
    const host = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/join`, headers: { authorization: `Bearer ${await makeToken('alice')}` } });
    expect(host.json()).toMatchObject({ identity: 'alice', isHost: true });
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ headless: true }) as never);
    const viewer = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/join`, headers: { authorization: `Bearer ${await makeToken('bob')}` } });
    expect(viewer.json()).toMatchObject({ identity: 'bob', isHost: false });
    expect(vi.mocked(createLivekitToken).mock.calls[1][1]).toBe('bob');
  });

  it('/listen with the host\'s session also avoids the ingress identity', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ headless: true }) as never);
    const res = await app.inject({
      method: 'POST', url: `/rooms/${ROOM}/listen`, payload: {},
      headers: { authorization: `Bearer ${await makeToken('alice')}` },
    });
    expect(res.json()).toMatchObject({ identity: 'alice~watch', isGuest: false });
  });

  it('studio /live and /broadcast are refused on a headless room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ headless: true }) as never);
    const auth = { authorization: `Bearer ${await makeToken('alice')}` };
    expect((await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/live`, headers: auth, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/broadcast`, headers: auth, payload: { broadcasting: false } })).statusCode).toBe(409);
    expect(roomService.updateRoomMetadata).not.toHaveBeenCalled();
  });

  it('DELETE /rooms/:name on a headless room ends the whole headless stream', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const hs = await import('../../src/lib/headlessStreams.js');
    vi.mocked(roomService.listRooms).mockResolvedValue(room({ headless: true }) as never);
    const res = await app.inject({ method: 'DELETE', url: `/rooms/${ROOM}`, headers: { authorization: `Bearer ${await makeToken('alice')}` } });
    expect(res.statusCode).toBe(204);
    expect(hs.endHeadlessStreamForRoom).toHaveBeenCalledWith(ROOM, 'host_closed');
    expect(roomService.deleteRoom).not.toHaveBeenCalled();
  });
});
