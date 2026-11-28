import { hangoutsJson, type FetchLike } from './hangoutsHttp.js';
import { spendPoints } from './pointsSpend.js';
import type { HiveOperation } from './vscContract.js';

/**
 * The points shop in the live room: the pure half (no React), so the chat, the
 * viewer dialogs, the studio's host panels and the OBS dock agree, and so it
 * can be tested on its own.
 *
 * Every purchase goes through one route, POST /points/shop/buy, with the same
 * spend handling as a points boost (lib/pointsSpend.ts: 428 sign with the
 * wallet, 202 pending). What was bought shows up on the data channel, from the
 * server only (lib/dataTrust.ts): chat system lines (highlight, reward,
 * bounty, bountydone), `readaloud` on `boost`, `poll-suggestion` on `poll`,
 * and the `rewards` and `bounty` topics.
 */

// ── the catalog ───────────────────────────────────────────────────────────

/** The shop items the live room uses (GET /points/shop has more). */
export type LiveShopItem = 'highlight' | 'readaloud' | 'suggestpoll' | 'reward' | 'bounty' | 'stickers' | 'minutes' | 'cosmetic';

export interface ShopItemQuote {
  enabled: boolean;
  price?: number;
  min?: number;
  max?: number;
  [k: string]: unknown;
}

export interface ShopCatalog {
  items: Record<string, ShopItemQuote>;
  /** Sticker id to emoji. */
  stickers: Record<string, string>;
  cosmetics: Record<string, { kind: CosmeticKind; price: number }>;
  supporterMin: number;
}

/** The channel sticker set (the server's lib/shopLive.ts STICKERS). */
export const DEFAULT_STICKERS: Readonly<Record<string, string>> = {
  fire: '🔥', clap: '👏', party: '🎉', heart: '❤️', laugh: '😂', rocket: '🚀', crown: '👑', trophy: '🏆',
};

/** The prices the server starts from, for a catalog that has not loaded yet. */
export const DEFAULT_SHOP_PRICES: Readonly<Record<string, number>> = {
  highlight: 500, readaloud: 1000, suggestpoll: 2000, bounty: 100, stickers: 1000, minutes: 10_000,
};

const obj = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseShopCatalog(body: unknown): ShopCatalog {
  const b = obj(body) ?? {};
  const items: Record<string, ShopItemQuote> = {};
  for (const [id, q] of Object.entries(obj(b.items) ?? {})) {
    const o = obj(q);
    if (o) items[id] = { ...o, enabled: o.enabled === true };
  }
  const stickers: Record<string, string> = {};
  for (const [id, e] of Object.entries(obj(b.stickers) ?? {})) if (typeof e === 'string' && /^[a-z]{2,20}$/.test(id)) stickers[id] = e;
  const cosmetics: ShopCatalog['cosmetics'] = {};
  for (const [id, c] of Object.entries(obj(b.cosmetics) ?? {})) {
    const o = obj(c);
    if (o && isCosmeticKind(o.kind) && num(o.price) !== undefined) cosmetics[id] = { kind: o.kind, price: o.price as number };
  }
  return {
    items,
    stickers: Object.keys(stickers).length ? stickers : { ...DEFAULT_STICKERS },
    cosmetics,
    supporterMin: num(b.supporterMin) ?? 10_000,
  };
}

/** An item's price and whether it is on sale, from the catalog (or the defaults while it loads). */
export function shopQuote(catalog: ShopCatalog | null, item: string): { enabled: boolean; price: number; min?: number; max?: number } {
  const q = catalog?.items[item];
  if (!catalog) return { enabled: true, price: DEFAULT_SHOP_PRICES[item] ?? 0 };
  if (!q) return { enabled: false, price: DEFAULT_SHOP_PRICES[item] ?? 0 };
  return { enabled: q.enabled, price: num(q.price) ?? num(q.min) ?? DEFAULT_SHOP_PRICES[item] ?? 0, min: num(q.min), max: num(q.max) };
}

// ── stickers ──────────────────────────────────────────────────────────────

/** The sticker a chat line is, when its whole text is `:st-<id>:` for a known id. */
export function stickerIdOf(text: string, stickers: Readonly<Record<string, string>> = DEFAULT_STICKERS): string | null {
  const m = /^:st-([a-z]{2,20}):$/.exec(text.trim());
  return m && Object.prototype.hasOwnProperty.call(stickers, m[1]) ? m[1] : null;
}

