import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), listParticipants: vi.fn() },
}));

const { roomService } = await import('../../src/lib/livekit.js');
const { findLiveRoomForHost } = await import('../../src/lib/chatOverlay.js');

function room(name: string, meta: Record<string, unknown>) {
  return { name, metadata: JSON.stringify(meta) };
}

describe('findLiveRoomForHost', () => {
  beforeEach(() => {
    vi.mocked(roomService.listParticipants).mockImplementation(async (name: string) => (
      name === 'gone-host' ? [{ identity: 'viewer1' }] : [{ identity: 'alice' }, { identity: 'viewer1' }]
    ) as never);
  });

  it('returns the broadcasting standalone room the host is connected to', async () => {
    vi.mocked(roomService.listRooms).mockResolvedValue([
      room('bob-1', { mode: 'standalone', host: 'bob', broadcasting: true }),
      room('alice-conf', { mode: 'conference', host: 'alice', broadcasting: true }),
      room('alice-idle', { mode: 'standalone', host: 'alice', broadcasting: false }),
      room('alice-live', { mode: 'standalone', host: 'alice', broadcasting: true, liveAt: '2026-10-18T14:00:00Z' }),
    ] as never);
    expect(await findLiveRoomForHost('alice')).toBe('alice-live');
  });

  it('skips a stale broadcasting room whose host is gone, and prefers the newest', async () => {
    vi.mocked(roomService.listRooms).mockResolvedValue([
      room('alice-old', { mode: 'standalone', host: 'alice', broadcasting: true, liveAt: '2026-10-18T10:00:00Z' }),
      room('gone-host', { mode: 'standalone', host: 'alice', broadcasting: true, liveAt: '2026-10-18T15:00:00Z' }),
      room('alice-new', { mode: 'standalone', host: 'alice', broadcasting: true, liveAt: '2026-10-18T14:00:00Z' }),
    ] as never);
    expect(await findLiveRoomForHost('alice')).toBe('alice-new');
  });

  it('returns null when the user is not live', async () => {
    vi.mocked(roomService.listRooms).mockResolvedValue([room('x', { mode: 'standalone', host: 'bob', broadcasting: true })] as never);
    expect(await findLiveRoomForHost('alice')).toBeNull();
  });
});
