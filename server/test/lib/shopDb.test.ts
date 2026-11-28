import { describe, expect, it } from 'vitest';
import { memoryCol } from '../../src/lib/shopDb.js';

// The memory side of lib/shopDb.ts: the Mongo calls the points shop makes.
describe('memoryCol', () => {
  interface Doc { id: string; user: string; n: number; tags?: string[]; data?: { room?: string }; at?: Date }

  it('filters by value, nested paths and operators, sorts and limits', async () => {
    const c = memoryCol<Doc>([['id']]);
    await c.insertOne({ id: 'a', user: 'fan', n: 3, data: { room: 'r1' }, at: new Date(1000) });
    await c.insertOne({ id: 'b', user: 'bob', n: 1, data: { room: 'r2' }, at: new Date(2000) });
    await c.insertOne({ id: 'c', user: 'fan', n: 2, tags: ['x', 'y'] });
    expect(await c.insertOne({ id: 'a', user: 'dup', n: 0 })).toBe(false);
    expect((await c.find({ user: 'fan' }, { sort: { n: 1 } })).map((d) => d.id)).toEqual(['c', 'a']);
    expect((await c.find({ 'data.room': 'r2' })).map((d) => d.id)).toEqual(['b']);
    expect((await c.find({ n: { $gte: 2, $lt: 3 } })).map((d) => d.id)).toEqual(['c']);
    expect((await c.find({ user: { $in: ['bob'] } })).map((d) => d.id)).toEqual(['b']);
    expect((await c.find({ user: { $nin: ['bob'] }, n: { $ne: 3 } })).map((d) => d.id)).toEqual(['c']);
    expect((await c.find({ tags: 'y' })).map((d) => d.id)).toEqual(['c']);
    expect((await c.find({ tags: { $exists: false } }, { sort: { n: -1 }, limit: 1 })).map((d) => d.id)).toEqual(['a']);
    expect((await c.find({ at: { $gt: new Date(1500) } })).map((d) => d.id)).toEqual(['b']);
    expect(await c.count({ user: 'fan' })).toBe(2);
    await expect(c.find({ n: { $regex: 'x' } })).rejects.toThrow('not supported');
  });

  it('updates with $set, $inc, $unset, $push, $pull; upserts; keeps unique fields unique', async () => {
    const c = memoryCol<Doc>([['id']]);
    await c.insertOne({ id: 'a', user: 'fan', n: 1, tags: ['x'] });
    const u = await c.update({ id: 'a' }, { $set: { 'data.room': 'r1' }, $inc: { n: 2 }, $push: { tags: 'y' } });
    expect(u).toMatchObject({ n: 3, data: { room: 'r1' }, tags: ['x', 'y'] });
    expect(await c.update({ id: 'a' }, { $pull: { tags: 'x' }, $unset: { 'data.room': '' } })).toMatchObject({ tags: ['y'], data: {} });
    expect(await c.update({ id: 'zz' }, { $set: { n: 1 } })).toBeNull();
    const up = await c.update({ id: 'b', user: 'bob' }, { $inc: { n: 5 }, $setOnInsert: { tags: [] } }, { upsert: true });
    expect(up).toEqual({ id: 'b', user: 'bob', n: 5, tags: [] });
    await c.update({ id: 'b' }, { $setOnInsert: { n: 99 } }, { upsert: true });
    expect((await c.findOne({ id: 'b' }))?.n).toBe(5);
    await expect(c.update({ id: 'b' }, { $set: { id: 'a' } })).rejects.toThrow('duplicate key');
    await expect(c.update({ id: 'c' }, { $set: { id: 'a' } }, { upsert: true })).rejects.toThrow('duplicate key');
    await expect(c.update({ id: 'a' }, { $rename: { n: 'm' } })).rejects.toThrow('not supported');
    expect(await c.deleteOne({ id: 'a' })).toBe(true);
    expect(await c.deleteOne({ id: 'a' })).toBe(false);
    // What it hands out is a copy.
    const got = await c.findOne({ id: 'b' });
    got!.n = 0;
    expect((await c.findOne({ id: 'b' }))?.n).toBe(5);
  });
});
