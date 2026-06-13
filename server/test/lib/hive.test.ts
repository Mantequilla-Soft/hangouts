import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

// Use real dhive crypto (key derivation, signing, recovery) but stub the
// network-backed Client so we can supply on-chain account authorities inline.
const getAccountsMock = vi.fn();
vi.mock('@hiveio/dhive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hiveio/dhive')>();
  return {
    ...actual,
    Client: class {
      database = { getAccounts: getAccountsMock };
    },
  };
});

const { verifyHiveSignature } = await import('../../src/lib/hive.js');

// Deterministic key pairs.
const userKey = PrivateKey.fromSeed('user-posting');
const delegateKey = PrivateKey.fromSeed('threespeak-posting');
const strangerKey = PrivateKey.fromSeed('stranger-posting');
const userPub = userKey.createPublic().toString();
const delegatePub = delegateKey.createPublic().toString();

const MESSAGE = 'hivehangouts:alice:1700000000000:deadbeef';

/** Keychain-style signBuffer: sign sha256(message). */
function sign(key: PrivateKey, message: string): string {
  return key.sign(cryptoUtils.sha256(message)).toString();
}

function posting(opts: {
  keys?: [string, number][];
  accounts?: [string, number][];
  threshold?: number;
}) {
  return {
    posting: {
      weight_threshold: opts.threshold ?? 1,
      account_auths: opts.accounts ?? [],
      key_auths: opts.keys ?? [],
    },
  };
}

/** Resolve getAccounts([...names]) against an inline account map. */
function mockChain(map: Record<string, unknown>) {
  getAccountsMock.mockImplementation((names: string[]) =>
    Promise.resolve(names.map((n) => map[n]).filter(Boolean)),
  );
}

beforeEach(() => {
  getAccountsMock.mockReset();
});

describe('verifyHiveSignature', () => {
  it('accepts a signature from the account’s own posting key', async () => {
    mockChain({ alice: posting({ keys: [[userPub, 1]] }) });
    expect(await verifyHiveSignature('alice', MESSAGE, sign(userKey, MESSAGE))).toBe(true);
  });

  it('accepts a delegated signature from a granted posting authority (@threespeak)', async () => {
    mockChain({
      alice: posting({ keys: [[userPub, 1]], accounts: [['threespeak', 1]] }),
      threespeak: posting({ keys: [[delegatePub, 1]] }),
    });
    expect(await verifyHiveSignature('alice', MESSAGE, sign(delegateKey, MESSAGE))).toBe(true);
  });

  it('rejects a delegated signature when the user has NOT granted that account', async () => {
    mockChain({
      alice: posting({ keys: [[userPub, 1]] }), // no account_auths
      threespeak: posting({ keys: [[delegatePub, 1]] }),
    });
    expect(await verifyHiveSignature('alice', MESSAGE, sign(delegateKey, MESSAGE))).toBe(false);
  });

  it('rejects a signature from an unrelated key', async () => {
    mockChain({
      alice: posting({ keys: [[userPub, 1]], accounts: [['threespeak', 1]] }),
      threespeak: posting({ keys: [[delegatePub, 1]] }),
    });
    expect(await verifyHiveSignature('alice', MESSAGE, sign(strangerKey, MESSAGE))).toBe(false);
  });

  it('rejects a delegate whose granted weight is below the threshold', async () => {
    mockChain({
      alice: posting({ keys: [[userPub, 1]], accounts: [['threespeak', 1]], threshold: 2 }),
      threespeak: posting({ keys: [[delegatePub, 1]] }),
    });
    expect(await verifyHiveSignature('alice', MESSAGE, sign(delegateKey, MESSAGE))).toBe(false);
  });

  it('rejects a malformed signature without throwing', async () => {
    mockChain({ alice: posting({ keys: [[userPub, 1]] }) });
    expect(await verifyHiveSignature('alice', MESSAGE, 'not-a-signature')).toBe(false);
  });
});
