import { createHash, randomBytes } from 'node:crypto';
import type { Collection } from 'mongodb';
import { config } from '../config.js';
import { hiveClient } from './hive.js';
import { MISSING_AUTHORITY_RE, contractCallOp, hiveAddress, magi, tokenContract } from './magi.js';
import { getLiveDb } from './mongoDb.js';
import { POINTS_START, applyPointsNow, pointsStore, setPointsExpiryOff } from './points.js';
import { KIND_CODE, ledgerStore, newRow, setPointsLogStage } from './pointsLedger.js';

/**
 * Channel points as the 3SP token on Magi (3SP-INTEGRATION guide).
 *
 *   earning   unchanged: counted in Mongo first (lib/points.ts), then minted
 *             in batches by the minter (@threespeak-pro, posting key). A
 *             batch id is deterministic and accepted once on chain, so a
 *             retry never mints twice. An account's first batch carries its
 *             welcome grant (`g`, POINTS_START) unless the airdrop gave it one.
 *   spending  burn first, then grant: a points boost or a prediction stake is
 *             the USER burning their own points (`burn` as hive:<user>),
 *             signed by @threespeak under the user's posting authority, or by
 *             the user's own wallet when that authority is missing. The boost
 *             or stake happens only once Magi confirms the burn.
 *   Mongo     still holds the balance the wallet shows: what is on chain plus
 *             earnings not minted yet. No expiry while the token is on.
 *
 * Off (Mongo-only, as before) until POINTS_TOKEN_CONTRACT is set AND the
 * one-time airdrop (scripts/airdrop-points.ts) has put the existing balances
 * on chain: before that a spend would find nothing to burn.
 */

/** Room under Hive's 8,192-byte custom_json limit for the envelope. */
const MINT_PAYLOAD_MAX_BYTES = 7000;
/** The contract's own row limit. */
const MINT_ROWS_MAX = 500;
const BURN_RC_LIMIT = 2000;
/** A sent batch with no answer from Magi after this is broadcast again (same id). */
const MINT_RESEND_MS = 10 * 60 * 1000;
/** How long a spend is followed before it is given up as unknown. */
const SPEND_GIVE_UP_MS = 60 * 60 * 1000;
/** How long a request waits for its burn before answering "pending". */
export const SPEND_WAIT_MS = Math.max(0, Number(process.env.POINTS_SPEND_WAIT_MS ?? 30_000) || 0);
const SPEND_POLL_MS = 1500;

// ── types ─────────────────────────────────────────────────────────────────

export type MintRow = [account: string, amount: string, kind: string];

export interface MintBatch {
  id: string;
  rows: MintRow[];
  /** The ledger rows this batch mints (their `mint` is this id). */
  ledgerIds: string[];
  total: number;
  status: 'new' | 'sent' | 'ok' | 'failed';
  tx?: string;
  sentAt?: number;
  tries: number;
  error?: string;
  createdAt: number;
}

export type SpendPurpose =
  | { type: 'boost'; room: string; message: string; displayName?: string; recipient: string; minUsd: number }
  | { type: 'stake'; room: string; poll: string; option: number }
  // `room` is the ledger ref here ('promote:<author>/<permlink>'), no stream.
  | { type: 'promote'; room: string; author: string; permlink: string; days: number };

export interface SpendDoc {
  id: string;
  user: string;
  amount: number;
  purpose: SpendPurpose;
  /** The burn's Hive txid (unique: one burn pays for one thing). */
  tx: string;
  signedBy: 'server' | 'user';
  status: 'sent' | 'ok' | 'failed' | 'refunded' | 'unknown';
  error?: string;
  /** What the completer returned (the boost event). */
  result?: unknown;
  /** Stakes: paid out or refunded with their prediction. */
  settled?: boolean;
  createdAt: number;
  doneAt?: number;
}

export interface TokenStore {
  airdropDone(): Promise<boolean>;
  markAirdropDone(info: Record<string, unknown>): Promise<void>;
  /** The batch not finished yet (new or sent), if any. */
  openBatch(): Promise<MintBatch | null>;
  saveBatch(b: MintBatch): Promise<void>;
  /** Accounts waiting for their welcome grant with no earning to carry it. */
  grantRequests(): Promise<string[]>;
  requestGrant(user: string): Promise<void>;
  clearGrantRequests(users: string[]): Promise<void>;
  /** False when that txid already paid for a spend. */
  insertSpend(s: SpendDoc): Promise<boolean>;
  /** Patch a spend only while its status is one of `from` (one writer wins). */
  updateSpend(id: string, from: SpendDoc['status'][], patch: Partial<SpendDoc>): Promise<SpendDoc | null>;
  getSpend(id: string): Promise<SpendDoc | null>;
  pendingSpends(limit: number): Promise<SpendDoc[]>;
  /** Confirmed stakes not paid out or refunded yet. */
  unsettledStakes(limit: number): Promise<SpendDoc[]>;
  /** Mark a prediction's stakes settled: the ones this call settled. */
  settleStakes(pollId: string): Promise<SpendDoc[]>;
  settleSpend(id: string): Promise<boolean>;
}

