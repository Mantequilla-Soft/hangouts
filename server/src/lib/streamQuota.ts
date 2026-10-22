import { MongoClient, type Collection } from 'mongodb';
import { config } from '../config.js';

/**
 * How many streams a FREE host may start per rolling 24 hours (owner,
 * 2026-10-21). Pro hosts are not limited.
 *
 * A stream counts once it actually goes live (studio Start, or an OBS session
 * receiving media), once per room: a reload, a resume or a pause/resume in the
 * same room is the same stream. Creating a room and never going live costs
 * nothing.
 */
export const FREE_STREAMS_PER_DAY = 1;

/**
 * How long a FREE host's stream may run, and so its published recording: the
 * same 30 minutes the studio caps a free stream at (sdk-react
 * lib/streamLimits.ts). Pro streams run up to 4 hours.
 */
export const FREE_STREAM_CAP_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface GoLiveDoc {
  owner: string;
  roomName: string;
  at: Date;
  /** TTL: the record only matters for a day; kept two to be safe. */
  expiresAt: Date;
}

let col: Collection<GoLiveDoc> | null = null;
let connecting: Promise<void> | null = null;

async function goLives(): Promise<Collection<GoLiveDoc> | null> {
  if (col) return col;
  if (!config.MONGODB_URI) return null;
  // Single-flight: a burst of first requests must not open N clients.
  connecting ??= (async () => {
    try {
      const client = new MongoClient(config.MONGODB_URI);
      await client.connect();
      const c = client.db().collection<GoLiveDoc>('stream-golive');
      await c.createIndex({ owner: 1, roomName: 1 }, { unique: true });
      await c.createIndex({ owner: 1, at: -1 });
      await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      col = c;
    } catch (err) {
      console.error('[StreamQuota] Failed to connect to MongoDB:', err);
    } finally {
      connecting = null;
    }
  })();
  await connecting;
  return col;
}

/** This host's stream in this room went live. Idempotent per room. */
export async function recordGoLive(owner: string, roomName: string): Promise<void> {
  try {
    const c = await goLives();
    if (!c) return;
    const now = new Date();
    await c.updateOne(
      { owner, roomName },
      { $setOnInsert: { owner, roomName, at: now, expiresAt: new Date(now.getTime() + 2 * DAY_MS) } },
      { upsert: true },
    );
  } catch (err) {
    console.error('[StreamQuota] recordGoLive failed:', err);
  }
}

/**
 * When a FREE host may next start a stream, or null if they may now. `room` is
 * a stream already in progress (a reload or resume of it), which never counts
 * against itself.
 *
 * Fails OPEN: a quota store that cannot answer must not stop everyone streaming.
 */
export async function nextFreeStreamAt(owner: string, room?: string): Promise<Date | null> {
  try {
    const c = await goLives();
    if (!c) return null;
    const since = new Date(Date.now() - DAY_MS);
    const docs = await c
      .find({ owner, at: { $gte: since }, ...(room ? { roomName: { $ne: room } } : {}) })
      .sort({ at: 1 })
      .toArray();
    if (docs.length < FREE_STREAMS_PER_DAY) return null;
    // Free again once enough of today's streams have aged out of the window.
    return new Date(docs[docs.length - FREE_STREAMS_PER_DAY].at.getTime() + DAY_MS);
  } catch (err) {
    console.error('[StreamQuota] nextFreeStreamAt failed:', err);
    return null;
  }
}

/** The refusal every surface sends, so the studio, OBS and API say the same thing. */
export function dailyLimitBody(retryAt: Date): { error: 'daily_stream_limit'; message: string; retryAt: string } {
  return {
    error: 'daily_stream_limit',
    message: `Free accounts can start ${FREE_STREAMS_PER_DAY === 1 ? 'one stream' : `${FREE_STREAMS_PER_DAY} streams`} per day. `
      + `You can go live again at ${retryAt.toISOString().slice(11, 16)} UTC, or upgrade to 3Speak Pro to stream without a daily limit.`,
    retryAt: retryAt.toISOString(),
  };
}
