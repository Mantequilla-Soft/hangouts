import { config } from '../config.js';
import type { PointsKind } from './pointsLog.js';

/**
 * Double points: inside a window every EARNING pays x2 (watching, streaming,
 * chat, raids, battles, boosts and every award of lib/pointsAwards.ts,
 * quests too). Never refunds, prediction payouts, spends or expiries, and
 * nothing outside this server's earnings (the token's grant and airdrop).
 *
 *   POINTS_DOUBLE_WEEKENDS  true: every Saturday 00:00 to Sunday 24:00 UTC
 *   POINTS_DOUBLE_WINDOWS   a comma list of `<ISO start>/<ISO end>`
 *
 * Applied where earnings are paid (lib/points.ts earn and applyPointsNow), so
 * a sender never decides it.
 */

export const DOUBLE_FACTOR = 2;

/** Moves that are not earnings: never doubled. */
const NOT_EARNINGS: ReadonlySet<PointsKind> = new Set<PointsKind>(['spend', 'refund', 'prediction', 'expire', 'transfer']);

const DAY_MS = 24 * 60 * 60 * 1000;
type Span = [start: number, end: number];

let parsedFrom: string | null = null;
let parsed: Span[] = [];

/** POINTS_DOUBLE_WINDOWS as spans; a window that does not parse is skipped. */
function configuredWindows(): Span[] {
  const raw = config.POINTS_DOUBLE_WINDOWS ?? '';
  if (raw === parsedFrom) return parsed;
  parsed = raw.split(',').map((w) => w.trim()).filter(Boolean).flatMap((w): Span[] => {
    const [a, b] = w.split('/');
    const start = Date.parse(a ?? '');
    const end = Date.parse(b ?? '');
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [[start, end]] : [];
  });
  parsedFrom = raw;
  return parsed;
}

/** The weekends from the one before `now` to a few weeks on. */
function weekends(now: number): Span[] {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // This weekend's Saturday (getUTCDay: 0 Sunday ... 6 Saturday): on a
  // Sunday that was yesterday.
  const day = d.getUTCDay();
  const saturday = midnight + (day === 0 ? -1 : 6 - day) * DAY_MS;
  const out: Span[] = [];
  for (let w = -1; w <= 4; w += 1) {
    const start = saturday + w * 7 * DAY_MS;
    out.push([start, start + 2 * DAY_MS]);
  }
  return out;
}

/** Every double-points span around `now`, merged and in order. */
function spans(now: number): Span[] {
  const all = [...configuredWindows(), ...(config.POINTS_DOUBLE_WEEKENDS ? weekends(now) : [])].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function doubleActive(at = Date.now()): boolean {
  return spans(at).some(([s, e]) => at >= s && at < e);
}

/** What an earning of `kind` at `at` is multiplied by. */
export function pointsMultiplier(kind: PointsKind, at = Date.now()): number {
  return !NOT_EARNINGS.has(kind) && doubleActive(at) ? DOUBLE_FACTOR : 1;
}

export interface DoubleState { active: boolean; until?: string; next?: string }

/** For GET /points/events: whether it is on now, until when, and when next. */
export function doubleState(now = Date.now()): DoubleState {
  const all = spans(now);
  const cur = all.find(([s, e]) => now >= s && now < e);
  const next = all.find(([s]) => s > now);
  return {
    active: !!cur,
    ...(cur ? { until: new Date(cur[1]).toISOString() } : {}),
    ...(next ? { next: new Date(next[0]).toISOString() } : {}),
  };
}
