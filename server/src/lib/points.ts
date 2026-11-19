import type { Collection } from 'mongodb';
import { ParticipantInfo_Kind } from '@livekit/protocol';
import { getLiveDb } from './mongoDb.js';
import { ledgerStore, logPendingToChain, newRow, type LedgerRow, type PointsKind } from './pointsLedger.js';

/**
 * Channel points: ONE balance per Hive account across every stream (not per
 * channel). Not money: they cannot be bought, sold or paid out.
 *
 * Earned (the server counts it, clients never claim points):
 *   watching    10 a minute, everyone signed in and connected to a live stream
 *               (WebRTC or HLS), once per account however many tabs
 *   chat        1 per word, at most 20 a message and 50 a minute
 *   streaming   100 a minute while live with at least one viewer
 *   raid        500 to the raider, battle 500 to both hosts when it runs its
 *               full time; once an hour for the same two streamers
 *   boosting    100 plus 100 per HBD of value, at most 2,000 a boost
 * Spent:
 *   predictions (stakes, lib/polls.ts) and points boosts (POINTS_BOOST_MIN and up)
 *
 * A balance nobody touched for POINTS_TTL_DAYS (90, a quarter) starts again at
 * POINTS_START: come back, or stream, to keep it. The reset is a movement of
 * its own (kind `expire`), in the history and on the chain like any other.
 *
 * Every movement is also a ledger row and, batched, a custom_json on Hive
 * (lib/pointsLedger.ts), so balances can be rebuilt from the chain.
 */

export const POINTS_START = Math.max(1, Number(process.env.POINTS_START ?? 1000) || 1000);
export const POINTS_TTL_DAYS = Math.max(1, Number(process.env.POINTS_TTL_DAYS ?? 90) || 90);
const POINTS_TTL_MS = POINTS_TTL_DAYS * 24 * 60 * 60 * 1000;

export const WATCH_POINTS_PER_MIN = 10;
export const STREAM_POINTS_PER_MIN = 100;
export const CHAT_POINTS_PER_MESSAGE_MAX = 20;
export const CHAT_POINTS_PER_MIN_MAX = 50;
export const RAID_POINTS = 500;
export const BATTLE_POINTS = 500;
/** One raid or battle reward per pair of streamers in this window. */
export const PAIR_REWARD_GAP_MS = 60 * 60 * 1000;
export const BOOST_POINTS_BASE = 100;
export const BOOST_POINTS_PER_HBD = 100;
export const BOOST_POINTS_MAX = 2000;
/** A points boost costs at least this (a bit over 4 hours of watching). */
export const POINTS_BOOST_MIN = Math.max(1, Number(process.env.POINTS_BOOST_MIN ?? 2500) || 2500);
export const POINTS_BOOST_MAX = 1_000_000;
/** What a points boost is worth in HBD for the alert's size and how long it
 *  stays, and for the host's "minimum to show": 10,000 points like 1 HBD. */
export const POINTS_PER_HBD = 10_000;

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/** A Hive account name, or null for guests, the OBS ingress and the rest. */
export function pointsAccount(identity: string | null | undefined): string | null {
  // The host's second device watches as `<host>~watch`: the same person.
  const id = (identity ?? '').toLowerCase().replace(/~watch$/, '');
  // Guests (`guest-<id>`) and the OBS ingress/battle links (`obs-...`) would
  // pass for Hive names.
  if (id.startsWith('guest-') || id.startsWith('obs-')) return null;
  return ACCOUNT_RE.test(id) ? id : null;
}

/** Points for a boost worth `hbd`. */
export function boostReward(hbd: number): number {
  if (!Number.isFinite(hbd) || hbd <= 0) return 0;
  return Math.min(BOOST_POINTS_MAX, Math.round(BOOST_POINTS_BASE + BOOST_POINTS_PER_HBD * hbd));
}

/** Words in a chat line, as points (before the per-minute cap). */
export function chatWords(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return Math.min(CHAT_POINTS_PER_MESSAGE_MAX, words);
}

