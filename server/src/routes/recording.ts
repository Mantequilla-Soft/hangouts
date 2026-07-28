import type { FastifyPluginAsync } from 'fastify';
import { EgressClient, EncodedFileOutput, EncodedFileType, EncodingOptionsPreset, EncodingOptions } from 'livekit-server-sdk';
import { TrackType, TrackSource } from '@livekit/protocol';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { canRecordVideo, canRecordAudio } from '../lib/permissions.js';
import { publishRecordingToVod, getPublishState, hasPublish } from '../lib/streamVodPublish.js';
import { readFile, unlink, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createReadStream } from 'node:fs';

const egressClient = new EgressClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

type RecordingMode = 'audio' | 'video';
type RecordingLayout = 'speaker' | 'grid' | 'single';

interface ActiveRecording {
  egressId: string;
  mode: RecordingMode;
  layout: RecordingLayout;
  filepath: string;
}

// Track active recordings: roomName → recording state
const activeRecordings = new Map<string, ActiveRecording>();

/**
 * Publish metadata for an in-progress standalone VOD, captured at record START.
 *
 * Captured up front — not read from the room at stop time — so the crash
 * watchdog can still publish after the room has been torn down. Keyed by room.
 */
interface PendingVod {
  egressId: string;
  owner: string;
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailUrl?: string;
  filepath: string;
  /** Publish the recording as the announcement post's VOD. */
  publish: boolean;
  /** Offer the recording to the host as a file download. */
  download: boolean;
}
const pendingVods = new Map<string, PendingVod>();

/** When did we last see the host connected? Drives the crash watchdog. */
const hostLastSeen = new Map<string, number>();

/**
 * Stop egress (if still running) and publish the recording as the VOD. Shared
 * by the clean /record/stop path and the crash watchdog, so a stream that ends
 * abnormally still produces a video. Idempotent — hasPublish() guards a double.
 */
async function finishAndPublishVod(
  roomName: string,
  opts?: { stopEgress?: boolean; filePath?: string; duration?: number },
): Promise<void> {
  const pending = pendingVods.get(roomName);
  if (!pending || hasPublish(roomName)) return;
  pendingVods.delete(roomName);

  let filePath = opts?.filePath || pending.filepath;
  let duration = opts?.duration ?? 0;
  if (opts?.stopEgress !== false) {
    // Crash path: egress is still running — stop it and take the finalised file.
    try {
      const info = await egressClient.stopEgress(pending.egressId);
      filePath = info.fileResults?.[0]?.filename || filePath;
      duration = Number(info.fileResults?.[0]?.duration || 0) / 1e9;
    } catch { /* already stopped — use the path we have */ }
  }
  activeRecordings.delete(roomName);
  hostLastSeen.delete(roomName);

  if (!pending.publish) return;
  await publishRecordingToVod({
    filePath,
    roomName,
    owner: pending.owner,
    title: pending.title,
    description: pending.description,
    tags: pending.tags,
    thumbnailUrl: pending.thumbnailUrl,
    duration,
  });
  // Reclaim disk now for a publish-ONLY recording: the embed service has its
  // own copy and nothing else needs this file. When a download was ALSO
  // requested we leave it — the download endpoint + the 1h pendingDownloads
  // sweeper own its lifetime — and the /opt/livekit egress-janitor (2-day
  // retention, plus a low-disk emergency stop) is the backstop for everything.
  if (!pending.download) {
    await unlink(filePath).catch(() => { /* already gone */ });
  }
}

