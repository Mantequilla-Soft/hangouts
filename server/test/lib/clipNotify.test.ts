import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/lib/livekit.js', () => ({ roomService: { listRooms: vi.fn() } }));

type N = typeof import('../../src/lib/clipNotify.js');
type C = typeof import('../../src/lib/streamClips.js');
let n: N;
let c: C;
let lk: typeof import('../../src/lib/livekit.js')['roomService'];
const ROOM = 'badadib-n1';

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  lk = (await import('../../src/lib/livekit.js')).roomService;
  n = await import('../../src/lib/clipNotify.js');
  c = await import('../../src/lib/streamClips.js');
  c.setClipStore(c.memoryClipStore());
}
const keep = (clipper: string | null, extra: Record<string, unknown> = {}) =>
  c.registerClip({ room: ROOM, host: 'badadib', clipper, source: clipper ? 'viewer' : 'auto', file: `${Math.random()}.mp4`, offsetSec: 1, durationSec: 30, ...extra });

beforeEach(async () => { await load({ CLIPS_NOTIFY_ENABLED: 'true', STREAM_STATS_SECRET: 'test-secret', CHECKER_URL: 'https://checker.test/' }); });
afterEach(() => vi.unstubAllEnvs());

describe('clipsReadyBody', () => {
  it('counts the ready clips for the host and per clipper (not the host, not guests or automatic ones)', async () => {
    await keep('fan'); await keep('fan'); await keep('badadib'); await keep(null); await keep('other', { pendingAt: 5 });
    const clips = await (await c.clipStore()).listForRoom(ROOM);
    expect(n.clipsReadyBody(ROOM, clips, 'Friday')).toEqual({ room: ROOM, host: 'badadib', title: 'Friday', total: 4, clippers: [{ user: 'fan', count: 2 }] });
    expect(n.clipsReadyBody(ROOM, [], null)).toBeNull();
  });
});

describe('notifyClipsReady', () => {
  it('posts to the checker with the stream-stats secret', async () => {
    vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: JSON.stringify({ host: 'badadib', title: 'Friday' }) }] as never);
    await keep('fan');
    const f = vi.fn().mockResolvedValue({ ok: true });
    expect(await n.notifyClipsReady(ROOM, f as never)).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://checker.test/stream-stats/clips-ready');
    expect(init.headers.Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(init.body)).toEqual({ room: ROOM, host: 'badadib', title: 'Friday', total: 1, clippers: [{ user: 'fan', count: 1 }] });
  });

  it('does nothing without clips, when switched off (the default) or without the secret, and swallows failures', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    expect(await n.notifyClipsReady(ROOM, f as never)).toBe(false);
    await keep('fan');
    vi.mocked(lk.listRooms).mockResolvedValue([] as never);
    f.mockRejectedValue(new Error('down'));
    expect(await n.notifyClipsReady(ROOM, f as never)).toBe(false);
    await load({ CLIPS_NOTIFY_ENABLED: 'false', STREAM_STATS_SECRET: 'test-secret' });
    f.mockReset().mockResolvedValue({ ok: true });
    expect(await n.notifyClipsReady(ROOM, f as never)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    await load({ CLIPS_NOTIFY_ENABLED: 'true', STREAM_STATS_SECRET: '' });
    expect(await n.notifyClipsReady(ROOM, f as never)).toBe(false);
  });
});
