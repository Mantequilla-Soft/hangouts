import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { hiveClient } from './hive.js';
import type { BoostAsset } from './boostTypes.js';

function amountWithAsset(amount: string, asset: BoostAsset): string {
  return `${amount} ${asset}`;
}

export async function sendBoostPayout(args: {
  to: string;
  amount: string;
  asset: BoostAsset;
  memo: string;
}): Promise<void> {
  const from = config.BOOST_PLATFORM_ACCOUNT.trim().toLowerCase();
  const activeKey = config.BOOST_PLATFORM_ACTIVE_KEY.trim();
  if (!from || !activeKey) {
    throw new Error('Boost payout key/account are not configured');
  }

  const key = PrivateKey.fromString(activeKey);
  await hiveClient.broadcast.transfer(
    {
      from,
      to: args.to,
      amount: amountWithAsset(args.amount, args.asset),
      memo: args.memo,
    },
    key,
  );
}