// Track recordings that have been stopped but the file hasn't yet been
// downloaded (or expired). The host can fetch the MP4 via GET /record/file
// and upload it through the studio flow themselves. Cleared on download or
// after PENDING_TTL_MS.
interface PendingDownload {
  username: string;     // host who can fetch this file
  filePath: string;     // path on disk
  filename: string;     // suggested filename for the download
  duration: number;     // seconds
  mode: RecordingMode;
  expiresAt: number;
}
const pendingDownloads = new Map<string, PendingDownload>();
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
  const now = Date.now();
  for (const [token, p] of pendingDownloads) {
    if (p.expiresAt < now) {
      pendingDownloads.delete(token);
      // best-effort cleanup of the orphaned file
      void unlink(p.filePath).catch(() => { /* ignore */ });
    }
  }
}, 5 * 60 * 1000);

// Custom egress template URL — same vhost as the API, served from
// hangouts/demo/dist via nginx. The template renders the SAME visual layout
// as the in-room hangouts UI (WYSIWYG) and falls back to the room background
// image when no video is being published.
const EGRESS_TEMPLATE_URL = config.EGRESS_TEMPLATE_URL;

async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };
  let meta: { host?: string; mode?: string; portrait?: boolean } = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null, meta };
}

/**
 * Crash recovery for standalone VODs.
 *
 * If a streamer's connection dies, they never call /record/stop — so egress
 * keeps rolling and the recording is never published. This sweep notices when
 * the host has been gone from a recording room for longer than the grace
 * window, stops egress, and publishes what was captured. The host opted into
 * "replace the stream with a video", so the promise holds even when their side
 * fails.
 *
 * Grace matches the studio's mobile background-pause window (BACKGROUND_GRACE_MS
 * in StandaloneStudio — 5 min), and MUST NOT be shorter than it: a phone
 * streamer who locks their screen is told they have 5 minutes to come back, so
 * the server can't publish the VOD and tear down the room before that window
 * closes, or they'd unlock to find their stream already gone. LiveKit also
 * rides out brief blips on its own (ICE restarts keep the participant
 * "present"), so an absence this long is a real crash, not a hiccup — and a
 * false positive only costs a couple of trailing minutes of "offline" screen.
 */
const HOST_ABSENT_GRACE_MS = 5 * 60 * 1000;
setInterval(() => {
  void (async () => {
    for (const [roomName, pending] of pendingVods) {
      try {
        const parts = await roomService.listParticipants(roomName).catch(() => null);
        // Room gone entirely (closed) → the host is certainly not coming back.
        const hostPresent = parts != null && parts.some((pt) => pt.identity === pending.owner);
        if (hostPresent) { hostLastSeen.set(roomName, Date.now()); continue; }
        const since = hostLastSeen.get(roomName) ?? Date.now();
        if (Date.now() - since >= HOST_ABSENT_GRACE_MS) {
          await finishAndPublishVod(roomName, { stopEgress: true });
          // Best-effort: tidy up the abandoned room so it leaves the lobby.
          await roomService.deleteRoom(roomName).catch(() => { /* already gone */ });
        }
      } catch { /* try again next sweep */ }
    }
  })();
}, 30 * 1000);

