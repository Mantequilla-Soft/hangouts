import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/requireAuth.js';
import { roomService, generateRoomName, createLivekitToken } from '../lib/livekit.js';
import { getUserStatus } from '../lib/users.js';
import {
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  setEventStatus,
  toggleAttendance,
} from '../lib/events.js';

const EVENT_VISIBILITIES = ['public', 'unlisted'] as const;

// Build a map of Hive username → presence data by querying all active LiveKit rooms.
async function buildPresenceMap(): Promise<Map<string, { roomName: string; roomTitle: string; role: 'host' | 'speaker' | 'listener' }>> {
  const presence = new Map<string, { roomName: string; roomTitle: string; role: 'host' | 'speaker' | 'listener' }>();

  let rooms;
  try {
    rooms = await roomService.listRooms();
  } catch {
    return presence;
  }

  await Promise.all(rooms.map(async (room) => {
    let meta: { host?: string; title?: string } = {};
    try { meta = JSON.parse(room.metadata || '{}'); } catch { /* ignore */ }

    let participants;
    try {
      participants = await roomService.listParticipants(room.name);
    } catch {
      return;
    }

    for (const p of participants) {
      if (p.identity.startsWith('guest-') || p.identity.startsWith('obs-')) continue;

      const role: 'host' | 'speaker' | 'listener' =
        p.identity === meta.host
          ? 'host'
          : p.permission?.canPublish
          ? 'speaker'
          : 'listener';

      presence.set(p.identity, {
        roomName: room.name,
        roomTitle: meta.title || room.name,
        role,
      });
    }
  }));

  return presence;
}