// ── store ─────────────────────────────────────────────────────────────────

export interface PointsStore {
  get(user: string): Promise<number>;
  /** The balance and when it expires (null: no row yet, or no Mongo). */
  details(user: string): Promise<{ balance: number; expiresAt: Date | null }>;
  /** Add `delta` to each user's balance (starting from POINTS_START, never below 0). */
  apply(deltas: Map<string, number>): Promise<void>;
  /** Take `amount` if the balance covers it: the balance left, or null. */
  spend(user: string, amount: number): Promise<number | null>;
  /** Remove balances untouched since their expiry, at most `limit`: who, and
   *  what they had. */
  expire(now: number, limit: number): Promise<Array<{ user: string; balance: number }>>;
}

interface PointsDoc { user: string; balance: number; updatedAt: Date; expiresAt: Date }

let col: Collection<PointsDoc> | null = null;

async function collection(): Promise<Collection<PointsDoc> | null> {
  if (col) return col;
  const db = await getLiveDb();
  if (!db) return null;
  // `points`, not the old per-channel `stream-points` (whose rows expire on
  // their own TTL). No TTL here: an expiry is a logged movement (expirePoints).
  const c = db.collection<PointsDoc>('points');
  await c.createIndex({ user: 1 }, { unique: true }).catch(() => undefined);
  await c.createIndex({ expiresAt: 1 }).catch(() => undefined);
  col = c;
  return c;
}

/** In memory: tests, and a server with no Mongo configured. */
export function memoryPointsStore(): PointsStore & { balances: Map<string, number>; expires: Map<string, number> } {
  const balances = new Map<string, number>();
  const expires = new Map<string, number>();
  const touch = (user: string) => expires.set(user, Date.now() + POINTS_TTL_MS);
  return {
    balances,
    expires,
    async get(user) { return balances.get(user) ?? POINTS_START; },
    async details(user) {
      const at = expires.get(user);
      return { balance: balances.get(user) ?? POINTS_START, expiresAt: balances.has(user) && at ? new Date(at) : null };
    },
    async apply(deltas) {
      for (const [user, d] of deltas) {
        balances.set(user, Math.max(0, (balances.get(user) ?? POINTS_START) + d));
        touch(user);
      }
    },
    async spend(user, amount) {
      const cur = balances.get(user) ?? POINTS_START;
      touch(user);
      if (cur < amount) return null;
      balances.set(user, cur - amount);
      return cur - amount;
    },
    async expire(now, limit) {
      const out: Array<{ user: string; balance: number }> = [];
      for (const [user, at] of expires) {
        if (out.length >= limit) break;
        if (at > now || !balances.has(user)) continue;
        out.push({ user, balance: balances.get(user)! });
        balances.delete(user);
        expires.delete(user);
      }
      return out;
    },
  };
}

