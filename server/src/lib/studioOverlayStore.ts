import { MongoClient, type Collection } from 'mongodb';
import { config } from '../config.js';
import type { OverlayTemplate } from './studioOverlayInput.js';

/**
 * The studio's text overlay templates, per host (H17), so a host's lower
 * third, ticker, countdown and "be right back" setup follow them to another
 * computer. Collection `studio-overlays`: ONE small document per host
 * (at most MAX_OVERLAY_TEMPLATES templates of a few hundred bytes each),
 * unique on owner. Read when the studio opens, written when the host saves a
 * template: no per-frame or per-stream work.
 *
 * A document nobody has saved for 400 days expires (TTL on updatedAt).
 *
 * Same lazy-connect / reset-on-error pattern as lib/streamTemplates.ts.
 */

export interface OverlayDoc {
  owner: string;
  templates: OverlayTemplate[];
  updatedAt: Date;
}

export const OVERLAY_TTL_SECONDS = 400 * 24 * 3600;

export class OverlayStoreUnavailableError extends Error {
  constructor() { super('Overlay storage unavailable'); }
}

let col: Collection<OverlayDoc> | null = null;
let connecting: Promise<void> | null = null;

async function collection(): Promise<Collection<OverlayDoc>> {
  if (col) return col;
  if (!config.MONGODB_URI) throw new OverlayStoreUnavailableError();
  connecting ??= (async () => {
    try {
      const client = new MongoClient(config.MONGODB_URI);
      await client.connect();
      const c = client.db().collection<OverlayDoc>('studio-overlays');
      await c.createIndex({ owner: 1 }, { unique: true });
      await c.createIndex({ updatedAt: 1 }, { expireAfterSeconds: OVERLAY_TTL_SECONDS });
      col = c;
    } catch (err) {
      console.error('[StudioOverlays] Failed to connect to MongoDB:', err);
    } finally {
      connecting = null;
    }
  })();
  await connecting;
  if (!col) throw new OverlayStoreUnavailableError();
  return col;
}

function reset(err: unknown, label: string): never {
  console.error(`[StudioOverlays] ${label} failed, resetting connection:`, err);
  col = null;
  throw new OverlayStoreUnavailableError();
}

export async function getOverlayTemplates(owner: string): Promise<OverlayTemplate[]> {
  const c = await collection();
  try {
    const doc = await c.findOne({ owner }, { projection: { _id: 0, templates: 1 } });
    return doc?.templates ?? [];
  } catch (err) { return reset(err, 'getOverlayTemplates'); }
}

export async function saveOverlayTemplates(owner: string, templates: OverlayTemplate[]): Promise<void> {
  const c = await collection();
  try {
    await c.updateOne({ owner }, { $set: { owner, templates, updatedAt: new Date() } }, { upsert: true });
  } catch (err) { reset(err, 'saveOverlayTemplates'); }
}
