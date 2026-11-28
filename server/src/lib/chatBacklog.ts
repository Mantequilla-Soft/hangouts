import type { Collection } from 'mongodb';
import { getLiveDb } from './mongoDb.js';

/**
 * The last few hundred chat lines of each live room, so a viewer who reloads or
 * joins late sees the conversation instead of an empty chat.
 *
 * Chat itself still travels peer to peer over the LiveKit data channel; the
 * sender also posts each line here (POST /rooms/:name/chat), fire and forget.
 * The server keeps a bounded ring per room in memory. A small Mongo copy with a
 * one-day TTL lets the ring survive a server restart mid-stream: lines are
 * written in batches every few seconds (never one write per message), and read
 * back only when a room's ring is not in memory yet.
 *
 * Moderation applies to the backlog too: a deleted line and every line of a
 * banned chatter are taken out of the ring and the Mongo copy.
 */

export interface BacklogSystem {
  /** raid: a host raiding in. The rest are points shop lines (lib/shopLive.ts):
   *  a highlighted message, a channel reward redeemed, a bounty put up or paid. */
  kind: 'raid' | 'highlight' | 'reward' | 'bounty' | 'bountydone';
  /** The raiding host, or the viewer who paid. */
  from: string;
  viewers?: number;
  /** highlight: pinned on top until then (ms). */
  until?: number;
  /** reward / bounty: its name. */
  title?: string;
  /** bounty: the points on it. */
  points?: number;
}

export interface BacklogMessage {
  id: string;
  identity: string;
  name: string;
  text: string;
  timestamp: number;
  /** A line written by the server, not a viewer (a raid arriving). */
  system?: BacklogSystem;
}

export const CHAT_BACKLOG_MAX = Math.max(20, Math.min(1000, Number(process.env.CHAT_BACKLOG_SIZE ?? 300) || 300));
export const CHAT_TEXT_MAX = 500;
export const CHAT_NAME_MAX = 64;
const TTL_MS = 24 * 60 * 60 * 1000;
const FLUSH_MS = 5000;

/** What the backlog persists through. Swappable for tests. */
export interface BacklogStore {
  insert(room: string, messages: BacklogMessage[]): Promise<void>;
  remove(room: string, ids: string[]): Promise<void>;
  removeIdentity(room: string, identity: string): Promise<void>;
  load(room: string, limit: number): Promise<BacklogMessage[]>;
}

interface BacklogDoc extends BacklogMessage {
  room: string;
  expiresAt: Date;
}

let backlogCol: Collection<BacklogDoc> | null = null;
let indexed = false;

async function collection(): Promise<Collection<BacklogDoc> | null> {
  if (backlogCol) return backlogCol;
  const db = await getLiveDb();
  if (!db) return null;
  const c = db.collection<BacklogDoc>('chat-backlog');
  if (!indexed) {
    indexed = true;
    await c.createIndex({ room: 1, timestamp: -1 }).catch(() => { indexed = false; });
    await c.createIndex({ room: 1, id: 1 }, { unique: true }).catch(() => undefined);
    await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
  }
  backlogCol = c;
  return c;
}

export const mongoBacklogStore: BacklogStore = {
  async insert(room, messages) {
    const c = await collection();
    if (!c || messages.length === 0) return;
    const expiresAt = new Date(Date.now() + TTL_MS);
    // ordered:false so one duplicate id (a retried flush) does not drop the rest.
    await c.insertMany(messages.map((m) => ({ ...m, room, expiresAt })), { ordered: false })
      .catch((err: { code?: number; writeErrors?: unknown }) => {
        if (err?.code !== 11000 && !err?.writeErrors) throw err;
      });
  },
  async remove(room, ids) {
    const c = await collection();
    if (!c || ids.length === 0) return;
    await c.deleteMany({ room, id: { $in: ids } });
  },
  async removeIdentity(room, identity) {
    const c = await collection();
    if (!c) return;
    await c.deleteMany({ room, identity });
  },
  async load(room, limit) {
    const c = await collection();
    if (!c) return [];
    const docs = await c.find({ room }, { projection: { _id: 0, room: 0, expiresAt: 0 } })
      .sort({ timestamp: -1 }).limit(limit).toArray();
    return (docs as BacklogMessage[]).reverse();
  },
};

let store: BacklogStore | null = mongoBacklogStore;

/** Tests swap the store; null keeps the backlog in memory only. */
export function setBacklogStore(next: BacklogStore | null): void {
  store = next;
}

interface Ring {
  messages: BacklogMessage[];
  /** Resolves once the Mongo copy has been read into the ring (or failed). */
  loading?: Promise<void>;
  loaded: boolean;
}