const mongoStore: PointsStore = {
  async get(user) {
    const c = await collection();
    if (!c) return fallback.get(user);
    const doc = await c.findOne({ user }, { projection: { balance: 1 } });
    return doc ? doc.balance : POINTS_START;
  },
  async details(user) {
    const c = await collection();
    if (!c) return fallback.details(user);
    const doc = await c.findOne({ user }, { projection: { balance: 1, expiresAt: 1 } });
    return doc ? { balance: doc.balance, expiresAt: doc.expiresAt ?? null } : { balance: POINTS_START, expiresAt: null };
  },
  async apply(deltas) {
    const c = await collection();
    if (!c) return fallback.apply(deltas);
    if (deltas.size === 0) return;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + POINTS_TTL_MS);
    // One bulk write. The pipeline update starts an account without a row at
    // POINTS_START and never lets a balance go below zero.
    await c.bulkWrite([...deltas].map(([user, delta]) => ({
      updateOne: {
        filter: { user },
        update: [{
          $set: {
            user, updatedAt: now, expiresAt,
            balance: { $max: [0, { $add: [{ $ifNull: ['$balance', POINTS_START] }, delta] }] },
          },
        }],
        upsert: true,
      },
    })), { ordered: false });
  },
  async spend(user, amount) {
    const c = await collection();
    if (!c) return fallback.spend(user, amount);
    const now = new Date();
    // One atomic step, so two quick taps cannot both spend the same points:
    // take it only when the balance covers it, and read what it was before.
    const before = await c.findOneAndUpdate({ user }, [{
      $set: {
        user, updatedAt: now, expiresAt: new Date(now.getTime() + POINTS_TTL_MS),
        balance: {
          $let: {
            vars: { cur: { $ifNull: ['$balance', POINTS_START] } },
            in: { $cond: [{ $gte: ['$$cur', amount] }, { $subtract: ['$$cur', amount] }, '$$cur'] },
          },
        },
      },
    }], { upsert: true, returnDocument: 'before', projection: { balance: 1 } });
    const had = before?.balance ?? POINTS_START;
    return had >= amount ? had - amount : null;
  },
  async expire(now, limit) {
    const c = await collection();
    if (!c) return fallback.expire(now, limit);
    const cutoff = new Date(now);
    const due = await c.find({ expiresAt: { $lte: cutoff } }, { projection: { user: 1 } }).limit(limit).toArray();
    const out: Array<{ user: string; balance: number }> = [];
    for (const { user } of due) {
      // Only if still untouched: an earning a moment ago moved its expiry on.
      const gone = await c.findOneAndDelete({ user, expiresAt: { $lte: cutoff } }, { projection: { balance: 1 } });
      if (gone) out.push({ user, balance: gone.balance });
    }
    return out;
  },
};

const fallback = memoryPointsStore();
let store: PointsStore = mongoStore;

/** Tests swap the store. */
export function setPointsStore(next: PointsStore): void {
  store = next;
}

export function pointsStore(): PointsStore {
  return store;
}

/** For the wallet: the balance and when it expires (public, like a profile stat). */
export function pointsDetails(user: string): Promise<{ balance: number; expiresAt: Date | null }> {
  return store.details(user.toLowerCase());
}

export function pointsBalance(user: string): Promise<number> {
  return store.get(user.toLowerCase());
}

/** A user's points history for the wallet, newest first. */
export function pointsHistory(user: string, limit: number, before?: number): Promise<LedgerRow[]> {
  return ledgerStore().history(user.toLowerCase(), limit, before);
}

/** Spend points (a points boost for `ref`, the stream). The balance left, or
 *  null when too few. The movement goes into the ledger right away. */
export async function spendPoints(user: string, amount: number, ref?: string): Promise<number | null> {
  const u = user.toLowerCase();
  const left = await store.spend(u, amount);
  if (left !== null) await ledgerStore().insert([newRow(u, -amount, 'spend', Date.now(), ref)]).catch(() => undefined);
  return left;
}

/** Move points now, with their ledger rows (a prediction's payouts, a refund). */
export async function applyPointsNow(deltas: Map<string, number>, kind: PointsKind, ref?: string): Promise<void> {
  if (deltas.size === 0) return;
  await store.apply(deltas);
  const at = Date.now();
  await ledgerStore().insert([...deltas].map(([u, d]) => newRow(u, d, kind, at, ref))).catch(() => undefined);
}

// Earnings wait here and are paid out with the next batch (POINTS_BATCH_MIN):
// one balance write and one ledger row per account and kind, then logged to
// the chain. A restart loses at most one batch of earnings, never a spend.
const pending = new Map<string, { user: string; kind: PointsKind; ref?: string; delta: number }>();

function earn(user: string, delta: number, kind: PointsKind, ref?: string): void {
  if (delta === 0) return;
  const k = `${user}|${kind}|${ref ?? ''}`;
  const cur = pending.get(k);
  if (cur) cur.delta += delta;
  else pending.set(k, { user, kind, ...(ref ? { ref } : {}), delta });
}

/**
 * Reset the balances untouched for POINTS_TTL_DAYS to POINTS_START, each as an
 * `expire` movement (delta: what it takes to get back to the start), so the
 * wallet history and the chain both show it. A balance already at the start
 * just goes, with nothing to log.
 */
