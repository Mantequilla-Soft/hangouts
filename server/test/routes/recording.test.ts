import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { Readable } from 'node:stream';
import { TrackType, TrackSource } from '@livekit/protocol';
import { FREE_STREAM_CAP_MS } from '../../src/lib/streamQuota.js';
import { makeToken } from '../setup.js';

const egress = vi.hoisted(() => ({
  startRoomCompositeEgress: vi.fn(),
  startTrackCompositeEgress: vi.fn(),
  stopEgress: vi.fn(),
}));
const fsp = vi.hoisted(() => ({ readFile: vi.fn(), unlink: vi.fn(), stat: vi.fn() }));
const createReadStreamMock = vi.hoisted(() => vi.fn());

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  return { ...actual, EgressClient: class { constructor() { return egress; } } };
});
vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<object>()), ...fsp }));
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<object>()), createReadStream: createReadStreamMock }));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), listParticipants: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn() },
}));
vi.mock('../../src/lib/users.js', () => ({ isUserBanned: vi.fn(), isUserPremium: vi.fn() }));
vi.mock('../../src/lib/permissions.js', () => ({ canRecordVideo: vi.fn(), canRecordAudio: vi.fn() }));
vi.mock('../../src/lib/streamVodPublish.js', () => ({
  publishRecordingToVod: vi.fn(), getPublishState: vi.fn(), hasPublish: vi.fn(),
}));

const ROOM = 'alice-rec1234';
const SEC = 1e9; // egress reports durations in nanoseconds

type Lk = typeof import('../../src/lib/livekit.js')['roomService'];
let app: FastifyInstance;
let auth: Record<string, string>;
let bobAuth: Record<string, string>;
let lk: Lk;
let perms: typeof import('../../src/lib/permissions.js');
let vod: typeof import('../../src/lib/streamVodPublish.js');
let users: typeof import('../../src/lib/users.js');
let rec: typeof import('../../src/routes/recording.js');
let fetchMock: ReturnType<typeof vi.fn>;
let egressN = 0;

const camera = { sid: 'TR_cam', type: TrackType.VIDEO, source: TrackSource.CAMERA, width: 1080, height: 1920 };
const monitor = { sid: 'TR_mon', name: 'host-monitor', type: TrackType.AUDIO, source: TrackSource.MICROPHONE };
const studioMix = { sid: 'TR_mix', name: 'studio-mix', type: TrackType.AUDIO, source: TrackSource.MICROPHONE };
const hostPresent = () => vi.mocked(lk.listParticipants).mockResolvedValue([{ identity: 'alice', tracks: [camera, monitor, studioMix] }] as never);
const hostGone = () => vi.mocked(lk.listParticipants).mockResolvedValue([{ identity: 'bob', tracks: [] }] as never);

function setRoom(meta: Record<string, unknown> | null) {
  vi.mocked(lk.listRooms).mockResolvedValue((meta ? [{ name: ROOM, metadata: JSON.stringify(meta) }] : []) as never);
}
const STANDALONE = {
  host: 'alice', mode: 'standalone', backgroundImage: 'https://img.test/bg.png',
  post: { title: 'My stream', description: 'desc', tags: ['a', 'b'], thumbnail: 'https://img.test/thumb.png' },
};

async function setup(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  lk = (await import('../../src/lib/livekit.js')).roomService;
  perms = await import('../../src/lib/permissions.js');
  vod = await import('../../src/lib/streamVodPublish.js');
  users = await import('../../src/lib/users.js');
  rec = await import('../../src/routes/recording.js');
  app = Fastify();
  await app.register(sensible);
  await app.register(rec.recordingRoutes);
}

beforeEach(async () => {
  // The module registers its sweeps (download TTL, crash watchdog) at import.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  egressN = 0;
  const nextEgress = async () => ({ egressId: `EG_${++egressN}` });
  egress.startRoomCompositeEgress.mockImplementation(nextEgress);
  egress.startTrackCompositeEgress.mockImplementation(nextEgress);
  egress.stopEgress.mockImplementation(async (id: string) => ({
    egressId: id, fileResults: [{ filename: `/tmp/livekit-recordings/${id}.mp4`, duration: 12 * SEC }],
  }));
  fsp.unlink.mockResolvedValue(undefined);
  fsp.stat.mockResolvedValue({ size: 5 });
  fsp.readFile.mockResolvedValue(Buffer.alloc(80_000));
  createReadStreamMock.mockImplementation(() => Readable.from([Buffer.from('FILE!')]));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await setup();
  setRoom({ host: 'alice', title: 'Talk' });
  hostPresent();
  vi.mocked(lk.updateRoomMetadata).mockResolvedValue(undefined as never);
  vi.mocked(lk.deleteRoom).mockResolvedValue(undefined as never);
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
  vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: true });
  vi.mocked(perms.canRecordAudio).mockResolvedValue({ ok: true });
  vi.mocked(vod.hasPublish).mockReturnValue(false);
  vi.mocked(vod.getPublishState).mockReturnValue(null);
  vi.mocked(vod.publishRecordingToVod).mockResolvedValue(undefined);
  auth = { authorization: `Bearer ${await makeToken('alice')}` };
  bobAuth = { authorization: `Bearer ${await makeToken('bob')}` };
});

