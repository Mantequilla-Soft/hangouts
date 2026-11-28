/**
 * Boost goals, tiers, alerts and preset amounts: the pure half (no React), so
 * the studio, the viewer pieces and the OBS alert player all agree, and so it
 * can be tested on its own.
 *
 * The host's settings sit in the room metadata's `boost` block (written by
 * PATCH /rooms/:name/boost); the tally sits in `boostStats` and is written only
 * by the server's boost listener. Amounts are in HBD: a HIVE boost counts at the
 * USD value the server priced it at when it arrived (HBD is pegged at 1 USD).
 *
 * Lives in this package rather than @snapie/hangouts-core on purpose: the
 * integrators vendor this package as a tarball but take core from npm, so new
 * runtime code in core would not reach them until core is published.
 */

/** Where the goal bar sits over the video (mirrors the server's GOAL_POSITIONS):
 *  a small card in a corner, or a full-width band along the top or bottom.
 *  The default first. */
export const GOAL_POSITIONS = ['top-right', 'bottom-right', 'bottom-left', 'top', 'bottom'] as const;
export type GoalPosition = typeof GOAL_POSITIONS[number];
/** Also what a goal saved without a position (before positions existed) shows. */
export const DEFAULT_GOAL_POSITION: GoalPosition = 'top-right';

export const isGoalPosition = (v: unknown): v is GoalPosition =>
  typeof v === 'string' && (GOAL_POSITIONS as readonly string[]).includes(v);

export interface BoostGoal {
  title: string;
  targetHbd: number;
  /** Absent = DEFAULT_GOAL_POSITION. */
  position?: GoalPosition;
}

export interface BoostAlertSettings {
  sound?: boolean;
  tts?: boolean;
  ttsMinHbd?: number;
  /** Points shop read-aloud messages: read with the boosts when `tts` is on
   *  (default true). False also stops viewers from buying them. */
  readAloud?: boolean;
}

/** The whole `boost` block of the room metadata, old fields and new. */
export interface BoostRoomConfig {
  enabled?: boolean;
  minBoostUsd?: number;
  creatorPayoutAccount?: string;
  goal?: BoostGoal;
  /** Amount tiers on (default) or off. */
  tiers?: boolean;
  alerts?: BoostAlertSettings;
  presets?: number[];
}

export interface BoostSupporter {
  account: string;
  displayName?: string;
  hbd: number;
  count: number;
}

export interface BoostStats {
  count: number;
  totalHbd: number;
  goalHbd: number;
  supporters: BoostSupporter[];
  goalReachedAt?: string;
  goalReachedFor?: number;
}

export const DEFAULT_BOOST_PRESETS: readonly number[] = [1, 5, 10, 25];
export const MAX_BOOST_PRESETS = 6;
export const DEFAULT_TTS_MIN_HBD = 5;
export const TOP_SUPPORTERS = 5;

/** How long a boost stays up when tiers are off (and the old fixed time). */
export const BOOST_BASE_DISPLAY_MS = 30_000;

export interface BoostTier {
  /** 0 = smallest. Used as the CSS modifier: `--tier-0` ... `--tier-3`. */
  level: 0 | 1 | 2 | 3;
  /** From this amount (HBD), inclusive. */
  minHbd: number;
  /** How long a boost of this tier stays pinned on screen. */
  displayMs: number;
}

/**
 * The brackets: under 1, 1 to 5, 5 to 20, 20 and up (HBD). Bigger boosts stay
 * up longer and stand out more; the colours come from the theme tokens (see
 * `boostTierColorVar`), so an integrator's skin decides what they look like.
 */
export const BOOST_TIERS: readonly BoostTier[] = [
  { level: 0, minHbd: 0, displayMs: 15_000 },
  { level: 1, minHbd: 1, displayMs: 30_000 },
  { level: 2, minHbd: 5, displayMs: 60_000 },
  { level: 3, minHbd: 20, displayMs: 120_000 },
];

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Parse a room's metadata JSON; anything unreadable is an empty object. */
export function parseRoomMeta(metadata: string | undefined | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    return asObj(JSON.parse(metadata)) ?? {};
  } catch {
    return {};
  }
}

export function readBoostConfig(meta: Record<string, unknown>): BoostRoomConfig | undefined {
  const b = asObj(meta.boost);
  return b ? b as BoostRoomConfig : undefined;
}

export function readBoostGoal(config: BoostRoomConfig | undefined): BoostGoal | null {
  const goal = asObj(config?.goal);
  if (!goal) return null;
  const target = typeof goal.targetHbd === 'number' && Number.isFinite(goal.targetHbd) && goal.targetHbd > 0 ? goal.targetHbd : null;
  if (target === null) return null;
  return {
    title: typeof goal.title === 'string' ? goal.title : '',
    targetHbd: target,
    ...(isGoalPosition(goal.position) ? { position: goal.position } : {}),
  };
}

