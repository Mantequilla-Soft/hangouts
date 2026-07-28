import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import * as tus from 'tus-js-client';
import { config } from '../config.js';

/**
 * Publish a finished standalone-stream recording as its video-on-demand,
 * ENTIRELY on the server.
 *
 * This replaces the old round-trip where the studio downloaded the egress MP4
 * back into the browser and re-uploaded it through the user's connection. That
 * couldn't survive a long session — a multi-GB file will OOM a phone tab — and
 * it couldn't run at all if the streamer's own connection died. The server
 * already holds the file on disk, so it uploads straight from there.
 *
 * The permlink trick is the same as the old client path: the upload carries
 * `permlink: roomName` in its TUS metadata, so the embed row is created at
 * exactly `{ owner: host, permlink: roomName }` — the same identity as the live
 * stream and the announcement post. The watch page already tries the VIDEO
 * lookup before the stream lookup, so every `?v=host/roomName` link flips from
 * "live" to the VOD on its own once encoding finishes.
 *
 * Progress is tracked in a module-level map keyed by roomName, which the client
 * polls to show toasts — it can't watch the upload directly anymore.
 */

export type PublishStatus = 'uploading' | 'processing' | 'published' | 'failed';

export interface PublishState {
  status: PublishStatus;
  /** 0–100 upload progress; 100 once the file is fully sent. */
  progress: number;
  error?: string;
  updatedAt: number;
}

const states = new Map<string, PublishState>();

export function getPublishState(roomName: string): PublishState | null {
  return states.get(roomName) ?? null;
}

/** Drop settled (published/failed) publish states older than maxAgeMs. The map
 *  otherwise only ever grows — one entry per room ever recorded — which leaks
 *  memory and keeps `hasPublish()` true forever for a recycled room name. */
export function sweepPublishStates(maxAgeMs = 60 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [name, s] of states) {
    if ((s.status === 'published' || s.status === 'failed') && s.updatedAt < cutoff) states.delete(name);
  }
}

function setState(roomName: string, patch: Partial<PublishState>) {
  const prev = states.get(roomName);
  states.set(roomName, {
    status: patch.status ?? prev?.status ?? 'uploading',
    progress: patch.progress ?? prev?.progress ?? 0,
    error: patch.error ?? prev?.error,
    updatedAt: Date.now(),
  });
}

export interface PublishRecordingInput {
  filePath: string;
  /** The stream's room name — doubles as the VOD permlink. */
  roomName: string;
  owner: string;
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailUrl?: string;
  duration: number;
}

/** True once a publish for this room has already been started (any state). */
export function hasPublish(roomName: string): boolean {
  return states.has(roomName);
}

/**
 * Fire-and-forget: uploads the recording, associates it with the Hive post,
 * then deletes the local file. Never throws — failures land in the state map
 * for the client to surface. Safe to call from the normal stop path OR from a
 * crash-recovery path; the first caller wins (guarded by hasPublish upstream).
 */
export async function publishRecordingToVod(input: PublishRecordingInput): Promise<void> {
  const { filePath, roomName, owner, title, description, tags, thumbnailUrl, duration } = input;
  setState(roomName, { status: 'uploading', progress: 0 });

  try {
    if (!config.EMBED_API_KEY) throw new Error('No embed API key configured');

    // Wait for egress to finish writing the file before uploading it.
    //
    // stopEgress ACKs the moment the pipeline is asked to stop, but egress is
    // still muxing (the moov atom, a final flush) for a beat after that — so a
    // straight stat() loses the race and 404s on a recording that lands ~200ms
    // later. Wait for the file to appear AND for its size to settle. (Same
    // reason the /record/file download endpoint waits.)
    let size = 0;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { size = (await stat(filePath)).size; break; }
      catch {
        if (Date.now() >= deadline) throw new Error('Recording file never appeared on disk');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      let next = size;
      try { next = (await stat(filePath)).size; } catch { break; }
      if (next === size || Date.now() >= deadline) { size = next; break; }
      size = next;
    }

    await new Promise<void>((resolve, reject) => {
      const source = createReadStream(filePath);
      const upload = new tus.Upload(source, {
        endpoint: config.EMBED_UPLOAD_URL,
        // Streams MUST declare a chunk size and total size — tus can't seek a
        // pipe. Streaming (not a Buffer) is the point: a 4-hour recording is
        // gigabytes, and buffering that in RAM would defeat the exercise.
        chunkSize: 8 * 1024 * 1024,
        uploadSize: size,
        retryDelays: [0, 3_000, 5_000, 10_000, 20_000, 30_000],
        storeFingerprintForResuming: false,
        removeFingerprintOnSuccess: true,
        headers: { 'X-API-Key': config.EMBED_API_KEY },
        metadata: {
          filename: `${roomName}.mp4`,
          filetype: 'video/mp4',
          frontend_app: '3speak-hangouts',
          owner,
          short: 'false',
          duration: String(Math.round(duration || 0)),
          // The stream id IS the asset permlink — see the note above.
          permlink: roomName,
        },
        onError: reject,
        onProgress: (uploaded, total) => {
          setState(roomName, { status: 'uploading', progress: total ? Math.round((uploaded / total) * 100) : 0 });
        },
        onSuccess: () => resolve(),
      });
      upload.start();
    });

    // Uploaded — now the encoder processes it. Associate it with the Hive post
    // so the title/body/tags are right and it shows on the author's profile.
    setState(roomName, { status: 'processing', progress: 100 });
    const apiBase = config.EMBED_API_URL.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': config.EMBED_API_KEY };

    await fetch(`${apiBase}/video/${encodeURIComponent(roomName)}/hive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        hive_author: owner,
        hive_permlink: roomName,
        hive_title: title || `Live stream — ${roomName}`,
        hive_body: description || '',
        hive_tags: Array.isArray(tags) ? tags : [],
      }),
    }).catch(() => { /* non-fatal: the video still publishes, just less well-titled */ });

    if (thumbnailUrl) {
      await fetch(`${apiBase}/video/${encodeURIComponent(roomName)}/thumbnail`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ thumbnail_url: thumbnailUrl }),
      }).catch(() => { /* non-fatal */ });
    }

    setState(roomName, { status: 'published', progress: 100 });
    // The embed service has its own copy now — drop ours.
    await unlink(filePath).catch(() => { /* already gone */ });
  } catch (err) {
    setState(roomName, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    // Deliberately keep the file on a failure, so a retry (or manual rescue) is
    // still possible.
  }
}
