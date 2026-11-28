import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { applyPointsNow, spendPoints } from './points.js';
import { PointsSpendError, registerSpendCompleter, spendOnChain, tokenLive, type SpendPurpose } from './pointsToken.js';

/**
 * Promote a 3Speak video (Discover #1) with points, PROMOTE_POINTS_PER_24H a
 * day. The checker owns the promotion: it says whether a video can be
 * promoted and for how many days (GET /promote/eligible/:author/:permlink),
 * and books it (PUT /promote/points, POINTS_AWARD_SECRET), once per spend id.
 *
 *   token on   the user burns the points first (spendOnChain); the 'promote'
 *              completer below books it once Magi confirms the burn.
 *   token off  the Mongo balance pays, the booking follows at once, and the
 *              points come back when the checker turns it down.
 *
 * The spend's ledger ref is 'promote:<author>/<permlink>', so the wallet
 * history can say which video it was for.
 */

export const PROMOTE_MAX_DAYS = 7;
const CHECKER_TIMEOUT_MS = 8000;

type Fetch = typeof fetch;
let fetchFn: Fetch = (input, init) => fetch(input, init);
/** Tests: answer the checker calls (null: the real fetch). */
export function setPromoteFetch(fn: Fetch | null): void { fetchFn = fn ?? ((input, init) => fetch(input, init)); }

/** Waits between booking attempts: a network error or a 5xx is tried again. */
let retryDelays = [1000, 3000, 6000];
/** Tests: no waiting. */
export function setPromoteRetryDelays(ms: number[]): void { retryDelays = ms; }

export class PromoteError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export function promoteEnabled(): boolean {
  return !!config.POINTS_AWARD_SECRET;
}

export function promoteQuote(): { per24h: number; maxDays: number; enabled: boolean } {
  return { per24h: config.PROMOTE_POINTS_PER_24H, maxDays: PROMOTE_MAX_DAYS, enabled: promoteEnabled() };
}

export const promoteRef = (author: string, permlink: string) => `promote:${author}/${permlink}`;

const checker = () => config.CHECKER_URL.replace(/\/$/, '');
const unavailable = () => new PromoteError(503, 'unavailable', 'Promotions cannot be booked right now. Try again in a minute.');

export interface Eligibility { eligible: boolean; reason?: string; promotedUntil: unknown; maxDays: number }

/** The checker's word on this video. Throws 503 when it does not answer. */
export async function promoteEligibility(author: string, permlink: string): Promise<Eligibility> {
  let body: Partial<Eligibility> & { success?: boolean };
  try {
    const res = await fetchFn(`${checker()}/promote/eligible/${encodeURIComponent(author)}/${encodeURIComponent(permlink)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CHECKER_TIMEOUT_MS),
    });
    if (!res.ok) throw unavailable();
    body = await res.json() as typeof body;
  } catch {
    throw unavailable();
  }
  if (typeof body?.eligible !== 'boolean') throw unavailable();
  const maxDays = Math.max(0, Math.floor(Number(body.maxDays) || 0));
  return { eligible: body.eligible, ...(body.reason ? { reason: String(body.reason) } : {}), promotedUntil: body.promotedUntil ?? null, maxDays };
}

/** The checker said no for good (or kept failing): the points come back. */
export class PromoteCreditError extends Error {
  constructor(message: string, public transient: boolean) { super(message); }
}

const refusals: Record<string, string> = {
  not_found: 'That video cannot be found.',
  ineligible: 'That video cannot be promoted.',
  too_long: 'That runs longer than a promotion can.',
};

/**
 * Book `days` for the video under `spendId` (PUT /promote/points). The
 * checker credits a spend id once, so a retry after a lost answer is safe:
 * network errors and 5xx are tried again; 4xx is final.
 */
export async function creditPromotion(input: { spendId: string; user: string; author: string; permlink: string; days: number; points: number }): Promise<{ promotedUntil: unknown }> {
  const body = JSON.stringify({
    author: input.author, permlink: input.permlink, days: input.days, spendId: input.spendId, user: input.user, points: input.points,
  });
  for (let attempt = 0; ; attempt += 1) {
    let status = 0;
    let json = null as { promotedUntil?: unknown; code?: string } | null;
    try {
      const res = await fetchFn(`${checker()}/promote/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-points-award-secret': config.POINTS_AWARD_SECRET },
        body,
        signal: AbortSignal.timeout(CHECKER_TIMEOUT_MS),
      });
      status = res.status;
      json = await res.json().catch(() => null) as typeof json;
    } catch {
      status = 0; // no answer
    }
    if (status >= 200 && status < 300 && json && json.promotedUntil !== undefined) return { promotedUntil: json.promotedUntil };
    const final = status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (final) throw new PromoteCreditError(refusals[json?.code ?? ''] ?? 'The promotion was turned down.', false);
    if (attempt >= retryDelays.length) throw new PromoteCreditError('The promotion could not be booked.', true);
    await new Promise((r) => setTimeout(r, retryDelays[attempt]));
  }
}

