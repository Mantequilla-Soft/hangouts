import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { pointsAccount, pointsBalance } from '../lib/points.js';
import {
  EXTERNAL_KINDS, LOGIN_POINTS, RANK_POINTS, REMIX_PER_DAY, REMIX_POINTS, awardDailyLogin, awardPoints, awardsConfig,
} from '../lib/pointsAwards.js';
import { DOUBLE_FACTOR, doubleState } from '../lib/pointsEvents.js';
import { QUEST_POINTS, QUESTS_PER_WEEK, checkQuests, questProgress } from '../lib/pointsQuests.js';
import { PointsSpendError, spendStatus } from '../lib/pointsToken.js';
import { TRANSFER_MAX, transferPoints } from '../lib/pointsTransfer.js';
import { checkBan } from '../middleware/checkBan.js';

/** A spend that could not go through, as JSON the SDK reads: `code` says
 *  what to do (sign: the op is in `op`; insufficient: `onChain`, `unminted`). */
export function sendSpendError(reply: FastifyReply, err: PointsSpendError) {
  return reply.code(err.status).send({ message: err.message, code: err.code, ...err.extra });
}

/** A spend still waiting for Magi: the client polls GET /points/spends/:id. */
export function sendSpendPending(reply: FastifyReply, spendId: string) {
  return reply.code(202).send({
    pending: true,
    spendId,
    message: 'Your points are being spent. It goes through as soon as that is confirmed.',
  });
}

/** Longer than the 'promote' completer can take with its retries. */
const PROMOTE_BOOKING_MS = 2 * 60 * 1000;

