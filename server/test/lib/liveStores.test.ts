import { describe, expect, it, vi } from 'vitest';

// The Mongo side of the live-interaction stores (chat backlog, points, poll
// archive, raid opt-outs) against a recording fake collection.
const db = vi.hoisted(() => {
  const calls: Array<{ col: string; op: string; args: unknown[] }> = [];
  const results: Record<string, unknown> = {};
  const collection = (name: string) => {
    const rec = (op: string) => vi.fn(async (...args: unknown[]) => { calls.push({ col: name, op, args }); return results[`${name}.${op}`] ?? null; });
    return {
      createIndex: rec('createIndex'),
      insertMany: rec('insertMany'),
      deleteMany: rec('deleteMany'),
      deleteOne: rec('deleteOne'),
      updateOne: rec('updateOne'),
      bulkWrite: rec('bulkWrite'),
      findOne: rec('findOne'),
      find: vi.fn((...args: unknown[]) => {
        calls.push({ col: name, op: 'find', args });
        const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => (results[`${name}.find`] as unknown[]) ?? [] };
        return cursor;
      }),
    };
  };
  const cols = new Map<string, ReturnType<typeof collection>>();
  return { calls, results, cols, collection: (n: string) => { if (!cols.has(n)) cols.set(n, collection(n)); return cols.get(n)!; } };
});

vi.mock('mongodb', () => ({
  MongoClient: class {
    async connect() { return this; }
    db() { return { collection: db.collection }; }
  },
}));

vi.mock('../../src/config.js', () => ({
  config: { MONGODB_URI: 'mongodb://test', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' },
}));

const { mongoBacklogStore } = await import('../../src/lib/chatBacklog.js');
const { pointsBalance, POINTS_START, createPoll, resolvePrediction, stake, listRoomPolls, resetPolls } = await import('../../src/lib/polls.js');
const { acceptsRaids, setAcceptsRaids } = await import('../../src/lib/raids.js');
const { getLiveDb } = await import('../../src/lib/mongoDb.js');

const ops = (col: string, op: string) => db.calls.filter((c) => c.col === col && c.op === op);

describe('one shared connection', () => {
  it('connects once', async () => {
    const [a, b] = await Promise.all([getLiveDb(), getLiveDb()]);
    expect(a).toBe(b);
  });
});

describe('chat-backlog collection', () => {
  it('indexes once with a TTL, batches inserts and tolerates duplicates', async () => {
    await mongoBacklogStore.insert('r', [{ id: 'a-1', identity: 'a', name: 'a', text: 'hi', timestamp: 1 }]);
    await mongoBacklogStore.insert('r', []);
    const idx = ops('chat-backlog', 'createIndex').map((c) => c.args);
    expect(idx).toContainEqual([{ expiresAt: 1 }, { expireAfterSeconds: 0 }]);
    const [ins] = ops('chat-backlog', 'insertMany');
    expect((ins.args[0] as Array<{ room: string; expiresAt: Date }>)[0]).toMatchObject({ room: 'r', id: 'a-1' });
    expect(ins.args[1]).toEqual({ ordered: false });

    db.cols.get('chat-backlog')!.insertMany.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(mongoBacklogStore.insert('r', [{ id: 'a-1', identity: 'a', name: 'a', text: 'hi', timestamp: 1 }])).resolves.toBeUndefined();
    db.cols.get('chat-backlog')!.insertMany.mockRejectedValueOnce(new Error('network'));
    await expect(mongoBacklogStore.insert('r', [{ id: 'a-2', identity: 'a', name: 'a', text: 'hi', timestamp: 2 }])).rejects.toThrow('network');
  });

  it('deletes lines and a chatter, and loads oldest first', async () => {
    await mongoBacklogStore.remove('r', ['a-1']);
    await mongoBacklogStore.remove('r', []);
    await mongoBacklogStore.removeIdentity('r', 'guest-x');
    expect(ops('chat-backlog', 'deleteMany').map((c) => c.args[0])).toEqual([
      { room: 'r', id: { $in: ['a-1'] } }, { room: 'r', identity: 'guest-x' },
    ]);
    db.results['chat-backlog.find'] = [{ id: 'b', timestamp: 2 }, { id: 'a', timestamp: 1 }];
    expect((await mongoBacklogStore.load('r', 10)).map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('stream-points and stream-polls collections', () => {
  it('reads a balance, defaulting to the start amount', async () => {
    expect(await pointsBalance('badadib', 'fan')).toBe(POINTS_START);
    db.results['stream-points.findOne'] = { balance: 777 };
    expect(await pointsBalance('badadib', 'fan')).toBe(777);
    db.results['stream-points.findOne'] = null;
  });

  it('applies a resolution as one bulk write and archives the result', async () => {
    resetPolls();
    const p = createPoll('room-m', 'badadib', { kind: 'prediction', question: 'Win?', options: ['Yes', 'No'], durationSec: 60 }, null);
    await stake('room-m', p.id, 'fan', 0, 10);
    await stake('room-m', p.id, 'fan2', 1, 30);
    await resolvePrediction('room-m', p.id, 0);
    const [bulk] = ops('stream-points', 'bulkWrite');
    const writes = bulk.args[0] as Array<{ updateOne: { filter: unknown; upsert: boolean } }>;
    expect(writes.map((w) => w.updateOne.filter)).toEqual([{ channel: 'badadib', user: 'fan' }, { channel: 'badadib', user: 'fan2' }]);
    expect(writes.every((w) => w.updateOne.upsert)).toBe(true);
    const [save] = ops('stream-polls', 'updateOne');
    expect(save.args[0]).toEqual({ id: p.id });
    db.results['stream-polls.find'] = [{ id: p.id }];
    expect(await listRoomPolls('room-m')).toEqual([{ id: p.id }]);
  });
});

describe('raid-settings collection', () => {
  it('keeps a row only for hosts who turned raids off', async () => {
    await setAcceptsRaids('h', false);
    expect(ops('raid-settings', 'updateOne')[0].args[0]).toEqual({ owner: 'h' });
    await setAcceptsRaids('h', true);
    expect(ops('raid-settings', 'deleteOne')[0].args[0]).toEqual({ owner: 'h' });
    db.results['raid-settings.findOne'] = { _id: 1 };
    expect(await acceptsRaids('someone-new')).toBe(false);
  });
});
