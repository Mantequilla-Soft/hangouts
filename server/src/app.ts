import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { mkdir } from 'node:fs/promises';
import { authRoutes } from './routes/auth.js';
import { roomRoutes } from './routes/rooms.js';
import { participantRoutes } from './routes/participants.js';
import { recordingRoutes } from './routes/recording.js';
import { streamingRoutes } from './routes/streaming.js';
import { dvrRoutes } from './routes/dvr.js';
import { hlsRoutes } from './routes/hls.js';
import { boostRoutes } from './routes/boosts.js';
import { eventRoutes } from './routes/events.js';
import { gameRoutes } from './routes/games.js';
import { premiumRoutes } from './routes/premium.js';
import { templateRoutes } from './routes/templates.js';
import { whipRoutes } from './routes/whip.js';
import { highlightRoutes } from './routes/highlights.js';
import { dvrRewindRoutes } from './routes/dvrRewind.js';
import { podcastRoutes } from './routes/podcast.js';
import { chatRoutes } from './routes/chat.js';
import { pollRoutes } from './routes/polls.js';
import { pointsTokenRoutes } from './routes/pointsToken.js';
import { promotePointsRoutes } from './routes/promotePoints.js';
import { raidRoutes } from './routes/raids.js';
import { battleRoutes } from './routes/battles.js';
import { captionRoutes } from './routes/captions.js';
import { studioToolRoutes } from './routes/studioTools.js';
import { seedWordCollections } from './lib/seed-word-collections.js';
import './games/index.js';

export interface BuildAppOptions {
  /** Called for every route as it is registered (scripts/list-routes.ts uses it). */
  onRoute?: (route: RouteOptions) => void;
  /** Fastify logger; on by default. */
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  await mkdir('/tmp/livekit-recordings', { recursive: true });
  await seedWordCollections();

  // trustProxy: this service runs behind nginx on loopback (proxy_pass
  // http://127.0.0.1:3002, which sets X-Forwarded-For). Without this, every
  // request.ip is 127.0.0.1 — which silently breaks guest IP bans (banning one
  // guest bans ALL of them via 127.0.0.1) and collapses per-IP rate limits into
  // a single global bucket. Trusting only the loopback proxy means XFF spoofed
  // by a real client is ignored (nginx appends the true peer to the right).
  const server = Fastify({ logger: opts.logger ?? true, trustProxy: '127.0.0.1' });
  if (opts.onRoute) server.addHook('onRoute', opts.onRoute);

  await server.register(cors, { origin: true });
  await server.register(sensible);
  await server.register(rateLimit, { global: false });
  await server.register(authRoutes);
  await server.register(roomRoutes);
  await server.register(participantRoutes);
  await server.register(recordingRoutes);
  await server.register(streamingRoutes);
  await server.register(dvrRoutes);
  await server.register(hlsRoutes);
  await server.register(boostRoutes);
  await server.register(eventRoutes);
  await server.register(gameRoutes);
  await server.register(premiumRoutes);
  await server.register(templateRoutes);
  await server.register(whipRoutes);
  // Highlight clips (H13), rewind (H14), record as podcast (H23).
  await server.register(highlightRoutes);
  await server.register(dvrRewindRoutes);
  await server.register(podcastRoutes);
  // Live interaction: chat backlog, polls and predictions, raids.
  await server.register(chatRoutes);
  await server.register(pollRoutes);
  await server.register(pointsTokenRoutes);
  await server.register(promotePointsRoutes);
  await server.register(raidRoutes);
  await server.register(battleRoutes);
  await server.register(captionRoutes);
  await server.register(studioToolRoutes);

  return server;
}
