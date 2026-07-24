import type { FastifyPluginAsync } from 'fastify';
import { EgressClient, SegmentedFileOutput, SegmentedFileProtocol, EncodingOptionsPreset } from 'livekit-server-sdk';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { isUserPremium } from '../lib/users.js';

/**
 * DVR: a segmented-HLS egress that records a rolling on-disk buffer while a Pro
 * host is live, so they can grab a shareable clip of the last ~30 seconds. This
 * is a SECOND egress alongside the stream (and the VOD, if any), which is why
 * it's Pro-gated and behind DVR_ENABLED.
 *
 * The egress writes .ts segments to a shared local path (the /opt/livekit egress
 * runs on this box), a janitor prunes anything older than the buffer window, and
 * /clip ffmpeg-concats the most recent segments into an MP4 served from /clips.
 */
const egressClient = new EgressClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

const DVR_DIR = '/tmp/livekit-dvr';
const CLIP_DIR = '/tmp/livekit-dvr-clips';
const SEGMENT_SEC = 2;                 // HLS segment length
const BUFFER_SEC = 150;                // keep ~2.5min of segments on disk
const CLIP_SEC = 30;                   // clip window
const CLIP_TTL_MS = 60 * 60 * 1000;    // serve a clip for 1h, then sweep

// roomName -> active DVR session.
const active = new Map<string, { egressId: string; dir: string; janitor: NodeJS.Timeout }>();

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };
  let meta: { host?: string } = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null };
}

// Drop .ts segments older than the buffer window so disk stays bounded.
async function pruneSegments(dir: string) {
  try {
    const now = Date.now();
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.ts')) continue;
      const p = join(dir, f);
      const s = await stat(p).catch(() => null);
      if (s && now - s.mtimeMs > BUFFER_SEC * 1000) await unlink(p).catch(() => { /* raced */ });
    }
  } catch { /* dir not created yet */ }
}

// Concat MPEG-TS segments into an MP4 without re-encoding (fast, lossless).
function ffmpegConcat(inputs: string[], out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', `concat:${inputs.join('|')}`, '-c', 'copy', '-movflags', '+faststart', out];
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

const paramsSchema = {
  params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
} as const;

export const dvrRoutes: FastifyPluginAsync = async (fastify) => {
  // Serve a finished clip. No auth: the filename carries a random token, same
  // trust model as the VOD download link. TTL-swept.
  fastify.get('/dvr/clips/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!/^[A-Za-z0-9._-]+\.mp4$/.test(file) || file.includes('..')) return reply.badRequest('bad file');
    const p = join(CLIP_DIR, file);
    const s = await stat(p).catch(() => null);
    if (!s) return reply.notFound('clip not found');
    reply.header('Content-Type', 'video/mp4');
    reply.header('Content-Length', String(s.size));
    reply.header('Content-Disposition', `inline; filename="${file}"`);
    return reply.send(createReadStream(p));
  });

  // Start DVR (host + Pro). Idempotent.
  fastify.post('/rooms/:name/dvr/start', { preHandler: [requireAuth, checkBan], schema: paramsSchema }, async (request, reply) => {
    if (!config.DVR_ENABLED) return reply.code(503).send({ message: 'DVR is disabled' });
    const { name } = request.params as { name: string };
    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can start DVR');
    if (!(await isUserPremium(request.username))) {
      return reply.code(402).send({ message: 'DVR (clip the last 30s) is a 3Speak Pro feature.' });
    }
    if (active.has(name)) return reply.send({ status: 'recording', egressId: active.get(name)!.egressId });

    const dir = join(DVR_DIR, safeName(name));
    await mkdir(dir, { recursive: true });
    const output = new SegmentedFileOutput({
      protocol: SegmentedFileProtocol.HLS_PROTOCOL,
      filenamePrefix: join(dir, 'seg'),
      playlistName: join(dir, 'index.m3u8'),
      livePlaylistName: join(dir, 'live.m3u8'),
      segmentDuration: SEGMENT_SEC,
    });
    const info = await egressClient.startRoomCompositeEgress(name, { segments: output }, {
      layout: 'speaker',
      encodingOptions: EncodingOptionsPreset.H264_720P_30,
    });
    const janitor = setInterval(() => void pruneSegments(dir), 30_000);
    active.set(name, { egressId: info.egressId, dir, janitor });
    return reply.send({ status: 'recording', egressId: info.egressId });
  });

  // Clip the last ~30s into a shareable MP4.
  fastify.post('/rooms/:name/dvr/clip', { preHandler: [requireAuth, checkBan], schema: paramsSchema }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can clip');
    const entry = active.get(name);
    if (!entry) return reply.badRequest('DVR is not recording');

    // Most-recent segments within the clip window, in chronological order. Pad
    // by two segment durations so we never lose the tail to timing.
    const now = Date.now();
    const withMtime: Array<{ f: string; m: number }> = [];
    for (const f of (await readdir(entry.dir)).filter((x) => x.endsWith('.ts'))) {
      const s = await stat(join(entry.dir, f)).catch(() => null);
      if (s) withMtime.push({ f, m: s.mtimeMs });
    }
    withMtime.sort((a, b) => a.m - b.m);
    const cutoff = now - (CLIP_SEC + SEGMENT_SEC * 2) * 1000;
    const recent = withMtime.filter((x) => x.m >= cutoff).map((x) => join(entry.dir, x.f));
    if (recent.length === 0) return reply.badRequest('Nothing recorded yet — give it a few seconds.');

    await mkdir(CLIP_DIR, { recursive: true });
    const outName = `${safeName(name)}-${Date.now()}-${randomBytes(4).toString('hex')}.mp4`;
    try {
      await ffmpegConcat(recent, join(CLIP_DIR, outName));
    } catch (e) {
      request.log.error({ err: e }, '[dvr] clip failed');
      return reply.code(500).send({ message: 'Could not build the clip.' });
    }
    return reply.send({ path: `/dvr/clips/${outName}` });
  });

  // Stop DVR.
  fastify.post('/rooms/:name/dvr/stop', { preHandler: [requireAuth, checkBan], schema: paramsSchema }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can stop DVR');
    const entry = active.get(name);
    if (!entry) return reply.send({ status: 'stopped' });
    clearInterval(entry.janitor);
    await egressClient.stopEgress(entry.egressId).catch(() => { /* already gone */ });
    active.delete(name);
    void pruneSegments(entry.dir);
    return reply.send({ status: 'stopped' });
  });

  // Status.
  fastify.get('/rooms/:name/dvr/status', { preHandler: [requireAuth, checkBan], schema: paramsSchema }, async (request, reply) => {
    const { name } = request.params as { name: string };
    return reply.send({ recording: active.has(name) });
  });
};

// Sweep clips older than the TTL.
setInterval(() => {
  void (async () => {
    try {
      const now = Date.now();
      for (const f of await readdir(CLIP_DIR)) {
        const p = join(CLIP_DIR, f);
        const s = await stat(p).catch(() => null);
        if (s && now - s.mtimeMs > CLIP_TTL_MS) await unlink(p).catch(() => { /* raced */ });
      }
    } catch { /* dir not created yet */ }
  })();
}, 10 * 60 * 1000);
