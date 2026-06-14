import { Client, cryptoUtils, Signature } from '@hiveio/dhive';
import type { ExtendedAccount } from '@hiveio/dhive';
import { config } from '../config.js';

export const hiveClient = new Client(config.HIVE_API_NODE);

/** Fetch a Hive account, throwing if it doesn't exist. */
async function getAccount(username: string): Promise<ExtendedAccount> {
  const [account] = await hiveClient.database.getAccounts([username]);
  if (!account) throw new Error(`Hive account "${username}" not found`);
  return account;
}

/** True when `key` is one of the account's on-chain posting key_auths. */
function hasPostingKey(account: ExtendedAccount, key: string): boolean {
  return account.posting.key_auths.some(([k]) => k.toString() === key);
}

/**
 * Verify that `message` was signed by an authority allowed to act with the
 * posting permission of `username`. Two cases are accepted:
 *
 *  1. **Direct** — the signer is one of the account's own posting `key_auths`.
 *  2. **Delegated** — the signer is the posting key of another account that
 *     `username` has granted posting authority to via `posting.account_auths`
 *     (e.g. a signature produced by @threespeak on the user's behalf).
 *
 * Case 2 is what lets HiveSigner / ManteAuth users — who cannot sign a
 * challenge client-side — authenticate: their delegated service account signs
 * the challenge for them, exactly as it already broadcasts posting ops for them.
 *
 * Matching is done by recovering the public key from sha256(message) and
 * comparing it to the candidate posting keys.
 */
export async function verifyHiveSignature(
  username: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const account = await getAccount(username);

  const messageHash = cryptoUtils.sha256(message);
  let recoveredKey: string;
  try {
    recoveredKey = Signature.fromString(signature).recover(messageHash).toString();
  } catch {
    return false; // malformed signature
  }

  // 1. Direct: signed by one of the account's own posting keys.
  if (hasPostingKey(account, recoveredKey)) return true;

  // 2. Delegated: signed by an account this user granted posting authority to.
  return verifyDelegatedPostingSignature(account, recoveredKey);
}

/**
 * True when `recoveredKey` belongs to an account that `account` has delegated
 * sufficient posting authority to.
 *
 * We only ever receive a single signature for a challenge, so that one signer
 * must on its own meet the account's posting `weight_threshold` — hence we only
 * consider delegates whose granted weight clears the threshold. We check each
 * delegate's own posting `key_auths`; service accounts (e.g. @threespeak) sign
 * with their own key, and Hive caps authority nesting in practice, so we
 * deliberately do not recurse into a delegate's own delegates.
 */
async function verifyDelegatedPostingSignature(
  account: ExtendedAccount,
  recoveredKey: string,
): Promise<boolean> {
  const threshold = account.posting.weight_threshold;
  const delegateNames = account.posting.account_auths
    .filter(([, weight]) => weight >= threshold)
    .map(([name]) => name);

  if (delegateNames.length === 0) return false;

  const delegates = await hiveClient.database.getAccounts(delegateNames);
  return delegates.some((delegate) => hasPostingKey(delegate, recoveredKey));
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
