// Fire-and-forget reporting of live-stream stats to the checker's secret-gated
// /stream-stats/* endpoints (see 3speakchecks/routes/streamStats.ts), which feed
// the streaming leaderboard.
//
// Rules: stats must NEVER break a stream. Every call is best-effort — disabled
// unless STREAM_STATS_SECRET is set, wrapped so a failure is swallowed, and never
// awaited on a hot path. `streamId` is the LiveKit roomName, which is stable for a
// whole broadcast (a new broadcast = a new room = a new id).
import { config } from '../config.js';
import { roomService } from './livekit.js';

const BASE = config.CHECKER_URL.replace(/\/$/, '');
const SECRET = config.STREAM_STATS_SECRET;
const enabled = (): boolean => SECRET.length > 0;

function post(path: string, body: Record<string, unknown>): void {
  if (!enabled()) return;
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  }).catch(() => { /* non-fatal — leaderboard stats never block a stream */ });
}

/** One new viewer showed up on a standalone stream (bumps totalViewers). */
export function recordViewerJoin(roomName: string, host?: string): void {
  post('/stream-stats/viewer', { streamId: roomName, roomName, host });
}

/** A boost landed on a stream — log the sender + amount against it. */
export function recordBoost(
  roomName: string,
  host: string | undefined,
  sender: string,
  amount?: number,
  message?: string,
): void {
  if (!sender) return;
  post('/stream-stats/boost', { streamId: roomName, roomName, host, sender, amount, message });
}

// ── peak + end sampler ──────────────────────────────────────────────────────
// No LiveKit webhook is wired (participant_joined / room_finished), so we poll.
// Each tick: for every live standalone room, report its current concurrent
// viewers (the checker keeps the $max, so this yields the peak); and when a room
// we were tracking disappears, report the stream's end + duration.
type Tracked = { host?: string; liveAtMs: number; lastSeenMs: number };
const tracked = new Map<string, Tracked>();
let timer: ReturnType<typeof setInterval> | null = null;

// Viewers = everyone but the broadcaster, the co-broadcaster, and the OBS ingress
// overlay (which joins as its own participant). Mirrors the /streams count rule.
function countViewers(
  parts: { identity: string }[],
  meta: { host?: string; collabGuest?: string },
): number {
  return parts.filter((p) =>
    p.identity !== meta.host &&
    p.identity !== meta.collabGuest &&
    !p.identity.startsWith('obs-'),
  ).length;
}

async function sampleOnce(): Promise<void> {
  if (!enabled()) return;
  let rooms;
  try {
    rooms = await roomService.listRooms();
  } catch {
    return; // LiveKit unreachable this tick — try again next time
  }
  const now = Date.now();
  const seen = new Set<string>();

  for (const room of rooms) {
    let meta: { mode?: string; host?: string; liveAt?: string; collabGuest?: string } = {};
    try { meta = JSON.parse(room.metadata || '{}'); } catch { /* keep {} */ }
    // Only actual livestreams (standalone studio) that have gone live at least once.
    if (meta.mode !== 'standalone' || !meta.liveAt) continue;

    const roomName = room.name;
    const host = typeof meta.host === 'string' ? meta.host.toLowerCase() : undefined;
    const liveAtMs = Date.parse(meta.liveAt) || now;
    seen.add(roomName);
    tracked.set(roomName, { host, liveAtMs, lastSeenMs: now });

    try {
      const parts = await roomService.listParticipants(roomName);
      post('/stream-stats/peak', { streamId: roomName, roomName, host, peak: countViewers(parts, meta) });
    } catch { /* skip this room this tick */ }
  }

  // Rooms we were tracking that are gone now → the broadcast ended.
  for (const [roomName, t] of tracked) {
    if (seen.has(roomName)) continue;
    const durationSec = Math.max(0, Math.round((t.lastSeenMs - t.liveAtMs) / 1000));
    post('/stream-stats/end', { streamId: roomName, roomName, host: t.host, durationSec });
    tracked.delete(roomName);
  }
}

/** Start the periodic peak/end sampler. No-op if the secret is unset. */
export function startStreamStatsSampler(intervalMs = 30_000): void {
  if (!enabled() || timer) return;
  timer = setInterval(() => { void sampleOnce(); }, intervalMs);
  timer.unref?.();
}
