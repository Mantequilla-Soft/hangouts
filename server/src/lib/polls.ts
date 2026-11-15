import { randomBytes } from 'node:crypto';
import type { Collection } from 'mongodb';
import { getLiveDb } from './mongoDb.js';

/**
 * Polls and predictions in a live stream.
 *
 *   poll        2 to 4 options and a timer. One vote per Hive account.
 *   prediction  two outcomes. Viewers stake channel points (NOT money) while
 *               it is open; the host resolves it and the winners split the
 *               whole pot in proportion to their stake.
 *
 * Points are kept per viewer per channel (the host's account), starting at
 * POINTS_START. A prediction changes balances only when it is resolved, in one
 * batch, so a server restart mid-prediction loses the prediction but never
 * anybody's points.
 *
 * One poll or prediction runs per room at a time. Live state is in memory;
 * finished results are archived (TTL one year) so they can be shown with the
 * stream's VOD later (GET /rooms/:name/polls).
 */

export type PollKind = 'poll' | 'prediction';
/** open: taking votes or stakes. locked: a prediction past its window, waiting
 *  for the host. closed: a poll that ended. resolved/cancelled: a prediction's end. */
export type PollStatus = 'open' | 'locked' | 'closed' | 'resolved' | 'cancelled';

export const POINTS_START = Math.max(1, Number(process.env.POINTS_START ?? 1000) || 1000);
export const POLL_MIN_SEC = 15;
export const POLL_MAX_SEC = 600;
export const PREDICTION_MAX_SEC = 1800;
export const QUESTION_MAX = 140;
export const OPTION_MAX = 60;
/** A prediction nobody resolved is cancelled (refunded by doing nothing) after this. */
const UNRESOLVED_MS = 3 * 60 * 60 * 1000;
const ARCHIVE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const POINTS_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** How many polls one room may run; a stream is a few hours, this is plenty. */
const MAX_PER_ROOM = 60;

export interface Poll {
  id: string;
  room: string;
  /** The channel: the host's account. Points are per channel. */
  host: string;
  kind: PollKind;
  question: string;
  options: string[];
  createdAt: number;
  endsAt: number;
  status: PollStatus;
  /** Seconds into the stream when it started, for the VOD replay. */
  offset: number | null;
  votes: Map<string, number>;
  stakes: Map<string, { option: number; amount: number }>;
  winner?: number;
  endedAt?: number;
}

export interface PollOptionView {
  label: string;
  /** Votes (poll) or how many staked on it (prediction). */
  votes: number;
  /** Points staked on it (prediction only). */
  points?: number;
}

export interface PollView {
  id: string;
  room: string;
  host: string;
  kind: PollKind;
  question: string;
  options: PollOptionView[];
  total: number;
  /** Total points in the pot (prediction only). */
  pot?: number;
  status: PollStatus;
  createdAt: number;
  endsAt: number;
  endedAt?: number;
  offset: number | null;
  winner?: number;
}

export function toView(p: Poll): PollView {
  const options: PollOptionView[] = p.options.map((label) => ({ label, votes: 0, ...(p.kind === 'prediction' ? { points: 0 } : {}) }));
  if (p.kind === 'poll') {
    for (const o of p.votes.values()) if (options[o]) options[o].votes += 1;
  } else {
    for (const s of p.stakes.values()) {
      const o = options[s.option];
      if (!o) continue;
      o.votes += 1;
      o.points = (o.points ?? 0) + s.amount;
    }
  }
  const total = p.kind === 'poll' ? p.votes.size : p.stakes.size;
  return {
    id: p.id,
    room: p.room,
    host: p.host,
    kind: p.kind,
    question: p.question,
    options,
    total,
    ...(p.kind === 'prediction' ? { pot: options.reduce((s, o) => s + (o.points ?? 0), 0) } : {}),
    status: p.status,
    createdAt: p.createdAt,
    endsAt: p.endsAt,
    ...(p.endedAt ? { endedAt: p.endedAt } : {}),
    offset: p.offset,
    ...(p.winner !== undefined ? { winner: p.winner } : {}),
  };
}

// ── stores ────────────────────────────────────────────────────────────────

