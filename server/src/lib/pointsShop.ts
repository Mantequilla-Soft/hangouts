import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { applyPointsNow, spendPoints } from './points.js';
import { PointsSpendError, registerSpendCompleter, spendOnChain, tokenLive, type SpendPurpose } from './pointsToken.js';
import { memoryCol, mongoCol, type Col } from './shopDb.js';

/**
 * The points shop: every way to spend 3Speak Points that is not a boost, a
 * prediction stake, a promotion or a transfer (those keep their own routes).
 *
 * One buy path for all of them (POST /points/shop/buy):
 *   1. the item checks the request and names its price (`prepare`)
 *   2. the points are paid: the Mongo balance, or a Magi burn once the token
 *      is live (purpose 'shop', finished by the completer below)
 *   3. the item happens (`fulfil`). A throw gives the points back.
 *
 * Some items are held instead of done: the points are paid but wait for
 * someone to decide (a host accepts a suggested poll, a creator delivers a
 * requested video, a spotlight auction closes). `resolveOrder` finishes them:
 * done (the points stay spent, or go to `payTo`), or refunded.
 *
 * Every order paid for something on a channel counts toward that channel's
 * supporters (`points-support`, per month), with points boosts and tips.
 */

export class ShopError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export type OrderStatus = 'paying' | 'held' | 'done' | 'refunded';

export interface ShopOrder {
  id: string;
  user: string;
  item: string;
  price: number;
  /** The ledger ref of the spend ('shop:<item>:<what>'). */
  ref: string;
  /** The account the item is for when not the buyer (a gift, a channel). */
  target?: string;
  /** The channel the points support (a stream's host, a requested creator). */
  channel?: string;
  /** Item fields (the room, the text, the poll, ...). */
  data: Record<string, unknown>;
  status: OrderStatus;
  /** What fulfil returned, for the buyer. */
  result?: unknown;
  /** Who a held order paid out to, when it did. */
  paidTo?: string;
  /** Why it was refunded. */
  reason?: string;
  spendId?: string;
  createdAt: number;
  doneAt?: number;
  /** A held order nobody decided on by then comes back (the sweep). */
  expiresAt?: number;
}

export interface Prepared {
  price: number;
  ref: string;
  target?: string;
  channel?: string;
  data?: Record<string, unknown>;
  /** Held: paid now, decided later (resolveOrder). */
  hold?: boolean;
  expiresAt?: number;
}

export interface ItemQuote {
  enabled: boolean;
  price?: number;
  min?: number;
  max?: number;
  [k: string]: unknown;
}

export interface ShopItem {
  id: string;
  quote(): ItemQuote;
  prepare(user: string, input: Record<string, unknown>): Promise<Prepared>;
  /** Do it, once paid. Throw ShopError (or any error) to give the points back. */
  fulfil(order: ShopOrder): Promise<unknown>;
  /** A held order came back (refund) or is done: tidy up (a queue, a broadcast). */
  onResolved?(order: ShopOrder): Promise<void>;
}

const items = new Map<string, ShopItem>();
export function registerShopItem(item: ShopItem): void { items.set(item.id, item); }
export function shopItem(id: string): ShopItem | undefined { return items.get(id); }

