import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { TrackType, TrackSource } from '@livekit/protocol';
import { makeToken } from '../setup.js';

const egress = vi.hoisted(() => ({
  startRoomCompositeEgress: vi.fn(),
  startTrackCompositeEgress: vi.fn(),
  stopEgress: vi.fn(),
}));

const fsp = vi.hoisted(() => ({
  readdir: vi.fn(), stat: vi.fn(), unlink: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), rm: vi.fn(),
}));
const spawnMock = vi.hoisted(() => vi.fn());
const createReadStreamMock = vi.hoisted(() => vi.fn());

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  return { ...actual, EgressClient: class { constructor() { return egress; } } };
});
vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<object>()), ...fsp }));
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<object>()), createReadStream: createReadStreamMock }));
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), spawn: spawnMock }));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), listParticipants: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn() },
}));
vi.mock('../../src/lib/users.js', () => ({ isUserBanned: vi.fn(), isUserPremium: vi.fn() }));

const ROOM = 'alice-dvr1234';
const DVR_DIR = '/tmp/livekit-recordings/dvr';
const SEG_DIR = `${DVR_DIR}/${ROOM}`;
const CLIP_DIR = '/tmp/livekit-dvr-clips';

const hostWithTracks = (tracks: Array<Record<string, unknown>>) => [{ identity: 'alice', tracks }];
const camera = (extra: Record<string, unknown> = {}) => ({ sid: 'TR_cam', type: TrackType.VIDEO, source: TrackSource.CAMERA, width: 1080, height: 1920, ...extra });
const mic = (sid: string, name: string) => ({ sid, name, type: TrackType.AUDIO, source: TrackSource.MICROPHONE });

/** A fake ffmpeg process that exits with `code` (or emits a spawn error). */
function fakeFfmpeg(code: number | Error) {
  const p = new EventEmitter();
  queueMicrotask(() => (code instanceof Error ? p.emit('error', code) : p.emit('close', code)));
  return p;
}

let app: FastifyInstance;
let auth: Record<string, string>;
let lk: typeof import('../../src/lib/livekit.js')['roomService'];
let users: typeof import('../../src/lib/users.js');
let dvr: typeof import('../../src/routes/dvr.js');
/** dir -> { file -> mtimeMs } — what readdir/stat see. */
let disk: Record<string, Record<string, number>>;

async function setup(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  lk = (await import('../../src/lib/livekit.js')).roomService;
  users = await import('../../src/lib/users.js');
  dvr = await import('../../src/routes/dvr.js');
  app = Fastify();
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(dvr.dvrRoutes);
  auth = { authorization: `Bearer ${await makeToken('alice')}` };
}

beforeEach(async () => {
  // Module-level setIntervals register at import, so fake timers come first.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  disk = {};
  fsp.readdir.mockImplementation(async (dir: string) => {
    if (!disk[dir]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Object.keys(disk[dir]);
  });
  fsp.stat.mockImplementation(async (p: string) => {
    const i = p.lastIndexOf('/');
    const m = disk[p.slice(0, i)]?.[p.slice(i + 1)];
    if (m === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { mtimeMs: m, size: 1234 };
  });
  fsp.unlink.mockResolvedValue(undefined);
  fsp.mkdir.mockResolvedValue(undefined);
  fsp.chmod.mockResolvedValue(undefined);
  fsp.rm.mockResolvedValue(undefined);
  spawnMock.mockImplementation(() => fakeFfmpeg(0));
  createReadStreamMock.mockImplementation(() => Readable.from([Buffer.from('MP4DATA')]));
  egress.startTrackCompositeEgress.mockResolvedValue({ egressId: 'EG_track' });
  egress.startRoomCompositeEgress.mockResolvedValue({ egressId: 'EG_room' });
  egress.stopEgress.mockResolvedValue({});
  await setup();
  vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: JSON.stringify({ host: 'alice', mode: 'standalone' }) }] as never);
  vi.mocked(lk.listParticipants).mockResolvedValue(hostWithTracks([camera(), mic('TR_mon', 'host-monitor'), mic('TR_mix', 'studio-mix')]) as never);
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
  vi.mocked(users.isUserPremium).mockResolvedValue(true);
});

