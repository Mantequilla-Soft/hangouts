import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { recordGuestIp, banGuestByIdentity, isGuestBanned, clearRoomBans } from '../../src/lib/guestBans.js';

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

describe('PATCH /rooms/:name/layout', () => {
  it('the host sets layout and view state, and gets the effective values back', async () => {
    setRoom({ broadcasting: true });
    const res = await req('PATCH', '/layout', 'alice', { layout: 'grid', focusedIdentity: 'bob', suppressScreenAutoFocus: true, chatOpen: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ layout: 'grid', focusedIdentity: 'bob', suppressScreenAutoFocus: true, chatOpen: false });
    expect(roomMeta()).toMatchObject({ recordLayout: 'grid', focusedIdentity: 'bob', suppressScreenAutoFocus: true, chatOpen: false, broadcasting: true });
  });

  it('a partial update keeps the other fields and defaults chat to open', async () => {
    setRoom({ recordLayout: 'speaker' });
    const res = await req('PATCH', '/layout', 'alice', { focusedIdentity: null });
    expect(res.json()).toEqual({ layout: 'speaker', focusedIdentity: null, suppressScreenAutoFocus: false, chatOpen: true });
  });

  it('only the host may change the layout (403)', async () => {
    setRoom({});
    expect((await req('PATCH', '/layout', 'bob', { layout: 'grid' })).statusCode).toBe(403);
  });

  it('returns 404 for a missing room and 400 for an unknown layout', async () => {
    expect((await req('PATCH', '/layout', 'alice', { layout: 'grid' })).statusCode).toBe(404);
    setRoom({});
    expect((await req('PATCH', '/layout', 'alice', { layout: 'mosaic' })).statusCode).toBe(400);
  });

  // Possible bug: /layout (rooms.ts:643-664), /boost (rooms.ts:696-720) and the
  // host transfer (rooms.ts:1030-1051) read and write room metadata directly
  // instead of through mutateRoomMetadata, so they race the per-room lock that
  // /live, /broadcast, /post and the collab slot rely on. A layout change made
  // while the broadcast heartbeat writes erases the heartbeat's flag.
  it.fails('a layout change does not erase a broadcast flag written at the same time', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ broadcasting: false });
    let releaseLayoutRead!: () => void;
    const staleSnapshot = [{ ...lk.rooms.get(ROOM)! }];
    vi.mocked(roomService.listRooms).mockImplementationOnce(() => new Promise((resolve) => {
      releaseLayoutRead = () => resolve(staleSnapshot as never);
    }));
    const layout = req('PATCH', '/layout', 'alice', { layout: 'grid' });
    await new Promise((r) => setTimeout(r, 20));
    expect((await req('PATCH', '/broadcast', 'alice', { broadcasting: true })).statusCode).toBe(200);
    releaseLayoutRead();
    expect((await layout).statusCode).toBe(200);
    expect(roomMeta()).toMatchObject({ recordLayout: 'grid', broadcasting: true });
  });
});

