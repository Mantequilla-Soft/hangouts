import { randomBytes } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getLiveDb } from './mongoDb.js';

/**
 * Every points movement, kept twice:
 *
 *   points-ledger   Mongo rows the wallet's history reads (newest first).
 *   Hive            one custom_json `3speak_points` per batch, signed by the
 *                   points account (@threespeak-pro), so every balance can be
 *                   rebuilt from the chain alone (replayPointsLog below).
 *
 * The chain is public: watching and chat rows carry no stream, or anyone could
 * read a viewer's viewing history there. Boosts, raids and battles name the
 * other side (public anyway). A row is written to Mongo first and logged to
 * the chain on the next batch; a failed broadcast is retried with the next one.
 */

export { POINTS_LOG_ID, decodePointsLog, encodePointsLog, replayPointsLog, type LoggedMovement, type PointsKind } from './pointsLog.js';
import { encodePointsLog, type PointsKind } from './pointsLog.js';

const LEDGER_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export interface LedgerRow {
  id: string;
  user: string;
  delta: number;
  kind: PointsKind;
  /** The stream, poll or other account it was for, when that may be public. */
  ref?: string;
  /** ms epoch. */
  at: number;
  /** The Hive transaction that logged it; null until then. */
  tx: string | null;
}

export function newRow(user: string, delta: number, kind: PointsKind, at: number, ref?: string): LedgerRow {
  return { id: `${at.toString(36)}-${randomBytes(5).toString('hex')}`, user, delta, kind, ...(ref ? { ref } : {}), at, tx: null };
}

// ── store ─────────────────────────────────────────────────────────────────

export interface LedgerStore {
  insert(rows: LedgerRow[]): Promise<void>;
  /** Rows not on the chain yet, oldest first. */
  unlogged(limit: number): Promise<LedgerRow[]>;
  markLogged(ids: string[], tx: string): Promise<void>;
  /** A user's rows, newest first, older than `before` (ms) when given. */
  history(user: string, limit: number, before?: number): Promise<LedgerRow[]>;
}

export function memoryLedgerStore(): LedgerStore & { rows: LedgerRow[] } {
  const rows: LedgerRow[] = [];
  return {
    rows,
    async insert(add) { rows.push(...add.map((r) => ({ ...r }))); },
    async unlogged(limit) { return rows.filter((r) => !r.tx).sort((a, b) => a.at - b.at).slice(0, limit); },
    async markLogged(ids, tx) { for (const r of rows) if (ids.includes(r.id)) r.tx = tx; },
    async history(user, limit, before) {
      return rows.filter((r) => r.user === user && (before === undefined || r.at < before))
        .sort((a, b) => b.at - a.at).slice(0, limit);
    },
  };
}

interface LedgerDoc extends Omit<LedgerRow, 'at'> { at: Date; expiresAt: Date }

let col: Collection<LedgerDoc> | null = null;
async function collection(): Promise<Collection<LedgerDoc> | null> {
  if (col) return col;
  const db = await getLiveDb();
  if (!db) return null;
  const c = db.collection<LedgerDoc>('points-ledger');
  await c.createIndex({ id: 1 }, { unique: true }).catch(() => undefined);
  await c.createIndex({ user: 1, at: -1 }).catch(() => undefined);
  await c.createIndex({ tx: 1, at: 1 }).catch(() => undefined);
  // The chain keeps them for good; the wallet's history needs about a year.
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
  col = c;
  return c;
}

const toRow = (d: LedgerDoc): LedgerRow => ({
  id: d.id, user: d.user, delta: d.delta, kind: d.kind, ...(d.ref ? { ref: d.ref } : {}), at: d.at.getTime(), tx: d.tx ?? null,
});

const mongoLedger: LedgerStore = {
  async insert(rows) {
    const c = await collection();
    if (!c) return fallback.insert(rows);
    if (rows.length === 0) return;
    await c.insertMany(rows.map((r) => ({ ...r, at: new Date(r.at), expiresAt: new Date(r.at + LEDGER_TTL_MS) })), { ordered: false });
  },
  async unlogged(limit) {
    const c = await collection();
    if (!c) return fallback.unlogged(limit);
    const docs = await c.find({ tx: null }, { projection: { _id: 0 } }).sort({ at: 1 }).limit(limit).toArray();
    return docs.map(toRow);
  },
  async markLogged(ids, tx) {
    const c = await collection();
    if (!c) return fallback.markLogged(ids, tx);
    await c.updateMany({ id: { $in: ids } }, { $set: { tx } });
  },
  async history(user, limit, before) {
    const c = await collection();
    if (!c) return fallback.history(user, limit, before);
    const filter = before === undefined ? { user } : { user, at: { $lt: new Date(before) } };
    const docs = await c.find(filter, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
    return docs.map(toRow);
  },
};

const fallback = memoryLedgerStore();
let ledger: LedgerStore = mongoLedger;

export function setLedgerStore(next: LedgerStore): void { ledger = next; }
export function ledgerStore(): LedgerStore { return ledger; }

// ── chain writer ──────────────────────────────────────────────────────────

/** Broadcasts one payload, resolving the transaction id. */
export type PointsLogWriter = (json: string) => Promise<string>;

let writer: PointsLogWriter | null = null;
export function setPointsLogWriter(next: PointsLogWriter | null): void { writer = next; }

/**
 * Put the rows not on the chain yet there, a few payloads at a time (a long
 * backlog drains over the next batches). No writer configured: they wait.
 */
export async function logPendingToChain(maxPayloads = 20): Promise<number> {
  if (!writer) return 0;
  const rows = await ledger.unlogged(maxPayloads * 60);
  let sent = 0;
  for (const { json, ids } of encodePointsLog(rows).slice(0, maxPayloads)) {
    let tx: string;
    try { tx = await writer(json); } catch { break; } // retried with the next batch
    await ledger.markLogged(ids, tx);
    sent += 1;
  }
  return sent;
}
