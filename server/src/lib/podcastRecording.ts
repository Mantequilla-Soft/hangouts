import { EgressClient, DirectFileOutput } from 'livekit-server-sdk';
import { TrackType, TrackSource } from '@livekit/protocol';
import { spawn } from 'node:child_process';
import { mkdir, chmod, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { roomService } from './livekit.js';
import { mutateRoomMetadata } from './roomMeta.js';
import { config } from '../config.js';

/**
 * "Record as podcast" in audio rooms (H23).
 *
 * One TRACK egress per speaker's microphone: the opus track is written to an
 * .ogg file as it arrives (no Chrome, no decode, no mixing on the egress), which
 * is the lightest recording LiveKit can do. A speaker who leaves the stage and
 * comes back gets a new track and a new file with its own start offset.
 *
 * Stage changes (who is speaking, from LiveKit's participant list, polled every
 * 10 s for the few rooms recording) and the host's markers become chapters.
 *
 * On stop, ONE ffmpeg run (niced, one at a time on the box) lays the speaker
 * files on a shared timeline into a single MP3, and the host gets: the mix, the
 * per-speaker files with their offsets (for the audio editor's voice tracks),
 * and the chapters. All of it is kept a day behind unguessable links.
 *
 * While recording, the room's metadata carries `podcastLive`, which GET /streams
 * passes on, so the checker can announce the show as <podcast:liveItem>.
 */
const egressClient = new EgressClient(config.LIVEKIT_HOST, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);

// Under /tmp/livekit-recordings: the only path bind-mounted into the egress container.
export const PODCAST_DIR = '/tmp/livekit-recordings/podcast';
export const MAX_SPEAKER_TRACKS = 12;
const POLL_MS = 10_000;
const RESULT_TTL_MS = 24 * 3_600_000;
const MIX_BITRATE = '96k';
/** Chapters closer together than this are merged (a quick hop on and off stage). */
const MIN_CHAPTER_GAP_SEC = 30;

export interface SpeakerTrack {
  identity: string;
  trackSid: string;
  egressId: string;
  file: string;
  startedAt: number;
}

export type StageEvent =
  | { at: number; type: 'join' | 'leave'; identity: string }
  | { at: number; type: 'marker'; title: string };

export interface PodcastSession {
  room: string;
  host: string;
  title: string | null;
  startedAt: number;
  dir: string;
  tracks: SpeakerTrack[];
  onStage: Set<string>;
  events: StageEvent[];
}

export type ChapterKind = 'start' | 'join' | 'marker';
export interface PodcastChapter { start: number; kind: ChapterKind; identity?: string; title?: string }

export interface PodcastResult {
  token: string;
  room: string;
  host: string;
  title: string | null;
  createdAt: number;
  status: 'mixing' | 'ready' | 'failed';
  durationSec: number;
  dir: string;
  mixFile: string | null;
  tracks: Array<{ identity: string; file: string; offsetSec: number }>;
  chapters: PodcastChapter[];
}

const sessions = new Map<string, PodcastSession>();
const results = new Map<string, PodcastResult>();
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function getPodcastSession(room: string): PodcastSession | null { return sessions.get(room) ?? null; }
export function getPodcastResult(token: string): PodcastResult | null { return results.get(token) ?? null; }
export function podcastResultsFor(host: string): PodcastResult[] {
  return [...results.values()].filter((r) => r.host === host).sort((a, b) => b.createdAt - a.createdAt);
}

/** Pure: chapters from the stage events of a recording `durationSec` long. */
export function chaptersFrom(events: StageEvent[], startedAt: number, host: string, durationSec: number): PodcastChapter[] {
  const out: PodcastChapter[] = [{ start: 0, kind: 'start' }];
  const seen = new Set<string>();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const start = Math.round((e.at - startedAt) / 1000);
    if (start <= 0 || (durationSec > 0 && start >= durationSec)) continue;
    let ch: PodcastChapter | null = null;
    if (e.type === 'marker') ch = { start, kind: 'marker', title: e.title };
    else if (e.type === 'join' && e.identity !== host && !seen.has(e.identity)) ch = { start, kind: 'join', identity: e.identity };
    if (e.type === 'join') seen.add(e.identity);
    if (!ch) continue;
    const last = out[out.length - 1];
    if (start - last.start < MIN_CHAPTER_GAP_SEC) {
      // A marker the host set on purpose wins over an automatic chapter; the
      // opening chapter always stays at 0.
      if (ch.kind === 'marker' && last.kind !== 'start') out[out.length - 1] = ch;
      continue;
    }
    out.push(ch);
  }
  return out;
}