describe('PATCH /rooms/:name/boost', () => {
  it('merges the update into the existing boost settings', async () => {
    setRoom({ boost: { enabled: true, minBoostUsd: 0, creatorPayoutAccount: 'alice' }, title: 'keep' });
    const res = await req('PATCH', '/boost', 'alice', { minBoostUsd: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ boost: { enabled: true, minBoostUsd: 3, creatorPayoutAccount: 'alice' } });
    expect(roomMeta()).toMatchObject({ title: 'keep', boost: { minBoostUsd: 3 } });
  });

  it('an empty payout account clears it, and a missing or malformed boost starts from scratch', async () => {
    setRoom({ boost: ['bad'] });
    const res = await req('PATCH', '/boost', 'alice', { enabled: false, creatorPayoutAccount: '' });
    expect(res.json().boost).toEqual({ enabled: false });
  });

  // Hosts change Boosts mid-stream from the studio, while its heartbeat writes
  // `broadcasting`: the update goes through the per-room metadata lock.
  it('a boost change mid-stream does not erase a broadcast flag written at the same time', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ broadcasting: false, boost: { enabled: true, minBoostUsd: 0 } });
    let releaseBoostRead!: () => void;
    const staleSnapshot = [{ ...lk.rooms.get(ROOM)! }];
    vi.mocked(roomService.listRooms).mockImplementationOnce(() => new Promise((resolve) => {
      releaseBoostRead = () => resolve(staleSnapshot as never);
    }));
    const boost = req('PATCH', '/boost', 'alice', { enabled: false });
    await new Promise((r) => setTimeout(r, 20));
    const broadcast = req('PATCH', '/broadcast', 'alice', { broadcasting: true });
    releaseBoostRead();
    expect((await boost).statusCode).toBe(200);
    expect((await broadcast).statusCode).toBe(200);
    expect(roomMeta()).toMatchObject({ broadcasting: true, boost: { enabled: false } });
  });

  it('only the host may change boost settings (403), and the room must exist (404)', async () => {
    expect((await req('PATCH', '/boost', 'alice', { enabled: true })).statusCode).toBe(404);
    setRoom({});
    expect((await req('PATCH', '/boost', 'bob', { enabled: true })).statusCode).toBe(403);
  });

  it('rejects a negative minimum and requires a session', async () => {
    setRoom({});
    expect((await req('PATCH', '/boost', 'alice', { minBoostUsd: -2 })).statusCode).toBe(400);
    expect((await req('PATCH', '/boost', null, { enabled: true })).statusCode).toBe(401);
  });
});

