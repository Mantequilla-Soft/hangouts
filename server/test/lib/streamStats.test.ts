import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The secret and checker URL are read once at import, and the sampler keeps its
// timer and tracked rooms in module state, so each test re-imports the module
// with its own config. LiveKit and fetch are fakes; fake timers drive the
// sampler interval.
const h = vi.hoisted(() => ({
  config: { CHECKER_URL: 'https://checker.test/', STREAM_STATS_SECRET: 'stats-secret' },
  listRooms: vi.fn(),
  listParticipants: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: h.listRooms, listParticipants: h.listParticipants },
}));

type StatsModule = typeof import('../../src/lib/streamStats.js');
let fetchMock: ReturnType<typeof vi.fn>;

async function load(secret = 'stats-secret'): Promise<StatsModule> {
  h.config.STREAM_STATS_SECRET = secret;
  vi.resetModules();
  return import('../../src/lib/streamStats.js');
}

/** Every POST the module sent, as { path, body }. */
const posts = () => fetchMock.mock.calls.map(([url, init]) => ({
  path: String(url).replace('https://checker.test', ''),
  body: JSON.parse(String((init as RequestInit).body)),
}));
const postsTo = (path: string) => posts().filter((p) => p.path === path).map((p) => p.body);

const T0 = Date.parse('2026-11-13T12:00:00Z');
const live = (name: string, meta: Record<string, unknown>) => ({ name, metadata: JSON.stringify(meta) });
const standalone = (host: string, extra: Record<string, unknown> = {}) =>
  ({ mode: 'standalone', host, liveAt: new Date(T0 - 60_000).toISOString(), ...extra });
const people = (...ids: string[]) => ids.map((identity) => ({ identity }));

