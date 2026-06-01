import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processBoostTransfer } from '../../src/lib/boostListener.js';
import { listBoostLedger } from '../../src/lib/boostLedger.js';

vi.mock('../../src/config.js', () => ({
  config: {
    BOOST_PLATFORM_ACCOUNT: 'boostwallet',
    BOOST_PLATFORM_FEE_PERCENT: 5,
    BOOST_HIVE_USD_FALLBACK: 0.25,
    BOOST_HIVE_USD_CACHE_MS: 120000,
    BOOSTS_ENABLED: true,
    BOOST_PLATFORM_ACTIVE_KEY: '',
  },
}));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), sendData: vi.fn() },
}));

vi.mock('../../src/lib/boostPricing.js', () => ({
  getHiveUsdRate: vi.fn().mockResolvedValue(0.25),
  hbdUsdRate: vi.fn().mockReturnValue(1),
}));

vi.mock('../../src/lib/boostPayout.js', () => ({
  sendBoostPayout: vi.fn().mockResolvedValue(undefined),
}));

const noop = () => {};

function makeRoomMeta(overrides: Record<string, unknown> = {}) {
  return {
    name: 'alice-room-abc123',
    metadata: JSON.stringify({
      host: 'alice',
      boost: { enabled: true, minBoostUsd: 1, creatorPayoutAccount: 'alice' },
      ...overrides,
    }),
    numParticipants: 0,
    maxParticipants: 500,
  };
}

function makeMockLk(roomMeta = makeRoomMeta()) {
  return {
    listRooms: vi.fn().mockResolvedValue([roomMeta]),
    sendData: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function baseInput(txId: string, overrides: Partial<{
  to: string; amount: string; memo: string;
}> = {}) {
  return {
    txId,
    opIndex: 0,
    blockNum: 100,
    timestamp: Date.now(),
    to: 'boostwallet',
    amount: '2.000 HBD',
    memo: JSON.stringify({
      version: 1,
      room: 'alice-room-abc123',
      message: 'Hello host!',
      sender: 'bob',
      nonce: 'nonce-abc123',
    }),
    ...overrides,
  };
}

describe('processBoostTransfer', () => {
  let payout: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('../../src/lib/boostPayout.js');
    payout = vi.mocked(mod.sendBoostPayout);
  });

  it('silently ignores a transfer destined for a different account', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-ignore-001', { to: 'other-account' }), noop, lk);
    expect(lk.listRooms).not.toHaveBeenCalled();
    expect(payout).not.toHaveBeenCalled();
  });

  it('rejects with invalid_memo when the memo is not valid JSON', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-badmemo-001', { memo: 'not-json' }), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-badmemo-001');
    expect(entry?.status).toBe('rejected');
    expect(entry?.rejectReason).toBe('invalid_memo');
    expect(payout).not.toHaveBeenCalled();
  });

  it('rejects with invalid_asset when the amount format is wrong', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-badamt-001', { amount: '10 HBD' }), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-badamt-001');
    expect(entry?.status).toBe('rejected');
    expect(entry?.rejectReason).toBe('invalid_asset');
    expect(payout).not.toHaveBeenCalled();
  });

  it('rejects with room_not_found when the room does not exist', async () => {
    const lk = { listRooms: vi.fn().mockResolvedValue([]), sendData: vi.fn() } as any;
    await processBoostTransfer(baseInput('tx-noroom-001'), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-noroom-001');
    expect(entry?.status).toBe('rejected');
    expect(entry?.rejectReason).toBe('room_not_found');
    expect(payout).not.toHaveBeenCalled();
  });

  it('below_minimum: still pays the host but does not broadcast to the room', async () => {
    const lk = makeMockLk(makeRoomMeta({
      boost: { enabled: true, minBoostUsd: 100, creatorPayoutAccount: 'alice' },
    }));
    await processBoostTransfer(baseInput('tx-belowmin-001', { amount: '0.100 HBD' }), noop, lk);
    const entry = listBoostLedger().find((e) => e.txId === 'tx-belowmin-001');
    expect(entry?.status).toBe('payout_sent');
    expect(lk.sendData).not.toHaveBeenCalled();
    expect(payout).toHaveBeenCalledOnce();
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice' }));
  });

  it('rejects the second of two identical transfers — payout called only once', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-dup-001'), noop, lk);
    await processBoostTransfer(baseInput('tx-dup-001'), noop, lk);
    expect(payout).toHaveBeenCalledTimes(1);
  });

  it('happy path: broadcasts event, pays out, ledger shows payout_sent', async () => {
    const lk = makeMockLk();
    await processBoostTransfer(baseInput('tx-happy-001'), noop, lk);

    expect(lk.sendData).toHaveBeenCalledOnce();
    expect(payout).toHaveBeenCalledOnce();
    expect(payout).toHaveBeenCalledWith(expect.objectContaining({
      to: 'alice',
      asset: 'HBD',
    }));

    const entry = listBoostLedger().find((e) => e.txId === 'tx-happy-001');
    expect(entry?.status).toBe('payout_sent');
    expect(entry?.payoutRecipient).toBe('alice');
    expect(entry?.feeAmount).toBe('0.100');
    expect(entry?.payoutAmount).toBe('1.900');
  });
});
