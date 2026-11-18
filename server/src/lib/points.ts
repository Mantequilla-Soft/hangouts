import type { Collection } from 'mongodb';
import { ParticipantInfo_Kind } from '@livekit/protocol';
import { getLiveDb } from './mongoDb.js';

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
 * A balance nobody touched for POINTS_TTL_DAYS (90, a quarter) is deleted, and
 * the account starts again at POINTS_START: come back, or stream, to keep it.
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
}

interface PointsDoc { user: string; balance: number; updatedAt: Date; expiresAt: Date }

let col: Collection<PointsDoc> | null = null;

async function collection(): Promise<Collection<PointsDoc> | null> {
  if (col) return col;
  const db = await getLiveDb();
  if (!db) return null;
  // `points`, not the old per-channel `stream-points` (whose rows expire on
  // their own TTL).
  const c = db.collection<PointsDoc>('points');
  await c.createIndex({ user: 1 }, { unique: true }).catch(() => undefined);
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
  col = c;
  return c;
}

/** In memory: tests, and a server with no Mongo configured. */
export function memoryPointsStore(): PointsStore & { balances: Map<string, number> } {
  const balances = new Map<string, number>();
  return {
    balances,
    async get(user) { return balances.get(user) ?? POINTS_START; },
    async details(user) { return { balance: balances.get(user) ?? POINTS_START, expiresAt: null }; },
    async apply(deltas) {
      for (const [user, d] of deltas) balances.set(user, Math.max(0, (balances.get(user) ?? POINTS_START) + d));
    },
    async spend(user, amount) {
      const cur = balances.get(user) ?? POINTS_START;
      if (cur < amount) return null;
      balances.set(user, cur - amount);
      return cur - amount;
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

/** Spend points (a points boost). The balance left, or null when too few. */
export function spendPoints(user: string, amount: number): Promise<number | null> {
  return store.spend(user.toLowerCase(), amount);
}

/** Best effort: points never break a stream, a chat line or a boost. */
function award(deltas: Map<string, number>): void {
  if (deltas.size === 0) return;
  void store.apply(deltas).catch(() => undefined);
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
  award(new Map([[user, pts]]));
  return pts;
}

/** A boost worth `hbd` from `sender`. */
export function earnForBoost(sender: string, hbd: number): number {
  const user = pointsAccount(sender);
  const pts = boostReward(hbd);
  if (!user || pts <= 0) return 0;
  award(new Map([[user, pts]]));
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
  award(new Map([[a, RAID_POINTS]]));
  return RAID_POINTS;
}

/** A battle ran its full time: both hosts earn BATTLE_POINTS. */
export function earnForBattle(hostA: string, hostB: string, now = Date.now()): number {
  const a = pointsAccount(hostA);
  const b = pointsAccount(hostB);
  if (!a || !b || a === b || !pairDue('battle', a, b, now)) return 0;
  award(new Map([[a, BATTLE_POINTS], [b, BATTLE_POINTS]]));
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
export function minuteRewards(rooms: Array<{ metadata?: string; participants: SampleParticipant[] }>): Map<string, number> {
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
  const out = new Map<string, number>();
  for (const v of viewers) out.set(v, WATCH_POINTS_PER_MIN);
  // A streamer watching someone else in another tab still earns as a streamer.
  for (const s of streamers) out.set(s, STREAM_POINTS_PER_MIN);
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
  award(minuteRewards(withPeople));
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Count watching and streaming once a minute. POINTS_EARN_ENABLED=false turns it off. */
export function startPointsSampler(intervalMs = 60_000): void {
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
  chatMinute.clear();
  lastPairReward.clear();
}
