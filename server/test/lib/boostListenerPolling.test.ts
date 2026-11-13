import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utils } from '@hiveio/dhive';

// The listener keeps its watermark and "started" flag in module state, so every
// test re-imports it (vi.resetModules) and drives the 3 s loop with fake timers.
const h = vi.hoisted(() => ({
  config: {
    BOOST_PLATFORM_ACCOUNT: 'boostwallet',
    BOOST_PLATFORM_FEE_PERCENT: 5,
    BOOSTS_ENABLED: true,
  },
  getAccountHistory: vi.fn(),
  listRooms: vi.fn(),
  sendData: vi.fn(),
  sendBoostPayout: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('../../src/lib/hive.js', () => ({
  hiveClient: { database: { getAccountHistory: h.getAccountHistory } },
}));
vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: h.listRooms, sendData: h.sendData },
}));
vi.mock('../../src/lib/boostPricing.js', () => ({
  getHiveUsdRate: vi.fn().mockResolvedValue(0.25),
  hbdUsdRate: vi.fn().mockReturnValue(1),
}));
vi.mock('../../src/lib/boostPayout.js', () => ({ sendBoostPayout: h.sendBoostPayout }));
vi.mock('../../src/lib/streamStats.js', () => ({ recordBoost: vi.fn() }));

type ListenerModule = typeof import('../../src/lib/boostListener.js');
type LedgerModule = typeof import('../../src/lib/boostLedger.js');
let listener: ListenerModule;
let ledger: LedgerModule;

const ROOM = 'alice-room-abc123';
const memo = (nonce: string) => JSON.stringify({ version: 1, room: ROOM, message: 'Hi', sender: 'bob', nonce });

/** One account-history row as returned by condenser get_account_history. */
function row(seq: number, opts: { to?: string; amount?: string; nonce?: string; timestamp?: string; type?: string } = {}) {
  return [
    seq,
    {
      trx_id: `trx-${seq}`,
      block: 1000 + seq,
      timestamp: opts.timestamp ?? '2026-11-13T10:00:00',
      op: [
        opts.type ?? 'transfer',
        {
          from: 'bob',
          to: opts.to ?? 'boostwallet',
          amount: opts.amount ?? '1.000 HBD',
          memo: memo(opts.nonce ?? `nonce-${seq}xx`),
        },
      ],
    },
  ];
}

const processedSeqs = () => ledger.listBoostLedger().map((e) => e.opIndex);

async function start(log = vi.fn()) {
  listener.startBoostListener(log);
  await vi.advanceTimersByTimeAsync(0);
  return log;
}

/** Let the 3 s timer fire and the next poll finish. */
const nextPoll = () => vi.advanceTimersByTimeAsync(3_000);

beforeEach(async () => {
  vi.useFakeTimers();
  h.config.BOOST_PLATFORM_ACCOUNT = 'boostwallet';
  h.config.BOOSTS_ENABLED = true;
  h.getAccountHistory.mockReset().mockResolvedValue([]);
  h.listRooms.mockReset().mockResolvedValue([{ name: ROOM, metadata: JSON.stringify({ host: 'alice' }) }]);
  h.sendData.mockReset().mockResolvedValue(undefined);
  h.sendBoostPayout.mockReset().mockResolvedValue(undefined);
  vi.resetModules();
  listener = await import('../../src/lib/boostListener.js');
  ledger = await import('../../src/lib/boostLedger.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startBoostListener', () => {
  it('does nothing when boosts are disabled', async () => {
    h.config.BOOSTS_ENABLED = false;
    const log = await start();
    await nextPoll();
    expect(h.getAccountHistory).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs that it is enabled and polls the platform wallet transfers every 3 seconds', async () => {
    const log = await start();
    expect(log).toHaveBeenCalledWith('[Boost] listener enabled');
    expect(h.getAccountHistory).toHaveBeenCalledTimes(1);
    const mask = utils.makeBitMaskFilter([utils.operationOrders.transfer]);
    expect(h.getAccountHistory).toHaveBeenCalledWith('boostwallet', -1, 200, mask);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.getAccountHistory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.getAccountHistory).toHaveBeenCalledTimes(2);
    await nextPoll();
    expect(h.getAccountHistory).toHaveBeenCalledTimes(3);
  });

  it('starting twice runs only one loop', async () => {
    const log = await start();
    listener.startBoostListener(log);
    await nextPoll();
    expect(h.getAccountHistory).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.filter(([m]) => m === '[Boost] listener enabled')).toHaveLength(1);
  });

  it('logs a failed poll and tries again 3 seconds later', async () => {
    const err = new Error('RPC node timeout');
    h.getAccountHistory.mockRejectedValueOnce(err);
    const log = await start();
    expect(log).toHaveBeenCalledWith('[Boost] listener poll error', err);
    await nextPoll();
    expect(h.getAccountHistory).toHaveBeenCalledTimes(2);
  });

  it('logs to the console by default, with the detail only when there is one', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = new Error('down');
    h.getAccountHistory.mockRejectedValueOnce(err);
    listener.startBoostListener();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledWith('[Boost] listener enabled');
    expect(spy).toHaveBeenCalledWith('[Boost] listener poll error', err);
    spy.mockRestore();
  });

  it('does not query Hive when no platform account is configured', async () => {
    h.config.BOOST_PLATFORM_ACCOUNT = '  ';
    await start();
    await nextPoll();
    expect(h.getAccountHistory).not.toHaveBeenCalled();
  });
});