export const stickerText = (id: string) => `:st-${id}:`;

/** True when `cosmetics` (the sender's) holds `host`'s sticker set. */
export function ownsStickers(cosmetics: CosmeticsView | null | undefined, host: string | null | undefined): boolean {
  if (!cosmetics || !host) return false;
  const h = host.toLowerCase();
  return cosmetics.stickers.some((c) => c.toLowerCase() === h);
}

// ── cosmetics ─────────────────────────────────────────────────────────────

export type CosmeticKind = 'color' | 'badge' | 'frame' | 'theme';
const isCosmeticKind = (v: unknown): v is CosmeticKind => v === 'color' || v === 'badge' || v === 'frame' || v === 'theme';

export interface CosmeticsView {
  owned: string[];
  equipped: Partial<Record<CosmeticKind, string>>;
  /** The channels whose sticker set this account unlocked. */
  stickers: string[];
}

export const EMPTY_COSMETICS: CosmeticsView = { owned: [], equipped: {}, stickers: [] };

export function parseCosmetics(body: unknown): CosmeticsView {
  const b = obj(body) ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const equipped: CosmeticsView['equipped'] = {};
  for (const [k, v] of Object.entries(obj(b.equipped) ?? {})) {
    if (isCosmeticKind(k) && typeof v === 'string' && COSMETIC_LOOKS[v]?.kind === k) equipped[k] = v;
  }
  return { owned: list(b.owned), equipped, stickers: list(b.stickers) };
}

/** A chat name colour. `color` is the flat colour; the chat mixes it with the
 *  surface's own name colour so it stays readable on light and dark. */
export const NAME_COLORS: Readonly<Record<string, string>> = {
  'color-gold': '#f5b400',
  'color-cyan': '#13c4d6',
  'color-pink': '#ff5fa2',
  'color-green': '#2fbf68',
  'color-violet': '#9b7bff',
};

/** A badge before the chat name. */
export const BADGE_EMOJIS: Readonly<Record<string, string>> = {
  'badge-flame': '🔥',
  'badge-star': '⭐',
  'badge-diamond': '💎',
  'badge-crown': '👑',
};

/** An avatar frame: the class the SDK stylesheet draws (flat rings, no gradient). */
export const FRAME_CLASSES: Readonly<Record<string, string>> = {
  'frame-gold': 'hh-frame hh-frame--gold',
  'frame-neon': 'hh-frame hh-frame--neon',
  'frame-rainbow': 'hh-frame hh-frame--rainbow',
};

/** A profile theme: a class that sets --hh-profile-bg, --hh-profile-text and
 *  --hh-profile-accent (flat colours) for a profile card or channel header. */
export const THEME_CLASSES: Readonly<Record<string, string>> = {
  'theme-midnight': 'hh-profile-theme hh-profile-theme--midnight',
  'theme-sunset': 'hh-profile-theme hh-profile-theme--sunset',
  'theme-forest': 'hh-profile-theme hh-profile-theme--forest',
};

export interface CosmeticLook {
  kind: CosmeticKind;
  /** color: the flat name colour. */
  color?: string;
  /** badge: the emoji. */
  emoji?: string;
  /** frame / theme: the CSS classes (src/styles/points-shop.css). */
  className?: string;
}

/** Every cosmetic id the server sells, and how the SDK draws it. */
export const COSMETIC_LOOKS: Readonly<Record<string, CosmeticLook>> = {
  ...Object.fromEntries(Object.entries(NAME_COLORS).map(([id, color]) => [id, { kind: 'color' as const, color }])),
  ...Object.fromEntries(Object.entries(BADGE_EMOJIS).map(([id, emoji]) => [id, { kind: 'badge' as const, emoji }])),
  ...Object.fromEntries(Object.entries(FRAME_CLASSES).map(([id, className]) => [id, { kind: 'frame' as const, className }])),
  ...Object.fromEntries(Object.entries(THEME_CLASSES).map(([id, className]) => [id, { kind: 'theme' as const, className }])),
};

