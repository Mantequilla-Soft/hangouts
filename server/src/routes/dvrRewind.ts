import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dvrDirOf, DVR_BUFFER_SECONDS, DVR_SEGMENT_SEC } from './dvr.js';
import { config } from '../config.js';
import { readRoomFacts, optionalUser } from '../lib/roomInfo.js';
import { rewindToken, checkRewindToken, buildRewindPlaylist, SEGMENT_RE } from '../lib/dvrRewind.js';

/**
 * Rewind during a live stream (H14), from the existing Pro DVR egress.
 *
 *   GET /rooms/:name/dvr/rewind                       is it available, and the playlist URL
 *   GET /rooms/:name/dvr/hls/:token/live.m3u8         the rewind playlist (1 s cache)
 *   GET /rooms/:name/dvr/hls/:token/<segment>.ts      a segment (immutable)
 *
 * Server work per viewer: one small playlist build per room per second (shared
 * by every viewer), and file reads. Per-IP rate limits sit well above what
 * hls.js asks for (one playlist per 2 s, one segment per 2 s).
 */
const ROOM_RE = '^[A-Za-z0-9_-]{1,80}$';
const PLAYLIST_CACHE_MS = 1000;
const cache = new Map<string, { at: number; body: string | null }>();

async function playlistFor(room: string, dir: string): Promise<string | null> {
  const hit = cache.get(room);
  if (hit && Date.now() - hit.at < PLAYLIST_CACHE_MS) return hit.body;
  const [index, files] = await Promise.all([
    readFile(join(dir, 'index.m3u8'), 'utf8').catch(() => null),
    readdir(dir).catch(() => [] as string[]),
  ]);
  const body = buildRewindPlaylist(index, files, { segmentSec: DVR_SEGMENT_SEC });
  cache.set(room, { at: Date.now(), body });
  // Bounded: drop entries of rooms whose DVR stopped.
  if (cache.size > 200) for (const k of cache.keys()) if (!dvrDirOf(k)) cache.delete(k);
  return body;
}

export const dvrRewindRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/rooms/:name/dvr/rewind', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: ROOM_RE } } } },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    reply.header('Cache-Control', 'no-store');
    if (!config.REWIND_ENABLED) return reply.send({ available: false, reason: 'off' });
    if (!dvrDirOf(name)) return reply.send({ available: false });
    const facts = await readRoomFacts(name);
    if (!facts) return reply.send({ available: false });
    // Hive-only rooms: the same rule as watching them, a signed-in Hive account.
    if (facts.visibility === 'hive-internal' && !(await optionalUser(request))) {
      return reply.code(401).send({ available: false, reason: 'login_required' });
    }
    return reply.send({
      available: true,
      playlist: `/rooms/${encodeURIComponent(name)}/dvr/hls/${rewindToken(name)}/live.m3u8`,
      windowSec: DVR_BUFFER_SECONDS,
      liveAt: facts.liveAt ? new Date(facts.liveAt).toISOString() : null,
    });
  });

  const hlsParams = {
    params: {
      type: 'object',
      required: ['name', 'token', 'file'],
      properties: { name: { type: 'string', pattern: ROOM_RE }, token: { type: 'string' }, file: { type: 'string' } },
    },
  } as const;

  fastify.get('/rooms/:name/dvr/hls/:token/:file', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    schema: hlsParams,
  }, async (request, reply) => {
    const { name, token, file } = request.params as { name: string; token: string; file: string };
    if (!config.REWIND_ENABLED) return reply.notFound('Rewind is off');
    if (!checkRewindToken(name, token)) return reply.forbidden('Rewind link expired, reload the stream');
    const dir = dvrDirOf(name);
    if (!dir) return reply.notFound('This stream has no rewind right now');

    if (file === 'live.m3u8') {
      const body = await playlistFor(name, dir);
      if (!body) return reply.code(404).header('Cache-Control', 'no-store').send({ message: 'Nothing recorded yet' });
      return reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'public, max-age=1')
        .send(body);
    }

    if (!SEGMENT_RE.test(file)) return reply.badRequest('bad file');
    const p = join(dir, file);
    const s = await stat(p).catch(() => null);
    if (!s) return reply.notFound('segment gone');
    return reply
      .header('Content-Type', 'video/mp2t')
      .header('Content-Length', String(s.size))
      // A segment never changes once written.
      .header('Cache-Control', 'public, max-age=600, immutable')
      .send(createReadStream(p));
  });
};
