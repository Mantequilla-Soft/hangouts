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
 *
 * With the 3SP token the log id changes at the airdrop (`3speak_points` before,
 * `3sp_points` after, see lib/pointsLog.ts), so replaying the old log gives the
 * airdrop and nothing after it is counted twice. From setting the token
 * contract until the airdrop is done nothing new is logged: a row logged then
 * could not tell which side of the airdrop it is on.
 */

export { KIND_CODE, POINTS_LOG_ID, POINTS_TOKEN_LOG_ID, decodePointsLog, encodePointsLog, replayPointsLog, type LoggedMovement, type PointsKind } from './pointsLog.js';
import { POINTS_LOG_ID, POINTS_TOKEN_LOG_ID, encodePointsLog, type PointsKind } from './pointsLog.js';

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
  /**
   * The 3SP token (lib/pointsToken.ts): the mint batch that put an earning on
   * Magi. Null/absent: not minted yet (only rows with delta > 0 ever are).
   * `pre`: from before the token (the airdrop covers it). `burn`: a spend the
   * user burned on Magi. `skip:<why>`: never minted (no such Hive account).
   */
  mint?: string | null;
}

export function newRow(user: string, delta: number, kind: PointsKind, at: number, ref?: string, mint?: string): LedgerRow {
  return {
    id: `${at.toString(36)}-${randomBytes(5).toString('hex')}`, user, delta, kind, ...(ref ? { ref } : {}), at, tx: null,
    ...(mint ? { mint } : {}),
  };
}

// ── store ─────────────────────────────────────────────────────────────────

