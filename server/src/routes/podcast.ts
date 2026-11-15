import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { canRecordAudio } from '../lib/permissions.js';
import { readRoomFacts } from '../lib/roomInfo.js';
import { config } from '../config.js';
import {
  startPodcastRecording, stopPodcastRecording, addPodcastMarker, getPodcastSession,
  getPodcastResult, podcastResultsFor, type PodcastResult,
} from '../lib/podcastRecording.js';

/**
 * Record a live audio room as a podcast episode (H23).
 *
 *   POST /rooms/:name/podcast/start    host + Pro, audio (conference) rooms only
 *   POST /rooms/:name/podcast/marker   host: a chapter mark now { title }
 *   POST /rooms/:name/podcast/stop     host: stop, mix, return the result
 *   GET  /rooms/:name/podcast/status   host: recording? since when, speakers
 *   GET  /podcast/recordings           host: their episodes of the last day
 *   GET  /podcast/files/:token/:file   the mix or a speaker file (token = capability)
 */
const ROOM_RE = '^[A-Za-z0-9_-]{1,80}$';
const nameParams = { params: { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: ROOM_RE } } } } as const;

export function resultView(r: PodcastResult) {
  const file = (f: string) => `/podcast/files/${r.token}/${encodeURIComponent(f)}`;
  return {
    token: r.token,
    room: r.room,
    title: r.title,
    status: r.status,
    durationSec: r.durationSec,
    createdAt: new Date(r.createdAt).toISOString(),
    mixUrl: r.mixFile ? file(r.mixFile) : null,
    tracks: r.tracks.map((t) => ({ identity: t.identity, offsetSec: t.offsetSec, url: file(t.file) })),
    chapters: r.chapters,
  };
}

async function hostCheck(name: string, username: string) {
  const facts = await readRoomFacts(name);
  if (!facts) return { error: 'not_found' as const, facts: null };
  if (facts.host !== username) return { error: 'forbidden' as const, facts };
  return { error: null, facts };
}

export const podcastRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/rooms/:name/podcast/start', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: nameParams,
  }, async (request, reply) => {
    if (!config.PODCAST_RECORDING_ENABLED) return reply.code(503).send({ message: 'Podcast recording is switched off' });
    const { name } = request.params as { name: string };
    const check = await hostCheck(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can record the show');
    if (check.facts?.mode === 'standalone') return reply.badRequest('Record as podcast is for audio rooms');
    const perm = await canRecordAudio(request.username);
    if (!perm.ok) return reply.code(402).send({ message: perm.reason ?? 'Recording is a 3Speak Pro feature' });
    const s = await startPodcastRecording(name, request.username, check.facts?.title ?? null, request.log);
    return reply.send({ recording: true, startedAt: new Date(s.startedAt).toISOString(), speakers: s.tracks.length });
  });

  fastify.post('/rooms/:name/podcast/marker', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      ...nameParams,
      body: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 } } },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const s = getPodcastSession(name);
    if (!s) return reply.badRequest('This room is not being recorded');
    if (s.host !== request.username) return reply.forbidden('Only the host can add chapters');
    if (!addPodcastMarker(name, (request.body as { title: string }).title)) return reply.badRequest('Chapter not added');
    return reply.send({ ok: true, at: Math.round((Date.now() - s.startedAt) / 1000) });
  });

  fastify.post('/rooms/:name/podcast/stop', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: nameParams,
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const s = getPodcastSession(name);
    if (!s) return reply.badRequest('This room is not being recorded');
    if (s.host !== request.username) return reply.forbidden('Only the host can stop the recording');
    const result = await stopPodcastRecording(name, request.log);
    return reply.send(result ? resultView(result) : { status: 'failed' });
  });

  fastify.get('/rooms/:name/podcast/status', {
    preHandler: [requireAuth],
    schema: nameParams,
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const s = getPodcastSession(name);
    reply.header('Cache-Control', 'no-store');
    if (!s || s.host !== request.username) return reply.send({ recording: false });
    return reply.send({
      recording: true,
      startedAt: new Date(s.startedAt).toISOString(),
      speakers: [...new Set(s.tracks.map((t) => t.identity))],
      chapters: s.events.filter((e) => e.type === 'marker').length,
    });
  });

  fastify.get('/podcast/recordings', { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send({ recordings: podcastResultsFor(request.username).map(resultView) });
  });

  // The token is the capability (16 random bytes, a day), like the recording
  // download link: a plain <a href> or fetch() needs no auth header.
  fastify.get('/podcast/files/:token/:file', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object', required: ['token', 'file'],
        properties: { token: { type: 'string', pattern: '^[0-9a-f]{32}$' }, file: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}\\.(ogg|mp3)$' } },
      },
    },
  }, async (request, reply) => {
    const { token, file } = request.params as { token: string; file: string };
    const r = getPodcastResult(token);
    if (!r || !(file === r.mixFile || r.tracks.some((t) => t.file === file))) return reply.notFound('Recording not available');
    const p = join(r.dir, file);
    const s = await stat(p).catch(() => null);
    if (!s) return reply.notFound('Recording not available');
    return reply
      .header('Content-Type', file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg')
      .header('Content-Length', String(s.size))
      .header('Content-Disposition', `attachment; filename="${file}"`)
      .header('Cache-Control', 'private, max-age=3600')
      .send(createReadStream(p));
  });
};
