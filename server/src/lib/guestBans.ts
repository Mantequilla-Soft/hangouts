/** In-memory IP-based ban state for guest listeners, scoped per room.
 *  All data is ephemeral — cleared when a room ends or the server restarts.
 *  Rooms don't persist across restarts, so this is always correct. */

// room → (guestIdentity → IP address)
const guestIpRegistry = new Map<string, Map<string, string>>();

// room → Set of banned IP addresses
const roomBannedIps = new Map<string, Set<string>>();

export function recordGuestIp(roomName: string, identity: string, ip: string): void {
  if (!guestIpRegistry.has(roomName)) guestIpRegistry.set(roomName, new Map());
  guestIpRegistry.get(roomName)!.set(identity, ip);
}

export function isGuestBanned(roomName: string, ip: string): boolean {
  return roomBannedIps.get(roomName)?.has(ip) ?? false;
}

/** Bans a guest by identity — looks up their IP and adds it to the room ban set.
 *  Returns true if the identity was found and banned, false if the identity was unknown. */
export function banGuestByIdentity(roomName: string, identity: string): boolean {
  const ip = guestIpRegistry.get(roomName)?.get(identity);
  if (!ip) return false;
  if (!roomBannedIps.has(roomName)) roomBannedIps.set(roomName, new Set());
  roomBannedIps.get(roomName)!.add(ip);
  return true;
}

export function clearRoomBans(roomName: string): void {
  guestIpRegistry.delete(roomName);
  roomBannedIps.delete(roomName);
}