describe('platform wallet polling', () => {
  it('the first poll only seeds the watermark: transfers from before startup are not replayed', async () => {
    h.getAccountHistory.mockResolvedValue([row(10), row(11)]);
    await start();
    await nextPoll();
    expect(processedSeqs()).toEqual([]);
    expect(h.listRooms).not.toHaveBeenCalled();
    expect(h.sendBoostPayout).not.toHaveBeenCalled();
  });

  it('processes only transfers newer than the watermark, oldest first, and never twice', async () => {
    h.getAccountHistory.mockResolvedValueOnce([row(10)]);
    await start();

    // returned out of order, with the already-seen row still in the window
    h.getAccountHistory.mockResolvedValueOnce([row(13), row(10), row(12)]);
    await nextPoll();
    expect(processedSeqs()).toEqual([12, 13]);
    expect(h.sendBoostPayout).toHaveBeenCalledTimes(2);
    expect(h.sendBoostPayout.mock.calls[0][0].memo).toBe(`boost payout:${ROOM}:trx-12`);

    h.getAccountHistory.mockResolvedValueOnce([row(12), row(13), row(14)]);
    await nextPoll();
    expect(processedSeqs()).toEqual([12, 13, 14]);
    expect(h.sendBoostPayout).toHaveBeenCalledTimes(3);
  });

  it('an empty history seeds the watermark at 0 so the wallet first ever transfer still counts', async () => {
    await start();
    h.getAccountHistory.mockResolvedValueOnce([row(1)]);
    await nextPoll();
    expect(processedSeqs()).toEqual([1]);
    expect(ledger.listBoostLedger()[0].status).toBe('payout_sent');
  });

  it('skips rows that are not transfers but still moves past them', async () => {
    await start();
    h.getAccountHistory.mockResolvedValueOnce([
      row(1, { type: 'transfer_to_vesting' }),
      [2, { trx_id: 'x', block: 1, timestamp: '2026-11-13T10:00:00' }],
      row(3),
    ]);
    await nextPoll();
    expect(processedSeqs()).toEqual([3]);
  });

  it('outgoing transfers from the wallet (payouts) are passed over without a ledger entry', async () => {
    await start();
    h.getAccountHistory.mockResolvedValueOnce([row(1, { to: 'alice' }), row(2)]);
    await nextPoll();
    expect(processedSeqs()).toEqual([2]);
  });

  it('feeds each transfer with its history seq as opIndex and its block number', async () => {
    await start();
    h.getAccountHistory.mockResolvedValueOnce([row(5)]);
    await nextPoll();
    expect(ledger.listBoostLedger()[0]).toMatchObject({ id: 'trx-5:5', txId: 'trx-5', opIndex: 5 });
    const event = JSON.parse(new TextDecoder().decode(h.sendData.mock.calls[0][1]));
    expect(event.blockNum).toBe(1005);
  });

  it('reads Hive block times without a zone as UTC and keeps an explicit zone', async () => {
    await start();
    h.getAccountHistory.mockResolvedValueOnce([
      row(1, { timestamp: '2026-11-13T10:00:00' }),
      row(2, { timestamp: '2026-11-13T10:00:00Z' }),
      row(3, { timestamp: '2026-11-13T10:00:00+02:00' }),
      row(4, { timestamp: '2026-11-13T10:00:00-05:00' }),
    ]);
    await nextPoll();
    const stamps = h.sendData.mock.calls.map((c) => JSON.parse(new TextDecoder().decode(c[1])).timestamp);
    expect(stamps).toEqual([
      Date.UTC(2026, 10, 13, 10),
      Date.UTC(2026, 10, 13, 10),
      Date.UTC(2026, 10, 13, 8),
      Date.UTC(2026, 10, 13, 15),
    ]);
  });

  it('a rejected boost (unknown room) still advances the watermark', async () => {
    await start();
    h.listRooms.mockResolvedValueOnce([]);
    h.getAccountHistory.mockResolvedValueOnce([row(1)]);
    await nextPoll();
    expect(ledger.listBoostLedger()[0]).toMatchObject({ status: 'rejected', rejectReason: 'room_not_found' });

    h.getAccountHistory.mockResolvedValueOnce([row(1)]);
    await nextPoll();
    expect(ledger.listBoostLedger()).toHaveLength(1);
    expect(ledger.listBoostLedger()[0].rejectReason).toBe('room_not_found');
  });
});
