import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hlsSessionDir, touchHlsSession } from '../lib/hlsLive.js';

/**
 * Serves a stream's live HLS playlist and segments (see lib/hlsLive.ts).
 *
 * Public and not rate-limited: every HLS viewer polls the playlist every
 * couple of seconds. Cache headers are set so a CDN in front (HLS_PUBLIC_BASE)
 * collapses that load: the playlist for one second, segments for a day (their
 * names are never reused). "Not there yet" answers are no-store so a CDN never
 * caches a 404 over a stream that is just starting.
 */
const FILE_RE = /^(live\.m3u8|[A-Za-z0-9_-]+\.ts)$/;

export const hlsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/rooms/:name/hls/:file', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'file'],
        properties: { name: { type: 'string' }, file: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name, file } = request.params as { name: string; file: string };
    if (!FILE_RE.test(file)) return reply.code(400).header('Cache-Control', 'no-store').send({ message: 'bad file' });
    const dir = hlsSessionDir(name);
    if (!dir) return reply.code(404).header('Cache-Control', 'no-store').send({ message: 'HLS is not running for this stream' });

    if (file === 'live.m3u8') {
      touchHlsSession(name);
      const body = await readFile(join(dir, file), 'utf8').catch(() => null);
      if (body === null) return reply.code(404).header('Cache-Control', 'no-store').send({ message: 'starting' });
      return reply
        .header('Content-Type', 'application/vnd.apple.mpegurl')
        .header('Cache-Control', 'public, max-age=1')
        .send(body);
    }

    const p = join(dir, file);
    const s = await stat(p).catch(() => null);
    if (!s) return reply.code(404).header('Cache-Control', 'no-store').send({ message: 'segment gone' });
    return reply
      .header('Content-Type', 'video/mp2t')
      .header('Content-Length', String(s.size))
      .header('Cache-Control', 'public, max-age=86400, immutable')
      .send(createReadStream(p));
  });
};
