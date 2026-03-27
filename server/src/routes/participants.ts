import type { FastifyPluginAsync } from 'fastify';
import { roomService } from '../lib/livekit.js';
import { requireAuth } from '../middleware/requireAuth.js';

/** Parse room metadata and verify the caller is the host. */
async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };

  let meta: { host?: string } = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null };
}

export const participantRoutes: FastifyPluginAsync = async (fastify) => {
  // Promote/demote a participant (host only)
  fastify.patch('/rooms/:name/participants/:identity/permissions', {
    preHandler: requireAuth,
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
        required: ['canPublish'],
        properties: {
          canPublish: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, identity } = request.params as { name: string; identity: string };
    const { canPublish } = request.body as { canPublish: boolean };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can change permissions');

    const updated = await roomService.updateParticipant(name, identity, undefined, {
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    });

    return reply.send({
      identity: updated.identity,
      canPublish: updated.permission?.canPublish ?? false,
    });
  });

  // Kick a participant (host only)
  fastify.delete('/rooms/:name/participants/:identity', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        required: ['name', 'identity'],
        properties: {
          name:     { type: 'string' },
          identity: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, identity } = request.params as { name: string; identity: string };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can kick participants');

    await roomService.removeParticipant(name, identity);
    return reply.code(204).send();
  });
};
