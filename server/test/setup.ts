import { afterEach } from 'vitest';
import { createSessionToken } from '../src/lib/session.js';

afterEach(() => {
  vi.clearAllMocks();
});

/** Creates a real signed JWT for the given Hive username. Use in Authorization headers. */
export async function makeToken(username: string): Promise<string> {
  return createSessionToken(username);
}
