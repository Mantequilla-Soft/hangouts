import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { Readable } from 'node:stream';
import { makeToken } from '../setup.js';

const dvr = vi.hoisted(() => ({ dvrDirOf: vi.fn(), DVR_BUFFER_SECONDS: 600, DVR_SEGMENT_SEC: 2 }));
const fsp = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() }));
const createReadStreamMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/routes/dvr.js', () => dvr);
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<object>()), ...fsp }));
vi.mock('node:fs', async (orig) => ({ ...(await orig<object>()), createReadStream: createReadStreamMock }));
vi.mock('../../src/lib/livekit.js', () => ({ roomService: { listRooms: vi.fn() } }));

const ROOM = 'badadib-rw1';
const DIR = '/tmp/livekit-recordings/dvr/badadib-rw1';
let app: FastifyInstance;
let lk: typeof import('../../src/lib/livekit.js')['roomService'];
let tokenFor: typeof import('../../src/lib/dvrRewind.js')['rewindToken'];

const meta = (extra: Record<string, unknown> = {}) => [{ name: ROOM, metadata: JSON.stringify({ host: 'badadib', mode: 'standalone', liveAt: '2026-11-15T12:00:00.000Z', ...extra }) }];
const INDEX = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', ...Array.from({ length: 6 }, (_, i) => [`#EXTINF:2.000,`, `seg_0000${i}.ts`]).flat()].join('\n');

beforeEach(async () => {
  vi.resetModules();
  lk = (await import('../../src/lib/livekit.js')).roomService;
  tokenFor = (await import('../../src/lib/dvrRewind.js')).rewindToken;
  const { dvrRewindRoutes } = await import('../../src/routes/dvrRewind.js');
  vi.mocked(lk.listRooms).mockResolvedValue(meta() as never);
  dvr.dvrDirOf.mockReturnValue(DIR);
  fsp.readFile.mockResolvedValue(INDEX);
  fsp.readdir.mockResolvedValue(['seg_00000.ts', 'seg_00001.ts', 'seg_00002.ts', 'seg_00003.ts', 'seg_00004.ts', 'seg_00005.ts', 'index.m3u8']);
  fsp.stat.mockResolvedValue({ size: 4321 });
  createReadStreamMock.mockImplementation(() => Readable.from([Buffer.from('TS')]));
  app = Fastify();
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(dvrRewindRoutes);
});
afterEach(async () => { await app.close(); });

const info = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/rooms/${ROOM}/dvr/rewind`, headers });

describe('GET /rooms/:name/dvr/rewind', () => {
  it('offers the tokenised playlist while the DVR runs, with the window and go-live time', async () => {
    const res = await info();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      available: true,
      playlist: `/rooms/${ROOM}/dvr/hls/${tokenFor(ROOM)}/live.m3u8`,
      windowSec: 600,
      liveAt: '2026-11-15T12:00:00.000Z',
    });
  });

  it('is unavailable without a DVR session or a room', async () => {
    dvr.dvrDirOf.mockReturnValueOnce(null);
    expect((await info()).json()).toEqual({ available: false });
    vi.mocked(lk.listRooms).mockResolvedValueOnce([] as never);
    expect((await info()).json()).toEqual({ available: false });
  });

  it('a Hive-only room needs a signed-in viewer', async () => {
    vi.mocked(lk.listRooms).mockResolvedValue(meta({ visibility: 'hive-internal' }) as never);
    const anon = await info();
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ available: false, reason: 'login_required' });
    expect((await info({ authorization: `Bearer ${await makeToken('fan')}` })).json().available).toBe(true);
  });
});

describe('the rewind HLS', () => {
  const hls = (file: string, token = tokenFor(ROOM)) => app.inject({ method: 'GET', url: `/rooms/${ROOM}/dvr/hls/${token}/${file}` });

  it('serves the playlist (CDN-cacheable for a second), built once per second per room', async () => {
    const res = await hls('live.m3u8');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(res.headers['cache-control']).toBe('public, max-age=1');
    expect(res.body).toContain('#EXT-X-MEDIA-SEQUENCE:2');
    expect(res.body).toContain('seg_00005.ts');
    await hls('live.m3u8');
    expect(fsp.readFile).toHaveBeenCalledTimes(1);
  });

  it('404s the playlist while nothing is playable yet', async () => {
    fsp.readFile.mockResolvedValue(null);
    fsp.readdir.mockResolvedValue([]);
    const res = await hls('live.m3u8');
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('falls back to the listing when the index or the listing cannot be read', async () => {
    fsp.readFile.mockRejectedValue(new Error('ENOENT'));
    fsp.readdir.mockRejectedValue(new Error('ENOENT'));
    expect((await hls('live.m3u8')).statusCode).toBe(404);
  });

  it('serves a segment as immutable video/mp2t', async () => {
    const res = await hls('seg_00004.ts');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp2t');
    expect(res.headers['content-length']).toBe('4321');
    expect(res.headers['cache-control']).toBe('public, max-age=600, immutable');
    expect(createReadStreamMock).toHaveBeenCalledWith(`${DIR}/seg_00004.ts`);
  });

  it('refuses a wrong token, a stopped DVR, unsafe names and pruned segments', async () => {
    expect((await hls('live.m3u8', 'x'.repeat(22))).statusCode).toBe(403);
    dvr.dvrDirOf.mockReturnValueOnce(null);
    expect((await hls('live.m3u8')).statusCode).toBe(404);
    expect((await hls('index.m3u8')).statusCode).toBe(400);
    expect((await hls('..%2Fx.ts')).statusCode).toBe(400);
    fsp.stat.mockRejectedValueOnce(new Error('ENOENT'));
    expect((await hls('seg_00000.ts')).statusCode).toBe(404);
  });
});