/** Run one sampler tick (default 30 s interval). */
const tick = (ms = 30_000) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  h.config.CHECKER_URL = 'https://checker.test/';
  h.listRooms.mockReset().mockResolvedValue([]);
  h.listParticipants.mockReset().mockResolvedValue([]);
  fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recordViewerJoin / recordBoost', () => {
  it('posts a viewer join to the checker with the shared secret', async () => {
    const stats = await load();
    stats.recordViewerJoin('alice-room', 'alice');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://checker.test/stream-stats/viewer');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stats-secret' },
    });
    expect(JSON.parse(init.body)).toEqual({ streamId: 'alice-room', roomName: 'alice-room', host: 'alice' });
  });

  it('posts a boost with its sender, amount and message', async () => {
    const stats = await load();
    stats.recordBoost('alice-room', 'alice', 'bob', 2.5, 'great stream');

    expect(postsTo('/stream-stats/boost')).toEqual([{
      streamId: 'alice-room', roomName: 'alice-room', host: 'alice', sender: 'bob', amount: 2.5, message: 'great stream',
    }]);
  });

  it('ignores a boost without a sender', async () => {
    const stats = await load();
    stats.recordBoost('alice-room', 'alice', '', 1);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing at all when no stats secret is configured', async () => {
    const stats = await load('');
    stats.recordViewerJoin('alice-room', 'alice');
    stats.recordBoost('alice-room', 'alice', 'bob', 1);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a checker that cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const stats = await load();

    expect(() => stats.recordViewerJoin('alice-room')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0); // the rejection is handled, not unhandled
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('startStreamStatsSampler', () => {
  it('does not poll LiveKit when no stats secret is configured', async () => {
    const stats = await load('');
    stats.startStreamStatsSampler();
    await tick(120_000);

    expect(h.listRooms).not.toHaveBeenCalled();
  });

  it('polls LiveKit every 30 s by default', async () => {
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick(29_999);
    expect(h.listRooms).not.toHaveBeenCalled();
    await tick(1);
    expect(h.listRooms).toHaveBeenCalledTimes(1);
    await tick();
    expect(h.listRooms).toHaveBeenCalledTimes(2);
  });

  it('honours a custom interval', async () => {
    const stats = await load();
    stats.startStreamStatsSampler(5_000);
    await tick(15_000);

    expect(h.listRooms).toHaveBeenCalledTimes(3);
  });

  it('starts only one sampler when called twice', async () => {
    const stats = await load();
    stats.startStreamStatsSampler();
    stats.startStreamStatsSampler();
    await tick();

    expect(h.listRooms).toHaveBeenCalledTimes(1);
  });

  it('reports the concurrent viewers of a live standalone stream as its peak', async () => {
    h.listRooms.mockResolvedValue([live('alice-room', standalone('Alice', { collabGuest: 'carol' }))]);
    h.listParticipants.mockResolvedValue(people('Alice', 'carol', 'obs-alice', 'bob', 'dave'));
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick();

    expect(h.listParticipants).toHaveBeenCalledWith('alice-room');
    // The host, the co-broadcaster and the OBS ingress participant are not viewers;
    // the host is reported lower-cased.
    expect(postsTo('/stream-stats/peak')).toEqual([
      { streamId: 'alice-room', roomName: 'alice-room', host: 'alice', peak: 2 },
    ]);
  });

  it('skips conference rooms, streams that never went live and unreadable metadata', async () => {
    h.listRooms.mockResolvedValue([
      live('conf', { mode: 'conference', host: 'alice', liveAt: new Date(T0).toISOString() }),
      live('not-yet-live', { mode: 'standalone', host: 'alice' }),
      { name: 'garbled', metadata: '{not json' },
      { name: 'empty', metadata: '' },
    ]);
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick();
    h.listRooms.mockResolvedValue([]);
    await tick();

    expect(h.listParticipants).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled(); // no peak, and no "end" for rooms it never tracked
  });

  it('reports no host when the metadata host is not a string', async () => {
    h.listRooms.mockResolvedValue([live('odd', standalone('x', { host: 42 }))]);
    h.listParticipants.mockResolvedValue(people('bob'));
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick();

    expect(postsTo('/stream-stats/peak')).toEqual([{ streamId: 'odd', roomName: 'odd', peak: 1 }]);
  });

  it('skips a room whose participants cannot be listed, but keeps sampling the rest', async () => {
    h.listRooms.mockResolvedValue([live('broken', standalone('alice')), live('fine', standalone('bob'))]);
    h.listParticipants.mockImplementation(async (name: string) => {
      if (name === 'broken') throw new Error('twirp error');
      return people('bob', 'viewer1');
    });
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick();

    expect(postsTo('/stream-stats/peak')).toEqual([{ streamId: 'fine', roomName: 'fine', host: 'bob', peak: 1 }]);
  });

  it('reports the end and duration of a stream once its room disappears', async () => {
    h.listRooms.mockResolvedValue([live('alice-room', standalone('alice'))]);
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick(); // seen at T0+30s, live since T0-60s
    await tick(); // seen at T0+60s
    h.listRooms.mockResolvedValue([]);
    await tick(); // gone at T0+90s

    expect(postsTo('/stream-stats/end')).toEqual([
      { streamId: 'alice-room', roomName: 'alice-room', host: 'alice', durationSec: 120 },
    ]);
  });

  it('reports a stream end only once', async () => {
    h.listRooms.mockResolvedValue([live('alice-room', standalone('alice'))]);
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick();
    h.listRooms.mockResolvedValue([]);
    await tick();
    await tick();

    expect(postsTo('/stream-stats/end')).toHaveLength(1);
  });

  it('times a stream from when it was first seen when its liveAt is not a date', async () => {
    h.listRooms.mockResolvedValue([live('alice-room', standalone('alice', { liveAt: 'soon' }))]);
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick(); // first seen at T0+30s; liveAt falls back to "now" each tick
    await tick();
    h.listRooms.mockResolvedValue([]);
    await tick();

    expect(postsTo('/stream-stats/end')[0].durationSec).toBe(0);
  });

  it('never reports a negative duration for a liveAt in the future', async () => {
    h.listRooms.mockResolvedValue([live('alice-room', standalone('alice', { liveAt: new Date(T0 + 3_600_000).toISOString() }))]);
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick();
    h.listRooms.mockResolvedValue([]);
    await tick();

    expect(postsTo('/stream-stats/end')[0].durationSec).toBe(0);
  });

  it('does not end tracked streams when LiveKit cannot be reached for a tick', async () => {
    h.listRooms.mockResolvedValue([live('alice-room', standalone('alice'))]);
    const stats = await load();
    stats.startStreamStatsSampler();
    await tick();
    h.listRooms.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await tick();

    expect(postsTo('/stream-stats/end')).toEqual([]);
    expect(postsTo('/stream-stats/peak')).toHaveLength(1);

    await tick(); // LiveKit back, room still there
    expect(postsTo('/stream-stats/end')).toEqual([]);
    expect(postsTo('/stream-stats/peak')).toHaveLength(2);
  });
});
