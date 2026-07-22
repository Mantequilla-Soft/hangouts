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
import { ingressRoutes } from './routes/ingress.js';
import { boostRoutes } from './routes/boosts.js';
import { eventRoutes } from './routes/events.js';
import { gameRoutes } from './routes/games.js';
import { seedWordCollections } from './lib/seed-word-collections.js';
import './games/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  await mkdir('/tmp/livekit-recordings', { recursive: true });
  await seedWordCollections();

  // trustProxy: this service runs behind nginx on loopback (proxy_pass
  // http://127.0.0.1:3002, which sets X-Forwarded-For). Without this, every
  // request.ip is 127.0.0.1 — which silently breaks guest IP bans (banning one
  // guest bans ALL of them via 127.0.0.1) and collapses per-IP rate limits into
  // a single global bucket. Trusting only the loopback proxy means XFF spoofed
  // by a real client is ignored (nginx appends the true peer to the right).
  const server = Fastify({ logger: true, trustProxy: '127.0.0.1' });

  await server.register(cors, { origin: true });
  await server.register(sensible);
  await server.register(rateLimit, { global: false });
  await server.register(authRoutes);
  await server.register(roomRoutes);
  await server.register(participantRoutes);
  await server.register(recordingRoutes);
  await server.register(streamingRoutes);
  await server.register(ingressRoutes);
  await server.register(boostRoutes);
  await server.register(eventRoutes);
  await server.register(gameRoutes);

  return server;
}
