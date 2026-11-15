import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { makeToken } from '../setup.js';

const dvr = vi.hoisted(() => ({ dvrDirOf: vi.fn(), cutDvrClip: vi.fn() }));
const fsp = vi.hoisted(() => ({ unlink: vi.fn(), stat: vi.fn() }));
const cp = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<object>()), ...cp }));
function proc(code: number) {
  const listeners: Record<string, (v: number) => void> = {};
  queueMicrotask(() => listeners.close?.(code));
  return { on: (ev: string, fn: (v: number) => void) => { listeners[ev] = fn; } };
}
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
  fsp.stat.mockRejectedValue(new Error('ENOENT'));
  cp.spawn.mockReset().mockImplementation(() => proc(0));
  app = Fastify();
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(routes.highlightRoutes);
});
afterEach(async () => { await app.close(); hl.resetHighlights(); });

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

  it('without DVR, a stream recording its VOD gets a pending automatic clip of the moment', async () => {
    const vc = await import('../../src/lib/vodClips.js');
    vc.noteVodRecording(ROOM, { startedAt: T0 - 600_000, maxMs: null });
    const m = { at: T0, offsetSec: 600, reasons: ['chat' as const], chatters: 6, lines: 6, boosts: 0, usd: 0, score: 6 };
    expect(await routes.autoClipMoment(ROOM, m, { host: 'badadib', liveAt: T0 - 600_000 })).toBe(true);
    const [p] = await (await clips.clipStore()).listPending(ROOM);
    expect(p).toMatchObject({ source: 'auto', status: 'pending', vodStartSec: 566, reasons: ['chat'] });
    vc.resetVodClips();
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
    vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: JSON.stringify({ host: 'badadib', vertical: { on: true, x: 0.5, w: 0.316 } }) }] as never);
    const t = Date.now();
    for (let i = 0; i < 6; i++) hl.noteChat(ROOM, `w${i}`, t);
    hl.sweepHighlights(t + 25_000);
    await vi.waitFor(() => expect(dvr.cutDvrClip).toHaveBeenCalledWith(ROOM));
    await vi.waitFor(async () => expect((await (await clips.clipStore()).listForRoom(ROOM))[0]?.crop).toEqual({ x: 0.5, w: 0.316 }));
  });
});

describe('POST /clips/:id/vertical', () => {
  const vert = async (u: string, id: string) => app.inject({ method: 'POST', url: `/clips/${id}/vertical`, headers: await bearer(u) });
  const keep = async (crop: { x: number; w: number } | null) => {
    const r = await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: 'v.mp4', offsetSec: 1, durationSec: 30, crop });
    if (!('clip' in r)) throw new Error('refused');
    return r.clip;
  };

  it('crops the kept clip with the phone crop (niced, one re-encode) and remembers the copy', async () => {
    const c = await keep({ x: 0.5, w: 0.316 });
    const res = await vert('fan', c.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().clip.vertical).toEqual({ available: true, path: expect.stringMatching(/^\/dvr\/clips\/v-v-[0-9a-f]{6}\.mp4$/) });
    const [bin, args] = cp.spawn.mock.calls[0];
    expect(bin).toBe('nice');
    expect(args[args.indexOf('-vf') + 1]).toBe('crop=trunc(iw*0.316/2)*2:ih:max(0\\,min(iw-trunc(iw*0.316/2)*2\\,trunc(iw*0.342/2)*2)):0');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-c:a', 'copy']));
    // Asked again: the same copy, no second encode.
    fsp.stat.mockResolvedValue({ size: 1 });
    expect((await vert('badadib', c.id)).json().clip.vertical.path).toBe(res.json().clip.vertical.path);
    expect(cp.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses strangers, unknown clips, and clips without a crop; a failed encode is a 500', async () => {
    const plain = await keep(null);
    const waiting = await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: 'p.mp4', offsetSec: 1, durationSec: 36, crop: { x: 0.5, w: 0.3 }, pendingAt: 10 });
    if ('clip' in waiting) expect((await vert('fan', waiting.clip.id)).statusCode).toBe(409);
    expect((await vert('stranger', plain.id)).statusCode).toBe(403);
    expect((await vert('fan', 'abcdefabcdefabcdef')).statusCode).toBe(404);
    expect((await vert('fan', plain.id)).statusCode).toBe(400);
    const c = await keep({ x: 0.3, w: 0.2 });
    cp.spawn.mockImplementationOnce(() => proc(1));
    expect((await vert('fan', c.id)).statusCode).toBe(500);
    expect(fsp.unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/livekit-dvr-clips\/v-v-/));
  });

  it('verticalArgs keeps the crop inside the frame', () => {
    expect(routes.verticalArgs('/a.mp4', '/b.mp4', { x: 0.9, w: 0.2 })).toContain('crop=trunc(iw*0.2/2)*2:ih:max(0\\,min(iw-trunc(iw*0.2/2)*2\\,trunc(iw*0.8/2)*2)):0');
  });
});

describe('clips of a user, and deleting', () => {
  it('GET /clips/mine lists the signed-in clipper\'s clips', async () => {
    await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: 'v.mp4', offsetSec: 10, durationSec: 30 });
    const res = await app.inject({ method: 'GET', url: '/clips/mine', headers: await bearer('fan') });
    expect(res.json().clips).toHaveLength(1);
    // A host sees the clips of their streams too, with how long clips are kept.
    await clips.registerClip({ room: ROOM, host: 'badadib', clipper: null, source: 'auto', file: 'a.mp4', offsetSec: 20, durationSec: 30 });
    const host = (await app.inject({ method: 'GET', url: '/clips/mine', headers: await bearer('badadib') })).json();
    expect(host.clips.map((c: { path: string }) => c.path).sort()).toEqual(['/dvr/clips/a.mp4', '/dvr/clips/v.mp4']);
    expect(host.keepHours).toBe(48);
    expect((await app.inject({ method: 'GET', url: '/clips/mine' })).statusCode).toBe(401);
  });

  it('DELETE /clips/:id: only the host or the clipper, and the file goes too', async () => {
    const r = await clips.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: 'v.mp4', offsetSec: 10, durationSec: 30 });
    if (!('clip' in r)) throw new Error('refused');
    const del = async (u: string, id = r.clip.id) => app.inject({ method: 'DELETE', url: `/clips/${id}`, headers: await bearer(u) });
    expect((await del('stranger')).statusCode).toBe(403);
    expect((await del('fan', 'abcdefabcdefabcdef')).statusCode).toBe(404);
    expect((await del('fan', 'nothex')).statusCode).toBe(400);
    await (await clips.clipStore()).update(r.clip.id, { verticalFile: 'v-v.mp4' });
    expect((await del('badadib')).json()).toEqual({ deleted: true });
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-dvr-clips/v-v.mp4');
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-dvr-clips/v.mp4');
    expect((await del('fan')).statusCode).toBe(404);
  });
});