export function readBoostStats(meta: Record<string, unknown>): BoostStats {
  const raw = asObj(meta.boostStats);
  const supporters = Array.isArray(raw?.supporters)
    ? (raw!.supporters as unknown[]).flatMap((s): BoostSupporter[] => {
      const o = asObj(s);
      if (!o || typeof o.account !== 'string' || !o.account) return [];
      return [{
        account: o.account,
        ...(typeof o.displayName === 'string' && o.displayName ? { displayName: o.displayName } : {}),
        hbd: nonNeg(o.hbd),
        count: nonNeg(o.count),
      }];
    })
    : [];
  return {
    count: nonNeg(raw?.count),
    totalHbd: nonNeg(raw?.totalHbd),
    goalHbd: nonNeg(raw?.goalHbd),
    supporters,
    ...(typeof raw?.goalReachedAt === 'string' ? { goalReachedAt: raw.goalReachedAt } : {}),
    ...(typeof raw?.goalReachedFor === 'number' ? { goalReachedFor: raw.goalReachedFor } : {}),
  };
}

/**
 * A goal from what the host typed (the create form's Boosts step), or null: an
 * amount above 0 makes a goal, a title alone does not, and no boosts no goal.
 */
export function goalFromInput(boostsOn: boolean, title: string, amount: string, position: GoalPosition = DEFAULT_GOAL_POSITION): BoostGoal | null {
  const target = parseFloat(amount);
  if (!boostsOn || !Number.isFinite(target) || target <= 0) return null;
  return {
    title: title.replace(/\s+/g, ' ').trim().slice(0, 80),
    targetHbd: target,
    // Always stored, so the choice can't change meaning if the default does.
    position,
  };
}

export interface GoalProgress {
  title: string;
  targetHbd: number;
  position: GoalPosition;
  progressHbd: number;
  /** 0..1, for the bar width. */
  fraction: number;
  reached: boolean;
}

export function goalProgress(goal: BoostGoal | null, stats: BoostStats): GoalProgress | null {
  if (!goal) return null;
  const progress = stats.goalHbd;
  return {
    title: goal.title,
    targetHbd: goal.targetHbd,
    position: goal.position ?? DEFAULT_GOAL_POSITION,
    progressHbd: progress,
    fraction: Math.max(0, Math.min(1, progress / goal.targetHbd)),
    reached: progress >= goal.targetHbd,
  };
}

/** The top supporters, biggest first (the server keeps them sorted; sorted
 *  again here so a hand-edited list can't show out of order). */
export function topSupporters(stats: BoostStats, n = TOP_SUPPORTERS): BoostSupporter[] {
  return [...stats.supporters].sort((a, b) => b.hbd - a.hbd).slice(0, n);
}

export function tiersEnabled(config: BoostRoomConfig | undefined): boolean {
  return config?.tiers !== false;
}

/** The tier of a boost worth `hbd`. */
export function boostTier(hbd: number): BoostTier {
  let tier = BOOST_TIERS[0];
  for (const t of BOOST_TIERS) if (hbd >= t.minHbd) tier = t;
  return tier;
}

/** How long a boost stays on screen: by tier, or the fixed time with tiers off. */
export function boostDisplayMs(hbd: number, tiersOn: boolean): number {
  return tiersOn ? boostTier(hbd).displayMs : BOOST_BASE_DISPLAY_MS;
}

/**
 * The theme token for a tier's accent, as a CSS custom property name. Only
 * tokens the SDK theme already has (an integrator's skin maps them to its own
 * palette); the tiers also differ in weight, not colour alone, so they stay
 * apart in a skin that maps two tokens to the same colour.
 */
export function boostTierColorVar(level: number): string {
  switch (level) {
    case 3: return '--hh-pro-gold';
    case 2: return '--hh-primary';
    case 1: return '--hh-success';
    default: return '--hh-text-muted';
  }
}

interface PinnableBoost {
  id: string;
  usdAmount: number;
  timestamp: number;
  belowMinimum?: boolean;
}

/**
 * Which boosts are on screen at `now`, at most `max`. Each stays for its tier's
 * time; when more are up than fit, the bigger tiers keep their place (that is
 * the "pinned" part) and the newest of the rest fill the remaining slots.
 * Returned oldest first, the order they stack in.
 */
export function pickPinnedBoosts<T extends PinnableBoost>(
  boosts: readonly T[],
  now: number,
  tiersOn: boolean,
  max: number,
): T[] {
  const live = boosts.filter((b) => !b.belowMinimum && now - b.timestamp < boostDisplayMs(b.usdAmount, tiersOn));
  if (live.length <= max) return live;
  const ranked = [...live].sort((a, b) => {
    if (tiersOn) {
      const d = boostTier(b.usdAmount).level - boostTier(a.usdAmount).level;
      if (d !== 0) return d;
    }
    return b.timestamp - a.timestamp;
  });
  const keep = new Set(ranked.slice(0, max).map((b) => b.id));
  return live.filter((b) => keep.has(b.id));
}

