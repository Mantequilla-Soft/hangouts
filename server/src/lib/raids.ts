import { randomBytes } from 'node:crypto';
import { earnForRaid } from './points.js';
import { awardPoints } from './pointsAwards.js';
import type { Collection } from 'mongodb';
import { getLiveDb } from './mongoDb.js';

/**
 * Raids: a host sends everyone watching their stream to another live 3Speak
 * stream. Viewers get a short countdown banner, then the page moves them; the
 * target's chat says "<host> is raiding with N viewers".
 *
 * Abuse limits, all in memory (a restart forgets them, which only ever allows
 * one extra raid):
 *  - a host starts at most one raid per RAID_COOLDOWN_MS,
 *  - a stream receives at most one raid per RAID_TARGET_GAP_MS,
 *  - one raid per source room counts down at a time.
 * A host can switch incoming raids off (stored as an opt-out row per account).
 */

export const RAID_COUNTDOWN_SEC = Math.max(3, Math.min(30, Number(process.env.RAID_COUNTDOWN_SEC ?? 10) || 10));
export const RAID_COOLDOWN_MS = Math.max(0, Number(process.env.RAID_COOLDOWN_MIN ?? 10) || 0) * 60 * 1000;
export const RAID_TARGET_GAP_MS = 2 * 60 * 1000;

export interface RaidTarget {
  roomName: string;
  host: string;
  title: string;
}

export interface Raid {
  id: string;
  from: string;
  fromRoom: string;
  target: RaidTarget;
  viewers: number;
  startedAt: number;
  endsAt: number;
}

export class RaidError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const pending = new Map<string, { raid: Raid; timer: ReturnType<typeof setTimeout> }>();
const lastRaidBy = new Map<string, number>();
const lastRaidOn = new Map<string, number>();

export function pendingRaid(fromRoom: string): Raid | null {
  return pending.get(fromRoom)?.raid ?? null;
}

/** When `host` may raid again (ms epoch), or 0 if now. */
export function raidCooldownUntil(host: string, now = Date.now()): number {
  const last = lastRaidBy.get(host);
  return last && now - last < RAID_COOLDOWN_MS ? last + RAID_COOLDOWN_MS : 0;
}

/**
 * Start a raid's countdown. `land` runs when it reaches zero (the route posts
 * the target's chat line and tells the source room to go). Throws RaidError.
 */
export function startRaid(
  input: { from: string; fromRoom: string; target: RaidTarget; viewers: number },
  land: (raid: Raid) => void | Promise<void>,
  now = Date.now(),
): Raid {
  if (pending.has(input.fromRoom)) throw new RaidError(409, 'A raid is already counting down.');
  const until = raidCooldownUntil(input.from, now);
  if (until) throw new RaidError(429, `You can raid again in ${Math.ceil((until - now) / 60000)} min.`);
  const lastOn = lastRaidOn.get(input.target.roomName);
  if (lastOn && now - lastOn < RAID_TARGET_GAP_MS) throw new RaidError(429, 'That stream was raided a moment ago. Try another one.');

  const raid: Raid = {
    id: randomBytes(5).toString('hex'),
    ...input,
    startedAt: now,
    endsAt: now + RAID_COUNTDOWN_SEC * 1000,
  };
  lastRaidBy.set(input.from, now);
  lastRaidOn.set(input.target.roomName, now);
  const timer = setTimeout(() => {
    pending.delete(input.fromRoom);
    // Channel points for the raider (once an hour for the same two streamers),
    // and, when that paid, for the one raided.
    if (earnForRaid(raid.from, raid.target.host) > 0) {
      void awardPoints([{ id: `raided:${raid.id}`, user: raid.target.host, kind: 'raided', ref: raid.from }]).catch(() => undefined);
    }
    void Promise.resolve(land(raid)).catch(() => undefined);
  }, RAID_COUNTDOWN_SEC * 1000);
  timer.unref?.();
  pending.set(input.fromRoom, { raid, timer });
  return raid;
}

