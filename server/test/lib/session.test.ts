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
    // Flip a character in the signature segment
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'a' ? 'b' : 'a');
    await expect(verifySessionToken(parts.join('.'))).rejects.toThrow();
  });
});
