import { randomBytes } from 'node:crypto';
import { addBacklogMessage, type BacklogMessage, type BacklogSystem } from './chatBacklog.js';
import { readRoomMeta, sendRoomData, type LiveRoomMeta } from './liveRoom.js';
import { mutateRoomMetadata } from './roomMeta.js';
import { OPTION_MAX, QUESTION_MAX } from './polls.js';
import { isUserPremium } from './users.js';
import { memoryCol, mongoCol, type Col } from './shopDb.js';
import {
  registerShopItem, resolveOrder, shopNumber, shopRef, shopStores, ShopError, type ShopOrder,
} from './pointsShop.js';

/**
 * The points shop's live-stream items (lib/pointsShop.ts buys them):
 *   highlight    a chat line that stands out and stays pinned on top a minute
 *   readaloud    a short message the stream reads aloud, no full boost
 *   suggestpoll  a poll for the host to run; back if the host says no
 *   reward       the host's own channel rewards, queued for the host
 *   bounty       viewers pool points on a challenge; the host gets them
 *                when it is done, otherwise they come back
 *   stickers     a channel's sticker set, unlocked for good
 *   minutes      30 more minutes past the free stream cap, for today
 */

export const TEXT_MAX = 200;
export const HIGHLIGHT_PIN_MS = 60_000;
export const SUGGEST_TTL_MS = 30 * 60_000;
export const SUGGEST_OPEN_MAX = 3;
export const REWARD_TTL_MS = 24 * 60 * 60_000;
export const REWARDS_MAX = 12;
export const REWARD_COST_MIN = 100;
export const REWARD_COST_MAX = 1_000_000;
export const BOUNTY_TTL_MS = 6 * 60 * 60_000;
export const BOUNTY_OPEN_MAX = 5;
export const EXTRA_MINUTES_MS = 30 * 60_000;
export const EXTRA_PER_DAY_MAX = 4;

/** The sticker set a channel's viewers unlock (shown big in chat as `:st-<id>:`). */
export const STICKERS: Record<string, string> = {
  fire: '🔥', clap: '👏', party: '🎉', heart: '❤️', laugh: '😂', rocket: '🚀', crown: '👑', trophy: '🏆',
};

// ── stores ────────────────────────────────────────────────────────────────

export interface ChannelReward { id: string; title: string; cost: number; prompt: boolean; enabled: boolean }
export interface RewardsDoc { owner: string; rewards: ChannelReward[]; updatedAt: number }
export interface BountyDoc {
  id: string; room: string; channel: string; text: string; createdBy: string;
  status: 'open' | 'done' | 'refunded'; total: number; backers: number; createdAt: number; doneAt?: number;
}
export interface ExtraDoc { user: string; day: string; ms: number; buys: number; expires?: Date }

export interface LiveShopStores { rewards: Col<RewardsDoc>; bounties: Col<BountyDoc>; extra: Col<ExtraDoc> }

const mongoStores = (): LiveShopStores => ({
  rewards: mongoCol<RewardsDoc>('channel-rewards', [{ keys: { owner: 1 }, unique: true }]),
  bounties: mongoCol<BountyDoc>('points-bounties', [{ keys: { id: 1 }, unique: true }, { keys: { room: 1, status: 1 } }]),
  extra: mongoCol<ExtraDoc>('stream-extra', [{ keys: { user: 1, day: 1 }, unique: true }, { keys: { expires: 1 }, expireAfterSeconds: 0 }]),
});

export function memoryLiveShopStores(): LiveShopStores {
  return { rewards: memoryCol([['owner']]), bounties: memoryCol([['id']]), extra: memoryCol([['user', 'day']]) };
}

let stores: LiveShopStores | null = null;
export function liveShopStores(): LiveShopStores { return (stores ??= mongoStores()); }
export function setLiveShopStores(next: LiveShopStores | null): void { stores = next; }

// ── helpers ───────────────────────────────────────────────────────────────

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const idPart = () => randomBytes(4).toString('hex');
const utcDay = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

/** The live room an item is for, and its host. 404 when it is not live. */
async function liveRoom(input: Record<string, unknown>): Promise<{ room: string; meta: LiveRoomMeta; host: string }> {
  const room = typeof input.room === 'string' ? input.room : '';
  if (!/^[a-z0-9.-]{3,64}$/.test(room)) throw new ShopError(400, 'invalid', 'Which stream is it for?');
  let meta: LiveRoomMeta | null;
  try { meta = await readRoomMeta(room); } catch { meta = null; }
  const host = typeof meta?.host === 'string' ? meta.host.toLowerCase() : '';
  if (!meta || !host) throw new ShopError(404, 'not_live', 'This stream is not live.');
  return { room, meta, host };
}

