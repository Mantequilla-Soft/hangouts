import type { FastifyPluginAsync } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';

interface RoomMetadata {
  title: string;
  description?: string;
  host: string;
  createdAt: string;
}

function generateRoomName(username: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const id = Math.random().toString(36).slice(2, 8);
  return `${username}-${slug}-${id}`;
}

async function createLivekitToken(
  room: string,
  identity: string,
  options: { canPublish: boolean; canPublishData: boolean },
): Promise<string> {
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity,
    ttl: '6h',
  });

  at.addGrant({
    roomJoin: true,
    room,
    canPublish: options.canPublish,
    canSubscribe: true,
    canPublishData: options.canPublishData,
  });

  return at.toJwt();
}

export const roomRoutes: FastifyPluginAsync = async (fastify) => {
  // List active rooms (public — no auth required)
  fastify.get('/rooms', async (_request, reply) => {
    const rooms = await roomService.listRooms();

    const result = rooms.map((r) => {
      let meta: Partial<RoomMetadata> = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }

      return {
        name: r.name,
        title: meta.title || r.name,
        host: meta.host || 'unknown',
        description: meta.description,
        numParticipants: r.numParticipants,
        maxParticipants: r.maxParticipants,
        createdAt: meta.createdAt || new Date(Number(r.creationTime) * 1000).toISOString(),
      };
    });

    return reply.send(result);
  });

  // Get a single room by name (public — no auth required)
  fastify.get('/rooms/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) {
      return reply.notFound('Room not found');
    }

    const r = rooms[0];
    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }

    return reply.send({
      name: r.name,
      title: meta.title || r.name,
      host: meta.host || 'unknown',
      description: meta.description,
      numParticipants: r.numParticipants,
      maxParticipants: r.maxParticipants,
      createdAt: meta.createdAt || new Date(Number(r.creationTime) * 1000).toISOString(),
    });
  });

  // Create a room (auth required — caller becomes host)
  fastify.post('/rooms', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title:       { type: 'string', minLength: 1, maxLength: 64 },
          description: { type: 'string', maxLength: 256 },
        },
      },
    },
  }, async (request, reply) => {
    const { title, description } = request.body as { title: string; description?: string };
    const host = request.username;

    const roomName = generateRoomName(host, title);
    const metadata: RoomMetadata = {
      title,
      description,
      host,
      createdAt: new Date().toISOString(),
    };

    const room = await roomService.createRoom({
      name: roomName,
      maxParticipants: 500,
      emptyTimeout: 300,
      metadata: JSON.stringify(metadata),
    });

    // Issue a host token with full permissions
    const token = await createLivekitToken(roomName, host, {
      canPublish: true,
      canPublishData: true,
    });

    return reply.code(201).send({
      room: {
        name: room.name,
        title: metadata.title,
        host: metadata.host,
        description: metadata.description,
        createdAt: metadata.createdAt,
      },
      token,
    });
  });

  // Join a room as a listener (auth required — identity from session)
  fastify.post('/rooms/:name/join', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const identity = request.username;

    // Verify the room exists
    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) {
      return reply.notFound('Room not found');
    }

    // Check if this user is the host — if so, give publish permissions
    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
    const isHost = meta.host === identity;

    const token = await createLivekitToken(name, identity, {
      canPublish: isHost,
      canPublishData: true, // all participants can send data (hand raise, etc.)
    });

    return reply.send({ token, roomName: name, identity, isHost });
  });

  // Delete/close a room (auth required — host only)
  fastify.delete('/rooms/:name', {
    preHandler: requireAuth,
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    // Verify caller is the host
    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) {
      return reply.notFound('Room not found');
    }

    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    if (meta.host !== request.username) {
      return reply.forbidden('Only the host can close the room');
    }

    await roomService.deleteRoom(name);
    return reply.code(204).send();
  });
};