/** The host changed their mind during the countdown. Gives the cooldown back. */
export function cancelRaid(fromRoom: string): Raid | null {
  const p = pending.get(fromRoom);
  if (!p) return null;
  clearTimeout(p.timer);
  pending.delete(fromRoom);
  lastRaidBy.delete(p.raid.from);
  lastRaidOn.delete(p.raid.target.roomName);
  return p.raid;
}

// ── incoming raids setting ──────────────────────────────────────────────────

/** Only hosts who turned raids OFF have a row; everyone else accepts them. */
interface RaidPrefDoc { owner: string; acceptRaids: false; updatedAt: Date }

export interface RaidPrefStore {
  get(owner: string): Promise<boolean>;
  set(owner: string, accept: boolean): Promise<void>;
}

let prefCol: Collection<RaidPrefDoc> | null = null;
async function prefCollection(): Promise<Collection<RaidPrefDoc> | null> {
  if (prefCol) return prefCol;
  const db = await getLiveDb();
  if (!db) return null;
  const c = db.collection<RaidPrefDoc>('raid-settings');
  await c.createIndex({ owner: 1 }, { unique: true }).catch(() => undefined);
  prefCol = c;
  return c;
}

export function memoryRaidPrefs(): RaidPrefStore {
  const off = new Set<string>();
  return {
    async get(owner) { return !off.has(owner); },
    async set(owner, accept) { if (accept) off.delete(owner); else off.add(owner); },
  };
}

const fallbackPrefs = memoryRaidPrefs();
const mongoPrefs: RaidPrefStore = {
  async get(owner) {
    const c = await prefCollection();
    if (!c) return fallbackPrefs.get(owner);
    return !(await c.findOne({ owner }, { projection: { _id: 1 } }));
  },
  async set(owner, accept) {
    const c = await prefCollection();
    if (!c) return fallbackPrefs.set(owner, accept);
    if (accept) await c.deleteOne({ owner });
    else await c.updateOne({ owner }, { $set: { owner, acceptRaids: false, updatedAt: new Date() } }, { upsert: true });
  },
};

let prefs: RaidPrefStore = mongoPrefs;
const prefCache = new Map<string, { accept: boolean; at: number }>();
const PREF_TTL_MS = 60_000;

export function setRaidPrefStore(next: RaidPrefStore): void {
  prefs = next;
  prefCache.clear();
}

/** Does `owner` accept incoming raids? Fails open (true) when the store cannot answer. */
export async function acceptsRaids(owner: string): Promise<boolean> {
  const hit = prefCache.get(owner);
  if (hit && Date.now() - hit.at < PREF_TTL_MS) return hit.accept;
  let accept = true;
  try { accept = await prefs.get(owner); } catch { /* fail open */ }
  prefCache.set(owner, { accept, at: Date.now() });
  return accept;
}

export async function setAcceptsRaids(owner: string, accept: boolean): Promise<void> {
  await prefs.set(owner, accept);
  prefCache.set(owner, { accept, at: Date.now() });
}

/** Forget limits that no longer matter, and countdowns of rooms that are gone. */
export function sweepRaids(activeRooms: Set<string>, now = Date.now()): void {
  for (const [h, at] of lastRaidBy) if (now - at >= RAID_COOLDOWN_MS) lastRaidBy.delete(h);
  for (const [r, at] of lastRaidOn) if (now - at >= RAID_TARGET_GAP_MS) lastRaidOn.delete(r);
  for (const room of pending.keys()) if (!activeRooms.has(room)) cancelRaid(room);
  for (const [o, c] of prefCache) if (now - c.at >= PREF_TTL_MS) prefCache.delete(o);
}

/** Test helper. */
export function resetRaids(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  lastRaidBy.clear();
  lastRaidOn.clear();
  prefCache.clear();
}
