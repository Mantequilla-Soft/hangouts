import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { isHostOrMod, readRoomMeta, sessionUser, streamOffset } from '../lib/liveRoom.js';
import { createPoll, PollError, toView } from '../lib/polls.js';
import { PointsSpendError } from '../lib/pointsToken.js';
import { buy, monthOf, orderFor, resolveOrder, shopCatalog, shopStores, ShopError } from '../lib/pointsShop.js';
import {
  STICKERS, channelRewards, closeBounty, pollSuggestions, rewardQueue, roomBounties, saveChannelRewards, streamExtraMs,
} from '../lib/shopLive.js';
import {
  FREEZES_PER_MONTH, actOnRequest, audioGrants, channelSupporters, cosmeticsCatalog, cosmeticsOf, equipCosmetics,
  freezesThisMonth, listRequests, missedDays, spotlightState, supporterBadges, topSupporters, SUPPORTER_MIN,
} from '../lib/shopAccount.js';
import { loginStreak } from '../lib/pointsAwards.js';
import { sendSpendError, sendSpendPending } from './pointsToken.js';
import '../lib/shopChecker.js';

/**
 * The points shop (lib/pointsShop.ts and its items in shopLive, shopAccount
 * and shopChecker): the catalog, buying, and what hosts, creators and buyers
 * do with what was bought.
 */

const ACCOUNT = '^[a-z][a-z0-9.-]{2,15}$';
const MONTH_RE = /^\d{4}-\d{2}$/;
const nameParam = { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } } as const;
const idParams = {
  type: 'object', required: ['name', 'id'],
  properties: { name: { type: 'string', maxLength: 128 }, id: { type: 'string', maxLength: 128 } },
} as const;
const accountParam = (key: string) => ({ type: 'object', required: [key], properties: { [key]: { type: 'string', pattern: ACCOUNT } } }) as const;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ShopError) return reply.code(err.status).send({ message: err.message, code: err.code, ...err.extra });
  if (err instanceof PointsSpendError) return sendSpendError(reply, err);
  if (err instanceof PollError) return reply.code(err.status).send({ message: err.message });
  throw err;
}

const month = (q: unknown) => {
  const m = (q as { month?: string })?.month;
  return typeof m === 'string' && MONTH_RE.test(m) ? m : monthOf();
};

