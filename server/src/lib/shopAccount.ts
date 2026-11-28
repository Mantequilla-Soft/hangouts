import { existingAccounts } from './pointsToken.js';
import { isoWeek, isoWeekStart, loginDays, setStreakFreezes, utcDay, utcMidnight } from './pointsAwards.js';
import { getPremiumStatus, grantProPass, isUserPremium, passCannotExtend } from './users.js';
import { memoryCol, mongoCol, type Col } from './shopDb.js';
import { checkerCheck, checkerGrant } from './shopChecker.js';
import {
  checkerShopEnabled, monthOf, registerShopItem, resolveOrder, shopNumber, shopRef, shopStores, ShopError,
  type ShopItem, type ShopOrder,
} from './pointsShop.js';
import { stickerChannels } from './shopLive.js';

/**
 * The points shop's account items (lib/pointsShop.ts buys them):
 *   cosmetic      a chat name colour, a badge, an avatar frame or a profile
 *                 theme, for yourself or as a gift
 *   proday        a day of 3Speak Pro, for yourself or as a gift
 *   audiolong     one audio upload 20 minutes past the free cap
 *   streakfreeze  a missed sign-in day that keeps the streak (2 a month)
 *   request       points on a video you ask a creator for: theirs once they
 *                 deliver, back if they do not
 *   spotlight     a bid for next week's home spotlight; the top bid when the
 *                 week starts wins, every other bid comes back
 * And the supporters: who spent the most on a channel (a badge past
 * SHOP_SUPPORTER_MIN) and the monthly board of who spent most on others.
 */

const DAY_MS = 86_400_000;
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const acct = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^@/, '').toLowerCase() : '');
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** `to` when given (a gift: an existing account, not the buyer), else the buyer. */
async function recipient(user: string, input: Record<string, unknown>): Promise<string> {
  const to = acct(input.to);
  if (!to || to === user) return user;
  if (!ACCOUNT_RE.test(to)) throw new ShopError(400, 'invalid', 'That is not a Hive account name.');
  let exists: Set<string>;
  try { exists = await existingAccounts([to]); } catch { throw new ShopError(503, 'unavailable', 'Hive cannot be asked right now. Try again in a minute.'); }
  if (!exists.has(to)) throw new ShopError(404, 'no_account', `There is no Hive account @${to}.`);
  return to;
}

// ── stores ────────────────────────────────────────────────────────────────

export interface EquippedDoc { user: string; equipped: Partial<Record<CosmeticKind, string>>; updatedAt: number }
export interface FreezeDoc { user: string; day: string; month: string; order: string }
export interface AudioGrantDoc { user: string; extraSeconds: number; spendId: string; createdAt: Date; expiresAt: Date; usedAt: Date | null }

export interface AccountShopStores { equipped: Col<EquippedDoc>; freezes: Col<FreezeDoc>; audio: Col<AudioGrantDoc> }

const mongoStores = (): AccountShopStores => ({
  equipped: mongoCol<EquippedDoc>('points-cosmetics', [{ keys: { user: 1 }, unique: true }]),
  freezes: mongoCol<FreezeDoc>('points-streak-freezes', [{ keys: { user: 1, day: 1 }, unique: true }]),
  // Read and used up by snapieaudio's upload (utils/audioLimits.js).
  audio: mongoCol<AudioGrantDoc>('audio_length_grants', [{ keys: { spendId: 1 }, unique: true }, { keys: { user: 1, usedAt: 1, expiresAt: 1 } }]),
});

export function memoryAccountShopStores(): AccountShopStores {
  return { equipped: memoryCol([['user']]), freezes: memoryCol([['user', 'day']]), audio: memoryCol([['spendId']]) };
}

let stores: AccountShopStores | null = null;
export function accountShopStores(): AccountShopStores { return (stores ??= mongoStores()); }
export function setAccountShopStores(next: AccountShopStores | null): void { stores = next; }

// ── cosmetics ─────────────────────────────────────────────────────────────

