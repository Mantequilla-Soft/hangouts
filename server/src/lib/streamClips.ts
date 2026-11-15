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
/** `ready`: the MP4 is there. `pending`: a stream without the Pro DVR; the clip
 *  is cut from the VOD recording when the stream ends (lib/vodClips.ts).
 *  `unavailable`: it could not be cut (see `reason`). Older rows have no status
 *  and are ready. */
export type ClipStatus = 'pending' | 'ready' | 'unavailable';
export type ClipUnavailableReason = 'past_cap' | 'past_end' | 'no_recording' | 'failed';

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
  /** The host's 9:16 phone crop at clip time (room metadata `vertical`, H19):
   *  centre x and width as fractions of the landscape frame. */
  crop?: { x: number; w: number };
  /** The vertical (cropped) copy, made on request (POST /clips/:id/vertical). */
  verticalFile?: string;
  status?: ClipStatus;
  /** Pending clips: where the window starts in the VOD recording, seconds. */
  vodStartSec?: number;
  reason?: ClipUnavailableReason;
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
  listPending(room: string): Promise<StreamClip[]>;
  update(id: string, patch: Partial<Pick<StreamClip, 'status' | 'reason' | 'verticalFile'>>): Promise<void>;
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
    async listPending(room) { return all().filter((c) => c.room === room && c.status === 'pending').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()); },
    async update(id, patch) { const c = rows.get(id); if (c) rows.set(id, { ...c, ...patch }); },
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
    async listPending(room) {
      return c.find({ room, status: 'pending', expiresAt: now() }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).limit(MAX_CLIPS_PER_ROOM).toArray();
    },
    async update(id, patch) { await c.updateOne({ id }, { $set: patch }); },
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
  crop?: { x: number; w: number } | null;
  /** A clip of a stream without DVR: cut later from the VOD at this second. */
  pendingAt?: number;
  unavailable?: ClipUnavailableReason;
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
    ...(input.crop ? { crop: input.crop } : {}),
    ...(input.unavailable
      ? { status: 'unavailable' as const, reason: input.unavailable }
      : input.pendingAt != null ? { status: 'pending' as const, vodStartSec: Math.max(0, Math.round(input.pendingAt * 10) / 10) } : {}),
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.CLIP_KEEP_HOURS * 3_600_000),
  };
  await store.insert(clip);
  return { clip };
}

/** The public shape (dates as ISO strings, the file as a path). */
/** A pending clip older than this never got its recording (a server restart
 *  lost it, the longest stream is 4 h): it is shown as unavailable. */
const PENDING_GIVE_UP_MS = 5 * 3_600_000;

export function clipStatusOf(c: StreamClip, now = Date.now()): { status: ClipStatus; reason?: ClipUnavailableReason } {
  if (c.status === 'pending' && now - c.createdAt.getTime() > PENDING_GIVE_UP_MS) return { status: 'unavailable', reason: 'no_recording' };
  if (c.status === 'unavailable') return { status: 'unavailable', reason: c.reason ?? 'failed' };
  return { status: c.status ?? 'ready' };
}

export function clipView(c: StreamClip) {
  const st = clipStatusOf(c);
  const ready = st.status === 'ready';
  return {
    id: c.id,
    room: c.room,
    host: c.host,
    clipper: c.clipper,
    source: c.source,
    status: st.status,
    ...(st.reason ? { reason: st.reason } : {}),
    // Only a ready clip has a file to fetch.
    path: ready ? `/dvr/clips/${c.file}` : null,
    offsetSec: c.offsetSec,
    durationSec: c.durationSec,
    reasons: c.reasons ?? [],
    // A Shorts-ready 9:16 version: possible when the host had the phone crop
    // on; `path` once it has been made.
    vertical: { available: ready && !!c.crop, path: ready && c.verticalFile ? `/dvr/clips/${c.verticalFile}` : null },
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
  };
}

/**
 * The phone crop from room metadata (`vertical: { on, x, w }`, H19) when it is
 * on and sane, else null. Fractions of the landscape frame width.
 */
export function cropFromMeta(meta: Record<string, unknown> | null | undefined): { x: number; w: number } | null {
  const v = meta?.vertical as { on?: unknown; x?: unknown; w?: unknown } | undefined;
  if (!v || v.on !== true) return null;
  const x = Number(v.x);
  const w = Number(v.w);
  if (!(w >= 0.05 && w <= 1) || !(x - w / 2 >= -0.001 && x + w / 2 <= 1.001)) return null;
  return { x, w };
}