export function memoryTokenStore(): TokenStore & { batches: Map<string, MintBatch>; spends: Map<string, SpendDoc>; airdrop: boolean } {
  const batches = new Map<string, MintBatch>();
  const spends = new Map<string, SpendDoc>();
  const grants = new Set<string>();
  const s = {
    batches, spends, airdrop: false,
    async airdropDone() { return s.airdrop; },
    async markAirdropDone() { s.airdrop = true; },
    async openBatch() { return [...batches.values()].find((b) => b.status === 'new' || b.status === 'sent') ?? null; },
    async saveBatch(b: MintBatch) { batches.set(b.id, { ...b, rows: b.rows.map((r) => [...r] as MintRow) }); },
    async grantRequests() { return [...grants]; },
    async requestGrant(user: string) { grants.add(user); },
    async clearGrantRequests(users: string[]) { for (const u of users) grants.delete(u); },
    async insertSpend(d: SpendDoc) {
      if ([...spends.values()].some((x) => x.tx === d.tx)) return false;
      spends.set(d.id, { ...d });
      return true;
    },
    async updateSpend(id: string, from: SpendDoc['status'][], patch: Partial<SpendDoc>) {
      const cur = spends.get(id);
      if (!cur || !from.includes(cur.status)) return null;
      const next = { ...cur, ...patch };
      spends.set(id, next);
      return { ...next };
    },
    async getSpend(id: string) { const d = spends.get(id); return d ? { ...d } : null; },
    async pendingSpends(limit: number) { return [...spends.values()].filter((d) => d.status === 'sent').slice(0, limit).map((d) => ({ ...d })); },
    async unsettledStakes(limit: number) {
      return [...spends.values()].filter((d) => d.purpose.type === 'stake' && d.status === 'ok' && !d.settled).slice(0, limit).map((d) => ({ ...d }));
    },
    async settleStakes(pollId: string) {
      const out: SpendDoc[] = [];
      for (const d of spends.values()) {
        if (d.purpose.type === 'stake' && d.purpose.poll === pollId && d.status === 'ok' && !d.settled) { d.settled = true; out.push({ ...d }); }
      }
      return out;
    },
    async settleSpend(id: string) {
      const d = spends.get(id);
      if (!d || d.settled) return false;
      d.settled = true;
      return true;
    },
  };
  return s;
}

// ── Mongo store ───────────────────────────────────────────────────────────

interface StateDoc { _id: string; done?: boolean; at?: Date; info?: Record<string, unknown>; users?: string[] }

let cols: { state: Collection<StateDoc>; batches: Collection<MintBatch>; spends: Collection<SpendDoc> } | null = null;
async function collections() {
  if (cols) return cols;
  const db = await getLiveDb();
  if (!db) return null;
  const state = db.collection<StateDoc>('points-token');
  const batches = db.collection<MintBatch>('points-mint');
  const spends = db.collection<SpendDoc>('points-spends');
  await batches.createIndex({ id: 1 }, { unique: true }).catch(() => undefined);
  await batches.createIndex({ status: 1, createdAt: 1 }).catch(() => undefined);
  await spends.createIndex({ id: 1 }, { unique: true }).catch(() => undefined);
  await spends.createIndex({ tx: 1 }, { unique: true }).catch(() => undefined);
  await spends.createIndex({ status: 1, createdAt: 1 }).catch(() => undefined);
  await spends.createIndex({ 'purpose.poll': 1 }, { sparse: true }).catch(() => undefined);
  cols = { state, batches, spends };
  return cols;
}

const noId = { projection: { _id: 0 } } as const;