/** Pure: the ffmpeg arguments that put each file at its offset and mix them. */
export function mixArgs(inputs: Array<{ path: string; offsetSec: number }>, out: string): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const i of inputs) args.push('-i', i.path);
  const parts = inputs.map((i, n) => {
    const ms = Math.max(0, Math.round(i.offsetSec * 1000));
    // aresample async fills gaps from the timestamps with silence (a muted or
    // dropped stretch must not pull the rest of that voice forward).
    return `[${n}:a]aresample=async=1:first_pts=0,adelay=${ms}:all=1[a${n}]`;
  });
  const labels = inputs.map((_, n) => `[a${n}]`).join('');
  const mix = inputs.length > 1
    ? `${labels}amix=inputs=${inputs.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95[out]`
    : `[a0]anull[out]`;
  args.push('-filter_complex', `${parts.join(';')};${mix}`, '-map', '[out]', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', MIX_BITRATE, out);
  return args;
}

// One mix at a time on the box; the rest wait their turn.
let mixQueue: Promise<unknown> = Promise.resolve();
function runMix(args: string[]): Promise<void> {
  const run = () => new Promise<void>((resolve, reject) => {
    const p = spawn('nice', ['-n', '15', 'ffmpeg', ...args], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  const next = mixQueue.catch(() => undefined).then(run);
  mixQueue = next;
  return next;
}

/** Wait until a file egress is finishing appears and its size settles. */
async function settled(path: string, deadline: number): Promise<number | null> {
  let size = -1;
  for (;;) {
    const s = await stat(path).catch(() => null);
    if (s && s.size > 0 && s.size === size) return s.size;
    if (s) size = s.size;
    if (Date.now() >= deadline) return s && s.size > 0 ? s.size : null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

type LogLike = { warn: (obj: unknown, msg?: string) => void };

function micTrackOf(p: { tracks: Array<{ sid: string; type: number; source: number; muted?: boolean }> }) {
  return p.tracks.find((t) => t.type === TrackType.AUDIO && t.source === TrackSource.MICROPHONE) ?? null;
}

/** One poll: start egress for new speaker tracks, note who joined or left. */
export async function syncPodcastSession(s: PodcastSession, log?: LogLike): Promise<'ok' | 'gone'> {
  let parts;
  try {
    parts = await roomService.listParticipants(s.room);
  } catch {
    const rooms = await roomService.listRooms([s.room]).catch(() => null);
    return rooms && rooms.length === 0 ? 'gone' : 'ok';
  }
  const now = Date.now();
  const speaking = new Set<string>();
  for (const p of parts) {
    if (p.identity.startsWith('obs-')) continue;
    const mic = micTrackOf(p as never);
    if (!mic) continue;
    speaking.add(p.identity);
    if (s.tracks.some((t) => t.trackSid === mic.sid)) continue;
    if (s.tracks.length >= MAX_SPEAKER_TRACKS) continue;
    const n = s.tracks.filter((t) => t.identity === p.identity).length + 1;
    const file = `${safe(p.identity)}-${n}.ogg`;
    try {
      const info = await egressClient.startTrackEgress(s.room, new DirectFileOutput({ filepath: join(s.dir, file) }), mic.sid);
      s.tracks.push({ identity: p.identity, trackSid: mic.sid, egressId: info.egressId, file, startedAt: now });
    } catch (err) {
      log?.warn({ err, room: s.room, identity: p.identity }, '[podcast] track egress failed');
    }
  }
  for (const id of speaking) if (!s.onStage.has(id)) s.events.push({ at: now, type: 'join', identity: id });
  for (const id of s.onStage) if (!speaking.has(id)) s.events.push({ at: now, type: 'leave', identity: id });
  s.onStage = speaking;
  if (s.events.length > 500) s.events.splice(0, s.events.length - 500);
  return 'ok';
}

async function setPodcastLive(room: string, live: { startedAt: string } | null): Promise<void> {
  await mutateRoomMetadata(room, (m) => {
    const next = { ...m };
    if (live) next.podcastLive = live;
    else delete next.podcastLive;
    return next;
  }).catch(() => { /* the room may be gone already */ });
}

export async function startPodcastRecording(room: string, host: string, title: string | null, log?: LogLike): Promise<PodcastSession> {
  const existing = sessions.get(room);
  if (existing) return existing;
  const startedAt = Date.now();
  const dir = join(PODCAST_DIR, `${safe(room)}-${startedAt}`);
  await mkdir(dir, { recursive: true });
  // The egress container writes as its own user.
  await chmod(PODCAST_DIR, 0o777).catch(() => { /* best effort */ });
  await chmod(dir, 0o777).catch(() => { /* best effort */ });
  const s: PodcastSession = { room, host, title, startedAt, dir, tracks: [], onStage: new Set(), events: [] };
  sessions.set(room, s);
  await syncPodcastSession(s, log);
  await setPodcastLive(room, { startedAt: new Date(startedAt).toISOString() });
  ensurePoller(log);
  return s;
}

export function addPodcastMarker(room: string, title: string): boolean {
  const s = sessions.get(room);
  if (!s) return false;
  const clean = title.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return false;
  if (s.events.filter((e) => e.type === 'marker').length >= 100) return false;
  s.events.push({ at: Date.now(), type: 'marker', title: clean });
  return true;
}

/**
 * Stop every speaker egress and start the mix. Resolves as soon as the result
 * exists (status 'mixing'); the mix finishes in the background and flips it to
 * 'ready' (or 'failed', with the speaker files still there).
 */
export async function stopPodcastRecording(room: string, log?: LogLike): Promise<PodcastResult | null> {
  const s = sessions.get(room);
  if (!s) return null;
  sessions.delete(room);
  const stoppedAt = Date.now();
  await Promise.all(s.tracks.map((t) => egressClient.stopEgress(t.egressId).catch(() => { /* ended with its track */ })));
  void setPodcastLive(room, null);
  const durationSec = Math.max(0, Math.round((stoppedAt - s.startedAt) / 1000));
  const result: PodcastResult = {
    token: randomBytes(16).toString('hex'),
    room, host: s.host, title: s.title, createdAt: stoppedAt, status: 'mixing', durationSec,
    dir: s.dir, mixFile: null,
    tracks: s.tracks.map((t) => ({ identity: t.identity, file: t.file, offsetSec: Math.max(0, Math.round((t.startedAt - s.startedAt) / 100) / 10) })),
    chapters: chaptersFrom(s.events, s.startedAt, s.host, durationSec),
  };
  results.set(result.token, result);
  void finishMix(result, log);
  return result;
}

async function finishMix(r: PodcastResult, log?: LogLike): Promise<void> {
  try {
    const deadline = Date.now() + 30_000;
    const present: PodcastResult['tracks'] = [];
    for (const t of r.tracks) {
      if (await settled(join(r.dir, t.file), deadline)) present.push(t);
    }
    r.tracks = present;
    if (present.length === 0) throw new Error('no speaker audio was recorded');
    const mixFile = 'episode.mp3';
    await runMix(mixArgs(present.map((t) => ({ path: join(r.dir, t.file), offsetSec: t.offsetSec })), join(r.dir, mixFile)));
    r.mixFile = mixFile;
    r.status = 'ready';
  } catch (err) {
    log?.warn({ err, room: r.room }, '[podcast] mix failed');
    r.status = 'failed';
  }
}

let poller: ReturnType<typeof setInterval> | null = null;
function ensurePoller(log?: LogLike) {
  if (poller) return;
  poller = setInterval(() => {
    void (async () => {
      for (const s of [...sessions.values()]) {
        // A room that closed while recording still becomes an episode.
        if (await syncPodcastSession(s, log) === 'gone') await stopPodcastRecording(s.room, log);
      }
      const cutoff = Date.now() - RESULT_TTL_MS;
      for (const [token, r] of results) {
        if (r.createdAt < cutoff) {
          results.delete(token);
          await rm(r.dir, { recursive: true, force: true }).catch(() => { /* raced */ });
        }
      }
      if (sessions.size === 0 && results.size === 0 && poller) { clearInterval(poller); poller = null; }
    })();
  }, POLL_MS);
  poller.unref?.();
}

/** Tests only. */
export function resetPodcastRecording(): void {
  sessions.clear();
  results.clear();
  mixQueue = Promise.resolve();
  if (poller) { clearInterval(poller); poller = null; }
}