function secretMatches(given: unknown): boolean {
  const want = config.POINTS_AWARD_SECRET;
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const pointsTokenRoutes: FastifyPluginAsync = async (fastify) => {
  // The day's login point (once per UTC day). 3Speak calls it once a day for
  // a signed-in account; a fresh sign-in here (POST /auth/verify) counts too.
  fastify.post('/points/daily', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const awarded = await awardDailyLogin(request.username).catch(() => false);
    reply.header('Cache-Control', 'no-store');
    return reply.send({ awarded, points: awarded ? LOGIN_POINTS : 0, balance: await pointsBalance(request.username) });
  });

  // Awards the checker computes (leaderboards, remixes, watching, listening,
  // posts, tips, followers...; lib/pointsAwards.ts KINDS). Shared secret; each
  // id pays once, the amounts and limits are ours. `units` scales the amount
  // of vodtime and listen (minutes) and tip (milli-HBD).
  fastify.post('/points/awards', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['awards'],
        properties: {
          awards: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              required: ['id', 'user', 'kind'],
              properties: {
                id: { type: 'string', maxLength: 300 },
                user: { type: 'string', maxLength: 16 },
                kind: { type: 'string', enum: EXTERNAL_KINDS },
                ref: { type: 'string', maxLength: 300 },
                units: { type: 'integer', minimum: 0, maximum: 100_000_000 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    if (!config.POINTS_AWARD_SECRET) return reply.code(404).send({ message: 'Not found' });
    if (!secretMatches(request.headers['x-points-award-secret'])) return reply.code(401).send({ message: 'Unauthorized' });
    const { awards } = request.body as { awards: Array<{ id: string; user: string; kind: string; ref?: string; units?: number }> };
    return reply.send({ results: await awardPoints(awards, Date.now(), { external: true }) });
  });

  // What the awards are worth (the wallet explains them): every kind's
  // amount and limits, plus the older flat fields.
  fastify.get('/points/awards/config', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.send({
      login: LOGIN_POINTS, rank: RANK_POINTS, remix: REMIX_POINTS, remixPerDay: REMIX_PER_DAY,
      kinds: awardsConfig(),
      double: { factor: DOUBLE_FACTOR },
      quests: { points: QUEST_POINTS, perWeek: QUESTS_PER_WEEK },
      // Points can be sent to other accounts (POST /points/transfer).
      transfer: { min: 1, max: TRANSFER_MAX },
    });
  });

  // Double points: on now, until when, and when next.
  fastify.get('/points/events', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send({ double: doubleState() });
  });

  // This week's quests of an account with their progress (public, like the
  // balance). A done quest that was not paid yet (a failed try) pays now.
  fastify.get('/points/quests', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', required: ['user'], properties: { user: { type: 'string', maxLength: 16 } } } },
  }, async (request, reply) => {
    const user = pointsAccount((request.query as { user: string }).user);
    if (!user) return reply.code(400).send({ message: 'Not a Hive account.' });
    let view = await questProgress(user);
    if (view.quests.some((q) => q.done) && await checkQuests(user).catch(() => 0) > 0) view = await questProgress(user);
    reply.header('Cache-Control', 'no-store');
    return reply.send(view);
  });

  // 50 points, once ever, for installing the app. CLIENT-CLAIMED: the
  // installed app calls this when it runs standalone, and nothing here can
  // prove that it is installed. The once-ever id keeps it to 50 per account.
  // 200 paid, 409 claimed already (both final for the app).
  fastify.post('/points/pwa', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = pointsAccount(request.username);
    if (!user) return reply.code(400).send({ message: 'Not a Hive account.' });
    const [r] = await awardPoints([{ id: `pwa:${user}`, user, kind: 'pwa' }]);
    reply.header('Cache-Control', 'no-store');
    const balance = await pointsBalance(user);
    if (r.awarded) return reply.send({ awarded: true, points: r.points, balance });
    if (r.reason === 'already') return reply.code(409).send({ awarded: false, points: 0, balance, message: 'Already claimed.' });
    return reply.code(r.reason === 'error' ? 503 : 403).send({ awarded: false, points: 0, balance, message: 'Not paid.', reason: r.reason });
  });

  // Send points to another account (lib/pointsTransfer.ts): from the wallet,
  // or as a points tip on one of the receiver's posts (`post`).
  fastify.post('/points/transfer', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['to', 'amount'],
        properties: {
          to: { type: 'string', pattern: '^@?[a-z][a-z0-9.-]{2,15}$' },
          amount: { type: 'integer', minimum: 1, maximum: TRANSFER_MAX },
          post: { type: 'string', pattern: '^[a-z][a-z0-9.-]{2,15}/[a-z0-9-]{1,255}$' },
          // 3SP: the txid of the transfer the user's wallet signed after a 428.
          burnTx: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        },
      },
    },
  }, async (request, reply) => {
    const from = pointsAccount(request.username);
    if (!from) return reply.code(400).send({ message: 'Not a Hive account.' });
    const body = request.body as { to: string; amount: number; post?: string; burnTx?: string };
    try {
      const res = await transferPoints({ from, ...body });
      if ('pending' in res) return sendSpendPending(reply, res.spendId);
      return reply.code(201).send(res);
    } catch (err) {
      if (err instanceof PointsSpendError) return sendSpendError(reply, err);
      throw err;
    }
  });

  // A spend of the signed-in account (a pending points boost, stake or promotion).
  fastify.get('/points/spends/:id', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const s = await spendStatus(request.username, id);
    if (!s) return reply.code(404).send({ message: 'No such spend.' });
    reply.header('Cache-Control', 'no-store');
    // A promotion is 'ok' once its burn is, but booked only when the
    // completer's result is saved (it may still retry the checker, or end
    // refunded): until then it reads as still pending.
    const booking = s.status === 'ok' && s.purpose.type === 'promote' && s.result === undefined
      && Date.now() - (s.doneAt ?? 0) < PROMOTE_BOOKING_MS;
    return reply.send({
      id: s.id,
      status: booking ? 'sent' : s.status,
      amount: s.amount,
      type: s.purpose.type,
      tx: s.tx,
      ...(s.error ? { message: s.error } : {}),
      ...(s.status === 'ok' && s.purpose.type === 'boost' && s.result ? { boost: s.result } : {}),
      ...(s.status === 'ok' && s.purpose.type === 'promote' && s.result
        ? { promotedUntil: (s.result as { promotedUntil?: unknown }).promotedUntil ?? null } : {}),
      balance: await pointsBalance(request.username),
    });
  });
};