const mongoTokenStore: TokenStore = {
  async airdropDone() {
    const c = await collections();
    if (!c) return fallback.airdropDone();
    return !!(await c.state.findOne({ _id: 'airdrop' }))?.done;
  },
  async markAirdropDone(info) {
    const c = await collections();
    if (!c) return fallback.markAirdropDone(info);
    await c.state.updateOne({ _id: 'airdrop' }, { $set: { done: true, at: new Date(), info } }, { upsert: true });
  },
  async openBatch() {
    const c = await collections();
    if (!c) return fallback.openBatch();
    return c.batches.findOne({ status: { $in: ['new', 'sent'] } }, { ...noId, sort: { createdAt: 1 } }) as Promise<MintBatch | null>;
  },
  async saveBatch(b) {
    const c = await collections();
    if (!c) return fallback.saveBatch(b);
    await c.batches.replaceOne({ id: b.id }, b, { upsert: true });
  },
  async grantRequests() {
    const c = await collections();
    if (!c) return fallback.grantRequests();
    return (await c.state.findOne({ _id: 'grant-requests' }))?.users ?? [];
  },
  async requestGrant(user) {
    const c = await collections();
    if (!c) return fallback.requestGrant(user);
    await c.state.updateOne({ _id: 'grant-requests' }, { $addToSet: { users: user } }, { upsert: true });
  },
  async clearGrantRequests(users) {
    const c = await collections();
    if (!c) return fallback.clearGrantRequests(users);
    if (users.length) await c.state.updateOne({ _id: 'grant-requests' }, { $pull: { users: { $in: users } } });
  },
  async insertSpend(s) {
    const c = await collections();
    if (!c) return fallback.insertSpend(s);
    try { await c.spends.insertOne({ ...s }); return true; }
    catch (err) { if ((err as { code?: number }).code === 11000) return false; throw err; }
  },
  async updateSpend(id, from, patch) {
    const c = await collections();
    if (!c) return fallback.updateSpend(id, from, patch);
    return c.spends.findOneAndUpdate({ id, status: { $in: from } }, { $set: patch }, { ...noId, returnDocument: 'after' }) as Promise<SpendDoc | null>;
  },
  async getSpend(id) {
    const c = await collections();
    if (!c) return fallback.getSpend(id);
    return c.spends.findOne({ id }, noId) as Promise<SpendDoc | null>;
  },
  async pendingSpends(limit) {
    const c = await collections();
    if (!c) return fallback.pendingSpends(limit);
    return c.spends.find({ status: 'sent' }, noId).sort({ createdAt: 1 }).limit(limit).toArray() as Promise<SpendDoc[]>;
  },
  async unsettledStakes(limit) {
    const c = await collections();
    if (!c) return fallback.unsettledStakes(limit);
    return c.spends.find({ 'purpose.type': 'stake', status: 'ok', settled: { $ne: true } }, noId).sort({ createdAt: 1 }).limit(limit).toArray() as Promise<SpendDoc[]>;
  },
  async settleStakes(pollId) {
    const c = await collections();
    if (!c) return fallback.settleStakes(pollId);
    const out: SpendDoc[] = [];
    // One by one, so a stake is settled by exactly one caller.
    for (const d of await c.spends.find({ 'purpose.poll': pollId, status: 'ok', settled: { $ne: true } }, noId).toArray()) {
      const won = await c.spends.findOneAndUpdate({ id: d.id, settled: { $ne: true } }, { $set: { settled: true } }, noId);
      if (won) out.push(won as SpendDoc);
    }
    return out;
  },
  async settleSpend(id) {
    const c = await collections();
    if (!c) return fallback.settleSpend(id);
    return !!(await c.spends.findOneAndUpdate({ id, settled: { $ne: true } }, { $set: { settled: true } }, noId));
  },
};

const fallback = memoryTokenStore();
let store: TokenStore = mongoTokenStore;
export function setTokenStore(next: TokenStore): void { store = next; }
export function tokenStore(): TokenStore { return store; }

// ── on or off ─────────────────────────────────────────────────────────────

let enabledOverride: boolean | null = null;
/** Tests: force the token on or off (null: from config). */
export function setTokenEnabled(v: boolean | null): void { enabledOverride = v; liveCache = null; }

export function tokenConfigured(): boolean {
  return enabledOverride ?? !!tokenContract();
}

/** For clients: which contract and network the points live on. */
export function tokenInfo(): { contract: string; netId: string; symbol: '3SP' } {
  return { contract: tokenContract(), netId: config.POINTS_TOKEN_NET_ID, symbol: '3SP' };
}

let liveCache: { at: number; live: boolean } | null = null;
/** Configured and the airdrop is done: spends burn on chain, earnings mint. */
export async function tokenLive(now = Date.now()): Promise<boolean> {
  if (!tokenConfigured()) return false;
  if (liveCache?.live || (liveCache && now - liveCache.at < 30_000)) return liveCache.live;
  let live = false;
  try { live = await store.airdropDone(); } catch { live = false; }
  liveCache = { at: now, live };
  return live;
}