describe('PATCH /rooms/:name/post', () => {
  it('merges a partial update into the existing post', async () => {
    setRoom({ post: { title: 'Old', description: 'Keep me' }, broadcasting: true });
    const res = await req('PATCH', '/post', 'alice', { title: 'New', thumbnail: 'https://t/x.jpg', tags: ['a'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ post: { title: 'New', description: 'Keep me', thumbnail: 'https://t/x.jpg', tags: ['a'] } });
    expect(roomMeta()).toMatchObject({ broadcasting: true, post: { title: 'New', description: 'Keep me' } });
  });

  it('starts a fresh post when the stored one is not an object', async () => {
    setRoom({ post: 'legacy string' });
    const res = await req('PATCH', '/post', 'alice', { description: 'D' });
    expect(res.json()).toEqual({ post: { description: 'D' } });
  });

  it('only the host may edit the post (403), the room must exist (404)', async () => {
    expect((await req('PATCH', '/post', 'alice', { title: 'x' })).statusCode).toBe(404);
    setRoom({});
    expect((await req('PATCH', '/post', 'bob', { title: 'x' })).statusCode).toBe(403);
  });

  it('rejects a title over 160 characters and more than 10 tags (400)', async () => {
    setRoom({});
    expect((await req('PATCH', '/post', 'alice', { title: 'x'.repeat(161) })).statusCode).toBe(400);
    expect((await req('PATCH', '/post', 'alice', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).statusCode).toBe(400);
  });
});

describe('PATCH /rooms/:name/live', () => {
  it('stamps liveAt on the server, records the VOD choice and orientation, and counts the go-live', async () => {
    const quota = await import('../../src/lib/streamQuota.js');
    setRoom({ mode: 'standalone' });
    const before = Date.now();
    const res = await req('PATCH', '/live', 'alice', { willPublishVod: true, portrait: true });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ willPublishVod: true, portrait: true });
    expect(new Date(body.liveAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(roomMeta()).toMatchObject({ liveAt: body.liveAt, willPublishVod: true, portrait: true });
    expect(quota.nextFreeStreamAt).toHaveBeenCalledWith('alice', ROOM);
    expect(quota.recordGoLive).toHaveBeenCalledWith('alice', ROOM);
  });

  it('a resume keeps the first liveAt so chat timecodes keep their origin', async () => {
    setRoom({ mode: 'standalone', liveAt: '2026-11-13T08:00:00.000Z', portrait: true });
    const res = await req('PATCH', '/live', 'alice', {});
    expect(res.json()).toEqual({ liveAt: '2026-11-13T08:00:00.000Z', willPublishVod: false, portrait: false });
    // portrait left out of the body leaves the stored value alone
    expect(roomMeta().portrait).toBe(true);
  });

  it('closes the room and answers 429 when a free host already streamed today from another room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const quota = await import('../../src/lib/streamQuota.js');
    setRoom({ mode: 'standalone' });
    recordGuestIp(ROOM, 'guest-x', '10.50.0.1');
    banGuestByIdentity(ROOM, 'guest-x');
    vi.mocked(quota.nextFreeStreamAt).mockResolvedValueOnce(new Date('2026-11-14T07:00:00Z'));
    const res = await req('PATCH', '/live', 'alice', {});
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'daily_stream_limit', retryAt: '2026-11-14T07:00:00.000Z' });
    expect(roomService.deleteRoom).toHaveBeenCalledWith(ROOM);
    expect(isGuestBanned(ROOM, '10.50.0.1')).toBe(false);
    expect(quota.recordGoLive).not.toHaveBeenCalled();
  });

  it('still answers 429 when closing the over-limit room fails', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    const quota = await import('../../src/lib/streamQuota.js');
    setRoom({ mode: 'standalone' });
    vi.mocked(quota.nextFreeStreamAt).mockResolvedValueOnce(new Date('2026-11-14T07:00:00Z'));
    vi.mocked(roomService.deleteRoom).mockRejectedValueOnce(new Error('already gone'));
    expect((await req('PATCH', '/live', 'alice', {})).statusCode).toBe(429);
  });

  it('a Pro host is never checked against the daily limit', async () => {
    const users = await import('../../src/lib/users.js');
    const quota = await import('../../src/lib/streamQuota.js');
    vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: true });
    setRoom({ mode: 'standalone' });
    expect((await req('PATCH', '/live', 'alice', {})).statusCode).toBe(200);
    expect(quota.nextFreeStreamAt).not.toHaveBeenCalled();
    expect(quota.recordGoLive).toHaveBeenCalledWith('alice', ROOM);
  });

  it('only the host may go live (403) and writes nothing', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'standalone' });
    expect((await req('PATCH', '/live', 'bob', {})).statusCode).toBe(403);
    expect(roomService.updateRoomMetadata).not.toHaveBeenCalled();
  });

  it('returns 404 for a room that does not exist', async () => {
    expect((await req('PATCH', '/live', 'alice', {})).statusCode).toBe(404);
  });

  it('a request with no JSON body at all is refused by the schema (400)', async () => {
    setRoom({ mode: 'standalone' });
    expect((await req('PATCH', '/live', 'alice')).statusCode).toBe(400);
  });
});

describe('PATCH /rooms/:name/broadcast', () => {
  it('the host toggles the broadcasting flag, keeping the rest of the metadata', async () => {
    setRoom({ mode: 'standalone', liveAt: 'x' });
    const on = await req('PATCH', '/broadcast', 'alice', { broadcasting: true });
    expect(on.json()).toEqual({ broadcasting: true });
    expect(roomMeta()).toMatchObject({ broadcasting: true, liveAt: 'x' });
    await req('PATCH', '/broadcast', 'alice', { broadcasting: false });
    expect(roomMeta().broadcasting).toBe(false);
  });

  it('refuses non-hosts (403), missing rooms (404) and a missing flag (400)', async () => {
    expect((await req('PATCH', '/broadcast', 'alice', { broadcasting: true })).statusCode).toBe(404);
    setRoom({});
    expect((await req('PATCH', '/broadcast', 'bob', { broadcasting: true })).statusCode).toBe(403);
    expect((await req('PATCH', '/broadcast', 'alice', {})).statusCode).toBe(400);
  });

  it('concurrent /post, /live and /broadcast writes all survive (per-room lock)', async () => {
    setRoom({ mode: 'standalone' });
    await Promise.all([
      req('PATCH', '/post', 'alice', { title: 'P' }),
      req('PATCH', '/live', 'alice', { willPublishVod: true }),
      req('PATCH', '/broadcast', 'alice', { broadcasting: true }),
    ]);
    expect(roomMeta()).toMatchObject({ post: { title: 'P' }, willPublishVod: true, broadcasting: true });
    expect(typeof roomMeta().liveAt).toBe('string');
  });
});