afterEach(async () => {
  await app.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const post = (path: string, headers = auth) => app.inject({ method: 'POST', url: `/rooms/${ROOM}/dvr/${path}`, headers });
const dvrStatus = async () => (await app.inject({ method: 'GET', url: `/rooms/${ROOM}/dvr/status` })).json();

describe('DVR start', () => {
  it('returns 503 when DVR is disabled by config, whoever asks', async () => {
    await app.close();
    await setup({ DVR_ENABLED: 'false' });
    const res = await post('start');
    expect(res.statusCode).toBe(503);
    expect(egress.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it('requires a session token (401)', async () => {
    expect((await post('start', {})).statusCode).toBe(401);
  });

  it('returns 404 for a missing room and 403 for a non-host', async () => {
    vi.mocked(lk.listRooms).mockResolvedValueOnce([] as never);
    expect((await post('start')).statusCode).toBe(404);
    expect((await post('start', { authorization: `Bearer ${await makeToken('bob')}` })).statusCode).toBe(403);
    expect(fsp.mkdir).not.toHaveBeenCalled();
  });

  it('returns 402 for a host without Pro', async () => {
    vi.mocked(users.isUserPremium).mockResolvedValue(false);
    const res = await post('start');
    expect(res.statusCode).toBe(402);
    expect(egress.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it('records the host program track (studio-mix, not host-monitor) at its own size into a world-writable segment dir', async () => {
    const res = await post('start');
    expect(res.json()).toEqual({ status: 'recording', egressId: 'EG_track' });
    expect(fsp.mkdir).toHaveBeenCalledWith(SEG_DIR, { recursive: true });
    expect(fsp.chmod).toHaveBeenCalledWith(DVR_DIR, 0o777);
    expect(fsp.chmod).toHaveBeenCalledWith(SEG_DIR, 0o777);
    const [room, out, opts] = egress.startTrackCompositeEgress.mock.calls[0];
    expect(room).toBe(ROOM);
    expect(out.segments.filenamePrefix).toBe(`${SEG_DIR}/seg`);
    expect(out.segments.playlistName).toBe(`${SEG_DIR}/index.m3u8`);
    expect(opts).toMatchObject({ videoTrackId: 'TR_cam', audioTrackId: 'TR_mix' });
    expect(opts.encodingOptions).toMatchObject({ width: 1080, height: 1920, framerate: 30 });
    expect(await dvrStatus()).toEqual({ recording: true });
  });

  it('falls back to the first microphone when none is named studio-mix', async () => {
    vi.mocked(lk.listParticipants).mockResolvedValue(hostWithTracks([camera(), mic('TR_a', 'mic'), mic('TR_b', 'mic2')]) as never);
    await post('start');
    expect(egress.startTrackCompositeEgress.mock.calls[0][2].audioTrackId).toBe('TR_a');
  });

  it('a chmod failure is ignored (best effort)', async () => {
    fsp.chmod.mockRejectedValue(new Error('EPERM'));
    expect((await post('start')).statusCode).toBe(200);
  });

  it('is idempotent: a second start returns the running egress without starting another', async () => {
    await post('start');
    const again = await post('start');
    expect(again.json()).toEqual({ status: 'recording', egressId: 'EG_track' });
    expect(egress.startTrackCompositeEgress).toHaveBeenCalledTimes(1);
    expect(await dvr.startDvrSession(ROOM, {}, { warn: vi.fn() })).toBe('EG_track');
  });

  it('without a host camera track it uses the standalone template at portrait size for a portrait stream', async () => {
    vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: JSON.stringify({ host: 'alice', portrait: true }) }] as never);
    vi.mocked(lk.listParticipants).mockResolvedValue(hostWithTracks([mic('TR_mix', 'studio-mix')]) as never);
    const res = await post('start');
    expect(res.json().egressId).toBe('EG_room');
    expect(egress.startTrackCompositeEgress).not.toHaveBeenCalled();
    const [, out, opts] = egress.startRoomCompositeEgress.mock.calls[0];
    expect(out.segments).toBeDefined();
    expect(opts.customBaseUrl).toBe('https://3speak.tv/egress-stream');
    expect(opts.encodingOptions).toMatchObject({ width: 720, height: 1280 });
  });

  it('when LiveKit cannot list participants it falls back to the template at landscape size', async () => {
    vi.mocked(lk.listParticipants).mockRejectedValue(new Error('twirp down'));
    await post('start');
    expect(egress.startRoomCompositeEgress.mock.calls[0][2].encodingOptions).toMatchObject({ width: 1280, height: 720 });
  });

  it('when the track composite is refused by LiveKit it falls back to the template composite', async () => {
    egress.startTrackCompositeEgress.mockRejectedValueOnce(new Error('unsupported codec'));
    const res = await post('start');
    expect(res.json().egressId).toBe('EG_room');
    expect(egress.startRoomCompositeEgress.mock.calls[0][2].encodingOptions).toMatchObject({ width: 1080, height: 1920 });
  });

  it('when both egress kinds fail it returns 500 and leaves no session or janitor behind', async () => {
    egress.startTrackCompositeEgress.mockRejectedValueOnce(new Error('a'));
    egress.startRoomCompositeEgress.mockRejectedValueOnce(new Error('b'));
    expect((await post('start')).statusCode).toBe(500);
    expect(await dvrStatus()).toEqual({ recording: false });
    expect(vi.getTimerCount()).toBe(2); // only the two module-level sweeps
  });

  it('turns unsafe characters of the room name into underscores in the segment dir', async () => {
    await dvr.startDvrSession('a.b c/d', { host: 'nobody' }, { warn: vi.fn() });
    expect(fsp.mkdir).toHaveBeenCalledWith(`${DVR_DIR}/a_b_c_d`, { recursive: true });
  });
});

describe('DVR segment janitor', () => {
  it('every 30 s deletes only .ts segments older than the 150 s buffer', async () => {
    await post('start');
    const now = Date.now();
    disk[SEG_DIR] = {
      'seg_old.ts': now - 200_000,
      'seg_new.ts': now - 1_000,
      'index.m3u8': now - 999_999,
    };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fsp.unlink).toHaveBeenCalledTimes(1);
    expect(fsp.unlink).toHaveBeenCalledWith(`${SEG_DIR}/seg_old.ts`);
  });

  it('a segment that vanishes between readdir and stat, or a missing dir, is tolerated', async () => {
    await post('start');
    await vi.advanceTimersByTimeAsync(30_000); // dir not created yet
    disk[SEG_DIR] = { 'gone.ts': 0 };
    fsp.stat.mockRejectedValueOnce(new Error('ENOENT'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fsp.unlink).not.toHaveBeenCalled();
  });
});

describe('DVR clip', () => {
  const clip = () => app.inject({ method: 'POST', url: `/rooms/${ROOM}/dvr/clip`, remoteAddress: `10.0.0.${Math.floor(Math.random() * 250)}` });

  it('returns 400 when the room has no DVR session', async () => {
    const res = await clip();
    expect(res.statusCode).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 400 when no segment falls inside the clip window yet', async () => {
    await post('start');
    disk[SEG_DIR] = { 'seg_old.ts': Date.now() - 60_000 };
    const res = await clip();
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Nothing recorded yet/);
  });

  it('concats the last ~34 s of segments in time order with ffmpeg (no re-encode) and returns a clip path', async () => {
    await post('start');
    const now = Date.now();
    disk[SEG_DIR] = {
      'seg_c.ts': now - 2_000,
      'seg_a.ts': now - 33_000,
      'seg_b.ts': now - 20_000,
      'seg_too_old.ts': now - 40_000,
      'live.m3u8': now,
    };
    const res = await clip();
    expect(res.statusCode).toBe(200);
    const { path } = res.json();
    expect(path).toMatch(new RegExp(`^/dvr/clips/${ROOM}-\\d+-[0-9a-f]{8}\\.mp4$`));
    expect(fsp.mkdir).toHaveBeenCalledWith(CLIP_DIR, { recursive: true });
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('ffmpeg');
    expect(args).toContain(`concat:${SEG_DIR}/seg_a.ts|${SEG_DIR}/seg_b.ts|${SEG_DIR}/seg_c.ts`);
    expect(args).toEqual(expect.arrayContaining(['-c', 'copy']));
    expect(args[args.length - 1]).toBe(`${CLIP_DIR}/${path.split('/').pop()}`);
  });

  it('returns 500 when ffmpeg exits non-zero', async () => {
    await post('start');
    disk[SEG_DIR] = { 's.ts': Date.now() };
    spawnMock.mockImplementationOnce(() => fakeFfmpeg(1));
    const res = await clip();
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe('Could not build the clip.');
  });

  it('returns 500 when ffmpeg cannot be spawned at all', async () => {
    await post('start');
    disk[SEG_DIR] = { 's.ts': Date.now() };
    spawnMock.mockImplementationOnce(() => fakeFfmpeg(new Error('spawn ffmpeg ENOENT')));
    expect((await clip()).statusCode).toBe(500);
  });

  it('is rate limited to 6 clips per minute per IP', async () => {
    await post('start');
    disk[SEG_DIR] = { 's.ts': Date.now() };
    const fromOneIp = () => app.inject({ method: 'POST', url: `/rooms/${ROOM}/dvr/clip`, remoteAddress: '10.9.9.9' });
    for (let i = 0; i < 6; i++) expect((await fromOneIp()).statusCode).toBe(200);
    expect((await fromOneIp()).statusCode).toBe(429);
  });
});

describe('DVR clip download', () => {
  const get = (file: string) => app.inject({ method: 'GET', url: `/dvr/clips/${file}` });

  it('rejects names that are not a plain .mp4 file name, or contain ".."', async () => {
    expect((await get('clip.txt')).statusCode).toBe(400);
    expect((await get('a..b.mp4')).statusCode).toBe(400);
    expect((await get('a%2Fb.mp4')).statusCode).toBe(400);
    expect(fsp.stat).not.toHaveBeenCalled();
  });

  it('returns 404 for a clip that does not exist (or was swept)', async () => {
    expect((await get('nope.mp4')).statusCode).toBe(404);
  });

  it('streams an existing clip inline as video/mp4 with its size', async () => {
    disk[CLIP_DIR] = { 'room-1-abcd.mp4': Date.now() };
    const res = await get('room-1-abcd.mp4');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe('1234');
    expect(res.headers['content-disposition']).toBe('inline; filename="room-1-abcd.mp4"');
    expect(createReadStreamMock).toHaveBeenCalledWith(`${CLIP_DIR}/room-1-abcd.mp4`);
  });
});

describe('DVR stop and status', () => {
  it('status is public and false when nothing is recording', async () => {
    expect(await dvrStatus()).toEqual({ recording: false });
  });

  it('stop requires a session token (401)', async () => {
    expect((await post('stop', {})).statusCode).toBe(401);
  });

  it('a non-host cannot stop the DVR (403) and the session keeps running', async () => {
    await post('start');
    expect((await post('stop', { authorization: `Bearer ${await makeToken('bob')}` })).statusCode).toBe(403);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    expect(await dvrStatus()).toEqual({ recording: true });
  });

  it('the host stop ends the egress, deletes the segment dir and stops the janitor', async () => {
    await post('start');
    const res = await post('stop');
    expect(res.json()).toEqual({ status: 'stopped' });
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_track');
    expect(fsp.rm).toHaveBeenCalledWith(SEG_DIR, { recursive: true, force: true });
    expect(await dvrStatus()).toEqual({ recording: false });
    fsp.readdir.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fsp.readdir).not.toHaveBeenCalledWith(SEG_DIR);
  });

  it('stop still tears down when the room was already deleted (no 404 leak)', async () => {
    await post('start');
    vi.mocked(lk.listRooms).mockResolvedValueOnce([] as never);
    expect((await post('stop')).statusCode).toBe(200);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_track');
    expect(await dvrStatus()).toEqual({ recording: false });
  });

  it('stop succeeds when the egress already completed and the dir is already gone', async () => {
    await post('start');
    egress.stopEgress.mockRejectedValueOnce(new Error('egress not found'));
    fsp.rm.mockRejectedValueOnce(new Error('EBUSY'));
    expect((await post('stop')).statusCode).toBe(200);
    expect(await dvrStatus()).toEqual({ recording: false });
  });

  it('stop with no running session is a plain 200', async () => {
    expect((await post('stop')).json()).toEqual({ status: 'stopped' });
    expect(egress.stopEgress).not.toHaveBeenCalled();
  });

  it('stopDvrSession (headless teardown) tears down a running session and is a no-op otherwise', async () => {
    await dvr.stopDvrSession(ROOM);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    await post('start');
    await dvr.stopDvrSession(ROOM);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_track');
    expect(await dvrStatus()).toEqual({ recording: false });
  });
});

describe('DVR background sweeps', () => {
  it('every 45 s tears down a session whose room no longer exists', async () => {
    await post('start');
    vi.mocked(lk.listRooms).mockResolvedValue([] as never);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_track');
    expect(fsp.rm).toHaveBeenCalledWith(SEG_DIR, { recursive: true, force: true });
    expect(await dvrStatus()).toEqual({ recording: false });
  });

  it('keeps a session whose room still exists, or when LiveKit errors (retried next sweep)', async () => {
    await post('start');
    await vi.advanceTimersByTimeAsync(45_000);
    vi.mocked(lk.listRooms).mockRejectedValueOnce(new Error('twirp down'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    expect(await dvrStatus()).toEqual({ recording: true });
  });

  it('every 10 min deletes clips older than 1 h and keeps newer ones', async () => {
    const now = Date.now();
    disk[CLIP_DIR] = { 'old.mp4': now - 2 * 3600_000, 'fresh.mp4': now };
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fsp.unlink).toHaveBeenCalledTimes(1);
    expect(fsp.unlink).toHaveBeenCalledWith(`${CLIP_DIR}/old.mp4`);
  });

  it('the clip sweep tolerates a missing clip dir', async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fsp.unlink).not.toHaveBeenCalled();
  });
});