export type CosmeticKind = 'color' | 'badge' | 'frame' | 'theme';
export interface Cosmetic { kind: CosmeticKind; price: number }

const COSMETIC_PRICE: Record<CosmeticKind, [string, number]> = {
  color: ['COLOR', 2000], badge: ['BADGE', 3000], frame: ['FRAME', 5000], theme: ['THEME', 10_000],
};
/** What can be bought; how each looks is the client's (a colour, an emoji, a frame style). */
export const COSMETIC_IDS: Record<string, CosmeticKind> = {
  'color-gold': 'color', 'color-cyan': 'color', 'color-pink': 'color', 'color-green': 'color', 'color-violet': 'color',
  'badge-flame': 'badge', 'badge-star': 'badge', 'badge-diamond': 'badge', 'badge-crown': 'badge',
  'frame-gold': 'frame', 'frame-neon': 'frame', 'frame-rainbow': 'frame',
  'theme-midnight': 'theme', 'theme-sunset': 'theme', 'theme-forest': 'theme',
};
export function cosmeticsCatalog(): Record<string, Cosmetic> {
  return Object.fromEntries(Object.entries(COSMETIC_IDS).map(([id, kind]) => [id, { kind, price: shopNumber(...COSMETIC_PRICE[kind]) }]));
}

/** What `user` owns (bought or given). */
export async function ownedCosmetics(user: string): Promise<string[]> {
  const rows = await shopStores().orders.find({ item: 'cosmetic', status: 'done', target: user.toLowerCase() }, { limit: 200 });
  return [...new Set(rows.map((o) => String(o.data.id)))];
}

export interface CosmeticsView {
  owned: string[];
  equipped: Partial<Record<CosmeticKind, string>>;
  /** Channels whose sticker set the user unlocked. */
  stickers: string[];
}

/** Public: what `user` wears (GET /users/:account/cosmetics). */
export async function cosmeticsOf(user: string): Promise<CosmeticsView> {
  const u = user.toLowerCase();
  const [owned, doc, stickers] = await Promise.all([
    ownedCosmetics(u), accountShopStores().equipped.findOne({ user: u }), stickerChannels(u),
  ]);
  const equipped: Partial<Record<CosmeticKind, string>> = {};
  for (const [k, id] of Object.entries(doc?.equipped ?? {})) if (id && owned.includes(id)) equipped[k as CosmeticKind] = id;
  return { owned, equipped, stickers };
}

/** Wear (or take off, null) one per kind; only what the user owns. */
export async function equipCosmetics(user: string, input: Record<string, unknown>): Promise<CosmeticsView> {
  const u = user.toLowerCase();
  const owned = await ownedCosmetics(u);
  const set: Record<string, string> = {};
  const unset: Record<string, ''> = {};
  for (const kind of ['color', 'badge', 'frame', 'theme'] as const) {
    if (!(kind in input)) continue;
    const id = input[kind];
    if (id === null || id === '') { unset[`equipped.${kind}`] = ''; continue; }
    if (typeof id !== 'string' || COSMETIC_IDS[id] !== kind || !owned.includes(id)) throw new ShopError(400, 'invalid', 'You do not own that.');
    set[`equipped.${kind}`] = id;
  }
  await accountShopStores().equipped.update({ user: u }, {
    $set: { ...set, updatedAt: Date.now() }, ...(Object.keys(unset).length ? { $unset: unset } : {}),
  }, { upsert: true });
  return cosmeticsOf(u);
}

registerShopItem({
  id: 'cosmetic',
  quote: () => ({ enabled: true, items: cosmeticsCatalog() }),
  async prepare(user, input) {
    const id = typeof input.id === 'string' ? input.id : '';
    const kind = COSMETIC_IDS[id];
    if (!kind) throw new ShopError(404, 'not_found', 'There is no such item.');
    const to = await recipient(user, input);
    if ((await ownedCosmetics(to)).includes(id)) {
      throw new ShopError(409, 'owned', to === user ? 'You already have it.' : `@${to} already has it.`);
    }
    return { price: shopNumber(...COSMETIC_PRICE[kind]), ref: shopRef('cosmetic', to === user ? id : `${id}:${to}`), target: to, data: { id, kind } };
  },
  async fulfil(order) { return { id: order.data.id, to: order.target }; },
});

