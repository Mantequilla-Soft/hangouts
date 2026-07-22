import type { FastifyPluginAsync } from 'fastify';
import { createChallenge, consumeChallenge, verifyHiveSignature } from '../lib/hive.js';
import { createSessionToken } from '../lib/session.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Step 1: Client requests a challenge nonce to sign
  fastify.post('/auth/challenge', {
    // Unauthenticated + populates the nonce store and (via verify) forces Hive
    // RPC — rate-limit per IP so it can't be used for memory growth / RPC
    // amplification. (Meaningful now that trustProxy makes request.ip real.)
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 16 },
        },
      },
    },
  }, async (request, reply) => {
    const { username } = request.body as { username: string };
    const { challenge, expires } = createChallenge(username.toLowerCase());
    return reply.send({ challenge, expires });
  });

  // Step 2: Client sends signed challenge, server verifies against Hive chain
  fastify.post('/auth/verify', {
    // Forces outbound Hive getAccount(s) for any caller with a fresh challenge —
    // rate-limit to blunt amplification/brute-force against us and the RPC node.
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'challenge', 'signature'],
        properties: {
          username:  { type: 'string', minLength: 3, maxLength: 16 },
          challenge: { type: 'string', minLength: 1 },
          signature: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { username, challenge, signature } = request.body as {
      username: string;
      challenge: string;
      signature: string;
    };

    const lowerUsername = username.toLowerCase();

    // Validate and consume the nonce
    if (!consumeChallenge(challenge, lowerUsername)) {
      return reply.badRequest('Invalid or expired challenge');
    }

    // Verify the signature against the Hive blockchain
    const valid = await verifyHiveSignature(lowerUsername, challenge, signature);
    if (!valid) {
      return reply.unauthorized('Signature verification failed');
    }

    // Issue a session JWT
    const token = await createSessionToken(lowerUsername);
    return reply.send({ token, username: lowerUsername });
  });

  // Cheap authenticated probe. Lets a client check whether the session token it
  // restored from storage is still valid BEFORE trying to act on it — a stored
  // JWT can be unexpired yet unverifiable (e.g. after SESSION_SECRET is
  // rotated), and without this the client happily reuses it forever and every
  // action fails with "Invalid or expired session token".
  fastify.get('/auth/me', { preHandler: [requireAuth] }, async (request) => {
    return { username: request.username };
  });
};
