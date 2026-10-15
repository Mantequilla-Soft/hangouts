import { config } from './config.js';
import { buildApp } from './app.js';
import { startBoostListener } from './lib/boostListener.js';
import { roomService } from './lib/livekit.js';
import { sweepEndedRooms } from './lib/guestBans.js';
import { sweepPublishStates } from './lib/streamVodPublish.js';
import { startStreamStatsSampler } from './lib/streamStats.js';
import { reconcileHeadlessRooms } from './lib/headlessStreams.js';

const server = await buildApp();
await server.listen({ port: config.PORT, host: '0.0.0.0' });
startBoostListener((msg, detail) => {
  if (detail) server.log.info({ detail }, msg);
  else server.log.info(msg);
});
// Poll live standalone streams for peak viewers + end/duration (no LiveKit
// webhook is wired). No-op unless STREAM_STATS_SECRET is set.
startStreamStatsSampler();

// Headless (OBS) streams live in an in-memory session map, which a restart
// loses. Re-adopt any that are still publishing and tear down the rest — now,
// and again on the 10-minute sweep below as a backstop for half-finished
// teardowns.
void reconcileHeadlessRooms();

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
    await reconcileHeadlessRooms().catch((err) => server.log.warn({ err }, 'headless reconcile failed'));
  })();
}, 10 * 60 * 1000).unref();
