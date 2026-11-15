import { describe, expect, it, vi } from 'vitest';
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
    CHECKER_URL: 'https://checker.test',
    STREAM_STATS_SECRET: '',
  },
}));
vi.mock('../../src/lib/livekit.js', () => ({ roomService: { listRooms: vi.fn(), sendData: vi.fn(), updateRoomMetadata: vi.fn() } }));
vi.mock('../../src/lib/boostPricing.js', () => ({
  getHiveUsdRate: vi.fn().mockResolvedValue(0.25),
  hbdUsdRate: vi.fn().mockReturnValue(1),
}));
vi.mock('../../src/lib/boostPayout.js', () => ({
  sendBoostPayout: vi.fn().mockResolvedValue(undefined),
  sendBoostRefund: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/streamStats.js', () => ({ recordBoost: vi.fn() }));

const ROOM = 'badadib-live-abc123';

/** A LiveKit fake whose metadata writes are read back, like the real one. */
function statefulLk(meta: Record<string, unknown>) {
  const state = { metadata: JSON.stringify({ host: 'badadib', boost: { enabled: true, minBoostUsd: 0 }, ...meta }) };
  return {
    state,
    meta: () => JSON.parse(state.metadata),
    listRooms: vi.fn(async () => [{ name: ROOM, metadata: state.metadata }]),
    updateRoomMetadata: vi.fn(async (_n: string, m: string) => { state.metadata = m; }),
    sendData: vi.fn().mockResolvedValue(undefined),
  };
}

let seq = 0;
function transfer(over: { from?: string; amount?: string; sender?: string; displayName?: string; recipient?: string } = {}) {
  seq += 1;
  return {
    from: over.from ?? 'fan',
    txId: `tx-tally-${seq}`,
    opIndex: seq,
    blockNum: 1,
    timestamp: Date.now(),
    to: 'boostwallet',
    amount: over.amount ?? '2.000 HBD',
    memo: JSON.stringify({
      version: 1, room: ROOM, message: 'go go', sender: over.sender ?? 'fan', nonce: `nonce-${seq}xx`,
      ...(over.displayName ? { displayName: over.displayName } : {}),
      ...(over.recipient ? { recipient: over.recipient } : {}),
    }),
  };
}

const noop = () => {};

describe('processBoostTransfer: the stream tally', () => {
  it('counts HBD at face value and HIVE at its price, towards the goal and the supporters', async () => {
    const lk = statefulLk({ boost: { enabled: true, minBoostUsd: 0, goal: { title: 'mic', targetHbd: 50 } } });
    await processBoostTransfer(transfer({ amount: '2.000 HBD', displayName: 'Fan' }), noop, lk as never);
    await processBoostTransfer(transfer({ amount: '8.000 HIVE' }), noop, lk as never);
    const stats = lk.meta().boostStats;
    expect(stats).toMatchObject({ count: 2, totalHbd: 4, goalHbd: 4 });
    expect(stats.supporters).toEqual([{ account: 'fan', displayName: 'Fan', hbd: 4, count: 2 }]);
    // The goal settings are untouched by the tally.
    expect(lk.meta().boost.goal).toEqual({ title: 'mic', targetHbd: 50 });
  });

  it('credits the account that paid, not the name the memo claims', async () => {
    const lk = statefulLk({});
    await processBoostTransfer(transfer({ from: 'fan', sender: 'badadib', displayName: 'Not me' }), noop, lk as never);
    expect(lk.meta().boostStats.supporters).toEqual([{ account: 'fan', hbd: 2, count: 1 }]);
  });

  it('a boost to the collab guest counts in the totals but not the host goal', async () => {
    const lk = statefulLk({ collabGuest: 'guestone' });
    await processBoostTransfer(transfer({ recipient: 'guestone' }), noop, lk as never);
    expect(lk.meta().boostStats).toMatchObject({ totalHbd: 2, goalHbd: 0 });
  });

  it('stamps the goal as reached by the boost that gets there, and logs it', async () => {
    const lk = statefulLk({ boost: { enabled: true, minBoostUsd: 0, goal: { title: 'mic', targetHbd: 3 } } });
    const log = vi.fn();
    await processBoostTransfer(transfer(), log, lk as never);
    expect(lk.meta().boostStats.goalReachedAt).toBeUndefined();
    await processBoostTransfer(transfer(), log, lk as never);
    expect(lk.meta().boostStats.goalReachedFor).toBe(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reached its boost goal'));
  });

  it('below-minimum boosts are paid, so they count too', async () => {
    const lk = statefulLk({ boost: { enabled: true, minBoostUsd: 5 } });
    await processBoostTransfer(transfer({ amount: '1.000 HBD' }), noop, lk as never);
    expect(lk.meta().boostStats.totalHbd).toBe(1);
  });

  it('refunded boosts never count', async () => {
    const lk = statefulLk({ boost: { enabled: false } });
    await processBoostTransfer(transfer(), noop, lk as never);
    expect(lk.meta().boostStats).toBeUndefined();
  });

  it('a failed tally write is logged and the boost is still paid', async () => {
    const lk = statefulLk({});
    lk.updateRoomMetadata.mockRejectedValueOnce(new Error('livekit down'));
    const log = vi.fn();
    const t = transfer();
    await processBoostTransfer(t, log, lk as never);
    const payout = await import('../../src/lib/boostPayout.js');
    expect(payout.sendBoostPayout).toHaveBeenCalled();
    expect(listBoostLedger().find((e) => e.txId === t.txId)?.status).toBe('payout_sent');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not update the boost tally'), expect.any(Error));
  });
});
