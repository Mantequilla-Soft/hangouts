import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { roomService } from '../lib/livekit.js';
import { mutateRoomMetadata } from '../lib/roomMeta.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { CaptionSlots, CAPTION_LANG_RE } from '../lib/captionSlots.js';

/**
 * Live captions (H11). The studio asks for a caption slot before it opens its
 * speech-to-text session and renews it every 30 s while it captions; the slot
 * count is the cap that keeps the speech server from being overloaded. While a
 * room holds a slot its metadata carries `captions: { lang }`, so viewers show
 * the CC button before the first words arrive. The caption text itself never
 * comes through here (LiveKit data channel, host to viewers).
 */
export const captionSlots = new CaptionSlots(config.CAPTIONS_MAX_STREAMS, config.CAPTIONS_SLOT_TTL_SEC * 1000);

const paramsSchema = {
  params: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } },
} as const;

async function roomHost(name: string): Promise<string | null | undefined> {
  const rooms = await roomService.listRooms([name]);
  if (rooms.length === 0) return undefined;
  try {
    const meta = JSON.parse(rooms[0].metadata || '{}') as { host?: string };
    return typeof meta.host === 'string' ? meta.host : null;
  } catch { return null; }
}

/** Set or clear `captions` in the room's metadata. Best effort: the room may be gone. */
export async function writeCaptionMeta(name: string, lang: string | null): Promise<void> {
  try {
    await mutateRoomMetadata(name, (meta) => {
      const cur = meta.captions as { lang?: string } | undefined;
      if (lang === null) {
        if (!cur) return null;
        const { captions: _drop, ...rest } = meta;
        return rest;
      }
      if (cur && cur.lang === lang) return null;
      return { ...meta, captions: { lang } };
    });
  } catch { /* room gone: nothing to show */ }
}

const status = () => ({
  enabled: config.CAPTIONS_ENABLED && captionSlots.capacity > 0,
  max: captionSlots.capacity,
  active: captionSlots.active,
});

export const captionRoutes: FastifyPluginAsync = async (fastify) => {
  // Public: can a host turn captions on right now? The studio shows the toggle
  // (and "all caption slots are in use") from this.
  fastify.get('/captions/status', async () => {
    const s = status();
    return { ...s, available: s.enabled && s.active < s.max };
  });

  // Take or renew the room's caption slot. Host only. Renewal of a slot this
  // host already holds skips the LiveKit lookup, so a captioning stream costs
  // one tiny request every 30 s.
  fastify.post('/rooms/:name/captions/start', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    schema: {
      ...paramsSchema,
      body: {
        type: 'object',
        properties: { lang: { type: 'string', maxLength: 16 } },
      },
    },
  }, async (request, reply) => {
    if (!status().enabled) return reply.code(503).send({ message: 'Live captions are off on this server.', reason: 'disabled' });
    const { name } = request.params as { name: string };
    const lang = String((request.body as { lang?: string } | undefined)?.lang || 'en-us').toLowerCase();
    if (!CAPTION_LANG_RE.test(lang)) return reply.badRequest('Unknown caption language');

    const held = captionSlots.get(name);
    if (!held || held.host !== request.username) {
      const host = await roomHost(name);
      if (host === undefined) return reply.notFound('Room not found');
      if (host !== request.username) return reply.forbidden('Only the host can caption this stream');
    }

    const res = captionSlots.acquire(name, request.username, lang);
    if (!res.ok) {
      return reply.code(res.reason === 'full' ? 429 : 409).send({
        message: res.reason === 'full'
          ? 'All live caption slots are in use right now. Try again in a few minutes.'
          : 'Captions for this stream are held by another session.',
        reason: res.reason,
        ...status(),
      });
    }
    if (res.fresh) await writeCaptionMeta(name, lang);
    return {
      ok: true,
      lang: res.slot.lang,
      renewInSec: 30,
      expiresInSec: Math.round((res.slot.expiresAt - Date.now()) / 1000),
      ...status(),
    };
  });

  // Give the slot back (captions off, stream paused or ended).
  fastify.post('/rooms/:name/captions/stop', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    schema: paramsSchema,
  }, async (request) => {
    const { name } = request.params as { name: string };
    if (captionSlots.release(name, request.username)) await writeCaptionMeta(name, null);
    return { ok: true };
  });
};

/** Expired slots (a studio that stopped renewing): clear their CC flag. */
export async function sweepCaptionSlots(): Promise<string[]> {
  const gone = captionSlots.sweep();
  for (const room of gone) await writeCaptionMeta(room, null);
  return gone;
}

setInterval(() => { void sweepCaptionSlots(); }, 30_000).unref?.();