describe('POST /rooms/:name/ingress (OBS in the studio)', () => {
  beforeEach(async () => {
    const users = await import('../../src/lib/users.js');
    vi.mocked(users.getUserStatus).mockResolvedValue({ banned: false, premium: true });
  });

  it('defaults to a VP8 transcoding ingress whose WHIP URL ends in the stream key', async () => {
    setRoom({ mode: 'standalone' });
    const res = await req('POST', '/ingress', 'alice', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ingressId: 'IN_new', streamKey: 'newkey', participantIdentity: `obs-ingress-${ROOM}` });
    expect(res.json().whipUrl).toMatch(/\/newkey$/);
    const opts = ingress.createIngress.mock.calls[0][1];
    expect(opts).toMatchObject({ name: `obs-${ROOM}-vp8`, roomName: ROOM, enableTranscoding: true, participantIdentity: `obs-ingress-${ROOM}` });
    expect(opts.video).toBeDefined();
  });

  it('creates a passthrough ingress when the host opts out of transcoding', async () => {
    setRoom({ mode: 'standalone' });
    await req('POST', '/ingress', 'alice', { transcode: false });
    const opts = ingress.createIngress.mock.calls[0][1];
    expect(opts).toMatchObject({ name: `obs-${ROOM}`, enableTranscoding: false });
    expect(opts.video).toBeUndefined();
  });

  it('reuses an existing ingress in the right mode so the host keeps the same key', async () => {
    setRoom({ mode: 'standalone' });
    ingress.listIngress.mockResolvedValue([
      { ingressId: 'IN_old', streamKey: 'oldkey', name: `obs-${ROOM}-vp8`, participantIdentity: `obs-ingress-${ROOM}` },
    ]);
    const res = await req('POST', '/ingress', 'alice', {});
    expect(res.json()).toMatchObject({ ingressId: 'IN_old', streamKey: 'oldkey' });
    expect(ingress.createIngress).not.toHaveBeenCalled();
    expect(ingress.deleteIngress).not.toHaveBeenCalled();
  });

  it('rebuilds an existing ingress that is in the wrong mode, even if deleting it fails', async () => {
    setRoom({ mode: 'standalone' });
    ingress.listIngress.mockResolvedValue([
      { ingressId: 'IN_old', streamKey: 'oldkey', name: `obs-${ROOM}`, participantIdentity: `obs-ingress-${ROOM}` },
    ]);
    ingress.deleteIngress.mockRejectedValueOnce(new Error('already gone'));
    const res = await req('POST', '/ingress', 'alice', {});
    expect(res.json()).toMatchObject({ ingressId: 'IN_new' });
    expect(ingress.deleteIngress).toHaveBeenCalledWith('IN_old');
    expect(ingress.createIngress).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when LiveKit ingress fails', async () => {
    setRoom({ mode: 'standalone' });
    ingress.createIngress.mockRejectedValueOnce(new Error('ingress service down'));
    const res = await req('POST', '/ingress', 'alice', {});
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ message: 'Could not set up OBS ingest' });
  });

  it('only the host may set up OBS (403), the room must exist (404)', async () => {
    expect((await req('POST', '/ingress', 'alice', {})).statusCode).toBe(404);
    setRoom({});
    expect((await req('POST', '/ingress', 'bob', {})).statusCode).toBe(403);
    expect(ingress.listIngress).not.toHaveBeenCalled();
  });
});

