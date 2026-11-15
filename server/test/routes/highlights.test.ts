import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { makeToken } from '../setup.js';

const dvr = vi.hoisted(() => ({ dvrDirOf: vi.fn(), cutDvrClip: vi.fn() }));
const fsp = vi.hoisted(() => ({ unlink: vi.fn() }));
vi.mock('../../src/routes/dvr.js', () => dvr);
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<object>()), ...fsp }));
vi.mock('../../src/lib/livekit.js', () => ({ roomService: { listRooms: vi.fn(), listParticipants: vi.fn() } }));

const ROOM = 'badadib-hl1';
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

let app: FastifyInstance;
let lk: typeof import('../../src/lib/livekit.js')['roomService'];
let hl: typeof import('../../src/lib/streamHighlights.js');
let clips: typeof import('../../src/lib/streamClips.js');
let routes: typeof import('../../src/routes/highlights.js');
const bearer = async (u: string) => ({ authorization: `Bearer ${await makeToken(u)}` });

beforeEach(async () => {
  vi.resetModules();
  lk = (await import('../../src/lib/livekit.js')).roomService;
  hl = await import('../../src/lib/streamHighlights.js');
  hl.resetHighlights();
  clips = await import('../../src/lib/streamClips.js');
  clips.setClipStore(clips.memoryClipStore());
  routes = await import('../../src/routes/highlights.js');
  routes.resetHighlightRoutes();
  vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: JSON.stringify({ host: 'badadib', liveAt: new Date(T0 - 300_000).toISOString() }) }] as never);
  dvr.dvrDirOf.mockReturnValue(null);
  dvr.cutDvrClip.mockResolvedValue({ error: null, file: 'auto.mp4', durationSec: 34 });
  fsp.unlink.mockResolvedValue(undefined);
  app = Fastify();
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(routes.highlightRoutes);
});
afterEach(async () => { await app.close(); hl.resetHighlights(); });

const chat = (headers: Record<string, string> = {}, ip = '10.0.0.1', room = ROOM) =>
  app.inject({ method: 'POST', url: `/rooms/${room}/highlights/chat`, headers, remoteAddress: ip });

describe('POST /rooms/:name/highlights/chat', () => {
  it('counts a line (204), signed-in senders by name and guests by IP', async () => {
    const spy = vi.spyOn(hl, 'noteChat');
    expect((await chat(await bearer('fan'))).statusCode).toBe(204);
    expect((await chat({}, '10.0.0.7')).statusCode).toBe(204);
    // A real burst ends up as a moment.
    for (let i = 0; i < 6; i++) await chat(await bearer(`fan${i}`));
    hl.sweepHighlights(Date.now() + 25_000);
    const data = await hl.getHighlights(ROOM);
    expect(data!.moments.length).toBe(1);
    expect(data!.moments[0].chatters).toBeGreaterThanOrEqual(6);
    spy.mockRestore();
  });

  it('refuses a bad room name and is rate limited per IP', async () => {
    expect((await chat({}, '10.0.0.2', 'bad%20name')).statusCode).toBe(400);
    for (let i = 0; i < 40; i++) expect((await chat({}, '10.0.0.3')).statusCode).toBe(204);
    expect((await chat({}, '10.0.0.3')).statusCode).toBe(429);
  });
});

describe('GET /rooms/:name/highlights', () => {
  const get = async (u?: string) => app.inject({ method: 'GET', url: `/rooms/${ROOM}/highlights`, headers: u ? await bearer(u) : {} });

  it('needs a session', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it('the host gets every moment and every clip; a viewer only their own clips', async () => {
    const store = await clips.clipStore();
    await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: 'v.mp4', offsetSec: 10, durationSec: 30 });
    await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'other', source: 'viewer', file: 'o.mp4', offsetSec: 20, durationSec: 30 });
    expect((await store.listForRoom(ROOM)).length).toBe(2);
    hl.setRoomResolver(async () => ({ host: 'badadib', liveAt: T0 }));
    for (let i = 0; i < 6; i++) hl.noteChat(ROOM, `u${i}`, T0 + 1000 + i);
    hl.sweepHighlights(T0 + 20_000);

    const host = (await get('badadib')).json();
    expect(host).toMatchObject({ room: ROOM, host: 'badadib', isHost: true });
    expect(host.moments).toHaveLength(1);
    expect(host.clips.map((c: { path: string }) => c.path).sort()).toEqual(['/dvr/clips/o.mp4', '/dvr/clips/v.mp4']);

    const fan = (await get('fan')).json();
    expect(fan).toMatchObject({ isHost: false, moments: [] });
    expect(fan.clips.map((c: { clipper: string }) => c.clipper)).toEqual(['fan']);
  });

  it('learns the host from a clip, or from the live room, when no moments are in memory', async () => {
    await clips.registerClip({ room: ROOM, host: 'badadib', clipper: null, source: 'auto', file: 'a.mp4', offsetSec: null, durationSec: 30 });
    expect((await get('badadib')).json().isHost).toBe(true);
    await clips.clipStore().then(async (s) => { for (const c of await s.listForRoom(ROOM)) await s.remove(c.id); });
    expect((await get('badadib')).json()).toMatchObject({ isHost: true, liveAt: null });
    vi.mocked(lk.listRooms).mockResolvedValue([] as never);
    expect((await get('badadib')).json()).toMatchObject({ host: null, isHost: false });
  });
});