/** A line in the room's chat written by the server, in the backlog too. */
async function systemLine(room: string, line: Omit<BacklogMessage, 'timestamp'> & { system: BacklogSystem }): Promise<void> {
  const full = { ...line, timestamp: Date.now() };
  addBacklogMessage(room, full);
  await sendRoomData(room, 'chat', { type: 'system', ...full });
}

const heldInRoom = (item: string, room: string) => shopStores().orders.find(
  { item, status: 'held', 'data.room': room }, { sort: { createdAt: 1 }, limit: 200 },
);

// ── highlight ─────────────────────────────────────────────────────────────

registerShopItem({
  id: 'highlight',
  quote: () => ({ enabled: true, price: shopNumber('HIGHLIGHT', 500), pinSeconds: HIGHLIGHT_PIN_MS / 1000, max: TEXT_MAX }),
  async prepare(user, input) {
    const { room, host } = await liveRoom(input);
    const text = clean(input.text, TEXT_MAX);
    if (!text) throw new ShopError(400, 'invalid', 'Write your message.');
    return { price: shopNumber('HIGHLIGHT', 500), ref: shopRef('highlight', host), channel: host, data: { room, text } };
  },
  async fulfil(order) {
    const room = String(order.data.room);
    const until = Date.now() + HIGHLIGHT_PIN_MS;
    const id = `hl-${order.id}`;
    await systemLine(room, {
      id, identity: order.user, name: order.user, text: String(order.data.text),
      system: { kind: 'highlight', from: order.user, until },
    });
    // Pinned on top of the chat for a minute (the client hides it after `until`).
    await mutateRoomMetadata(room, (m) => ({ ...m, pinnedChat: { id, from: order.user, text: order.data.text, until } }))
      .catch(() => undefined);
    return { id, until };
  },
});

// ── read-aloud ────────────────────────────────────────────────────────────

/** The host turned read-aloud messages off (meta.boost.alerts.readAloud === false). */
const readAloudOff = (meta: LiveRoomMeta) =>
  ((meta as { boost?: { alerts?: { readAloud?: unknown } } }).boost?.alerts?.readAloud === false);

registerShopItem({
  id: 'readaloud',
  quote: () => ({ enabled: true, price: shopNumber('READALOUD', 1000), max: TEXT_MAX }),
  async prepare(user, input) {
    const { room, meta, host } = await liveRoom(input);
    if (readAloudOff(meta)) throw new ShopError(409, 'off', 'The host switched read-aloud messages off.');
    const text = clean(input.text, TEXT_MAX);
    if (!text) throw new ShopError(400, 'invalid', 'Write your message.');
    return { price: shopNumber('READALOUD', 1000), ref: shopRef('readaloud', host), channel: host, data: { room, text } };
  },
  async fulfil(order) {
    const room = String(order.data.room);
    const event = { type: 'readaloud', id: `ra-${order.id}`, room, sender: order.user, message: order.data.text, timestamp: Date.now() };
    if (!(await sendRoomData(room, 'boost', event))) throw new ShopError(503, 'unavailable', 'The message could not reach the stream.');
    return event;
  },
});

// ── suggest a poll ────────────────────────────────────────────────────────

export interface PollSuggestion { id: string; from: string; question: string; options: string[]; at: number }
export const suggestionOf = (o: ShopOrder): PollSuggestion => ({
  id: o.id, from: o.user, question: String(o.data.question), options: o.data.options as string[], at: o.createdAt,
});

