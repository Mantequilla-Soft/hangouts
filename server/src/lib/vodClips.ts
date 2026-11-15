import { spawn } from 'node:child_process';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { clipStore, type StreamClip } from './streamClips.js';

/**
 * Clips of streams WITHOUT the Pro DVR (H13), cut from the VOD recording every
 * stream makes (routes/recording.ts startStandaloneVod; free streams are capped
 * at 30 minutes).
 *
 * The recording is one MP4 that is only readable once the egress has finalised
 * it, so a clip taken during the stream is stored as `pending` with the second
 * its window starts at in the recording. When the recording ends, and BEFORE
 * the VOD upload deletes the file, cutPendingClips cuts each one with an ffmpeg
 * stream copy (no re-encode: disk I/O only, niced, one at a time) into the clip
 * dir and marks it ready. The whole step is time-boxed; whatever it could not
 * cut is marked unavailable, and the upload goes on either way.
 */
export const CLIP_DIR = '/tmp/livekit-dvr-clips';
/** The window of a clip: the last 30 s plus a little slack at both ends (the
 *  recording starts a moment after the egress was asked for). */
export const VOD_CLIP_SEC = 36;
const TIME_BOX_MS = 90_000;
const PER_CLIP_MS = 20_000;
const FILE_WAIT_MS = 30_000;

interface RecordingInfo { startedAt: number; maxMs: number | null }
const recordings = new Map<string, RecordingInfo>();

/** A VOD recording of `room` started now (free ones stop at `maxMs`). */
export function noteVodRecording(room: string, info: { startedAt?: number; maxMs?: number | null }): void {
  recordings.set(room, { startedAt: info.startedAt ?? Date.now(), maxMs: info.maxMs && info.maxMs > 0 ? info.maxMs : null });
}
export function vodRecordingOf(room: string): RecordingInfo | null { return recordings.get(room) ?? null; }
export function forgetVodRecording(room: string): void { recordings.delete(room); }

/**
 * Where a clip ending at wall time `endAt` sits in the recording, or why it
 * cannot be cut: `{ start }` (seconds into the recording) or `{ unavailable }`.
 */
export function vodWindow(rec: RecordingInfo, endAt: number): { start: number } | { unavailable: 'past_cap' } {
  const endSec = (endAt - rec.startedAt) / 1000;
  if (rec.maxMs != null && endSec - VOD_CLIP_SEC >= rec.maxMs / 1000) return { unavailable: 'past_cap' };
  return { start: Math.max(0, endSec - VOD_CLIP_SEC + 2) };
}

/** Pure: the ffmpeg arguments of one cut (stream copy, starts on a keyframe). */
export function cutArgs(input: string, output: string, startSec: number, durationSec: number): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, startSec)), '-i', input,
    '-t', String(durationSec), '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', output];
}

function runCut(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('nice', ['-n', '15', 'ffmpeg', ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('cut timed out')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg exited ${code}`)); });
  });
}

/** The finalised file's size once it stops growing, or null. */
async function settledSize(path: string, deadline: number): Promise<number | null> {
  let last = -1;
  for (;;) {
    const s = await stat(path).catch(() => null);
    if (s && s.size > 0 && s.size === last) return s.size;
    if (s) last = s.size;
    if (Date.now() >= deadline) return s && s.size > 0 ? s.size : null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

export interface CutSummary { ready: number; unavailable: number }

/**
 * Cut every pending clip of `room` out of its finished recording. Never throws;
 * returns within about TIME_BOX_MS (plus the file wait) whatever happens.
 * `durationSec` is the recording's length when the egress said (0 = unknown).
 */
export async function cutPendingClips(room: string, filePath: string | null | undefined, durationSec = 0): Promise<CutSummary> {
  const summary: CutSummary = { ready: 0, unavailable: 0 };
  const rec = recordings.get(room);
  recordings.delete(room);
  let pending: StreamClip[] = [];
  try {
    const store = await clipStore();
    pending = await store.listPending(room);
    if (pending.length === 0) return summary;
    const fail = async (c: StreamClip, reason: 'past_cap' | 'past_end' | 'no_recording' | 'failed') => {
      await store.update(c.id, { status: 'unavailable', reason }).catch(() => { /* next time */ });
      summary.unavailable += 1;
    };
    const size = filePath ? await settledSize(filePath, Date.now() + FILE_WAIT_MS) : null;
    if (!filePath || !size) {
      for (const c of pending) await fail(c, 'no_recording');
      return summary;
    }
    await mkdir(CLIP_DIR, { recursive: true });
    const deadline = Date.now() + TIME_BOX_MS;
    const capSec = rec?.maxMs != null ? rec.maxMs / 1000 : null;
    for (const c of pending) {
      const start = c.vodStartSec ?? 0;
      if (capSec != null && start >= capSec) { await fail(c, 'past_cap'); continue; }
      if (durationSec > 0 && start >= durationSec - 1) { await fail(c, 'past_end'); continue; }
      const left = deadline - Date.now();
      if (left <= 1000) { await fail(c, 'failed'); continue; }
      const out = join(CLIP_DIR, c.file);
      try {
        await runCut(cutArgs(filePath, out, start, c.durationSec || VOD_CLIP_SEC), Math.min(PER_CLIP_MS, left));
        await store.update(c.id, { status: 'ready' });
        summary.ready += 1;
      } catch {
        await unlink(out).catch(() => { /* never written */ });
        await fail(c, 'failed');
      }
    }
  } catch {
    // A store that is down: the clips stay pending and show as unavailable
    // after a few hours (streamClips clipStatusOf). The VOD is never held up.
  }
  return summary;
}

/** Tests only. */
export function resetVodClips(): void { recordings.clear(); }
