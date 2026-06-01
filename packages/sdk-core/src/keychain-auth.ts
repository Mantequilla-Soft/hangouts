import type { HangoutsApiClient } from './api-client.js';
import type { AuthSession } from './types.js';

interface KeychainResponse {
  success: boolean;
  result?: string;
  error?: string;
  publicKey?: string;
}

interface HiveKeychain {
  requestSignBuffer(
    username: string,
    message: string,
    keyType: string,
    callback: (response: KeychainResponse) => void,
    rpc?: string,
    title?: string,
  ): void;
}

function getKeychain(): HiveKeychain | undefined {
  return (window as unknown as Record<string, unknown>).hive_keychain as HiveKeychain | undefined;
}

export function isKeychainAvailable(): boolean {
  return typeof window !== 'undefined' && !!getKeychain();
}

function signWithKeychain(username: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const keychain = getKeychain();
    if (!keychain) {
      reject(new Error('Hive Keychain extension is not installed'));
      return;
    }

    keychain.requestSignBuffer(
      username,
      message,
      'Posting',
      (response) => {
        if (response.success && response.result) {
          resolve(response.result);
        } else {
          reject(new Error(response.error || 'Keychain signing failed'));
        }
      },
    );
  });
}

export async function loginWithKeychain(
  apiClient: HangoutsApiClient,
  username: string,
): Promise<AuthSession> {
  const { challenge } = await apiClient.requestChallenge(username);
  const signature = await signWithKeychain(username, challenge);
  const session = await apiClient.verifySignature(username, challenge, signature);
  apiClient.setSessionToken(session.token);
  return session;
}

export async function loginWithSignFn(
  apiClient: HangoutsApiClient,
  username: string,
  signFn: (message: string) => Promise<string>,
): Promise<AuthSession> {
  const { challenge } = await apiClient.requestChallenge(username);
  const signature = await signFn(challenge);
  const session = await apiClient.verifySignature(username, challenge, signature);
  apiClient.setSessionToken(session.token);
  return session;
}

/**
 * Minimal subset of `@aioha/aioha`'s `Aioha` interface that we actually need.
 * We deliberately don't import the real type so the SDK doesn't need
 * `@aioha/aioha` as a hard dependency — consumers who already have an Aioha
 * instance can pass it directly, anyone else can wrap whatever signing flow
 * they prefer in `loginWithSignFn` instead.
 */
export interface AiohaLike {
  /** Sign a message with the currently-logged-in user's posting key. */
  signMessage(
    message: string,
    keyType: string,
  ): Promise<{ success: boolean; result?: string; error?: string }>;
  /** Optional — return the username Aioha is currently authenticated as. */
  getCurrentUser?(): string | undefined | null;
  /** Optional — true when the user has an active Aioha session. */
  isLoggedIn?(): boolean;
  /** Optional — broadcast a Hive transfer with the active key. */
  transfer?(
    to: string,
    amount: number,
    currency: string,
    memo: string,
  ): Promise<{ success: boolean; result?: unknown; error?: string }>;
}

/**
 * Sign in to the hangouts server using a logged-in Aioha session.
 *
 * The consumer is responsible for completing Aioha's own login flow first
 * (e.g. by mounting `@aioha/react-ui`'s modal). This helper just:
 *   1. Resolves the username (passed in or via `aioha.getCurrentUser()`)
 *   2. Asks the server for a challenge
 *   3. Has Aioha sign it with the posting key (any registered provider —
 *      Keychain, HiveAuth, PeakVault, MetaMask Snap, Ledger, etc.)
 *   4. Posts the signature back for verification
 *
 * HiveSigner is intentionally not coupled here — it's just one of the
 * providers a consumer may or may not register on their Aioha instance,
 * and we don't drive that registration from inside the SDK.
 */
export async function loginWithAioha(
  apiClient: HangoutsApiClient,
  aioha: AiohaLike,
  username?: string,
): Promise<AuthSession> {
  const resolvedUsername = username ?? aioha.getCurrentUser?.() ?? null;
  if (!resolvedUsername) {
    throw new Error(
      'No Hive username available — pass one explicitly or log in via Aioha first.',
    );
  }
  return loginWithSignFn(apiClient, resolvedUsername, async (message) => {
    const res = await aioha.signMessage(message, 'posting');
    if (!res.success || !res.result) {
      throw new Error(res.error || 'Aioha signMessage failed');
    }
    return res.result;
  });
}
