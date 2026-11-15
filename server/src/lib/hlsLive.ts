import { EgressClient, SegmentedFileOutput, SegmentedFileProtocol, EncodingOptions } from 'livekit-server-sdk';
import { TrackType, TrackSource, ParticipantInfo_Kind, ParticipantInfo_State, type ParticipantInfo } from '@livekit/protocol';
import { mkdir, chmod, rm, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { roomService } from './livekit.js';
import { config } from '../config.js';

/**
 * HLS for large audiences (backlog idea H1).
 *
 * WebRTC gives every viewer a sub-second picture, but each one is a live SFU
 * connection the server feeds itself: the 2026-11-05 stress test was clean at
 * 50 viewers of one stream and fell apart at 100. HLS is plain files that a CDN
 * can fan out to any number of viewers, at the price of a few seconds' delay.
 *
 * So the first HLS_VIEWER_THRESHOLD viewers of a stream watch over WebRTC, and
 * everyone after them gets a token WITHOUT subscribe rights plus this stream's
 * HLS playlist. They are still room participants, so chat, boosts, the viewer
 * count and "is the host live" all keep working over the data channel; LiveKit
 * just sends them no media (verified on a real LiveKit 1.x stack: data packets
 * and lk.chat text streams reach a canSubscribe=false participant both ways).
 *
 * The playlist comes from a segmented-HLS egress of the host's program track,
 * the same recipe as the DVR. It starts with the first HLS viewer and stops when
 * the room ends or nobody has watched over HLS for IDLE_STOP_MS. It is a
 * separate egress from the DVR's on purpose: both are bounded (one per stream)
 * and keeping them apart means stopping a DVR never freezes HLS viewers.
 */

export type Delivery = 'webrtc' | 'hls';

/** Minimal room metadata this module reads. */
export interface HlsRoomMeta {
  host?: string;
  collabGuest?: string;
  mode?: string;
  portrait?: boolean;
}

type LogLike = { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };

// MUST live under /tmp/livekit-recordings: the only path bind-mounted into the
// egress container and allowed by egress.yaml `local:` (see routes/dvr.ts).
export const HLS_DIR = '/tmp/livekit-recordings/live';
const SEGMENT_SEC = 2;
/** Segments kept on disk. The live playlist lists the newest five (10 s); the
 *  rest is slack for slow CDN pulls and players a little behind. */
const KEEP_SEC = 60;
/** Stop the egress after this long without any HLS viewer. */
export const IDLE_STOP_MS = 5 * 60 * 1000;
/** Restart the egress when the playlist has not been rewritten for this long
 *  while the host is still publishing (host reconnected with a new track, the
 *  egress died). */
export const STALL_MS = 20 * 1000;
/** After a failed egress start, hand out WebRTC for this long instead. */
export const RETRY_AFTER_FAIL_MS = 60 * 1000;
export const SWEEP_MS = 15 * 1000;

const egressClient = new EgressClient(config.LIVEKIT_HOST, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);

interface Session {
  egressId: string;
  dir: string;
  startedAt: number;
  lastViewerAt: number;
  meta: HlsRoomMeta;
}
const sessions = new Map<string, Session>();
const starting = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** HLS is switched on for this server. */
export function hlsEnabled(): boolean {
  return config.HLS_VIEWER_THRESHOLD !== null;
}

/** Viewers may ask for HLS on a poor connection (below the threshold). */
export function hlsWeakFallbackEnabled(): boolean {
  return hlsEnabled() && config.HLS_WEAK_FALLBACK;
}

/** The playlist URL handed to an HLS viewer. Relative (starts with "/") unless
 *  HLS_PUBLIC_BASE points at a CDN. */
export function hlsPlaylistUrl(room: string): string {
  const path = `/rooms/${encodeURIComponent(room)}/hls/live.m3u8`;
  return config.HLS_PUBLIC_BASE ? config.HLS_PUBLIC_BASE.replace(/\/+$/, '') + path : path;
}

/** A start failed recently, so HLS is not offered for this room right now. */
export function hlsUnavailable(room: string, now = Date.now()): boolean {
  const at = failedAt.get(room);
  return at !== undefined && now - at < RETRY_AFTER_FAIL_MS;
}

function isStandardViewer(p: ParticipantInfo, meta: HlsRoomMeta): boolean {
  // Egress, ingress (a headless OBS stream's broadcaster), SIP and agents are
  // not viewers. Test doubles without `kind` count as standard.
  if (p.kind !== undefined && p.kind !== ParticipantInfo_Kind.STANDARD) return false;
  if (p.state === ParticipantInfo_State.DISCONNECTED) return false;
  if (p.identity.startsWith('obs-')) return false;
  if (p.identity === meta.host) return false;
  if (meta.collabGuest && p.identity === meta.collabGuest) return false;
  return true;
}

/** A viewer LiveKit sends media to (counts against the WebRTC threshold). */
export function isMediaViewer(p: ParticipantInfo, meta: HlsRoomMeta): boolean {
  return isStandardViewer(p, meta) && p.permission?.canSubscribe !== false;
}

/** A viewer watching over HLS (in the room without subscribe rights). */
export function isHlsViewer(p: ParticipantInfo, meta: HlsRoomMeta): boolean {
  return isStandardViewer(p, meta) && p.permission?.canSubscribe === false;
}

/**
 * How a viewer joining `room` gets the picture.
 *
 * `hlsCapable` = the client sent `hlsCapable: true` (SDK 0.26.25+ StandaloneWatch).
 * `identity` is the viewer's own identity when known (a reconnecting viewer
 * must not count against itself). `wants: 'hls'` is a viewer on a poor
 * connection asking for HLS. Fails open to WebRTC whenever LiveKit can't be
 * asked, so a broken HLS path never stops anyone from watching.
 */
export async function chooseDelivery(
  room: string,
  meta: HlsRoomMeta,
  identity: string | null,
  wants?: Delivery,
  hlsCapable = false,
): Promise<Delivery> {
  const threshold = config.HLS_VIEWER_THRESHOLD;
  // Only a client that says it can play HLS is ever moved: older SDKs (and
  // the self-contained StandaloneViewer) would show a black picture.
  if (!hlsCapable || threshold === null || meta.mode !== 'standalone') return 'webrtc';
  if (hlsUnavailable(room)) return 'webrtc';
  if (wants === 'hls' && config.HLS_WEAK_FALLBACK) return 'hls';
  if (threshold === 0) return 'hls';
  try {
    const parts = await roomService.listParticipants(room);
    const onWebrtc = parts.filter((p) => p.identity !== identity && isMediaViewer(p, meta)).length;
    return onWebrtc >= threshold ? 'hls' : 'webrtc';
  } catch {
    return 'webrtc';
  }
}

/** The host's program video and full-mix audio, as the DVR and VOD use them. */
async function programTracks(room: string, meta: HlsRoomMeta) {
  let videoTrackId = '';
  let audioTrackId = '';
  let width = 0;
  let height = 0;
  try {
    const parts = await roomService.listParticipants(room);
    const host = parts.find((pt) => pt.identity === meta.host);
    // The host may publish more than one program video: 'studio-vertical' is a
    // second, vertical composition for phone viewers (idea H19). Skip it, and
    // among the rest take the one whose shape matches the stream.
    const videos = (host?.tracks.filter((t) => t.type === TrackType.VIDEO && t.source === TrackSource.CAMERA) ?? [])
      .filter((t, _i, all) => t.name !== 'studio-vertical' || all.every((x) => x.name === 'studio-vertical'));
    const wantPortrait = meta.portrait === true;
    const matches = (t: { width: number; height: number }) => !t.width || !t.height
      || (wantPortrait ? t.height > t.width : t.width >= t.height);
    const video = videos.find(matches) ?? videos[0];
    videoTrackId = video?.sid ?? '';
    width = video?.width ?? 0;
    height = video?.height ?? 0;
    // 'studio-mix' is the FULL program audio (not 'host-monitor', the mix-minus).
    const mics = host?.tracks.filter((t) => t.type === TrackType.AUDIO && t.source === TrackSource.MICROPHONE) ?? [];
    audioTrackId = (mics.find((t) => t.name === 'studio-mix') ?? mics[0])?.sid ?? '';
  } catch { /* fall through to the template composite */ }
  return { videoTrackId, audioTrackId, width, height };
}

/** Start one egress writing this room's live playlist. Segment names carry a
 *  fresh random prefix every time, because a CDN caches segments as immutable:
 *  a restarted egress must never reuse a name. */
async function startEgress(room: string, meta: HlsRoomMeta, log: LogLike): Promise<{ egressId: string; dir: string }> {
  const dir = join(HLS_DIR, safeName(room));
  await mkdir(dir, { recursive: true });
  // The egress container writes as its own user.
  await chmod(HLS_DIR, 0o777).catch(() => { /* best effort */ });
  await chmod(dir, 0o777).catch(() => { /* best effort */ });
  // A playlist left by a previous egress would point players at segments that
  // are about to be pruned. Better a short 404 ("starting") than a dead list.
  await unlink(join(dir, 'live.m3u8')).catch(() => { /* none yet */ });

  const output = new SegmentedFileOutput({
    protocol: SegmentedFileProtocol.HLS_PROTOCOL,
    filenamePrefix: join(dir, `s${randomBytes(4).toString('hex')}`),
    playlistName: join(dir, 'index.m3u8'),
    livePlaylistName: join(dir, 'live.m3u8'),
    segmentDuration: SEGMENT_SEC,
  });
  const portrait = meta.portrait === true;
  const tracks = await programTracks(room, meta);
  const encodingOptions = new EncodingOptions({
    width: tracks.width || (portrait ? 720 : 1280),
    height: tracks.height || (portrait ? 1280 : 720),
    framerate: 30,
    videoBitrate: config.HLS_VIDEO_BITRATE,
  });
  let info;
  try {
    if (!tracks.videoTrackId) throw new Error('host program track not found');
    info = await egressClient.startTrackCompositeEgress(room, { segments: output }, {
      audioTrackId: tracks.audioTrackId,
      videoTrackId: tracks.videoTrackId,
      encodingOptions,
    });
  } catch (err) {
    log.warn({ err }, '[hls] track-composite failed; using standalone template');
    info = await egressClient.startRoomCompositeEgress(room, { segments: output }, {
      customBaseUrl: config.EGRESS_STANDALONE_TEMPLATE_URL,
      encodingOptions,
    });
  }
  return { egressId: info.egressId, dir };
}

/**
 * Make sure this room's HLS egress is running. Single-flight: concurrent
 * joins share one start. A failure is remembered for RETRY_AFTER_FAIL_MS so
 * viewers get WebRTC meanwhile, and is re-thrown to the caller.
 */
export function ensureHlsSession(room: string, meta: HlsRoomMeta, log: LogLike): Promise<void> {
  const existing = sessions.get(room);
  if (existing) {
    existing.lastViewerAt = Date.now();
    return Promise.resolve();
  }
  let pending = starting.get(room);
  if (!pending) {
    pending = (async () => {
      try {
        const { egressId, dir } = await startEgress(room, meta, log);
        const now = Date.now();
        sessions.set(room, { egressId, dir, startedAt: now, lastViewerAt: now, meta });
        failedAt.delete(room);
        log.info?.({ room, egressId }, '[hls] egress started');
      } catch (err) {
        failedAt.set(room, Date.now());
        throw err;
      }
    })().finally(() => starting.delete(room));
    starting.set(room, pending);
  }
  return pending;
}

/** Where this room's live playlist and segments are, while HLS runs for it. */
export function hlsSessionDir(room: string): string | null {
  return sessions.get(room)?.dir ?? null;
}

/** A player fetched the playlist: the session is in use. */
export function touchHlsSession(room: string): void {
  const s = sessions.get(room);
  if (s) s.lastViewerAt = Date.now();
}

/** Stop a room's HLS egress and drop its files. */
export async function stopHlsSession(room: string): Promise<void> {
  const s = sessions.get(room);
  if (!s) return;
  sessions.delete(room);
  await egressClient.stopEgress(s.egressId).catch(() => { /* already ended */ });
  await rm(s.dir, { recursive: true, force: true }).catch(() => { /* raced */ });
}

async function pruneSegments(dir: string, now: number) {
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.ts')) continue;
      const p = join(dir, f);
      const s = await stat(p).catch(() => null);
      if (s && now - s.mtimeMs > KEEP_SEC * 1000) await unlink(p).catch(() => { /* raced */ });
    }
  } catch { /* dir gone */ }
}