export async function expirePoints(now = Date.now(), limit = 500): Promise<number> {
  const gone = await store.expire(now, limit);
  const rows = gone.filter((g) => g.balance !== POINTS_START).map((g) => newRow(g.user, POINTS_START - g.balance, 'expire', now));
  if (rows.length) await ledgerStore().insert(rows);
  return gone.length;
}

/** Pay out the waiting earnings, then log what is not on the chain yet
 *  (`chain: false` on shutdown, when there is no time to wait for Hive). */
export async function flushPoints(now = Date.now(), { chain = true }: { chain?: boolean } = {}): Promise<void> {
  if (pending.size > 0) {
    const batch = [...pending.values()];
    pending.clear();
    const deltas = new Map<string, number>();
    for (const e of batch) deltas.set(e.user, (deltas.get(e.user) ?? 0) + e.delta);
    try {
      await store.apply(deltas);
      await ledgerStore().insert(batch.map((e) => newRow(e.user, e.delta, e.kind, now, e.ref)));
    } catch { /* this batch's earnings are lost: points never break a stream */ }
  }
  if (chain) {
    await expirePoints(now).catch(() => 0);
    await logPendingToChain().catch(() => 0);
  }
}

// ── earning ───────────────────────────────────────────────────────────────

const chatMinute = new Map<string, { minute: number; earned: number }>();
const lastPairReward = new Map<string, number>();

/** A chat line from a signed-in account: 1 point a word, capped. */
export function earnForChat(identity: string, text: string, now = Date.now()): number {
  const user = pointsAccount(identity);
  if (!user) return 0;
  const minute = Math.floor(now / 60_000);
  const seen = chatMinute.get(user);
  const earned = seen && seen.minute === minute ? seen.earned : 0;
  const pts = Math.min(chatWords(text), CHAT_POINTS_PER_MIN_MAX - earned);
  if (pts <= 0) return 0;
  chatMinute.set(user, { minute, earned: earned + pts });
  // No stream on the record: the chain must not show where someone chats.
  earn(user, pts, 'chat');
  return pts;
}

/** A boost worth `hbd` from `sender` to the stream `room`. */
export function earnForBoost(sender: string, hbd: number, room?: string): number {
  const user = pointsAccount(sender);
  const pts = boostReward(hbd);
  if (!user || pts <= 0) return 0;
  earn(user, pts, 'boost', room);
  return pts;
}

function pairKey(kind: string, a: string, b: string): string {
  return `${kind}|${[a, b].sort().join('|')}`;
}

/** Once an hour per pair: two friends raiding each other back and forth earn it once. */
function pairDue(kind: string, a: string, b: string, now: number): boolean {
  const k = pairKey(kind, a, b);
  const last = lastPairReward.get(k);
  if (last !== undefined && now - last < PAIR_REWARD_GAP_MS) return false;
  lastPairReward.set(k, now);
  return true;
}

/** A raid landed: the raider earns RAID_POINTS. */
export function earnForRaid(raider: string, target: string, now = Date.now()): number {
  const a = pointsAccount(raider);
  const b = pointsAccount(target);
  if (!a || !b || a === b || !pairDue('raid', a, b, now)) return 0;
  earn(a, RAID_POINTS, 'raid', b);
  return RAID_POINTS;
}

/** A battle ran its full time: both hosts earn BATTLE_POINTS. */
export function earnForBattle(hostA: string, hostB: string, now = Date.now()): number {
  const a = pointsAccount(hostA);
  const b = pointsAccount(hostB);
  if (!a || !b || a === b || !pairDue('battle', a, b, now)) return 0;
  earn(a, BATTLE_POINTS, 'battle', b);
  earn(b, BATTLE_POINTS, 'battle', a);
  return BATTLE_POINTS;
}

interface SampleParticipant {
  identity: string;
  kind?: number;
  tracks?: unknown[];
}

