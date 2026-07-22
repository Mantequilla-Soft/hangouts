import { config } from './config.js';
import { buildApp } from './app.js';
import { startBoostListener } from './lib/boostListener.js';
import { roomService } from './lib/livekit.js';
import { sweepEndedRooms } from './lib/guestBans.js';
import { sweepPublishStates } from './lib/streamVodPublish.js';

const server = await buildApp();
await server.listen({ port: config.PORT, host: '0.0.0.0' });
startBoostListener((msg, detail) => {
  if (detail) server.log.info({ detail }, msg);
  else server.log.info(msg);
});

// Periodic cleanup of in-memory maps that would otherwise grow unbounded:
// guest IP registry (PII) + ban sets for rooms that self-expired, and settled
// VOD-publish states. Every 10 minutes.
setInterval(() => {
  void (async () => {
    try {
      const rooms = await roomService.listRooms();
      sweepEndedRooms(new Set(rooms.map((r) => r.name)));
    } catch (err) {
      server.log.warn({ err }, 'room-data sweep failed');
    }
    sweepPublishStates();
  })();
}, 10 * 60 * 1000).unref();
