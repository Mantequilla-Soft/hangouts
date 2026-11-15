import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { mutateRoomMetadata } from '../lib/roomMeta.js';
import { cleanOverlayTemplates, cleanVerticalCrop, type VerticalCrop } from '../lib/studioOverlayInput.js';
import { getOverlayTemplates, saveOverlayTemplates, OverlayStoreUnavailableError } from '../lib/studioOverlayStore.js';

/**
 * Small studio helpers.
 *
 * - PATCH /rooms/:name/vertical (H19): the host's 9:16 phone crop, kept in the
 *   room metadata as `vertical`. Viewers on a phone use it to place their own
 *   crop when the studio sends no vertical track (OBS streams), and clips can
 *   read it to cut a Shorts-ready vertical. The studio sends it when the host
 *   moves the crop, at most every few seconds while it follows a source.
 * - GET / PUT /studio/overlays (H17): the host's saved overlay templates.
 */
export const studioToolRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.patch('/rooms/:name/vertical', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } },
      body: {
        type: 'object',
        properties: {
          on: { type: 'boolean' },
          x: { type: 'number' },
          w: { type: 'number' },
          follow: { type: 'string', maxLength: 16 },
          track: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const vertical = cleanVerticalCrop(request.body);
    let forbidden = false;
    let stored: VerticalCrop | null = null;
    try {
      await mutateRoomMetadata(name, (meta) => {
        if (meta.host !== request.username) { forbidden = true; return null; }
        const prev = JSON.stringify(meta.vertical ?? null);
        stored = vertical;
        // Unchanged (a follow tick that did not move): no metadata write, so
        // viewers get no room update for nothing.
        if (prev === JSON.stringify(vertical)) return null;
        return { ...meta, vertical };
      });
    } catch {
      return reply.notFound('Room not found');
    }
    if (forbidden) return reply.forbidden('Only the host can set the phone crop');
    return reply.send({ vertical: stored });
  });

  fastify.get('/studio/overlays', { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      return reply.send({ templates: await getOverlayTemplates(request.username) });
    } catch (err) {
      if (err instanceof OverlayStoreUnavailableError) {
        return reply.code(503).send({ statusCode: 503, error: 'storage_unavailable', message: 'Overlay storage is unavailable' });
      }
      throw err;
    }
  });

  fastify.put('/studio/overlays', {
    preHandler: [requireAuth, checkBan],
    bodyLimit: 64 * 1024,
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
    schema: {
      body: { type: 'object', required: ['templates'], properties: { templates: { type: 'array' } } },
    },
  }, async (request, reply) => {
    const templates = cleanOverlayTemplates((request.body as { templates: unknown }).templates);
    if (typeof templates === 'string') {
      return reply.code(400).send({ statusCode: 400, error: 'invalid_input', message: templates });
    }
    try {
      await saveOverlayTemplates(request.username, templates);
    } catch (err) {
      if (err instanceof OverlayStoreUnavailableError) {
        return reply.code(503).send({ statusCode: 503, error: 'storage_unavailable', message: 'Overlay storage is unavailable' });
      }
      throw err;
    }
    return reply.send({ templates });
  });
};