registerShopItem({
  id: 'suggestpoll',
  quote: () => ({ enabled: true, price: shopNumber('SUGGESTPOLL', 2000), minutes: SUGGEST_TTL_MS / 60_000 }),
  async prepare(user, input) {
    const { room, host } = await liveRoom(input);
    if (user === host) throw new ShopError(400, 'invalid', 'You run the polls here: start one from the studio.');
    const question = clean(input.question, QUESTION_MAX);
    const options = (Array.isArray(input.options) ? input.options : []).map((o) => clean(o, OPTION_MAX)).filter(Boolean);
    if (!question) throw new ShopError(400, 'invalid', 'Ask a question.');
    if (options.length < 2 || options.length > 4) throw new ShopError(400, 'invalid', 'A poll needs 2 to 4 options.');
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new ShopError(400, 'invalid', 'The options must differ.');
    const mine = (await heldInRoom('suggestpoll', room)).filter((o) => o.user === user).length;
    if (mine >= SUGGEST_OPEN_MAX) throw new ShopError(429, 'limit', 'Wait for the host to answer your other suggestions.');
    return {
      price: shopNumber('SUGGESTPOLL', 2000), ref: shopRef('suggestpoll', host), channel: host,
      data: { room, host, question, options }, hold: true, expiresAt: Date.now() + SUGGEST_TTL_MS,
    };
  },
  async fulfil(order) {
    await sendRoomData(String(order.data.room), 'poll', { type: 'poll-suggestion', suggestion: suggestionOf(order) });
    return { id: order.id };
  },
  async onResolved(order) {
    await sendRoomData(String(order.data.room), 'poll', { type: 'poll-suggestion-done', id: order.id, status: order.status });
  },
});

export const pollSuggestions = async (room: string) => (await heldInRoom('suggestpoll', room)).map(suggestionOf);

// ── channel rewards ───────────────────────────────────────────────────────

export async function channelRewards(owner: string): Promise<ChannelReward[]> {
  return (await liveShopStores().rewards.findOne({ owner: owner.toLowerCase() }))?.rewards ?? [];
}

/** The host's rewards, checked and saved whole (PUT /channels/rewards). */
export async function saveChannelRewards(owner: string, input: unknown): Promise<ChannelReward[]> {
  if (!Array.isArray(input)) throw new ShopError(400, 'invalid', 'Send the list of rewards.');
  if (input.length > REWARDS_MAX) throw new ShopError(400, 'invalid', `A channel has at most ${REWARDS_MAX} rewards.`);
  const seen = new Set<string>();
  const rewards = input.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const title = clean(o.title, 60);
    const cost = Math.floor(Number(o.cost));
    if (!title) throw new ShopError(400, 'invalid', 'Every reward needs a name.');
    if (!(cost >= REWARD_COST_MIN && cost <= REWARD_COST_MAX)) {
      throw new ShopError(400, 'invalid', `A reward costs ${REWARD_COST_MIN.toLocaleString('en-US')} to ${REWARD_COST_MAX.toLocaleString('en-US')} points.`);
    }
    let id = typeof o.id === 'string' && /^[a-z0-9]{4,16}$/.test(o.id) ? o.id : idPart();
    while (seen.has(id)) id = idPart();
    seen.add(id);
    return { id, title, cost, prompt: o.prompt === true, enabled: o.enabled !== false };
  });
  await liveShopStores().rewards.update({ owner: owner.toLowerCase() }, { $set: { rewards, updatedAt: Date.now() } }, { upsert: true });
  return rewards;
}

export interface Redemption { id: string; from: string; rewardId: string; title: string; cost: number; input?: string; at: number }
export const redemptionOf = (o: ShopOrder): Redemption => ({
  id: o.id, from: o.user, rewardId: String(o.data.rewardId), title: String(o.data.title), cost: o.price,
  ...(o.data.input ? { input: String(o.data.input) } : {}), at: o.createdAt,
});

registerShopItem({
  id: 'reward',
  quote: () => ({ enabled: true, min: REWARD_COST_MIN, max: REWARD_COST_MAX }),
  async prepare(user, input) {
    const { room, host } = await liveRoom(input);
    if (user === host) throw new ShopError(400, 'invalid', 'These are your own rewards.');
    const reward = (await channelRewards(host)).find((r) => r.id === input.rewardId && r.enabled);
    if (!reward) throw new ShopError(404, 'not_found', 'That reward is not on offer.');
    const text = clean(input.input, TEXT_MAX);
    if (reward.prompt && !text) throw new ShopError(400, 'invalid', 'This reward asks you to write something.');
    return {
      price: reward.cost, ref: shopRef('reward', host), channel: host,
      data: { room, host, rewardId: reward.id, title: reward.title, ...(reward.prompt ? { input: text } : {}) },
      hold: true, expiresAt: Date.now() + REWARD_TTL_MS,
    };
  },
  async fulfil(order) {
    const room = String(order.data.room);
    await systemLine(room, {
      id: `rw-${order.id}`, identity: order.user, name: order.user, text: String(order.data.title),
      system: { kind: 'reward', from: order.user, title: String(order.data.title) },
    });
    await sendRoomData(room, 'rewards', { type: 'reward-redeemed', redemption: redemptionOf(order) });
    return { id: order.id };
  },
  async onResolved(order) {
    await sendRoomData(String(order.data.room), 'rewards', { type: 'reward-done', id: order.id, status: order.status });
  },
});