/**
 * One minute's watching and streaming points from what is live now. Pure:
 * `rooms` is every room with its metadata and participants.
 */
export function minuteRewards(
  rooms: Array<{ metadata?: string; participants: SampleParticipant[] }>,
): Map<string, { points: number; kind: 'watch' | 'stream' }> {
  const viewers = new Set<string>();
  const streamers = new Set<string>();
  for (const room of rooms) {
    let meta: { mode?: string; host?: string; liveAt?: string; collabGuest?: string } = {};
    try { meta = JSON.parse(room.metadata || '{}'); } catch { /* not a stream */ }
    // Live streams only (the standalone studio, gone live at least once).
    if (meta.mode !== 'standalone' || !meta.liveAt) continue;
    const host = pointsAccount(meta.host);
    const guest = pointsAccount(meta.collabGuest);
    const standard = room.participants.filter((p) => p.kind === undefined || p.kind === ParticipantInfo_Kind.STANDARD);
    // Someone is sending the picture: the host's studio, or its OBS ingress.
    const onAir = room.participants.some((p) => (
      (p.identity.startsWith('obs-') || pointsAccount(p.identity) === host) && (p.tracks?.length ?? 1) > 0
    ));
    let audience = 0;
    for (const p of standard) {
      if (p.identity.startsWith('obs-')) continue;
      const user = pointsAccount(p.identity);
      if (user && (user === host || user === guest)) continue;
      audience += 1; // guests count as an audience, but earn nothing
      if (user) viewers.add(user);
    }
    if (onAir && audience > 0) {
      if (host) streamers.add(host);
      if (guest && standard.some((p) => pointsAccount(p.identity) === guest)) streamers.add(guest);
    }
  }
  const out = new Map<string, { points: number; kind: 'watch' | 'stream' }>();
  for (const v of viewers) out.set(v, { points: WATCH_POINTS_PER_MIN, kind: 'watch' });
  // A streamer watching someone else in another tab still earns as a streamer.
  for (const s of streamers) out.set(s, { points: STREAM_POINTS_PER_MIN, kind: 'stream' });
  return out;
}

async function sampleMinute(): Promise<void> {
  // Loaded here, not at the top: the stores above must load without LiveKit.
  const { roomService } = await import('./livekit.js');
  let rooms;
  try { rooms = await roomService.listRooms(); } catch { return; }
  const withPeople = [];
  for (const room of rooms) {
    if (!room.metadata?.includes('"standalone"')) continue;
    try {
      withPeople.push({ metadata: room.metadata, participants: await roomService.listParticipants(room.name) });
    } catch { /* skip this room this minute */ }
  }
  // No stream on the record for watching either (viewing history stays private).
  for (const [user, r] of minuteRewards(withPeople)) earn(user, r.points, r.kind);
}

export const POINTS_BATCH_MIN = Math.max(1, Number(process.env.POINTS_BATCH_MIN ?? 5) || 5);
let timer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Count watching and streaming once a minute (POINTS_EARN_ENABLED=false turns
 *  that off), and pay out and log a batch every POINTS_BATCH_MIN minutes. */
export function startPointsSampler(intervalMs = 60_000): void {
  if (!flushTimer) {
    flushTimer = setInterval(() => { void flushPoints(); }, POINTS_BATCH_MIN * 60_000);
    flushTimer.unref?.();
  }
  if (timer || process.env.POINTS_EARN_ENABLED === 'false') return;
  timer = setInterval(() => { void sampleMinute(); }, intervalMs);
  timer.unref?.();
}

/** Drop rate-limit memory older than its window (the 10-minute sweep). */
export function sweepPoints(now = Date.now()): void {
  const minute = Math.floor(now / 60_000);
  for (const [u, s] of chatMinute) if (s.minute < minute) chatMinute.delete(u);
  for (const [k, at] of lastPairReward) if (now - at >= PAIR_REWARD_GAP_MS) lastPairReward.delete(k);
}

export function resetPointsEarning(): void {
  pending.clear();
  chatMinute.clear();
  lastPairReward.clear();
}