export interface PointsStore {
  get(channel: string, user: string): Promise<number>;
  /** Add `delta` to each user's balance (starting from POINTS_START). */
  apply(channel: string, deltas: Map<string, number>): Promise<void>;
}

export interface PollArchive {
  save(view: PollView): Promise<void>;
  list(room: string): Promise<PollView[]>;
}

interface PointsDoc { channel: string; user: string; balance: number; updatedAt: Date; expiresAt: Date }
interface ArchiveDoc extends PollView { expiresAt: Date }

let pointsCol: Collection<PointsDoc> | null = null;
let archiveCol: Collection<ArchiveDoc> | null = null;

async function pointsCollection(): Promise<Collection<PointsDoc> | null> {
  if (pointsCol) return pointsCol;
  const db = await getLiveDb();
  if (!db) return null;
  const c = db.collection<PointsDoc>('stream-points');
  await c.createIndex({ channel: 1, user: 1 }, { unique: true }).catch(() => undefined);
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
  pointsCol = c;
  return c;
}

async function archiveCollection(): Promise<Collection<ArchiveDoc> | null> {
  if (archiveCol) return archiveCol;
  const db = await getLiveDb();
  if (!db) return null;
  const c = db.collection<ArchiveDoc>('stream-polls');
  await c.createIndex({ id: 1 }, { unique: true }).catch(() => undefined);
  await c.createIndex({ room: 1, createdAt: 1 }).catch(() => undefined);
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
  archiveCol = c;
  return c;
}

/** In memory: tests, and a server with no Mongo configured. */
export function memoryPointsStore(): PointsStore & { balances: Map<string, number> } {
  const balances = new Map<string, number>();
  return {
    balances,
    async get(channel, user) { return balances.get(`${channel}|${user}`) ?? POINTS_START; },
    async apply(channel, deltas) {
      for (const [user, d] of deltas) {
        const k = `${channel}|${user}`;
        balances.set(k, Math.max(0, (balances.get(k) ?? POINTS_START) + d));
      }
    },
  };
}

export function memoryPollArchive(): PollArchive & { docs: PollView[] } {
  const docs: PollView[] = [];
  return {
    docs,
    async save(view) {
      const i = docs.findIndex((d) => d.id === view.id);
      if (i >= 0) docs[i] = view; else docs.push(view);
    },
    async list(room) { return docs.filter((d) => d.room === room).sort((a, b) => a.createdAt - b.createdAt); },
  };
}

const mongoPoints: PointsStore = {
  async get(channel, user) {
    const c = await pointsCollection();
    if (!c) return fallbackPoints.get(channel, user);
    const doc = await c.findOne({ channel, user }, { projection: { balance: 1 } });
    return doc ? doc.balance : POINTS_START;
  },
  async apply(channel, deltas) {
    const c = await pointsCollection();
    if (!c) return fallbackPoints.apply(channel, deltas);
    if (deltas.size === 0) return;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + POINTS_TTL_MS);
    // One bulk write per resolution. The pipeline update starts a viewer who
    // never had a row at POINTS_START and never lets a balance go below zero.
    await c.bulkWrite([...deltas].map(([user, delta]) => ({
      updateOne: {
        filter: { channel, user },
        update: [{
          $set: {
            channel, user, updatedAt: now, expiresAt,
            balance: { $max: [0, { $add: [{ $ifNull: ['$balance', POINTS_START] }, delta] }] },
          },
        }],
        upsert: true,
      },
    })), { ordered: false });
  },
};

const mongoArchive: PollArchive = {
  async save(view) {
    const c = await archiveCollection();
    if (!c) return fallbackArchive.save(view);
    await c.updateOne({ id: view.id }, { $set: { ...view, expiresAt: new Date(Date.now() + ARCHIVE_TTL_MS) } }, { upsert: true });
  },
  async list(room) {
    const c = await archiveCollection();
    if (!c) return fallbackArchive.list(room);
    return c.find({ room }, { projection: { _id: 0, expiresAt: 0 } }).sort({ createdAt: 1 }).limit(MAX_PER_ROOM).toArray() as Promise<PollView[]>;
  },
};

const fallbackPoints = memoryPointsStore();
const fallbackArchive = memoryPollArchive();

let points: PointsStore = mongoPoints;
let archive: PollArchive = mongoArchive;

