import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { TrackType, TrackSource } from '@livekit/protocol';
import { makeToken } from '../setup.js';

const egress = vi.hoisted(() => ({ startTrackEgress: vi.fn(), stopEgress: vi.fn() }));
const fsp = vi.hoisted(() => ({ mkdir: vi.fn(), chmod: vi.fn(), stat: vi.fn(), rm: vi.fn() }));
const spawnMock = vi.hoisted(() => vi.fn());
const createReadStreamMock = vi.hoisted(() => vi.fn());

vi.mock('livekit-server-sdk', async (orig) => {
  const actual = await orig<typeof import('livekit-server-sdk')>();
  return { ...actual, EgressClient: class { constructor() { return egress; } } };
});
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<object>()), ...fsp }));
vi.mock('node:fs', async (orig) => ({ ...(await orig<object>()), createReadStream: createReadStreamMock }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<object>()), spawn: spawnMock }));
vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), listParticipants: vi.fn(), updateRoomMetadata: vi.fn() },
}));
vi.mock('../../src/lib/users.js', () => ({ isUserBanned: vi.fn(), isUserPremium: vi.fn(), getUserStatus: vi.fn() }));

const ROOM = 'badadib-pod1';
let app: FastifyInstance;
let lk: typeof import('../../src/lib/livekit.js')['roomService'];
let users: typeof import('../../src/lib/users.js');
let pod: typeof import('../../src/lib/podcastRecording.js');
/** path -> size on "disk" */
let disk: Record<string, number>;
let roomMeta: Record<string, unknown>;

const mic = (sid: string) => ({ sid, type: TrackType.AUDIO, source: TrackSource.MICROPHONE });
const speaker = (identity: string, sid: string) => ({ identity, tracks: [mic(sid)] });
const listener = (identity: string) => ({ identity, tracks: [] });
const bearer = async (u: string) => ({ authorization: `Bearer ${await makeToken(u)}` });

