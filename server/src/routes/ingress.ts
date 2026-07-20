import type { FastifyPluginAsync } from 'fastify';
import { IngressClient, IngressInput } from 'livekit-server-sdk';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';

const ingressClient = new IngressClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

// Track active WHIP ingresses: roomName → ingressId. One broadcaster per
// room for now — mirrors the one-active-stream/-recording assumption in
// streaming.ts / recording.ts.
const activeIngresses = new Map<string, string>();

async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };
  let meta: { host?: string } = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null };
}

export const ingressRoutes: FastifyPluginAsync = async (fastify) => {
  // Start a WHIP ingress (host only). Returns the WHIP URL + stream key for
  // the host to paste into an external encoder (OBS 30.2+, ffmpeg, etc).
  // The resulting publisher joins the room as a normal participant.
  fastify.post('/rooms/:name/ingress/whip', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: ['object', 'null'],
        properties: {
          displayName: { type: 'string', maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { displayName } = (request.body ?? {}) as { displayName?: string };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can start a WHIP broadcast');

    if (activeIngresses.has(name)) {
      return reply.conflict('Room already has an active WHIP ingress');
    }

    const info = await ingressClient.createIngress(IngressInput.WHIP_INPUT, {
      name: `${name}-whip`,
      roomName: name,
      participantIdentity: `whip-${name}`,
      participantName: displayName || 'Broadcaster',
    });

    activeIngresses.set(name, info.ingressId);

    return reply.send({
      ingressId: info.ingressId,
      url: info.url,
      streamKey: info.streamKey,
      status: 'created',
    });
  });

  // Stop the active WHIP ingress (host only)
  fastify.delete('/rooms/:name/ingress', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can stop the WHIP broadcast');

    const ingressId = activeIngresses.get(name);
    if (!ingressId) return reply.badRequest('Room has no active WHIP ingress');

    await ingressClient.deleteIngress(ingressId);
    activeIngresses.delete(name);

    return reply.send({ status: 'stopped' });
  });

  // WHIP ingress status
  fastify.get('/rooms/:name/ingress/status', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const ingressId = activeIngresses.get(name);
    if (!ingressId) return reply.send({ active: false });

    return reply.send({ active: true, ingressId });
  });
};