/** Tests swap the stores. */
export function setPollStores(next: { points?: PointsStore; archive?: PollArchive }): void {
  if (next.points) points = next.points;
  if (next.archive) archive = next.archive;
}

export function pointsBalance(channel: string, user: string): Promise<number> {
  return points.get(channel, user);
}

// ── live state ────────────────────────────────────────────────────────────

const active = new Map<string, Poll>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const perRoomCount = new Map<string, number>();
let onChange: (p: Poll) => void = () => {};

/** Who to tell when a poll changes (the routes broadcast it to the room). */
export function onPollChange(fn: (p: Poll) => void): void {
  onChange = fn;
}

export class PollError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function activePoll(room: string): Poll | null {
  return active.get(room) ?? null;
}

function clearTimer(room: string) {
  const t = timers.get(room);
  if (t) clearTimeout(t);
  timers.delete(room);
}

function arm(p: Poll) {
  clearTimer(p.room);
  // A locked prediction waits for the host, but not forever.
  const due = p.status === 'open' ? p.endsAt : p.endsAt + UNRESOLVED_MS;
  const t = setTimeout(() => { void expire(p.room, p.id); }, Math.max(0, due - Date.now()));
  t.unref?.();
  timers.set(p.room, t);
}

async function expire(room: string, id: string): Promise<void> {
  const p = active.get(room);
  if (!p || p.id !== id) return;
  if (p.status === 'open') {
    if (p.kind === 'poll') await finish(p, 'closed');
    else { p.status = 'locked'; arm(p); onChange(p); }
  } else if (p.status === 'locked') {
    await finish(p, 'cancelled');
  }
}

async function finish(p: Poll, status: PollStatus): Promise<void> {
  clearTimer(p.room);
  p.status = status;
  p.endedAt = Date.now();
  if (active.get(p.room) === p) active.delete(p.room);
  onChange(p);
  try { await archive.save(toView(p)); }
  catch (err) { console.warn('[Polls] archive failed:', err instanceof Error ? err.message : err); }
}

function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export interface CreatePollInput {
  kind: PollKind;
  question: string;
  options: string[];
  durationSec: number;
}

export function createPoll(room: string, host: string, input: CreatePollInput, offset: number | null): Poll {
  if (active.has(room)) throw new PollError(409, 'A poll or prediction is already running. End it first.');
  if ((perRoomCount.get(room) ?? 0) >= MAX_PER_ROOM) throw new PollError(429, 'This stream has run as many polls as it can.');
  const kind: PollKind = input.kind === 'prediction' ? 'prediction' : 'poll';
  const question = cleanText(input.question, QUESTION_MAX);
  if (!question) throw new PollError(400, 'Ask a question.');
  const options = (Array.isArray(input.options) ? input.options : []).map((o) => cleanText(o, OPTION_MAX)).filter(Boolean);
  if (kind === 'poll' && (options.length < 2 || options.length > 4)) throw new PollError(400, 'A poll needs 2 to 4 options.');
  if (kind === 'prediction' && options.length !== 2) throw new PollError(400, 'A prediction needs exactly two outcomes.');
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new PollError(400, 'The options must differ.');
  const max = kind === 'poll' ? POLL_MAX_SEC : PREDICTION_MAX_SEC;
  const sec = Math.round(Number(input.durationSec));
  if (!Number.isFinite(sec) || sec < POLL_MIN_SEC || sec > max) throw new PollError(400, `The timer runs from ${POLL_MIN_SEC} to ${max} seconds.`);

  const now = Date.now();
  const p: Poll = {
    id: `${room}-${randomBytes(4).toString('hex')}`,
    room, host, kind, question, options,
    createdAt: now,
    endsAt: now + sec * 1000,
    status: 'open',
    offset,
    votes: new Map(),
    stakes: new Map(),
  };
  active.set(room, p);
  perRoomCount.set(room, (perRoomCount.get(room) ?? 0) + 1);
  arm(p);
  onChange(p);
  return p;
}

function current(room: string, id: string): Poll {
  const p = active.get(room);
  if (!p || p.id !== id) throw new PollError(404, 'That poll is over.');
  return p;
}

