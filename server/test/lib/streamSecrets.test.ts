import { describe, it, expect } from 'vitest';
import {
  generateStreamSecret, hashStreamSecret, verifyStreamSecret,
  encryptStreamSecret, decryptStreamSecret, chatOverlayKey, parseChatOverlayKey,
} from '../../src/lib/streamSecrets.js';

describe('streaming secret crypto', () => {
  it('generates ss_-prefixed base64url secrets with 32 bytes of entropy', () => {
    const a = generateStreamSecret();
    const b = generateStreamSecret();
    expect(a).toMatch(/^ss_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically and never returns the secret', () => {
    const s = generateStreamSecret();
    expect(hashStreamSecret(s)).toBe(hashStreamSecret(s));
    expect(hashStreamSecret(s)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashStreamSecret(s)).not.toContain(s.slice(3));
  });

  it('verifies the right secret and rejects wrong / empty / malformed input', () => {
    const s = generateStreamSecret();
    const h = hashStreamSecret(s);
    expect(verifyStreamSecret(s, h)).toBe(true);
    expect(verifyStreamSecret(generateStreamSecret(), h)).toBe(false);
    expect(verifyStreamSecret('', h)).toBe(false);
    expect(verifyStreamSecret(s, '')).toBe(false);
    expect(verifyStreamSecret(s, 'abc')).toBe(false);
    expect(verifyStreamSecret(undefined as unknown as string, h)).toBe(false);
  });

  it('round-trips through AES-GCM with a fresh IV each time', () => {
    const s = generateStreamSecret();
    const e1 = encryptStreamSecret(s);
    const e2 = encryptStreamSecret(s);
    expect(e1).not.toBe(e2);
    expect(e1).not.toContain(s);
    expect(e1.startsWith('v1.')).toBe(true);
    expect(decryptStreamSecret(e1)).toBe(s);
    expect(decryptStreamSecret(e2)).toBe(s);
  });

  it('refuses a tampered ciphertext', () => {
    const e = encryptStreamSecret(generateStreamSecret());
    const parts = e.split('.');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 1;
    parts[3] = ct.toString('base64url');
    expect(() => decryptStreamSecret(parts.join('.'))).toThrow();
    expect(() => decryptStreamSecret('v2.a.b.c')).toThrow();
  });
});

describe('chat overlay keys', () => {
  it('are stable per user and round-trip to the username', () => {
    const key = chatOverlayKey('badadib');
    expect(key).toMatch(/^badadib\.[A-Za-z0-9_-]{22}$/);
    expect(chatOverlayKey('badadib')).toBe(key);
    expect(parseChatOverlayKey(key)).toBe('badadib');
    // Hive names may contain dots and dashes.
    expect(parseChatOverlayKey(chatOverlayKey('the.radio-x'))).toBe('the.radio-x');
  });

  it('reject a forged or swapped signature', () => {
    const key = chatOverlayKey('alice');
    const other = chatOverlayKey('bob');
    expect(parseChatOverlayKey(`alice.${other.split('.')[1]}`)).toBeNull();
    const sig = key.split('.')[1];
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(parseChatOverlayKey(`alice.${flipped}`)).toBeNull();
    expect(parseChatOverlayKey('alice')).toBeNull();
    expect(parseChatOverlayKey('')).toBeNull();
  });
});
