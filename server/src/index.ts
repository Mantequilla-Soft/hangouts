import { config } from './config.js';
import { buildApp } from './app.js';
import { startBoostListener } from './lib/boostListener.js';
import { roomService } from './lib/livekit.js';
import { sweepEndedRooms } from './lib/guestBans.js';
import { sweepPublishStates } from './lib/streamVodPublish.js';
import { startStreamStatsSampler } from './lib/streamStats.js';
import { reconcileHeadlessRooms } from './lib/headlessStreams.js';
import { sweepBacklogs, flushBacklog } from './lib/chatBacklog.js';
import { sweepPolls } from './lib/polls.js';
import { sweepRaids } from './lib/raids.js';
import { flushPoints, startPointsSampler, sweepPoints } from './lib/points.js';
import { setPointsLogWriter } from './lib/pointsLedger.js';
import { hivePointsLogWriter } from './lib/pointsChain.js';
import { startPointsToken } from './lib/pointsToken.js';
import { sweepShop } from './lib/pointsShop.js';
import { sweepShopRooms } from './lib/shopLive.js';

const server = await buildApp();
await server.listen({ port: config.PORT, host: '0.0.0.0' });
startBoostListener((msg, detail) => {
  if (detail) server.log.info({ detail }, msg);
  else server.log.info(msg);
});
// Poll live standalone streams for peak viewers + end/duration (no LiveKit
// webhook is wired). No-op unless STREAM_STATS_SECRET is set.
startStreamStatsSampler();
// Channel points for watching and streaming, counted once a minute; every
// movement batched into the ledger and logged on Hive (custom_json).
const pointsWriter = hivePointsLogWriter();
setPointsLogWriter(pointsWriter);
if (!pointsWriter) server.log.warn('[Points] no POINTS_LOG_POSTING_KEY: movements are kept in Mongo but not logged on Hive yet');
startPointsSampler();
// 3SP on Magi: the mint queue and the spend follower (off without a contract).
startPointsToken((msg) => server.log.info(msg));

// Points shop: held orders nobody decided on come back, and the spotlight
// auction closes when its week starts. Every minute.
setInterval(() => { void sweepShop().catch((err) => server.log.warn({ err }, 'points shop sweep failed')); }, 60 * 1000).unref();

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
      const names = new Set(rooms.map((r) => r.name));
      sweepEndedRooms(names);
      // Chat backlogs, polls and raid countdowns of rooms that are gone.
      sweepBacklogs(names);
      sweepPolls(names);
      sweepPoints();
      sweepRaids(names);
      await sweepShopRooms(names).catch((err) => server.log.warn({ err }, 'points shop room sweep failed'));
    } catch (err) {
      server.log.warn({ err }, 'room-data sweep failed');
    }
    sweepPublishStates();
    await reconcileHeadlessRooms().catch((err) => server.log.warn({ err }, 'headless reconcile failed'));
  })();
}, 10 * 60 * 1000).unref();

// Write the last few seconds of chat backlog before a clean shutdown.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    // Never hold a shutdown up for long: three seconds, then exit regardless.
    setTimeout(() => process.exit(0), 3000).unref();
    // Pay out the earnings waiting for the next batch (the chain log follows
    // after the restart: the rows wait in Mongo).
    void Promise.allSettled([flushBacklog(), flushPoints(Date.now(), { chain: false })]).finally(() => process.exit(0));
  });
}
