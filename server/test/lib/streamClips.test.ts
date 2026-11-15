import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mongo = vi.hoisted(() => ({
  insertOne: vi.fn(), countDocuments: vi.fn(), find: vi.fn(), findOne: vi.fn(), deleteOne: vi.fn(), createIndex: vi.fn(), fail: false,
}));
vi.mock('mongodb', () => ({
  MongoClient: class {
    async connect() { if (mongo.fail) throw new Error('down'); }
    db() { return { collection: () => mongo }; }
  },
}));

type C = typeof import('../../src/lib/streamClips.js');
let c: C;

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  c = await import('../../src/lib/streamClips.js');
}

const input = (over: Record<string, unknown> = {}) => ({
  room: 'badadib-r1', host: 'badadib', clipper: 'fan', source: 'viewer' as const,
  file: 'f.mp4', offsetSec: 60, durationSec: 30, ...over,
});

beforeEach(async () => {
  mongo.fail = false;
  for (const k of ['insertOne', 'countDocuments', 'findOne', 'deleteOne', 'createIndex'] as const) mongo[k].mockReset();
  mongo.createIndex.mockResolvedValue('ok');
  await load();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('memory store (no MONGODB_URI)', () => {
  it('registers a clip kept CLIP_KEEP_HOURS, lists it for the room and the clipper, newest first', async () => {
    const a = await c.registerClip(input({ file: 'a.mp4' }));
    const b = await c.registerClip(input({ file: 'b.mp4', clipper: null, source: 'auto', reasons: ['chat'] }));
    if (!('clip' in a) || !('clip' in b)) throw new Error('refused');
    expect(a.clip.id).toMatch(/^[0-9a-f]{18}$/);
    expect(a.clip.expiresAt.getTime() - a.clip.createdAt.getTime()).toBe(48 * 3_600_000);
    const store = await c.clipStore();
    expect((await store.listForRoom('badadib-r1')).map((x) => x.file).sort()).toEqual(['a.mp4', 'b.mp4']);
    expect((await store.listForClipper('fan')).map((x) => x.file)).toEqual(['a.mp4']);
    expect(await store.get(a.clip.id)).toEqual(a.clip);
    await store.remove(a.clip.id);
    expect(await store.get(a.clip.id)).toBeNull();
    expect(c.clipView(b.clip)).toMatchObject({ path: '/dvr/clips/b.mp4', reasons: ['chat'], clipper: null, source: 'auto' });
    expect(c.clipView(a.clip).reasons).toEqual([]);
  });

  it('refuses past 8 clips per clipper and 40 per stream', async () => {
    for (let i = 0; i < c.MAX_CLIPS_PER_CLIPPER; i++) expect('clip' in await c.registerClip(input())).toBe(true);
    expect(await c.registerClip(input())).toEqual({ refused: 'clipper_full' });
    for (let i = c.MAX_CLIPS_PER_CLIPPER; i < c.MAX_CLIPS_PER_ROOM; i++) await c.registerClip(input({ clipper: null }));
    expect(await c.registerClip(input({ clipper: 'other' }))).toEqual({ refused: 'room_full' });
  });

  it('forgets expired clips', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = await c.registerClip(input());
    vi.setSystemTime(Date.now() + 49 * 3_600_000);
    const store = await c.clipStore();
    expect(await store.listForRoom('badadib-r1')).toEqual([]);
    if ('clip' in r) expect(await store.get(r.clip.id)).toBeNull();
  });

  it('setClipStore swaps the store (tests)', async () => {
    const fake = c.memoryClipStore();
    c.setClipStore(fake);
    expect(await c.clipStore()).toBe(fake);
    c.setClipStore(null);
  });
});

describe('Mongo store', () => {
  beforeEach(async () => { await load({ MONGODB_URI: 'mongodb://test' }); });

  it('creates the indexes (TTL on expiresAt) once and queries only unexpired rows', async () => {
    mongo.countDocuments.mockResolvedValue(0);
    mongo.insertOne.mockResolvedValue({});
    const r = await c.registerClip(input());
    expect('clip' in r).toBe(true);
    expect(mongo.createIndex).toHaveBeenCalledWith({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    expect(mongo.createIndex).toHaveBeenCalledWith({ id: 1 }, { unique: true });
    expect(mongo.countDocuments).toHaveBeenCalledWith({ room: 'badadib-r1', expiresAt: { $gt: expect.any(Date) } });
    expect(mongo.countDocuments).toHaveBeenCalledWith({ room: 'badadib-r1', clipper: 'fan', expiresAt: { $gt: expect.any(Date) } });

    const toArray = vi.fn().mockResolvedValue([{ id: 'x' }]);
    const limit = vi.fn(() => ({ toArray }));
    const sort = vi.fn(() => ({ limit }));
    mongo.find.mockReturnValue({ sort });
    const store = await c.clipStore();
    expect(await store.listForRoom('badadib-r1')).toEqual([{ id: 'x' }]);
    expect(await store.listForClipper('fan')).toEqual([{ id: 'x' }]);
    expect(limit).toHaveBeenCalledWith(40);
    expect(limit).toHaveBeenCalledWith(50);
    mongo.findOne.mockResolvedValue({ id: 'x' });
    expect(await store.get('x')).toEqual({ id: 'x' });
    mongo.deleteOne.mockResolvedValue({});
    await store.remove('x');
    expect(mongo.deleteOne).toHaveBeenCalledWith({ id: 'x' });
    expect(mongo.createIndex).toHaveBeenCalledTimes(4);
  });

  it('falls back to memory when Mongo cannot connect', async () => {
    mongo.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await c.registerClip(input());
    expect('clip' in r).toBe(true);
    expect(mongo.insertOne).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
