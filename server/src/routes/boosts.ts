import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { processBoostTransfer } from '../lib/boostListener.js';
import { listBoostLedger } from '../lib/boostLedger.js';

export const boostRoutes: FastifyPluginAsync = async (fastify) => {
  // Dev/admin ingest endpoint for v1 spike and manual reconciliation.
  fastify.post('/boosts/ingest', {
    schema: {
      body: {
        type: 'object',
        required: ['txId', 'opIndex', 'blockNum', 'timestamp', 'to', 'amount', 'memo'],
        properties: {
          txId: { type: 'string', minLength: 8, maxLength: 128 },
          opIndex: { type: 'number', minimum: 0 },
          blockNum: { type: 'number', minimum: 0 },
          timestamp: { type: 'number', minimum: 0 },
          to: { type: 'string', minLength: 3, maxLength: 16 },
          amount: { type: 'string', minLength: 1, maxLength: 32 },
          memo: { type: 'string', minLength: 1, maxLength: 512 },
        },
      },
    },
  }, async (request, reply) => {
    if (!config.BOOSTS_ENABLED) {
      return reply.code(503).send({ message: 'Boosts are disabled' });
    }
    // Admin-only, fail-closed. This endpoint issues real payouts from the
    // request body without on-chain re-verification, so an unauthenticated
    // caller could POST a fabricated transfer and drain BOOST_PLATFORM_ACCOUNT.
    // The production path is the on-chain poller (startBoostListener); this is
    // only for manual reconciliation and stays disabled unless a key is set.
    const adminKey = request.headers['x-admin-key'];
    if (!config.BOOST_INGEST_KEY || adminKey !== config.BOOST_INGEST_KEY) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const body = request.body as {
      txId: string;
      opIndex: number;
      blockNum: number;
      timestamp: number;
      to: string;
      amount: string;
      memo: string;
    };
    await processBoostTransfer(body, (msg, detail) => {
      if (detail) request.log.info({ detail }, msg);
      else request.log.info(msg);
    });
    return reply.code(202).send({ accepted: true });
  });

  fastify.get('/boosts/config', async (_request, reply) => {
    return reply.send({
      enabled: config.BOOSTS_ENABLED,
      platformAccount: config.BOOST_PLATFORM_ACCOUNT,
      feePercent: config.BOOST_PLATFORM_FEE_PERCENT,
    });
  });

  fastify.get('/boosts/ledger', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          room: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { room } = request.query as { room?: string };
    return reply.send(listBoostLedger(room));
  });
};
