import { config } from '../config.js';
import { clipStore, clipStatusOf, type StreamClip } from './streamClips.js';
import { readRoomFacts } from './roomInfo.js';

/**
 * Tell the 3Speak checker that a stream's clips are ready (H13), so the host
 * (every clip) and each clipper (their own) get a bell notification and a push
 * that lead to 3speak.tv/clips. Same secret-gated channel as the stream stats
 * (POST /stream-stats/clips-ready, STREAM_STATS_SECRET); off when it is unset.
 * Called once the clips exist: at the end of a DVR stream, and after the
 * pending clips were cut from the VOD recording. The checker keeps one row per
 * person and stream, so a second call only updates the counts.
 */
type Fetch = typeof fetch;

/** Pure: the body for the checker, or null when nothing is ready. */
export function clipsReadyBody(room: string, clips: StreamClip[], title: string | null) {
  const ready = clips.filter((c) => clipStatusOf(c).status === 'ready');
  const host = ready.find((c) => c.host)?.host ?? null;
  if (!host || ready.length === 0) return null;
  const counts = new Map<string, number>();
  for (const c of ready) if (c.clipper && c.clipper !== host) counts.set(c.clipper, (counts.get(c.clipper) ?? 0) + 1);
  return {
    room,
    host,
    ...(title ? { title } : {}),
    total: ready.length,
    clippers: [...counts.entries()].map(([user, count]) => ({ user, count })),
  };
}

export async function notifyClipsReady(room: string, fetchFn: Fetch = fetch): Promise<boolean> {
  if (!config.STREAM_STATS_SECRET) return false;
  try {
    const store = await clipStore();
    const clips = await store.listForRoom(room);
    const title = clips.length ? (await readRoomFacts(room))?.title ?? null : null;
    const body = clipsReadyBody(room, clips, title);
    if (!body) return false;
    const res = await fetchFn(`${config.CHECKER_URL.replace(/\/$/, '')}/stream-stats/clips-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.STREAM_STATS_SECRET}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false; // notifications never break a stream's end
  }
}
