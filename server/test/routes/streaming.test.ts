import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { makeToken } from '../setup.js';

// One shared fake EgressClient: the route module builds its client at import.
const egress = vi.hoisted(() => ({
  startRoomCompositeEgress: vi.fn(),
  startTrackCompositeEgress: vi.fn(),
  stopEgress: vi.fn(),
}));

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  return { ...actual, EgressClient: class { constructor() { return egress; } } };
});

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(), listParticipants: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn(),
  isUserPremium: vi.fn(),
}));

const ROOM = 'alice-str1234';
const roomWith = (meta: Record<string, unknown>) => [{ name: ROOM, metadata: JSON.stringify(meta) }];

let app: FastifyInstance;
let auth: Record<string, string>;
let lkRooms: typeof import('../../src/lib/livekit.js')['roomService'];
let users: typeof import('../../src/lib/users.js');

beforeEach(async () => {
  // Fresh module per test so the activeStreams map starts empty.
  vi.resetModules();
  lkRooms = (await import('../../src/lib/livekit.js')).roomService;
  users = await import('../../src/lib/users.js');
  vi.mocked(lkRooms.listRooms).mockResolvedValue(roomWith({ host: 'alice', title: 'Show' }) as never);
  vi.mocked(lkRooms.updateRoomMetadata).mockResolvedValue(undefined as never);
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
  vi.mocked(users.isUserPremium).mockResolvedValue(true);
  egress.startRoomCompositeEgress.mockResolvedValue({ egressId: 'EG_1' });
  egress.stopEgress.mockResolvedValue({ egressId: 'EG_1' });

  const { streamingRoutes } = await import('../../src/routes/streaming.js');
  app = Fastify();
  await app.register(sensible);
  await app.register(streamingRoutes);
  auth = { authorization: `Bearer ${await makeToken('alice')}` };
});

afterEach(async () => { await app.close(); });

const start = (payload: Record<string, unknown>, headers = auth) =>
  app.inject({ method: 'POST', url: `/rooms/${ROOM}/stream/start`, headers, payload });
const stop = (headers = auth) => app.inject({ method: 'POST', url: `/rooms/${ROOM}/stream/stop`, headers });
const status = (headers = auth) => app.inject({ method: 'GET', url: `/rooms/${ROOM}/stream/status`, headers });

