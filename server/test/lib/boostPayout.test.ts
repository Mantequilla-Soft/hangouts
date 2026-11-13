import { beforeEach, describe, expect, it, vi } from 'vitest';

// sendBoostPayout / sendBoostRefund (src/lib/boostPayout.ts): a transfer from the
// platform boost account, signed with its active key. A refund is the same
// transfer back to the sender, for the full amount.
const h = vi.hoisted(() => ({
  config: { BOOST_PLATFORM_ACCOUNT: ' BoostWallet ', BOOST_PLATFORM_ACTIVE_KEY: ' 5KTestKey ' },
  transfer: vi.fn(),
  fromString: vi.fn((k: string) => ({ key: k })),
}));
vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('../../src/lib/hive.js', () => ({ hiveClient: { broadcast: { transfer: h.transfer } } }));
vi.mock('@hiveio/dhive', () => ({ PrivateKey: { fromString: h.fromString } }));

import { sendBoostPayout, sendBoostRefund } from '../../src/lib/boostPayout.js';

describe('boost payouts and refunds', () => {
  beforeEach(() => {
    h.transfer.mockReset().mockResolvedValue({});
    h.fromString.mockClear();
    h.config.BOOST_PLATFORM_ACCOUNT = ' BoostWallet ';
    h.config.BOOST_PLATFORM_ACTIVE_KEY = ' 5KTestKey ';
  });

  it('sends a payout from the platform account, signed with its trimmed active key', async () => {
    await sendBoostPayout({ to: 'alice', amount: '1.900', asset: 'HBD', memo: 'boost payout:r:tx' });
    expect(h.fromString).toHaveBeenCalledWith('5KTestKey');
    expect(h.transfer).toHaveBeenCalledWith(
      { from: 'boostwallet', to: 'alice', amount: '1.900 HBD', memo: 'boost payout:r:tx' },
      { key: '5KTestKey' },
    );
  });

  it('sends a refund as the same kind of transfer, back to the sender', async () => {
    await sendBoostRefund({ to: 'bob', amount: '2.000', asset: 'HIVE', memo: 'boost refund:r:tx: off' });
    expect(h.transfer.mock.calls[0][0]).toEqual({ from: 'boostwallet', to: 'bob', amount: '2.000 HIVE', memo: 'boost refund:r:tx: off' });
  });

  it('refuses to send anything without a configured account or key', async () => {
    h.config.BOOST_PLATFORM_ACTIVE_KEY = '  ';
    await expect(sendBoostRefund({ to: 'bob', amount: '1.000', asset: 'HBD', memo: 'm' })).rejects.toThrow(/not configured/);
    h.config.BOOST_PLATFORM_ACTIVE_KEY = '5K';
    h.config.BOOST_PLATFORM_ACCOUNT = '';
    await expect(sendBoostPayout({ to: 'bob', amount: '1.000', asset: 'HBD', memo: 'm' })).rejects.toThrow(/not configured/);
    expect(h.transfer).not.toHaveBeenCalled();
  });

  it('passes a failed broadcast up to the caller', async () => {
    h.transfer.mockRejectedValueOnce(new Error('rpc down'));
    await expect(sendBoostPayout({ to: 'alice', amount: '1.000', asset: 'HBD', memo: 'm' })).rejects.toThrow('rpc down');
  });
});
