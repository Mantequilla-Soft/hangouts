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
} from './boostTypes.js';
import {
  boostLedgerId,
  hasBoostLedgerEntry,
  markBoostAccepted,
  markBoostBroadcasted,
  markBoostPayoutSent,
  markBoostRejected,
  upsertBoostLedgerReceived,
} from './boostLedger.js';
import { sendBoostPayout } from './boostPayout.js';

interface BoostTransferInput {
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

export async function processBoostTransfer(input: BoostTransferInput, log: (msg: string, detail?: unknown) => void, lk: RoomServiceClient = roomService): Promise<void> {
  const platformAccount = config.BOOST_PLATFORM_ACCOUNT.trim().toLowerCase();
  if (!platformAccount) return;
  if (input.to.trim().toLowerCase() !== platformAccount) {
    return;
  }

  if (hasBoostLedgerEntry(input.txId, input.opIndex)) {
    const id = boostLedgerId(input.txId, input.opIndex);
    await handleRejected(id, 'duplicate_transfer', log);
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

  let meta: Record<string, unknown>;
  try {
    meta = await readRoomMetadata(memo.room, lk);
  } catch (err) {
    await handleRejected(id, 'room_not_found', log, err);
    return;
  }

  const usdAmount = await usdFor(amount.asset, amount.value);
  const minUsd = boostMinUsd(meta);
  if (!boostEnabled(meta)) {
    await handleRejected(id, 'room_not_found', log, 'boosts disabled for room');
    return;
  }

  const recipient = payoutAccount(meta);
  if (!recipient) {
    await handleRejected(id, 'internal_error', log, 'missing payout recipient');
    return;
  }

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
let lastHistorySeq = Number.MAX_SAFE_INTEGER;

async function pollPlatformWallet(log: (msg: string, detail?: unknown) => void): Promise<void> {
  const account = config.BOOST_PLATFORM_ACCOUNT.trim().toLowerCase();
  if (!account) return;

  const opTransfer = (utils.operationOrders as Record<string, number>).transfer;
  const transferMask = utils.makeBitMaskFilter([opTransfer]);

  const rows = await hiveClient.database.getAccountHistory(account, -1, 200, transferMask);
  const ordered = [...rows].sort((a, b) => a[0] - b[0]);
  for (const [seq, applied] of ordered) {
    if (seq <= lastHistorySeq) continue;
    const op = applied as unknown as AccountHistoryTransferOp;
    if (!op?.op || op.op[0] !== 'transfer') continue;
    const payload = op.op[1];
    await processBoostTransfer(
      {
        txId: op.trx_id,
        opIndex: seq,
        blockNum: op.block,
        timestamp: Date.parse(op.timestamp),
        to: payload.to,
        amount: payload.amount,
        memo: payload.memo,
      },
      log,
    );
    lastHistorySeq = seq;
  }
  if (ordered.length > 0 && lastHistorySeq === Number.MAX_SAFE_INTEGER) {
    lastHistorySeq = ordered[ordered.length - 1][0];
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