// The token keeps no expiry (owner decision 2026-11-22): a reset would be a
// burn nobody asked for. Off as soon as the token is configured, so the
// airdrop snapshot is not reset under it either.
setPointsExpiryOff(() => tokenConfigured());

// The points log changes id at the airdrop and holds new rows until then
// (lib/pointsLedger.ts logIdFor).
setPointsLogStage(async () => (!tokenConfigured() ? 'off' : (await tokenLive()) ? 'live' : 'waiting'));

// ── reads ─────────────────────────────────────────────────────────────────

/** The account's 3SP on chain. */
export async function chainBalance(user: string): Promise<number> {
  const [r] = await magi().read([{ action: 'balanceOf', payload: { account: hiveAddress(user) } }]);
  const bal = Number((r?.ret as { balance?: string } | null)?.balance);
  if (!r?.ok || !Number.isFinite(bal)) throw new Error(r?.err || 'balanceOf failed');
  return bal;
}

const granted = new Set<string>();
/** Which of these accounts already had their welcome grant (or airdrop). */
async function grantedOf(users: string[]): Promise<Set<string>> {
  const ask = users.filter((u) => !granted.has(u));
  if (ask.length) {
    const res = await magi().read(ask.map((u) => ({ action: 'hasGrant', payload: { account: hiveAddress(u) } })));
    ask.forEach((u, i) => {
      if (!res[i]?.ok) throw new Error(res[i]?.err || 'hasGrant failed');
      if ((res[i].ret as { granted?: boolean } | null)?.granted) granted.add(u);
    });
  }
  return new Set(users.filter((u) => granted.has(u)));
}

const knownAccounts = new Set<string>();
/** The accounts that exist on Hive: a well-formed name nobody registered
 *  passes the contract's address check and would get the points. */
export async function existingAccounts(users: string[]): Promise<Set<string>> {
  const ask = users.filter((u) => !knownAccounts.has(u));
  for (let i = 0; i < ask.length; i += 100) {
    const found = await hiveClient.database.getAccounts(ask.slice(i, i + 100));
    for (const a of found) knownAccounts.add(a.name);
  }
  return new Set(users.filter((u) => knownAccounts.has(u)));
}

// ── minting ───────────────────────────────────────────────────────────────

function minterKey(): string {
  const own = (config.POINTS_MINTER_POSTING_KEY ?? '').trim();
  if (own) return own;
  const sameAccount = (config.POINTS_MINTER_ACCOUNT ?? '').trim().toLowerCase() === (config.POINTS_LOG_ACCOUNT ?? '').trim().toLowerCase();
  return sameAccount ? (config.POINTS_LOG_POSTING_KEY ?? '').trim() : '';
}

function minter(): string {
  return (config.POINTS_MINTER_ACCOUNT ?? '').trim().toLowerCase();
}

/** A batch's id from its content: rebuilding the same rows gives the same id. */
export function mintBatchId(rows: MintRow[], ledgerIds: string[]): string {
  const h = createHash('sha256').update(JSON.stringify(rows)).update('|').update([...ledgerIds].sort().join(',')).digest('hex');
  return `m-${h.slice(0, 24)}`;
}

function mintPayload(id: string, rows: MintRow[]): Record<string, unknown> {
  return { id, to: rows };
}

function payloadBytes(id: string, rows: MintRow[]): number {
  // The payload travels as a JSON string inside the call's JSON.
  return Buffer.byteLength(JSON.stringify(contractCallOp(minter(), 'mintBatch', mintPayload(id, rows), 50_000).json));
}

const mintRcLimit = (rows: number) => Math.min(100_000, 1000 + 200 * rows);

/**
 * The next batch from the ledger: one row per account (its earnings since the
 * last batch, summed: RC is paid per row), its welcome grant first when it
 * has none, under the per-batch cap, what is left of today's cap and the
 * custom_json size. Accounts that do not exist on Hive are skipped for good.
 */
