import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './routes/auth.js';
import { roomRoutes } from './routes/rooms.js';
import { participantRoutes } from './routes/participants.js';
import { recordingRoutes } from './routes/recording.js';
import { streamingRoutes } from './routes/streaming.js';

export async function buildApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  await server.register(cors, { origin: true });
  await server.register(sensible);
  await server.register(rateLimit, { global: false });
  await server.register(authRoutes);
  await server.register(roomRoutes);
  await server.register(participantRoutes);
  await server.register(recordingRoutes);
  await server.register(streamingRoutes);

  return server;
}