describe('DELETE /rooms/:name/ingress', () => {
  it('removes only this room\'s OBS ingress', async () => {
    setRoom({});
    ingress.listIngress.mockResolvedValue([
      { ingressId: 'IN_a', participantIdentity: `obs-ingress-${ROOM}` },
      { ingressId: 'IN_b', participantIdentity: 'someone-else' },
    ]);
    const res = await req('DELETE', '/ingress', 'alice');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(ingress.deleteIngress).toHaveBeenCalledTimes(1);
    expect(ingress.deleteIngress).toHaveBeenCalledWith('IN_a');
  });

  it('answers 503 when LiveKit ingress fails', async () => {
    setRoom({});
    ingress.listIngress.mockRejectedValueOnce(new Error('down'));
    expect((await req('DELETE', '/ingress', 'alice')).statusCode).toBe(503);
  });

  it('only the host may remove OBS (403), the room must exist (404)', async () => {
    expect((await req('DELETE', '/ingress', 'alice')).statusCode).toBe(404);
    setRoom({});
    expect((await req('DELETE', '/ingress', 'bob')).statusCode).toBe(403);
  });
});

describe('POST /rooms/:name/host (transfer)', () => {
  it('hands a conference room to a participant who is present and lets them publish', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'conference', title: 'keep' });
    vi.mocked(roomService.listParticipants).mockResolvedValue([{ identity: 'bob' }] as never);
    const res = await req('POST', '/host', 'alice', { newHost: 'bob' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ host: 'bob' });
    expect(roomMeta()).toMatchObject({ host: 'bob', title: 'keep' });
    expect(roomService.updateParticipant).toHaveBeenCalledWith(ROOM, 'bob', undefined, { canPublish: true, canSubscribe: true, canPublishData: true });
  });

  it('refuses to hand over a standalone stream (403)', async () => {
    setRoom({ mode: 'standalone' });
    expect((await req('POST', '/host', 'alice', { newHost: 'bob' })).statusCode).toBe(403);
    expect(roomMeta().host).toBe('alice');
  });

  it('refuses a new host who is not in the room (404)', async () => {
    setRoom({ mode: 'conference' });
    expect((await req('POST', '/host', 'alice', { newHost: 'bob' })).statusCode).toBe(404);
    expect(roomMeta().host).toBe('alice');
  });

  it('only the host may transfer (403), the room must exist (404), newHost is required (400)', async () => {
    expect((await req('POST', '/host', 'alice', { newHost: 'bob' })).statusCode).toBe(404);
    setRoom({ mode: 'conference' });
    expect((await req('POST', '/host', 'bob', { newHost: 'bob' })).statusCode).toBe(403);
    expect((await req('POST', '/host', 'alice', {})).statusCode).toBe(400);
  });
});

describe('DELETE /rooms/:name', () => {
  it('the host closes a studio room: the LiveKit room is deleted and its guest bans dropped', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({ mode: 'standalone' });
    recordGuestIp(ROOM, 'guest-y', '10.50.0.2');
    banGuestByIdentity(ROOM, 'guest-y');
    const res = await req('DELETE', '', 'alice');
    expect(res.statusCode).toBe(204);
    expect(roomService.deleteRoom).toHaveBeenCalledWith(ROOM);
    expect(isGuestBanned(ROOM, '10.50.0.2')).toBe(false);
  });

  it('only the host may close the room (403)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    setRoom({});
    expect((await req('DELETE', '', 'bob')).statusCode).toBe(403);
    expect(roomService.deleteRoom).not.toHaveBeenCalled();
  });

  it('returns 404 for a room that does not exist, 401 without a session', async () => {
    expect((await req('DELETE', '', 'alice')).statusCode).toBe(404);
    expect((await req('DELETE', '', null)).statusCode).toBe(401);
  });

  it('a suspended host cannot close the room (403)', async () => {
    const users = await import('../../src/lib/users.js');
    setRoom({});
    vi.mocked(users.isUserBanned).mockResolvedValueOnce(true);
    expect((await req('DELETE', '', 'alice')).statusCode).toBe(403);
  });
});

afterAll(() => { clearRoomBans(ROOM); });