export async function buildMintBatch(caps: { room: number }, now = Date.now()): Promise<MintBatch | null> {
  const ledger = ledgerStore();
  const pending = await ledger.unminted(5000);
  const requested = await store.grantRequests();
  const byUser = new Map<string, { amount: number; kinds: Set<string>; ids: string[] }>();
  for (const r of pending) {
    const e = byUser.get(r.user) ?? { amount: 0, kinds: new Set<string>(), ids: [] };
    e.amount += r.delta;
    e.kinds.add(KIND_CODE[r.kind] ?? 'e');
    e.ids.push(r.id);
    byUser.set(r.user, e);
  }
  for (const u of requested) if (!byUser.has(u)) byUser.set(u, { amount: 0, kinds: new Set(), ids: [] });
  if (byUser.size === 0) return null;

  const users = [...byUser.keys()];
  const exists = await existingAccounts(users);
  const missing = users.filter((u) => !exists.has(u));
  for (const u of missing) {
    await ledger.setMint(byUser.get(u)!.ids, 'skip:account', null);
    byUser.delete(u);
  }
  if (missing.length) await store.clearGrantRequests(missing);
  const hasGrant = await grantedOf([...byUser.keys()]);
  // Grant requests already granted (by the airdrop or a batch) are done.
  const doneRequests = requested.filter((u) => hasGrant.has(u));
  if (doneRequests.length) await store.clearGrantRequests(doneRequests);

  const rows: MintRow[] = [];
  const ledgerIds: string[] = [];
  let total = 0;
  // Oldest earnings first (the ledger order), grant requests after them.
  for (const [user, e] of byUser) {
    const add: MintRow[] = [];
    if (!hasGrant.has(user)) add.push([hiveAddress(user), String(POINTS_START), 'g']);
    if (e.amount > 0) add.push([hiveAddress(user), String(e.amount), e.kinds.size === 1 ? [...e.kinds][0] : 'e']);
    if (add.length === 0) continue;
    const addTotal = add.reduce((n, r) => n + Number(r[1]), 0);
    if (total + addTotal > caps.room) {
      if (rows.length === 0) console.warn(`[Points] ${user} needs ${addTotal} in one batch, more than the ${caps.room} the caps allow now`);
      continue;
    }
    if (rows.length + add.length > MINT_ROWS_MAX) break;
    if (payloadBytes('m-000000000000000000000000', [...rows, ...add]) > MINT_PAYLOAD_MAX_BYTES) break;
    rows.push(...add);
    ledgerIds.push(...e.ids);
    total += addTotal;
  }
  if (rows.length === 0) return null;
  return { id: mintBatchId(rows, ledgerIds), rows, ledgerIds, total, status: 'new', tries: 0, createdAt: now };
}

