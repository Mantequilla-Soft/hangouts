import { config } from './config.js';
import { buildApp } from './app.js';

const server = await buildApp();
await server.listen({ port: config.PORT, host: '0.0.0.0' });
