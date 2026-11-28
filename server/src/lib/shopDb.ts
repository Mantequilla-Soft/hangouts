import type { Db } from 'mongodb';
import { getLiveDb } from './mongoDb.js';

/**
 * The few collection calls the points shop (lib/pointsShop.ts) makes, so the
 * same code runs on Mongo and, in tests or without a database, in memory.
 * The memory side understands what the shop uses and nothing more: filters
 * of equal values, `$in`, `$ne`, `$lt`/`$lte`/`$gt`/`$gte`, and `$exists`;
 * updates of `$set`, `$inc`, `$unset`, `$push`, `$pull` and `$setOnInsert`;
 * sorting on top-level fields.
 */

export type Filter = Record<string, unknown>;
export type Update = Record<string, Record<string, unknown>>;
export interface FindOpts { sort?: Record<string, 1 | -1>; limit?: number }

export interface Col<T extends object> {
  insertOne(doc: T): Promise<boolean>;
  findOne(filter: Filter): Promise<T | null>;
  find(filter: Filter, opts?: FindOpts): Promise<T[]>;
  count(filter: Filter): Promise<number>;
  /** The document after the update, or null when nothing matched (and no upsert). */
  update(filter: Filter, update: Update, opts?: { upsert?: boolean }): Promise<T | null>;
  deleteOne(filter: Filter): Promise<boolean>;
}

const get = (doc: object, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), doc);

function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]] = value;
}

function unsetPath(doc: Record<string, unknown>, path: string): void {
  const keys = path.split('.');
  const parent = keys.length === 1 ? doc : get(doc, keys.slice(0, -1).join('.'));
  if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[keys[keys.length - 1]];
}

const cmp = (a: unknown, b: unknown): number => {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  return (x as number) < (y as number) ? -1 : 1;
};
const same = (a: unknown, b: unknown) => (Array.isArray(a) ? a.some((v) => cmp(v, b) === 0) : cmp(a, b) === 0);

function matches(doc: object, filter: Filter): boolean {
  return Object.entries(filter).every(([path, want]) => {
    const have = get(doc, path);
    if (want && typeof want === 'object' && !(want instanceof Date) && !Array.isArray(want)) {
      return Object.entries(want as Record<string, unknown>).every(([op, v]) => {
        switch (op) {
          case '$in': return (v as unknown[]).some((x) => same(have, x));
          case '$nin': return !(v as unknown[]).some((x) => same(have, x));
          case '$ne': return !same(have, v);
          case '$lt': return have !== undefined && cmp(have, v) < 0;
          case '$lte': return have !== undefined && cmp(have, v) <= 0;
          case '$gt': return have !== undefined && cmp(have, v) > 0;
          case '$gte': return have !== undefined && cmp(have, v) >= 0;
          case '$exists': return (have !== undefined) === !!v;
          default: throw new Error(`memory collection: ${op} is not supported`);
        }
      });
    }
    return same(have, want);
  });
}

function applyUpdate(doc: Record<string, unknown>, update: Update, inserting: boolean): void {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, v] of Object.entries(fields)) {
      switch (op) {
        case '$set': setPath(doc, path, v); break;
        case '$setOnInsert': if (inserting) setPath(doc, path, v); break;
        case '$inc': setPath(doc, path, ((get(doc, path) as number) || 0) + (v as number)); break;
        case '$unset': unsetPath(doc, path); break;
        case '$push': setPath(doc, path, [...((get(doc, path) as unknown[]) ?? []), v]); break;
        case '$pull': setPath(doc, path, ((get(doc, path) as unknown[]) ?? []).filter((x) => !same(x, v))); break;
        default: throw new Error(`memory collection: ${op} is not supported`);
      }
    }
  }
}

const clone = <T>(v: T): T => structuredClone(v);

