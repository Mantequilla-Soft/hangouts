import { describe, it, expect } from 'vitest';
import {
  generateStreamSecret, hashStreamSecret, verifyStreamSecret,
  encryptStreamSecret, decryptStreamSecret,
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