/** The host's queue: what viewers redeemed and the host has not handled. */
export async function rewardQueue(host: string): Promise<Redemption[]> {
  return (await shopStores().orders.find({ item: 'reward', status: 'held', 'data.host': host.toLowerCase() }, { sort: { createdAt: 1 }, limit: 200 }))
    .map(redemptionOf);
}

// ── bounties ──────────────────────────────────────────────────────────────

export const BOUNTY_MIN = () => shopNumber('BOUNTY_MIN', 100);

registerShopItem({
  id: 'bounty',
  quote: () => ({ enabled: true, min: BOUNTY_MIN(), hours: BOUNTY_TTL_MS / 3_600_000 }),
  async prepare(user, input) {
    const { room, host } = await liveRoom(input);
    if (user === host) throw new ShopError(400, 'invalid', 'You cannot put a bounty on your own stream.');
    const amount = Math.floor(Number(input.amount));
    if (!(amount >= BOUNTY_MIN())) throw new ShopError(400, 'invalid', `Pledge at least ${BOUNTY_MIN().toLocaleString('en-US')} points.`);
    let bountyId = typeof input.bountyId === 'string' ? input.bountyId : '';
    let text = '';
    if (bountyId) {
      const b = await liveShopStores().bounties.findOne({ id: bountyId, room, status: 'open' });
      if (!b) throw new ShopError(404, 'not_found', 'That bounty is closed.');
      text = b.text;
    } else {
      text = clean(input.text, 120);
      if (!text) throw new ShopError(400, 'invalid', 'Say what the challenge is.');
      const open = await liveShopStores().bounties.count({ room, status: 'open' });
      if (open >= BOUNTY_OPEN_MAX) throw new ShopError(429, 'limit', 'This stream has as many open bounties as it can take.');
      bountyId = `bo-${Date.now().toString(36)}-${idPart()}`;
    }
    return {
      price: amount, ref: shopRef('bounty', host), channel: host,
      data: { room, host, bountyId, text, isNew: !input.bountyId }, hold: true, expiresAt: Date.now() + BOUNTY_TTL_MS,
    };
  },
  async fulfil(order) {
    const room = String(order.data.room);
    const id = String(order.data.bountyId);
    const b = liveShopStores().bounties;
    let bounty = await b.update({ id, status: 'open' }, { $inc: { total: order.price, backers: 1 } });
    if (!bounty && order.data.isNew) {
      const doc: BountyDoc = {
        id, room, channel: String(order.data.host), text: String(order.data.text), createdBy: order.user,
        status: 'open', total: order.price, backers: 1, createdAt: Date.now(),
      };
      await b.insertOne(doc);
      bounty = doc;
    }
    if (!bounty) throw new ShopError(409, 'closed', 'That bounty closed.');
    await sendRoomData(room, 'bounty', { type: 'bounty', bounty });
    if (order.data.isNew) {
      await systemLine(room, {
        id: `bo-${order.id}`, identity: order.user, name: order.user, text: bounty.text,
        system: { kind: 'bounty', from: order.user, title: bounty.text, points: bounty.total },
      });
    }
    return { bounty };
  },
  async onResolved(order) {
    if (order.status !== 'refunded') return;
    const b = await liveShopStores().bounties.update({ id: String(order.data.bountyId), status: 'open' }, { $inc: { total: -order.price, backers: -1 } });
    if (b && b.total <= 0) await liveShopStores().bounties.update({ id: b.id }, { $set: { status: 'refunded', doneAt: Date.now() } });
    if (b) await sendRoomData(b.room, 'bounty', { type: 'bounty', bounty: { ...b, ...(b.total <= 0 ? { status: 'refunded' } : {}) } });
  },
});

export const roomBounties = (room: string) => liveShopStores().bounties.find({ room, status: 'open' }, { sort: { createdAt: 1 }, limit: 20 });

