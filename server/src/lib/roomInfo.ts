import type { FastifyRequest } from 'fastify';
import { roomService } from './livekit.js';
import { verifySessionToken } from './session.js';

/**
 * The few room facts the highlight, clip, rewind and podcast code needs: host,
 * go-live time, mode, visibility, title. One LiveKit call; null when the room is
 * gone or LiveKit does not answer.
 */
export interface RoomFacts {
  host: string | null;
  liveAt: number | null;
  mode: string | null;
  visibility: string | null;
  title: string | null;
  thumbnail: string | null;
  meta: Record<string, unknown>;
}

export async function readRoomFacts(room: string): Promise<RoomFacts | null> {
  try {
    const rooms = await roomService.listRooms([room]);
    if (rooms.length === 0) return null;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* empty */ }
    const post = (meta.post && typeof meta.post === 'object' ? meta.post : {}) as Record<string, unknown>;
    const liveAt = typeof meta.liveAt === 'string' ? Date.parse(meta.liveAt) : NaN;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return {
      host: str(meta.host),
      liveAt: Number.isFinite(liveAt) ? liveAt : null,
      mode: str(meta.mode),
      visibility: str(meta.visibility),
      title: str(post.title) ?? str(meta.title),
      thumbnail: str(post.thumbnail) ?? str(meta.backgroundImage),
      meta,
    };
  } catch {
    return null;
  }
}

/** The signed-in user of a request when it carries a valid session, else null.
 *  For routes that work for guests too but credit a user when there is one. */
export async function optionalUser(request: FastifyRequest): Promise<string | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return (await verifySessionToken(header.slice(7))).sub;
  } catch {
    return null;
  }
}
