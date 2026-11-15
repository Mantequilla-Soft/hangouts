import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import {
  BATTLE_DURATIONS, BattleError, battleCandidates, endBattleBy, getBattle, inviteBattle,
  linkToken, respondBattle, settleBattle, type BattleCandidate,
} from '../lib/battles.js';

const roomParams = {
  type: 'object',
  required: ['room'],
  properties: { room: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BattleError) return reply.code(err.status).send({ code: err.code, message: err.message });
  if (err instanceof Error && /room not found/i.test(err.message)) return reply.code(404).send({ code: 'not_found', message: 'Room not found' });
  throw err;
}

/**
 * Live battles (H16). See lib/battles.ts for the model. All writes are
 * host-only and rate-limited; the result is computed here from the boost
 * tally the listener keeps, never sent by a client.
 */
export const battleRoutes: FastifyPluginAsync = async (fastify) => {
  // The candidate list is one listRooms; share it for a few seconds so a
  // studio with the panel open can't make that a per-request cost.
  let cache: { at: number; all: BattleCandidate[] } | null = null;
  const CANDIDATES_TTL_MS = 3000;

  fastify.get('/battles/candidates', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!cache || Date.now() - cache.at > CANDIDATES_TTL_MS) {
      // Built for a host no one is, then filtered per caller below.
      cache = { at: Date.now(), all: await battleCandidates('') };
    }
    const list = cache.all.filter((c) => c.host !== request.username);
    return reply.send({ streams: list, durations: BATTLE_DURATIONS });
  });

  fastify.get('/battles/:room', { schema: { params: roomParams } }, async (request, reply) => {
    const { room } = request.params as { room: string };
    try {
      return reply.send({ battle: await getBattle(room) });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/battles/:room/invite', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      params: roomParams,
      body: {
        type: 'object',
        required: ['opponent', 'durationSec'],
        properties: {
          opponent: { type: 'string', minLength: 1, maxLength: 128 },
          durationSec: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { room } = request.params as { room: string };
    const body = request.body as { opponent: string; durationSec: number };
    try {
      const battle = await inviteBattle({ room, by: request.username, opponent: body.opponent, durationSec: body.durationSec });
      return reply.code(201).send({ battle });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/battles/:room/respond', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      params: roomParams,
      body: { type: 'object', required: ['accept'], properties: { accept: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const { room } = request.params as { room: string };
    const { accept } = request.body as { accept: boolean };
    try {
      return reply.send({ battle: await respondBattle({ room, by: request.username, accept }) });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/battles/:room/end', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      params: roomParams,
      body: { type: 'object', properties: { reason: { type: 'string', enum: ['ended', 'dropped'] } } },
    },
  }, async (request, reply) => {
    const { room } = request.params as { room: string };
    const { reason } = (request.body ?? {}) as { reason?: 'ended' | 'dropped' };
    try {
      return reply.send({ battle: await endBattleBy({ room, by: request.username, reason }) });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/battles/:room/settle', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: roomParams },
  }, async (request, reply) => {
    const { room } = request.params as { room: string };
    try {
      return reply.send({ battle: await settleBattle({ room, by: request.username }) });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/battles/:room/link', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: roomParams },
  }, async (request, reply) => {
    const { room } = request.params as { room: string };
    try {
      return reply.send(await linkToken({ room, by: request.username }));
    } catch (err) { return fail(reply, err); }
  });
};
