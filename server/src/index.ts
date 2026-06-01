import { config } from './config.js';
import { buildApp } from './app.js';
import { startBoostListener } from './lib/boostListener.js';

const server = await buildApp();
await server.listen({ port: config.PORT, host: '0.0.0.0' });
startBoostListener((msg, detail) => {
  if (detail) server.log.info({ detail }, msg);
  else server.log.info(msg);
});
