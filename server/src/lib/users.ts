import { MongoClient, type Db, type Collection } from 'mongodb';
import { config } from '../config.js';

interface EmbedUser {
  username: string;
  banned: boolean;
  premium: boolean;
  banReason?: string | null;
  bannedAt?: Date | null;
  bannedBy?: string | null;
  /** How the current premium flag was granted: 'subs' (on-chain subscription,
   *  written by the checker's premiumSubsSync worker), 'testing' (the free
   *  trial below), or 'manual'. Unset when the user is not premium. */
  premium_source?: string | null;
  /** When the current premium grant lapses. Null for manual/perpetual grants.
   *  The checker's premiumSubsSync sweep flips `premium` off past this. */
  premium_expires_at?: Date | null;
  /** Sticky for life — set the first time a user claims their free trial and
   *  never cleared, so the trial can only ever be taken once. */
  testing_started?: Date | null;
  premium_synced_at?: Date | null;
}

export interface PremiumStatus {
  username: string;
  premium: boolean;
  premium_source: string | null;
  premium_expires_at: string | null;
  testing_started: string | null;
}

let db: Db | null = null;
let collection: Collection<EmbedUser> | null = null;

// In-memory cache to avoid hitting MongoDB on every request
const cache = new Map<string, { user: EmbedUser | null; expires: number }>();
const CACHE_TTL = 60_000; // 1 minute

async function getCollection(): Promise<Collection<EmbedUser> | null> {
  if (collection) return collection;
  if (!config.MONGODB_URI) return null;

  try {
    const client = new MongoClient(config.MONGODB_URI);
    await client.connect();
    db = client.db();
    collection = db.collection<EmbedUser>('embed-users');
    console.log('[Users] Connected to MongoDB');
    return collection;
  } catch (err) {
    console.error('[Users] Failed to connect to MongoDB:', err);
    return null;
  }
}

async function getUser(username: string): Promise<EmbedUser | null> {
  // Check cache
  const cached = cache.get(username);
  if (cached && cached.expires > Date.now()) {
    return cached.user;
  }

  const col = await getCollection();
  if (!col) return null;

  try {
    const user = await col.findOne({ username });
    cache.set(username, { user, expires: Date.now() + CACHE_TTL });
    return user;
  } catch (err) {
    // Connection dropped — reset so getCollection() reconnects next time
    console.error('[Users] Query failed, resetting connection:', err);
    collection = null;
    db = null;
    return null;
  }
}

export async function isUserBanned(username: string): Promise<boolean> {
  const user = await getUser(username);
  return user?.banned === true;
}

export async function isUserPremium(username: string): Promise<boolean> {
  const user = await getUser(username);
  return user?.premium === true;
}

export async function getUserStatus(username: string): Promise<{ banned: boolean; premium: boolean }> {
  const user = await getUser(username);
  return {
    banned: user?.banned === true,
    premium: user?.premium === true,
  };
}

/** Hive account names are always lowercase; the checker writes them that way,
 *  so every premium read/write normalises before touching Mongo. */
function normalise(username: string): string {
  return username.trim().toLowerCase();
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/**
 * Full premium status for a user — the shape the SDK's premium hook consumes.
 * Mirrors the 3Speak checker's `GET /premium/:username` so the SDK can read it
 * from the hangouts API instead of depending on a 3Speak-specific service.
 */
export async function getPremiumStatus(username: string): Promise<PremiumStatus> {
  const name = normalise(username);
  const user = await getUser(name);
  return {
    username: name,
    premium: user?.premium === true,
    premium_source: user?.premium_source ?? null,
    premium_expires_at: toIso(user?.premium_expires_at),
    testing_started: toIso(user?.testing_started),
  };
}

/** Currently-premium accounts, for the subscriber ticker. */
export async function listPremiumUsers(limit: number): Promise<Array<{ username: string; premium_source: string | null; premium_expires_at: string | null }>> {
  const col = await getCollection();
  if (!col) return [];
  try {
    const docs = await col
      .find({ premium: true }, { projection: { _id: 0, username: 1, premium_source: 1, premium_expires_at: 1 } })
      .sort({ username: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({
      username: d.username,
      premium_source: d.premium_source ?? null,
      premium_expires_at: toIso(d.premium_expires_at),
    }));
  } catch (err) {
    console.error('[Users] Premium list query failed, resetting connection:', err);
    collection = null;
    db = null;
    return [];
  }
}

export type StartTrialResult =
  | { ok: true; expiresAt: string }
  | { ok: false; reason: 'unavailable' | 'already_used' | 'already_premium' };

/**
 * Grant a one-off free premium trial.
 *
 * Writes the same fields the checker's `premiumSubsSync` expiry sweep looks
 * for (`premium_source: 'testing'` + `premium_expires_at`), so the trial is
 * revoked by that worker rather than needing its own timer here.
 * `testing_started` is set once and never cleared, which is what makes the
 * trial one-per-lifetime — the `$exists: false` guard in the filter is the
 * actual race-safe enforcement, not the pre-check.
 */
export async function startPremiumTesting(username: string, durationHours: number): Promise<StartTrialResult> {
  const name = normalise(username);
  const col = await getCollection();
  if (!col) return { ok: false, reason: 'unavailable' };

  // Refuse when the user is already premium. Not just a courtesy: the write
  // below would stamp `premium_source: 'testing'` over a paid subscriber's
  // 'subs' tag, and the checker's demote sweep only reconsiders rows still
  // tagged 'subs' — so until the next promote tick re-tagged them, that
  // subscriber would be a candidate for the 24h trial-expiry sweep instead.
  const existing = await getUser(name);
  if (existing?.premium === true) return { ok: false, reason: 'already_premium' };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

  try {
    // Single atomic upsert-guarded update: `testing_started: { $exists: false }`
    // means a second concurrent claim matches nothing and reports 409 rather
    // than extending the first trial.
    const res = await col.updateOne(
      { username: name, testing_started: { $exists: false } },
      {
        $set: {
          premium: true,
          premium_source: 'testing',
          premium_expires_at: expiresAt,
          testing_started: now,
          premium_synced_at: now,
        },
        $setOnInsert: { username: name, banned: false },
      },
      { upsert: true },
    );

    if (res.matchedCount === 0 && res.upsertedCount === 0) {
      return { ok: false, reason: 'already_used' };
    }

    cache.delete(name);
    return { ok: true, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    // A duplicate-key error means the upsert raced another claim into an
    // existing row that already has `testing_started` — same as already_used.
    if ((err as { code?: number }).code === 11000) return { ok: false, reason: 'already_used' };
    console.error('[Users] startPremiumTesting failed:', err);
    collection = null;
    db = null;
    return { ok: false, reason: 'unavailable' };
  }
}