// ── Pro day pass ──────────────────────────────────────────────────────────

export const PRO_PASS_HOURS = 24;

registerShopItem({
  id: 'proday',
  quote: () => ({ enabled: true, price: shopNumber('PRODAY', 50_000), hours: PRO_PASS_HOURS }),
  async prepare(user, input) {
    const to = await recipient(user, input);
    let status;
    try { status = await getPremiumStatus(to); } catch { throw new ShopError(503, 'unavailable', 'Pro cannot be checked right now.'); }
    if (passCannotExtend(status)) throw new ShopError(409, 'already_pro', to === user ? 'You have Pro already.' : `@${to} has Pro already.`);
    return { price: shopNumber('PRODAY', 50_000), ref: shopRef('proday', to), target: to, data: {} };
  },
  async fulfil(order) {
    const res = await grantProPass(order.target ?? order.user, PRO_PASS_HOURS);
    if (!res.ok) {
      throw res.reason === 'already_premium'
        ? new ShopError(409, 'already_pro', 'That account has Pro already.')
        : new ShopError(503, 'unavailable', 'Pro could not be switched on.');
    }
    return { expiresAt: res.expiresAt, to: order.target };
  },
});

// ── longer audio upload ───────────────────────────────────────────────────

export const AUDIO_EXTRA_SECONDS = 20 * 60;
export const AUDIO_GRANT_DAYS = 30;
export const AUDIO_GRANTS_OPEN_MAX = 3;

/** Unused, unexpired longer-audio grants of `user`. */
export async function audioGrants(user: string, now = new Date()): Promise<AudioGrantDoc[]> {
  return accountShopStores().audio.find({ user: user.toLowerCase(), usedAt: null, expiresAt: { $gt: now } }, { sort: { createdAt: 1 }, limit: 10 });
}

registerShopItem({
  id: 'audiolong',
  quote: () => ({ enabled: true, price: shopNumber('AUDIOLONG', 5000), minutes: AUDIO_EXTRA_SECONDS / 60, days: AUDIO_GRANT_DAYS }),
  async prepare(user) {
    if (await isUserPremium(user)) throw new ShopError(409, 'pro', 'Pro uploads have no such limit.');
    if ((await audioGrants(user)).length >= AUDIO_GRANTS_OPEN_MAX) throw new ShopError(429, 'limit', 'Use the longer uploads you have first.');
    return { price: shopNumber('AUDIOLONG', 5000), ref: shopRef('audiolong', user), data: {} };
  },
  async fulfil(order) {
    const now = new Date();
    const doc: AudioGrantDoc = {
      user: order.user, extraSeconds: AUDIO_EXTRA_SECONDS, spendId: order.spendId ?? order.id,
      createdAt: now, expiresAt: new Date(now.getTime() + AUDIO_GRANT_DAYS * DAY_MS), usedAt: null,
    };
    await accountShopStores().audio.insertOne(doc);
    return { extraSeconds: doc.extraSeconds, expiresAt: doc.expiresAt.toISOString() };
  },
});

// ── streak freeze (sign-in) ───────────────────────────────────────────────

export const FREEZE_LOOKBACK_DAYS = 14;
export const FREEZES_PER_MONTH = 2;

setStreakFreezes(async (user, since) => (await accountShopStores().freezes.find({ user, day: { $gte: utcDay(since) } }, { limit: 60 }))
  .map((f) => f.day));

export const freezesThisMonth = async (user: string, now = Date.now()) =>
  accountShopStores().freezes.count({ user: user.toLowerCase(), month: monthOf(now) });

