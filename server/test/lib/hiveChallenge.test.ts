import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

// The nonce store and its 60 s clean-up interval are created at import, so
// every test re-imports the module under fake timers. The dhive Client is
// stubbed; crypto stays real.
const getAccountsMock = vi.hoisted(() => vi.fn());
vi.mock('@hiveio/dhive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hiveio/dhive')>();
  return { ...actual, Client: class { database = { getAccounts: getAccountsMock }; } };
});

type HiveModule = typeof import('../../src/lib/hive.js');
let hive: HiveModule;

const T0 = Date.parse('2026-11-13T12:00:00Z');
const FIVE_MIN = 5 * 60 * 1000;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  getAccountsMock.mockReset();
  vi.resetModules();
  hive = await import('../../src/lib/hive.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createChallenge', () => {
  it('issues a challenge naming the user and the time, valid for five minutes', () => {
    const { challenge, expires } = hive.createChallenge('alice');

    expect(challenge).toMatch(new RegExp(`^hivehangouts:alice:${T0}:[0-9a-f]{16}$`));
    expect(expires).toBe(T0 + FIVE_MIN);
  });

  it('issues a different challenge every time', () => {
    const a = hive.createChallenge('alice').challenge;
    const b = hive.createChallenge('alice').challenge;

    expect(a).not.toBe(b);
  });
});

describe('consumeChallenge', () => {
  it('accepts an issued challenge exactly once', () => {
    const { challenge } = hive.createChallenge('alice');

    expect(hive.consumeChallenge(challenge, 'alice')).toBe(true);
    expect(hive.consumeChallenge(challenge, 'alice')).toBe(false);
  });

  it('rejects a challenge that was never issued', () => {
    expect(hive.consumeChallenge('hivehangouts:alice:1:feedfacefeedface', 'alice')).toBe(false);
  });

  it('rejects a challenge presented for a different user, without burning it for its owner', () => {
    const { challenge } = hive.createChallenge('alice');

    expect(hive.consumeChallenge(challenge, 'mallory')).toBe(false);
    expect(hive.consumeChallenge(challenge, 'alice')).toBe(true);
  });

  it('still accepts a challenge at the last millisecond of its lifetime', () => {
    const { challenge } = hive.createChallenge('alice');
    vi.setSystemTime(T0 + FIVE_MIN);

    expect(hive.consumeChallenge(challenge, 'alice')).toBe(true);
  });

  it('rejects an expired challenge and forgets it', () => {
    const { challenge } = hive.createChallenge('alice');
    vi.setSystemTime(T0 + FIVE_MIN + 1);
    expect(hive.consumeChallenge(challenge, 'alice')).toBe(false);

    vi.setSystemTime(T0 + 1_000); // even if the clock went back, it is gone
    expect(hive.consumeChallenge(challenge, 'alice')).toBe(false);
  });
});

describe('nonce clean-up interval', () => {
  // The store is private, so these tests move the clock past expiry and back:
  // a challenge that was swept is gone, one that was not still verifies.
  it('sweeps expired challenges once a minute', async () => {
    const { challenge } = hive.createChallenge('alice');
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000); // the 6-minute sweep sees it expired

    vi.setSystemTime(T0 + 1_000);
    expect(hive.consumeChallenge(challenge, 'alice')).toBe(false);
  });

  it('leaves challenges that have not expired yet', async () => {
    const { challenge } = hive.createChallenge('alice');
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000); // four sweeps, none past expiry

    expect(hive.consumeChallenge(challenge, 'alice')).toBe(true);
  });

  it('keeps an expired challenge until the next sweep runs', () => {
    const { challenge } = hive.createChallenge('alice');
    vi.setSystemTime(T0 + 6 * 60 * 1000); // clock moved, no timer fired
    vi.setSystemTime(T0 + 1_000);

    expect(hive.consumeChallenge(challenge, 'alice')).toBe(true);
  });
});

describe('verifyHiveSignature: account lookups', () => {
  const key = PrivateKey.fromSeed('alice-posting');
  const msg = 'hivehangouts:alice:1:abc';
  const sig = key.sign(cryptoUtils.sha256(msg)).toString();
  const account = (keys: string[], accounts: [string, number][] = []) => ({
    posting: { weight_threshold: 1, key_auths: keys.map((k) => [k, 1]), account_auths: accounts },
  });

  it('throws for an account that does not exist on chain', async () => {
    getAccountsMock.mockResolvedValue([]);

    await expect(hive.verifyHiveSignature('ghost', msg, sig)).rejects.toThrow('Hive account "ghost" not found');
  });

  it('does not look up delegates when the account has granted none', async () => {
    getAccountsMock.mockResolvedValue([account(['STM8someOtherKey'])]);

    expect(await hive.verifyHiveSignature('alice', msg, sig)).toBe(false);
    expect(getAccountsMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a Hive node failure while loading delegates', async () => {
    getAccountsMock
      .mockResolvedValueOnce([account(['STM8someOtherKey'], [['threespeak', 1]])])
      .mockRejectedValueOnce(new Error('HTTP 429'));

    await expect(hive.verifyHiveSignature('alice', msg, sig)).rejects.toThrow('HTTP 429');
    expect(getAccountsMock).toHaveBeenLastCalledWith(['threespeak']);
  });
});
