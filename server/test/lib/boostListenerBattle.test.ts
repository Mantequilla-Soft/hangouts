import { describe, expect, it, vi } from 'vitest';
import { processBoostTransfer } from '../../src/lib/boostListener.js';
import { readBattle, startBattle, type Battle } from '../../src/lib/battles.js';

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

const A = 'badadib-aaa';
const B = 'fan-bbb';

/** Two rooms in one LiveKit fake, both carrying the same battle. */
function twoRooms(battle: Battle | null) {
  const state = new Map<string, string>([
    [A, JSON.stringify({ host: 'badadib', mode: 'standalone', boost: { enabled: true, minBoostUsd: 0 }, ...(battle ? { battle } : {}) })],
    [B, JSON.stringify({ host: 'fan', mode: 'standalone', boost: { enabled: true, minBoostUsd: 0 }, ...(battle ? { battle } : {}) })],
  ]);
  return {
    battleIn: (r: string) => readBattle(JSON.parse(state.get(r)!)),
    listRooms: vi.fn(async (names?: string[]) => [...state.entries()]
      .filter(([n]) => !names || names.includes(n)).map(([name, metadata]) => ({ name, metadata }))),
    updateRoomMetadata: vi.fn(async (n: string, m: string) => { state.set(n, m); }),
    sendData: vi.fn().mockResolvedValue(undefined),
    listParticipants: vi.fn().mockResolvedValue([]),
  };
}

let seq = 0;
function transfer(room: string, timestamp: number, amount = '2.000 HBD') {
  seq += 1;
  return {
    from: 'viewer', txId: `tx-battle-${seq}`, opIndex: seq, blockNum: 1, timestamp, to: 'boostwallet', amount,
    memo: JSON.stringify({ version: 1, room, message: 'go', sender: 'viewer', nonce: `nonce-${seq}xxx` }),
  };
}

const noop = () => {};

describe('processBoostTransfer: live battles', () => {
  const now = Date.now();
  const live = startBattle({
    id: 'bt1', state: 'invited', durationSec: 180,
    a: { host: 'badadib', room: A, hbd: 0, count: 0 },
    b: { host: 'fan', room: B, hbd: 0, count: 0 },
    invitedAt: new Date(now - 20_000).toISOString(), expiresAt: new Date(now + 40_000).toISOString(),
  }, now - 10_000);

  it('counts a boost in the window on both rooms, by HBD value', async () => {
    const lk = twoRooms(live);
    await processBoostTransfer(transfer(A, now), noop, lk as never);
    await processBoostTransfer(transfer(B, now, '4.000 HIVE'), noop, lk as never);
    for (const r of [A, B]) expect(lk.battleIn(r)).toMatchObject({ a: { hbd: 2, count: 1 }, b: { hbd: 1, count: 1 } });
  });

  it('ignores boosts sent before the start or after the end, and still pays them', async () => {
    const lk = twoRooms(live);
    await processBoostTransfer(transfer(A, Date.parse(live.startedAt!) - 1), noop, lk as never);
    await processBoostTransfer(transfer(A, Date.parse(live.endsAt!) + 1), noop, lk as never);
    expect(lk.battleIn(B)).toMatchObject({ a: { hbd: 0 }, b: { hbd: 0 } });
    const payout = await import('../../src/lib/boostPayout.js');
    expect(payout.sendBoostPayout).toHaveBeenCalledTimes(2);
  });

  it('streams without a battle make no extra LiveKit calls', async () => {
    const lk = twoRooms(null);
    await processBoostTransfer(transfer(A, now), noop, lk as never);
    // One read for the boost itself, one for the tally write: no battle read.
    expect(lk.listRooms).toHaveBeenCalledTimes(2);
  });

  it('a timestamp-less boost counts at arrival time; a failure is only logged', async () => {
    const lk = twoRooms(live);
    await processBoostTransfer(transfer(A, 0), noop, lk as never);
    expect(lk.battleIn(A)?.a.hbd).toBe(2);
    const log = vi.fn();
    const failing = twoRooms(live);
    let n = 0;
    failing.listRooms.mockImplementation(async (names?: string[]) => {
      n += 1;
      if (n === 3) throw new Error('livekit down');
      return [{ name: names?.[0] ?? A, metadata: JSON.stringify({ host: 'badadib', mode: 'standalone', boost: { enabled: true }, battle: live }) }];
    });
    await processBoostTransfer(transfer(A, now), log, failing as never);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not count the boost for the battle'), expect.any(Error));
  });
});
