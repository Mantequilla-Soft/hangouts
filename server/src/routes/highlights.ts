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
 *   POST   /rooms/:name/recap             the host: 2 to 4 of the stream's ready
 *                                         clips joined into one recap video, in
 *                                         stream order (posted as a Short that
 *                                         names the VOD as its source)
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

/** Clips in one recap, and its longest total (a Short is at most 120 s; a few
 *  seconds of slack for clips cut a little long). */
export const RECAP_MAX_CLIPS = 4;
export const RECAP_MIN_CLIPS = 2;
export const RECAP_MAX_SEC = 125;

/** Pure: the ffmpeg arguments joining `inputs` into one H.264/AAC MP4 of
 *  `size` (each part scaled to fit and padded, 30 fps, stereo 48 kHz), so clips
 *  cut at different sizes or rates still join. */
export function recapArgs(inputs: string[], output: string, size: { w: number; h: number } = { w: 1280, h: 720 }): string[] {
  const { w, h } = size;
  const parts = inputs.map((_, i) => (
    `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];`
    + `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`
  ));
  const join = `${inputs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`;
  return ['-y', '-hide_banner', '-loglevel', 'error',
    ...inputs.flatMap((p) => ['-i', p]),
    '-filter_complex', [...parts, join].join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', output];
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

  // The OBS dock's "your viewers' clips" card (a dock session or a login): the
  // host's newest stream with ready clips their viewers made. The dock shows it
  // once that stream is over and its VOD is up (the dock checks the VOD).
  fastify.get('/dock/clips', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' }, dock: true },
  }, async (request, reply) => {
    const store = await clipStore();
    const host = request.username;
    const suggested = (await store.listForHost(host)).filter((c) => (
      c.source === 'viewer' && !!c.clipper && c.clipper !== host && clipStatusOf(c).status === 'ready'
    ));
    reply.header('Cache-Control', 'private, no-store');
    const room = suggested[0]?.room ?? null;
    if (!room) return reply.send({ room: null, count: 0, clippers: 0 });
    const ofRoom = suggested.filter((c) => c.room === room);
    return reply.send({ room, count: ofRoom.length, clippers: new Set(ofRoom.map((c) => c.clipper)).size });
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

  fastify.post('/rooms/:name/recap', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    schema: {
      ...nameParams,
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', minItems: RECAP_MIN_CLIPS, maxItems: RECAP_MAX_CLIPS, uniqueItems: true, items: { type: 'string', pattern: '^[0-9a-f]{18}$' } },
          vertical: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { ids, vertical = false } = request.body as { ids: string[]; vertical?: boolean };
    const store = await clipStore();
    const found = await Promise.all(ids.map((id) => store.get(id)));
    if (found.some((c) => !c || c.room !== name)) return reply.notFound('Clip not found');
    const list = found as NonNullable<(typeof found)[number]>[];
    if (list.some((c) => c.host !== request.username)) return reply.forbidden('Only the host can make a recap of the stream');
    if (list.some((c) => clipStatusOf(c).status !== 'ready')) return reply.conflict('A clip is not ready yet');
    const total = list.reduce((sum, c) => sum + (Number(c.durationSec) || 0), 0);
    if (total > RECAP_MAX_SEC) return reply.badRequest(`A recap is at most ${RECAP_MAX_SEC - 5} seconds`);
    if (vertical && list.some((c) => !c.crop)) return reply.badRequest('This stream had no phone crop');

    // In stream order, whatever order they were picked in.
    const ordered = [...list].sort((a, b) => (a.offsetSec ?? 0) - (b.offsetSec ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());
    const made: string[] = [];
    try {
      const inputs: string[] = [];
      for (const c of ordered) {
        if (!vertical) { inputs.push(join(CLIP_DIR, c.file)); continue; }
        // The 9:16 copy of each part, made now when it is not there yet.
        let v = c.verticalFile && await stat(join(CLIP_DIR, c.verticalFile)).catch(() => null) ? c.verticalFile : null;
        if (!v) {
          v = `${c.file.replace(/\.mp4$/, '')}-v-${randomBytes(3).toString('hex')}.mp4`;
          await runNiced(verticalArgs(join(CLIP_DIR, c.file), join(CLIP_DIR, v), c.crop!));
          made.push(v);
          await store.update(c.id, { verticalFile: v });
        }
        inputs.push(join(CLIP_DIR, v));
      }
      const out = `recap-${name.replace(/[^A-Za-z0-9_-]/g, '_')}-${randomBytes(4).toString('hex')}.mp4`;
      try {
        await runNiced(recapArgs(inputs, join(CLIP_DIR, out), vertical ? { w: 720, h: 1280 } : { w: 1280, h: 720 }));
      } catch (err) {
        await unlink(join(CLIP_DIR, out)).catch(() => { /* never written */ });
        throw err;
      }
      return reply.send({
        room: name,
        host: request.username,
        path: `/dvr/clips/${out}`,
        durationSec: Math.round(total * 10) / 10,
        vertical,
        clips: ordered.map((c) => c.id),
        // From the first part: where in the stream the recap starts.
        offsetSec: ordered[0].offsetSec ?? null,
        expiresAt: new Date(Date.now() + config.CLIP_KEEP_HOURS * 3_600_000).toISOString(),
      });
    } catch (err) {
      request.log.error({ err }, '[clips] recap failed');
      return reply.code(500).send({ message: 'Could not make the recap.', ...(made.length ? { partial: made.length } : {}) });
    }
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
