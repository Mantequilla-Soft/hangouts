import type { FastifyPluginAsync } from 'fastify';
import { roomService } from '../livekit.js';

export const participantRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.patch('/rooms/:name/participants/:identity/permissions', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'identity'],
        properties: {
          name:     { type: 'string' },
          identity: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          canPublish:     { type: 'boolean' },
          canSubscribe:   { type: 'boolean' },
          canPublishData: { type: 'boolean' },
        },
        additionalProperties: false,
        minProperties: 1,
      },
    },
  }, async (request, reply) => {
    const { name, identity } = request.params as { name: string; identity: string };
    const permissions = request.body as {
      canPublish?:     boolean;
      canSubscribe?:   boolean;
      canPublishData?: boolean;
    };

    const updated = await roomService.updateParticipant(name, identity, undefined, {
      canPublish:     permissions.canPublish,
      canSubscribe:   permissions.canSubscribe,
      canPublishData: permissions.canPublishData,
    });

    return reply.send({
      identity:   updated.identity,
      permission: updated.permission,
    });
  });
};
