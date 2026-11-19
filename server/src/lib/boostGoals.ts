import type { RoomServiceClient } from 'livekit-server-sdk';
import { mutateRoomMetadata, type RoomMetaRecord } from './roomMeta.js';

/**
 * Boost goals, tiers, alerts, preset amounts and the per-stream tally.
 *
 * The HOST's settings live in `meta.boost` next to the existing enabled /
 * minBoostUsd / creatorPayoutAccount (written through PATCH /rooms/:name/boost).
 * The TALLY lives in `meta.boostStats` and is written only by the server, by
 * the boost listener, so no client can fake progress or a supporters list.
 *
 * Amounts are counted in HBD. A HIVE boost counts at the value the listener
 * already priced it at when it arrived (`usdAmount`, from the same HIVE price
 * the minimum check uses), since HBD is pegged at 1 USD. So one goal target
 * covers both currencies, and a HIVE boost counts for what it was worth then.
 */

/** Where the bar sits over the video: a full-width band along the bottom or
 *  the top, or a small card in a corner. */
export const GOAL_POSITIONS = ['bottom', 'top', 'top-right', 'bottom-right', 'bottom-left'] as const;
export type GoalPosition = typeof GOAL_POSITIONS[number];

export interface BoostGoal {
  title: string;
  targetHbd: number;
  /** Absent = bottom (goals set before positions existed). */
  position?: GoalPosition;
}

export const isGoalPosition = (v: unknown): v is GoalPosition =>
  typeof v === 'string' && (GOAL_POSITIONS as readonly string[]).includes(v);

export interface BoostAlertSettings {
  /** Play a short chime in the studio for each boost. */
  sound?: boolean;
  /** Read the boost out with the browser's speech synthesis. */
  tts?: boolean;
  /** Only read boosts worth at least this much (HBD). */
  ttsMinHbd?: number;
}

export interface BoostSupporter {
  account: string;
  displayName?: string;
  /** Total of this account's boosts on this stream, in HBD. */
  hbd: number;
  count: number;
}

export interface BoostStats {
  /** Boosts counted on this stream. */
  count: number;
  /** Everything boosted on this stream, in HBD, to anyone on air. */
  totalHbd: number;
  /** What counts towards the host's goal: boosts paid to the host's payout
   *  account (a collab guest's boosts are theirs, not the host's mic fund). */
  goalHbd: number;
  /** Biggest first, capped at MAX_TRACKED_SUPPORTERS. */
  supporters: BoostSupporter[];
  /** When the current goal was reached (ISO), and the target it was reached
   *  for. Clients celebrate once when they see this change. */
  goalReachedAt?: string;
  goalReachedFor?: number;
}

export const MAX_GOAL_TITLE = 80;
export const MAX_GOAL_HBD = 1_000_000;
export const MAX_PRESETS = 6;
export const MAX_PRESET_AMOUNT = 100_000;
export const MAX_TTS_MIN_HBD = 100_000;
export const TOP_SUPPORTERS = 5;
/**
 * The stats ride in room metadata, which every participant receives on each
 * change, so the list can't grow forever. Someone outside the top 50 who
 * boosts again starts from that boost; only a very long tail is affected.
 */
export const MAX_TRACKED_SUPPORTERS = 50;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The body fields PATCH /rooms/:name/boost accepts on top of the old ones. */
export interface BoostExtrasInput {
  goal?: { title?: string; targetHbd?: number; position?: string } | null;
  tiers?: boolean;
  alerts?: BoostAlertSettings;
  presets?: number[];
}

