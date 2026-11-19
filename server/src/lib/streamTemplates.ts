import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';
import { config } from '../config.js';
import type { TemplateFields } from './streamTemplateInput.js';
import {
  generateStreamSecret, hashStreamSecret, verifyStreamSecret,
  encryptStreamSecret, decryptStreamSecret,
} from './streamSecrets.js';

/**
 * Mongo storage for stream templates + the per-user streaming secret.
 * Same lazy-connect / reset-on-error pattern as lib/events.ts.
 *
 *  - `stream-templates`: one doc per template, unique on {owner, slug} — the
 *    slug IS the stream address (`/whip/<owner>/<slug>`), so two templates of
 *    one owner can never share it.
 *  - `stream-secrets`: one doc per owner: HMAC hash (verify) + AES-GCM copy
 *    (reveal). Never the plaintext.
 */

export interface TemplateDoc extends TemplateFields {
  _id: ObjectId;
  owner: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
  lastLiveAt: Date | null;
}

interface SecretDoc {
  owner: string;
  hash: string;
  enc: string;
  createdAt: Date;
  rotatedAt: Date;
  /** The OBS dock's control key: same scheme, reset on its own. */
  dockHash?: string;
  dockEnc?: string;
  dockRotatedAt?: Date;
}

/** Thrown when Mongo isn't configured/reachable — routes answer 503. */
export class StoreUnavailableError extends Error {
  constructor() { super('Template storage unavailable'); }
}

let db: Db | null = null;
let templates: Collection<TemplateDoc> | null = null;
let secrets: Collection<SecretDoc> | null = null;
let connecting: Promise<void> | null = null;

async function cols(): Promise<{ templates: Collection<TemplateDoc>; secrets: Collection<SecretDoc> }> {
  if (templates && secrets) return { templates, secrets };
  if (!config.MONGODB_URI) throw new StoreUnavailableError();
  // Single-flight: a burst of first requests must not open N clients.
  connecting ??= (async () => {
    try {
      const client = new MongoClient(config.MONGODB_URI);
      await client.connect();
      db = client.db();
      const t = db.collection<TemplateDoc>('stream-templates');
      const s = db.collection<SecretDoc>('stream-secrets');
      await t.createIndex({ owner: 1, slug: 1 }, { unique: true });
      await s.createIndex({ owner: 1 }, { unique: true });
      templates = t;
      secrets = s;
      console.log('[StreamTemplates] Connected to MongoDB');
    } catch (err) {
      console.error('[StreamTemplates] Failed to connect to MongoDB:', err);
    } finally {
      connecting = null;
    }
  })();
  await connecting;
  if (!templates || !secrets) throw new StoreUnavailableError();
  return { templates, secrets };
}

function resetConnection(err: unknown, label: string): never {
  console.error(`[StreamTemplates] ${label} failed, resetting connection:`, err);
  templates = null;
  secrets = null;
  db = null;
  throw new StoreUnavailableError();
}

const isDupKey = (err: unknown) => (err as { code?: number })?.code === 11000;

function oid(id: string): ObjectId | null {
  try { return ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null; } catch { return null; }
}

// ── templates ────────────────────────────────────────────────────────────────

export async function listTemplates(owner: string): Promise<TemplateDoc[]> {
  const c = await cols();
  try {
    return await c.templates.find({ owner }).sort({ createdAt: 1 }).limit(100).toArray();
  } catch (err) { return resetConnection(err, 'listTemplates'); }
}

export async function countTemplates(owner: string): Promise<number> {
  const c = await cols();
  try { return await c.templates.countDocuments({ owner }); } catch (err) { return resetConnection(err, 'countTemplates'); }
}

export async function getTemplate(owner: string, id: string): Promise<TemplateDoc | null> {
  const _id = oid(id);
  if (!_id) return null;
  const c = await cols();
  try { return await c.templates.findOne({ _id, owner }); } catch (err) { return resetConnection(err, 'getTemplate'); }
}

/** By id alone — for the boot-time reconcile, which only has the room's metadata. */
export async function getTemplateById(id: string): Promise<TemplateDoc | null> {
  const _id = oid(id);
  if (!_id) return null;
  const c = await cols();
  try { return await c.templates.findOne({ _id }); } catch (err) { return resetConnection(err, 'getTemplateById'); }
}

