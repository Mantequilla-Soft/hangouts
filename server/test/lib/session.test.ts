import { describe, it, expect } from 'vitest';
import { createSessionToken, verifySessionToken } from '../../src/lib/session.js';

describe('createSessionToken', () => {
  it('returns a non-empty string', async () => {
    const token = await createSessionToken('alice');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });
});

describe('verifySessionToken', () => {
  it('roundtrip recovers the username as sub', async () => {
    const token = await createSessionToken('alice');
    const payload = await verifySessionToken(token);
    expect(payload.sub).toBe('alice');
  });

  it('throws on an invalid token string', async () => {
    await expect(verifySessionToken('not-a-token')).rejects.toThrow();
  });

  it('throws on a tampered token', async () => {
    const token = await createSessionToken('alice');
    const parts = token.split('.');
    // Flip a character near the start of the signature — the last character's
    // bottom 2 bits are base64 padding zeros that jose silently ignores, so
    // tampering there can leave the decoded HMAC unchanged.
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await expect(verifySessionToken(parts.join('.'))).rejects.toThrow();
  });
});