describe('restream start', () => {
  it('rejects a request without a session token with 401', async () => {
    const res = await start({ platform: 'youtube', streamKey: 'k' }, {});
    expect(res.statusCode).toBe(401);
    expect(egress.startRoomCompositeEgress).not.toHaveBeenCalled();
  });

  it('rejects a banned host with 403 before touching LiveKit', async () => {
    vi.mocked(users.isUserBanned).mockResolvedValue(true);
    const res = await start({ platform: 'youtube', streamKey: 'k' });
    expect(res.statusCode).toBe(403);
    expect(lkRooms.listRooms).not.toHaveBeenCalled();
  });

  it('rejects an unknown platform or an empty stream key with 400', async () => {
    expect((await start({ platform: 'facebook', streamKey: 'k' })).statusCode).toBe(400);
    expect((await start({ platform: 'youtube', streamKey: '' })).statusCode).toBe(400);
  });

  it('returns 404 when the room does not exist', async () => {
    vi.mocked(lkRooms.listRooms).mockResolvedValue([] as never);
    expect((await start({ platform: 'youtube', streamKey: 'k' })).statusCode).toBe(404);
  });

  it('returns 403 when the caller is not the room host', async () => {
    const res = await start({ platform: 'youtube', streamKey: 'k' }, { authorization: `Bearer ${await makeToken('bob')}` });
    expect(res.statusCode).toBe(403);
    expect(egress.startRoomCompositeEgress).not.toHaveBeenCalled();
  });

  it('treats unreadable room metadata as "no host" and refuses with 403', async () => {
    vi.mocked(lkRooms.listRooms).mockResolvedValue([{ name: ROOM, metadata: '{not json' }] as never);
    expect((await start({ platform: 'youtube', streamKey: 'k' })).statusCode).toBe(403);
  });

  it('returns 402 for a host without Pro', async () => {
    vi.mocked(users.isUserPremium).mockResolvedValue(false);
    const res = await start({ platform: 'youtube', streamKey: 'k' });
    expect(res.statusCode).toBe(402);
    expect(res.json().message).toMatch(/Pro/);
    expect(egress.startRoomCompositeEgress).not.toHaveBeenCalled();
  });

  it('an audio room stamps the default background on the room and streams the custom template to YouTube', async () => {
    const res = await start({ platform: 'youtube', streamKey: 'yt-key' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ egressId: 'EG_1', status: 'streaming', platform: 'youtube' });

    const meta = JSON.parse(vi.mocked(lkRooms.updateRoomMetadata).mock.calls[0][1] as string);
    expect(meta).toMatchObject({ host: 'alice', title: 'Show' });
    expect(meta.streamBg).toMatch(/^https:\/\/hotipfs-3speak-1\.b-cdn\.net\/ipfs\//);

    const [room, out, opts] = egress.startRoomCompositeEgress.mock.calls[0];
    expect(room).toBe(ROOM);
    expect(out.stream.urls).toEqual(['rtmp://a.rtmp.youtube.com/live2/yt-key']);
    expect(opts.customBaseUrl).toBe('https://hangout.3speak.tv/egress-template');
  });

  it('an audio room uses the background image the host picked', async () => {
    await start({ platform: 'youtube', streamKey: 'k', backgroundImageUrl: 'https://img.test/bg.png' });
    const meta = JSON.parse(vi.mocked(lkRooms.updateRoomMetadata).mock.calls[0][1] as string);
    expect(meta.streamBg).toBe('https://img.test/bg.png');
  });

  it('a video room streams the speaker layout to Twitch without touching room metadata', async () => {
    const res = await start({ platform: 'twitch', streamKey: 'tw-key', videoEnabled: true });
    expect(res.json()).toMatchObject({ status: 'streaming', platform: 'twitch' });
    expect(lkRooms.updateRoomMetadata).not.toHaveBeenCalled();
    const [, out, opts] = egress.startRoomCompositeEgress.mock.calls[0];
    expect(out.stream.urls).toEqual(['rtmp://live.twitch.tv/app/tw-key']);
    expect(opts.layout).toBe('speaker');
    expect(opts.customBaseUrl).toBeUndefined();
  });

  it('refuses a second restream of the same room with 409', async () => {
    expect((await start({ platform: 'youtube', streamKey: 'k' })).statusCode).toBe(200);
    expect((await start({ platform: 'twitch', streamKey: 'k' })).statusCode).toBe(409);
    expect(egress.startRoomCompositeEgress).toHaveBeenCalledTimes(1);
  });

  it('a LiveKit failure on start returns 500 and leaves the room not streaming', async () => {
    egress.startRoomCompositeEgress.mockRejectedValueOnce(new Error('twirp: no egress available'));
    expect((await start({ platform: 'youtube', streamKey: 'k' })).statusCode).toBe(500);
    expect((await status()).json()).toEqual({ streaming: false, egressId: null });
  });
});

describe('restream stop and status', () => {
  it('status needs a session token', async () => {
    expect((await status({})).statusCode).toBe(401);
  });

  it('status reports streaming with the egress id while the restream runs, and not after stop', async () => {
    expect((await status()).json()).toEqual({ streaming: false, egressId: null });
    await start({ platform: 'youtube', streamKey: 'k' });
    expect((await status()).json()).toEqual({ streaming: true, egressId: 'EG_1' });
    const res = await stop();
    expect(res.json()).toEqual({ egressId: 'EG_1', status: 'stopped' });
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_1');
    expect((await status()).json()).toEqual({ streaming: false, egressId: null });
  });

  it('after a stop the host can start a new restream in the same room', async () => {
    await start({ platform: 'youtube', streamKey: 'k' });
    await stop();
    expect((await start({ platform: 'youtube', streamKey: 'k' })).statusCode).toBe(200);
  });

  it('stop returns 400 when the room is not streaming', async () => {
    expect((await stop()).statusCode).toBe(400);
    expect(egress.stopEgress).not.toHaveBeenCalled();
  });

  it('stop returns 404 for a missing room and 403 for a non-host, and keeps the restream running', async () => {
    await start({ platform: 'youtube', streamKey: 'k' });
    expect((await stop({ authorization: `Bearer ${await makeToken('bob')}` })).statusCode).toBe(403);
    vi.mocked(lkRooms.listRooms).mockResolvedValueOnce([] as never);
    expect((await stop()).statusCode).toBe(404);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    expect((await status()).json().streaming).toBe(true);
  });

  // BUG (streaming.ts:138-139): stopEgress is awaited before activeStreams.delete,
  // with no catch. When the egress already ended on LiveKit's side (RTMP target
  // dropped it, egress crashed), stopEgress rejects, the route 500s and the map
  // entry stays forever: every later /stream/start is a 409 and /stream/status
  // keeps saying streaming until the server restarts.
  it.fails('a stop whose egress already ended on LiveKit still clears the restream (currently stuck)', async () => {
    await start({ platform: 'youtube', streamKey: 'k' });
    egress.stopEgress.mockRejectedValueOnce(new Error('egress not found'));
    await stop();
    expect((await status()).json().streaming).toBe(false);
  });
});