/** `unique`: field sets that may appear once (like a unique index). */
export function memoryCol<T extends object>(unique: string[][] = []): Col<T> & { docs: T[] } {
  const docs: T[] = [];
  const clash = (d: T, skip?: T) => unique.some((keys) => docs.some((o) => o !== skip
    && keys.every((k) => get(o, k) !== undefined && cmp(get(o, k), get(d, k)) === 0)));
  const sorted = (list: T[], sort?: Record<string, 1 | -1>) => (sort
    ? [...list].sort((a, b) => {
      for (const [k, dir] of Object.entries(sort)) { const c = cmp(get(a, k), get(b, k)); if (c) return c * dir; }
      return 0;
    })
    : list);
  return {
    docs,
    async insertOne(doc) { if (clash(doc)) return false; docs.push(clone(doc)); return true; },
    async findOne(filter) { const d = docs.find((x) => matches(x, filter)); return d ? clone(d) : null; },
    async find(filter, opts = {}) {
      const list = sorted(docs.filter((x) => matches(x, filter)), opts.sort);
      return clone(opts.limit ? list.slice(0, opts.limit) : list);
    },
    async count(filter) { return docs.filter((x) => matches(x, filter)).length; },
    async update(filter, update, opts = {}) {
      const d = docs.find((x) => matches(x, filter));
      if (d) {
        const next = clone(d) as Record<string, unknown>;
        applyUpdate(next, update, false);
        if (clash(next as T, d)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
        Object.assign(d, next);
        for (const k of Object.keys(d)) if (!(k in next)) delete (d as Record<string, unknown>)[k];
        return clone(d);
      }
      if (!opts.upsert) return null;
      const fresh: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && (typeof v !== 'object' || v === null || v instanceof Date)) setPath(fresh, k, v);
      applyUpdate(fresh, update, true);
      if (clash(fresh as T)) throw Object.assign(new Error('duplicate key'), { code: 11000 });
      docs.push(fresh as T);
      return clone(fresh as T);
    },
    async deleteOne(filter) {
      const i = docs.findIndex((x) => matches(x, filter));
      if (i < 0) return false;
      docs.splice(i, 1);
      return true;
    },
  };
}

/** The same calls on a Mongo collection, with its indexes made once. */
export function mongoCol<T extends object>(name: string, indexes: { keys: Record<string, 1 | -1>; unique?: boolean; expireAfterSeconds?: number }[] = []): Col<T> {
  let ready: Promise<ReturnType<Db['collection']> | null> | null = null;
  const fallback = memoryCol<T>(indexes.filter((i) => i.unique).map((i) => Object.keys(i.keys)));
  const col = () => (ready ??= (async () => {
    const db = await getLiveDb();
    if (!db) { ready = null; return null; }
    const c = db.collection(name);
    for (const i of indexes) {
      await c.createIndex(i.keys, {
        ...(i.unique ? { unique: true } : {}),
        ...(i.expireAfterSeconds ? { expireAfterSeconds: i.expireAfterSeconds } : {}),
      }).catch(() => undefined);
    }
    return c;
  })());
  const strip = <D>(d: D | null): D | null => {
    if (!d) return null;
    const { _id, ...rest } = d as Record<string, unknown>;
    void _id;
    return rest as D;
  };
  return {
    async insertOne(doc) {
      const c = await col();
      if (!c) return fallback.insertOne(doc);
      try { await c.insertOne({ ...doc }); return true; } catch (err) {
        if ((err as { code?: number }).code === 11000) return false;
        throw err;
      }
    },
    async findOne(filter) {
      const c = await col();
      return c ? strip(await c.findOne(filter) as T | null) : fallback.findOne(filter);
    },
    async find(filter, opts = {}) {
      const c = await col();
      if (!c) return fallback.find(filter, opts);
      let cur = c.find(filter);
      if (opts.sort) cur = cur.sort(opts.sort);
      if (opts.limit) cur = cur.limit(opts.limit);
      return (await cur.toArray()).map((d) => strip(d as T) as T);
    },
    async count(filter) {
      const c = await col();
      return c ? c.countDocuments(filter) : fallback.count(filter);
    },
    async update(filter, update, opts = {}) {
      const c = await col();
      if (!c) return fallback.update(filter, update, opts);
      const res = await c.findOneAndUpdate(filter, update, { returnDocument: 'after', upsert: !!opts.upsert });
      return strip(res as T | null);
    },
    async deleteOne(filter) {
      const c = await col();
      if (!c) return fallback.deleteOne(filter);
      return (await c.deleteOne(filter)).deletedCount > 0;
    },
  };
}