describe('automatic clips from highlights', () => {
  it('a moment cuts a DVR clip when the DVR runs, kept as source auto with the reasons', async () => {
    dvr.dvrDirOf.mockReturnValue('/tmp/livekit-recordings/dvr/x');
    const ok = await routes.autoClipMoment(ROOM, { at: T0, offsetSec: 300, reasons: ['chat'], chatters: 6, lines: 6, boosts: 0, usd: 0, score: 6 }, { host: 'badadib', liveAt: T0 - 300_000 });
    expect(ok).toBe(true);
    const [c] = await (await clips.clipStore()).listForRoom(ROOM);
    expect(c).toMatchObject({ source: 'auto', clipper: null, host: 'badadib', file: 'auto.mp4', offsetSec: 300, reasons: ['chat'] });
  });

  it('does nothing without DVR, and gives up quietly when the cut fails', async () => {
    const m = { at: T0, offsetSec: 1, reasons: ['chat' as const], chatters: 6, lines: 6, boosts: 0, usd: 0, score: 6 };
    expect(await routes.autoClipMoment(ROOM, m, { host: 'badadib', liveAt: null })).toBe(false);
    expect(dvr.cutDvrClip).not.toHaveBeenCalled();
    dvr.dvrDirOf.mockReturnValue('/d');
    dvr.cutDvrClip.mockResolvedValueOnce({ error: 'empty' });
    expect(await routes.autoClipMoment(ROOM, m, { host: 'badadib', liveAt: null })).toBe(false);
  });

  it('past the per-stream cap the cut MP4 is deleted again', async () => {
    dvr.dvrDirOf.mockReturnValue('/d');
    for (let i = 0; i < clips.MAX_CLIPS_PER_ROOM; i++) {
      await clips.registerClip({ room: ROOM, host: 'badadib', clipper: null, source: 'auto', file: `f${i}.mp4`, offsetSec: null, durationSec: 30 });
    }
    const m = { at: T0, offsetSec: 1, reasons: ['chat' as const], chatters: 6, lines: 6, boosts: 0, usd: 0, score: 6 };
    expect(await routes.autoClipMoment(ROOM, m, { host: 'badadib', liveAt: null })).toBe(false);
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-dvr-clips/auto.mp4');
  });

  it('is wired to the highlight counter when the routes register', async () => {
    dvr.dvrDirOf.mockReturnValue('/d');
    for (let i = 0; i < 6; i++) await chat(await bearer(`w${i}`));
    hl.sweepHighlights(Date.now() + 25_000);
    await vi.waitFor(() => expect(dvr.cutDvrClip).toHaveBeenCalledWith(ROOM));
  });
});

describe('clips of a user, and deleting', () => {
  it('GET /clips/mine lists the signed-in clipper\'s clips', async () => {
    await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: 'v.mp4', offsetSec: 10, durationSec: 30 });
    const res = await app.inject({ method: 'GET', url: '/clips/mine', headers: await bearer('fan') });
    expect(res.json().clips).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/clips/mine' })).statusCode).toBe(401);
  });

  it('DELETE /clips/:id: only the host or the clipper, and the file goes too', async () => {
    const r = await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: 'v.mp4', offsetSec: 10, durationSec: 30 });
    if (!('clip' in r)) throw new Error('refused');
    const del = async (u: string, id = r.clip.id) => app.inject({ method: 'DELETE', url: `/clips/${id}`, headers: await bearer(u) });
    expect((await del('stranger')).statusCode).toBe(403);
    expect((await del('fan', 'abcdefabcdefabcdef')).statusCode).toBe(404);
    expect((await del('fan', 'nothex')).statusCode).toBe(400);
    expect((await del('badadib')).json()).toEqual({ deleted: true });
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-dvr-clips/v.mp4');
    expect((await del('fan')).statusCode).toBe(404);
  });
});