export interface LedgerStore {
  insert(rows: LedgerRow[]): Promise<void>;
  /** Rows not on the chain yet, oldest first. */
  unlogged(limit: number): Promise<LedgerRow[]>;
  markLogged(ids: string[], tx: string): Promise<void>;
  /** A user's rows, newest first, older than `before` (ms) when given. */
  history(user: string, limit: number, before?: number): Promise<LedgerRow[]>;
  /** Earnings (delta > 0) not on Magi yet, oldest first. */
  unminted(limit: number): Promise<LedgerRow[]>;
  /** Set rows' mint claim; `onlyFrom` limits it to rows whose claim is that
   *  now (null: unclaimed), so two writers never take the same row. */
  setMint(ids: string[], mint: string | null, onlyFrom?: string | null): Promise<void>;
  /** A user's earnings not on Magi yet (shown as "on the way"). */
  unmintedTotal(user: string): Promise<number>;
  /** When the user's oldest row of `kind` is from (ms), or null. */
  earliest(user: string, kind: PointsKind): Promise<number | null>;
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
    async unminted(limit) {
      return rows.filter((r) => r.delta > 0 && !r.mint).sort((a, b) => a.at - b.at).slice(0, limit).map((r) => ({ ...r }));
    },
    async setMint(ids, mint, onlyFrom) {
      for (const r of rows) {
        if (!ids.includes(r.id)) continue;
        if (onlyFrom !== undefined && (r.mint ?? null) !== onlyFrom) continue;
        r.mint = mint;
      }
    },
    async unmintedTotal(user) {
      return rows.filter((r) => r.user === user && r.delta > 0 && !r.mint).reduce((n, r) => n + r.delta, 0);
    },
    async earliest(user, kind) {
      const ats = rows.filter((r) => r.user === user && r.kind === kind).map((r) => r.at);
      return ats.length ? Math.min(...ats) : null;
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
  // The mint queue: earnings not on Magi yet, oldest first.
  await c.createIndex({ mint: 1, at: 1 }, { partialFilterExpression: { delta: { $gt: 0 } } }).catch(() => undefined);
  // The chain keeps them for good; the wallet's history needs about a year.
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
  col = c;
  return c;
}

const toRow = (d: LedgerDoc): LedgerRow => ({
  id: d.id, user: d.user, delta: d.delta, kind: d.kind, ...(d.ref ? { ref: d.ref } : {}), at: d.at.getTime(), tx: d.tx ?? null,
  ...(d.mint ? { mint: d.mint } : {}),
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
  async unminted(limit) {
    const c = await collection();
    if (!c) return fallback.unminted(limit);
    // `mint: null` also matches rows without the field.
    const docs = await c.find({ mint: null, delta: { $gt: 0 } }, { projection: { _id: 0 } }).sort({ at: 1 }).limit(limit).toArray();
    return docs.map(toRow);
  },
  async setMint(ids, mint, onlyFrom) {
    const c = await collection();
    if (!c) return fallback.setMint(ids, mint, onlyFrom);
    if (ids.length === 0) return;
    await c.updateMany({ id: { $in: ids }, ...(onlyFrom !== undefined ? { mint: onlyFrom } : {}) }, { $set: { mint } });
  },
  async unmintedTotal(user) {
    const c = await collection();
    if (!c) return fallback.unmintedTotal(user);
    const [r] = await c.aggregate<{ n: number }>([
      { $match: { user, mint: null, delta: { $gt: 0 } } },
      { $group: { _id: null, n: { $sum: '$delta' } } },
    ]).toArray();
    return r?.n ?? 0;
  },
  async earliest(user, kind) {
    const c = await collection();
    if (!c) return fallback.earliest(user, kind);
    const [d] = await c.find({ user, kind }, { projection: { at: 1 } }).sort({ at: 1 }).limit(1).toArray();
    return d ? d.at.getTime() : null;
  },
};

const fallback = memoryLedgerStore();
let ledger: LedgerStore = mongoLedger;

export function setLedgerStore(next: LedgerStore): void { ledger = next; }
export function ledgerStore(): LedgerStore { return ledger; }

// ── chain writer ──────────────────────────────────────────────────────────

/** Broadcasts one payload under custom_json `id`, resolving the transaction id. */
export type PointsLogWriter = (json: string, id: string) => Promise<string>;

let writer: PointsLogWriter | null = null;
export function setPointsLogWriter(next: PointsLogWriter | null): void { writer = next; }

/** Where the 3SP token is: `off` (not configured), `waiting` (configured, the
 *  airdrop not done yet) or `live`. Set by lib/pointsToken.ts. */
export type PointsLogStage = 'off' | 'waiting' | 'live';
let stageOf: () => Promise<PointsLogStage> = async () => 'off';
export function setPointsLogStage(next: () => Promise<PointsLogStage>): void { stageOf = next; }

/** The custom_json id a row is logged under, or null to hold it for now. */
export function logIdFor(row: Pick<LedgerRow, 'mint'>, stage: PointsLogStage): string | null {
  // Covered by the airdrop, or no token at all: the old log.
  if (row.mint === 'pre' || stage === 'off') return POINTS_LOG_ID;
  return stage === 'live' ? POINTS_TOKEN_LOG_ID : null;
}

/**
 * Put the rows not on the chain yet there, a few payloads at a time (a long
 * backlog drains over the next batches). No writer configured: they wait.
 */
export async function logPendingToChain(maxPayloads = 20): Promise<number> {
  if (!writer) return 0;
  // Unsure where the token is: hold the rows, never guess a log.
  const stage = await stageOf().catch((): PointsLogStage => 'waiting');
  const rows = await ledger.unlogged(maxPayloads * 60);
  const byLog = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const id = logIdFor(r, stage);
    if (id) byLog.set(id, [...(byLog.get(id) ?? []), r]);
  }
  let sent = 0;
  for (const [id, list] of byLog) {
    for (const { json, ids } of encodePointsLog(list)) {
      if (sent >= maxPayloads) return sent;
      let tx: string;
      try { tx = await writer(json, id); } catch { return sent; } // retried with the next batch
      await ledger.markLogged(ids, tx);
      sent += 1;
    }
  }
  return sent;
}