/** The look of what `cosmetics` wears in chat: a name colour, a badge, a frame. */
export function chatLook(cosmetics: CosmeticsView | null | undefined): { color?: string; badge?: string; frameClass?: string } {
  const e = cosmetics?.equipped ?? {};
  return {
    ...(e.color && NAME_COLORS[e.color] ? { color: NAME_COLORS[e.color] } : {}),
    ...(e.badge && BADGE_EMOJIS[e.badge] ? { badge: BADGE_EMOJIS[e.badge] } : {}),
    ...(e.frame && FRAME_CLASSES[e.frame] ? { frameClass: FRAME_CLASSES[e.frame] } : {}),
  };
}

/** A Hive account name (what the cosmetics and supporters routes take). Guests
 *  (`guest-*`) and OBS observers (`obs-*`) are not. */
export const isHiveAccount = (v: string | null | undefined): v is string =>
  !!v && /^[a-z][a-z0-9.-]{2,15}$/.test(v) && !v.startsWith('guest-') && !v.startsWith('obs-');

// ── live room state ───────────────────────────────────────────────────────

export interface PinnedChat { id: string; from: string; text: string; until: number }

/** The highlighted message pinned on top (room metadata `pinnedChat`), while `until` is ahead. */
export function activePinnedChat(meta: Record<string, unknown>, now = Date.now()): PinnedChat | null {
  const p = obj(meta.pinnedChat);
  if (!p) return null;
  const until = num(p.until);
  const text = str(p.text);
  if (until === undefined || until <= now || !text || !str(p.from)) return null;
  return { id: str(p.id) || `pin-${until}`, from: str(p.from), text, until };
}

export interface PollSuggestion { id: string; from: string; question: string; options: string[]; at: number }
export interface ChannelReward { id?: string; title: string; cost: number; prompt: boolean; enabled: boolean }
export interface Redemption { id: string; from: string; rewardId: string; title: string; cost: number; input?: string; at: number }
export interface Bounty {
  id: string; room?: string; channel?: string; text: string; createdBy: string;
  status: 'open' | 'done' | 'refunded'; total: number; backers: number; createdAt?: number;
}

export function parseSuggestion(v: unknown): PollSuggestion | null {
  const o = obj(v);
  if (!o || !str(o.id) || !str(o.question) || !Array.isArray(o.options)) return null;
  const options = o.options.filter((x): x is string => typeof x === 'string' && !!x);
  if (options.length < 2) return null;
  return { id: str(o.id), from: str(o.from), question: str(o.question), options, at: num(o.at) ?? 0 };
}

export function parseReward(v: unknown): ChannelReward | null {
  const o = obj(v);
  if (!o || !str(o.title) || num(o.cost) === undefined) return null;
  return { ...(str(o.id) ? { id: str(o.id) } : {}), title: str(o.title), cost: o.cost as number, prompt: o.prompt === true, enabled: o.enabled !== false };
}

export function parseRedemption(v: unknown): Redemption | null {
  const o = obj(v);
  if (!o || !str(o.id) || !str(o.title)) return null;
  return {
    id: str(o.id), from: str(o.from), rewardId: str(o.rewardId), title: str(o.title), cost: num(o.cost) ?? 0,
    ...(str(o.input) ? { input: str(o.input) } : {}), at: num(o.at) ?? 0,
  };
}

export function parseBounty(v: unknown): Bounty | null {
  const o = obj(v);
  if (!o || !str(o.id) || !str(o.text)) return null;
  const status = o.status === 'done' || o.status === 'refunded' ? o.status : 'open';
  return {
    id: str(o.id), text: str(o.text), createdBy: str(o.createdBy), status,
    total: Math.max(0, num(o.total) ?? 0), backers: Math.max(0, num(o.backers) ?? 0),
    ...(str(o.room) ? { room: str(o.room) } : {}), ...(str(o.channel) ? { channel: str(o.channel) } : {}),
    ...(num(o.createdAt) !== undefined ? { createdAt: o.createdAt as number } : {}),
  };
}

const listOf = <T>(v: unknown, parse: (x: unknown) => T | null): T[] =>
  (Array.isArray(v) ? v.map(parse).filter((x): x is T => x !== null) : []);

