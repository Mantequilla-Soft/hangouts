import type { FastifyPluginAsync } from 'fastify';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  noteChat, getHighlights, onHighlight, setRoomResolver, startHighlightSweep,
  type HighlightMoment, type RoomInfo,
} from '../lib/streamHighlights.js';
import { clipStore, clipView, registerClip } from '../lib/streamClips.js';
import { readRoomFacts, optionalUser } from '../lib/roomInfo.js';
import { cutDvrClip, dvrDirOf } from './dvr.js';

/**
 * Highlight clips that become Shorts (H13).
 *
 *   POST   /rooms/:name/highlights/chat   one chat line happened (sender's client)
 *   GET    /rooms/:name/highlights        the host: moments + every kept clip;
 *                                         anyone else signed in: their own clips
 *   GET    /clips/mine                    the signed-in user's recent clips
 *   DELETE /clips/:id                     the host or the clipper drops a clip
 *
 * And, while a Pro host's DVR runs, every highlight moment cuts its own clip
 * from the DVR buffer (source 'auto'), so the host finds the best moments ready
 * to post after the stream.
 */
const CLIP_DIR = '/tmp/livekit-dvr-clips';
const ROOM_RE = /^[A-Za-z0-9_-]{1,80}$/;

const nameParams = {
  params: { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: ROOM_RE.source } } },
} as const;

/** The automatic clip of a moment, when the room's DVR is running. */
export async function autoClipMoment(room: string, moment: HighlightMoment, info: RoomInfo): Promise<boolean> {
  if (!dvrDirOf(room)) return false;
  const cut = await cutDvrClip(room);
  if (cut.error) return false;
  const kept = await registerClip({
    room, host: info.host, clipper: null, source: 'auto', file: cut.file,
    offsetSec: moment.offsetSec, durationSec: cut.durationSec, reasons: moment.reasons,
  }).catch(() => null);
  if (!kept || !('clip' in kept)) {
    await unlink(join(CLIP_DIR, cut.file)).catch(() => { /* already gone */ });
    return false;
  }
  return true;
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  setRoomResolver(async (room) => {
    const f = await readRoomFacts(room);
    return f ? { host: f.host, liveAt: f.liveAt } : null;
  });
  onHighlight((room, moment, info) => { void autoClipMoment(room, moment, info).catch(() => { /* best effort */ }); });
  startHighlightSweep();
}

/** Tests only. */
export function resetHighlightRoutes(): void { wired = false; }

export const highlightRoutes: FastifyPluginAsync = async (fastify) => {
  wireOnce();

  // Fire-and-forget from the chat composer. No body; a signed-in sender is
  // counted by name, a guest by IP. Rate limited well above human chat speed.
  fastify.post('/rooms/:name/highlights/chat', {
    config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    schema: nameParams,
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const user = await optionalUser(request);
    noteChat(name, user ? `u:${user}` : `ip:${request.ip}`);
    return reply.code(204).send();
  });

  fastify.get('/rooms/:name/highlights', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: nameParams,
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const [data, store] = await Promise.all([getHighlights(name), clipStore()]);
    const clips = await store.listForRoom(name);
    let host = data?.host ?? clips.find((c) => c.host)?.host ?? null;
    if (!host) host = (await readRoomFacts(name))?.host ?? null;
    const isHost = !!host && host === request.username;
    reply.header('Cache-Control', 'private, no-store');
    return reply.send({
      room: name,
      host,
      isHost,
      liveAt: data?.liveAt ? new Date(data.liveAt).toISOString() : null,
      moments: isHost ? (data?.moments ?? []) : [],
      clips: (isHost ? clips : clips.filter((c) => c.clipper === request.username)).map(clipView),
    });
  });

  fastify.get('/clips/mine', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const store = await clipStore();
    reply.header('Cache-Control', 'private, no-store');
    return reply.send({ clips: (await store.listForClipper(request.username)).map(clipView) });
  });

  fastify.delete('/clips/:id', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{18}$' } } } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = await clipStore();
    const clip = await store.get(id);
    if (!clip) return reply.notFound('Clip not found');
    if (request.username !== clip.host && request.username !== clip.clipper) {
      return reply.forbidden('Only the host or the person who made the clip can delete it');
    }
    await store.remove(id);
    await unlink(join(CLIP_DIR, clip.file)).catch(() => { /* already swept */ });
    return reply.send({ deleted: true });
  });
};