export const eventRoutes: FastifyPluginAsync = async (fastify) => {
  // List upcoming events — public, no auth required.
  // Query: ?status=scheduled&host=username&limit=20
  fastify.get('/events', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['scheduled', 'live', 'ended', 'cancelled'] },
          host:   { type: 'string', minLength: 3, maxLength: 16 },
          limit:  { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { status, host, limit } = request.query as {
      status?: 'scheduled' | 'live' | 'ended' | 'cancelled';
      host?: string;
      limit?: number;
    };
    const events = await listEvents({ status, host, limit });
    return reply.send(events);
  });

  // Get a single event by ID — public, no auth required.
  fastify.get('/events/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 24, maxLength: 24 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const event = await getEventById(id);
    if (!event) return reply.notFound('Event not found');
    return reply.send(event);
  });

  // Create a scheduled event (auth required — caller becomes host).
  fastify.post('/events', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'scheduledAt'],
        properties: {
          title:       { type: 'string', minLength: 3, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          scheduledAt: { type: 'string', format: 'date-time' },
          coverImage:  { type: 'string', maxLength: 512 },
          tags:        { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 5 },
          visibility:  { type: 'string', enum: EVENT_VISIBILITIES as unknown as string[] },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      title: string;
      description?: string;
      scheduledAt: string;
      coverImage?: string;
      tags?: string[];
      visibility?: 'public' | 'unlisted';
    };

    const scheduledAt = new Date(body.scheduledAt);
    if (scheduledAt <= new Date()) {
      return reply.badRequest('scheduledAt must be in the future');
    }

    const event = await createEvent({
      title: body.title,
      description: body.description,
      hostUsername: request.username,
      scheduledAt,
      coverImage: body.coverImage,
      tags: body.tags,
      visibility: body.visibility,
    });

    if (!event) {
      return reply.internalServerError('Failed to create event — MongoDB may not be configured');
    }

    return reply.code(201).send(event);
  });

  // Update a scheduled event (host only, only while scheduled).
  fastify.patch('/events/:id', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 24, maxLength: 24 } },
      },
      body: {
        type: 'object',
        properties: {
          title:       { type: 'string', minLength: 3, maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          scheduledAt: { type: 'string', format: 'date-time' },
          coverImage:  { type: 'string', maxLength: 512 },
          tags:        { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 5 },
          visibility:  { type: 'string', enum: EVENT_VISIBILITIES as unknown as string[] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      title?: string;
      description?: string;
      scheduledAt?: string;
      coverImage?: string;
      tags?: string[];
      visibility?: 'public' | 'unlisted';
    };

    const existing = await getEventById(id);
    if (!existing) return reply.notFound('Event not found');
    if (existing.hostUsername !== request.username) return reply.forbidden('Only the host can edit this event');
    if (existing.status !== 'scheduled') return reply.badRequest('Only scheduled events can be edited');

    let scheduledAt: Date | undefined;
    if (body.scheduledAt) {
      scheduledAt = new Date(body.scheduledAt);
      if (scheduledAt <= new Date()) {
        return reply.badRequest('scheduledAt must be in the future');
      }
    }

    const updated = await updateEvent(id, {
      title: body.title,
      description: body.description,
      scheduledAt,
      coverImage: body.coverImage,
      tags: body.tags,
      visibility: body.visibility,
    });

    if (!updated) return reply.internalServerError('Failed to update event');
    return reply.send(updated);
  });

  // Cancel or end an event (host only).
  // scheduled → cancelled; live → ended.
  fastify.delete('/events/:id', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 24, maxLength: 24 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await getEventById(id);
    if (!existing) return reply.notFound('Event not found');
    if (existing.hostUsername !== request.username) return reply.forbidden('Only the host can cancel this event');
    if (existing.status === 'cancelled' || existing.status === 'ended') {
      return reply.code(204).send();
    }

    const newStatus = existing.status === 'live' ? 'ended' : 'cancelled';
    await setEventStatus(id, newStatus);
    return reply.code(204).send();
  });

  // Mark attending (auth required — any Hive user).
  fastify.post('/events/:id/attend', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 24, maxLength: 24 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await getEventById(id);
    if (!existing) return reply.notFound('Event not found');
    if (existing.status === 'cancelled' || existing.status === 'ended') {
      return reply.badRequest('Cannot attend a cancelled or ended event');
    }

    const updated = await toggleAttendance(id, request.username, true);
    if (!updated) return reply.internalServerError('Failed to update attendance');
    return reply.send({ attendees: updated.attendees, attendeeCount: updated.attendeeCount });
  });

  // Remove attendance (auth required, idempotent).
  fastify.delete('/events/:id/attend', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 24, maxLength: 24 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await getEventById(id);
    if (!existing) return reply.notFound('Event not found');

    const updated = await toggleAttendance(id, request.username, false);
    if (!updated) return reply.internalServerError('Failed to update attendance');
    return reply.send({ attendees: updated.attendees, attendeeCount: updated.attendeeCount });
  });

  // Start event: creates the LiveKit room and marks the event live.
  // Returns a host token so the caller can join immediately.
  fastify.post('/events/:id/start', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 24, maxLength: 24 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await getEventById(id);
    if (!existing) return reply.notFound('Event not found');
    if (existing.hostUsername !== request.username) return reply.forbidden('Only the host can start this event');
    if (existing.status !== 'scheduled') return reply.badRequest('Only scheduled events can be started');

    const host = request.username;
    const { premium } = await getUserStatus(host);
    const roomName = generateRoomName(host, existing.title);

    const metadata = {
      title: existing.title,
      description: existing.description,
      host,
      createdAt: new Date().toISOString(),
      visibility: existing.visibility,
      allowGuests: true,
      eventId: id,
    };

    const room = await roomService.createRoom({
      name: roomName,
      maxParticipants: 500,
      emptyTimeout: 300,
      metadata: JSON.stringify(metadata),
    });

    const token = await createLivekitToken(roomName, host, {
      canPublish: true,
      canPublishData: true,
      premium,
    });

    const updated = await setEventStatus(id, 'live', roomName);
    if (!updated) return reply.internalServerError('Room created but failed to update event status');

    return reply.send({
      event: updated,
      room: {
        name: room.name,
        title: metadata.title,
        host: metadata.host,
        description: metadata.description,
        createdAt: metadata.createdAt,
        visibility: metadata.visibility,
      },
      token,
      isPremium: premium,
    });
  });

  // Check if a Hive user is currently in any room — public, no auth.
  fastify.get('/presence/:username', {
    schema: {
      params: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string', minLength: 3, maxLength: 16 } },
      },
    },
  }, async (request, reply) => {
    const { username } = request.params as { username: string };
    const presenceMap = await buildPresenceMap();
    const found = presenceMap.get(username.toLowerCase());

    if (!found) return reply.send({ online: false });
    return reply.send({ online: true, ...found });
  });

  // Bulk presence check — public, no auth. Body: { usernames: string[] }.
  fastify.post('/presence/bulk', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
    schema: {
      body: {
        type: 'object',
        required: ['usernames'],
        properties: {
          usernames: {
            type: 'array',
            items: { type: 'string', minLength: 3, maxLength: 16 },
            minItems: 1,
            maxItems: 50,
          },
        },
      },
    },
  }, async (request, reply) => {
    const { usernames } = request.body as { usernames: string[] };
    const normalized = usernames.map((u) => u.toLowerCase());

    const presenceMap = await buildPresenceMap();
    const result: Record<string, unknown> = {};

    for (const username of normalized) {
      const found = presenceMap.get(username);
      result[username] = found ? { online: true, ...found } : { online: false };
    }

    return reply.send(result);
  });
};
