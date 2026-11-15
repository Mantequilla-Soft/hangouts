/**
 * Highlight moments of a live stream: chat and boost spikes (H13).
 *
 * Kept deliberately cheap, because this runs on the Mongo primary box:
 *   - per room, ONE open bucket of BUCKET_MS (chat lines, distinct chatters,
 *     boosts, boosted USD) plus a short ring of closed bucket scores for the
 *     baseline. Nothing per message beyond a Map lookup and a Set add.
 *   - a bucket closes lazily (on the next event) or on the shared sweep timer;
 *     only then is the spike rule evaluated.
 *   - a spike is written to Mongo (one upsert per spike, at most MAX_MOMENTS
 *     per room), so the host still sees the moments after the room is gone.
 *
 * Chat reaches the server from the senders' clients (POST .../highlights/chat,
 * one tiny request per line, rate limited), boosts from the boost listener.
 * Neither is trusted for money: a spike only suggests a clip.
 */
import { MongoClient, type Collection } from 'mongodb';
import { config } from '../config.js';

export const BUCKET_MS = 20_000;
/** Closed buckets the baseline averages over (5 minutes). */
const BASELINE_BUCKETS = 15;
/** A bucket must score at least this AND SPIKE_FACTOR times the baseline. */
const MIN_SCORE = 4;
const SPIKE_FACTOR = 2.5;
/** Two moments are at least this far apart. */
const MIN_GAP_MS = 90_000;
/** One boost of at least this many USD is a moment by itself. */
const BIG_BOOST_USD = 5;
export const MAX_MOMENTS = 12;
/** A sender counts for at most this many lines per bucket (one person spamming
 *  is not a spike). */
const MAX_LINES_PER_SENDER = 3;
/** Distinct chatters remembered per bucket (memory bound). */
const MAX_SENDERS_PER_BUCKET = 300;
/** Rooms tracked at once, and how long an idle room stays in memory. */
const MAX_ROOMS = 500;
const IDLE_DROP_MS = 15 * 60_000;
const KEEP_DAYS = 30;

export type MomentReason = 'chat' | 'boosts' | 'big_boost';

export interface HighlightMoment {
  /** Wall clock of the bucket's END (ms epoch). */
  at: number;
  /** Seconds since the stream went live (null when liveAt is unknown). */
  offsetSec: number | null;
  reasons: MomentReason[];
  chatters: number;
  lines: number;
  boosts: number;
  usd: number;
  score: number;
}

interface Bucket {
  start: number;
  lines: number;
  senders: Map<string, number>;
  boosts: number;
  usd: number;
  bigBoost: boolean;
}

interface RoomState {
  room: string;
  host: string | null;
  liveAt: number | null;
  bucket: Bucket | null;
  scores: number[];
  lastMomentAt: number;
  moments: HighlightMoment[];
  touched: number;
}

export interface RoomInfo { host: string | null; liveAt: number | null }
type Resolver = (room: string) => Promise<RoomInfo | null>;
type SpikeListener = (room: string, moment: HighlightMoment, info: RoomInfo) => void;

const rooms = new Map<string, RoomState>();
const listeners = new Set<SpikeListener>();
let resolver: Resolver = async () => null;

/** How the room's host and go-live time are found (LiveKit metadata in prod). */
export function setRoomResolver(fn: Resolver): void { resolver = fn; }
/** Called for every new moment (the auto clip hooks in here). */
export function onHighlight(fn: SpikeListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Score of one bucket: distinct chatters count most, extra lines a little,
 *  boosts a lot (they cost money), boosted dollars a bit more, capped. */
export function bucketScore(b: Pick<Bucket, 'lines' | 'boosts' | 'usd'> & { chatters: number }): number {
  const extraLines = Math.max(0, b.lines - b.chatters);
  return Math.round((b.chatters + extraLines * 0.5 + b.boosts * 3 + Math.min(b.usd, 50) / 5) * 10) / 10;
}

/** Pure spike rule over the closed bucket and the scores before it. */
export function isSpike(score: number, previous: number[], bigBoost = false): boolean {
  if (bigBoost) return true;
  if (score < MIN_SCORE) return false;
  const base = previous.length ? previous.reduce((a, b) => a + b, 0) / previous.length : 0;
  return score >= SPIKE_FACTOR * Math.max(base, 1);
}

// --- persistence -------------------------------------------------------------

interface HighlightDoc {
  room: string;
  host: string | null;
  liveAt: Date | null;
  moments: HighlightMoment[];
  updatedAt: Date;
  expiresAt: Date;
}

let col: Collection<HighlightDoc> | null = null;
let connecting: Promise<void> | null = null;

async function store(): Promise<Collection<HighlightDoc> | null> {
  if (col) return col;
  if (!config.MONGODB_URI) return null;
  connecting ??= (async () => {
    try {
      const client = new MongoClient(config.MONGODB_URI);
      await client.connect();
      const c = client.db().collection<HighlightDoc>('stream-highlights');
      await c.createIndex({ room: 1 }, { unique: true });
      await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      col = c;
    } catch (err) {
      console.error('[Highlights] Failed to connect to MongoDB:', err);
    } finally {
      connecting = null;
    }
  })();
  await connecting;
  return col;
}

async function persist(s: RoomState): Promise<void> {
  try {
    const c = await store();
    if (!c) return;
    const now = new Date();
    await c.updateOne(
      { room: s.room },
      { $set: {
        host: s.host, liveAt: s.liveAt ? new Date(s.liveAt) : null, moments: s.moments,
        updatedAt: now, expiresAt: new Date(now.getTime() + KEEP_DAYS * 86_400_000),
      } },
      { upsert: true },
    );
  } catch (err) {
    console.error('[Highlights] persist failed:', err);
  }
}

// --- the counters ------------------------------------------------------------

function stateFor(room: string, now: number): RoomState | null {
  let s = rooms.get(room);
  if (s) { s.touched = now; return s; }
  if (rooms.size >= MAX_ROOMS) {
    // Drop the least recently touched room rather than refusing new ones.
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of rooms) if (v.touched < oldestAt) { oldest = k; oldestAt = v.touched; }
    if (oldest) rooms.delete(oldest);
  }
  s = { room, host: null, liveAt: null, bucket: null, scores: [], lastMomentAt: 0, moments: [], touched: now };
  rooms.set(room, s);
  // Learn host + liveAt once per room (one LiveKit call), in the background.
  void resolver(room).then((info) => {
    if (info && rooms.get(room) === s) { s!.host = info.host; s!.liveAt = info.liveAt; }
  }).catch(() => { /* stays unknown */ });
  return s;
}