/**
 * One pass over the running sessions: stop ended or idle ones, restart a
 * stalled egress, prune old segments. Exported for tests; runs every SWEEP_MS.
 */
export async function sweepHlsSessions(log: LogLike = console): Promise<void> {
  const now = Date.now();
  for (const [room, s] of [...sessions]) {
    try {
      const rooms = await roomService.listRooms([room]);
      if (rooms.length === 0) { await stopHlsSession(room); continue; }
      const parts = await roomService.listParticipants(room);
      if (parts.some((p) => isHlsViewer(p, s.meta))) s.lastViewerAt = now;
      if (now - s.lastViewerAt > IDLE_STOP_MS) {
        log.info?.({ room }, '[hls] no HLS viewers, stopping egress');
        await stopHlsSession(room);
        continue;
      }
      const hostPublishing = parts.some((p) => p.identity === s.meta.host
        && p.tracks.some((t) => t.type === TrackType.VIDEO));
      const written = await stat(join(s.dir, 'live.m3u8')).then((st) => st.mtimeMs).catch(() => 0);
      if (hostPublishing && now - Math.max(written, s.startedAt) > STALL_MS) {
        log.warn({ room, egressId: s.egressId }, '[hls] playlist stalled, restarting egress');
        await egressClient.stopEgress(s.egressId).catch(() => { /* already ended */ });
        const next = await startEgress(room, s.meta, log);
        s.egressId = next.egressId;
        s.startedAt = Date.now();
      }
      await pruneSegments(s.dir, now);
    } catch (err) {
      log.warn({ err, room }, '[hls] sweep failed (retrying next pass)');
    }
  }
  for (const [room, at] of failedAt) if (now - at >= RETRY_AFTER_FAIL_MS) failedAt.delete(room);
}

const sweeper = setInterval(() => { void sweepHlsSessions(); }, SWEEP_MS);
sweeper.unref?.();

/** Test hook: an egress start is still in flight. */
export function _hlsStartsPending(): number {
  return starting.size;
}

/** Test hook: forget all state. */
export function _resetHlsForTests(): void {
  sessions.clear();
  starting.clear();
  failedAt.clear();
}
