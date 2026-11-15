import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mongo = vi.hoisted(() => ({
  updateOne: vi.fn(), findOne: vi.fn(), createIndex: vi.fn(), connect: vi.fn(), fail: false,
}));
vi.mock('mongodb', () => ({
  MongoClient: class {
    async connect() { mongo.connect(); if (mongo.fail) throw new Error('down'); }
    db() { return { collection: () => ({ updateOne: mongo.updateOne, findOne: mongo.findOne, createIndex: mongo.createIndex }) }; }
  },
}));

type H = typeof import('../../src/lib/streamHighlights.js');
let h: H;
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0); // a bucket boundary

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  h = await import('../../src/lib/streamHighlights.js');
  h.resetHighlights();
}

beforeEach(async () => {
  mongo.fail = false;
  mongo.updateOne.mockResolvedValue({});
  mongo.findOne.mockResolvedValue(null);
  mongo.createIndex.mockResolvedValue('ok');
  await load();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

/** n distinct chatters, one line each, inside the bucket starting at `t`. */
const chatBurst = (room: string, t: number, n: number, prefix = 'fan') => {
  for (let i = 0; i < n; i++) h.noteChat(room, `${prefix}${i}`, t + 1000 + i);
};

describe('bucketScore and isSpike (pure)', () => {
  it('counts chatters fully, extra lines at half, boosts at 3 and dollars a little (capped)', () => {
    expect(h.bucketScore({ chatters: 4, lines: 6, boosts: 0, usd: 0 })).toBe(5);
    expect(h.bucketScore({ chatters: 0, lines: 0, boosts: 2, usd: 10 })).toBe(8);
    expect(h.bucketScore({ chatters: 0, lines: 0, boosts: 1, usd: 500 })).toBe(13);
  });

  it('needs the minimum score and 2.5x the baseline; a big boost always counts', () => {
    expect(h.isSpike(3, [])).toBe(false);
    expect(h.isSpike(4, [])).toBe(true);
    expect(h.isSpike(6, [3, 3])).toBe(false);
    expect(h.isSpike(8, [3, 3])).toBe(true);
    expect(h.isSpike(0, [10], true)).toBe(true);
  });
});

describe('chat and boost spikes', () => {
  it('a chat burst after a quiet stretch becomes a moment with its offset since go-live', async () => {
    h.setRoomResolver(async () => ({ host: 'badadib', liveAt: T0 - 600_000 }));
    const seen: unknown[] = [];
    h.onHighlight((room, m, info) => seen.push({ room, m, info }));
    h.noteChat('badadib-r1', 'fan0', T0 - 60_000); // tracked, resolver runs
    await Promise.resolve();
    chatBurst('badadib-r1', T0, 6);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    const data = await h.getHighlights('badadib-r1');
    expect(data?.host).toBe('badadib');
    expect(data?.moments).toHaveLength(1);
    expect(data?.moments[0]).toMatchObject({ at: T0 + 20_000, offsetSec: 620, reasons: ['chat'], chatters: 6, lines: 6, score: 6 });
    expect(seen).toHaveLength(1);
    expect(mongo.updateOne).not.toHaveBeenCalled(); // no MONGODB_URI in tests
  });

  it('one person spamming is not a spike (3 lines per sender per bucket)', async () => {
    for (let i = 0; i < 30; i++) h.noteChat('r', 'spammer', T0 + i * 100);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect((await h.getHighlights('r'))?.moments).toEqual([]);
  });

  it('a busy chat that stays busy is the baseline, not a string of spikes', async () => {
    for (let b = 0; b < 10; b++) chatBurst('r', T0 + b * h.BUCKET_MS, 6);
    h.sweepHighlights(T0 + 10 * h.BUCKET_MS);
    // Only the first bucket stands out against an empty baseline.
    expect((await h.getHighlights('r'))?.moments).toHaveLength(1);
  });

  it('moments are at least 90 s apart and at most 12 per stream', async () => {
    let t = T0;
    for (let i = 0; i < 40; i++) {
      chatBurst('r', t, 8, `w${i}-`);
      t += h.BUCKET_MS;
      // quiet buckets in between drop the baseline again
      t += 5 * h.BUCKET_MS;
    }
    h.sweepHighlights(t + h.BUCKET_MS);
    const ms = (await h.getHighlights('r'))!.moments;
    expect(ms).toHaveLength(h.MAX_MOMENTS);
    for (let i = 1; i < ms.length; i++) expect(ms[i].at - ms[i - 1].at).toBeGreaterThanOrEqual(90_000);
  });

  it('a boost of 5 USD or more is a moment on its own; small boosts add up', async () => {
    h.noteBoost('r', 7.5, T0 + 1000);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect((await h.getHighlights('r'))!.moments[0]).toMatchObject({ reasons: ['big_boost'], boosts: 1, usd: 7.5 });

    h.noteBoost('r2', 1, T0 + 1000);
    h.noteBoost('r2', 1, T0 + 2000);
    h.noteBoost('r2', Number.NaN, T0 + 3000);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect((await h.getHighlights('r2'))!.moments[0]).toMatchObject({ reasons: ['boosts'], boosts: 3, usd: 2 });
  });

  it('chat and boosts in the same bucket list both reasons; offset is null without liveAt', async () => {
    chatBurst('r', T0, 3);
    h.noteBoost('r', 1, T0 + 5000);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect((await h.getHighlights('r'))!.moments[0]).toMatchObject({ reasons: ['chat', 'boosts'], offsetSec: null });
  });

  it('the next event closes a finished bucket without the sweep', async () => {
    chatBurst('r', T0, 5);
    h.noteChat('r', 'late', T0 + h.BUCKET_MS + 10);
    expect((await h.getHighlights('r'))!.moments).toHaveLength(1);
  });

  it('a throwing listener does not stop counting', async () => {
    h.onHighlight(() => { throw new Error('boom'); });
    const off = h.onHighlight(() => {});
    off();
    chatBurst('r', T0, 5);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect((await h.getHighlights('r'))!.moments).toHaveLength(1);
  });

  it('does nothing when HIGHLIGHTS_ENABLED=false or without a room', async () => {
    h.noteChat('', 'x', T0);
    expect(await h.getHighlights('')).toBeNull();
    await load({ HIGHLIGHTS_ENABLED: 'false' });
    chatBurst('r', T0, 6);
    h.noteBoost('r', 50, T0);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect(await h.getHighlights('r')).toBeNull();
  });

  it('caps senders per bucket and the number of rooms tracked, and forgets idle rooms', async () => {
    chatBurst('r', T0, 400);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect((await h.getHighlights('r'))!.moments[0].chatters).toBe(300);
    for (let i = 0; i < 500; i++) h.noteChat(`room-${i}`, 'a', T0 + 5000 + i);
    expect(await h.getHighlights('r')).toBeNull(); // least recently touched dropped
    h.sweepHighlights(T0 + 60 * 60_000);
    expect(await h.getHighlights('room-499')).toBeNull();
  });

  it('a resolver that fails leaves host and liveAt unknown', async () => {
    h.setRoomResolver(async () => { throw new Error('lk down'); });
    chatBurst('r', T0, 5);
    await Promise.resolve();
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect((await h.getHighlights('r'))!.host).toBeNull();
  });

  it('the shared sweep timer starts once and closes buckets', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    h.startHighlightSweep(1000);
    h.startHighlightSweep(1000);
    chatBurst('r', T0, 5);
    vi.setSystemTime(T0 + h.BUCKET_MS + 1);
    vi.advanceTimersByTime(1000);
    expect((await h.getHighlights('r'))!.moments).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('writes each moment to stream-highlights (TTL index) and reads a finished room back', async () => {
    await load({ MONGODB_URI: 'mongodb://test' });
    h.setRoomResolver(async () => ({ host: 'badadib', liveAt: T0 }));
    h.noteChat('r', 'a', T0 - 100);
    await Promise.resolve();
    chatBurst('r', T0, 6);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    await vi.waitFor(() => expect(mongo.updateOne).toHaveBeenCalledTimes(1));
    const [filter, update, opts] = mongo.updateOne.mock.calls[0];
    expect(filter).toEqual({ room: 'r' });
    expect(update.$set).toMatchObject({ host: 'badadib', moments: [expect.objectContaining({ chatters: 6 })] });
    expect(opts).toEqual({ upsert: true });
    expect(mongo.createIndex).toHaveBeenCalledWith({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    mongo.findOne.mockResolvedValue({ room: 'gone', host: 'badadib', liveAt: new Date(T0), moments: [{ at: 1 }] });
    expect(await h.getHighlights('gone')).toEqual({ host: 'badadib', liveAt: T0, moments: [{ at: 1 }] });
    mongo.findOne.mockResolvedValue({ room: 'gone2', host: null, liveAt: null });
    expect(await h.getHighlights('gone2')).toEqual({ host: null, liveAt: null, moments: [] });
    mongo.findOne.mockRejectedValue(new Error('x'));
    expect(await h.getHighlights('gone3')).toBeNull();
  });

  it('a Mongo that is down or throws on write never breaks counting', async () => {
    await load({ MONGODB_URI: 'mongodb://test' });
    mongo.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    chatBurst('r', T0, 6);
    h.sweepHighlights(T0 + h.BUCKET_MS);
    expect(await h.getHighlights('nope')).toBeNull();
    mongo.fail = false;
    mongo.updateOne.mockRejectedValue(new Error('write'));
    chatBurst('r', T0 + 10 * h.BUCKET_MS, 20, 'z');
    h.sweepHighlights(T0 + 11 * h.BUCKET_MS);
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect((await h.getHighlights('r'))!.moments.length).toBeGreaterThanOrEqual(1);
    err.mockRestore();
  });
});
