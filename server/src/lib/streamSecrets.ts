import { randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual, hkdfSync } from 'node:crypto';
import { config } from '../config.js';

/**
 * The per-user STREAMING SECRET: what OBS sends as its WHIP "Bearer Token".
 *
 * One secret per user (not per template) — the template is picked by the URL
 * (`/whip/<owner>/<slug>`), the secret only proves it's the owner. Stored two
 * ways, never in plaintext:
 *  - `hash`: HMAC-SHA256 under a server key → constant-time verification on
 *    every WHIP connect without decrypting anything;
 *  - `enc`: AES-256-GCM copy → the owner can reveal it again in the UI (OBS
 *    users lose these all the time, and a reset would break every saved
 *    profile at once).
 * Both keys are derived (HKDF) from STREAM_KEY_SECRET, else SESSION_SECRET, with
 * distinct labels so the hash key and the encryption key are never the same.
 *
 * Pure crypto — no I/O — so it's unit-testable without Mongo.
 */

const SECRET_PREFIX = 'ss_';

function baseKey(): Buffer {
  return Buffer.from(config.STREAM_KEY_SECRET || config.SESSION_SECRET, 'utf8');
}

let hashKey: Buffer | null = null;
let encKey: Buffer | null = null;
function keys(): { hashKey: Buffer; encKey: Buffer } {
  if (!hashKey || !encKey) {
    const salt = Buffer.from('hangouts-stream-secret', 'utf8');
    hashKey = Buffer.from(hkdfSync('sha256', baseKey(), salt, 'hash-v1', 32));
    encKey = Buffer.from(hkdfSync('sha256', baseKey(), salt, 'enc-v1', 32));
  }
  return { hashKey, encKey };
}

/** A fresh streaming secret: `ss_` + 32 random bytes, base64url. */
export function generateStreamSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64url');
}

/** Lookup/verify hash (hex). */
export function hashStreamSecret(secret: string): string {
  return createHmac('sha256', keys().hashKey).update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time check of a presented secret against the stored hash. Hashing
 * the presented value first makes both sides the same length, so
 * timingSafeEqual never throws and leaks nothing about the stored value.
 */
export function verifyStreamSecret(presented: string, storedHash: string): boolean {
  if (typeof presented !== 'string' || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashStreamSecret(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Encrypt for at-rest storage: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encryptStreamSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys().encKey, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Decrypt a stored secret. Throws if it was tampered with or the key changed. */
export function decryptStreamSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported stream secret format');
  const decipher = createDecipheriv('aes-256-gcm', keys().encKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

// ── chat overlay keys ────────────────────────────────────────────────────────

let overlayKeyBytes: Buffer | null = null;
function overlayKey(): Buffer {
  overlayKeyBytes ??= Buffer.from(hkdfSync('sha256', baseKey(), Buffer.from('hangouts-chat-overlay', 'utf8'), 'overlay-v1', 32));
  return overlayKeyBytes;
}

function overlaySignature(username: string): string {
  return createHmac('sha256', overlayKey()).update(username, 'utf8').digest('base64url').slice(0, 22);
}

/**
 * The key in a user's OBS chat overlay URL: `<username>.<signature>`. Bound to
 * the user (one person streams one thing at a time), stable, so OBS keeps one
 * dock across streams, and unguessable, so it can't be used to find unlisted
 * streams.
 */
export function chatOverlayKey(username: string): string {
  return `${username}.${overlaySignature(username)}`;
}

/** The username a chat overlay key was issued for, or null if it isn't valid. */
export function parseChatOverlayKey(key: string): string | null {
  if (typeof key !== 'string') return null;
  // Hive names may contain dots; the signature never does.
  const m = /^([a-z0-9.-]{3,16})\.([A-Za-z0-9_-]{22})$/.exec(key);
  if (!m) return null;
  const a = Buffer.from(m[2], 'utf8');
  const b = Buffer.from(overlaySignature(m[1]), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
}