/** Missed sign-in days of the last two weeks a freeze could still cover. */
export async function missedDays(user: string, now = Date.now()): Promise<string[]> {
  const today = utcMidnight(now);
  const since = today - FREEZE_LOOKBACK_DAYS * DAY_MS;
  const [signed, frozen] = await Promise.all([
    loginDays(user, since),
    accountShopStores().freezes.find({ user, day: { $gte: utcDay(since) } }, { limit: 60 }),
  ]);
  const covered = new Set([...signed, ...frozen.map((f) => f.day)]);
  const out: string[] = [];
  for (let d = 1; d <= FREEZE_LOOKBACK_DAYS; d += 1) {
    const day = utcDay(today - d * DAY_MS);
    if (!covered.has(day)) out.push(day);
  }
  return out;
}

registerShopItem({
  id: 'streakfreeze',
  quote: () => ({ enabled: true, price: shopNumber('STREAKFREEZE', 1000), perMonth: FREEZES_PER_MONTH, days: FREEZE_LOOKBACK_DAYS }),
  async prepare(user, input) {
    const day = typeof input.day === 'string' ? input.day : '';
    if (!(await missedDays(user)).includes(day)) throw new ShopError(409, 'not_needed', 'That day needs no freeze.');
    if (await freezesThisMonth(user) >= FREEZES_PER_MONTH) throw new ShopError(429, 'monthly_limit', `You can freeze ${FREEZES_PER_MONTH} days a month.`);
    return { price: shopNumber('STREAKFREEZE', 1000), ref: shopRef('streakfreeze', day), data: { day } };
  },
  async fulfil(order) {
    const day = String(order.data.day);
    const ok = await accountShopStores().freezes.insertOne({ user: order.user, day, month: monthOf(), order: order.id });
    if (!ok) throw new ShopError(409, 'not_needed', 'That day is covered already.');
    return { day };
  },
});

// ── supporters ────────────────────────────────────────────────────────────

export const SUPPORTER_MIN = () => shopNumber('SUPPORTER_MIN', 10_000);

/** Who spent the most on `channel` in `month` (default: this month). */
export async function channelSupporters(channel: string, month = monthOf(), limit = 20): Promise<{ user: string; points: number }[]> {
  return (await shopStores().support.find({ channel: channel.toLowerCase(), month }, { sort: { points: -1 }, limit }))
    .map((d) => ({ user: d.user, points: d.points }));
}

/** Everyone who spent SUPPORTER_MIN or more on `channel`, all months together: they wear its supporter badge. */
export async function supporterBadges(channel: string): Promise<string[]> {
  const totals = new Map<string, number>();
  for (const d of await shopStores().support.find({ channel: channel.toLowerCase() }, { limit: 20_000 })) {
    totals.set(d.user, (totals.get(d.user) ?? 0) + d.points);
  }
  return [...totals].filter(([, p]) => p >= SUPPORTER_MIN()).sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 500);
}

/** The monthly board: who spent the most points on other people's channels. */
export async function topSupporters(month = monthOf(), limit = 50): Promise<{ user: string; points: number; channels: number }[]> {
  const totals = new Map<string, { points: number; channels: number }>();
  for (const d of await shopStores().support.find({ month }, { limit: 50_000 })) {
    const t = totals.get(d.user) ?? { points: 0, channels: 0 };
    t.points += d.points;
    t.channels += 1;
    totals.set(d.user, t);
  }
  return [...totals].map(([user, t]) => ({ user, ...t })).sort((a, b) => b.points - a.points).slice(0, limit);
}

// ── content requests ──────────────────────────────────────────────────────

export const REQUEST_MIN = () => shopNumber('REQUEST_MIN', 1000);
export const REQUEST_OPEN_DAYS = 14;
export const REQUEST_REVIEW_DAYS = 7;

export interface ContentRequest {
  id: string; from: string; creator: string; text: string; points: number;
  state: 'open' | 'delivered' | 'done' | 'refunded'; permlink?: string; at: number; until?: number;
}
export const requestOf = (o: ShopOrder): ContentRequest => ({
  id: o.id, from: o.user, creator: String(o.data.creator), text: String(o.data.text), points: o.price,
  state: o.status === 'done' ? 'done' : o.status === 'refunded' ? 'refunded' : (o.data.state === 'delivered' ? 'delivered' : 'open'),
  ...(o.data.permlink ? { permlink: String(o.data.permlink) } : {}), at: o.createdAt, ...(o.expiresAt ? { until: o.expiresAt } : {}),
});