/** Add or replace by id (an update for one that is there), oldest first. */
export function upsertById<T extends { id?: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = [...list];
  next[i] = item;
  return next;
}

// ── server packets (the checked readers live in lib/dataTrust.ts) ─────────

export interface ReadAloudEvent { type: 'readaloud'; id: string; sender: string; message: string; timestamp: number }

export type PollSuggestionPacket =
  | { type: 'poll-suggestion'; suggestion: PollSuggestion }
  | { type: 'poll-suggestion-done'; id: string; status: string };

export type RewardsPacket =
  | { type: 'reward-redeemed'; redemption: Redemption }
  | { type: 'reward-done'; id: string; status: string };

export interface BountyPacket { type: 'bounty'; bounty: Bounty }

/** A read-aloud message counts as news (worth speaking) for this long. */
export const READALOUD_FRESH_MS = 60_000;

/**
 * Speak a read-aloud message? Only when the host reads boosts aloud and has
 * not switched read-aloud messages off. The boost minimum (ttsMinHbd) does
 * not apply: the viewer paid the shop's price. A stale one (a replay) never.
 */
export function planReadAloud(
  event: { timestamp?: number },
  settings: { tts: boolean; readAloud?: boolean },
  now = Date.now(),
): boolean {
  if (!settings.tts || settings.readAloud === false) return false;
  return !(typeof event.timestamp === 'number' && now - event.timestamp >= READALOUD_FRESH_MS);
}

/**
 * The host's read-aloud choice when the server does not keep it in the room
 * metadata (it then answers the boost PATCH without `alerts.readAloud`): kept
 * in this browser, which is where the studio speaks anyway.
 */
const READALOUD_KEY = 'hh-readaloud-off';
export function localReadAloud(): boolean | null {
  try {
    const v = localStorage.getItem(READALOUD_KEY);
    return v === null ? null : v !== '1';
  } catch { return null; }
}
export function saveLocalReadAloud(on: boolean): void {
  try { localStorage.setItem(READALOUD_KEY, on ? '0' : '1'); } catch { /* private mode: the meta value only */ }
}

/** Read-aloud on: the room metadata's value, else this browser's, else on. */
export function readAloudOn(alerts: { readAloud?: boolean } | undefined): boolean {
  if (typeof alerts?.readAloud === 'boolean') return alerts.readAloud;
  return localReadAloud() ?? true;
}

// ── HTTP ──────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

/** The live-room shop routes (docs/api-routes.md "Points shop"). Each throws
 *  HangoutsHttpError with the server's `message` on a refusal. */
