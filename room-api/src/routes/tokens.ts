import type { FastifyPluginAsync } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { config } from '../config.js';

export const tokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/rooms/:name/token', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['identity'],
        properties: {
          identity:    { type: 'string', minLength: 1, maxLength: 128 },
          displayName: { type: 'string', maxLength: 128 },
          isHost:      { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { identity, displayName, isHost = false } =
      request.body as { identity: string; displayName?: string; isHost?: boolean };

    const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
      identity,
      name: displayName,
      ttl: '6h',
    });

    at.addGrant({
      roomJoin:       true,
      room:           name,
      canPublish:     isHost,
      canSubscribe:   true,
      canPublishData: isHost,
    });

    const token = await at.toJwt();
    return reply.send({ token, roomName: name, identity });
  });
};
