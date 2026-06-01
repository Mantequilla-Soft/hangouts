export type BoostAsset = 'HIVE' | 'HBD';

export interface BoostMemoV1 {
  version: 1;
  room: string;
  message: string;
  sender: string;
  nonce: string;
  displayName?: string;
}

export type BoostRejectReason =
  | 'invalid_memo'
  | 'invalid_asset'
  | 'room_not_found'
  | 'below_minimum'
  | 'invalid_destination'
  | 'duplicate_transfer'
  | 'payout_failed'
  | 'internal_error';

export interface BoostEvent {
  type: 'boost';
  id: string;
  room: string;
  sender: string;
  displayName?: string;
  message: string;
  amount: string;
  asset: BoostAsset;
  usdAmount: number;
  feeAmount: string;
  payoutAmount: string;
  recipient: string;
  txId: string;
  blockNum: number;
  timestamp: number;
  /** True when the amount was below the host's minBoostUsd floor.
   *  The host is still paid; clients suppress the overlay but show
   *  it in the history panel with a badge. */
  belowMinimum?: boolean;
}

const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,127}$/;
const USER_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{6,128}$/;
const MAX_MESSAGE_LENGTH = 280;

function asObj(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function parseBoostMemo(rawMemo: string): BoostMemoV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMemo);
  } catch {
    return null;
  }
  const memo = asObj(parsed);
  if (!memo) return null;

  const version = memo.version;
  const roomRaw = memo.room;
  const messageRaw = memo.message;
  const senderRaw = memo.sender;
  const nonceRaw = memo.nonce;
  const displayNameRaw = memo.displayName;

  if (version !== 1 || !isString(roomRaw) || !isString(messageRaw) || !isString(senderRaw) || !isString(nonceRaw)) {
    return null;
  }

  const room = cleanText(roomRaw).toLowerCase();
  const message = cleanText(messageRaw);
  const sender = cleanText(senderRaw).toLowerCase();
  const nonce = cleanText(nonceRaw);
  const displayName = isString(displayNameRaw) ? cleanText(displayNameRaw).slice(0, 64) : undefined;

  if (!ROOM_RE.test(room)) return null;
  if (!USER_RE.test(sender)) return null;
  if (!NONCE_RE.test(nonce)) return null;
  if (!message || message.length > MAX_MESSAGE_LENGTH) return null;

  return {
    version: 1,
    room,
    message,
    sender,
    nonce,
    ...(displayName ? { displayName } : {}),
  };
}

export interface ParsedTransferAmount {
  value: number;
  amount: string;
  asset: BoostAsset;
}

export function parseTransferAmount(rawAmount: string): ParsedTransferAmount | null {
  const match = rawAmount.trim().match(/^(\d+\.\d{3})\s+(HIVE|HBD)$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, amount: match[1], asset: match[2] as BoostAsset };
}

export function splitBoostAmounts(rawAmount: ParsedTransferAmount, feePercent: number): {
  feeAmount: string;
  payoutAmount: string;
} {
  const precision = 1000;
  const scaled = Math.round(rawAmount.value * precision);
  const feeScaled = Math.floor((scaled * feePercent) / 100);
  const payoutScaled = scaled - feeScaled;
  const fmt = (n: number) => (n / precision).toFixed(3);
  return {
    feeAmount: fmt(feeScaled),
    payoutAmount: fmt(payoutScaled),
  };
}
