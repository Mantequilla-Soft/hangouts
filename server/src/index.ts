import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { config } from './config.js';
import { authRoutes } from './routes/auth.js';
import { roomRoutes } from './routes/rooms.js';
import { participantRoutes } from './routes/participants.js';
import { recordingRoutes } from './routes/recording.js';
import { streamingRoutes } from './routes/streaming.js';

const server = Fastify({ logger: true });

await server.register(cors, { origin: true });
await server.register(sensible);
await server.register(authRoutes);
await server.register(roomRoutes);
await server.register(participantRoutes);
await server.register(recordingRoutes);
await server.register(streamingRoutes);

await server.listen({ port: config.PORT, host: '0.0.0.0' });