function fakeProc(code: number | Error) {
  const p = new EventEmitter();
  queueMicrotask(() => (code instanceof Error ? p.emit('error', code) : p.emit('close', code)));
  return p;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.resetModules();
  disk = {};
  roomMeta = { host: 'badadib', mode: 'conference', title: 'Weekly show' };
  lk = (await import('../../src/lib/livekit.js')).roomService;
  users = await import('../../src/lib/users.js');
  pod = await import('../../src/lib/podcastRecording.js');
  pod.resetPodcastRecording();
  const { podcastRoutes } = await import('../../src/routes/podcast.js');
  vi.mocked(lk.listRooms).mockImplementation(async () => [{ name: ROOM, metadata: JSON.stringify(roomMeta) }] as never);
  vi.mocked(lk.updateRoomMetadata).mockImplementation(async (_n: string, m: string) => { roomMeta = JSON.parse(m); return {} as never; });
  vi.mocked(lk.listParticipants).mockResolvedValue([speaker('badadib', 'TR_h'), listener('fan')] as never);
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
  vi.mocked(users.getUserStatus).mockResolvedValue({ premium: true } as never);
  let n = 0;
  egress.startTrackEgress.mockImplementation(async (_room: string, out: { filepath: string }) => {
    disk[out.filepath] = 5000;
    return { egressId: `EG_${++n}` };
  });
  egress.stopEgress.mockResolvedValue({});
  fsp.mkdir.mockResolvedValue(undefined);
  fsp.chmod.mockResolvedValue(undefined);
  fsp.rm.mockResolvedValue(undefined);
  fsp.stat.mockImplementation(async (p: string) => {
    if (disk[p] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { size: disk[p] };
  });
  spawnMock.mockImplementation((_bin: string, args: string[]) => {
    disk[args[args.length - 1]] = 9000;
    return fakeProc(0);
  });
  createReadStreamMock.mockImplementation(() => Readable.from([Buffer.from('AUDIO')]));
  app = Fastify();
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(podcastRoutes);
});
afterEach(async () => {
  await app.close();
  pod.resetPodcastRecording();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const call = async (method: 'POST' | 'GET', path: string, user: string | null = 'badadib', payload?: unknown) =>
  app.inject({ method, url: path, headers: user ? await bearer(user) : {}, ...(payload ? { payload } : {}) });

/** Let the background mix (file waits on 500 ms timers) finish. */
async function settle() { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(500); }

describe('start', () => {
  it('records each speaker\'s microphone with a track egress and marks the room podcastLive', async () => {
    const res = await call('POST', `/rooms/${ROOM}/podcast/start`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recording: true, speakers: 1 });
    const [room, out, trackId] = egress.startTrackEgress.mock.calls[0];
    expect(room).toBe(ROOM);
    expect(trackId).toBe('TR_h');
    expect(out.filepath).toMatch(new RegExp(`^/tmp/livekit-recordings/podcast/${ROOM}-\\d+/badadib-1\\.ogg$`));
    expect(fsp.chmod).toHaveBeenCalledWith('/tmp/livekit-recordings/podcast', 0o777);
    expect(roomMeta.podcastLive).toEqual({ startedAt: expect.any(String) });
    // Idempotent.
    await call('POST', `/rooms/${ROOM}/podcast/start`);
    expect(egress.startTrackEgress).toHaveBeenCalledTimes(1);
  });

  it('only the host of an existing audio room with Pro, and only when switched on', async () => {
    expect((await call('POST', `/rooms/${ROOM}/podcast/start`, null)).statusCode).toBe(401);
    expect((await call('POST', `/rooms/${ROOM}/podcast/start`, 'fan')).statusCode).toBe(403);
    vi.mocked(users.getUserStatus).mockResolvedValueOnce({ premium: false } as never);
    expect((await call('POST', `/rooms/${ROOM}/podcast/start`)).statusCode).toBe(402);
    roomMeta.mode = 'standalone';
    expect((await call('POST', `/rooms/${ROOM}/podcast/start`)).statusCode).toBe(400);
    vi.mocked(lk.listRooms).mockResolvedValueOnce([] as never);
    expect((await call('POST', `/rooms/${ROOM}/podcast/start`)).statusCode).toBe(404);
    expect(egress.startTrackEgress).not.toHaveBeenCalled();
  });

  it('503 when PODCAST_RECORDING_ENABLED=false', async () => {
    await app.close();
    vi.resetModules();
    vi.stubEnv('PODCAST_RECORDING_ENABLED', 'false');
    const { podcastRoutes } = await import('../../src/routes/podcast.js');
    app = Fastify();
    await app.register(sensible);
    await app.register(rateLimit, { global: false });
    await app.register(podcastRoutes);
    expect((await call('POST', `/rooms/${ROOM}/podcast/start`)).statusCode).toBe(503);
  });
});

describe('a show, end to end', () => {
  it('follows the stage, takes markers, and on stop mixes the speakers at their offsets with chapters', async () => {
    await call('POST', `/rooms/${ROOM}/podcast/start`);
    // 2 minutes in, fan is brought on stage (a new mic track).
    await vi.advanceTimersByTimeAsync(110_000);
    vi.mocked(lk.listParticipants).mockResolvedValue([speaker('badadib', 'TR_h'), speaker('fan', 'TR_f')] as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(egress.startTrackEgress).toHaveBeenCalledTimes(2);
    expect(egress.startTrackEgress.mock.calls[1][2]).toBe('TR_f');

    const status = (await call('GET', `/rooms/${ROOM}/podcast/status`)).json();
    expect(status).toMatchObject({ recording: true, speakers: ['badadib', 'fan'], chapters: 0 });
    expect((await call('GET', `/rooms/${ROOM}/podcast/status`, 'fan')).json()).toEqual({ recording: false });

    await vi.advanceTimersByTimeAsync(60_000);
    const mark = await call('POST', `/rooms/${ROOM}/podcast/marker`, 'badadib', { title: 'Questions\nfrom chat' });
    expect(mark.json()).toEqual({ ok: true, at: 180 });
    expect((await call('POST', `/rooms/${ROOM}/podcast/marker`, 'fan', { title: 'x' })).statusCode).toBe(403);
    expect((await call('POST', `/rooms/${ROOM}/podcast/marker`, 'badadib', { title: '   ' })).statusCode).toBe(400);

    // fan steps down, then comes back on a new track.
    vi.mocked(lk.listParticipants).mockResolvedValue([speaker('badadib', 'TR_h')] as never);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.mocked(lk.listParticipants).mockResolvedValue([speaker('badadib', 'TR_h'), speaker('fan', 'TR_f2')] as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(egress.startTrackEgress.mock.calls[2][1].filepath).toMatch(/fan-2\.ogg$/);

    await vi.advanceTimersByTimeAsync(100_000);
    expect((await call('POST', `/rooms/${ROOM}/podcast/stop`, 'fan')).statusCode).toBe(403);
    const stop = await call('POST', `/rooms/${ROOM}/podcast/stop`);
    expect(stop.statusCode).toBe(200);
    const r = stop.json();
    expect(r).toMatchObject({ status: 'mixing', durationSec: 300, title: 'Weekly show', mixUrl: null });
    expect(egress.stopEgress).toHaveBeenCalledTimes(3);
    expect(r.tracks.map((t: { identity: string; offsetSec: number }) => [t.identity, t.offsetSec])).toEqual([['badadib', 0], ['fan', 120], ['fan', 200]]);
    expect(r.chapters).toEqual([
      { start: 0, kind: 'start' },
      { start: 120, kind: 'join', identity: 'fan' },
      { start: 180, kind: 'marker', title: 'Questions from chat' },
    ]);
    expect(roomMeta.podcastLive).toBeUndefined();

    await settle();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('nice');
    expect(args.slice(0, 3)).toEqual(['-n', '15', 'ffmpeg']);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('adelay=120000:all=1');
    expect(filter).toContain('amix=inputs=3:normalize=0');
    expect(args[args.length - 1]).toMatch(/episode\.mp3$/);

    const list = (await call('GET', '/podcast/recordings')).json().recordings;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('ready');
    expect(list[0].mixUrl).toMatch(/^\/podcast\/files\/[0-9a-f]{32}\/episode\.mp3$/);
    expect((await call('GET', '/podcast/recordings', 'fan')).json().recordings).toEqual([]);

    const mp3 = await call('GET', list[0].mixUrl, null);
    expect(mp3.statusCode).toBe(200);
    expect(mp3.headers['content-type']).toBe('audio/mpeg');
    const ogg = await call('GET', list[0].tracks[1].url, null);
    expect(ogg.headers['content-type']).toBe('audio/ogg');
    expect((await call('GET', `/podcast/files/${'0'.repeat(32)}/episode.mp3`, null)).statusCode).toBe(404);
    expect((await call('GET', list[0].mixUrl.replace('episode.mp3', 'other.mp3'), null)).statusCode).toBe(404);
    expect((await call('POST', `/rooms/${ROOM}/podcast/stop`)).statusCode).toBe(400);
  });

  it('a mix that fails leaves the result failed (speaker files still listed)', async () => {
    await call('POST', `/rooms/${ROOM}/podcast/start`);
    spawnMock.mockImplementation(() => fakeProc(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await call('POST', `/rooms/${ROOM}/podcast/stop`);
    await settle();
    const [r] = (await call('GET', '/podcast/recordings')).json().recordings;
    expect(r).toMatchObject({ status: 'failed', mixUrl: null });
    expect(r.tracks).toHaveLength(1);
  });

  it('nothing recorded at all is a failed result; a missing file is a 404', async () => {
    egress.startTrackEgress.mockResolvedValue({ egressId: 'EG_x' }); // never writes a file
    await call('POST', `/rooms/${ROOM}/podcast/start`);
    await call('POST', `/rooms/${ROOM}/podcast/stop`);
    for (let i = 0; i < 70; i++) await vi.advanceTimersByTimeAsync(500);
    const [r] = (await call('GET', '/podcast/recordings')).json().recordings;
    expect(r).toMatchObject({ status: 'failed', tracks: [] });
  });

  it('a room that closes while recording still becomes an episode, and results expire after a day', async () => {
    await call('POST', `/rooms/${ROOM}/podcast/start`);
    vi.mocked(lk.listParticipants).mockRejectedValue(new Error('room gone'));
    vi.mocked(lk.listRooms).mockResolvedValue([] as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(pod.podcastResultsFor('badadib')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000 + 20_000);
    expect(pod.podcastResultsFor('badadib')).toHaveLength(0);
    expect(fsp.rm).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/livekit-recordings\/podcast\//), { recursive: true, force: true });
  });

  it('a LiveKit hiccup (participants fail but the room exists) keeps recording; a failed egress start is skipped', async () => {
    egress.startTrackEgress.mockRejectedValueOnce(new Error('egress busy'));
    await call('POST', `/rooms/${ROOM}/podcast/start`);
    expect((await call('GET', `/rooms/${ROOM}/podcast/status`)).json().speakers).toEqual([]);
    vi.mocked(lk.listParticipants).mockRejectedValueOnce(new Error('blip'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call('GET', `/rooms/${ROOM}/podcast/status`)).json().recording).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call('GET', `/rooms/${ROOM}/podcast/status`)).json().speakers).toEqual(['badadib']);
  });

  it('stop and marker without a recording are 400s', async () => {
    expect((await call('POST', `/rooms/${ROOM}/podcast/stop`)).statusCode).toBe(400);
    expect((await call('POST', `/rooms/${ROOM}/podcast/marker`, 'badadib', { title: 'x' })).statusCode).toBe(400);
  });
});

describe('pure helpers', () => {
  it('chaptersFrom: merges chapters under 30 s apart (a marker wins), ignores the host and repeat joins', () => {
    const t0 = 1_000_000;
    const ev = [
      { at: t0 + 10_000, type: 'join' as const, identity: 'badadib' },
      { at: t0 + 60_000, type: 'join' as const, identity: 'fan' },
      { at: t0 + 70_000, type: 'marker' as const, title: 'Q&A' },
      { at: t0 + 80_000, type: 'leave' as const, identity: 'fan' },
      { at: t0 + 200_000, type: 'join' as const, identity: 'fan' },
      { at: t0 + 15_000, type: 'marker' as const, title: 'too early' },
      { at: t0 + 999_000, type: 'marker' as const, title: 'after the end' },
    ];
    expect(pod.chaptersFrom(ev, t0, 'badadib', 600)).toEqual([
      { start: 0, kind: 'start' },
      { start: 70, kind: 'marker', title: 'Q&A' },
    ]);
  });

  it('mixArgs: one speaker needs no amix', () => {
    const args = pod.mixArgs([{ path: '/a.ogg', offsetSec: 1.5 }], '/o.mp3');
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:a]aresample=async=1:first_pts=0,adelay=1500:all=1[a0];[a0]anull[out]');
    expect(args.slice(-7)).toEqual(['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', '/o.mp3']);
  });

  it('caps speaker tracks per show and markers per show', async () => {
    const many = Array.from({ length: 20 }, (_, i) => speaker(`s${i}`, `TR_${i}`));
    vi.mocked(lk.listParticipants).mockResolvedValue(many as never);
    await call('POST', `/rooms/${ROOM}/podcast/start`);
    expect(egress.startTrackEgress).toHaveBeenCalledTimes(pod.MAX_SPEAKER_TRACKS);
    for (let i = 0; i < 100; i++) pod.addPodcastMarker(ROOM, `m${i}`);
    expect(pod.addPodcastMarker(ROOM, 'one more')).toBe(false);
    expect(pod.addPodcastMarker('nope', 'x')).toBe(false);
  });
});