/** The host's preset amounts, or the defaults. Positive, sorted, at most six. */
export function boostPresets(config: BoostRoomConfig | undefined): number[] {
  const raw = Array.isArray(config?.presets) ? config!.presets : [];
  const clean = [...new Set(raw.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0))]
    .sort((a, b) => a - b)
    .slice(0, MAX_BOOST_PRESETS);
  return clean.length ? clean : [...DEFAULT_BOOST_PRESETS];
}

/**
 * Read the preset amounts field: numbers split on commas or spaces. Returns
 * null when something in it is not a positive number.
 */
export function parsePresetsInput(raw: string): number[] | null {
  const parts = raw.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    const rounded = Math.round(n * 1000) / 1000;
    if (!Number.isFinite(n) || rounded <= 0) return null;
    out.push(rounded);
  }
  return out;
}

export interface ResolvedAlertSettings {
  sound: boolean;
  tts: boolean;
  ttsMinHbd: number;
  /** As stored; absent when the host never set it (readAloudOn() decides). */
  readAloud?: boolean;
}

/** Alert settings with their defaults: chime on, reading aloud off. */
export function alertSettings(config: BoostRoomConfig | undefined): ResolvedAlertSettings {
  const a = asObj(config?.alerts) ?? {};
  return {
    sound: a.sound !== false,
    tts: a.tts === true,
    ttsMinHbd: typeof a.ttsMinHbd === 'number' && Number.isFinite(a.ttsMinHbd) && a.ttsMinHbd >= 0 ? a.ttsMinHbd : DEFAULT_TTS_MIN_HBD,
    ...(typeof a.readAloud === 'boolean' ? { readAloud: a.readAloud } : {}),
  };
}

/** A boost counts as new (worth an alert) for this long after it was sent. */
export const ALERT_FRESH_MS = 60_000;

interface AlertableBoost {
  id: string;
  usdAmount: number;
  timestamp: number;
  belowMinimum?: boolean;
}

export interface AlertPlan {
  chime: boolean;
  speak: boolean;
}

/**
 * What to do for one boost: chime, read it aloud, both or neither. Hidden
 * (below the minimum) and stale boosts (replayed from storage after a reload)
 * never alert; reading aloud also needs the TTS minimum.
 */
export function planBoostAlert(boost: AlertableBoost, settings: ResolvedAlertSettings, now: number): AlertPlan {
  if (boost.belowMinimum || now - boost.timestamp >= ALERT_FRESH_MS) return { chime: false, speak: false };
  return {
    chime: settings.sound,
    speak: settings.tts && boost.usdAmount >= settings.ttsMinHbd,
  };
}

/** Fill `{name}` placeholders in a label. */
export function fillLabel(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A boost's amount as shown: "5.000 HBD", or "2,500 points" for a points boost. */
export function boostAmountText(boost: { amount: string; asset: string }): string {
  if (boost.asset === 'POINTS') {
    const n = Number(boost.amount);
    return `${Number.isFinite(n) ? n.toLocaleString('en-US') : boost.amount} points`;
  }
  return `${boost.amount} ${boost.asset}`;
}

/** What the speech synthesis says for a boost. `template` takes {name},
 *  {amount}, {asset} and {message}. */
export function boostSpeechText(
  boost: { sender: string; displayName?: string; amount: string; asset: string; message: string },
  template = '{name} boosted {amount} {asset}. {message}',
): string {
  // Trim the trailing zeros the chain format adds ("5.000" reads as "5").
  const amount = String(Number(boost.amount));
  return fillLabel(template, {
    name: boost.displayName || boost.sender,
    amount: amount === 'NaN' ? boost.amount : amount,
    asset: boost.asset === 'POINTS' ? 'points' : boost.asset,
    message: boost.message,
  }).replace(/\s+/g, ' ').trim();
}

/** "12.5" / "50" / "0.25": a compact HBD figure for the bar and lists. */
export function formatHbd(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // Whole numbers from 100 up keep their zeros: only trailing decimals go.
  if (n >= 100) return n.toFixed(0);
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/**
 * Has the goal just been reached, as seen by this client? True only when the
 * `goalReachedAt` stamp CHANGES to a new value after the first metadata this
 * client saw: opening a stream whose goal was reached an hour ago celebrates
 * nothing, and each crossing celebrates once.
 */
export function goalJustReached(
  previousStamp: string | undefined | null,
  nextStamp: string | undefined,
  firstLook: boolean,
  now?: number,
): boolean {
  if (firstLook || !nextStamp || nextStamp === previousStamp) return false;
  // Belt and braces against a stale stamp (a reconnect that re-delivers old
  // metadata): only a reach from the last few minutes is news.
  if (now !== undefined) {
    const at = Date.parse(nextStamp);
    if (Number.isFinite(at) && now - at > GOAL_NEWS_MS) return false;
  }
  return true;
}

/** A goal reached longer ago than this is not celebrated. */
export const GOAL_NEWS_MS = 5 * 60_000;
