import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { PROMOTE_MAX_DAYS, PromoteError, promoteQuote, promoteWithPoints } from '../lib/promotePoints.js';
import { PointsSpendError } from '../lib/pointsToken.js';
import { sendSpendError, sendSpendPending } from './pointsToken.js';

/** Promote a 3Speak video with points (lib/promotePoints.ts). */
export const promotePointsRoutes: FastifyPluginAsync = async (fastify) => {
  // What a day costs, for the 3Speak promote dialog.
  fastify.get('/points/promote/quote', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.send(promoteQuote());
  });

  fastify.post('/points/promote', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['author', 'permlink', 'days'],
        properties: {
          author: { type: 'string', pattern: '^[a-z][a-z0-9.-]{2,15}$' },
          permlink: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 255 },
          days: { type: 'integer', minimum: 1, maximum: PROMOTE_MAX_DAYS },
          // 3SP: the txid of the burn the user's wallet signed after a 428.
          burnTx: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { author: string; permlink: string; days: number; burnTx?: string };
    try {
      const res = await promoteWithPoints({ user: request.username, ...body });
      if ('pending' in res) return sendSpendPending(reply, res.spendId);
      return reply.code(201).send({ promotedUntil: res.promotedUntil, balance: res.balance });
    } catch (err) {
      if (err instanceof PromoteError) return reply.code(err.status).send({ message: err.message, code: err.code, ...err.extra });
      if (err instanceof PointsSpendError) return sendSpendError(reply, err);
      throw err;
    }
  });
};
