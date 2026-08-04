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
export const FREE_STREAM_CAP_MS = 60 * 60 * 1000;
export const FREE_STREAM_CAP_LABEL = '1 hour';
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
}

/** The cap that applies to this host. */
export function resolveStreamCap(isPremium: boolean): StreamCap {
  return isPremium
    ? { capMs: PRO_STREAM_CAP_MS, label: PRO_STREAM_CAP_LABEL, warnMs: PRO_STREAM_WARN_REMAINING_MS, isPro: true }
    : { capMs: FREE_STREAM_CAP_MS, label: FREE_STREAM_CAP_LABEL, warnMs: FREE_STREAM_WARN_REMAINING_MS, isPro: false };
}
