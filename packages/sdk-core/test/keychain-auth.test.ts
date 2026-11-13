import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HangoutsApiClient,
  isKeychainAvailable,
  loginWithAioha,
  loginWithKeychain,
  loginWithSignFn,
} from '../src/index.js';

const SESSION = { token: 'session-jwt', username: 'alice' };

/** A client whose challenge/verify calls are stubbed; everything else is real. */
function makeClient() {
  const client = new HangoutsApiClient({ baseUrl: 'https://api.test' });
  const requestChallenge = vi.spyOn(client, 'requestChallenge').mockResolvedValue({ challenge: 'sign-me' } as never);
  const verifySignature = vi.spyOn(client, 'verifySignature').mockResolvedValue(SESSION as never);
  return { client, requestChallenge, verifySignature };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isKeychainAvailable', () => {
  it('is false outside a browser', () => {
    expect(isKeychainAvailable()).toBe(false);
  });

  it('is false in a browser without the extension', () => {
    vi.stubGlobal('window', {});
    expect(isKeychainAvailable()).toBe(false);
  });

  it('is true when the extension is injected', () => {
    vi.stubGlobal('window', { hive_keychain: { requestSignBuffer: vi.fn() } });
    expect(isKeychainAvailable()).toBe(true);
  });
});

describe('loginWithSignFn', () => {
  it('signs the server challenge, verifies it and stores the session token', async () => {
    const { client, requestChallenge, verifySignature } = makeClient();
    const signFn = vi.fn().mockResolvedValue('sig-123');

    const session = await loginWithSignFn(client, 'alice', signFn);

    expect(requestChallenge).toHaveBeenCalledWith('alice');
    expect(signFn).toHaveBeenCalledWith('sign-me');
    expect(verifySignature).toHaveBeenCalledWith('alice', 'sign-me', 'sig-123');
    expect(session).toEqual(SESSION);
    expect(client.getSessionToken()).toBe('session-jwt');
  });

  it('does not verify or store a token when signing fails', async () => {
    const { client, verifySignature } = makeClient();
    await expect(loginWithSignFn(client, 'alice', () => Promise.reject(new Error('user cancelled')))).rejects.toThrow('user cancelled');
    expect(verifySignature).not.toHaveBeenCalled();
    expect(client.getSessionToken()).toBeNull();
  });

  it('does not store a token when the server rejects the signature', async () => {
    const { client, verifySignature } = makeClient();
    verifySignature.mockRejectedValue(new Error('bad signature'));
    await expect(loginWithSignFn(client, 'alice', async () => 'sig')).rejects.toThrow('bad signature');
    expect(client.getSessionToken()).toBeNull();
  });
});

describe('loginWithKeychain', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
  });

  it('asks Keychain to sign the challenge with the posting key and logs in', async () => {
    const requestSignBuffer = vi.fn((_u, _m, _k, cb) => cb({ success: true, result: 'kc-sig' }));
    vi.stubGlobal('window', { hive_keychain: { requestSignBuffer } });
    const { client, verifySignature } = makeClient();

    const session = await loginWithKeychain(client, 'alice');

    expect(requestSignBuffer).toHaveBeenCalledWith('alice', 'sign-me', 'Posting', expect.any(Function));
    expect(verifySignature).toHaveBeenCalledWith('alice', 'sign-me', 'kc-sig');
    expect(session).toEqual(SESSION);
    expect(client.getSessionToken()).toBe('session-jwt');
  });

  it('fails with a clear message when the extension is not installed', async () => {
    const { client } = makeClient();
    await expect(loginWithKeychain(client, 'alice')).rejects.toThrow('Hive Keychain extension is not installed');
  });

  it('passes on the Keychain error when the user declines', async () => {
    const requestSignBuffer = vi.fn((_u, _m, _k, cb) => cb({ success: false, error: 'user_cancel' }));
    vi.stubGlobal('window', { hive_keychain: { requestSignBuffer } });
    const { client, verifySignature } = makeClient();
    await expect(loginWithKeychain(client, 'alice')).rejects.toThrow('user_cancel');
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it('uses a generic message when Keychain reports success without a signature', async () => {
    const requestSignBuffer = vi.fn((_u, _m, _k, cb) => cb({ success: true }));
    vi.stubGlobal('window', { hive_keychain: { requestSignBuffer } });
    const { client } = makeClient();
    await expect(loginWithKeychain(client, 'alice')).rejects.toThrow('Keychain signing failed');
  });
});

describe('loginWithAioha', () => {
  it('signs with the posting key of the explicitly given user', async () => {
    const { client, requestChallenge, verifySignature } = makeClient();
    const aioha = { signMessage: vi.fn().mockResolvedValue({ success: true, result: 'aioha-sig' }), getCurrentUser: vi.fn(() => 'other') };

    await loginWithAioha(client, aioha, 'alice');

    expect(requestChallenge).toHaveBeenCalledWith('alice');
    expect(aioha.signMessage).toHaveBeenCalledWith('sign-me', 'posting');
    expect(verifySignature).toHaveBeenCalledWith('alice', 'sign-me', 'aioha-sig');
    expect(aioha.getCurrentUser).not.toHaveBeenCalled();
    expect(client.getSessionToken()).toBe('session-jwt');
  });

  it('falls back to the user Aioha is logged in as', async () => {
    const { client, requestChallenge } = makeClient();
    const aioha = { signMessage: vi.fn().mockResolvedValue({ success: true, result: 's' }), getCurrentUser: () => 'bob' };
    await loginWithAioha(client, aioha);
    expect(requestChallenge).toHaveBeenCalledWith('bob');
  });

  it('refuses without asking the server when no username is known', async () => {
    const { client, requestChallenge } = makeClient();
    await expect(loginWithAioha(client, { signMessage: vi.fn() })).rejects.toThrow(/No Hive username available/);
    await expect(loginWithAioha(client, { signMessage: vi.fn(), getCurrentUser: () => null })).rejects.toThrow(/No Hive username/);
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('passes on the Aioha error when signing fails', async () => {
    const { client, verifySignature } = makeClient();
    const aioha = { signMessage: vi.fn().mockResolvedValue({ success: false, error: 'rejected by user' }) };
    await expect(loginWithAioha(client, aioha, 'alice')).rejects.toThrow('rejected by user');
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it('uses a generic message when Aioha reports success without a signature', async () => {
    const { client } = makeClient();
    const aioha = { signMessage: vi.fn().mockResolvedValue({ success: true }) };
    await expect(loginWithAioha(client, aioha, 'alice')).rejects.toThrow('Aioha signMessage failed');
  });
});
