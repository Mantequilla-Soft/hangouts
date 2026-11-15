import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { TrackType, TrackSource, ParticipantInfo_Kind } from '@livekit/protocol';
import { makeToken } from '../setup.js';

// HLS on for this file: the first 2 viewers on WebRTC, then HLS. The config
// module parses the environment once and test/setup.ts already loaded it, so
// beforeAll stubs the env and re-imports the app from a fresh module registry.
const HLS_ENV = { HLS_VIEWER_THRESHOLD: '2', MAX_GUESTS_PER_ROOM: '50', HLS_VIDEO_BITRATE: '1800' };

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
    listRooms: vi.fn(), listParticipants: vi.fn().mockResolvedValue([]), createRoom: vi.fn(),
    removeParticipant: vi.fn(), updateParticipant: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-hls'),
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

const ROOM = 'alice-hls';
const DIR = `/tmp/livekit-recordings/live/${ROOM}`;

function room(meta: Record<string, unknown> = {}) {
  return [{ name: ROOM, metadata: JSON.stringify({ title: 't', host: 'alice', visibility: 'public', mode: 'standalone', ...meta }) }];
}
const viewer = (identity: string, canSubscribe = true, extra: Record<string, unknown> = {}) =>
  ({ identity, tracks: [], permission: { canSubscribe }, kind: ParticipantInfo_Kind.STANDARD, ...extra });
const host = (tracks: Array<Record<string, unknown>> = [
  { sid: 'TR_cam', type: TrackType.VIDEO, source: TrackSource.CAMERA, width: 1280, height: 720 },
  { sid: 'TR_mix', name: 'studio-mix', type: TrackType.AUDIO, source: TrackSource.MICROPHONE },
]) => ({ identity: 'alice', tracks, permission: { canSubscribe: true }, kind: ParticipantInfo_Kind.STANDARD });