export type PromoteResult = { promotedUntil: unknown; balance: number } | { pending: true; spendId: string };

/**
 * Spend the user's points on promoting author/permlink for `days`. Checks the
 * video with the checker first, so a video that cannot be promoted costs
 * nothing. Throws PromoteError (route shapes) or PointsSpendError (spend shapes).
 */
export async function promoteWithPoints(input: { user: string; author: string; permlink: string; days: number; burnTx?: string }): Promise<PromoteResult> {
  if (!promoteEnabled()) throw new PromoteError(404, 'not_found', 'Not found');
  const user = input.user.toLowerCase();
  const author = input.author.toLowerCase();
  const permlink = input.permlink;
  const days = Math.floor(Number(input.days));
  if (!Number.isInteger(days) || days < 1 || days > PROMOTE_MAX_DAYS) {
    throw new PromoteError(400, 'invalid', `A promotion runs 1 to ${PROMOTE_MAX_DAYS} days.`);
  }

  const e = await promoteEligibility(author, permlink);
  if (!e.eligible) throw new PromoteError(409, 'ineligible', 'This video cannot be promoted.', { reason: e.reason ?? 'unavailable' });
  if (days > e.maxDays) {
    throw new PromoteError(400, 'too_long', e.maxDays > 0
      ? `This video can be promoted for ${e.maxDays} more day${e.maxDays === 1 ? '' : 's'} at most.`
      : 'This video is already promoted for as long as it can be.', { maxDays: e.maxDays });
  }

  const amount = config.PROMOTE_POINTS_PER_24H * days;
  const ref = promoteRef(author, permlink);

  // The token: burn first, booked by the 'promote' completer once confirmed.
  if (await tokenLive()) {
    const purpose: SpendPurpose = { type: 'promote', room: ref, author, permlink, days };
    const res = await spendOnChain(user, amount, purpose, { burnTx: input.burnTx });
    if (res.state === 'pending') return { pending: true, spendId: res.spend.id };
    return { promotedUntil: (res.result as { promotedUntil?: unknown } | null)?.promotedUntil ?? null, balance: res.balance };
  }

  const balance = await spendPoints(user, amount, ref);
  if (balance === null) throw new PointsSpendError(400, 'insufficient', 'You do not have that many points.');
  try {
    const { promotedUntil } = await creditPromotion({ spendId: `m-${randomBytes(8).toString('hex')}`, user, author, permlink, days, points: amount });
    return { promotedUntil, balance };
  } catch (err) {
    // Not booked: give the points back.
    await applyPointsNow(new Map([[user, amount]]), 'refund', ref).catch(() => undefined);
    const transient = !(err instanceof PromoteCreditError) || err.transient;
    const why = err instanceof Error ? err.message : 'The promotion could not be booked.';
    if (transient) throw new PointsSpendError(503, 'unavailable', `${why} Your points are back.`);
    throw new PointsSpendError(409, 'failed', `${why} Your points are back.`);
  }
}

// A confirmed promote burn: book it on the checker under the spend id. A throw
// (turned down, or no answer after the retries) refunds the points.
registerSpendCompleter('promote', async (spend) => {
  const p = spend.purpose;
  if (p.type !== 'promote') throw new Error('Not a promotion.');
  return creditPromotion({ spendId: spend.id, user: spend.user, author: p.author, permlink: p.permlink, days: p.days, points: spend.amount });
});
