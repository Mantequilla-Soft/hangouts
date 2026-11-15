/**
 * Kept DVR clips (H13). A clip used to be a throw-away MP4 swept after an hour;
 * now each one is remembered for CLIP_KEEP_HOURS with who made it, so the host
 * can post it as a Short after the stream (the clipper gets a beneficiary
 * share) and the clipper can post it themselves (the host gets one).
 *
 * The record is small (no media in Mongo): the MP4 stays in the DVR clip dir,
 * served by GET /dvr/clips/:file, and the TTL index plus the clip-dir sweep
 * remove both. Without Mongo (dev, tests) an in-memory store does the same job.
 */
import { MongoClient, type Collection } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

export type ClipSource = 'viewer' | 'host' | 'auto';

export interface StreamClip {
  id: string;
  room: string;
  /** The stream's host (null when the room could not be read at clip time). */
  host: string | null;
  /** Who pressed Clip (null for a guest or an automatic highlight clip). */
  clipper: string | null;
  source: ClipSource;
  /** File name in the clip dir; served at /dvr/clips/<file>. */
  file: string;
  /** Seconds since go-live at the clip's END, when known. */
  offsetSec: number | null;
  durationSec: number;
  /** Why an automatic clip was made (the highlight's reasons). */
  reasons?: string[];
  createdAt: Date;
  expiresAt: Date;
}

/** At most this many clips are kept per stream, and per clipper per stream. */
export const MAX_CLIPS_PER_ROOM = 40;
export const MAX_CLIPS_PER_CLIPPER = 8;

export interface ClipStore {
  insert(clip: StreamClip): Promise<void>;
  countForRoom(room: string): Promise<number>;
  countForClipper(room: string, clipper: string): Promise<number>;
  listForRoom(room: string): Promise<StreamClip[]>;
  listForClipper(clipper: string): Promise<StreamClip[]>;
  get(id: string): Promise<StreamClip | null>;
  remove(id: string): Promise<void>;
}

const live = (c: StreamClip, now: number) => c.expiresAt.getTime() > now;
const newestFirst = (a: StreamClip, b: StreamClip) => b.createdAt.getTime() - a.createdAt.getTime();

export function memoryClipStore(): ClipStore {
  const rows = new Map<string, StreamClip>();
  const all = () => [...rows.values()].filter((c) => live(c, Date.now()));
  return {
    async insert(clip) { rows.set(clip.id, clip); },
    async countForRoom(room) { return all().filter((c) => c.room === room).length; },
    async countForClipper(room, clipper) { return all().filter((c) => c.room === room && c.clipper === clipper).length; },
    async listForRoom(room) { return all().filter((c) => c.room === room).sort(newestFirst); },
    async listForClipper(clipper) { return all().filter((c) => c.clipper === clipper).sort(newestFirst).slice(0, 50); },
    async get(id) { const c = rows.get(id); return c && live(c, Date.now()) ? c : null; },
    async remove(id) { rows.delete(id); },
  };
}

function mongoClipStore(c: Collection<StreamClip>): ClipStore {
  const now = () => ({ $gt: new Date() });
  return {
    async insert(clip) { await c.insertOne({ ...clip }); },
    async countForRoom(room) { return c.countDocuments({ room, expiresAt: now() }); },
    async countForClipper(room, clipper) { return c.countDocuments({ room, clipper, expiresAt: now() }); },
    async listForRoom(room) {
      return c.find({ room, expiresAt: now() }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(MAX_CLIPS_PER_ROOM).toArray();
    },
    async listForClipper(clipper) {
      return c.find({ clipper, expiresAt: now() }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
    },
    async get(id) { return c.findOne({ id, expiresAt: now() }, { projection: { _id: 0 } }); },
    async remove(id) { await c.deleteOne({ id }); },
  };
}

let current: ClipStore | null = null;
let connecting: Promise<void> | null = null;
const fallback = memoryClipStore();

export async function clipStore(): Promise<ClipStore> {
  if (current) return current;
  if (!config.MONGODB_URI) return fallback;
  connecting ??= (async () => {
    try {
      const client = new MongoClient(config.MONGODB_URI);
      await client.connect();
      const c = client.db().collection<StreamClip>('stream-clips');
      await c.createIndex({ id: 1 }, { unique: true });
      await c.createIndex({ room: 1, createdAt: -1 });
      await c.createIndex({ clipper: 1, createdAt: -1 });
      await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      current = mongoClipStore(c);
    } catch (err) {
      console.error('[StreamClips] Failed to connect to MongoDB:', err);
    } finally {
      connecting = null;
    }
  })();
  await connecting;
  return current ?? fallback;
}

/** Tests only: swap the store. */
export function setClipStore(store: ClipStore | null): void { current = store; }

export type ClipRefusal = 'room_full' | 'clipper_full';

/**
 * Remember a new clip. Refuses past the per-room / per-clipper caps (the caller
 * then deletes the MP4 it just made). Returns the stored clip.
 */
export async function registerClip(input: {
  room: string; host: string | null; clipper: string | null; source: ClipSource;
  file: string; offsetSec: number | null; durationSec: number; reasons?: string[];
}): Promise<{ clip: StreamClip } | { refused: ClipRefusal }> {
  const store = await clipStore();
  if (await store.countForRoom(input.room) >= MAX_CLIPS_PER_ROOM) return { refused: 'room_full' };
  if (input.clipper && await store.countForClipper(input.room, input.clipper) >= MAX_CLIPS_PER_CLIPPER) {
    return { refused: 'clipper_full' };
  }
  const now = new Date();
  const clip: StreamClip = {
    id: randomBytes(9).toString('hex'),
    room: input.room,
    host: input.host,
    clipper: input.clipper,
    source: input.source,
    file: input.file,
    offsetSec: input.offsetSec,
    durationSec: input.durationSec,
    ...(input.reasons?.length ? { reasons: input.reasons } : {}),
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.CLIP_KEEP_HOURS * 3_600_000),
  };
  await store.insert(clip);
  return { clip };
}

/** The public shape (dates as ISO strings, the file as a path). */
export function clipView(c: StreamClip) {
  return {
    id: c.id,
    room: c.room,
    host: c.host,
    clipper: c.clipper,
    source: c.source,
    path: `/dvr/clips/${c.file}`,
    offsetSec: c.offsetSec,
    durationSec: c.durationSec,
    reasons: c.reasons ?? [],
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
  };
}