let app: FastifyInstance;
let lk: typeof import('../../src/lib/livekit.js');
let hls: typeof import('../../src/lib/hlsLive.js');
const auth: Record<string, { authorization: string }> = {};
let ipCounter = 0;
const nextIp = () => `10.60.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

beforeAll(async () => {
  vi.resetModules();
  for (const [k, v] of Object.entries(HLS_ENV)) vi.stubEnv(k, v);
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp();
  lk = await import('../../src/lib/livekit.js');
  hls = await import('../../src/lib/hlsLive.js');
  for (const u of ['alice', 'bob']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  // A start left in flight by the previous test would land after the reset.
  await settle();
  vi.clearAllMocks();
  hls._resetHlsForTests();
  await rm(DIR, { recursive: true, force: true });
  vi.mocked(lk.roomService.listRooms).mockResolvedValue(room() as never);
  vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host()] as never);
  egress.startTrackCompositeEgress.mockResolvedValue({ egressId: 'EG_hls1' });
  egress.startRoomCompositeEgress.mockResolvedValue({ egressId: 'EG_tpl' });
  egress.stopEgress.mockResolvedValue(undefined);
});

// An SDK that can play HLS says so; tests send that unless they test without.
const listen = (payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/rooms/${ROOM}/listen`, payload: { hlsCapable: true, ...payload }, remoteAddress: nextIp() });
const join = (who: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/rooms/${ROOM}/join`, headers: auth[who], payload: { hlsCapable: true, ...payload } });
const tokenOpts = () => vi.mocked(lk.createLivekitToken).mock.calls.at(-1)![2];
/** Wait until the background egress start (real mkdir/chmod first) is done. */
const settle = () => vi.waitFor(() => { if (hls._hlsStartsPending() > 0) throw new Error('still starting'); }, { timeout: 2000, interval: 5 });

describe('choosing WebRTC or HLS', () => {
  it('below the threshold a viewer gets WebRTC, and is told it may ask for HLS', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-a')] as never);
    const res = await listen();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivery: 'webrtc', hlsFallback: true });
    expect(res.json().hlsUrl).toBeUndefined();
    expect(tokenOpts().canSubscribe).toBe(true);
    expect(egress.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it('at the threshold the next viewer gets HLS: no subscribe rights, the playlist URL, and the egress starts', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-a'), viewer('carol')] as never);
    const res = await listen();
    expect(res.json()).toMatchObject({ delivery: 'hls', hlsUrl: `/rooms/${ROOM}/hls/live.m3u8`, isGuest: true });
    expect(tokenOpts()).toMatchObject({ canSubscribe: false, canPublishData: true, canPublish: false });
    await settle();
    expect(egress.startTrackCompositeEgress).toHaveBeenCalledTimes(1);
    const [roomName, out, opts] = egress.startTrackCompositeEgress.mock.calls[0];
    expect(roomName).toBe(ROOM);
    expect(out.segments.livePlaylistName).toBe(`${DIR}/live.m3u8`);
    expect(out.segments.filenamePrefix).toMatch(new RegExp(`^${DIR}/s[0-9a-f]{8}$`));
    expect(opts).toMatchObject({ videoTrackId: 'TR_cam', audioTrackId: 'TR_mix' });
    expect(opts.encodingOptions).toMatchObject({ width: 1280, height: 720, videoBitrate: 1800 });
    expect(hls.hlsSessionDir(ROOM)).toBe(DIR);
  });

  it('a client that does not say it can play HLS is never moved there (older SDKs, StandaloneViewer)', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-a'), viewer('carol')] as never);
    const res = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/listen`, payload: { delivery: 'hls' }, remoteAddress: nextIp() });
    expect(res.json().delivery).toBe('webrtc');
    expect(res.json().hlsFallback).toBeUndefined();
    expect(tokenOpts().canSubscribe).toBe(true);
    const noBody = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/join`, headers: auth.bob });
    expect(noBody.json().delivery).toBe('webrtc');
  });

  it('signed-in viewers over the threshold get HLS through /join too', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-a'), viewer('carol')] as never);
    const res = await join('bob');
    expect(res.json()).toMatchObject({ identity: 'bob', delivery: 'hls', hlsUrl: `/rooms/${ROOM}/hls/live.m3u8` });
    expect(tokenOpts().canSubscribe).toBe(false);
  });

  it('only viewers LiveKit sends media to count: HLS viewers, the host, the co-host, OBS overlays and egress do not', async () => {
    vi.mocked(lk.roomService.listRooms).mockResolvedValue(room({ collabGuest: 'dave' }) as never);
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([
      host(), viewer('dave'), viewer('obs-abc'), viewer('EG_x', true, { kind: ParticipantInfo_Kind.EGRESS }),
      viewer('guest-h1', false), viewer('guest-h2', false), viewer('guest-a'),
    ] as never);
    expect((await listen()).json().delivery).toBe('webrtc');
  });

  it('a reconnecting viewer does not count against itself', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('bob'), viewer('carol')] as never);
    expect((await join('bob')).json().delivery).toBe('webrtc');
  });

  it('the host and an on-air co-host always get WebRTC with full rights', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([viewer('guest-a'), viewer('guest-b'), viewer('guest-c')] as never);
    const res = await join('alice');
    expect(res.json()).toMatchObject({ isHost: true, delivery: 'webrtc' });
    expect(tokenOpts()).toMatchObject({ canPublish: true, canSubscribe: true });
  });

  it('conference rooms are never moved to HLS', async () => {
    vi.mocked(lk.roomService.listRooms).mockResolvedValue(room({ mode: 'conference' }) as never);
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([viewer('a'), viewer('b'), viewer('c')] as never);
    const res = await listen();
    expect(res.json().delivery).toBe('webrtc');
    expect(res.json().hlsFallback).toBeUndefined();
  });

  it('a viewer on a poor connection can ask for HLS below the threshold', async () => {
    const res = await listen({ delivery: 'hls' });
    expect(res.json().delivery).toBe('hls');
    expect(tokenOpts().canSubscribe).toBe(false);
  });

  it('the OBS overlay stays on WebRTC and gets no delivery fields', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('a'), viewer('b'), viewer('c')] as never);
    const res = await listen({ silent: true });
    expect(res.json().identity).toMatch(/^obs-/);
    expect(res.json().delivery).toBeUndefined();
    expect(tokenOpts().canSubscribe).toBe(true);
  });

  it('a failed egress start hands out WebRTC for a minute instead of a dead playlist', async () => {
    egress.startTrackCompositeEgress.mockRejectedValue(new Error('no egress capacity'));
    egress.startRoomCompositeEgress.mockRejectedValue(new Error('no egress capacity'));
    await listen({ delivery: 'hls' });
    await settle(); await settle();
    expect(hls.hlsUnavailable(ROOM)).toBe(true);
    expect((await listen({ delivery: 'hls' })).json().delivery).toBe('webrtc');
  });

  it('falls back to the standalone template when the host has no program track yet', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host([])] as never);
    await listen({ delivery: 'hls' });
    await settle(); await settle();
    expect(egress.startRoomCompositeEgress).toHaveBeenCalledTimes(1);
    expect(hls.hlsSessionDir(ROOM)).toBe(DIR);
  });

  it('picks the program track matching the stream shape when the host publishes two', async () => {
    vi.mocked(lk.roomService.listRooms).mockResolvedValue(room({ portrait: false }) as never);
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host([
      { sid: 'TR_vert', type: TrackType.VIDEO, source: TrackSource.CAMERA, width: 720, height: 1280 },
      { sid: 'TR_land', type: TrackType.VIDEO, source: TrackSource.CAMERA, width: 1280, height: 720 },
    ])] as never);
    await listen({ delivery: 'hls' });
    await settle();
    expect(egress.startTrackCompositeEgress.mock.calls[0][2].videoTrackId).toBe('TR_land');
  });

  it('never carries the studio-vertical phone track, whatever its source or shape (same pick as DVR and VOD)', async () => {
    vi.mocked(lk.roomService.listRooms).mockResolvedValue(room({ portrait: false }) as never);
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host([
      { sid: 'TR_v1', name: 'studio-vertical', type: TrackType.VIDEO, source: TrackSource.CAMERA, width: 1280, height: 720 },
      { sid: 'TR_v2', name: 'studio-vertical', type: TrackType.VIDEO, source: TrackSource.UNKNOWN, width: 406, height: 720 },
      { sid: 'TR_prog', name: 'studio-program', type: TrackType.VIDEO, source: TrackSource.CAMERA, width: 1280, height: 720 },
    ])] as never);
    await listen({ delivery: 'hls' });
    await settle();
    expect(egress.startTrackCompositeEgress.mock.calls[0][2].videoTrackId).toBe('TR_prog');
  });

  it('concurrent HLS joins share one egress', async () => {
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('a'), viewer('b')] as never);
    await Promise.all([listen(), listen(), listen()]);
    await settle();
    expect(egress.startTrackCompositeEgress).toHaveBeenCalledTimes(1);
  });
});

describe('the guest cap with HLS on', () => {
  it('counts only guests LiveKit sends media to, and gives a full room HLS instead of a 409', async () => {
    vi.resetModules();
    vi.stubEnv('MAX_GUESTS_PER_ROOM', '1');
    vi.stubEnv('HLS_VIEWER_THRESHOLD', '100');
    const { buildApp } = await import('../../src/app.js');
    const capped = await buildApp();
    const lk2 = await import('../../src/lib/livekit.js');
    vi.mocked(lk2.roomService.listRooms).mockResolvedValue(room() as never);
    vi.mocked(lk2.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-h', false)] as never);
    const first = await capped.inject({ method: 'POST', url: `/rooms/${ROOM}/listen`, payload: { hlsCapable: true }, remoteAddress: nextIp() });
    expect(first.json().delivery).toBe('webrtc');
    vi.mocked(lk2.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-a')] as never);
    const res = await capped.inject({ method: 'POST', url: `/rooms/${ROOM}/listen`, payload: { hlsCapable: true }, remoteAddress: nextIp() });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivery).toBe('hls');
    // A client that can't play HLS still gets the old 409.
    const old = await capped.inject({ method: 'POST', url: `/rooms/${ROOM}/listen`, payload: {}, remoteAddress: nextIp() });
    expect(old.statusCode).toBe(409);
    await capped.close();
    for (const [k, v] of Object.entries(HLS_ENV)) vi.stubEnv(k, v);
  });
});

describe('GET /rooms/:name/hls/:file', () => {
  const get = (file: string) => app.inject({ method: 'GET', url: `/rooms/${ROOM}/hls/${file}` });

  it('404s without caching while HLS is not running for the stream', async () => {
    const res = await get('live.m3u8');
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves the playlist for one second and segments as immutable, and refuses other names', async () => {
    await listen({ delivery: 'hls' });
    await settle();
    expect((await get('live.m3u8')).statusCode).toBe(404); // egress not written yet
    await mkdir(DIR, { recursive: true });
    await writeFile(`${DIR}/live.m3u8`, '#EXTM3U\n#EXTINF:2.000,\nsab_00001.ts\n');
    await writeFile(`${DIR}/sab_00001.ts`, Buffer.alloc(188));
    const pl = await get('live.m3u8');
    expect(pl.statusCode).toBe(200);
    expect(pl.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(pl.headers['cache-control']).toBe('public, max-age=1');
    expect(pl.body).toContain('sab_00001.ts');
    const seg = await get('sab_00001.ts');
    expect(seg.statusCode).toBe(200);
    expect(seg.headers['content-type']).toBe('video/mp2t');
    expect(seg.headers['cache-control']).toBe('public, max-age=86400, immutable');
    expect(seg.rawPayload.length).toBe(188);
    expect((await get('sab_00009.ts')).headers['cache-control']).toBe('no-store');
    expect((await get('index.m3u8')).statusCode).toBe(400);
    expect((await get('..%2Fsecret.ts')).statusCode).toBe(400);
  });
});

describe('sweeping HLS sessions', () => {
  const startSession = async () => {
    await listen({ delivery: 'hls' });
    await settle();
    await mkdir(DIR, { recursive: true });
    await writeFile(`${DIR}/live.m3u8`, '#EXTM3U\n');
  };

  it('stops the egress and removes the files when the stream ended', async () => {
    await startSession();
    vi.mocked(lk.roomService.listRooms).mockResolvedValue([] as never);
    await hls.sweepHlsSessions();
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_hls1');
    expect(hls.hlsSessionDir(ROOM)).toBeNull();
  });

  it('keeps a session with HLS viewers, and stops one idle for longer than the idle limit', async () => {
    await startSession();
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-h', false)] as never);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + hls.IDLE_STOP_MS + 1000);
    await utimes(`${DIR}/live.m3u8`, new Date(), new Date(now + hls.IDLE_STOP_MS + 1000));
    await hls.sweepHlsSessions();
    expect(hls.hlsSessionDir(ROOM)).toBe(DIR);
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host()] as never);
    spy.mockReturnValue(now + 2 * hls.IDLE_STOP_MS + 5000);
    await hls.sweepHlsSessions();
    expect(hls.hlsSessionDir(ROOM)).toBeNull();
    spy.mockRestore();
  });

  it('restarts a stalled egress while the host is still publishing', async () => {
    await startSession();
    vi.mocked(lk.roomService.listParticipants).mockResolvedValue([host(), viewer('guest-h', false)] as never);
    const old = new Date(Date.now() - hls.STALL_MS - 5000);
    await utimes(`${DIR}/live.m3u8`, old, old);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + hls.STALL_MS + 5000);
    egress.startTrackCompositeEgress.mockResolvedValue({ egressId: 'EG_hls2' });
    await hls.sweepHlsSessions();
    spy.mockRestore();
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_hls1');
    expect(egress.startTrackCompositeEgress).toHaveBeenCalledTimes(2);
    // A fresh segment prefix every time: a CDN caches segments as immutable.
    const prefixes = egress.startTrackCompositeEgress.mock.calls.map((c) => c[1].segments.filenamePrefix);
    expect(prefixes[0]).not.toBe(prefixes[1]);
  });
});

describe('HLS_VIEWER_THRESHOLD default', () => {
  const loadConfig = async (value: string | undefined) => {
    vi.resetModules();
    if (value === undefined) delete process.env.HLS_VIEWER_THRESHOLD;
    else process.env.HLS_VIEWER_THRESHOLD = value;
    return (await import('../../src/config.js')).config;
  };
  afterAll(() => { process.env.HLS_VIEWER_THRESHOLD = HLS_ENV.HLS_VIEWER_THRESHOLD; });

  it('is 50 when the variable is not set, so HLS works without any setup', async () => {
    expect((await loadConfig(undefined)).HLS_VIEWER_THRESHOLD).toBe(50);
  });

  it('is off when set empty, and 0 means every viewer on HLS', async () => {
    expect((await loadConfig('')).HLS_VIEWER_THRESHOLD).toBeNull();
    expect((await loadConfig(' ')).HLS_VIEWER_THRESHOLD).toBeNull();
    expect((await loadConfig('0')).HLS_VIEWER_THRESHOLD).toBe(0);
  });
});