export async function findTemplateBySlug(owner: string, slug: string): Promise<TemplateDoc | null> {
  const c = await cols();
  try { return await c.templates.findOne({ owner, slug }); } catch (err) { return resetConnection(err, 'findTemplateBySlug'); }
}

export async function insertTemplate(owner: string, fields: TemplateFields, slug: string): Promise<TemplateDoc | 'name_taken'> {
  const c = await cols();
  const now = new Date();
  const doc: TemplateDoc = { ...fields, _id: new ObjectId(), owner, slug, createdAt: now, updatedAt: now, lastLiveAt: null };
  try {
    await c.templates.insertOne(doc);
    return doc;
  } catch (err) {
    // The unique {owner, slug} index is the real guard (the route doesn't
    // pre-check) — so two racing creates of the same name can't both win.
    if (isDupKey(err)) return 'name_taken';
    return resetConnection(err, 'insertTemplate');
  }
}

export async function updateTemplate(
  owner: string, id: string, fields: TemplateFields, slug: string,
): Promise<TemplateDoc | 'name_taken' | null> {
  const _id = oid(id);
  if (!_id) return null;
  const c = await cols();
  try {
    return await c.templates.findOneAndUpdate(
      { _id, owner },
      { $set: { ...fields, slug, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
  } catch (err) {
    if (isDupKey(err)) return 'name_taken';
    return resetConnection(err, 'updateTemplate');
  }
}

export async function deleteTemplate(owner: string, id: string): Promise<boolean> {
  const _id = oid(id);
  if (!_id) return false;
  const c = await cols();
  try {
    const r = await c.templates.deleteOne({ _id, owner });
    return r.deletedCount === 1;
  } catch (err) { return resetConnection(err, 'deleteTemplate'); }
}

/** Best-effort: stamp when a template last went live (shown in the UI). */
export async function setTemplateLastLiveAt(id: string, at: Date): Promise<void> {
  const _id = oid(id);
  if (!_id) return;
  try {
    const c = await cols();
    await c.templates.updateOne({ _id }, { $set: { lastLiveAt: at } });
  } catch (err) {
    console.error('[StreamTemplates] setTemplateLastLiveAt failed:', err);
  }
}

// ── streaming secret ─────────────────────────────────────────────────────────

/** The owner's streaming secret, created on first use. */
export async function getOrCreateStreamSecret(owner: string): Promise<string> {
  const c = await cols();
  let doc: SecretDoc | null;
  try {
    doc = await c.secrets.findOne({ owner });
    if (!doc) {
      const secret = generateStreamSecret();
      const now = new Date();
      // $setOnInsert: if two first requests race, both read back the SAME
      // winning secret rather than one silently overwriting the other.
      await c.secrets.updateOne(
        { owner },
        { $setOnInsert: { owner, hash: hashStreamSecret(secret), enc: encryptStreamSecret(secret), createdAt: now, rotatedAt: now } },
        { upsert: true },
      ).catch((err) => { if (!isDupKey(err)) throw err; });
      doc = await c.secrets.findOne({ owner });
    }
  } catch (err) { return resetConnection(err, 'getOrCreateStreamSecret'); }
  if (!doc) throw new StoreUnavailableError();
  // Outside the try: a decrypt failure (the server key changed) is not a
  // connection problem — it surfaces as a 500 and the owner resets the secret.
  return decryptStreamSecret(doc.enc);
}

/** Replace the owner's secret. The old one stops verifying immediately. */
export async function resetStreamSecret(owner: string): Promise<string> {
  const c = await cols();
  const secret = generateStreamSecret();
  const now = new Date();
  try {
    await c.secrets.updateOne(
      { owner },
      {
        $set: { hash: hashStreamSecret(secret), enc: encryptStreamSecret(secret), rotatedAt: now },
        $setOnInsert: { owner, createdAt: now },
      },
      { upsert: true },
    );
    return secret;
  } catch (err) { return resetConnection(err, 'resetStreamSecret'); }
}

/** Constant-time check of a presented secret for an owner. False if none set. */
export async function checkStreamSecret(owner: string, presented: string): Promise<boolean> {
  const c = await cols();
  let doc: SecretDoc | null;
  try { doc = await c.secrets.findOne({ owner }); } catch (err) { return resetConnection(err, 'checkStreamSecret'); }
  // Still run an HMAC when there's no doc, so "no such owner" and "wrong
  // secret" take the same time.
  return verifyStreamSecret(presented, doc?.hash ?? '0'.repeat(64)) && !!doc;
}

// ── OBS dock control key ─────────────────────────────────────────────────────
// `<owner>.<secret>`: the dock link carries it and trades it for a dock session
// (lib/session.ts) that may run the owner's live controls and nothing else.
// Kept apart from the streaming secret, so a dock link that leaked is reset
// without touching OBS's stream key.

const dockKeyOf = (owner: string, secret: string) => `${owner}.${secret}`;

/** A first secrets doc made for the dock key still needs a (matching) streaming secret. */
function newStreamSecretFields(): { hash: string; enc: string } {
  const secret = generateStreamSecret();
  return { hash: hashStreamSecret(secret), enc: encryptStreamSecret(secret) };
}

/** The owner's dock key, created on first use. */
export async function getOrCreateDockKey(owner: string): Promise<string> {
  const c = await cols();
  let doc: SecretDoc | null;
  try {
    doc = await c.secrets.findOne({ owner });
    if (!doc?.dockEnc) {
      const secret = generateStreamSecret();
      const now = new Date();
      // Only when there is none yet: two first requests read back the same key.
      await c.secrets.updateOne(
        { owner, dockEnc: { $exists: false } },
        {
          $set: { dockHash: hashStreamSecret(secret), dockEnc: encryptStreamSecret(secret), dockRotatedAt: now },
          $setOnInsert: { owner, ...newStreamSecretFields(), createdAt: now, rotatedAt: now },
        },
        { upsert: true },
      ).catch((err) => { if (!isDupKey(err)) throw err; });
      doc = await c.secrets.findOne({ owner });
    }
  } catch (err) { return resetConnection(err, 'getOrCreateDockKey'); }
  if (!doc?.dockEnc) throw new StoreUnavailableError();
  return dockKeyOf(owner, decryptStreamSecret(doc.dockEnc));
}

/** Replace the owner's dock key: old links and their dock sessions stop at once. */
export async function resetDockKey(owner: string): Promise<string> {
  const c = await cols();
  const secret = generateStreamSecret();
  const now = new Date();
  try {
    await c.secrets.updateOne(
      { owner },
      {
        $set: { dockHash: hashStreamSecret(secret), dockEnc: encryptStreamSecret(secret), dockRotatedAt: now },
        $setOnInsert: { owner, ...newStreamSecretFields(), createdAt: now, rotatedAt: now },
      },
      { upsert: true },
    );
    return dockKeyOf(owner, secret);
  } catch (err) { return resetConnection(err, 'resetDockKey'); }
}

/** A presented dock key: its owner and the key's version, or null. Constant time per owner. */
export async function checkDockKey(key: string): Promise<{ owner: string; version: number } | null> {
  const dot = typeof key === 'string' ? key.lastIndexOf('.') : -1;
  if (dot <= 0) return null;
  const owner = key.slice(0, dot).toLowerCase();
  const secret = key.slice(dot + 1);
  const c = await cols();
  let doc: SecretDoc | null;
  try { doc = await c.secrets.findOne({ owner }); } catch (err) { return resetConnection(err, 'checkDockKey'); }
  const ok = verifyStreamSecret(secret, doc?.dockHash ?? '0'.repeat(64));
  return ok && doc?.dockRotatedAt ? { owner, version: doc.dockRotatedAt.getTime() } : null;
}

/** The current dock key's version (its rotation time), or null without one. */
export async function dockKeyVersion(owner: string): Promise<number | null> {
  const c = await cols();
  try {
    const doc = await c.secrets.findOne({ owner }, { projection: { dockRotatedAt: 1 } });
    return doc?.dockRotatedAt ? doc.dockRotatedAt.getTime() : null;
  } catch (err) { return resetConnection(err, 'dockKeyVersion'); }
}