/** Prices and limits: the env can change each (SHOP_<NAME>), never below 1. */
export function shopNumber(name: string, fallback: number): number {
  const n = Math.floor(Number(process.env[`SHOP_${name}`] ?? fallback));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

// ── stores ────────────────────────────────────────────────────────────────

export interface SupportDoc { channel: string; user: string; month: string; points: number }

export interface ShopStores {
  orders: Col<ShopOrder>;
  support: Col<SupportDoc>;
}

const mongoStores = (): ShopStores => ({
  orders: mongoCol<ShopOrder>('points-shop-orders', [
    { keys: { id: 1 }, unique: true },
    { keys: { user: 1, createdAt: -1 } },
    { keys: { item: 1, status: 1 } },
    { keys: { status: 1, expiresAt: 1 } },
  ]),
  support: mongoCol<SupportDoc>('points-support', [
    { keys: { channel: 1, user: 1, month: 1 }, unique: true },
    { keys: { month: 1, points: -1 } },
    { keys: { channel: 1, month: 1, points: -1 } },
  ]),
});

export function memoryShopStores(): ShopStores {
  return { orders: memoryCol<ShopOrder>([['id']]), support: memoryCol<SupportDoc>([['channel', 'user', 'month']]) };
}

let stores: ShopStores | null = null;
export function shopStores(): ShopStores { return (stores ??= mongoStores()); }
/** Tests: memory stores (null: Mongo again). */
export function setShopStores(next: ShopStores | null): void { stores = next; }

// ── supporters ────────────────────────────────────────────────────────────

export const monthOf = (at = Date.now()) => new Date(at).toISOString().slice(0, 7);

/** `user` spent `points` on `channel` (not their own): one more for its supporters. */
export async function recordSupport(user: string, channel: string | undefined, points: number, at = Date.now()): Promise<void> {
  const u = user.toLowerCase();
  const c = channel?.toLowerCase();
  if (!c || c === u || !(points > 0)) return;
  await shopStores().support.update(
    { channel: c, user: u, month: monthOf(at) },
    { $inc: { points: Math.floor(points) } },
    { upsert: true },
  ).catch(() => undefined);
}

// ── buying ────────────────────────────────────────────────────────────────

export const shopRef = (item: string, what: string) => `shop:${item}:${what}`;
const newOrderId = () => `so-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;

export type BuyResult =
  | { order: ShopOrder; balance: number }
  | { pending: true; spendId: string; orderId: string };

/** Turn the request into a paid, fulfilled (or held) order. */
export async function buy(user: string, itemId: string, input: Record<string, unknown> & { burnTx?: string }): Promise<BuyResult> {
  const item = items.get(itemId);
  if (!item) throw new ShopError(404, 'not_found', 'There is no such thing to buy.');
  if (!item.quote().enabled) throw new ShopError(404, 'not_found', 'This cannot be bought right now.');
  const u = user.toLowerCase();
  const p = await item.prepare(u, input);
  const price = Math.floor(p.price);
  if (!(price >= 1)) throw new ShopError(400, 'invalid', 'That costs nothing.');
  const order: ShopOrder = {
    id: newOrderId(), user: u, item: item.id, price, ref: p.ref,
    ...(p.target ? { target: p.target } : {}),
    ...(p.channel ? { channel: p.channel.toLowerCase() } : {}),
    data: p.data ?? {}, status: 'paying', createdAt: Date.now(),
    ...(p.hold && p.expiresAt ? { expiresAt: p.expiresAt } : {}),
  };

  if (await tokenLive()) {
    await shopStores().orders.insertOne(order);
    const purpose: SpendPurpose = { type: 'shop', room: p.ref, item: item.id, order: order.id };
    let res;
    try {
      res = await spendOnChain(u, price, purpose, { burnTx: input.burnTx });
    } catch (err) {
      // Not paid (or paid and refunded by the completer): no order stays open.
      await shopStores().orders.update({ id: order.id, status: 'paying' }, { $set: { status: 'refunded', reason: 'not paid', doneAt: Date.now() } });
      throw err;
    }
    if (res.state === 'pending') {
      await shopStores().orders.update({ id: order.id }, { $set: { spendId: res.spend.id } });
      return { pending: true, spendId: res.spend.id, orderId: order.id };
    }
    const done = await shopStores().orders.findOne({ id: order.id });
    return { order: done ?? order, balance: res.balance };
  }

  const balance = await spendPoints(u, price, p.ref);
  if (balance === null) throw new PointsSpendError(400, 'insufficient', 'You do not have that many points.');
  await shopStores().orders.insertOne(order);
  try {
    return { order: await fulfilOrder(order), balance: balance };
  } catch (err) {
    await applyPointsNow(new Map([[u, price]]), 'refund', p.ref).catch(() => undefined);
    const why = err instanceof Error ? err.message : 'It could not happen.';
    if (err instanceof ShopError) throw new ShopError(err.status, err.code, `${why} Your points are back.`, err.extra);
    throw new ShopError(503, 'unavailable', `${why} Your points are back.`);
  }
}

/** Paid: run the item. Held items wait; the rest are done. Throws when it cannot happen (the caller refunds). */
async function fulfilOrder(order: ShopOrder): Promise<ShopOrder> {
  const item = items.get(order.item);
  if (!item) throw new ShopError(409, 'gone', 'This cannot be bought any more.');
  let result: unknown;
  try {
    result = await item.fulfil(order);
  } catch (err) {
    await shopStores().orders.update({ id: order.id }, {
      $set: { status: 'refunded', reason: err instanceof Error ? err.message : 'failed', doneAt: Date.now() },
    });
    throw err;
  }
  const held = !!order.expiresAt;
  const patch: Partial<ShopOrder> = {
    status: held ? 'held' : 'done', ...(result !== undefined ? { result } : {}), ...(held ? {} : { doneAt: Date.now() }),
    ...(order.spendId ? { spendId: order.spendId } : {}),
  };
  const next = await shopStores().orders.update({ id: order.id }, { $set: patch }) ?? { ...order, ...patch };
  if (!held) await recordSupport(order.user, order.channel, order.price);
  return next;
}

// A confirmed shop burn: run the item. A throw refunds the points (lib/pointsToken.ts).
registerSpendCompleter('shop', async (spend) => {
  const p = spend.purpose;
  if (p.type !== 'shop') throw new Error('Not a shop order.');
  const order = await shopStores().orders.findOne({ id: p.order });
  if (!order) throw new Error('That order is gone.');
  const done = await fulfilOrder({ ...order, spendId: spend.id });
  return { order: done };
});

/**
 * Finish a held order: 'done' keeps the points spent (or pays them to
 * `payTo`), 'refund' gives them back. Once only: false when it was already
 * finished (by the other side, or the sweep).
 */
export async function resolveOrder(id: string, how: { done: true; payTo?: string; result?: unknown } | { refund: true; reason: string }): Promise<ShopOrder | null> {
  const now = Date.now();
  const patch: Partial<ShopOrder> = 'refund' in how
    ? { status: 'refunded', reason: how.reason, doneAt: now }
    : { status: 'done', doneAt: now, ...(how.payTo ? { paidTo: how.payTo.toLowerCase() } : {}), ...(how.result !== undefined ? { result: how.result } : {}) };
  const order = await shopStores().orders.update({ id, status: 'held' }, { $set: patch });
  if (!order) return null;
  if ('refund' in how) {
    await applyPointsNow(new Map([[order.user, order.price]]), 'refund', order.ref);
  } else {
    if (how.payTo) await applyPointsNow(new Map([[how.payTo.toLowerCase(), order.price]]), 'payout', order.ref);
    await recordSupport(order.user, order.channel, order.price);
  }
  await items.get(order.item)?.onResolved?.(order).catch(() => undefined);
  return order;
}

/** Held orders nobody decided on in time come back (every minute). */
export async function sweepShop(now = Date.now()): Promise<number> {
  let n = 0;
  for (const o of await shopStores().orders.find({ status: 'held', expiresAt: { $lte: now } }, { limit: 200 })) {
    const item = items.get(o.item) as (ShopItem & { onExpired?: (o: ShopOrder) => Promise<boolean> }) | undefined;
    // An item may settle on its own when time runs out (an auction closing).
    if (item?.onExpired && await item.onExpired(o).catch(() => false)) { n += 1; continue; }
    if (await resolveOrder(o.id, { refund: true, reason: 'Nobody answered in time.' })) n += 1;
  }
  return n;
}

/** The catalog for clients (GET /points/shop). */
export function shopCatalog(): Record<string, ItemQuote> {
  const out: Record<string, ItemQuote> = {};
  for (const [id, item] of items) out[id] = item.quote();
  return out;
}

/** One of the user's orders (the client follows a pending one). */
export async function orderFor(user: string, id: string): Promise<ShopOrder | null> {
  const o = await shopStores().orders.findOne({ id });
  return o && o.user === user.toLowerCase() ? o : null;
}

/** True when the shop can reach the checker (the items it fulfils need it). */
export function checkerShopEnabled(): boolean { return !!config.POINTS_AWARD_SECRET; }
