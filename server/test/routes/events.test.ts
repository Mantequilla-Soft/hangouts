import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(),
    listParticipants: vi.fn(),
    createRoom: vi.fn(),
    removeParticipant: vi.fn(),
    updateParticipant: vi.fn(),
    updateRoomMetadata: vi.fn(),
    deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-test-event-abc123'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

vi.mock('../../src/lib/events.js', () => ({
  listEvents: vi.fn(),
  getEventById: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  setEventStatus: vi.fn(),
  toggleAttendance: vi.fn(),
}));

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const EVENT_ID = '507f1f77bcf86cd799439011';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: 'Test Hangout',
    description: 'A great event',
    hostUsername: 'alice',
    scheduledAt: FUTURE,
    tags: [],
    attendees: [],
    attendeeCount: 0,
    status: 'scheduled',
    visibility: 'public',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /events ─────────────────────────────────────────────────────────────

describe('GET /events', () => {
  it('returns 200 with an array of events (public, no auth)', async () => {
    const { listEvents } = await import('../../src/lib/events.js');
    vi.mocked(listEvents).mockResolvedValue([makeEvent()]);

    const res = await app.inject({ method: 'GET', url: '/events' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].title).toBe('Test Hangout');
  });

  it('passes status and host query params to listEvents', async () => {
    const { listEvents } = await import('../../src/lib/events.js');
    vi.mocked(listEvents).mockResolvedValue([]);

    await app.inject({ method: 'GET', url: '/events?status=live&host=alice&limit=5' });

    expect(listEvents).toHaveBeenCalledWith({ status: 'live', host: 'alice', limit: 5 });
  });

  it('returns 200 with empty array when no events', async () => {
    const { listEvents } = await import('../../src/lib/events.js');
    vi.mocked(listEvents).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/events' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

// ─── GET /events/:id ─────────────────────────────────────────────────────────

describe('GET /events/:id', () => {
  it('returns 200 with the event (public, no auth)', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent());

    const res = await app.inject({ method: 'GET', url: `/events/${EVENT_ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(EVENT_ID);
  });

  it('returns 404 when event does not exist', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: `/events/${EVENT_ID}` });

    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /events ─────────────────────────────────────────────────────────────

describe('POST /events', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: { title: 'My Event', scheduledAt: FUTURE },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 201 with the new event when authenticated', async () => {
    const { createEvent } = await import('../../src/lib/events.js');
    vi.mocked(createEvent).mockResolvedValue(makeEvent());
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'My Event', scheduledAt: FUTURE },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().title).toBe('Test Hangout');
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My Event',
      hostUsername: 'alice',
    }));
  });

  it('returns 400 when scheduledAt is in the past', async () => {
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'My Event', scheduledAt: PAST },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when title is too short', async () => {
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'AB', scheduledAt: FUTURE },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 500 when MongoDB is unavailable (createEvent returns null)', async () => {
    const { createEvent } = await import('../../src/lib/events.js');
    vi.mocked(createEvent).mockResolvedValue(null);
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'My Event', scheduledAt: FUTURE },
    });

    expect(res.statusCode).toBe(500);
  });
});

// ─── PATCH /events/:id ───────────────────────────────────────────────────────

describe('PATCH /events/:id', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/events/${EVENT_ID}`,
      payload: { title: 'Updated' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ hostUsername: 'alice' }));
    const token = await makeToken('bob');

    const res = await app.inject({
      method: 'PATCH',
      url: `/events/${EVENT_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Updated' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when event is not scheduled', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ status: 'live' }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'PATCH',
      url: `/events/${EVENT_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Updated' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with updated event when host edits a scheduled event', async () => {
    const { getEventById, updateEvent } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent());
    vi.mocked(updateEvent).mockResolvedValue(makeEvent({ title: 'Updated' }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'PATCH',
      url: `/events/${EVENT_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Updated' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Updated');
  });
});

// ─── DELETE /events/:id ──────────────────────────────────────────────────────

describe('DELETE /events/:id', () => {
  it('returns 403 when caller is not the host', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ hostUsername: 'alice' }));
    const token = await makeToken('bob');

    const res = await app.inject({
      method: 'DELETE',
      url: `/events/${EVENT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('sets status to cancelled when event is scheduled', async () => {
    const { getEventById, setEventStatus } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ status: 'scheduled' }));
    vi.mocked(setEventStatus).mockResolvedValue(makeEvent({ status: 'cancelled' }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'DELETE',
      url: `/events/${EVENT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(setEventStatus).toHaveBeenCalledWith(EVENT_ID, 'cancelled');
  });

  it('sets status to ended when event is live', async () => {
    const { getEventById, setEventStatus } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ status: 'live' }));
    vi.mocked(setEventStatus).mockResolvedValue(makeEvent({ status: 'ended' }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'DELETE',
      url: `/events/${EVENT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(setEventStatus).toHaveBeenCalledWith(EVENT_ID, 'ended');
  });

  it('returns 204 without calling setEventStatus when already terminal', async () => {
    const { getEventById, setEventStatus } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ status: 'cancelled' }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'DELETE',
      url: `/events/${EVENT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(setEventStatus).not.toHaveBeenCalled();
  });
});

// ─── POST /events/:id/attend ─────────────────────────────────────────────────

describe('POST /events/:id/attend', () => {
  it('returns 401 without a session token', async () => {
    const res = await app.inject({ method: 'POST', url: `/events/${EVENT_ID}/attend` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 and updated attendee list when authenticated', async () => {
    const { getEventById, toggleAttendance } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent());
    vi.mocked(toggleAttendance).mockResolvedValue(
      makeEvent({ attendees: ['alice'], attendeeCount: 1 }),
    );
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/events/${EVENT_ID}/attend`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().attendeeCount).toBe(1);
    expect(toggleAttendance).toHaveBeenCalledWith(EVENT_ID, 'alice', true);
  });

  it('returns 400 when event is cancelled', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ status: 'cancelled' }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/events/${EVENT_ID}/attend`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── DELETE /events/:id/attend ───────────────────────────────────────────────

describe('DELETE /events/:id/attend', () => {
  it('returns 200 and removes the attendee', async () => {
    const { getEventById, toggleAttendance } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ attendees: ['alice'], attendeeCount: 1 }));
    vi.mocked(toggleAttendance).mockResolvedValue(makeEvent({ attendees: [], attendeeCount: 0 }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'DELETE',
      url: `/events/${EVENT_ID}/attend`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().attendeeCount).toBe(0);
    expect(toggleAttendance).toHaveBeenCalledWith(EVENT_ID, 'alice', false);
  });
});

// ─── POST /events/:id/start ──────────────────────────────────────────────────

describe('POST /events/:id/start', () => {
  it('returns 403 when caller is not the host', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ hostUsername: 'alice' }));
    const token = await makeToken('bob');

    const res = await app.inject({
      method: 'POST',
      url: `/events/${EVENT_ID}/start`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when event is not scheduled', async () => {
    const { getEventById } = await import('../../src/lib/events.js');
    vi.mocked(getEventById).mockResolvedValue(makeEvent({ status: 'live' }));
    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/events/${EVENT_ID}/start`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with room, token, and updated event when host starts', async () => {
    const { getEventById, setEventStatus } = await import('../../src/lib/events.js');
    const { roomService } = await import('../../src/lib/livekit.js');

    vi.mocked(getEventById).mockResolvedValue(makeEvent());
    vi.mocked(roomService.createRoom).mockResolvedValue({
      name: 'alice-test-event-abc123',
      metadata: '{}',
      numParticipants: 0,
      maxParticipants: 500,
    } as any);
    vi.mocked(setEventStatus).mockResolvedValue(makeEvent({ status: 'live', roomName: 'alice-test-event-abc123' }));

    const token = await makeToken('alice');

    const res = await app.inject({
      method: 'POST',
      url: `/events/${EVENT_ID}/start`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe('mock-token');
    expect(res.json().event.status).toBe('live');
    expect(res.json().room.name).toBe('alice-test-event-abc123');
    expect(setEventStatus).toHaveBeenCalledWith(EVENT_ID, 'live', 'alice-test-event-abc123');
  });
});

// ─── GET /presence/:username ─────────────────────────────────────────────────

describe('GET /presence/:username', () => {
  it('returns online:false when user is not in any room (public, no auth)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/presence/alice' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ online: false });
  });

  it('returns online:true with room details when user is in a room', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([{
      name: 'alice-room-xyz',
      metadata: JSON.stringify({ host: 'alice', title: 'My Hangout' }),
      numParticipants: 1,
    }] as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([{
      identity: 'alice',
      permission: { canPublish: true },
    }] as any);

    const res = await app.inject({ method: 'GET', url: '/presence/alice' });

    expect(res.statusCode).toBe(200);
    expect(res.json().online).toBe(true);
    expect(res.json().roomName).toBe('alice-room-xyz');
    expect(res.json().roomTitle).toBe('My Hangout');
    expect(res.json().role).toBe('host');
  });

  it('excludes guest and obs identities from presence', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([{
      name: 'some-room',
      metadata: JSON.stringify({ host: 'carol', title: 'Room' }),
      numParticipants: 2,
    }] as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([
      { identity: 'guest-abc123', permission: { canPublish: false } },
      { identity: 'obs-xyz', permission: { canPublish: false } },
    ] as any);

    const res = await app.inject({ method: 'GET', url: '/presence/guest-abc123' });

    expect(res.statusCode).toBe(200);
    expect(res.json().online).toBe(false);
  });
});

// ─── POST /presence/bulk ─────────────────────────────────────────────────────

describe('POST /presence/bulk', () => {
  it('returns a map of username → presence (public, no auth)', async () => {
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.listRooms).mockResolvedValue([{
      name: 'alice-room',
      metadata: JSON.stringify({ host: 'alice', title: 'Alice Hangout' }),
      numParticipants: 1,
    }] as any);
    vi.mocked(roomService.listParticipants).mockResolvedValue([{
      identity: 'alice',
      permission: { canPublish: true },
    }] as any);

    const res = await app.inject({
      method: 'POST',
      url: '/presence/bulk',
      payload: { usernames: ['alice', 'bob'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().alice.online).toBe(true);
    expect(res.json().alice.role).toBe('host');
    expect(res.json().bob.online).toBe(false);
  });

  it('returns 400 when usernames array is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/presence/bulk',
      payload: { usernames: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when more than 50 usernames are requested', async () => {
    const usernames = Array.from({ length: 51 }, (_, i) => `user${i}`);
    const res = await app.inject({
      method: 'POST',
      url: '/presence/bulk',
      payload: { usernames },
    });
    expect(res.statusCode).toBe(400);
  });
});
