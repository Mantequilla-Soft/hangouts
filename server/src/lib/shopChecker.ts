import { config } from '../config.js';
import { checkerShopEnabled, registerShopItem, shopNumber, shopRef, ShopError, type Prepared } from './pointsShop.js';

/**
 * Points shop items the 3Speak checker grants (lib/pointsShop.ts buys them):
 *   publishslot    one more video or Short to publish within 24 hours
 *   story48        a Story kept 48 hours instead of 24
 *   storyfreeze    a missed Story day that keeps the Story streak
 *   premierefront  your name in a premiere's front row
 *   encode         your waiting video encodes first
 *   adcredit       pays a self-promo ad booking at a fixed points rate
 * Before paying, GET /points/grant/check says whether the checker would grant
 * it (so a refusal costs nothing); once paid, PUT /points/grant books it under
 * the spend id, once (POINTS_AWARD_SECRET). A refusal gives the points back.
 */

const CHECKER_TIMEOUT_MS = 8000;

type Fetch = typeof fetch;
let fetchFn: Fetch = (input, init) => fetch(input, init);
/** Tests: answer the checker calls (null: the real fetch). */
export function setShopCheckerFetch(fn: Fetch | null): void { fetchFn = fn ?? ((input, init) => fetch(input, init)); }

let retryDelays = [1000, 3000, 6000];
/** Tests: no waiting. */
export function setShopCheckerRetryDelays(ms: number[]): void { retryDelays = ms; }

const checker = () => config.CHECKER_URL.replace(/\/$/, '');
const unavailable = () => new ShopError(503, 'unavailable', 'This cannot be bought right now. Try again in a minute.');

/** The checker's word before paying: throws 409 with its code when it would refuse. */
export async function checkerCheck(item: string, user: string, fields: Record<string, string | number>): Promise<void> {
  const q = new URLSearchParams({ item, user, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])) });
  let body: { ok?: boolean; error?: string; message?: string };
  try {
    const res = await fetchFn(`${checker()}/points/grant/check?${q}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CHECKER_TIMEOUT_MS),
    });
    if (!res.ok) throw unavailable();
    body = await res.json() as typeof body;
  } catch {
    throw unavailable();
  }
  if (body?.ok === true) return;
  if (body?.ok === false) throw new ShopError(409, body.error || 'refused', body.message || 'This cannot be bought for that.');
  throw unavailable();
}

/**
 * Book the grant under `spendId`. Network errors and 5xx are tried again (the
 * checker grants a spend id once); a 4xx is final. Throws ShopError when not granted.
 */
export async function checkerGrant(item: string, body: Record<string, unknown> & { spendId: string; user: string }): Promise<Record<string, unknown>> {
  const payload = JSON.stringify({ item, ...body });
  for (let attempt = 0; ; attempt += 1) {
    let status = 0;
    let json = null as Record<string, unknown> | null;
    try {
      const res = await fetchFn(`${checker()}/points/grant`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-points-award-secret': config.POINTS_AWARD_SECRET },
        body: payload,
        signal: AbortSignal.timeout(CHECKER_TIMEOUT_MS),
      });
      status = res.status;
      json = await res.json().catch(() => null) as typeof json;
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300 && json?.ok === true) return json;
    const final = status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (final) throw new ShopError(409, String(json?.error ?? 'refused'), String(json?.message ?? 'The checker turned it down.'));
    if (attempt >= retryDelays.length) throw new ShopError(503, 'unavailable', 'It could not be booked.');
    await new Promise((r) => setTimeout(r, retryDelays[attempt]));
  }
}

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const acct = (v: unknown) => str(v).replace(/^@/, '').toLowerCase();

function post(input: Record<string, unknown>, authorKey: string): { author: string; permlink: string } {
  const author = acct(input[authorKey]);
  const permlink = str(input.permlink);
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) throw new ShopError(400, 'invalid', 'Which video is it for?');
  return { author, permlink };
}

interface CheckerItemSpec {
  id: string;
  price: () => number;
  /** The item's fields, checked; plus where it shows in the wallet history. */
  fields(user: string, input: Record<string, unknown>): { fields: Record<string, string | number>; what: string; channel?: string; price?: number };
  quote?: () => Record<string, unknown>;
}

function checkerItem(spec: CheckerItemSpec): void {
  registerShopItem({
    id: spec.id,
    quote: () => ({ enabled: checkerShopEnabled(), price: spec.price(), ...(spec.quote?.() ?? {}) }),
    async prepare(user, input): Promise<Prepared> {
      const f = spec.fields(user, input);
      await checkerCheck(spec.id, user, f.fields);
      return { price: f.price ?? spec.price(), ref: shopRef(spec.id, f.what), ...(f.channel ? { channel: f.channel } : {}), data: f.fields };
    },
    async fulfil(order) {
      return checkerGrant(spec.id, { ...order.data, spendId: order.spendId ?? order.id, user: order.user, points: order.price });
    },
  });
}

checkerItem({
  id: 'publishslot',
  price: () => shopNumber('PUBLISHSLOT', 25_000),
  fields(_user, input) {
    const kind = input.kind === 'short' ? 'short' : input.kind === 'video' ? 'video' : '';
    if (!kind) throw new ShopError(400, 'invalid', 'A video or a Short?');
    return { fields: { kind }, what: kind };
  },
});

checkerItem({
  id: 'story48',
  price: () => shopNumber('STORY48', 2000),
  fields(user, input) {
    const p = post(input, 'author');
    if (p.author !== user) throw new ShopError(403, 'not_yours', 'You can only keep your own Story longer.');
    return { fields: p, what: `${p.author}/${p.permlink}` };
  },
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
checkerItem({
  id: 'storyfreeze',
  price: () => shopNumber('STREAKFREEZE', 1000),
  fields(_user, input) {
    const day = str(input.day);
    if (!DAY_RE.test(day)) throw new ShopError(400, 'invalid', 'Which day?');
    return { fields: { day }, what: day };
  },
});

checkerItem({
  id: 'premierefront',
  price: () => shopNumber('PREMIEREFRONT', 500),
  fields(_user, input) {
    const p = post(input, 'owner');
    return { fields: { owner: p.author, permlink: p.permlink }, what: `${p.author}/${p.permlink}`, channel: p.author };
  },
});

checkerItem({
  id: 'encode',
  price: () => shopNumber('ENCODE', 5000),
  fields(user, input) {
    const p = post(input, 'author');
    if (p.author !== user) throw new ShopError(403, 'not_yours', 'You can only speed up your own videos.');
    return { fields: p, what: `${p.author}/${p.permlink}` };
  },
});

/** Points per HBD of ad credit (the checker caps the HBD per month). */
export const AD_POINTS_PER_HBD = () => shopNumber('AD_PER_HBD', 10_000);

checkerItem({
  id: 'adcredit',
  price: () => AD_POINTS_PER_HBD(),
  quote: () => ({ perHbd: AD_POINTS_PER_HBD() }),
  fields(_user, input) {
    const campaignId = str(input.campaignId);
    const hbd = Math.round(Number(input.hbd) * 1000) / 1000;
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(campaignId)) throw new ShopError(400, 'invalid', 'Which booking?');
    if (!(hbd > 0 && hbd <= 1000)) throw new ShopError(400, 'invalid', 'That is not an amount.');
    return { fields: { campaignId, hbd }, what: campaignId, price: Math.ceil(hbd * AD_POINTS_PER_HBD()) };
  },
});
