import { MongoClient, type Db, type Collection } from 'mongodb';
import { config } from '../config.js';

interface EmbedUser {
  username: string;
  banned: boolean;
  premium: boolean;
  banReason?: string | null;
  bannedAt?: Date | null;
  bannedBy?: string | null;
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

  const user = await col.findOne({ username });
  cache.set(username, { user, expires: Date.now() + CACHE_TTL });
  return user;
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
