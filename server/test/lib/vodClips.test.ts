import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const fsp = vi.hoisted(() => ({ stat: vi.fn(), mkdir: vi.fn(), unlink: vi.fn() }));
const cp = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', async (orig) => ({ ...(await orig<object>()), ...fsp }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<object>()), ...cp }));

type V = typeof import('../../src/lib/vodClips.js');
type C = typeof import('../../src/lib/streamClips.js');
let v: V;
let c: C;
const ROOM = 'badadib-vod1';
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const FILE = '/tmp/livekit-recordings/badadib-vod1-1.mp4';

function proc(code: number | 'hang') {
  const p = Object.assign(new EventEmitter(), { kill: vi.fn(() => { queueMicrotask(() => p.emit('close', null)); }) });
  if (code !== 'hang') queueMicrotask(() => p.emit('close', code));
  return p;
}

async function pending(atSec: number, over: Record<string, unknown> = {}) {
  const r = await c.registerClip({ room: ROOM, host: 'badadib', clipper: 'fan', source: 'viewer', file: `c${atSec}.mp4`, offsetSec: atSec, durationSec: 36, pendingAt: atSec, ...over });
  if (!('clip' in r)) throw new Error('refused');
  return r.clip;
}
const statusOf = async (id: string) => c.clipView((await (await c.clipStore()).get(id))!);

beforeEach(async () => {
  vi.resetModules();
  v = await import('../../src/lib/vodClips.js');
  c = await import('../../src/lib/streamClips.js');
  c.setClipStore(c.memoryClipStore());
  fsp.stat.mockResolvedValue({ size: 1000 });
  fsp.mkdir.mockResolvedValue(undefined);
  fsp.unlink.mockResolvedValue(undefined);
  cp.spawn.mockReset().mockImplementation(() => proc(0));
});
afterEach(() => { v.resetVodClips(); vi.useRealTimers(); });

describe('vodWindow', () => {
  it('puts the 30 s window (plus slack) before the press, and refuses what is past the free cap', () => {
    expect(v.vodWindow({ startedAt: T0, maxMs: null }, T0 + 100_000)).toEqual({ start: 66 });
    expect(v.vodWindow({ startedAt: T0, maxMs: null }, T0 + 10_000)).toEqual({ start: 0 });
    expect(v.vodWindow({ startedAt: T0, maxMs: 30 * 60_000 }, T0 + 30 * 60_000 + 40_000)).toEqual({ unavailable: 'past_cap' });
    expect(v.vodWindow({ startedAt: T0, maxMs: 30 * 60_000 }, T0 + 29 * 60_000)).toEqual({ start: 29 * 60 - 34 });
  });

  it('noteVodRecording remembers the start and cap until forgotten', () => {
    v.noteVodRecording(ROOM, { startedAt: T0, maxMs: 0 });
    expect(v.vodRecordingOf(ROOM)).toEqual({ startedAt: T0, maxMs: null });
    v.forgetVodRecording(ROOM);
    expect(v.vodRecordingOf(ROOM)).toBeNull();
  });
});

describe('cutPendingClips', () => {
  it('cuts each pending clip with a niced stream copy into the clip dir and marks it ready', async () => {
    v.noteVodRecording(ROOM, { startedAt: T0, maxMs: null });
    const a = await pending(66);
    const b = await pending(500);
    expect((await statusOf(a.id))).toMatchObject({ status: 'pending', path: null, vertical: { available: false } });
    expect(await v.cutPendingClips(ROOM, FILE, 900)).toEqual({ ready: 2, unavailable: 0 });
    const [bin, args] = cp.spawn.mock.calls[0];
    expect(bin).toBe('nice');
    expect(args).toEqual(['-n', '15', 'ffmpeg', ...v.cutArgs(FILE, '/tmp/livekit-dvr-clips/c66.mp4', 66, 36)]);
    expect(args).toEqual(expect.arrayContaining(['-ss', '66', '-t', '36', '-c', 'copy']));
    expect((await statusOf(a.id))).toMatchObject({ status: 'ready', path: '/dvr/clips/c66.mp4' });
    expect((await statusOf(b.id)).status).toBe('ready');
    expect(v.vodRecordingOf(ROOM)).toBeNull();
  });

  it('marks clips past the free cap or past the end unavailable, and a failed cut too', async () => {
    v.noteVodRecording(ROOM, { startedAt: T0, maxMs: 30 * 60_000 });
    const capped = await pending(1900);
    const late = await pending(800);
    const bad = await pending(10);
    cp.spawn.mockImplementation(() => proc(1));
    expect(await v.cutPendingClips(ROOM, FILE, 700)).toEqual({ ready: 0, unavailable: 3 });
    expect(await statusOf(capped.id)).toMatchObject({ status: 'unavailable', reason: 'past_cap', path: null });
    expect(await statusOf(late.id)).toMatchObject({ status: 'unavailable', reason: 'past_end' });
    expect(await statusOf(bad.id)).toMatchObject({ status: 'unavailable', reason: 'failed' });
    expect(fsp.unlink).toHaveBeenCalledWith('/tmp/livekit-dvr-clips/c10.mp4');
  });

  it('no recording file (VOD off, egress failed) makes every pending clip unavailable', async () => {
    const a = await pending(5);
    expect(await v.cutPendingClips(ROOM, null)).toEqual({ ready: 0, unavailable: 1 });
    expect(await statusOf(a.id)).toMatchObject({ status: 'unavailable', reason: 'no_recording' });
    const b = await pending(5);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    fsp.stat.mockRejectedValue(new Error('ENOENT'));
    const done = v.cutPendingClips(ROOM, FILE);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await done).toEqual({ ready: 0, unavailable: 1 });
    expect(await statusOf(b.id)).toMatchObject({ reason: 'no_recording' });
  });

  it('is time-boxed: a hanging cut is killed and the rest is given up, never throwing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await pending(i * 40)).id);
    cp.spawn.mockImplementation(() => proc('hang'));
    const done = v.cutPendingClips(ROOM, FILE, 0);
    await vi.advanceTimersByTimeAsync(200_000);
    const r = await done;
    expect(r.ready).toBe(0);
    expect(r.unavailable).toBe(6);
    expect(cp.spawn.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('nothing pending: returns at once, and a store that throws never breaks the caller', async () => {
    expect(await v.cutPendingClips(ROOM, FILE)).toEqual({ ready: 0, unavailable: 0 });
    expect(cp.spawn).not.toHaveBeenCalled();
    c.setClipStore({ ...c.memoryClipStore(), listPending: async () => { throw new Error('db down'); } });
    await expect(v.cutPendingClips(ROOM, FILE)).resolves.toEqual({ ready: 0, unavailable: 0 });
  });

  it('a pending clip whose recording never came shows as unavailable after 5 h', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = await pending(5);
    vi.setSystemTime(Date.now() + 6 * 3_600_000);
    expect(await statusOf(a.id)).toMatchObject({ status: 'unavailable', reason: 'no_recording' });
  });
});
