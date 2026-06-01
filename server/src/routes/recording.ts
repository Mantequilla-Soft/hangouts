import type { FastifyPluginAsync } from 'fastify';
import { EgressClient, EncodedFileOutput, EncodedFileType, EncodingOptionsPreset, EncodingOptions } from 'livekit-server-sdk';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { canRecordVideo, canRecordAudio } from '../lib/permissions.js';
import { readFile, unlink, stat } from 'node:fs/promises';
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
const EGRESS_TEMPLATE_URL = 'https://hangout.3speak.tv/egress-template';

async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };
  let meta: { host?: string } = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null };
}

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
          mode:   { type: 'string', enum: ['audio', 'video'] },
          layout: { type: 'string', enum: ['speaker', 'grid', 'single'] },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { mode = 'audio', layout = 'speaker' } = (request.body ?? {}) as {
      mode?: RecordingMode;
      layout?: RecordingLayout;
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
    if (mode === 'video') {
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

    // Register the file as pending host download. The token is the recording's
    // egressId — short, unguessable, scoped to this recording. Issued for
    // both audio and video so the integrator can pick its own publish
    // flow (3Speak Studio for video, audio uploader for audio).
    let downloadToken: string | undefined;
    if (filePath) {
      downloadToken = info.egressId;
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
    }

    return reply.send({
      egressId: info.egressId,
      status: 'stopped',
      mode: rec.mode,
      layout: rec.layout,
      filePath,
      duration,
      // Set for video recordings — host fetches the file via GET /record/file/:token
      downloadToken,
    });
  });

  // Stream the recorded MP4 to the host so the frontend can re-upload it
  // through the user's normal /studio flow (using their own auth instead of
  // a shared service token). One-time-ish: token is the egressId, valid for
  // 1h after /record/stop, deleted on successful streaming.
  fastify.get('/rooms/:name/record/file/:token', {
    preHandler: [requireAuth, checkBan],
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
    if (pending.username !== request.username) return reply.forbidden('Only the recording host can download this file');
    if (pending.expiresAt < Date.now()) {
      pendingDownloads.delete(token);
      return reply.notFound('Recording download token expired');
    }

    let st;
    try { st = await stat(pending.filePath); }
    catch { return reply.notFound('Recording file no longer exists on disk'); }

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
    // Delete the file + token after the host finishes streaming. If the
    // download fails midway, the cleanup interval will eventually remove
    // both based on the TTL.
    stream.on('end', () => {
      pendingDownloads.delete(token);
      void unlink(pending.filePath).catch(() => { /* ignore */ });
    });
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
    const { filePath, duration, title, tags } = request.body as {
      filePath: string;
      duration?: number;
      title?: string;
      tags?: string[];
    };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can upload recordings');

    if (!config.AUDIO_API_KEY) {
      return reply.serviceUnavailable('Audio upload not configured (AUDIO_API_KEY missing)');
    }

    if (!filePath.startsWith('/tmp/livekit-recordings/')) {
      return reply.badRequest('Invalid file path');
    }

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