const requestItem: ShopItem & { onExpired(o: ShopOrder): Promise<boolean> } = {
  id: 'request',
  quote: () => ({ enabled: true, min: REQUEST_MIN(), openDays: REQUEST_OPEN_DAYS, reviewDays: REQUEST_REVIEW_DAYS }),
  async prepare(user, input) {
    const creator = await recipient(user, { to: input.creator });
    if (creator === user) throw new ShopError(400, 'invalid', 'Ask another creator.');
    const text = clean(input.text, 300);
    if (!text) throw new ShopError(400, 'invalid', 'Say what video you would like.');
    const amount = Math.floor(Number(input.amount));
    if (!(amount >= REQUEST_MIN())) throw new ShopError(400, 'invalid', `Offer at least ${REQUEST_MIN().toLocaleString('en-US')} points.`);
    return {
      price: amount, ref: shopRef('request', creator), channel: creator,
      data: { creator, text, state: 'open' }, hold: true, expiresAt: Date.now() + REQUEST_OPEN_DAYS * DAY_MS,
    };
  },
  async fulfil(order) { return requestOf({ ...order, status: 'held' }); },
  // Delivered and not reviewed in time: the creator gets the points. Never delivered: they come back.
  async onExpired(o) {
    if (o.data.state === 'delivered') return !!(await resolveOrder(o.id, { done: true, payTo: String(o.data.creator) }));
    return false;
  },
};
registerShopItem(requestItem);

/** Requests `user` made (role 'from') or was asked for (role 'creator'), newest first. */
export async function listRequests(user: string, role: 'from' | 'creator'): Promise<ContentRequest[]> {
  const filter = role === 'from' ? { item: 'request', user } : { item: 'request', 'data.creator': user };
  return (await shopStores().orders.find(filter, { sort: { createdAt: -1 }, limit: 100 })).map(requestOf);
}

async function heldRequest(id: string): Promise<ShopOrder> {
  const o = await shopStores().orders.findOne({ id, item: 'request', status: 'held' });
  if (!o) throw new ShopError(404, 'not_found', 'That request is closed.');
  return o;
}

/** The creator delivers (a post of theirs) or says no; the asker approves or takes it back. */
export async function actOnRequest(user: string, id: string, action: 'deliver' | 'decline' | 'approve' | 'cancel', permlink?: string): Promise<ContentRequest> {
  const o = await heldRequest(id);
  const creator = String(o.data.creator);
  const isCreator = user === creator;
  const isAsker = user === o.user;
  let done: ShopOrder | null = null;
  if (action === 'deliver') {
    if (!isCreator) throw new ShopError(403, 'forbidden', 'Only the creator can deliver it.');
    if (o.data.state === 'delivered') throw new ShopError(409, 'delivered', 'You delivered it already.');
    if (!permlink || !/^[a-z0-9-]{1,255}$/.test(permlink)) throw new ShopError(400, 'invalid', 'Which video is it?');
    done = await shopStores().orders.update({ id, status: 'held' }, {
      $set: { 'data.state': 'delivered', 'data.permlink': permlink, expiresAt: Date.now() + REQUEST_REVIEW_DAYS * DAY_MS },
    });
  } else if (action === 'decline') {
    if (!isCreator) throw new ShopError(403, 'forbidden', 'Only the creator can turn it down.');
    done = await resolveOrder(id, { refund: true, reason: 'The creator turned the request down.' });
  } else if (action === 'approve') {
    if (!isAsker) throw new ShopError(403, 'forbidden', 'Only you can approve it.');
    if (o.data.state !== 'delivered') throw new ShopError(409, 'open', 'Nothing was delivered yet.');
    done = await resolveOrder(id, { done: true, payTo: creator });
  } else {
    if (!isAsker) throw new ShopError(403, 'forbidden', 'Only you can take it back.');
    if (o.data.state === 'delivered') throw new ShopError(409, 'delivered', 'It was delivered: approve it, or it is paid in a week.');
    done = await resolveOrder(id, { refund: true, reason: 'Taken back.' });
  }
  if (!done) throw new ShopError(409, 'closed', 'That request is closed.');
  return requestOf(done);
}

