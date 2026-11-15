import type { FastifyRequest } from 'fastify';
import { TokenVerifier } from 'livekit-server-sdk';
import { DataPacket_Kind } from '@livekit/protocol';
import { config } from '../config.js';
import { roomService } from './livekit.js';
import { verifySessionToken } from './session.js';
import type { RoomMetadata } from './streamRoom.js';

/**
 * Small shared helpers for the live-interaction routes (chat backlog, polls,
 * raids): read one room's metadata, tell who is calling, and send a data
 * message to everyone in a room.
 */

export type LiveRoomMeta = Partial<RoomMetadata> & {
  broadcasting?: boolean;
  liveAt?: string;
  mods?: string[];
  host?: string;
};

/** The room's metadata, or null when LiveKit has no such room. */
export async function readRoomMeta(name: string): Promise<LiveRoomMeta | null> {
  const rooms = await roomService.listRooms([name]);
  if (rooms.length === 0) return null;
  try { return JSON.parse(rooms[0].metadata || '{}') as LiveRoomMeta; } catch { return {}; }
}

/** The signed-in Hive account behind a Bearer session, or null (no header, expired, bogus). */
export async function sessionUser(request: FastifyRequest): Promise<string | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const session = await verifySessionToken(header.slice(7));
    return session.sub;
  } catch {
    return null;
  }
}

const verifier = new TokenVerifier(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);

/**
 * The LiveKit identity a room token proves, when it is a token for THIS room
 * that may publish data (a chatting guest). Null for anything else.
 */
export async function livekitIdentity(token: unknown, roomName: string): Promise<string | null> {
  return (await livekitParticipant(token, roomName))?.identity ?? null;
}

/**
 * Like livekitIdentity, plus the display name the server put in that token
 * (the name everyone sees on the data channel), so a line's name can come
 * from the token instead of the request body.
 */
export async function livekitParticipant(token: unknown, roomName: string): Promise<{ identity: string; name: string } | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
  try {
    const claims = await verifier.verify(token);
    if (claims.video?.room !== roomName || claims.video?.canPublishData === false) return null;
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : claims.sub;
    return { identity: claims.sub, name };
  } catch {
    return null;
  }
}

export function isHostOrMod(meta: LiveRoomMeta, username: string | null): boolean {
  if (!username) return false;
  if (meta.host === username) return true;
  return Array.isArray(meta.mods) && meta.mods.map((m) => String(m).toLowerCase()).includes(username.toLowerCase());
}

/** Everyone in the room gets `payload` on `topic`. Best-effort, never throws. */
export async function sendRoomData(roomName: string, topic: string, payload: unknown): Promise<boolean> {
  try {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    await roomService.sendData(roomName, data, DataPacket_Kind.RELIABLE, { topic });
    return true;
  } catch {
    return false;
  }
}

/** Seconds into the stream (from the go-live stamp), or null before Start. */
export function streamOffset(meta: LiveRoomMeta, at = Date.now()): number | null {
  const live = meta.liveAt ? Date.parse(meta.liveAt) : NaN;
  if (!Number.isFinite(live)) return null;
  return Math.max(0, Math.floor((at - live) / 1000));
}