afterEach(async () => {
  await app.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const startRec = (payload?: Record<string, unknown>, headers = auth) =>
  app.inject({ method: 'POST', url: `/rooms/${ROOM}/record/start`, headers, ...(payload ? { payload } : {}) });
const stopRec = (headers = auth) => app.inject({ method: 'POST', url: `/rooms/${ROOM}/record/stop`, headers });
const recStatus = async () => (await app.inject({ method: 'GET', url: `/rooms/${ROOM}/record/status`, headers: auth })).json();
/** Path part of a downloadUrl, injected without auth like a plain <a download>. */
const download = (url: string) => app.inject({ method: 'GET', url });

describe('record start: access', () => {
  it('requires a session token (401)', async () => {
    expect((await startRec(undefined, {})).statusCode).toBe(401);
  });

  it('refuses a banned user (403)', async () => {
    vi.mocked(users.isUserBanned).mockResolvedValue(true);
    expect((await startRec()).statusCode).toBe(403);
    expect(lk.listRooms).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing room and 403 for a non-host', async () => {
    setRoom(null);
    expect((await startRec()).statusCode).toBe(404);
    setRoom({ host: 'alice' });
    const res = await startRec(undefined, bobAuth);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Only the host can start recording');
  });

  it('treats unreadable room metadata as "not the host" (403)', async () => {
    vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: 'nope{' }] as never);
    expect((await startRec()).statusCode).toBe(403);
  });

  it('rejects an unknown mode or layout (400)', async () => {
    expect((await startRec({ mode: 'gif' })).statusCode).toBe(400);
    expect((await startRec({ layout: 'mosaic' })).statusCode).toBe(400);
  });

  it('an audio recording needs Pro: 403 with the permission reason', async () => {
    vi.mocked(perms.canRecordAudio).mockResolvedValue({ ok: false, reason: 'Audio needs Pro' });
    const res = await startRec();
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Audio needs Pro');
    expect(egress.startRoomCompositeEgress).not.toHaveBeenCalled();
  });

  it('a conference video recording needs Pro, with a fallback message when no reason is given', async () => {
    vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: false });
    const res = await startRec({ mode: 'video' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Video recording is not permitted for this account');
  });

  it('an audio recording without a reason gets the fallback message', async () => {
    vi.mocked(perms.canRecordAudio).mockResolvedValue({ ok: false });
    expect((await startRec()).json().message).toBe('Audio recording is not permitted for this account');
  });

  it('a free host may not record a standalone stream that is not published as a VOD', async () => {
    setRoom(STANDALONE);
    vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: false, reason: 'Pro only' });
    const res = await startRec({ mode: 'video', publish: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Pro only');
  });

  it('refuses a second recording of the same room (409)', async () => {
    await startRec();
    expect((await startRec()).statusCode).toBe(409);
    expect(egress.startRoomCompositeEgress).toHaveBeenCalledTimes(1);
  });
});

describe('record start: conference rooms', () => {
  it('with no body records audio-only MP3 at 64 kbps with the speaker layout', async () => {
    const res = await startRec();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ egressId: 'EG_1', status: 'recording', mode: 'audio', layout: 'speaker' });
    expect(body.filepath).toMatch(new RegExp(`^/tmp/livekit-recordings/${ROOM}-\\d+\\.mp3$`));
    const [room, out, opts] = egress.startRoomCompositeEgress.mock.calls[0];
    expect(room).toBe(ROOM);
    expect(out.file.filepath).toBe(body.filepath);
    expect(opts.audioOnly).toBe(true);
    expect(opts.encodingOptions.audioBitrate).toBe(64);
    expect(lk.updateRoomMetadata).not.toHaveBeenCalled();
    expect(await recStatus()).toEqual({ recording: true, egressId: 'EG_1', mode: 'audio', layout: 'speaker' });
  });

  it('video stamps recordBg + recordLayout on the room, then records the custom template to MP4', async () => {
    setRoom({ host: 'alice', title: 'Talk', backgroundImage: 'https://img.test/bg.png' });
    const res = await startRec({ mode: 'video', layout: 'grid' });
    expect(res.json()).toMatchObject({ mode: 'video', layout: 'grid' });
    expect(res.json().filepath).toMatch(/\.mp4$/);
    const meta = JSON.parse(vi.mocked(lk.updateRoomMetadata).mock.calls[0][1] as string);
    expect(meta).toEqual({ host: 'alice', title: 'Talk', backgroundImage: 'https://img.test/bg.png', recordBg: 'https://img.test/bg.png', recordLayout: 'grid' });
    expect(egress.startRoomCompositeEgress.mock.calls[0][2].customBaseUrl).toBe('https://hangout.3speak.tv/egress-template');
    expect(egress.startTrackCompositeEgress).not.toHaveBeenCalled();
  });

  it('a LiveKit failure returns 500 and leaves the room not recording', async () => {
    egress.startRoomCompositeEgress.mockRejectedValueOnce(new Error('no egress workers'));
    expect((await startRec()).statusCode).toBe(500);
    expect(await recStatus()).toEqual({ recording: false });
    expect(rec.isRecording(ROOM)).toBe(false);
  });
});