async function sendBatch(b: MintBatch, now: number): Promise<void> {
  const key = minterKey();
  if (!key) return; // waits until a key is set
  try {
    const tx = await magi().call(minter(), key, 'mintBatch', mintPayload(b.id, b.rows), mintRcLimit(b.rows.length));
    await store.saveBatch({ ...b, status: 'sent', tx, sentAt: now, tries: b.tries + 1 });
  } catch (err) {
    // Not broadcast: tried again on the next tick, same id.
    console.warn(`[Points] mint batch ${b.id} broadcast failed:`, err instanceof Error ? err.message : err);
    await store.saveBatch({ ...b, tries: b.tries + 1, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Follow the open batch: done, failed (its rows go back to the queue), or
 *  broadcast again under the same id. True when it is finished. */
async function advanceBatch(b: MintBatch, now: number): Promise<boolean> {
  if (b.status === 'new' || !b.tx) {
    // Claim (again) before sending: a crash between saving the batch and
    // claiming its rows must not leave them free for another batch.
    await ledgerStore().setMint(b.ledgerIds, b.id, null);
    await sendBatch(b, now);
    return false;
  }
  const t = await magi().tx(b.tx);
  if (t?.status === 'ok' || (t?.status === 'failed' && /batch id already used/i.test(t.error ?? ''))) {
    // Applied (now, or by an earlier broadcast of the same id).
    for (const [acct, , kind] of b.rows) if (kind === 'g') granted.add(acct.replace(/^hive:/, ''));
    await store.clearGrantRequests(b.rows.filter((r) => r[2] === 'g').map((r) => r[0].replace(/^hive:/, '')));
    await store.saveBatch({ ...b, status: 'ok' });
    return true;
  }
  if (t?.status === 'failed') {
    // Nothing changed on chain and the id stays free. Release the rows; the
    // next batch is built from what the chain says now.
    const already = /welcome grant already given to hive:([a-z0-9.-]+)/i.exec(t.error ?? '');
    if (already) granted.add(already[1]);
    console.warn(`[Points] mint batch ${b.id} aborted: ${t.error}`);
    await ledgerStore().setMint(b.ledgerIds, null, b.id);
    await store.saveBatch({ ...b, status: 'failed', error: t.error });
    return true;
  }
  if (now - (b.sentAt ?? 0) > MINT_RESEND_MS) {
    // No answer: send the same id again. Either the first one applied and
    // this one aborts, or it never landed and this one mints. Never both.
    await sendBatch(b, now);
  }
  return false;
}

let lastBuild = 0;
/**
 * One step of the mint queue (every minute): follow the open batch, and when
 * none is open and POINTS_MINT_INTERVAL_MIN has passed (or someone waits for
 * a grant), build and send the next one.
 */
export async function mintTick(now = Date.now()): Promise<void> {
  if (!(await tokenLive(now))) return;
  const open = await store.openBatch();
  if (open && !(await advanceBatch(open, now))) return;
  const waitingGrant = (await store.grantRequests()).length > 0;
  const due = now - lastBuild >= config.POINTS_MINT_INTERVAL_MIN * 60_000;
  if (!due && !(waitingGrant && now - lastBuild >= 2 * 60_000)) return;
  if (!minterKey()) return;
  lastBuild = now;
  const [capsRead] = await magi().read([{ action: 'getMintCaps', payload: {} }]);
  const caps = capsRead?.ret as { perBatch?: string; perDay?: string; mintedToday?: string } | null;
  if (!capsRead?.ok || !caps) return;
  const room = Math.min(Number(caps.perBatch), Number(caps.perDay) - Number(caps.mintedToday));
  if (!Number.isFinite(room) || room <= 0) return; // today's cap is used up: next window
  const b = await buildMintBatch({ room }, now);
  if (!b) return;
  // Claim the rows first, then broadcast: after a crash the batch is resent
  // with the same id, never rebuilt from the same rows under another.
  await store.saveBatch(b);
  await ledgerStore().setMint(b.ledgerIds, b.id, null);
  await sendBatch(b, now);
}

// ── spending ──────────────────────────────────────────────────────────────

export class PointsSpendError extends Error {
  constructor(
    public status: number,
    public code: 'insufficient' | 'sign' | 'invalid' | 'used' | 'unavailable' | 'failed',
    message: string,
    public extra: Record<string, unknown> = {},
  ) { super(message); }
}

type Completer = (spend: SpendDoc) => Promise<unknown>;
const completers = new Map<SpendPurpose['type'], Completer>();
/** What a confirmed burn pays for (lib/boostListener.ts, lib/polls.ts). It
 *  throws when that cannot happen any more: the points are refunded. */
export function registerSpendCompleter(type: SpendPurpose['type'], fn: Completer): void {
  completers.set(type, fn);
}

/** The custom_json the user signs when the server may not sign for them. */
export function burnOp(user: string, amount: number) {
  return contractCallOp(user, 'burn', { amount: String(amount) }, BURN_RC_LIMIT);
}

function spendSignerKey(): string {
  return (config.POINTS_SPEND_SIGNER_POSTING_KEY ?? '').trim();
}

const signNeeded = (user: string, amount: number) => new PointsSpendError(
  428, 'sign', 'Confirm this spend in your wallet.', { op: ['custom_json', burnOp(user, amount)] },
);

async function insufficient(user: string, amount: number, onChain: number): Promise<PointsSpendError> {
  const unminted = await ledgerStore().unmintedTotal(user).catch(() => 0);
  let grantPending = false;
  if (onChain < amount) {
    // A new account's starting points are not on chain until its first
    // batch: ask for that grant now.
    try {
      if (!(await grantedOf([user])).has(user)) { await store.requestGrant(user); grantPending = true; }
    } catch { /* unknown: say nothing about it */ }
  }
  const arriving = unminted + (grantPending ? POINTS_START : 0);
  return new PointsSpendError(400, 'insufficient', arriving > 0
    ? `You have ${onChain.toLocaleString('en-US')} points ready to spend. ${arriving.toLocaleString('en-US')} more are on the way and arrive within the hour.`
    : 'You do not have that many points.', { onChain, unminted: arriving });
}

/** Does this burn on chain pay exactly for this spend? */
function burnMatches(t: { caller?: string; contract?: string; action?: string; payload?: string }, user: string, amount: number): boolean {
  if (t.caller !== hiveAddress(user) || t.contract !== tokenContract() || t.action !== 'burn') return false;
  try { return (JSON.parse(t.payload ?? '{}') as { amount?: unknown }).amount === String(amount); } catch { return false; }
}

export type SpendResult =
  | { state: 'done'; spend: SpendDoc; result: unknown; balance: number }
  | { state: 'pending'; spend: SpendDoc };

/**
 * Check one spend's burn and finish it: confirmed -> the Mongo balance and
 * ledger follow, then the completer runs (refund when it cannot); aborted ->
 * failed, nothing granted. 'pending' while Magi has no answer.
 */
export async function checkSpend(spend: SpendDoc, now = Date.now()): Promise<'pending' | 'ok' | 'failed' | 'refunded' | 'unknown'> {
  let t;
  try { t = await magi().tx(spend.tx); } catch { t = undefined; }
  if (!t || t.status === 'pending') {
    if (now - spend.createdAt > SPEND_GIVE_UP_MS) {
      await store.updateSpend(spend.id, ['sent'], { status: 'unknown', doneAt: now });
      console.warn(`[Points] spend ${spend.id} (${spend.tx}) unconfirmed after an hour: nothing granted`);
      return 'unknown';
    }
    return 'pending';
  }
  if (t.status === 'failed' || !burnMatches(t, spend.user, spend.amount)) {
    const error = t.status === 'failed' ? (t.error ?? 'failed') : 'That transaction is not this spend.';
    const done = await store.updateSpend(spend.id, ['sent'], { status: 'failed', error, doneAt: now });
    return done ? 'failed' : ((await store.getSpend(spend.id))?.status ?? 'failed') as 'failed';
  }
  // Confirmed: exactly one caller gets past this.
  const won = await store.updateSpend(spend.id, ['sent'], { status: 'ok', doneAt: now });
  if (!won) return ((await store.getSpend(spend.id))?.status ?? 'ok') as 'ok';
  await pointsStore().apply(new Map([[spend.user, -spend.amount]]));
  await ledgerStore().insert([newRow(spend.user, -spend.amount, 'spend', now, spend.purpose.room, 'burn')]).catch(() => undefined);
  const complete = completers.get(spend.purpose.type);
  try {
    const result = complete ? await complete(won) : undefined;
    await store.updateSpend(spend.id, ['ok'], { result: result ?? null });
    return 'ok';
  } catch (err) {
    // Paid but it cannot happen any more (the stream ended, the window
    // closed): the points come back, minted with the next batch.
    await refund(won, err instanceof Error ? err.message : String(err));
    return 'refunded';
  }
}

async function refund(spend: SpendDoc, reason: string): Promise<void> {
  if (!(await store.settleSpend(spend.id))) return;
  await store.updateSpend(spend.id, ['ok'], { status: 'refunded', error: reason });
  await applyPointsNow(new Map([[spend.user, spend.amount]]), 'refund', spend.purpose.room);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spend `amount` of the user's points on `purpose`, burn first.
 *
 * Without `burnTx` the server signs the burn as the user (@threespeak's
 * posting authority); when it may not, a 428 carries the op for the user's
 * wallet to sign, and the client sends the same request again with the txid
 * as `burnTx`. Waits up to `waitMs` for Magi; after that the spend finishes
 * in the background (spendTick) and the caller answers "pending".
 */
export async function spendOnChain(user: string, amount: number, purpose: SpendPurpose, opts: { burnTx?: string; waitMs?: number } = {}): Promise<SpendResult> {
  const u = user.toLowerCase();
  const amt = Math.floor(amount);
  let tx: string;
  let signedBy: SpendDoc['signedBy'];
  if (opts.burnTx) {
    const id = opts.burnTx.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(id)) throw new PointsSpendError(400, 'invalid', 'That is not a transaction id.');
    const t = await magi().tx(id).catch(() => null);
    // Not seen yet is fine (checked again when it is); a different call is not.
    if (t && !burnMatches(t, u, amt)) throw new PointsSpendError(400, 'invalid', 'That transaction is not this spend.');
    tx = id;
    signedBy = 'user';
  } else {
    let onChain: number;
    try { onChain = await chainBalance(u); } catch { throw new PointsSpendError(503, 'unavailable', 'Points cannot be spent right now. Try again in a minute.'); }
    if (onChain < amt) throw await insufficient(u, amt, onChain);
    const key = spendSignerKey();
    if (!key) throw signNeeded(u, amt);
    try {
      tx = await magi().call(u, key, 'burn', { amount: String(amt) }, BURN_RC_LIMIT);
    } catch (err) {
      // The user removed (or never gave) the posting authority: their wallet signs.
      if (MISSING_AUTHORITY_RE.test(err instanceof Error ? err.message : String(err))) throw signNeeded(u, amt);
      throw new PointsSpendError(503, 'unavailable', 'Points cannot be spent right now. Try again in a minute.');
    }
    signedBy = 'server';
  }
  const spend: SpendDoc = {
    id: `sp-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`,
    user: u, amount: amt, purpose, tx, signedBy, status: 'sent', createdAt: Date.now(),
  };
  if (!(await store.insertSpend(spend))) throw new PointsSpendError(409, 'used', 'That transaction already paid for something.');

  const deadline = Date.now() + (opts.waitMs ?? SPEND_WAIT_MS);
  for (;;) {
    const state = await checkSpend(spend);
    if (state === 'pending' && Date.now() < deadline) { await sleep(SPEND_POLL_MS); continue; }
    const now = (await store.getSpend(spend.id)) ?? spend;
    if (state === 'pending' || state === 'unknown') return { state: 'pending', spend: now };
    if (state === 'failed') {
      if (/insufficient balance/i.test(now.error ?? '')) throw await insufficient(u, amt, await chainBalance(u).catch(() => 0));
      throw new PointsSpendError(400, 'failed', now.error || 'The spend did not go through.');
    }
    if (state === 'refunded') throw new PointsSpendError(409, 'failed', `${now.error ?? 'It could not happen any more.'} Your points are back.`);
    return { state: 'done', spend: now, result: now.result, balance: await pointsStore().get(u) };
  }
}

/** The status of a spend for its owner (the client polls a pending one). */
export async function spendStatus(user: string, id: string): Promise<SpendDoc | null> {
  const s = await store.getSpend(id);
  return s && s.user === user.toLowerCase() ? s : null;
}

/**
 * A prediction ends: its confirmed stakes (the burns) are settled once.
 * `winner` null (cancelled, lapsed) or nobody on the winning side: every
 * stake comes back. Otherwise the winners split the pot by stake. Both are
 * minted with the next batch.
 */
export async function settlePrediction(pollId: string, winner: number | null): Promise<Map<string, number>> {
  const settled = await store.settleStakes(pollId);
  const stakes = new Map<string, { option: number; amount: number }>();
  for (const s of settled) {
    if (s.purpose.type !== 'stake') continue;
    const cur = stakes.get(s.user);
    stakes.set(s.user, { option: s.purpose.option, amount: (cur?.amount ?? 0) + s.amount });
  }
  let pot = 0;
  let winPool = 0;
  for (const s of stakes.values()) { pot += s.amount; if (s.option === winner) winPool += s.amount; }
  const out = new Map<string, number>();
  if (winner === null || winPool === 0) {
    for (const [u, s] of stakes) out.set(u, s.amount);
    if (out.size) await applyPointsNow(out, 'refund', pollId);
    return out;
  }
  for (const [u, s] of stakes) {
    if (s.option === winner) out.set(u, Math.floor((s.amount * pot) / winPool));
  }
  if (out.size) await applyPointsNow(out, 'prediction', pollId);
  return out;
}

let stakeLive: (pollId: string) => boolean = () => true;
/** lib/polls.ts says which predictions are still running. */
export function setStakeLiveCheck(fn: (pollId: string) => boolean): void { stakeLive = fn; }

/**
 * Burned stakes whose prediction is gone (a restart loses running
 * predictions; a sweep ends them) come back, minted with the next batch.
 */
export async function refundOrphanStakes(now = Date.now()): Promise<number> {
  let n = 0;
  for (const s of await store.unsettledStakes(200)) {
    if (s.purpose.type !== 'stake' || stakeLive(s.purpose.poll) || now - s.createdAt < 60_000) continue;
    await refund(s, 'The prediction ended without a result.');
    n += 1;
  }
  return n;
}

/** Follow the pending spends (every 10 seconds) and refund orphaned stakes. */
export async function spendTick(now = Date.now()): Promise<void> {
  if (!tokenConfigured()) return;
  for (const s of await store.pendingSpends(50)) await checkSpend(s, now).catch(() => undefined);
  await refundOrphanStakes(now).catch(() => 0);
}

let mintTimer: ReturnType<typeof setInterval> | null = null;
let spendTimer: ReturnType<typeof setInterval> | null = null;
/** The mint queue every minute and the spend follower every 10 seconds. */
export function startPointsToken(log: (msg: string) => void = console.log): void {
  if (!tokenConfigured() || mintTimer) return;
  if (!minterKey()) log('[Points] token on but no minter posting key: earnings wait in Mongo');
  if (!spendSignerKey()) log('[Points] token on but no spend signer key: every spend is signed by the user');
  void tokenLive().then((live) => { if (!live) log('[Points] token configured, waiting for the airdrop (scripts/airdrop-points.ts)'); });
  mintTimer = setInterval(() => { void mintTick().catch((err) => log(`[Points] mint tick failed: ${err instanceof Error ? err.message : err}`)); }, 60_000);
  mintTimer.unref?.();
  spendTimer = setInterval(() => { void spendTick(); }, 10_000);
  spendTimer.unref?.();
}

/** Tests. */
export function resetPointsToken(): void {
  granted.clear();
  knownAccounts.clear();
  lastBuild = 0;
  liveCache = null;
}
