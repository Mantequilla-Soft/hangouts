import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Rewind during a live stream (H14): viewers seek back in the segments the Pro
 * DVR egress ALREADY writes. No new egress, no transcoding: the server only
 * rewrites a playlist (cached a second per room) and serves files from disk.
 *
 * Access: the playlist and segment URLs carry a token bound to the room and the
 * hour, handed out by GET /rooms/:name/dvr/rewind (which applies the room's
 * Hive-only rule). Everyone watching the same room in the same hour gets the
 * SAME URLs, so a CDN in front can cache them.
 */
const HOUR_MS = 3_600_000;

function key(): Buffer {
  return createHmac('sha256', config.SESSION_SECRET).update('hangouts-dvr-rewind-v1').digest();
}

export function rewindToken(room: string, now = Date.now()): string {
  const hour = Math.floor(now / HOUR_MS);
  return createHmac('sha256', key()).update(`${room}:${hour}`).digest('base64url').slice(0, 22);
}

/** Valid for the hour it was made in and the next one. */
export function checkRewindToken(room: string, token: string, now = Date.now()): boolean {
  if (typeof token !== 'string' || token.length !== 22) return false;
  for (const t of [now, now - HOUR_MS]) {
    const want = Buffer.from(rewindToken(room, t));
    const got = Buffer.from(token);
    if (want.length === got.length && timingSafeEqual(want, got)) return true;
  }
  return false;
}

export const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}\.ts$/;
const base = (uri: string) => uri.split(/[\\/]/).pop() ?? uri;

/**
 * The rewind playlist: the egress's full playlist (index.m3u8) cut down to the
 * segments still on disk, minus the oldest `margin` (the janitor is about to
 * delete them). A live (no ENDLIST) playlist, so hls.js keeps refreshing it and
 * the seek bar grows at the live edge. Without an index (not written yet), the
 * directory listing in name order with the nominal segment length.
 * Returns null when there is nothing to play yet.
 */
export function buildRewindPlaylist(
  indexText: string | null,
  onDisk: string[],
  { segmentSec = 2, margin = 2 }: { segmentSec?: number; margin?: number } = {},
): string | null {
  const present = new Set(onDisk.filter((f) => SEGMENT_RE.test(f)));
  type Entry = { seq: number; tags: string[]; uri: string };
  const entries: Entry[] = [];
  let target = segmentSec;
  let version = 3;

  if (indexText && indexText.includes('#EXTINF')) {
    let seq = 0;
    let pending: string[] = [];
    for (const raw of indexText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { seq = Number(line.split(':')[1]) || 0; continue; }
      if (line.startsWith('#EXT-X-TARGETDURATION:')) { target = Number(line.split(':')[1]) || target; continue; }
      if (line.startsWith('#EXT-X-VERSION:')) { version = Number(line.split(':')[1]) || version; continue; }
      if (line.startsWith('#EXTINF') || line.startsWith('#EXT-X-PROGRAM-DATE-TIME') || line === '#EXT-X-DISCONTINUITY') {
        pending.push(line);
        continue;
      }
      if (line.startsWith('#')) continue;
      entries.push({ seq, tags: pending, uri: base(line) });
      seq += 1;
      pending = [];
    }
  } else {
    // No index yet: the listing, minus the newest file (still being written).
    // The sequence number comes from the file name (seg_00012.ts), so it stays
    // stable while the janitor deletes the oldest files.
    [...present].sort().slice(0, -1).forEach((f, i) => {
      const n = /(\d+)\.ts$/.exec(f);
      entries.push({ seq: n ? Number(n[1]) : i, tags: [`#EXTINF:${segmentSec.toFixed(3)},`], uri: f });
    });
  }

  const kept = entries.filter((e) => present.has(e.uri)).slice(margin);
  if (kept.length === 0) return null;
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${version}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(target)}`,
    `#EXT-X-MEDIA-SEQUENCE:${kept[0].seq}`,
  ];
  for (const e of kept) {
    // A discontinuity before the first kept segment means nothing to the player.
    lines.push(...(e === kept[0] ? e.tags.filter((t) => t !== '#EXT-X-DISCONTINUITY') : e.tags), e.uri);
  }
  return `${lines.join('\n')}\n`;
}
