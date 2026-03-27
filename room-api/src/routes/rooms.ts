import type { FastifyPluginAsync } from 'fastify';
import { roomService } from '../livekit.js';

export const roomRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/rooms', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:            { type: 'string', minLength: 1, maxLength: 64 },
          maxParticipants: { type: 'integer', minimum: 2, maximum: 10000 },
          emptyTimeout:    { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { name, maxParticipants = 500, emptyTimeout = 300 } =
      request.body as { name: string; maxParticipants?: number; emptyTimeout?: number };

    const room = await roomService.createRoom({ name, maxParticipants, emptyTimeout });
    return reply.code(201).send(room);
  });

  fastify.get('/rooms', async (_request, reply) => {
    const rooms = await roomService.listRooms();
    return reply.send(rooms.map((r) => ({
      name:            r.name,
      numParticipants: r.numParticipants,
      maxParticipants: r.maxParticipants,
      creationTime:    r.creationTime,
      emptyTimeout:    r.emptyTimeout,
    })));
  });

  fastify.delete('/rooms/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    await roomService.deleteRoom(name);
    return reply.code(204).send();
  });
};
