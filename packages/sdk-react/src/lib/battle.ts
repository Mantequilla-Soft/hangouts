import { formatHbd } from './boostGoals.js';

export { formatHbd as formatBattleHbd };

/**
 * Live battles (H16), client side: reading the `battle` object the server
 * writes into the room metadata of BOTH streams, deriving the phase from its
 * timestamps, and the viewer text. See server/src/lib/battles.ts.
 */

export type BattleSideKey = 'a' | 'b';
export type BattleEndReason = 'time' | 'ended' | 'dropped' | 'declined' | 'expired' | 'cancelled';

export interface BattleSide {
  host: string;
  room: string;
  title?: string;
  hbd: number;
  count: number;
}

export interface Battle {
  id: string;
  state: 'invited' | 'live' | 'ended';
  durationSec: number;
  a: BattleSide;
  b: BattleSide;
  invitedAt: string;
  expiresAt: string;
  startedAt?: string;
  endsAt?: string;
  settleAt?: string;
  endedAt?: string;
  winner?: BattleSideKey | 'tie' | null;
  endReason?: BattleEndReason;
  endedBy?: string;
}

/**
 * invited   an open invite (the studios show it, viewers don't)
 * starting  accepted, a few seconds before the clock starts
 * live      counting boosts
 * settling  the clock ran out, the last boosts are still arriving
 * result    the winner banner, for RESULT_SHOW_MS after the end
 */
export type BattlePhase = 'invited' | 'starting' | 'live' | 'settling' | 'result';

export const BATTLE_DURATIONS = [180, 300, 600] as const;
/** Keep in step with the server's RESULT_SHOW_MS and DROP_GRACE_MS. */
export const RESULT_SHOW_MS = 15_000;
export const DROP_GRACE_MS = 30_000;
/** The opponent's program track and their mix-minus (their mix without us). */
export const PROGRAM_VIDEO_TRACK = 'studio-program';
export const MONITOR_AUDIO_TRACK = 'host-monitor';

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function readSide(v: unknown): BattleSide | null {
  const o = asObj(v);
  if (!o || typeof o.host !== 'string' || typeof o.room !== 'string' || !o.host || !o.room) return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  return { host: o.host, room: o.room, ...(typeof o.title === 'string' ? { title: o.title } : {}), hbd: num(o.hbd), count: num(o.count) };
}

/** The battle in a room's metadata (object or JSON string), or null. */
export function readBattle(meta: unknown): Battle | null {
  let m: unknown = meta;
  if (typeof meta === 'string') {
    try { m = JSON.parse(meta); } catch { return null; }
  }
  const o = asObj(asObj(m)?.battle);
  if (!o || typeof o.id !== 'string') return null;
  if (o.state !== 'invited' && o.state !== 'live' && o.state !== 'ended') return null;
  const a = readSide(o.a);
  const b = readSide(o.b);
  if (!a || !b) return null;
  return { ...(o as unknown as Battle), a, b, durationSec: typeof o.durationSec === 'number' ? o.durationSec : 300 };
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/** Where the battle is at `now`; null when there is nothing to show. With
 *  `all`, a declined / expired / withdrawn invite is a result too (the
 *  studios say so; viewers never saw the invite). */
export function battlePhase(b: Battle | null, now: number, all = false): BattlePhase | null {
  if (!b) return null;
  if (b.state === 'invited') return now < ms(b.expiresAt) ? 'invited' : null;
  if (b.state === 'live') {
    if (now < ms(b.startedAt)) return 'starting';
    if (now < ms(b.endsAt)) return 'live';
    return 'settling';
  }
  const shown = all || b.endReason === 'time' || b.endReason === 'ended' || b.endReason === 'dropped';
  return shown && now < ms(b.endedAt) + RESULT_SHOW_MS ? 'result' : null;
}

/** The phases where the split screen is up. */
export function battleOnAir(phase: BattlePhase | null): boolean {
  return phase === 'starting' || phase === 'live' || phase === 'settling';
}

/** Which side `room` is, falling back to `host` (a studio knows both). */
export function battleSide(b: Battle, room?: string, host?: string): BattleSideKey | null {
  if (room && b.a.room === room) return 'a';
  if (room && b.b.room === room) return 'b';
  if (host && b.a.host === host) return 'a';
  if (host && b.b.host === host) return 'b';
  return null;
}

export const otherSide = (s: BattleSideKey): BattleSideKey => (s === 'a' ? 'b' : 'a');

/** Milliseconds to the next milestone the countdown shows. */
export function battleRemainingMs(b: Battle, now: number): number {
  const phase = battlePhase(b, now, true);
  if (phase === 'invited') return Math.max(0, ms(b.expiresAt) - now);
  if (phase === 'starting') return Math.max(0, ms(b.startedAt) - now);
  if (phase === 'live') return Math.max(0, ms(b.endsAt) - now);
  return 0;
}

/** m:ss */
export function formatBattleClock(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** This side's share of the meter, 0..1 (0.5 before the first boost). */
export function battleShare(b: Battle, side: BattleSideKey): number {
  const mine = b[side].hbd;
  const total = b.a.hbd + b.b.hbd;
  return total > 0 ? mine / total : 0.5;
}

/** Viewer text for the meter and the banner. Placeholders `{x}` are filled
 *  by the SDK. Integrators pass any subset translated. */
export interface BattleLabels {
  /** The small tag on the meter. */
  title: string;
  /** {seconds} */
  startsIn: string;
  /** {time} */
  timeLeft: string;
  counting: string;
  /** {amount} */
  amount: string;
  /** {name} */
  wins: string;
  tie: string;
  endedEarly: string;
  /** {name}: the host who left. */
  dropped: string;
  /** {name}: a hint under the meter, which side your boost helps. */
  boostHint: string;
  /** {name} (studios only: an invite that came to nothing). */
  declined: string;
  /** {name} */
  expired: string;
  withdrawn: string;
}

export const DEFAULT_BATTLE_LABELS: BattleLabels = {
  title: 'Battle',
  startsIn: 'Starts in {seconds}',
  timeLeft: '{time} left',
  counting: 'Counting the last boosts…',
  amount: '{amount} HBD',
  wins: '@{name} wins!',
  tie: "It's a tie!",
  endedEarly: 'The battle ended early',
  dropped: 'The battle ended: @{name} left',
  boostHint: 'Boosts here count for @{name}',
  declined: '@{name} said no this time',
  expired: 'No answer from @{name}',
  withdrawn: 'The invite was withdrawn',
};

export function battleLabels(over?: Partial<BattleLabels>): BattleLabels {
  const out = { ...DEFAULT_BATTLE_LABELS };
  if (over) {
    for (const k of Object.keys(out) as Array<keyof BattleLabels>) {
      const v = over[k];
      if (typeof v === 'string' && v) out[k] = v;
    }
  }
  return out;
}

export function fillBattle(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/** The banner line for an ended battle. */
export function battleResultText(b: Battle, L: BattleLabels): string {
  if (b.endReason === 'time') {
    if (b.winner === 'a') return fillBattle(L.wins, { name: b.a.host });
    if (b.winner === 'b') return fillBattle(L.wins, { name: b.b.host });
    return L.tie;
  }
  if (b.endReason === 'dropped' && b.endedBy) return fillBattle(L.dropped, { name: b.endedBy });
  if (b.endReason === 'declined') return fillBattle(L.declined, { name: b.b.host });
  if (b.endReason === 'expired') return fillBattle(L.expired, { name: b.b.host });
  if (b.endReason === 'cancelled') return L.withdrawn;
  return L.endedEarly;
}