const rings = new Map<string, Ring>();
const pendingInserts = new Map<string, BacklogMessage[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ring(room: string): Ring {
  let r = rings.get(room);
  if (!r) {
    r = { messages: [], loaded: false };
    rings.set(room, r);
  }
  return r;
}

function trim(r: Ring): void {
  if (r.messages.length > CHAT_BACKLOG_MAX) r.messages.splice(0, r.messages.length - CHAT_BACKLOG_MAX);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushBacklog(); }, FLUSH_MS);
  flushTimer.unref?.();
}

/** Write the lines posted since the last flush, one batch per room. */
export async function flushBacklog(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batches = [...pendingInserts.entries()];
  pendingInserts.clear();
  if (!store) return;
  for (const [room, messages] of batches) {
    if (messages.length === 0) continue;
    try { await store.insert(room, messages); }
    catch (err) { console.warn('[ChatBacklog] flush failed:', err instanceof Error ? err.message : err); }
  }
}

/** Read the persisted copy into a ring that is not in memory yet (after a restart). */
async function ensureLoaded(room: string): Promise<Ring> {
  const r = ring(room);
  if (r.loaded) return r;
  r.loading ??= (async () => {
    try {
      const saved = store ? await store.load(room, CHAT_BACKLOG_MAX) : [];
      if (saved.length) {
        const have = new Set(r.messages.map((m) => m.id));
        r.messages = [...saved.filter((m) => !have.has(m.id)), ...r.messages]
          .sort((a, b) => a.timestamp - b.timestamp);
        trim(r);
      }
    } catch (err) {
      console.warn('[ChatBacklog] load failed:', err instanceof Error ? err.message : err);
    } finally {
      r.loaded = true;
      r.loading = undefined;
    }
  })();
  await r.loading;
  return r;
}

/** Clamp a client timestamp to "about now", so a wrong clock cannot reorder the log. */
export function clampTimestamp(ts: unknown, now = Date.now()): number {
  const n = typeof ts === 'number' && Number.isFinite(ts) ? Math.round(ts) : now;
  return Math.min(now + 5000, Math.max(now - 60_000, n));
}

/** Add one line. Duplicates (same id) are ignored. Returns false for a duplicate. */
export function addBacklogMessage(room: string, msg: BacklogMessage): boolean {
  const r = ring(room);
  if (r.messages.some((m) => m.id === msg.id)) return false;
  const clean: BacklogMessage = {
    id: String(msg.id).slice(0, 160),
    identity: String(msg.identity).slice(0, 80),
    name: String(msg.name || msg.identity).slice(0, CHAT_NAME_MAX),
    text: String(msg.text).slice(0, CHAT_TEXT_MAX),
    timestamp: msg.timestamp,
    ...(msg.system ? { system: msg.system } : {}),
  };
  // Usually the newest; insert in order if a slow client posts late.
  const at = r.messages.findIndex((m) => m.timestamp > clean.timestamp);
  if (at === -1) r.messages.push(clean); else r.messages.splice(at, 0, clean);
  trim(r);
  const pending = pendingInserts.get(room) ?? [];
  pending.push(clean);
  pendingInserts.set(room, pending);
  scheduleFlush();
  return true;
}

/** The newest `limit` lines, oldest first. */
export async function getBacklog(room: string, limit = CHAT_BACKLOG_MAX): Promise<BacklogMessage[]> {
  const r = await ensureLoaded(room);
  const n = Math.max(1, Math.min(CHAT_BACKLOG_MAX, Math.floor(limit) || CHAT_BACKLOG_MAX));
  return r.messages.slice(-n);
}

/** Take one line out (a moderator deleted it). True when it was in the ring. */
export async function removeBacklogMessage(room: string, id: string): Promise<boolean> {
  const r = ring(room);
  const before = r.messages.length;
  r.messages = r.messages.filter((m) => m.id !== id);
  const pending = pendingInserts.get(room);
  if (pending) pendingInserts.set(room, pending.filter((m) => m.id !== id));
  try { await store?.remove(room, [id]); } catch { /* the TTL takes it later */ }
  return r.messages.length !== before;
}

/** Take every line of one chatter out (they were banned). Returns how many. */
export async function purgeBacklogIdentity(room: string, identity: string): Promise<number> {
  const r = ring(room);
  const before = r.messages.length;
  r.messages = r.messages.filter((m) => m.identity !== identity);
  const pending = pendingInserts.get(room);
  if (pending) pendingInserts.set(room, pending.filter((m) => m.identity !== identity));
  try { await store?.removeIdentity(room, identity); } catch { /* the TTL takes it later */ }
  return before - r.messages.length;
}

/** Forget rings of rooms that no longer exist (the Mongo copy expires by TTL). */
export function sweepBacklogs(activeRooms: Set<string>): void {
  for (const room of rings.keys()) if (!activeRooms.has(room)) rings.delete(room);
}

/** Test helper: drop all in-memory state. */
export function resetBacklogs(): void {
  rings.clear();
  pendingInserts.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}
