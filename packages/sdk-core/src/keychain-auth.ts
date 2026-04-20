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