export const pointsShopRoutes: FastifyPluginAsync = async (fastify) => {
  // ── the catalog and buying ──────────────────────────────────────────────

  fastify.get('/points/shop', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.send({ items: shopCatalog(), stickers: STICKERS, cosmetics: cosmeticsCatalog(), supporterMin: SUPPORTER_MIN() });
  });

  fastify.post('/points/shop/buy', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', required: ['item'],
        properties: {
          item: { type: 'string', pattern: '^[a-z0-9]{2,20}$' },
          // 3SP: the txid of the burn the user's wallet signed after a 428.
          burnTx: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown> & { item: string; burnTx?: string };
    try {
      const res = await buy(request.username, body.item, body);
      if ('pending' in res) return reply.code(202).send({ pending: true, spendId: res.spendId, orderId: res.orderId, message: 'Your points are being spent. It goes through as soon as that is confirmed.' });
      return reply.code(201).send({ order: res.order, balance: res.balance });
    } catch (err) { return fail(reply, err); }
  });

  // One of your orders (a pending one is followed here, or at /points/spends/:id).
  fastify.get('/points/shop/orders/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const o = await orderFor(request.username, id);
    if (!o) return reply.notFound('No such order');
    reply.header('Cache-Control', 'no-store');
    return reply.send({ order: o });
  });

  fastify.get('/points/shop/orders', { preHandler: [requireAuth] }, async (request, reply) => {
    const { item } = (request.query ?? {}) as { item?: string };
    const filter: Record<string, unknown> = { user: request.username.toLowerCase() };
    if (item && /^[a-z0-9]{2,20}$/.test(item)) filter.item = item;
    reply.header('Cache-Control', 'no-store');
    return reply.send({ orders: await shopStores().orders.find(filter, { sort: { createdAt: -1 }, limit: 50 }) });
  });

  // ── suggested polls (host or mod decides) ───────────────────────────────

  fastify.get('/rooms/:name/poll-suggestions', { schema: { params: nameParam } }, async (request, reply) => {
    const { name } = request.params as { name: string };
    reply.header('Cache-Control', 'no-store');
    return reply.send({ suggestions: await pollSuggestions(name) });
  });

  fastify.post('/rooms/:name/poll-suggestions/:id/:action', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' }, dock: true },
    schema: {
      params: { ...idParams, required: ['name', 'id', 'action'], properties: { ...idParams.properties, action: { type: 'string', enum: ['accept', 'reject'] } } },
      body: { type: ['object', 'null'], properties: { durationSec: { type: 'integer', minimum: 15, maximum: 600 } } },
    },
  }, async (request, reply) => {
    const { name, id, action } = request.params as { name: string; id: string; action: 'accept' | 'reject' };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (!isHostOrMod(meta, request.username)) return reply.forbidden('Only the host can do that');
    const o = await shopStores().orders.findOne({ id, item: 'suggestpoll', status: 'held', 'data.room': name });
    if (!o) return reply.notFound('That suggestion is gone');
    try {
      if (action === 'reject') {
        await resolveOrder(id, { refund: true, reason: 'The host did not run it.' });
        return reply.send({ ok: true });
      }
      const durationSec = (request.body as { durationSec?: number } | null)?.durationSec ?? 60;
      const poll = createPoll(name, String(meta.host), { kind: 'poll', question: String(o.data.question), options: o.data.options as string[], durationSec }, streamOffset(meta));
      await resolveOrder(id, { done: true, result: { poll: poll.id } });
      return reply.code(201).send({ poll: toView(poll) });
    } catch (err) { return fail(reply, err); }
  });

  // ── channel rewards ─────────────────────────────────────────────────────

  fastify.get('/channels/:owner/rewards', { schema: { params: accountParam('owner') } }, async (request, reply) => {
    const { owner } = request.params as { owner: string };
    reply.header('Cache-Control', 'public, max-age=30');
    return reply.send({ rewards: await channelRewards(owner) });
  });

  fastify.put('/channels/rewards', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' }, dock: true },
    schema: { body: { type: 'object', required: ['rewards'], properties: { rewards: { type: 'array', maxItems: 50 } } } },
  }, async (request, reply) => {
    try {
      return reply.send({ rewards: await saveChannelRewards(request.username, (request.body as { rewards: unknown }).rewards) });
    } catch (err) { return fail(reply, err); }
  });

  fastify.get('/rooms/:name/rewards/queue', { preHandler: [requireAuth], config: { dock: true }, schema: { params: nameParam } }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (!isHostOrMod(meta, request.username)) return reply.forbidden('Only the host can see the queue');
    reply.header('Cache-Control', 'no-store');
    return reply.send({ queue: await rewardQueue(String(meta.host)) });
  });

  fastify.post('/rooms/:name/rewards/:id/:action', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' }, dock: true },
    schema: { params: { ...idParams, required: ['name', 'id', 'action'], properties: { ...idParams.properties, action: { type: 'string', enum: ['done', 'refund'] } } } },
  }, async (request, reply) => {
    const { name, id, action } = request.params as { name: string; id: string; action: 'done' | 'refund' };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (!isHostOrMod(meta, request.username)) return reply.forbidden('Only the host can do that');
    const o = await shopStores().orders.findOne({ id, item: 'reward', status: 'held', 'data.host': String(meta.host) });
    if (!o) return reply.notFound('That redemption is handled already');
    await (action === 'done'
      ? resolveOrder(id, { done: true })
      : resolveOrder(id, { refund: true, reason: 'The host gave the points back.' }));
    return reply.send({ ok: true });
  });

  // ── bounties ────────────────────────────────────────────────────────────

  fastify.get('/rooms/:name/bounties', { schema: { params: nameParam } }, async (request, reply) => {
    const { name } = request.params as { name: string };
    reply.header('Cache-Control', 'no-store');
    return reply.send({ bounties: await roomBounties(name) });
  });

  fastify.post('/rooms/:name/bounties/:id/:action', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' }, dock: true },
    schema: { params: { ...idParams, required: ['name', 'id', 'action'], properties: { ...idParams.properties, action: { type: 'string', enum: ['done', 'decline'] } } } },
  }, async (request, reply) => {
    const { name, id, action } = request.params as { name: string; id: string; action: 'done' | 'decline' };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (meta.host !== request.username) return reply.forbidden('Only the host can do that');
    try {
      return reply.send({ bounty: await closeBounty(name, request.username, id, action === 'done') });
    } catch (err) { return fail(reply, err); }
  });

  // ── stream time, streaks, longer audio ──────────────────────────────────

  fastify.get('/points/stream-extra', { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send({ extraMs: await streamExtraMs(request.username) });
  });

  fastify.get('/points/streak', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.username.toLowerCase();
    const [streak, missed, used] = await Promise.all([loginStreak(user), missedDays(user), freezesThisMonth(user)]);
    reply.header('Cache-Control', 'no-store');
    return reply.send({ ...streak, missed, freezesLeft: Math.max(0, FREEZES_PER_MONTH - used), perMonth: FREEZES_PER_MONTH });
  });

  fastify.get('/points/audio-grants', { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const grants = await audioGrants(request.username);
    return reply.send({ grants: grants.map((g) => ({ extraSeconds: g.extraSeconds, expiresAt: g.expiresAt })) });
  });

  // ── cosmetics ───────────────────────────────────────────────────────────

  fastify.get('/users/:account/cosmetics', { schema: { params: accountParam('account') } }, async (request, reply) => {
    const { account } = request.params as { account: string };
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send(await cosmeticsOf(account));
  });

  fastify.put('/points/cosmetics', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { body: { type: 'object' } },
  }, async (request, reply) => {
    try {
      return reply.send(await equipCosmetics(request.username, request.body as Record<string, unknown>));
    } catch (err) { return fail(reply, err); }
  });

  // ── supporters ──────────────────────────────────────────────────────────

  fastify.get('/channels/:owner/supporters', { schema: { params: accountParam('owner') } }, async (request, reply) => {
    const { owner } = request.params as { owner: string };
    const m = month(request.query);
    const [top, badges] = await Promise.all([channelSupporters(owner, m), supporterBadges(owner)]);
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send({ month: m, top, badges, min: SUPPORTER_MIN() });
  });

  fastify.get('/points/supporters', async (request, reply) => {
    const m = month(request.query);
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.send({ month: m, top: await topSupporters(m) });
  });

  // ── content requests ────────────────────────────────────────────────────

  fastify.get('/points/requests', { preHandler: [requireAuth] }, async (request, reply) => {
    const role = (request.query as { role?: string })?.role === 'creator' ? 'creator' : 'from';
    reply.header('Cache-Control', 'no-store');
    return reply.send({ requests: await listRequests(request.username.toLowerCase(), role) });
  });

  // Public: what creators were asked for (open ones), for their channel page.
  fastify.get('/channels/:owner/requests', { schema: { params: accountParam('owner') } }, async (request, reply) => {
    const { owner } = request.params as { owner: string };
    const open = (await listRequests(owner.toLowerCase(), 'creator')).filter((r) => r.state === 'open' || r.state === 'delivered');
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send({ requests: open });
  });

  fastify.post('/points/requests/:id/:action', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object', required: ['id', 'action'],
        properties: { id: { type: 'string', maxLength: 128 }, action: { type: 'string', enum: ['deliver', 'decline', 'approve', 'cancel'] } },
      },
      body: { type: ['object', 'null'], properties: { permlink: { type: 'string', pattern: '^[a-z0-9-]{1,255}$' } } },
    },
  }, async (request, reply) => {
    const { id, action } = request.params as { id: string; action: 'deliver' | 'decline' | 'approve' | 'cancel' };
    const permlink = (request.body as { permlink?: string } | null)?.permlink;
    try {
      return reply.send({ request: await actOnRequest(request.username.toLowerCase(), id, action, permlink) });
    } catch (err) { return fail(reply, err); }
  });

  // ── home spotlight auction ──────────────────────────────────────────────

  fastify.get('/points/spotlight', async (request, reply) => {
    const s = await spotlightState();
    // Bidders see their own name; others only the video and the bid.
    const me = await sessionUser(request);
    reply.header('Cache-Control', 'no-store');
    return reply.send({ ...s, top: s.top ? { ...s.top, mine: !!me && me === s.top.user } : null });
  });
};
