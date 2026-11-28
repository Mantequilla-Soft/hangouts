import { pointsStore } from './points.js';
import { ledgerStore, newRow } from './pointsLedger.js';
import { PointsSpendError, existingAccounts, registerSpendCompleter, spendOnChain, tokenLive } from './pointsToken.js';
import { recordSupport } from './pointsShop.js';

/**
 * Send points to another Hive account: a gift from the wallet, or a points tip
 * on a 3Speak post (`post`, `<author>/<permlink>`, always the receiver's).
 *
 *   token on   a Magi `transfer` as the sender, signed by @threespeak under
 *              their posting authority (or by their own wallet after a 428),
 *              through the same spend flow as a burn (spendOnChain). Once Magi
 *              confirms it both Mongo balances follow, with `chain` rows that
 *              are never minted or burned again.
 *   token off  the Mongo balances move at once.
 *
 * Either way both accounts get a `transfer` row: the sender's ref is the
 * receiver (or the tipped post), the receiver's is the sender. Not an earning,
 * so double points never touch it.
 */

export const TRANSFER_MAX = 10_000_000;

export interface TransferInput {
  from: string;
  to: string;
  amount: number;
  /** A points tip: the receiver's post it is for. */
  post?: string;
  /** 3SP: the txid of the transfer the sender's wallet signed after a 428. */
  burnTx?: string;
}

export type TransferResult = { balance: number; to: string; amount: number } | { pending: true; spendId: string };

export async function transferPoints(input: TransferInput): Promise<TransferResult> {
  const from = input.from.toLowerCase();
  const to = input.to.toLowerCase().replace(/^@/, '');
  const amount = Math.floor(input.amount);
  if (!(amount >= 1 && amount <= TRANSFER_MAX)) throw new PointsSpendError(400, 'invalid', 'Send at least 1 point.');
  if (to === from) throw new PointsSpendError(400, 'invalid', 'You cannot send points to yourself.');
  if (input.post && input.post.split('/')[0] !== to) throw new PointsSpendError(400, 'invalid', 'A tip goes to the post\'s author.');
  let found: Set<string>;
  try { found = await existingAccounts([to]); } catch {
    throw new PointsSpendError(503, 'unavailable', 'Points cannot be sent right now. Try again in a minute.');
  }
  if (!found.has(to)) throw new PointsSpendError(400, 'invalid', `There is no Hive account @${to}.`);
  const ref = input.post || to;

  if (await tokenLive()) {
    const res = await spendOnChain(from, amount, { type: 'transfer', room: ref, to }, { burnTx: input.burnTx });
    if (res.state === 'pending') return { pending: true, spendId: res.spend.id };
    return { balance: res.balance, to, amount };
  }

  const left = await pointsStore().spend(from, amount);
  if (left === null) throw new PointsSpendError(400, 'insufficient', 'You do not have that many points.');
  await pointsStore().apply(new Map([[to, amount]]));
  const now = Date.now();
  await ledgerStore().insert([newRow(from, -amount, 'transfer', now, ref), newRow(to, amount, 'transfer', now, from)]).catch(() => undefined);
  await recordSupport(from, to, amount, now);
  return { balance: left, to, amount };
}

// A confirmed Magi transfer (lib/pointsToken.ts moved both balances): it
// counts toward the recipient's supporters like any points spent on them.
registerSpendCompleter('transfer', async (spend) => {
  if (spend.purpose.type === 'transfer') await recordSupport(spend.user, spend.purpose.to, spend.amount);
  return null;
});
