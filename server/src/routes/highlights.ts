import type { FastifyPluginAsync } from 'fastify';
import { unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { requireAuth } from '../middleware/requireAuth.js';
import { config } from '../config.js';
import {
  getHighlights, onHighlight, setRoomResolver, startHighlightSweep,
  type HighlightMoment, type RoomInfo,
} from '../lib/streamHighlights.js';
import { clipStore, clipView, clipStatusOf, registerClip, cropFromMeta } from '../lib/streamClips.js';
import { readRoomFacts } from '../lib/roomInfo.js';
import { cutDvrClip, dvrDirOf } from './dvr.js';
import { vodRecordingOf, vodWindow, VOD_CLIP_SEC } from '../lib/vodClips.js';

/**
 * Highlight clips that become Shorts (H13).
 *
 *   GET    /rooms/:name/highlights        the host: moments + every kept clip;
 *                                         anyone else signed in: their own clips
 *   GET    /clips/mine                    the clips the signed-in user made, and
 *                                         every clip of their own streams
 *   DELETE /clips/:id                     the host or the clipper drops a clip
 *   POST   /clips/:id/vertical            a 9:16 copy cut with the host's phone
 *                                         crop (H19), for posting as a Short
 *
 * Chat lines are counted by the chat backlog route (POST /rooms/:name/chat,
 * routes/chat.ts), so a line costs one request. And, while a Pro host's DVR runs, every highlight moment cuts its own clip
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
  if (!dvrDirOf(room)) return pendingMomentClip(room, moment, info);
  const cut = await cutDvrClip(room);
  if (cut.error) return false;
  const facts = await readRoomFacts(room);
  const kept = await registerClip({
    room, host: info.host, clipper: null, source: 'auto', file: cut.file,
    offsetSec: moment.offsetSec, durationSec: cut.durationSec, reasons: moment.reasons,
    crop: cropFromMeta(facts?.meta),
  }).catch(() => null);
  if (!kept || !('clip' in kept)) {
    await unlink(join(CLIP_DIR, cut.file)).catch(() => { /* already gone */ });
    return false;
  }
  return true;
}

/** Without DVR: a pending clip of the moment, cut from the VOD when the stream
 *  ends (lib/vodClips.ts). Nothing when the stream records no VOD. */
async function pendingMomentClip(room: string, moment: HighlightMoment, info: RoomInfo): Promise<boolean> {
  const rec = vodRecordingOf(room);
  if (!rec) return false;
  const win = vodWindow(rec, moment.at);
  const facts = await readRoomFacts(room);
  const kept = await registerClip({
    room, host: info.host, clipper: null, source: 'auto',
    file: `${room.replace(/[^A-Za-z0-9_-]/g, '_')}-${moment.at}-${randomBytes(4).toString('hex')}.mp4`,
    offsetSec: moment.offsetSec, durationSec: VOD_CLIP_SEC, reasons: moment.reasons,
    crop: cropFromMeta(facts?.meta),
    ...('start' in win ? { pendingAt: win.start } : { unavailable: win.unavailable }),
  }).catch(() => null);
  return !!kept && 'clip' in kept;
}

/** Pure: the ffmpeg arguments for the 9:16 copy (crop x*W - w*W/2 .. x*W + w*W/2,
 *  full height, even sizes for H.264). The only re-encode in the clip code. */
export function verticalArgs(input: string, output: string, crop: { x: number; w: number }): string[] {
  const w = `trunc(iw*${crop.w}/2)*2`;
  const x = `max(0\\,min(iw-${w}\\,trunc(iw*${Math.round((crop.x - crop.w / 2) * 10000) / 10000}/2)*2))`;
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-vf', `crop=${w}:ih:${x}:0`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', output];
}

// One vertical encode at a time on the box; the rest wait their turn.
let encodeQueue: Promise<unknown> = Promise.resolve();
function runNiced(args: string[]): Promise<void> {
  const run = () => new Promise<void>((resolve, reject) => {
    const p = spawn('nice', ['-n', '15', 'ffmpeg', ...args], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  const next = encodeQueue.catch(() => undefined).then(run);
  encodeQueue = next;
  return next;
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
export function resetHighlightRoutes(): void { wired = false; encodeQueue = Promise.resolve(); }

export const highlightRoutes: FastifyPluginAsync = async (fastify) => {
  wireOnce();

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
    // The clips they made, and every clip of their own streams (H13 /clips page).
    const [mine, ofMyStreams] = await Promise.all([store.listForClipper(request.username), store.listForHost(request.username)]);
    const byId = new Map([...ofMyStreams, ...mine].map((c) => [c.id, c]));
    const clips = [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 100);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send({ clips: clips.map(clipView), keepHours: config.CLIP_KEEP_HOURS });
  });

  fastify.post('/clips/:id/vertical', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{18}$' } } } },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const store = await clipStore();
    const clip = await store.get(id);
    if (!clip) return reply.notFound('Clip not found');
    if (request.username !== clip.host && request.username !== clip.clipper) {
      return reply.forbidden('Only the host or the person who made the clip can do that');
    }
    if (clip.verticalFile && await stat(join(CLIP_DIR, clip.verticalFile)).catch(() => null)) {
      return reply.send({ clip: clipView(clip) });
    }
    if (clipStatusOf(clip).status !== 'ready') return reply.conflict('The clip is not ready yet');
    if (!clip.crop) return reply.badRequest('This stream had no phone crop');
    const out = `${clip.file.replace(/\.mp4$/, '')}-v-${randomBytes(3).toString('hex')}.mp4`;
    try {
      await runNiced(verticalArgs(join(CLIP_DIR, clip.file), join(CLIP_DIR, out), clip.crop));
    } catch (err) {
      request.log.error({ err }, '[clips] vertical failed');
      await unlink(join(CLIP_DIR, out)).catch(() => { /* never written */ });
      return reply.code(500).send({ message: 'Could not make the vertical clip.' });
    }
    await store.update(id, { verticalFile: out });
    return reply.send({ clip: clipView({ ...clip, verticalFile: out }) });
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
    if (clip.verticalFile) await unlink(join(CLIP_DIR, clip.verticalFile)).catch(() => { /* already swept */ });
    return reply.send({ deleted: true });
  });
};