/** The host: done pays every pledge to the host; no gives them all back. */
export async function closeBounty(room: string, host: string, id: string, done: boolean): Promise<BountyDoc> {
  const b = await liveShopStores().bounties.update(
    { id, room, channel: host.toLowerCase(), status: 'open' },
    { $set: { status: done ? 'done' : 'refunded', doneAt: Date.now() } },
  );
  if (!b) throw new ShopError(404, 'not_found', 'That bounty is closed.');
  for (const o of await shopStores().orders.find({ item: 'bounty', status: 'held', 'data.bountyId': id }, { limit: 1000 })) {
    await (done
      ? resolveOrder(o.id, { done: true, payTo: b.channel })
      : resolveOrder(o.id, { refund: true, reason: 'The host turned the bounty down.' }));
  }
  await sendRoomData(room, 'bounty', { type: 'bounty', bounty: b });
  if (done) {
    await systemLine(room, {
      id: `bd-${id}`, identity: b.channel, name: b.channel, text: b.text,
      system: { kind: 'bountydone', from: b.channel, title: b.text, points: b.total },
    });
  }
  return b;
}

// ── stickers ──────────────────────────────────────────────────────────────

const account = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^@/, '').toLowerCase() : '');

/** The channels whose sticker set `user` unlocked. */
export async function stickerChannels(user: string): Promise<string[]> {
  return (await shopStores().orders.find({ item: 'stickers', status: 'done', user: user.toLowerCase() }, { limit: 500 }))
    .map((o) => String(o.channel));
}

registerShopItem({
  id: 'stickers',
  quote: () => ({ enabled: true, price: shopNumber('STICKERS', 1000), set: STICKERS }),
  async prepare(user, input) {
    const channel = account(input.channel);
    if (!/^[a-z][a-z0-9.-]{2,15}$/.test(channel)) throw new ShopError(400, 'invalid', 'Which channel?');
    if ((await stickerChannels(user)).includes(channel)) throw new ShopError(409, 'owned', 'You already have these stickers.');
    return { price: shopNumber('STICKERS', 1000), ref: shopRef('stickers', channel), channel, data: {} };
  },
  async fulfil(order) { return { channel: order.channel, set: STICKERS }; },
});

// ── extra stream minutes ──────────────────────────────────────────────────

/** Minutes past the free cap `user` bought for today's streams. */
export async function streamExtraMs(user: string, at = Date.now()): Promise<number> {
  try {
    return (await liveShopStores().extra.findOne({ user: user.toLowerCase(), day: utcDay(at) }))?.ms ?? 0;
  } catch { return 0; }
}

registerShopItem({
  id: 'minutes',
  quote: () => ({ enabled: true, price: shopNumber('MINUTES', 10_000), minutes: EXTRA_MINUTES_MS / 60_000, perDay: EXTRA_PER_DAY_MAX }),
  async prepare(user) {
    if (await isUserPremium(user)) throw new ShopError(409, 'pro', 'Pro streams run 4 hours already.');
    const today = await liveShopStores().extra.findOne({ user, day: utcDay() });
    if ((today?.buys ?? 0) >= EXTRA_PER_DAY_MAX) throw new ShopError(429, 'limit', 'That is as much extra time as one day takes.');
    return { price: shopNumber('MINUTES', 10_000), ref: shopRef('minutes', user), data: { day: utcDay() } };
  },
  async fulfil(order) {
    const day = String(order.data.day);
    const doc = await liveShopStores().extra.update(
      { user: order.user, day },
      { $inc: { ms: EXTRA_MINUTES_MS, buys: 1 }, $setOnInsert: { expires: new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000) } },
      { upsert: true },
    );
    const extraMs = doc?.ms ?? EXTRA_MINUTES_MS;
    for (const fn of extraListeners) await Promise.resolve(fn(order.user, extraMs)).catch(() => undefined);
    return { extraMs };
  },
});

type ExtraListener = (user: string, extraMs: number) => void | Promise<void>;
const extraListeners: ExtraListener[] = [];
/** lib/headlessStreams.ts: a stream that is live now gets the time at once. */
export function onStreamExtra(fn: ExtraListener): void { extraListeners.push(fn); }

/** Held live orders of rooms that ended come back. */
export async function sweepShopRooms(activeRooms: Set<string>): Promise<void> {
  for (const item of ['suggestpoll'] as const) {
    for (const o of await shopStores().orders.find({ item, status: 'held' }, { limit: 500 })) {
      if (!activeRooms.has(String(o.data.room))) await resolveOrder(o.id, { refund: true, reason: 'The stream ended.' });
    }
  }
}