describe('record start: standalone streams', () => {
  beforeEach(() => setRoom(STANDALONE));

  it('muxes the host camera + studio-mix track (not host-monitor) at the track size', async () => {
    const res = await startRec({ mode: 'video' });
    expect(res.json()).toMatchObject({ egressId: 'EG_1', status: 'recording', mode: 'video' });
    expect(res.json().filepath).toMatch(new RegExp(`^/tmp/livekit-recordings/${ROOM}-\\d+\\.mp4$`));
    const [room, out, opts] = egress.startTrackCompositeEgress.mock.calls[0];
    expect(room).toBe(ROOM);
    expect(out.file.filepath).toBe(res.json().filepath);
    expect(opts).toMatchObject({ videoTrackId: 'TR_cam', audioTrackId: 'TR_mix' });
    expect(opts.encodingOptions).toMatchObject({ width: 1080, height: 1920, framerate: 30, videoBitrate: 3000 });
    expect(egress.startRoomCompositeEgress).not.toHaveBeenCalled();
    expect(rec.isRecording(ROOM)).toBe(true);
  });

  it('uses the first microphone when none is named studio-mix, and orientation dims when the track has none', async () => {
    setRoom({ ...STANDALONE, portrait: true });
    vi.mocked(lk.listParticipants).mockResolvedValue([{ identity: 'alice', tracks: [{ ...camera, width: 0, height: 0 }, monitor] }] as never);
    await startRec({ mode: 'video' });
    const opts = egress.startTrackCompositeEgress.mock.calls[0][2];
    expect(opts.audioTrackId).toBe('TR_mon');
    expect(opts.encodingOptions).toMatchObject({ width: 720, height: 1280 });
  });

  it('falls back to the standalone room-composite template when the host has no camera track', async () => {
    vi.mocked(lk.listParticipants).mockResolvedValue([{ identity: 'alice', tracks: [studioMix] }] as never);
    const res = await startRec({ mode: 'video' });
    expect(res.statusCode).toBe(200);
    expect(egress.startTrackCompositeEgress).not.toHaveBeenCalled();
    const opts = egress.startRoomCompositeEgress.mock.calls[0][2];
    expect(opts.customBaseUrl).toBe('https://3speak.tv/egress-stream');
    expect(opts.encodingOptions).toMatchObject({ width: 1280, height: 720 });
  });

  it('falls back to the template when LiveKit cannot list participants or refuses the track composite', async () => {
    vi.mocked(lk.listParticipants).mockRejectedValueOnce(new Error('twirp down'));
    await startRec({ mode: 'video' });
    expect(egress.startRoomCompositeEgress).toHaveBeenCalledTimes(1);
    await rec.stopStandaloneVod(ROOM);
    egress.startTrackCompositeEgress.mockRejectedValueOnce(new Error('unsupported'));
    const res = await startRec({ mode: 'video' });
    expect(res.statusCode).toBe(200);
    expect(egress.startRoomCompositeEgress).toHaveBeenCalledTimes(2);
  });

  it('returns 500 when both egress kinds fail, and nothing is left recording', async () => {
    egress.startTrackCompositeEgress.mockRejectedValueOnce(new Error('a'));
    egress.startRoomCompositeEgress.mockRejectedValueOnce(new Error('b'));
    expect((await startRec({ mode: 'video' })).statusCode).toBe(500);
    expect(rec.isRecording(ROOM)).toBe(false);
  });

  it('startStandaloneVod refuses a room that is already recording', async () => {
    await startRec({ mode: 'video' });
    await expect(rec.startStandaloneVod(ROOM, { host: 'alice' }, { publish: true, download: false, owner: 'alice' }, { warn: vi.fn() }))
      .rejects.toThrow('Room is already being recorded');
  });

  it('an audio recording of a standalone room takes the conference audio path', async () => {
    await startRec({ mode: 'audio' });
    expect(egress.startRoomCompositeEgress.mock.calls[0][2].audioOnly).toBe(true);
    expect(egress.startTrackCompositeEgress).not.toHaveBeenCalled();
  });
});