export const shopApi = {
  catalog: (base: string, f?: FetchLike) =>
    hangoutsJson<unknown>(base, '/points/shop', null, {}, f).then(parseShopCatalog),
  cosmetics: (base: string, account: string, f?: FetchLike) =>
    hangoutsJson<unknown>(base, `/users/${enc(account)}/cosmetics`, null, {}, f).then(parseCosmetics),
  supporters: (base: string, host: string, f?: FetchLike) =>
    hangoutsJson<{ badges?: unknown }>(base, `/channels/${enc(host)}/supporters`, null, {}, f)
      .then((b) => (Array.isArray(b?.badges) ? b.badges.filter((x): x is string => typeof x === 'string') : [])),
  balance: (base: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<{ balance?: number }>(base, '/points', token, {}, f).then((b) => (typeof b?.balance === 'number' ? b.balance : null)),
  streamExtra: (base: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<{ extraMs?: number }>(base, '/points/stream-extra', token, {}, f).then((b) => Math.max(0, num(b?.extraMs) ?? 0)),

  suggestions: (base: string, room: string, f?: FetchLike) =>
    hangoutsJson<{ suggestions?: unknown }>(base, `/rooms/${enc(room)}/poll-suggestions`, null, {}, f).then((b) => listOf(b?.suggestions, parseSuggestion)),
  acceptSuggestion: (base: string, room: string, id: string, token: string | null, durationSec?: number, f?: FetchLike) =>
    hangoutsJson<{ poll?: unknown }>(base, `/rooms/${enc(room)}/poll-suggestions/${enc(id)}/accept`, token,
      { method: 'POST', body: durationSec ? { durationSec } : {} }, f),
  rejectSuggestion: (base: string, room: string, id: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<{ ok?: boolean }>(base, `/rooms/${enc(room)}/poll-suggestions/${enc(id)}/reject`, token, { method: 'POST', body: {} }, f),

  rewards: (base: string, owner: string, f?: FetchLike) =>
    hangoutsJson<{ rewards?: unknown }>(base, `/channels/${enc(owner)}/rewards`, null, {}, f).then((b) => listOf(b?.rewards, parseReward)),
  saveRewards: (base: string, rewards: ChannelReward[], token: string | null, f?: FetchLike) =>
    hangoutsJson<{ rewards?: unknown }>(base, '/channels/rewards', token, { method: 'PUT', body: { rewards } }, f).then((b) => listOf(b?.rewards, parseReward)),
  rewardQueue: (base: string, room: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<{ queue?: unknown }>(base, `/rooms/${enc(room)}/rewards/queue`, token, {}, f).then((b) => listOf(b?.queue, parseRedemption)),
  rewardAction: (base: string, room: string, id: string, action: 'done' | 'refund', token: string | null, f?: FetchLike) =>
    hangoutsJson<{ ok?: boolean }>(base, `/rooms/${enc(room)}/rewards/${enc(id)}/${action}`, token, { method: 'POST', body: {} }, f),

  bounties: (base: string, room: string, f?: FetchLike) =>
    hangoutsJson<{ bounties?: unknown }>(base, `/rooms/${enc(room)}/bounties`, null, {}, f).then((b) => listOf(b?.bounties, parseBounty)),
  bountyAction: (base: string, room: string, id: string, action: 'done' | 'decline', token: string | null, f?: FetchLike) =>
    hangoutsJson<{ bounty?: unknown }>(base, `/rooms/${enc(room)}/bounties/${enc(id)}/${action}`, token, { method: 'POST', body: {} }, f)
      .then((b) => parseBounty(b?.bounty)),
};

/** Limits the server checks (lib/shopLive.ts), checked here first for a clear message. */
export const REWARDS_MAX = 12;
export const REWARD_COST_MIN = 100;
export const REWARD_COST_MAX = 1_000_000;
export const SHOP_TEXT_MAX = 200;
export const BOUNTY_TEXT_MAX = 120;

// ── buying ────────────────────────────────────────────────────────────────

export interface ShopOrder {
  id: string;
  item: string;
  price: number;
  /** done: it happened. held: paid, waiting for the host (a suggested poll,
   *  a reward, a bounty) or the auction. */
  status: 'paying' | 'held' | 'done' | 'refunded';
  result?: unknown;
  [k: string]: unknown;
}

export type ShopBuyOutcome =
  | { ok: true; order: ShopOrder | null; balance: number | null }
  | { ok: false; message: string; code?: string };

export interface BuyShopItemOptions {
  apiBaseUrl: string;
  /** The session token (Bearer). */
  token: () => string | null;
  item: string;
  /** The item's fields (room, text, question, options, rewardId, ...). */
  fields?: Record<string, unknown>;
  /** Sign and broadcast with the user's wallet (walletSigner). */
  sign?: (ops: HiveOperation[]) => Promise<string>;
  onPending?: () => void;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Buy one shop item: POST /points/shop/buy through spendPoints, so a 428
 * (the wallet signs the burn, then the same request again with burnTx) and a
 * 202 (followed at /points/spends/:id until it is done) work like a points
 * boost. The answer: the order and the new balance, or the server's message.
 */
export async function buyShopItem(opts: BuyShopItemOptions): Promise<ShopBuyOutcome> {
  const base = opts.apiBaseUrl.replace(/\/+$/, '');
  const out = await spendPoints({
    apiBaseUrl: base,
    url: `${base}/points/shop/buy`,
    body: { item: opts.item, ...(opts.fields ?? {}) },
    headers: (): Record<string, string> => {
      const t = opts.token();
      return t ? { Authorization: `Bearer ${t}` } : {};
    },
    sign: opts.sign,
    onPending: opts.onPending,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
  });
  if (!out.ok) return out;
  const order = obj(out.body.order);
  return {
    ok: true,
    order: order && typeof order.id === 'string' ? order as unknown as ShopOrder : null,
    balance: num(out.body.balance) ?? null,
  };
}
