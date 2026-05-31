import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordGuestIp,
  isGuestBanned,
  banGuestByIdentity,
  clearRoomBans,
} from '../../src/lib/guestBans.js';

const ROOM = 'test-room';
const OTHER_ROOM = 'other-room';
const IDENTITY = 'guest-abc123';
const IP = '1.2.3.4';

beforeEach(() => {
  clearRoomBans(ROOM);
  clearRoomBans(OTHER_ROOM);
});

describe('recordGuestIp', () => {
  it('stores the IP for a guest identity', () => {
    recordGuestIp(ROOM, IDENTITY, IP);
    // Verify indirectly: banGuestByIdentity should now find the IP
    expect(banGuestByIdentity(ROOM, IDENTITY)).toBe(true);
  });
});

describe('isGuestBanned', () => {
  it('returns false for an unknown IP', () => {
    expect(isGuestBanned(ROOM, IP)).toBe(false);
  });

  it('returns false for a room with no bans', () => {
    recordGuestIp(ROOM, IDENTITY, IP);
    expect(isGuestBanned(ROOM, IP)).toBe(false);
  });

  it('returns true after the IP has been banned', () => {
    recordGuestIp(ROOM, IDENTITY, IP);
    banGuestByIdentity(ROOM, IDENTITY);
    expect(isGuestBanned(ROOM, IP)).toBe(true);
  });
});

describe('banGuestByIdentity', () => {
  it('returns false when the identity has no recorded IP', () => {
    expect(banGuestByIdentity(ROOM, 'guest-unknown')).toBe(false);
  });

  it('returns true and marks the IP as banned', () => {
    recordGuestIp(ROOM, IDENTITY, IP);
    expect(banGuestByIdentity(ROOM, IDENTITY)).toBe(true);
    expect(isGuestBanned(ROOM, IP)).toBe(true);
  });

  it('banning one identity bans all guests sharing the same IP', () => {
    const identity2 = 'guest-xyz789';
    recordGuestIp(ROOM, IDENTITY, IP);
    recordGuestIp(ROOM, identity2, IP);
    banGuestByIdentity(ROOM, IDENTITY);
    expect(isGuestBanned(ROOM, IP)).toBe(true);
  });
});

describe('clearRoomBans', () => {
  it('removes all bans for a room', () => {
    recordGuestIp(ROOM, IDENTITY, IP);
    banGuestByIdentity(ROOM, IDENTITY);
    clearRoomBans(ROOM);
    expect(isGuestBanned(ROOM, IP)).toBe(false);
  });

  it('does not affect other rooms', () => {
    recordGuestIp(ROOM, IDENTITY, IP);
    recordGuestIp(OTHER_ROOM, IDENTITY, IP);
    banGuestByIdentity(ROOM, IDENTITY);
    banGuestByIdentity(OTHER_ROOM, IDENTITY);
    clearRoomBans(ROOM);
    expect(isGuestBanned(OTHER_ROOM, IP)).toBe(true);
  });
});

describe('cross-room isolation', () => {
  it('a ban in room A does not affect room B', () => {
    recordGuestIp(ROOM, IDENTITY, IP);
    banGuestByIdentity(ROOM, IDENTITY);
    expect(isGuestBanned(OTHER_ROOM, IP)).toBe(false);
  });
});
