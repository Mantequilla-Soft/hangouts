import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';

/**
 * One shared Mongo connection for the live-interaction stores (chat backlog,
 * polls and points, raid settings), instead of a client per module.
 *
 * Single-flight: a burst of first requests opens one client. Null when no
 * MONGODB_URI is configured or the connect failed; callers then keep their
 * state in memory only, so a missing database never breaks a stream.
 */
let db: Db | null = null;
let connecting: Promise<Db | null> | null = null;

export async function getLiveDb(): Promise<Db | null> {
  if (db) return db;
  if (!config.MONGODB_URI) return null;
  connecting ??= (async () => {
    try {
      const client = new MongoClient(config.MONGODB_URI);
      await client.connect();
      db = client.db();
      return db;
    } catch (err) {
      console.error('[LiveDb] Failed to connect to MongoDB:', err);
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}