function openBucket(s: RoomState, now: number): Bucket {
  const start = now - (now % BUCKET_MS);
  if (s.bucket && s.bucket.start === start) return s.bucket;
  closeUpTo(s, now);
  s.bucket = { start, lines: 0, senders: new Map(), boosts: 0, usd: 0, bigBoost: false };
  return s.bucket;
}

/** Close the open bucket if its window has passed, and push empty buckets'
 *  zero scores for the gap, so a quiet stretch lowers the baseline. */
function closeUpTo(s: RoomState, now: number): void {
  const b = s.bucket;
  if (!b || now < b.start + BUCKET_MS) return;
  s.bucket = null;
  const chatters = b.senders.size;
  const score = bucketScore({ lines: b.lines, chatters, boosts: b.boosts, usd: b.usd });
  const previous = s.scores.slice(-BASELINE_BUCKETS);
  const end = b.start + BUCKET_MS;
  const spike = isSpike(score, previous, b.bigBoost) && end - s.lastMomentAt >= MIN_GAP_MS && s.moments.length < MAX_MOMENTS;
  s.scores.push(score);
  const gap = Math.min(BASELINE_BUCKETS, Math.floor((now - end) / BUCKET_MS));
  for (let i = 0; i < gap; i++) s.scores.push(0);
  if (s.scores.length > BASELINE_BUCKETS * 2) s.scores.splice(0, s.scores.length - BASELINE_BUCKETS);
  if (!spike) return;
  const reasons: MomentReason[] = [];
  if (chatters >= 2) reasons.push('chat');
  if (b.boosts > 0) reasons.push(b.bigBoost ? 'big_boost' : 'boosts');
  if (reasons.length === 0) reasons.push('chat');
  const moment: HighlightMoment = {
    at: end,
    offsetSec: s.liveAt ? Math.max(0, Math.round((end - s.liveAt) / 1000)) : null,
    reasons,
    chatters,
    lines: b.lines,
    boosts: b.boosts,
    usd: Math.round(b.usd * 100) / 100,
    score,
  };
  s.moments.push(moment);
  s.lastMomentAt = end;
  void persist(s);
  const info = { host: s.host, liveAt: s.liveAt };
  for (const fn of listeners) {
    try { fn(s.room, moment, info); } catch { /* a listener never breaks counting */ }
  }
}

/** One chat line in `room` from `sender` (a username, or an IP for a guest). */
export function noteChat(room: string, sender: string, now = Date.now()): void {
  if (!config.HIGHLIGHTS_ENABLED || !room) return;
  const s = stateFor(room, now);
  if (!s) return;
  const b = openBucket(s, now);
  const n = b.senders.get(sender) ?? 0;
  if (n >= MAX_LINES_PER_SENDER) return;
  if (n === 0 && b.senders.size >= MAX_SENDERS_PER_BUCKET) return;
  b.senders.set(sender, n + 1);
  b.lines += 1;
}

/** A boost landed in `room` (from the boost listener, already verified on Hive). */
export function noteBoost(room: string, usd: number, now = Date.now()): void {
  if (!config.HIGHLIGHTS_ENABLED || !room) return;
  const s = stateFor(room, now);
  if (!s) return;
  const b = openBucket(s, now);
  const amount = Number.isFinite(usd) && usd > 0 ? usd : 0;
  b.boosts += 1;
  b.usd += amount;
  if (amount >= BIG_BOOST_USD) b.bigBoost = true;
}

/** Close due buckets everywhere and forget idle rooms. Run on a timer. */
export function sweepHighlights(now = Date.now()): void {
  for (const [room, s] of rooms) {
    closeUpTo(s, now);
    if (now - s.touched > IDLE_DROP_MS && !s.bucket) rooms.delete(room);
  }
}

/** The room's moments: from memory while it is tracked, else from Mongo. */
export async function getHighlights(room: string): Promise<{ host: string | null; liveAt: number | null; moments: HighlightMoment[] } | null> {
  const s = rooms.get(room);
  if (s) {
    closeUpTo(s, Date.now());
    return { host: s.host, liveAt: s.liveAt, moments: [...s.moments] };
  }
  try {
    const c = await store();
    const doc = c ? await c.findOne({ room }) : null;
    if (!doc) return null;
    return { host: doc.host, liveAt: doc.liveAt ? doc.liveAt.getTime() : null, moments: doc.moments ?? [] };
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Start the shared bucket sweep (one timer for all rooms). */
export function startHighlightSweep(intervalMs = 10_000): void {
  if (timer) return;
  timer = setInterval(() => sweepHighlights(), intervalMs);
  timer.unref?.();
}

/** Tests only. */
export function resetHighlights(): void {
  rooms.clear();
  listeners.clear();
  resolver = async () => null;
  if (timer) { clearInterval(timer); timer = null; }
}
