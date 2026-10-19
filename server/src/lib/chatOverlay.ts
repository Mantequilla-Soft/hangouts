import { roomService } from './livekit.js';
import type { RoomMetadata } from './streamRoom.js';

/**
 * The room a user is streaming in right now, for their OBS chat overlay.
 *
 * Bound to the user, not a template: a person streams one thing at a time, so
 * one overlay URL follows them across templates and also covers streams from
 * the browser Stream Studio. Same "live" rule as GET /streams: a standalone
 * room hosted by them that is broadcasting with the host still connected (a
 * headless OBS stream's ingress joins under the host's identity). Unlisted
 * streams count too: the overlay key is the proof of access.
 */
export async function findLiveRoomForHost(host: string): Promise<string | null> {
  const rooms = await roomService.listRooms();
  const candidates = rooms
    .map((r) => {
      let meta: Partial<RoomMetadata> & { broadcasting?: boolean } = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }
      return { name: r.name, meta };
    })
    .filter(({ meta }) => meta.mode === 'standalone' && meta.host === host && meta.broadcasting)
    // Newest first, in case a stale room is still around.
    .sort((a, b) => String(b.meta.liveAt || b.meta.createdAt || '').localeCompare(String(a.meta.liveAt || a.meta.createdAt || '')));

  for (const { name } of candidates) {
    try {
      const parts = await roomService.listParticipants(name);
      if (parts.some((p) => p.identity === host)) return name;
    } catch { /* room vanished between the two calls */ }
  }
  return null;
}