export const recordingRoutes: FastifyPluginAsync = async (fastify) => {
  // Start recording (host only)
  fastify.post('/rooms/:name/record/start', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      // Body is optional — older SDK callers POST with no body (audio mode +
      // default layout). nullable so Fastify doesn't 400 on an empty request.
      body: {
        type: ['object', 'null'],
        properties: {
          mode:     { type: 'string', enum: ['audio', 'video'] },
          layout:   { type: 'string', enum: ['speaker', 'grid', 'single'] },
          publish:  { type: 'boolean' },
          download: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { mode = 'audio', layout = 'speaker', publish = true, download = false } = (request.body ?? {}) as {
      mode?: RecordingMode;
      layout?: RecordingLayout;
      publish?: boolean;
      download?: boolean;
    };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can start recording');

    if (activeRecordings.has(name)) {
      return reply.conflict('Room is already being recorded');
    }

    // Premium gate for both recording modes. Audio + video both consume
    // egress runtime + downstream storage, so both are reserved for Pro
    // subscribers. The gate is mode-specific so each can be relaxed
    // independently later (e.g. a cheaper audio-only tier).
    if (mode === 'video') {
      const perm = await canRecordVideo(request.username);
      if (!perm.ok) {
        return reply.forbidden(perm.reason ?? 'Video recording is not permitted for this account');
      }
    } else {
      const perm = await canRecordAudio(request.username);
      if (!perm.ok) {
        return reply.forbidden(perm.reason ?? 'Audio recording is not permitted for this account');
      }
    }

    const ext = mode === 'video' ? 'mp4' : 'mp3';
    const filepath = `/tmp/livekit-recordings/${name}-${Date.now()}.${ext}`;

    let info;
    // A standalone stream records through its OWN template: a chrome-free
    // full-bleed render of the broadcaster's program track, sized to the
    // stream's real orientation. The conference path below is untouched.
    if (mode === 'video' && check.meta?.mode === 'standalone') {
      const portrait = check.meta.portrait === true;
      const output = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath });

      // TRACK-COMPOSITE over RoomComposite for a standalone stream.
      //
      // A standalone program is a SINGLE already-composited track — there's
      // nothing to lay out server-side. RoomComposite renders it in a headless
      // Chrome and screenshots that at a fixed 30fps, which RESAMPLES a jittery
      // mobile stream and shows up as skipped frames in the recording. Muxing
      // the published track directly keeps its real frame timing (and needs no
      // Chrome, so it's far lighter). No output width/height, so the muxed
      // track keeps its own orientation — portrait vs landscape is automatic.
      let videoTrackId = '';
      let audioTrackId = '';
      let vw = 0;
      let vh = 0;
      try {
        const parts = await roomService.listParticipants(name);
        const host = parts.find((pt) => pt.identity === check.meta!.host);
        const videoInfo = host?.tracks.find((t) => t.type === TrackType.VIDEO && t.source === TrackSource.CAMERA);
        videoTrackId = videoInfo?.sid ?? '';
        vw = videoInfo?.width ?? 0;
        vh = videoInfo?.height ?? 0;
        // The host may publish TWO Microphone tracks: 'studio-mix' (the full
        // program) and 'host-monitor' (the mix-minus track for a collab guest,
        // which is MISSING the guest's audio). Always record the full mix — pick
        // it by name, and only fall back to "first mic" when it isn't named.
        const mics = host?.tracks.filter((t) => t.type === TrackType.AUDIO && t.source === TrackSource.MICROPHONE) ?? [];
        audioTrackId = (mics.find((t) => t.name === 'studio-mix') ?? mics[0])?.sid ?? '';
      } catch { /* fall back below */ }

      try {
        if (!videoTrackId) throw new Error('host video track not found');
        // OUTPUT DIMENSIONS ARE MANDATORY. TrackComposite transcodes (VP8 → H.264
        // for the MP4), and egress defaults a missing width/height to 16:9 — so
        // a portrait stream comes out landscape. Use the published track's own
        // dimensions (correct aspect + resolution); fall back to the orientation
        // flag if the track didn't report them yet.
        info = await egressClient.startTrackCompositeEgress(name, { file: output }, {
          audioTrackId,
          videoTrackId,
          encodingOptions: new EncodingOptions({
            width: vw || (portrait ? 720 : 1280),
            height: vh || (portrait ? 1280 : 720),
            framerate: 30,
            videoBitrate: 3000,
          }),
        });
      } catch (err) {
        // Any problem (track not found, unsupported) → the known-good template
        // composite, so a stream is never left un-recorded. Its explicit dims
        // avoid letterboxing a portrait stream into a 16:9 box.
        request.log.warn({ err }, 'track-composite egress failed; using room-composite');
        info = await egressClient.startRoomCompositeEgress(name, { file: output }, {
          customBaseUrl: config.EGRESS_STANDALONE_TEMPLATE_URL,
          encodingOptions: new EncodingOptions({
            width: portrait ? 720 : 1280,
            height: portrait ? 1280 : 720,
            framerate: 30,
            videoBitrate: 3000,
          }),
        });
      }
    } else if (mode === 'video') {
      // Stamp recordBg + recordLayout on the room metadata BEFORE starting
      // egress. The custom template reads this — recordBg is shown when no
      // video is published; recordLayout drives layout changes mid-recording.
      const rooms = await roomService.listRooms([name]);
      const currentMeta: Record<string, unknown> = {};
      try { Object.assign(currentMeta, JSON.parse(rooms[0]?.metadata || '{}')); } catch { /* ignore */ }
      const recordBg = (currentMeta.backgroundImage as string | undefined) ?? undefined;
      await roomService.updateRoomMetadata(name, JSON.stringify({
        ...currentMeta,
        recordBg,
        recordLayout: layout,
      }));

      const output = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath });
      info = await egressClient.startRoomCompositeEgress(name, { file: output }, {
        customBaseUrl: EGRESS_TEMPLATE_URL,
        encodingOptions: EncodingOptionsPreset.H264_720P_30,
      });
    } else {
      // Audio-only egress: 64 kbps is plenty for talk content and roughly
      // halves storage vs the LiveKit default — picked up from upstream
      // commit 3f624e8 ("reduce recording bitrate to 64kbps for talk content").
      const output = new EncodedFileOutput({ fileType: EncodedFileType.MP3, filepath });
      info = await egressClient.startRoomCompositeEgress(name, { file: output }, {
        audioOnly: true,
        encodingOptions: new EncodingOptions({ audioBitrate: 64 }),
      });
    }

    activeRecordings.set(name, { egressId: info.egressId, mode, layout, filepath });
    // For a standalone VOD, remember what it takes to publish it — so the crash
    // watchdog can finish the job even if the host never calls /record/stop.
    if (mode === 'video' && check.meta?.mode === 'standalone') {
      const post = (check.meta as { post?: Record<string, unknown> }).post ?? {};
      pendingVods.set(name, {
        egressId: info.egressId,
        owner: (check.meta.host as string) || request.username,
        title: post.title as string | undefined,
        description: post.description as string | undefined,
        tags: Array.isArray(post.tags) ? post.tags as string[] : undefined,
        thumbnailUrl: (post.thumbnail as string) || (check.meta as { backgroundImage?: string }).backgroundImage || undefined,
        filepath,
        publish,
        download,
      });
      hostLastSeen.set(name, Date.now());
    }

    return reply.send({
      egressId: info.egressId,
      status: 'recording',
      mode,
      layout,
      filepath,
    });
  });

  // Switch the active video recording layout (host only). Audio recordings ignore.
  fastify.patch('/rooms/:name/record/layout', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['layout'],
        properties: {
          layout: { type: 'string', enum: ['speaker', 'grid', 'single'] },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { layout } = request.body as { layout: RecordingLayout };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can change the recording layout');

    const rec = activeRecordings.get(name);
    if (!rec) return reply.badRequest('Room is not being recorded');
    if (rec.mode !== 'video') return reply.badRequest('Layout switching is only available for video recordings');

    // Update room metadata — the custom egress template's useRoomInfo() picks
    // up the change and re-renders with the new layout. The headless Chrome
    // running the template captures the visual switch live, so the recording
    // shows segment 1 (old layout) then segment 2 (new layout) seamlessly.
    const rooms = await roomService.listRooms([name]);
    const currentMeta: Record<string, unknown> = {};
    try { Object.assign(currentMeta, JSON.parse(rooms[0]?.metadata || '{}')); } catch { /* ignore */ }
    await roomService.updateRoomMetadata(name, JSON.stringify({
      ...currentMeta,
      recordLayout: layout,
    }));
    rec.layout = layout;
    return reply.send({ egressId: rec.egressId, layout });
  });

  // Stop recording (host only)
  fastify.post('/rooms/:name/record/stop', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can stop recording');

    const rec = activeRecordings.get(name);
    if (!rec) {
      return reply.badRequest('Room is not being recorded');
    }

    const info = await egressClient.stopEgress(rec.egressId);
    activeRecordings.delete(name);

    const filePath = info.fileResults?.[0]?.filename || rec.filepath;
    const duration = Number(info.fileResults?.[0]?.duration || 0) / 1e9;

    const pending = pendingVods.get(name);

    // PUBLISH: upload the recording as the announcement post's VOD, server-side.
    // The egress is already stopped, so the finisher just publishes (it re-reads
    // duration otherwise; we already have it).
    let publishStatusUrl: string | undefined;
    if (rec.mode === 'video' && pending?.publish && filePath && !hasPublish(name)) {
      void finishAndPublishVod(name, { stopEgress: false, filePath, duration }).catch(() => { /* state map carries the error */ });
      publishStatusUrl = `/rooms/${encodeURIComponent(name)}/record/publish-status`;
    }

    // DOWNLOAD: make the SERVER's recording available as a file the host's
    // browser streams straight to disk — no client-side second encode. The
    // token IS the capability (the unguessable egressId), so the download link
    // needs no auth header and works as a plain anchor.
    let downloadUrl: string | undefined;
    const wantDownload = pending ? pending.download : rec.mode === 'audio' || !pending;
    if (filePath && wantDownload) {
      const downloadToken = info.egressId;
      const fallbackExt = rec.mode === 'video' ? 'mp4' : 'ogg';
      const filename = filePath.split('/').pop() ?? `${name}-${Date.now()}.${fallbackExt}`;
      pendingDownloads.set(downloadToken, {
        username: request.username,
        filePath,
        filename,
        duration,
        mode: rec.mode,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
      downloadUrl = `/rooms/${encodeURIComponent(name)}/record/file/${downloadToken}`;
    }

    return reply.send({
      egressId: info.egressId,
      status: publishStatusUrl ? 'publishing' : 'stopped',
      mode: rec.mode,
      layout: rec.layout,
      duration,
      publishStatusUrl,
      downloadUrl,
    });
  });

  // Progress of the server-side VOD publish (public — no secret in it). The
  // client polls this AFTER the studio has closed, so it deliberately does NOT
  // require the room to still exist or the caller to be the host.
  fastify.get('/rooms/:name/record/publish-status', {
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const state = getPublishState(name);
    if (!state) return reply.notFound('No publish in progress for this room');
    // Public endpoint (any viewer polls it) — expose only status/progress, not
    // the raw internal `error` string (which can carry file paths / internals).
    return reply.send({
      status: state.status,
      progress: state.progress,
      updatedAt: state.updatedAt,
      failed: state.status === 'failed',
    });
  });

  // Stream the recorded MP4 to the host so the frontend can re-upload it
  // through the user's normal /studio flow (using their own auth instead of
  // a shared service token). One-time-ish: token is the egressId, valid for
  // 1h after /record/stop, deleted on successful streaming.
  // The token IS the capability: it's the unguessable egressId, scoped to one
  // recording and TTL'd. So NO requireAuth — a plain <a download> link (which
  // can't send a Bearer header) streams the server's file straight to the
  // host's disk, no second client-side encode.
  fastify.get('/rooms/:name/record/file/:token', {
    schema: {
      params: {
        type: 'object',
        required: ['name', 'token'],
        properties: {
          name:  { type: 'string' },
          token: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { name: string; token: string };
    const pending = pendingDownloads.get(token);
    if (!pending) return reply.notFound('Recording file not available — token expired or already downloaded');
    if (pending.expiresAt < Date.now()) {
      pendingDownloads.delete(token);
      return reply.notFound('Recording download token expired');
    }

    let st;
    // Wait for the file to appear before giving up.
    //
    // /record/stop returns as soon as egress ACKs, but egress is still
    // finalising the MP4 — muxing the moov atom and flushing — for a moment
    // after that. The studio fetches immediately, so a straight stat() lost the
    // race by about 100ms and 404'd on a recording that was very much on its
    // way to disk. The host then saw "stream has already ended" with no VOD,
    // while a perfectly good file sat in /tmp.
    const FILE_WAIT_MS = 30_000;
    const deadline = Date.now() + FILE_WAIT_MS;
    for (;;) {
      try { st = await stat(pending.filePath); break; }
      catch {
        if (Date.now() >= deadline) {
          return reply.notFound('Recording file no longer exists on disk');
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // A file that exists but is still growing is not finished either — wait for
    // its size to settle before streaming it out.
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      let again;
      try { again = await stat(pending.filePath); } catch { break; }
      if (again.size === st.size) break;
      st = again;
      if (Date.now() >= deadline) break;
    }

    // Pick a Content-Type that matches the actual file. LiveKit egress
    // outputs MP4 for video and OGG (Opus) for audio by default; allow
    // M4A/WAV in case the egress preset changes later. Anything else
    // falls back to a generic octet stream so the browser still saves
    // it correctly via Content-Disposition.
    const ext = (pending.filename.split('.').pop() ?? '').toLowerCase();
    const contentType =
      ext === 'mp4'  ? 'video/mp4' :
      ext === 'webm' ? 'video/webm' :
      ext === 'ogg'  ? 'audio/ogg' :
      ext === 'oga'  ? 'audio/ogg' :
      ext === 'm4a'  ? 'audio/mp4' :
      ext === 'mp3'  ? 'audio/mpeg' :
      ext === 'wav'  ? 'audio/wav' :
      'application/octet-stream';

    reply
      .header('Content-Type', contentType)
      .header('Content-Length', st.size.toString())
      .header('Content-Disposition', `attachment; filename="${pending.filename}"`)
      .header('X-Recording-Duration', pending.duration.toString())
      .header('X-Recording-Filename', pending.filename);

    const stream = createReadStream(pending.filePath);
    // Drop only the TOKEN once served — NOT the file. A stream that also chose
    // "replace with a video" is uploading the SAME file as its VOD, so deleting
    // it here would race that upload. The TTL sweeper and egress janitor reclaim
    // the disk.
    stream.on('end', () => { pendingDownloads.delete(token); });
    return reply.send(stream);
  });

  // Get recording status (host only)
  fastify.get('/rooms/:name/record/status', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const rec = activeRecordings.get(name);
    if (!rec) {
      return reply.send({ recording: false });
    }

    return reply.send({ recording: true, egressId: rec.egressId, mode: rec.mode, layout: rec.layout });
  });

  // Upload audio recording to audio.3speak.tv (host only)
  fastify.post('/rooms/:name/record/upload', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['filePath'],
        properties: {
          filePath: { type: 'string' },
          duration: { type: 'number' },
          title: { type: 'string', maxLength: 128 },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { duration, title, tags } = request.body as {
      filePath: string;
      duration?: number;
      title?: string;
      tags?: string[];
    };
    let filePath = (request.body as { filePath: string }).filePath;

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can upload recordings');

    if (!config.AUDIO_API_KEY) {
      return reply.serviceUnavailable('Audio upload not configured (AUDIO_API_KEY missing)');
    }

    // Contain the path to the recordings dir AFTER resolving it. A plain
    // startsWith() is bypassable — "/tmp/livekit-recordings/../../etc/passwd"
    // passes the prefix but readFile follows the "..", which would let a host
    // exfiltrate any server file (e.g. .env → SESSION_SECRET / LIVEKIT secret).
    const RECORDINGS_DIR = '/tmp/livekit-recordings';
    const resolvedPath = resolve(filePath);
    if (resolvedPath !== RECORDINGS_DIR && !resolvedPath.startsWith(RECORDINGS_DIR + sep)) {
      return reply.badRequest('Invalid file path');
    }
    filePath = resolvedPath;

    let fileBuffer: Buffer;
    try {
      fileBuffer = await readFile(filePath);
    } catch {
      return reply.notFound('Recording file not found — it may have been cleaned up');
    }

    const rooms = await roomService.listRooms([name]);
    let roomTitle = name;
    let roomThumbnail: string | undefined;
    try {
      const meta = JSON.parse(rooms[0]?.metadata || '{}');
      roomTitle = meta.title || name;
      roomThumbnail = meta.backgroundImage || undefined;
    } catch { /* ignore */ }

    // Use provided duration or estimate from file size (MP3 at 64kbps ≈ 8KB/sec).
    // Matches the bitrate set on the audio egress above.
    const estimatedDuration = duration || Math.round(fileBuffer.length / 8000);

    const formData = new FormData();
    formData.append('audio', new Blob([new Uint8Array(fileBuffer)], { type: 'audio/mpeg' }), `${name}.mp3`);
    formData.append('duration', estimatedDuration.toString());
    formData.append('format', 'mp3');
    formData.append('title', title || roomTitle);
    formData.append('category', 'podcast');
    formData.append('tags', JSON.stringify(tags || ['hangout', 'podcast', 'hive']));
    if (roomThumbnail) formData.append('thumbnail_url', roomThumbnail);

    const audioApiUrl = config.AUDIO_API_URL.replace(/\/$/, '');
    const audioResponse = await fetch(`${audioApiUrl}/api/audio/upload`, {
      method: 'POST',
      headers: {
        'X-API-Key': config.AUDIO_API_KEY,
        'X-User': request.username,
      },
      body: formData,
    });

    if (!audioResponse.ok) {
      const err = await audioResponse.text();
      request.log.error({ audioApiUrl, status: audioResponse.status, err }, 'Audio upload failed');
      return reply.internalServerError(`Audio upload failed: ${err}`);
    }

    const audioResult = await audioResponse.json() as {
      success: boolean;
      permlink: string;
      cid: string;
      playUrl: string;
    };

    try { await unlink(filePath); } catch { /* ignore */ }

    return reply.send({
      success: true,
      permlink: audioResult.permlink,
      cid: audioResult.cid,
      playUrl: audioResult.playUrl,
    });
  });

  // Update audio recording metadata after publishing (host/owner only)
  fastify.patch('/rooms/:name/record/:audioPerm/metadata', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name', 'audioPerm'],
        properties: {
          name: { type: 'string' },
          audioPerm: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          title:        { type: 'string', maxLength: 256 },
          description:  { type: 'string', maxLength: 10000 },
          tags:         { type: 'array', items: { type: 'string' } },
          post_permlink: { type: 'string', maxLength: 256 },
        },
      },
    },
  }, async (request, reply) => {
    const { audioPerm } = request.params as { name: string; audioPerm: string };
    const body = request.body as {
      title?: string;
      description?: string;
      tags?: string[];
      post_permlink?: string;
    };

    if (!config.AUDIO_API_KEY) {
      return reply.serviceUnavailable('Audio API not configured (AUDIO_API_KEY missing)');
    }

    const audioApiUrl = config.AUDIO_API_URL.replace(/\/$/, '');
    const audioResponse = await fetch(`${audioApiUrl}/api/audio/${encodeURIComponent(audioPerm)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.AUDIO_API_KEY,
        'X-User': request.username,
      },
      body: JSON.stringify(body),
    });

    if (!audioResponse.ok) {
      const err = await audioResponse.text();
      request.log.error({ audioPerm, status: audioResponse.status, err }, 'Audio metadata update failed');
      return reply.internalServerError(`Audio metadata update failed: ${err}`);
    }

    const result = await audioResponse.json();
    return reply.send(result);
  });
};
