import { Client, cryptoUtils, Signature } from '@hiveio/dhive';
import { config } from '../config.js';

const hiveClient = new Client(config.HIVE_API_NODE);

/**
 * Fetch the posting public keys for a Hive account.
 * Returns an array of public key strings (usually just one).
 */
async function getPostingKeys(username: string): Promise<string[]> {
  const [account] = await hiveClient.database.getAccounts([username]);
  if (!account) throw new Error(`Hive account "${username}" not found`);
  return account.posting.key_auths.map(([key]) => key.toString());
}

/**
 * Verify that a message was signed by the posting key of the given Hive account.
 *
 * - Hashes the message with SHA-256
 * - Recovers the public key from the signature
 * - Checks it matches one of the account's on-chain posting keys
 */
export async function verifyHiveSignature(
  username: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const postingKeys = await getPostingKeys(username);

  const messageHash = cryptoUtils.sha256(message);
  const sig = Signature.fromString(signature);
  const recoveredKey = sig.recover(messageHash).toString();

  return postingKeys.includes(recoveredKey);
}

// -- Nonce store for challenge-response auth --

interface NonceEntry {
  username: string;
  expires: number;
}

const nonceStore = new Map<string, NonceEntry>();

// Cleanup expired nonces every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of nonceStore) {
    if (entry.expires < now) nonceStore.delete(key);
  }
}, 60_000);

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createChallenge(username: string): { challenge: string; expires: number } {
  const random = cryptoUtils.sha256(
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
  ).toString('hex').slice(0, 16);

  const timestamp = Date.now();
  const challenge = `hivehangouts:${username}:${timestamp}:${random}`;
  const expires = timestamp + NONCE_TTL_MS;

  nonceStore.set(challenge, { username, expires });

  return { challenge, expires };
}

export function consumeChallenge(challenge: string, username: string): boolean {
  const entry = nonceStore.get(challenge);
  if (!entry) return false;
  if (entry.username !== username) return false;
  if (entry.expires < Date.now()) {
    nonceStore.delete(challenge);
    return false;
  }

  nonceStore.delete(challenge);
  return true;
}
