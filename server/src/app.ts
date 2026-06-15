import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { mkdir } from 'node:fs/promises';
import { authRoutes } from './routes/auth.js';
import { roomRoutes } from './routes/rooms.js';
import { participantRoutes } from './routes/participants.js';
import { recordingRoutes } from './routes/recording.js';
import { streamingRoutes } from './routes/streaming.js';
import { boostRoutes } from './routes/boosts.js';
import { eventRoutes } from './routes/events.js';
import { gameRoutes } from './routes/games.js';
import './games/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  // Ensure the recording output directory exists — it lives in /tmp which is
  // cleared on reboot, so we recreate it on every server start.
  await mkdir('/tmp/livekit-recordings', { recursive: true });

  const server = Fastify({ logger: true });

  await server.register(cors, { origin: true });
  await server.register(sensible);
  await server.register(rateLimit, { global: false });
  await server.register(authRoutes);
  await server.register(roomRoutes);
  await server.register(participantRoutes);
  await server.register(recordingRoutes);
  await server.register(streamingRoutes);
  await server.register(boostRoutes);
  await server.register(eventRoutes);
  await server.register(gameRoutes);

  return server;
}
