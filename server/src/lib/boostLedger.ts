import type { BoostAsset, BoostRejectReason, BoostMemoV1 } from './boostTypes.js';

export type BoostLedgerStatus = 'received' | 'accepted' | 'broadcasted' | 'payout_sent' | 'rejected';

export interface BoostLedgerEntry {
  id: string;
  txId: string;
  opIndex: number;
  room: string;
  sender: string;
  message: string;
  displayName?: string;
  amount: string;
  asset: BoostAsset;
  usdAmount?: number;
  payoutRecipient?: string;
  feeAmount?: string;
  payoutAmount?: string;
  rejectReason?: BoostRejectReason;
  status: BoostLedgerStatus;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ledgerId(txId: string, opIndex: number): string {
  return `${txId}:${opIndex}`;
}

const ledger = new Map<string, BoostLedgerEntry>();

export function boostLedgerId(txId: string, opIndex: number): string {
  return ledgerId(txId, opIndex);
}

export function hasBoostLedgerEntry(txId: string, opIndex: number): boolean {
  return ledger.has(ledgerId(txId, opIndex));
}

export function upsertBoostLedgerReceived(args: {
  txId: string;
  opIndex: number;
  memo: BoostMemoV1;
  amount: string;
  asset: BoostAsset;
}): BoostLedgerEntry {
  const id = ledgerId(args.txId, args.opIndex);
  const existing = ledger.get(id);
  if (existing) return existing;

  const entry: BoostLedgerEntry = {
    id,
    txId: args.txId,
    opIndex: args.opIndex,
    room: args.memo.room,
    sender: args.memo.sender,
    message: args.memo.message,
    displayName: args.memo.displayName,
    amount: args.amount,
    asset: args.asset,
    status: 'received',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  ledger.set(id, entry);
  return entry;
}

export function markBoostAccepted(id: string, args: {
  usdAmount: number;
  payoutRecipient: string;
  feeAmount: string;
  payoutAmount: string;
}): BoostLedgerEntry | null {
  const current = ledger.get(id);
  if (!current) return null;
  const next: BoostLedgerEntry = {
    ...current,
    status: 'accepted',
    usdAmount: args.usdAmount,
    payoutRecipient: args.payoutRecipient,
    feeAmount: args.feeAmount,
    payoutAmount: args.payoutAmount,
    updatedAt: nowIso(),
  };
  ledger.set(id, next);
  return next;
}

export function markBoostBroadcasted(id: string): BoostLedgerEntry | null {
  const current = ledger.get(id);
  if (!current) return null;
  const next: BoostLedgerEntry = {
    ...current,
    status: 'broadcasted',
    updatedAt: nowIso(),
  };
  ledger.set(id, next);
  return next;
}

export function markBoostPayoutSent(id: string): BoostLedgerEntry | null {
  const current = ledger.get(id);
  if (!current) return null;
  const next: BoostLedgerEntry = {
    ...current,
    status: 'payout_sent',
    updatedAt: nowIso(),
  };
  ledger.set(id, next);
  return next;
}

export function markBoostRejected(id: string, rejectReason: BoostRejectReason): BoostLedgerEntry | null {
  const current = ledger.get(id);
  if (!current) return null;
  const next: BoostLedgerEntry = {
    ...current,
    status: 'rejected',
    rejectReason,
    updatedAt: nowIso(),
  };
  ledger.set(id, next);
  return next;
}

export function listBoostLedger(room?: string): BoostLedgerEntry[] {
  const rows = Array.from(ledger.values());
  return room ? rows.filter((row) => row.room === room) : rows;
}