describe('record layout switch', () => {
  const patch = (layout: string, headers = auth) =>
    app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/record/layout`, headers, payload: { layout } });

  it('returns 404 / 403 / 400 for a missing room, a non-host and a room that is not recording', async () => {
    setRoom(null);
    expect((await patch('grid')).statusCode).toBe(404);
    setRoom({ host: 'alice' });
    expect((await patch('grid', bobAuth)).statusCode).toBe(403);
    expect((await patch('grid')).statusCode).toBe(400);
  });

  it('is refused for an audio recording', async () => {
    await startRec();
    const res = await patch('grid');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/only available for video/);
  });

  it('on a video recording writes recordLayout to the room and reports the new layout', async () => {
    await startRec({ mode: 'video', layout: 'speaker' });
    vi.mocked(lk.updateRoomMetadata).mockClear();
    setRoom({ host: 'alice', title: 'Talk', recordLayout: 'speaker' });
    const res = await patch('single');
    expect(res.json()).toEqual({ egressId: 'EG_1', layout: 'single' });
    const meta = JSON.parse(vi.mocked(lk.updateRoomMetadata).mock.calls[0][1] as string);
    expect(meta).toEqual({ host: 'alice', title: 'Talk', recordLayout: 'single' });
    expect((await recStatus()).layout).toBe('single');
  });
});

describe('record status', () => {
  it('requires a session token and reports not recording by default', async () => {
    expect((await app.inject({ method: 'GET', url: `/rooms/${ROOM}/record/status` })).statusCode).toBe(401);
    expect(await recStatus()).toEqual({ recording: false });
  });
});

describe('record stop', () => {
  it('returns 404 / 403 / 400 for a missing room, a non-host and a room that is not recording', async () => {
    setRoom(null);
    expect((await stopRec()).statusCode).toBe(404);
    setRoom({ host: 'alice' });
    expect((await stopRec(bobAuth)).statusCode).toBe(403);
    expect((await stopRec()).statusCode).toBe(400);
    expect(egress.stopEgress).not.toHaveBeenCalled();
  });

  it('a conference audio recording stops and offers the file as a download, duration in seconds', async () => {
    egress.stopEgress.mockResolvedValueOnce({ egressId: 'EG_1', fileResults: [{ filename: '/tmp/livekit-recordings/talk.mp3', duration: 90 * SEC }] });
    await startRec();
    const res = await stopRec();
    expect(res.json()).toEqual({
      egressId: 'EG_1', status: 'stopped', mode: 'audio', layout: 'speaker', duration: 90,
      downloadUrl: `/rooms/${ROOM}/record/file/EG_1`,
    });
    expect(vod.publishRecordingToVod).not.toHaveBeenCalled();
    expect(await recStatus()).toEqual({ recording: false });
  });

  it('a conference video recording (no VOD pending) is offered as a download too', async () => {
    await startRec({ mode: 'video' });
    const res = await stopRec();
    expect(res.json()).toMatchObject({ status: 'stopped', mode: 'video', downloadUrl: `/rooms/${ROOM}/record/file/EG_1` });
    expect(res.json().publishStatusUrl).toBeUndefined();
  });

  it('when egress reports no file it falls back to the path chosen at start', async () => {
    const started = (await startRec()).json();
    egress.stopEgress.mockResolvedValueOnce({ egressId: 'EG_1', fileResults: [] });
    const res = await stopRec();
    expect(res.json().duration).toBe(0);
    const p = download(res.json().downloadUrl);
    await vi.advanceTimersByTimeAsync(1_000);
    const dl = await p;
    expect(dl.headers['x-recording-filename']).toBe(started.filepath.split('/').pop());
  });

  it('a standalone publish-only stop publishes the VOD once, offers no download, and frees the disk after', async () => {
    setRoom(STANDALONE);
    await startRec({ mode: 'video' });
    const res = await stopRec();
    expect(res.json()).toMatchObject({
      egressId: 'EG_1', status: 'publishing', duration: 12,
      publishStatusUrl: `/rooms/${ROOM}/record/publish-status`,
    });
    expect(res.json().downloadUrl).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
    expect(vod.publishRecordingToVod).toHaveBeenCalledTimes(1);
    expect(vod.publishRecordingToVod).toHaveBeenCalledWith({
      filePath: '/tmp/livekit-recordings/EG_1.mp4', roomName: ROOM, owner: 'alice',
      title: 'My stream', description: 'desc', tags: ['a', 'b'], thumbnailUrl: 'https://img.test/thumb.png', duration: 12,
    });
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-recordings/EG_1.mp4');
  });

  it('a standalone publish + download stop does both and keeps the file for the download', async () => {
    setRoom({ ...STANDALONE, post: {} });
    await startRec({ mode: 'video', download: true });
    const res = await stopRec();
    expect(res.json()).toMatchObject({ status: 'publishing', downloadUrl: `/rooms/${ROOM}/record/file/EG_1` });
    await vi.advanceTimersByTimeAsync(0);
    expect(vod.publishRecordingToVod).toHaveBeenCalledWith(expect.objectContaining({
      title: undefined, tags: undefined, thumbnailUrl: 'https://img.test/bg.png',
    }));
    expect(fsp.unlink).not.toHaveBeenCalled();
  });

  it('a standalone stop does not publish again when a publish for the room already exists', async () => {
    setRoom(STANDALONE);
    await startRec({ mode: 'video' });
    vi.mocked(vod.hasPublish).mockReturnValue(true);
    const res = await stopRec();
    expect(res.json().status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(vod.publishRecordingToVod).not.toHaveBeenCalled();
  });

  it('a Pro standalone recording with publish off and download on is only offered as a download', async () => {
    setRoom(STANDALONE);
    await startRec({ mode: 'video', publish: false, download: true });
    const res = await stopRec();
    expect(res.json()).toMatchObject({ status: 'stopped', downloadUrl: `/rooms/${ROOM}/record/file/EG_1` });
    await vi.advanceTimersByTimeAsync(0);
    expect(vod.publishRecordingToVod).not.toHaveBeenCalled();
  });

  // An egress that already ended on LiveKit's side (egress crash, disk full,
  // LiveKit restart) makes stopEgress throw: the stop still succeeds and frees
  // the room, instead of leaving it "recording" forever (every start a 409).
  it('a LiveKit error on stop still answers 200 and frees the room', async () => {
    await startRec();
    egress.stopEgress.mockRejectedValueOnce(new Error('egress not found'));
    expect((await stopRec()).statusCode).toBe(200);
  });

  it('a stop whose egress already ended on LiveKit still frees the room for a new recording', async () => {
    await startRec();
    egress.stopEgress.mockRejectedValueOnce(new Error('egress not found'));
    await stopRec();
    expect((await startRec()).statusCode).toBe(200);
  });
});

describe('recording file download', () => {
  async function stoppedAudio(filename = '/tmp/livekit-recordings/talk.mp3') {
    egress.stopEgress.mockResolvedValueOnce({ egressId: 'EG_1', fileResults: [{ filename, duration: 7 * SEC }] });
    await startRec();
    return (await stopRec()).json().downloadUrl as string;
  }

  it('returns 404 for an unknown token', async () => {
    expect((await download(`/rooms/${ROOM}/record/file/EG_nope`)).statusCode).toBe(404);
  });

  it('streams the file without auth, with type, size, filename and duration headers, then drops the token', async () => {
    const url = await stoppedAudio();
    const p = download(url);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('FILE!');
    expect(res.headers).toMatchObject({
      'content-type': 'audio/mpeg',
      'content-length': '5',
      'content-disposition': 'attachment; filename="talk.mp3"',
      'x-recording-duration': '7',
      'x-recording-filename': 'talk.mp3',
    });
    expect(createReadStreamMock).toHaveBeenCalledWith('/tmp/livekit-recordings/talk.mp3');
    expect(fsp.unlink).not.toHaveBeenCalled(); // the file stays; only the token is spent
    expect((await download(url)).statusCode).toBe(404);
  });

  it.each([
    ['clip.mp4', 'video/mp4'], ['clip.webm', 'video/webm'], ['a.ogg', 'audio/ogg'], ['a.oga', 'audio/ogg'],
    ['a.m4a', 'audio/mp4'], ['a.WAV', 'audio/wav'], ['a.bin', 'application/octet-stream'],
  ])('serves %s as %s', async (name, type) => {
    const url = await stoppedAudio(`/tmp/livekit-recordings/${name}`);
    const p = download(url);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).headers['content-type']).toBe(type);
  });

  it('waits for a file egress has not finished writing, and sends its settled size', async () => {
    const url = await stoppedAudio();
    fsp.stat
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce({ size: 10 })
      .mockResolvedValueOnce({ size: 20 })
      .mockResolvedValueOnce({ size: 20 });
    const p = download(url);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await p;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('20');
  });

  it('gives up with 404 when the file never appears within 30 s', async () => {
    const url = await stoppedAudio();
    fsp.stat.mockRejectedValue(new Error('ENOENT'));
    const p = download(url);
    await vi.advanceTimersByTimeAsync(31_000);
    const res = await p;
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/no longer exists/);
  });

  it('streams the last size seen when the file vanishes while settling', async () => {
    const url = await stoppedAudio();
    fsp.stat.mockResolvedValueOnce({ size: 9 }).mockRejectedValueOnce(new Error('ENOENT'));
    const p = download(url);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).headers['content-length']).toBe('9');
  });

  it('a token past its 1 h lifetime is refused even before the sweeper runs', async () => {
    const url = await stoppedAudio();
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
    const res = await download(url);
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Recording download token expired');
  });

  it('the 5 min sweeper drops expired tokens and deletes their orphaned files', async () => {
    const url = await stoppedAudio();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(fsp.unlink).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-recordings/talk.mp3');
    expect((await download(url)).json().message).toMatch(/token expired or already downloaded/);
  });
});

describe('publish status', () => {
  const get = () => app.inject({ method: 'GET', url: `/rooms/${ROOM}/record/publish-status` });

  it('returns 404 when no publish is known for the room', async () => {
    expect((await get()).statusCode).toBe(404);
  });

  it('is public and never exposes the internal error string', async () => {
    vi.mocked(vod.getPublishState).mockReturnValue({ status: 'failed', progress: 40, updatedAt: 123, error: '/secret/path broke' } as never);
    const res = await get();
    expect(res.json()).toEqual({ status: 'failed', progress: 40, updatedAt: 123, failed: true });
    vi.mocked(vod.getPublishState).mockReturnValue({ status: 'uploading', progress: 10, updatedAt: 5 } as never);
    expect((await get()).json().failed).toBe(false);
  });
});

describe('crash watchdog (every 30 s)', () => {
  beforeEach(() => setRoom(STANDALONE));

  it('a host gone for 5 min gets the egress stopped, the VOD published exactly once and the room deleted', async () => {
    await startRec({ mode: 'video' });
    hostGone();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_1');
    expect(vod.publishRecordingToVod).toHaveBeenCalledTimes(1);
    expect(vod.publishRecordingToVod).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/livekit-recordings/EG_1.mp4', duration: 12, owner: 'alice',
    }));
    expect(lk.deleteRoom).toHaveBeenCalledWith(ROOM);
    expect(rec.isRecording(ROOM)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
    expect(vod.publishRecordingToVod).toHaveBeenCalledTimes(1);
  });

  it('the grace window restarts each time the host is seen again', async () => {
    await startRec({ mode: 'video' });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    hostGone();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
  });

  it('a room LiveKit no longer knows counts as the host being gone', async () => {
    await startRec({ mode: 'video' });
    vi.mocked(lk.listParticipants).mockRejectedValue(new Error('room not found'));
    vi.mocked(lk.deleteRoom).mockRejectedValue(new Error('room not found'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(vod.publishRecordingToVod).toHaveBeenCalledTimes(1);
  });

  it('still publishes from the path chosen at start when the egress already stopped itself', async () => {
    const { filepath } = (await startRec({ mode: 'video' })).json();
    hostGone();
    egress.stopEgress.mockRejectedValue(new Error('egress already complete'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(vod.publishRecordingToVod).toHaveBeenCalledWith(expect.objectContaining({ filePath: filepath, duration: 0 }));
  });

  it('a recording without publish is stopped and its room deleted, but nothing is published', async () => {
    await startRec({ mode: 'video', publish: false, download: true });
    hostGone();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
    expect(vod.publishRecordingToVod).not.toHaveBeenCalled();
    expect(lk.deleteRoom).toHaveBeenCalledWith(ROOM);
  });

  it('does nothing for a recording the host already stopped and published', async () => {
    await startRec({ mode: 'video' });
    await stopRec();
    hostGone();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
    expect(vod.publishRecordingToVod).toHaveBeenCalledTimes(1);
    expect(lk.deleteRoom).not.toHaveBeenCalled();
  });

  it('does not publish a second time when a publish already exists for the room', async () => {
    await startRec({ mode: 'video' });
    hostGone();
    vi.mocked(vod.hasPublish).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(vod.publishRecordingToVod).not.toHaveBeenCalled();
  });

  // Was a bug, fixed (recording.ts:68): finishAndPublishVod returns before stopping anything when
  // hasPublish(room) is already true, e.g. a second recording in a room whose first
  // recording was published within the last hour (publish states live 1 h). Then
  // the pendingVods entry is never removed: the watchdog never stops the egress,
  // and calls deleteRoom again on every 30 s sweep forever.
  it('a crashed second recording in a room that already published still has its egress stopped once', async () => {
    await startRec({ mode: 'video' });
    hostGone();
    vi.mocked(vod.hasPublish).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
    expect(lk.deleteRoom).toHaveBeenCalledTimes(1);
  });
});

describe('free stream cap timer', () => {
  beforeEach(() => {
    setRoom(STANDALONE);
    vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: false, reason: 'Pro only' });
  });
  const capMs = FREE_STREAM_CAP_MS + 60_000;

  it('a free host may publish a standalone stream, without the download copy even when asked', async () => {
    const res = await startRec({ mode: 'video', download: true });
    expect(res.statusCode).toBe(200);
    const stop = await stopRec();
    expect(stop.json().status).toBe('publishing');
    expect(stop.json().downloadUrl).toBeUndefined();
  });

  it('stops and publishes a free recording one minute after the free cap, once', async () => {
    await startRec({ mode: 'video' });
    await vi.advanceTimersByTimeAsync(capMs - 1_000);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_1');
    expect(vod.publishRecordingToVod).toHaveBeenCalledTimes(1);
    expect(rec.isRecording(ROOM)).toBe(false);
    expect(lk.deleteRoom).not.toHaveBeenCalled(); // the cap ends the recording, not the room
    await vi.advanceTimersByTimeAsync(capMs);
    expect(egress.stopEgress).toHaveBeenCalledTimes(1);
  });

  it('an old cap timer never cuts a later recording in the same room', async () => {
    await startRec({ mode: 'video' });                 // EG_1, cap timer for EG_1
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await stopRec();                                    // studio stopped it normally
    vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: true });
    await startRec({ mode: 'video' });                 // EG_2, Pro: no cap
    egress.stopEgress.mockClear();
    await vi.advanceTimersByTimeAsync(capMs);           // EG_1's timer fires
    expect(egress.stopEgress).not.toHaveBeenCalled();
    expect(rec.isRecording(ROOM)).toBe(true);
  });

  // Was a bug, fixed (recording.ts:68 via :224): the same early return defeats the free cap. A
  // free host who stops (and so publishes) a recording and then starts another in
  // the same room gets a cap timer for the new egress, but when it fires
  // hasPublish(room) is true, so the egress is never stopped and records past the cap.
  it('the free cap still stops a second recording in a room whose first recording was published', async () => {
    await startRec({ mode: 'video' });
    await stopRec();
    vi.mocked(vod.hasPublish).mockReturnValue(true);
    await startRec({ mode: 'video' });
    egress.stopEgress.mockClear();
    await vi.advanceTimersByTimeAsync(capMs);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_2');
  });

  it('a Pro recording has no cap', async () => {
    vi.mocked(perms.canRecordVideo).mockResolvedValue({ ok: true });
    await startRec({ mode: 'video' });
    await vi.advanceTimersByTimeAsync(4 * capMs);
    expect(egress.stopEgress).not.toHaveBeenCalled();
  });
});

describe('headless helpers', () => {
  it('stopStandaloneVod stops the egress and returns before the background publish finishes', async () => {
    setRoom(STANDALONE);
    await startRec({ mode: 'video' });
    let finish!: () => void;
    vi.mocked(vod.publishRecordingToVod).mockReturnValue(new Promise<void>((r) => { finish = r; }));
    await rec.stopStandaloneVod(ROOM);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_1');
    expect(vod.publishRecordingToVod).toHaveBeenCalledTimes(1);
    expect(fsp.unlink).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-recordings/EG_1.mp4');
  });

  it('a background publish failure is swallowed (the publish-state map carries it)', async () => {
    setRoom(STANDALONE);
    await startRec({ mode: 'video' });
    vi.mocked(vod.publishRecordingToVod).mockRejectedValue(new Error('upload failed'));
    await expect(rec.stopStandaloneVod(ROOM)).resolves.toBeUndefined();
  });

  it('stopStandaloneVod stops a plain recording, ignores an already-stopped egress, and is a no-op otherwise', async () => {
    await rec.stopStandaloneVod(ROOM);
    expect(egress.stopEgress).not.toHaveBeenCalled();
    await startRec();
    egress.stopEgress.mockRejectedValueOnce(new Error('already stopped'));
    await rec.stopStandaloneVod(ROOM);
    expect(egress.stopEgress).toHaveBeenCalledWith('EG_1');
    expect(rec.isRecording(ROOM)).toBe(false);
  });

  it('startStandaloneVod uses the caller as owner when the meta names no host', async () => {
    vi.mocked(lk.listParticipants).mockResolvedValue([] as never);
    const warn = vi.fn();
    await rec.startStandaloneVod(ROOM, {}, { publish: true, download: false, owner: 'carol' }, { warn });
    expect(warn).toHaveBeenCalled(); // no host track, so it logged the fallback
    await rec.stopStandaloneVod(ROOM);
    await vi.advanceTimersByTimeAsync(0);
    expect(vod.publishRecordingToVod).toHaveBeenCalledWith(expect.objectContaining({ owner: 'carol' }));
  });
});

describe('audio upload to audio.3speak.tv', () => {
  const upload = (payload: Record<string, unknown>, headers = auth) =>
    app.inject({ method: 'POST', url: `/rooms/${ROOM}/record/upload`, headers, payload });

  it('returns 503 when no audio API key is configured', async () => {
    const res = await upload({ filePath: '/tmp/livekit-recordings/a.mp3' });
    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('with an audio API key', () => {
    beforeEach(async () => {
      await app.close();
      await setup({ AUDIO_API_KEY: 'test-audio-key', AUDIO_API_URL: 'https://audio.test/' });
      setRoom({ host: 'alice', title: 'Room title', backgroundImage: 'https://img.test/bg.png' });
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, permlink: 'p1', cid: 'Qm1', playUrl: 'https://play/p1' })));
    });

    it('returns 404 for a missing room and 403 for a non-host', async () => {
      setRoom(null);
      expect((await upload({ filePath: '/tmp/livekit-recordings/a.mp3' })).statusCode).toBe(404);
      setRoom({ host: 'alice' });
      expect((await upload({ filePath: '/tmp/livekit-recordings/a.mp3' }, bobAuth)).statusCode).toBe(403);
    });

    it.each([
      '/tmp/livekit-recordings/../../etc/passwd',
      '/etc/passwd',
      '/tmp/livekit-recordings-evil/a.mp3',
      'relative.mp3',
    ])('refuses a file path outside the recordings dir: %s', async (filePath) => {
      const res = await upload({ filePath });
      expect(res.statusCode).toBe(400);
      expect(fsp.readFile).not.toHaveBeenCalled();
    });

    it('returns 404 when the recording file is gone', async () => {
      fsp.readFile.mockRejectedValueOnce(new Error('ENOENT'));
      expect((await upload({ filePath: '/tmp/livekit-recordings/a.mp3' })).statusCode).toBe(404);
    });

    it('uploads the MP3 with room defaults, estimates duration from size, then deletes the file', async () => {
      const res = await upload({ filePath: '/tmp/livekit-recordings/sub/../a.mp3' });
      expect(res.json()).toEqual({ success: true, permlink: 'p1', cid: 'Qm1', playUrl: 'https://play/p1' });
      expect(fsp.readFile).toHaveBeenCalledWith('/tmp/livekit-recordings/a.mp3');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://audio.test/api/audio/upload');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'X-API-Key': 'test-audio-key', 'X-User': 'alice' });
      const form = init.body as FormData;
      expect(form.get('duration')).toBe('10'); // 80 000 bytes at 8 KB/s
      expect(form.get('format')).toBe('mp3');
      expect(form.get('title')).toBe('Room title');
      expect(form.get('category')).toBe('podcast');
      expect(form.get('tags')).toBe(JSON.stringify(['hangout', 'podcast', 'hive']));
      expect(form.get('thumbnail_url')).toBe('https://img.test/bg.png');
      expect((form.get('audio') as File).name).toBe(`${ROOM}.mp3`);
      expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-recordings/a.mp3');
    });

    it('uses the title, tags and duration the host sent, and skips the thumbnail when the room has none', async () => {
      setRoom({ host: 'alice' });
      await upload({ filePath: '/tmp/livekit-recordings/a.mp3', title: 'Ep 1', tags: ['x'], duration: 42 });
      const form = fetchMock.mock.calls[0][1].body as FormData;
      expect(form.get('title')).toBe('Ep 1');
      expect(form.get('tags')).toBe('["x"]');
      expect(form.get('duration')).toBe('42');
      expect(form.get('thumbnail_url')).toBeNull();
    });

    it('a failed upload returns 500 with the audio API error and keeps the file', async () => {
      fetchMock.mockResolvedValueOnce(new Response('quota exceeded', { status: 413 }));
      const res = await upload({ filePath: '/tmp/livekit-recordings/a.mp3' });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toBe('Audio upload failed: quota exceeded');
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('a file that cannot be deleted after upload still reports success', async () => {
      fsp.unlink.mockRejectedValueOnce(new Error('EBUSY'));
      expect((await upload({ filePath: '/tmp/livekit-recordings/a.mp3' })).json().success).toBe(true);
    });

    it('metadata update forwards the body to the audio API for the encoded permlink', async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
      const res = await app.inject({
        method: 'PATCH', url: `/rooms/${ROOM}/record/a%20b/metadata`, headers: auth,
        payload: { title: 'New', tags: ['t'] },
      });
      expect(res.json()).toEqual({ ok: true });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://audio.test/api/audio/a%20b');
      expect(init.method).toBe('PATCH');
      expect(init.headers).toMatchObject({ 'X-API-Key': 'test-audio-key', 'X-User': 'alice' });
      expect(JSON.parse(init.body)).toEqual({ title: 'New', tags: ['t'] });
    });

    it('metadata update returns 500 when the audio API refuses', async () => {
      fetchMock.mockResolvedValueOnce(new Response('not yours', { status: 403 }));
      const res = await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/record/p1/metadata`, headers: auth, payload: {} });
      expect(res.statusCode).toBe(500);
      expect(res.json().message).toBe('Audio metadata update failed: not yours');
    });
  });

  it('metadata update returns 503 without an audio API key and needs a session token', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/record/p1/metadata`, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: `/rooms/${ROOM}/record/p1/metadata`, headers: auth, payload: {} })).statusCode).toBe(503);
  });
});
