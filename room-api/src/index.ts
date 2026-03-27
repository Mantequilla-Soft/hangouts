import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { config } from './config.js';
import { roomRoutes } from './routes/rooms.js';
import { tokenRoutes } from './routes/tokens.js';
import { participantRoutes } from './routes/participants.js';

const server = Fastify({ logger: true });

await server.register(sensible);
await server.register(roomRoutes);
await server.register(tokenRoutes);
await server.register(participantRoutes);

await server.listen({ port: config.PORT, host: '0.0.0.0' });
