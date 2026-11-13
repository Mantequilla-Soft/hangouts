import { DataPacket_Kind } from '@livekit/protocol';
import { utils } from '@hiveio/dhive';
import type { RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config.js';
import { roomService } from './livekit.js';
import { hiveClient } from './hive.js';
import { getHiveUsdRate, hbdUsdRate } from './boostPricing.js';
import {
  parseBoostMemo,
  parseTransferAmount,
  splitBoostAmounts,
  type BoostEvent,
  type BoostRejectReason,
  type BoostAsset,
} from './boostTypes.js';
import {
  boostLedgerId,
  hasBoostLedgerEntry,
  markBoostAccepted,
  markBoostBroadcasted,
  markBoostPayoutSent,
  markBoostRejected,
  markBoostRefunded,
  upsertBoostLedgerReceived,
} from './boostLedger.js';
import { sendBoostPayout, sendBoostRefund } from './boostPayout.js';
import { recordBoost } from './streamStats.js';

interface BoostTransferInput {
  /** The account that sent the transfer: where a refund goes. Taken from the
   *  operation itself, never from the memo (which the sender's client writes). */
  from?: string;
  txId: string;
  opIndex: number;
  blockNum: number;
  timestamp: number;
  to: string;
  amount: string;
  memo: string;
}

interface AccountHistoryTransferOp {
  trx_id: string;
  block: number;
  timestamp: string;
  op: [
    'transfer',
    {
      from: string;
      to: string;
      amount: string;
      memo: string;
    },
  ];
}

async function usdFor(asset: 'HIVE' | 'HBD', amount: number): Promise<number> {
  const rate = asset === 'HIVE' ? await getHiveUsdRate() : hbdUsdRate();
  return Number((amount * rate).toFixed(6));
}

function normalizeBoostReject(reason: BoostRejectReason, detail?: unknown): BoostRejectReason {
  if (detail instanceof Error && /room not found/i.test(detail.message)) return 'room_not_found';
  return reason;
}

async function readRoomMetadata(
  roomName: string,
  lk: RoomServiceClient,
): Promise<Record<string, unknown>> {
  const rooms = await lk.listRooms([roomName]);
  if (rooms.length === 0) throw new Error('room not found');
  try {
    return JSON.parse(rooms[0].metadata || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function boostMinUsd(meta: Record<string, unknown>): number {
  const boost = meta.boost;
  if (!boost || typeof boost !== 'object' || Array.isArray(boost)) return 0;
  const value = Number((boost as Record<string, unknown>).minBoostUsd ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function boostEnabled(meta: Record<string, unknown>): boolean {
  const boost = meta.boost;
  if (!boost || typeof boost !== 'object' || Array.isArray(boost)) return true;
  const enabled = (boost as Record<string, unknown>).enabled;
  return enabled !== false;
}

function payoutAccount(meta: Record<string, unknown>): string | null {
  const boost = meta.boost;
  if (boost && typeof boost === 'object' && !Array.isArray(boost)) {
    const fromBoost = (boost as Record<string, unknown>).creatorPayoutAccount;
    if (typeof fromBoost === 'string' && fromBoost.trim()) return fromBoost.trim().toLowerCase();
  }
  const host = meta.host;
  if (typeof host === 'string' && host.trim()) return host.trim().toLowerCase();
  return null;
}

async function publishBoost(roomName: string, event: BoostEvent, lk: RoomServiceClient): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(event));
  await lk.sendData(roomName, payload, DataPacket_Kind.RELIABLE, { topic: 'boost' });
}

async function handleRejected(id: string, reason: BoostRejectReason, log: (msg: string, detail?: unknown) => void, detail?: unknown) {
  markBoostRejected(id, normalizeBoostReject(reason, detail));
  log(`[Boost] rejected ${id}: ${reason}`, detail);
}

/**
 * A boost nobody can be paid for: send the full amount back to the account that
 * sent it, and record it as refunded. Without a known sender (or if it was the
 * platform account itself) it is only rejected, as before. A failed refund is
 * logged and left as `refund_failed` for a hand payout.
 */
async function refundBoost(
  id: string,
  reason: BoostRejectReason,
  input: BoostTransferInput,
  amount: { amount: string; asset: BoostAsset },
  room: string,
  log: (msg: string, detail?: unknown) => void,
  detail?: unknown,
): Promise<void> {
  const sender = input.from?.trim().toLowerCase();
  const platform = config.BOOST_PLATFORM_ACCOUNT.trim().toLowerCase();
  if (!sender || sender === platform) {
    await handleRejected(id, reason, log, detail);
    return;
  }
  const why = reason === 'boosts_disabled' ? 'Boosts are switched off for this stream' : 'the stream could not receive it';
  try {
    await sendBoostRefund({
      to: sender,
      amount: amount.amount,
      asset: amount.asset,
      memo: `boost refund:${room}:${input.txId}: ${why}`,
    });
    markBoostRefunded(id, reason);
    log(`[Boost] refunded ${id} to @${sender}: ${reason}`, detail);
  } catch (err) {
    markBoostRejected(id, 'refund_failed');
    log(`[Boost] REFUND FAILED ${id} (${amount.amount} ${amount.asset} to @${sender}, ${reason}), pay it back by hand`, err);
  }
}

export async function processBoostTransfer(input: BoostTransferInput, log: (msg: string, detail?: unknown) => void, lk: RoomServiceClient = roomService): Promise<void> {
  const platformAccount = config.BOOST_PLATFORM_ACCOUNT.trim().toLowerCase();
  if (!platformAccount) return;
  if (input.to.trim().toLowerCase() !== platformAccount) {
    return;
  }

  // Already processed (same txId + opIndex): ignore the replay. It must not
  // touch the ledger: marking "the" entry rejected would flip the ORIGINAL,
  // already broadcast and paid boost to rejected in the host's history.
  if (hasBoostLedgerEntry(input.txId, input.opIndex)) {
    log(`[Boost] ignored a duplicate of ${boostLedgerId(input.txId, input.opIndex)}`);
    return;
  }

  const memo = parseBoostMemo(input.memo);
  const amount = parseTransferAmount(input.amount);
  if (!memo || !amount) {
    const id = boostLedgerId(input.txId, input.opIndex);
    upsertBoostLedgerReceived({
      txId: input.txId,
      opIndex: input.opIndex,
      memo: memo ?? { version: 1, room: 'unknown-room', message: 'invalid', sender: 'unknown', nonce: 'unknown' },
      amount: amount?.amount ?? '0.000',
      asset: amount?.asset ?? 'HBD',
    });
    await handleRejected(id, memo ? 'invalid_asset' : 'invalid_memo', log);
    return;
  }

  const received = upsertBoostLedgerReceived({
    txId: input.txId,
    opIndex: input.opIndex,
    memo,
    amount: amount.amount,
    asset: amount.asset,
  });
  const id = received.id;

  // Nobody to pay (stream gone, Boosts switched off, no payout account): the
  // sender gets the money back rather than it sitting in the platform wallet.
  let meta: Record<string, unknown>;
  try {
    meta = await readRoomMetadata(memo.room, lk);
  } catch (err) {
    await refundBoost(id, 'room_not_found', input, amount, memo.room, log, err);
    return;
  }

  if (!boostEnabled(meta)) {
    await refundBoost(id, 'boosts_disabled', input, amount, memo.room, log);
    return;
  }

  const usdAmount = await usdFor(amount.asset, amount.value);
  const minUsd = boostMinUsd(meta);

  const hostAccount = payoutAccount(meta);
  if (!hostAccount) {
    await refundBoost(id, 'internal_error', input, amount, memo.room, log, 'missing payout recipient');
    return;
  }

  // A stream with a collab guest on air has TWO people the sender could be
  // boosting, so the memo may name one. Validate it here rather than trusting
  // it: the memo is written by the sender's client and nothing stops someone
  // hand-crafting a transfer that names an unrelated account. Only the host and
  // the room's current collab guest are payable; anything else falls back to
  // the host rather than being rejected, so a stale pick still pays someone
  // real instead of eating the sender's money.
  const collabGuest = typeof meta.collabGuest === 'string'
    ? meta.collabGuest.trim().toLowerCase()
    : null;
  const requested = memo.recipient;
  const recipient = requested && (requested === hostAccount || requested === collabGuest)
    ? requested
    : hostAccount;

  const { feeAmount, payoutAmount } = splitBoostAmounts(amount, config.BOOST_PLATFORM_FEE_PERCENT);
  // Below-minimum boosts are flagged but still broadcast so the host's
  // history panel can show them. The client overlay filters belowMinimum events.
  const belowMinimum = minUsd > 0 && usdAmount < minUsd;

  markBoostAccepted(id, {
    usdAmount,
    payoutRecipient: recipient,
    feeAmount,
    payoutAmount,
  });

  const event: BoostEvent = {
    type: 'boost',
    id,
    room: memo.room,
    sender: memo.sender,
    displayName: memo.displayName,
    message: memo.message,
    amount: amount.amount,
    asset: amount.asset,
    usdAmount,
    feeAmount,
    payoutAmount,
    recipient,
    txId: input.txId,
    blockNum: input.blockNum,
    timestamp: input.timestamp,
    ...(belowMinimum ? { belowMinimum: true } : {}),
  };

  try {
    await publishBoost(memo.room, event, lk);
    markBoostBroadcasted(id);
    // Leaderboard: log the boost against its stream (sender + recipient + amount).
    recordBoost(event.room, event.recipient, event.sender, event.usdAmount, event.message);
  } catch (err) {
    await handleRejected(id, 'internal_error', log, err);
    return;
  }

  try {
    await sendBoostPayout({
      to: recipient,
      amount: payoutAmount,
      asset: amount.asset,
      memo: `boost payout:${memo.room}:${input.txId}`,
    });
    markBoostPayoutSent(id);
  } catch (err) {
    await handleRejected(id, 'payout_failed', log, err);
  }
}

let started = false;
/**
 * Have we established where "already happened" ends?
 *
 * A separate flag rather than a sentinel value of lastHistorySeq. It used to be
 * seeded to MAX_SAFE_INTEGER and only replaced when the first poll returned
 * rows — so a platform account with NO transfer history never got seeded, the
 * watermark stayed at MAX, and `seq <= lastHistorySeq` then silently skipped
 * every transfer forever. A brand new boost wallet could therefore never
 * receive its first boost: nothing logged, nothing in the ledger, the money
 * simply vanished from the sender's point of view.
 */
let seeded = false;
let lastHistorySeq = 0;

async function pollPlatformWallet(log: (msg: string, detail?: unknown) => void): Promise<void> {
  const account = config.BOOST_PLATFORM_ACCOUNT.trim().toLowerCase();
  if (!account) return;

  const opTransfer = (utils.operationOrders as Record<string, number>).transfer;
  // makeBitMaskFilter returns the [low, high] bitmask tuple getAccountHistory
  // expects, but its declared return type is too loose (any[]) — assert it.
  const transferMask = utils.makeBitMaskFilter([opTransfer]) as [number, number];

  const rows = await hiveClient.database.getAccountHistory(account, -1, 200, transferMask);
  const ordered = [...rows].sort((a, b) => a[0] - b[0]);

  // First poll only establishes the watermark — transfers that predate startup
  // are history, not boosts to replay. An empty history seeds to 0, so the very
  // first transfer the account ever receives still counts.
  if (!seeded) {
    seeded = true;
    lastHistorySeq = ordered.length > 0 ? ordered[ordered.length - 1][0] : 0;
    return;
  }

  for (const [seq, applied] of ordered) {
    if (seq <= lastHistorySeq) continue;
    const op = applied as unknown as AccountHistoryTransferOp;
    if (!op?.op || op.op[0] !== 'transfer') continue;
    const payload = op.op[1];
    await processBoostTransfer(
      {
        from: payload.from,
        txId: op.trx_id,
        opIndex: seq,
        blockNum: op.block,
        // Hive returns block times WITHOUT a timezone, and Date.parse reads a
        // bare ISO date-time as LOCAL. This box is UTC so it happens to be
        // right, but moving the server to any other zone would silently shift
        // every boost's timestamp by the offset.
        timestamp: Date.parse(/[Z+]|-\d\d:\d\d$/.test(op.timestamp) ? op.timestamp : `${op.timestamp}Z`),
        to: payload.to,
        amount: payload.amount,
        memo: payload.memo,
      },
      log,
    );
    lastHistorySeq = seq;
  }
}

export function startBoostListener(log: (msg: string, detail?: unknown) => void = (msg, detail) => {
  if (detail) console.log(msg, detail);
  else console.log(msg);
}): void {
  if (started || !config.BOOSTS_ENABLED) return;
  started = true;
  const run = async () => {
    try {
      await pollPlatformWallet(log);
    } catch (err) {
      log('[Boost] listener poll error', err);
    } finally {
      setTimeout(run, 3_000);
    }
  };
  void run();
  log('[Boost] listener enabled');
}
