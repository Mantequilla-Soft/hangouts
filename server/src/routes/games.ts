import type { FastifyPluginAsync } from 'fastify';
import { DataPacket_Kind } from '@livekit/protocol';
import { roomService } from '../lib/livekit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { gameRegistry } from '../lib/game-registry.js';
import { gameSessionStore } from '../lib/game-session-store.js';
import { listCollections } from '../lib/word-collection.js';

async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };
  let meta: { host?: string } = {};
  try { meta = JSON.parse(rooms[0]!.metadata || '{}'); } catch { /* ignore */ }
  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null };
}

async function sendToParticipant(roomName: string, identity: string, msg: unknown): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(msg));
  await roomService.sendData(roomName, payload, DataPacket_Kind.RELIABLE, {
    topic: 'game',
    destinationIdentities: [identity],
  });
}

async function broadcastToRoom(roomName: string, msg: unknown): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(msg));
  await roomService.sendData(roomName, payload, DataPacket_Kind.RELIABLE, { topic: 'game' });
}

export const gameRoutes: FastifyPluginAsync = async (fastify) => {
  // List available game plugins — public, no auth required.
  fastify.get('/games', async (_request, reply) => {
    return reply.send(gameRegistry.list());
  });

  // List available word collections — public, no auth required.
  fastify.get('/game-collections', async (_request, reply) => {
    return reply.send(await listCollections());
  });

  // Get active game state for the calling participant (for late joiners).
  fastify.get('/rooms/:name/game', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const session = gameSessionStore.get(name);
    if (!session) return reply.notFound('No active game in this room');
    return reply.send({
      gameId: session.gameId,
      participants: session.participants,
      startedAt: session.startedAt,
      state: session.payloads[request.username] ?? null,
    });
  });

  // Start a game in a room (host only).
  fastify.post('/rooms/:name/game/start', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['gameId'],
        properties: {
          gameId: { type: 'string' },
          config: {},
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { gameId, config } = request.body as { gameId: string; config?: unknown };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can start a game');

    const plugin = gameRegistry.get(gameId);
    if (!plugin) return reply.notFound(`Game '${gameId}' not found`);

    const lkParticipants = await roomService.listParticipants(name);
    const participants = lkParticipants
      .map((p) => p.identity)
      .filter((id) => !id.startsWith('guest-') && !id.startsWith('obs-'));

    if (participants.length < plugin.minPlayers) {
      return reply.badRequest(`Game requires at least ${plugin.minPlayers} players`);
    }
    if (participants.length > plugin.maxPlayers) {
      return reply.badRequest(`Game supports at most ${plugin.maxPlayers} players`);
    }

    const result = await plugin.onStart({ participants, config });
    const session = gameSessionStore.start(name, plugin, result.state, participants, result.payloads);

    await broadcastToRoom(name, {
      type: 'game:started',
      gameId,
      participants,
      broadcast: result.broadcast ?? null,
    });

    await Promise.all(
      participants.map((identity) =>
        sendToParticipant(name, identity, {
          type: 'game:state',
          payload: result.payloads[identity] ?? null,
        }),
      ),
    );

    return reply.code(201).send({
      gameId: session.gameId,
      participants: session.participants,
      startedAt: session.startedAt,
    });
  });

  // Submit a game action as a participant.
  fastify.post('/rooms/:name/game/action', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['action'],
        properties: { action: {} },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { action } = request.body as { action: unknown };

    const session = gameSessionStore.get(name);
    if (!session) return reply.notFound('No active game in this room');

    if (!session.participants.includes(request.username)) {
      return reply.forbidden('You are not a participant in this game');
    }

    const result = session.plugin.onAction({
      from: request.username,
      action,
      state: session.state,
      participants: session.participants,
    });

    session.state = result.state;
    if (result.payloads) Object.assign(session.payloads, result.payloads);

    if (result.broadcast !== undefined) {
      await broadcastToRoom(name, { type: 'game:broadcast', payload: result.broadcast });
    }

    if (result.payloads) {
      await Promise.all(
        Object.entries(result.payloads).map(([identity, payload]) =>
          sendToParticipant(name, identity, { type: 'game:state', payload }),
        ),
      );
    }

    if (result.ended) {
      gameSessionStore.end(name);
      await broadcastToRoom(name, { type: 'game:ended' });
    }

    return reply.send({ ended: result.ended ?? false });
  });

  // End the active game (host only).
  fastify.delete('/rooms/:name/game', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can end a game');

    gameSessionStore.end(name);
    await broadcastToRoom(name, { type: 'game:ended' });
    return reply.code(204).send();
  });
};
