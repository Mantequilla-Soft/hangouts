import { RoomServiceClient, AccessToken } from 'livekit-server-sdk';
import { config } from '../config.js';

export const roomService = new RoomServiceClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

/**
 * Room names end up in the SHARE LINK (/watch/<roomName>) and are reused as the
 * Hive permlink for the announcement post, so they want to be short.
 *
 * The title slug used to be included at up to 32 chars, which produced links
 * like `badadib-testy-update4-s7dw6b`. Dropping it roughly halves the link
 * while staying unique and still saying who is streaming. `title` is kept in
 * the signature (and ignored) so callers don't need changing.
 */
export function generateRoomName(username: string, _title: string): string {
  // 7 chars of base36 ≈ 78 billion combinations — collision risk is nil at any
  // plausible room count, and it stays short.
  const id = Math.random().toString(36).slice(2, 9);
  return `${username}-${id}`;
}

export async function createLivekitToken(
  room: string,
  identity: string,
  options: { canPublish: boolean; canPublishData: boolean; premium?: boolean; ttl?: string; name?: string },
): Promise<string> {
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity,
    name: options.name,
    ttl: options.ttl ?? '6h',
  });

  const grant: Record<string, unknown> = {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublishData: options.canPublishData,
  };
  grant.canPublish = options.canPublish;
  at.addGrant(grant);
  return at.toJwt();
}
