import { RoomServiceClient, AccessToken } from 'livekit-server-sdk';
import { config } from '../config.js';

export const roomService = new RoomServiceClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

export function generateRoomName(username: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const id = Math.random().toString(36).slice(2, 8);
  return `${username}-${slug}-${id}`;
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
