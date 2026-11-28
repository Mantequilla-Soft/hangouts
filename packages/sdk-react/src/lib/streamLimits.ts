/**
 * Time caps for standalone streams.
 *
 * BOTH tiers are capped now. Free (non-Pro) streams get a short cap; Pro streams
 * get a long one — a safety ceiling that sits BELOW the egress janitor's 6-hour
 * kill (/opt/livekit/egress-janitor.sh), so a marathon Pro stream is stopped
 * cleanly here — with its VOD saved — before the janitor force-kills the egress
 * mid-recording and truncates it. The studio warns as either cap approaches and
 * then stops exactly like the host hitting Stop.
 *
 * The label is user-facing copy in two places (the create dialog's hint and the
 * studio's countdown), so it must stay in step with the ms value — both come
 * from here for exactly that reason.
 */

// --- Free (non-Pro) ---------------------------------------------------------
// 30 minutes (owner, 2026-10-21; was 1 hour). Also the length of a free host's
// published recording: the server stops that egress here too (permissions.ts).
export const FREE_STREAM_CAP_MS = 30 * 60 * 1000;
export const FREE_STREAM_CAP_LABEL = '30 minutes';
export const FREE_STREAM_WARN_REMAINING_MS = [15, 5, 1].map((m) => m * 60 * 1000);

// --- Pro -------------------------------------------------------------------
export const PRO_STREAM_CAP_MS = 4 * 60 * 60 * 1000;
export const PRO_STREAM_CAP_LABEL = '4 hours';
export const PRO_STREAM_WARN_REMAINING_MS = [15, 5, 1].map((m) => m * 60 * 1000);

export interface StreamCap {
  capMs: number;
  label: string;
  /** Minutes-remaining marks at which to warn, each fired once. */
  warnMs: number[];
  isPro: boolean;
  /** Time bought with points on top of the free cap (0 for Pro). */
  extraMs: number;
}

/** "30 minutes", "1 hour", "1 hour 30 minutes": the cap as the studio says it. */
export function capLabel(ms: number): string {
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hours = h ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const mins = m || !h ? `${m} minute${m === 1 ? '' : 's'}` : '';
  return [hours, mins].filter(Boolean).join(' ');
}

/**
 * The cap that applies to this host. `extraMs` is the stream time a free host
 * bought with points for today (GET /points/stream-extra, the points shop's
 * `minutes`): it adds to the free cap. Pro streams are not extended.
 */
export function resolveStreamCap(isPremium: boolean, extraMs = 0): StreamCap {
  if (isPremium) {
    return { capMs: PRO_STREAM_CAP_MS, label: PRO_STREAM_CAP_LABEL, warnMs: PRO_STREAM_WARN_REMAINING_MS, isPro: true, extraMs: 0 };
  }
  const extra = Number.isFinite(extraMs) && extraMs > 0 ? extraMs : 0;
  return {
    capMs: FREE_STREAM_CAP_MS + extra,
    label: extra ? capLabel(FREE_STREAM_CAP_MS + extra) : FREE_STREAM_CAP_LABEL,
    warnMs: FREE_STREAM_WARN_REMAINING_MS,
    isPro: false,
    extraMs: extra,
  };
}