// ── home spotlight auction ────────────────────────────────────────────────

export const SPOTLIGHT_MIN = () => shopNumber('SPOTLIGHT_MIN', 20_000);
export const SPOTLIGHT_STEP = () => shopNumber('SPOTLIGHT_STEP', 1000);

/** The auction running now: for next ISO week, closing when it starts. */
export function spotlightAuction(now = Date.now()): { week: string; endsAt: number } {
  const endsAt = isoWeekStart(now) + 7 * DAY_MS;
  return { week: isoWeek(endsAt), endsAt };
}

const heldBids = (week: string) => shopStores().orders.find({ item: 'spotlight', status: 'held', 'data.week': week }, { sort: { price: -1, createdAt: 1 }, limit: 50 });

export async function spotlightState(now = Date.now()): Promise<{ week: string; endsAt: number; min: number; step: number; top: { bid: number; user: string; author: string; permlink: string } | null }> {
  const a = spotlightAuction(now);
  const [top] = await heldBids(a.week);
  return {
    ...a, min: SPOTLIGHT_MIN(), step: SPOTLIGHT_STEP(),
    top: top ? { bid: top.price, user: top.user, author: String(top.data.author), permlink: String(top.data.permlink) } : null,
  };
}

const spotlightItem: ShopItem & { onExpired(o: ShopOrder): Promise<boolean> } = {
  id: 'spotlight',
  quote: () => ({ enabled: checkerShopEnabled(), min: SPOTLIGHT_MIN(), step: SPOTLIGHT_STEP() }),
  async prepare(user, input) {
    const author = acct(input.author);
    const permlink = typeof input.permlink === 'string' ? input.permlink.trim() : '';
    if (!ACCOUNT_RE.test(author) || !/^[a-z0-9-]{1,255}$/.test(permlink)) throw new ShopError(400, 'invalid', 'Which video is it for?');
    const bid = Math.floor(Number(input.bid));
    const s = await spotlightState();
    const need = s.top ? s.top.bid + s.step : s.min;
    if (!(bid >= need)) throw new ShopError(409, 'too_low', `Bid at least ${need.toLocaleString('en-US')} points.`, { min: need });
    await checkerCheck('spotlight', user, { author, permlink, week: s.week, bid });
    return {
      price: bid, ref: shopRef('spotlight', s.week), channel: author,
      data: { author, permlink, week: s.week }, hold: true, expiresAt: s.endsAt,
    };
  },
  // The top bid stays; every lower one comes back at once.
  async fulfil(order) {
    const [top, ...rest] = await heldBids(String(order.data.week));
    const mine = !top || top.id === order.id || top.price < order.price;
    for (const o of rest) if (o.id !== order.id) await resolveOrder(o.id, { refund: true, reason: 'Outbid.' });
    if (top && top.id !== order.id && top.price < order.price) await resolveOrder(top.id, { refund: true, reason: 'Outbid.' });
    if (!mine) throw new ShopError(409, 'too_low', 'Someone bid more just now.');
    return { week: order.data.week, bid: order.price };
  },
  // The week started: the top bid wins (the checker puts it on the home page).
  async onExpired(o) {
    try {
      await checkerGrant('spotlight', {
        spendId: o.spendId ?? o.id, user: o.user, author: o.data.author, permlink: o.data.permlink, week: o.data.week, bid: o.price,
      });
    } catch {
      return false; // refused or unreachable: the sweep refunds it
    }
    return !!(await resolveOrder(o.id, { done: true }));
  },
};
registerShopItem(spotlightItem);