function takingPart(p: Poll): void {
  if (p.status !== 'open' || Date.now() >= p.endsAt) throw new PollError(409, 'Voting has closed.');
}

export function vote(room: string, id: string, user: string, option: number): Poll {
  const p = current(room, id);
  if (p.kind !== 'poll') throw new PollError(400, 'This is a prediction: stake points instead.');
  takingPart(p);
  if (!Number.isInteger(option) || option < 0 || option >= p.options.length) throw new PollError(400, 'No such option.');
  if (p.votes.has(user)) throw new PollError(409, 'You already voted.');
  p.votes.set(user, option);
  onChange(p);
  return p;
}

export async function stake(room: string, id: string, user: string, option: number, amount: number): Promise<{ poll: Poll; balance: number }> {
  const p = current(room, id);
  if (p.kind !== 'prediction') throw new PollError(400, 'This is a poll: vote instead.');
  takingPart(p);
  if (user === p.host) throw new PollError(403, 'The host cannot take part in their own prediction.');
  if (!Number.isInteger(option) || option < 0 || option >= p.options.length) throw new PollError(400, 'No such outcome.');
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt < 1) throw new PollError(400, 'Stake at least 1 point.');
  if (p.stakes.get(user) && p.stakes.get(user)!.option !== option) throw new PollError(409, 'You already picked the other outcome.');
  const balance = await points.get(p.host, user);
  // Read the stake AFTER the await: two quick taps must not both spend the
  // same points, and the window may have closed meanwhile.
  takingPart(p);
  const prev = p.stakes.get(user);
  if (prev && prev.option !== option) throw new PollError(409, 'You already picked the other outcome.');
  const already = prev?.amount ?? 0;
  if (already + amt > balance) throw new PollError(400, 'You do not have that many points.');
  p.stakes.set(user, { option, amount: already + amt });
  onChange(p);
  return { poll: p, balance: balance - already - amt };
}

/** Host: stop a poll early, or close a prediction's window early. */
export async function endPoll(room: string, id: string): Promise<Poll> {
  const p = current(room, id);
  if (p.kind === 'poll') { await finish(p, 'closed'); return p; }
  if (p.status === 'open') { p.status = 'locked'; p.endsAt = Math.min(p.endsAt, Date.now()); arm(p); onChange(p); }
  return p;
}

/** The point changes a resolution makes: winners split the pot by stake. */
export function payouts(p: Poll, winner: number): Map<string, number> {
  const deltas = new Map<string, number>();
  let pot = 0;
  let winPool = 0;
  for (const s of p.stakes.values()) { pot += s.amount; if (s.option === winner) winPool += s.amount; }
  // Nobody backed the winner: everyone keeps their points.
  if (winPool === 0) return deltas;
  for (const [user, s] of p.stakes) {
    deltas.set(user, s.option === winner ? Math.floor((s.amount * pot) / winPool) - s.amount : -s.amount);
  }
  return deltas;
}

export async function resolvePrediction(room: string, id: string, winner: number): Promise<Poll> {
  const p = current(room, id);
  if (p.kind !== 'prediction') throw new PollError(400, 'Only a prediction is resolved.');
  if (!Number.isInteger(winner) || winner < 0 || winner >= p.options.length) throw new PollError(400, 'No such outcome.');
  p.winner = winner;
  await points.apply(p.host, payouts(p, winner));
  await finish(p, 'resolved');
  return p;
}

export async function cancelPoll(room: string, id: string): Promise<Poll> {
  const p = current(room, id);
  await finish(p, p.kind === 'poll' ? 'closed' : 'cancelled');
  return p;
}

/** Finished polls of a room, oldest first (the VOD shows them at their time). */
export function listRoomPolls(room: string): Promise<PollView[]> {
  return archive.list(room);
}

/** Drop state of rooms that no longer exist. An open poll there just ends. */
export function sweepPolls(activeRooms: Set<string>): void {
  for (const [room, p] of active) {
    if (!activeRooms.has(room)) void finish(p, p.kind === 'poll' ? 'closed' : 'cancelled');
  }
  for (const room of perRoomCount.keys()) if (!activeRooms.has(room)) perRoomCount.delete(room);
}

/** Test helper. */
export function resetPolls(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  active.clear();
  perRoomCount.clear();
}
