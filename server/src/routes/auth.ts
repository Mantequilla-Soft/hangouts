import type { FastifyPluginAsync } from 'fastify';
import { createChallenge, consumeChallenge, verifyHiveSignature } from '../lib/hive.js';
import { createSessionToken } from '../lib/session.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Step 1: Client requests a challenge nonce to sign
  fastify.post('/auth/challenge', {
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
};