export type BoostExtrasResult =
  | { ok: true; apply: (boost: Record<string, unknown>) => Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate the new settings and return a function that merges them into the
 * stored `boost` block. JSON schema already checks the types; this enforces
 * the ranges and normalises (trims the title, rounds and sorts presets).
 * Omitted fields are left as they were; `goal: null` removes the goal and an
 * empty `presets` array goes back to the default amounts.
 */
export function parseBoostExtras(body: BoostExtrasInput): BoostExtrasResult {
  const steps: Array<(b: Record<string, unknown>) => void> = [];

  if (body.goal === null) {
    steps.push((b) => { delete b.goal; });
  } else if (body.goal !== undefined) {
    const title = String(body.goal.title ?? '').replace(/\s+/g, ' ').trim();
    const target = finitePositive(body.goal.targetHbd);
    if (title.length > MAX_GOAL_TITLE) return { ok: false, error: `Goal title is longer than ${MAX_GOAL_TITLE} characters` };
    if (target === null || target > MAX_GOAL_HBD) return { ok: false, error: 'Enter a goal amount above 0' };
    const position = body.goal.position;
    if (position !== undefined && !isGoalPosition(position)) return { ok: false, error: 'Unknown goal position' };
    const goal: BoostGoal = { title, targetHbd: round3(target), ...(position ? { position } : {}) };
    steps.push((b) => { b.goal = goal; });
  }

  if (body.tiers !== undefined) {
    const tiers = body.tiers;
    steps.push((b) => { b.tiers = tiers; });
  }

  if (body.alerts !== undefined) {
    const a = body.alerts;
    if (a.ttsMinHbd !== undefined && (!Number.isFinite(a.ttsMinHbd) || a.ttsMinHbd < 0 || a.ttsMinHbd > MAX_TTS_MIN_HBD)) {
      return { ok: false, error: 'Enter a valid minimum for reading boosts aloud' };
    }
    steps.push((b) => {
      const prev = asObj(b.alerts) ?? {};
      b.alerts = {
        ...prev,
        ...(a.sound !== undefined ? { sound: a.sound } : {}),
        ...(a.tts !== undefined ? { tts: a.tts } : {}),
        ...(a.ttsMinHbd !== undefined ? { ttsMinHbd: round3(a.ttsMinHbd) } : {}),
      };
    });
  }

  if (body.presets !== undefined) {
    if (body.presets.length > MAX_PRESETS) return { ok: false, error: `At most ${MAX_PRESETS} preset amounts` };
    const cleaned: number[] = [];
    for (const raw of body.presets) {
      const n = finitePositive(raw);
      if (n === null || n > MAX_PRESET_AMOUNT || round3(n) <= 0) return { ok: false, error: 'Preset amounts must be above 0' };
      cleaned.push(round3(n));
    }
    const presets = [...new Set(cleaned)].sort((x, y) => x - y);
    steps.push((b) => {
      if (presets.length === 0) delete b.presets;
      else b.presets = presets;
    });
  }

  return {
    ok: true,
    apply: (boost) => {
      const next = { ...boost };
      for (const step of steps) step(next);
      return next;
    },
  };
}

export function readGoal(meta: RoomMetaRecord): BoostGoal | null {
  const goal = asObj(asObj(meta.boost)?.goal);
  if (!goal) return null;
  const target = finitePositive(goal.targetHbd);
  if (target === null) return null;
  return {
    title: typeof goal.title === 'string' ? goal.title : '',
    targetHbd: target,
    ...(isGoalPosition(goal.position) ? { position: goal.position } : {}),
  };
}

export function emptyStats(): BoostStats {
  return { count: 0, totalHbd: 0, goalHbd: 0, supporters: [] };
}

/** The stored tally, defensively read (metadata is one JSON blob anyone with
 *  a bug can corrupt). Anything unusable reads as an empty tally. */
export function readStats(meta: RoomMetaRecord): BoostStats {
  const raw = asObj(meta.boostStats);
  if (!raw) return emptyStats();
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const supporters = Array.isArray(raw.supporters)
    ? raw.supporters.flatMap((s): BoostSupporter[] => {
      const o = asObj(s);
      if (!o || typeof o.account !== 'string' || !o.account) return [];
      return [{
        account: o.account,
        ...(typeof o.displayName === 'string' && o.displayName ? { displayName: o.displayName } : {}),
        hbd: num(o.hbd),
        count: num(o.count),
      }];
    })
    : [];
  return {
    count: num(raw.count),
    totalHbd: num(raw.totalHbd),
    goalHbd: num(raw.goalHbd),
    supporters,
    ...(typeof raw.goalReachedAt === 'string' ? { goalReachedAt: raw.goalReachedAt } : {}),
    ...(typeof raw.goalReachedFor === 'number' ? { goalReachedFor: raw.goalReachedFor } : {}),
  };
}

function sortSupporters(list: BoostSupporter[]): BoostSupporter[] {
  // Biggest total first; on a tie, whoever got there first stays ahead
  // (Array.prototype.sort is stable).
  return [...list].sort((a, b) => b.hbd - a.hbd);
}

/**
 * Add one boost to a tally. Pure: returns the new tally and whether this boost
 * is the one that reached the goal.
 */
export function addBoostToStats(
  stats: BoostStats,
  boost: { account: string; displayName?: string; hbd: number; countsToGoal: boolean },
  goal: BoostGoal | null,
  now: Date = new Date(),
): { stats: BoostStats; reachedNow: boolean } {
  const hbd = round3(Math.max(0, boost.hbd));
  const supporters = stats.supporters.map((s) => ({ ...s }));
  const existing = supporters.find((s) => s.account === boost.account);
  if (existing) {
    existing.hbd = round3(existing.hbd + hbd);
    existing.count += 1;
    if (boost.displayName) existing.displayName = boost.displayName;
  } else {
    supporters.push({
      account: boost.account,
      ...(boost.displayName ? { displayName: boost.displayName } : {}),
      hbd,
      count: 1,
    });
  }

  const goalBefore = stats.goalHbd;
  const goalAfter = boost.countsToGoal ? round3(goalBefore + hbd) : goalBefore;
  const next: BoostStats = {
    ...stats,
    count: stats.count + 1,
    totalHbd: round3(stats.totalHbd + hbd),
    goalHbd: goalAfter,
    supporters: sortSupporters(supporters).slice(0, MAX_TRACKED_SUPPORTERS),
  };

  const reachedNow = !!goal && goalBefore < goal.targetHbd && goalAfter >= goal.targetHbd;
  if (reachedNow && goal) {
    next.goalReachedAt = now.toISOString();
    next.goalReachedFor = goal.targetHbd;
  }
  return { stats: next, reachedNow };
}

/**
 * After the host changed the goal: keep `goalReachedAt` honest. A target now
 * above the progress clears it (so reaching it later celebrates again); a new
 * target already covered by the progress counts as reached right now.
 */
export function restampGoal(stats: BoostStats, goal: BoostGoal | null, now: Date = new Date()): BoostStats {
  const next = { ...stats };
  if (!goal || stats.goalHbd < goal.targetHbd) {
    delete next.goalReachedAt;
    delete next.goalReachedFor;
    return next;
  }
  if (stats.goalReachedFor !== goal.targetHbd || !stats.goalReachedAt) {
    next.goalReachedAt = now.toISOString();
    next.goalReachedFor = goal.targetHbd;
  }
  return next;
}

/**
 * Count a paid boost against its stream, under the room's metadata lock.
 * Returns whether this boost reached the goal, or null when the room could not
 * be updated (the caller logs it; the boost itself is unaffected).
 */
export async function recordBoostTally(
  roomName: string,
  boost: { account: string; displayName?: string; hbd: number; countsToGoal: boolean },
  lk?: Pick<RoomServiceClient, 'listRooms' | 'updateRoomMetadata'>,
): Promise<{ reachedNow: boolean }> {
  let reachedNow = false;
  await mutateRoomMetadata(roomName, (meta) => {
    const result = addBoostToStats(readStats(meta), boost, readGoal(meta));
    reachedNow = result.reachedNow;
    return { ...meta, boostStats: result.stats };
  }, lk);
  return { reachedNow };
}

export interface BoostSummary {
  goal: (BoostGoal & { progressHbd: number; reached: boolean; reachedAt?: string }) | null;
  count: number;
  totalHbd: number;
  top: BoostSupporter[];
}

/** The public view of a stream's boosts: the goal with its progress, totals,
 *  and the top supporters. Everything here is public on Hive anyway. */
export function boostSummary(meta: RoomMetaRecord): BoostSummary {
  const stats = readStats(meta);
  const goal = readGoal(meta);
  return {
    goal: goal
      ? {
        ...goal,
        progressHbd: stats.goalHbd,
        reached: stats.goalHbd >= goal.targetHbd,
        ...(stats.goalReachedAt ? { reachedAt: stats.goalReachedAt } : {}),
      }
      : null,
    count: stats.count,
    totalHbd: stats.totalHbd,
    top: stats.supporters.slice(0, TOP_SUPPORTERS),
  };
}
