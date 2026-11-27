import { beforeEach, describe, expect, it, vi } from 'vitest';

const hive = vi.hoisted(() => ({ accounts: new Set<string>(['alice', 'bob', 'carol', 'dave']) }));
vi.mock('../../src/lib/hive.js', () => ({
  hiveClient: {
    database: { getAccounts: vi.fn(async (names: string[]) => names.filter((n) => hive.accounts.has(n)).map((name) => ({ name }))) },
  },
}));
vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { sendData: vi.fn().mockResolvedValue(undefined), listRooms: vi.fn().mockResolvedValue([]) },
}));

import { config } from '../../src/config.js';
import { setMagiApi, type MagiApi, type MagiTx } from '../../src/lib/magi.js';
import { POINTS_START, expirePoints, memoryPointsStore, pointsDetails, setPointsStore } from '../../src/lib/points.js';
import { memoryLedgerStore, newRow, setLedgerStore } from '../../src/lib/pointsLedger.js';
import {
  PointsSpendError, buildMintBatch, memoryTokenStore, mintBatchId, mintTick, refundOrphanStakes, registerSpendCompleter,
  resetPointsToken, setStakeLiveCheck, setTokenEnabled, setTokenStore, settlePrediction, spendOnChain, spendTick, tokenLive,
} from '../../src/lib/pointsToken.js';

/** A fake Magi: balances, grants, caps, and what each broadcast did. */
function fakeMagi() {
  const balances = new Map<string, number>();
  const grants = new Set<string>();
  const txs = new Map<string, MagiTx>();
  const calls: Array<{ user: string; action: string; payload: Record<string, unknown>; tx: string }> = [];
  const state = { mintedToday: 0, perBatch: 50_000, perDay: 250_000, auto: true as boolean, missingAuthority: false, n: 0 };
  const api: MagiApi = {
    async read(reads) {
      return reads.map((r) => {
        const acct = String(r.payload.account ?? '');
        if (r.action === 'balanceOf') return { ok: true, ret: { balance: String(balances.get(acct) ?? 0) } };
        if (r.action === 'hasGrant') return { ok: true, ret: { granted: grants.has(acct) } };
        if (r.action === 'getMintCaps') return { ok: true, ret: { perBatch: String(state.perBatch), perDay: String(state.perDay), mintedToday: String(state.mintedToday) } };
        return { ok: false, ret: null, err: 'unknown' };
      });
    },
    async tx(id) { return txs.get(id) ?? null; },
    async call(user, _key, action, payload) {
      if (state.missingAuthority && action === 'burn') throw new Error('missing required posting authority: Missing Posting Authority alice');
      const tx = (++state.n).toString(16).padStart(40, '0');
      calls.push({ user, action, payload, tx });
      if (state.auto) apply(tx, user, action, payload);
      else txs.set(tx, { status: 'pending' });
      return tx;
    },
  };
  function apply(tx: string, user: string, action: string, payload: Record<string, unknown>) {
    const base = { caller: `hive:${user}`, contract: 'vsc1test', action, payload: JSON.stringify(payload) };
    if (action === 'burn') {
      const amt = Number(payload.amount);
      const have = balances.get(`hive:${user}`) ?? 0;
      if (have < amt) { txs.set(tx, { ...base, status: 'failed', error: 'Insufficient balance' }); return; }
      balances.set(`hive:${user}`, have - amt);
    }
    if (action === 'mintBatch') {
      const rows = payload.to as Array<[string, string, string]>;
      for (const [a, , k] of rows) if ((k === 'g' || k === 'a') && grants.has(a)) { txs.set(tx, { ...base, status: 'failed', error: `Welcome grant already given to ${a}` }); return; }
      for (const [a, amt, k] of rows) {
        balances.set(a, (balances.get(a) ?? 0) + Number(amt));
        if (k === 'g' || k === 'a') grants.add(a);
        state.mintedToday += Number(amt);
      }
    }
    txs.set(tx, { ...base, status: 'ok' });
  }
  return { api, balances, grants, txs, calls, state, apply };
}

let magi: ReturnType<typeof fakeMagi>;
let points: ReturnType<typeof memoryPointsStore>;
let ledger: ReturnType<typeof memoryLedgerStore>;
let token: ReturnType<typeof memoryTokenStore>;

beforeEach(() => {
  magi = fakeMagi();
  setMagiApi(magi.api);
  points = memoryPointsStore();
  setPointsStore(points);
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  token = memoryTokenStore();
  token.airdrop = true;
  setTokenStore(token);
  setTokenEnabled(true);
  resetPointsToken();
  (config as { POINTS_TOKEN_CONTRACT: string }).POINTS_TOKEN_CONTRACT = 'vsc1test';
  (config as { POINTS_MINTER_POSTING_KEY: string }).POINTS_MINTER_POSTING_KEY = 'minter-key';
  (config as { POINTS_SPEND_SIGNER_POSTING_KEY: string }).POINTS_SPEND_SIGNER_POSTING_KEY = 'signer-key';
});

const earn = async (user: string, delta: number, kind: 'watch' | 'chat' | 'stream' = 'watch', at = Date.now()) => {
  await points.apply(new Map([[user, delta]]));
  await ledger.insert([newRow(user, delta, kind, at)]);
};

describe('on or off', () => {
  it('is live only once configured and the airdrop is done', async () => {
    token.airdrop = false;
    resetPointsToken();
    expect(await tokenLive()).toBe(false);
    setTokenEnabled(false);
    token.airdrop = true;
    expect(await tokenLive()).toBe(false);
    setTokenEnabled(true);
    expect(await tokenLive()).toBe(true);
  });

  it('no expiry while the token is configured', async () => {
    await points.apply(new Map([['alice', 500]]));
    const later = Date.now() + 400 * 24 * 3600 * 1000;
    expect(await expirePoints(later)).toBe(0);
    expect(await points.get('alice')).toBe(POINTS_START + 500);
    expect((await pointsDetails('alice')).expiresAt).toBeNull();
  });
});

describe('minting', () => {
  it('one row per account, its welcome grant first, a content id; the rows are claimed', async () => {
    await earn('alice', 10);
    await earn('alice', 5, 'chat');
    await earn('bob', 100, 'stream');
    magi.grants.add('hive:bob');
    await mintTick();
    expect(magi.calls).toHaveLength(1);
    const { payload } = magi.calls[0];
    expect(payload.to).toEqual([
      ['hive:alice', String(POINTS_START), 'g'],
      ['hive:alice', '15', 'e'],
      ['hive:bob', '100', 's'],
    ]);
    expect(payload.id).toBe(mintBatchId(payload.to as never, ledger.rows.map((r) => r.id)));
    expect(ledger.rows.every((r) => r.mint === payload.id)).toBe(true);
    await mintTick();
    expect([...token.batches.values()][0].status).toBe('ok');
    expect(magi.balances.get('hive:alice')).toBe(POINTS_START + 15);
    expect(magi.balances.get('hive:bob')).toBe(100);
  });

  it('never mints to an account that does not exist on Hive', async () => {
    await earn('ghostuser1', 10);
    await earn('alice', 10);
    magi.grants.add('hive:alice');
    await mintTick();
    expect(magi.calls[0].payload.to).toEqual([['hive:alice', '10', 'w']]);
    expect(ledger.rows.find((r) => r.user === 'ghostuser1')?.mint).toBe('skip:account');
  });

  it('waits for the airdrop, and builds only every POINTS_MINT_INTERVAL_MIN', async () => {
    token.airdrop = false;
    resetPointsToken();
    await earn('alice', 10);
    await mintTick();
    expect(magi.calls).toHaveLength(0);
    token.airdrop = true;
    resetPointsToken();
    const t0 = Date.now();
    await mintTick(t0);
    await mintTick(t0 + 1000);
    await earn('bob', 10);
    await mintTick(t0 + 2000);
    expect(magi.calls).toHaveLength(1);
    await mintTick(t0 + config.POINTS_MINT_INTERVAL_MIN * 60_000 + 3000);
    expect(magi.calls).toHaveLength(2);
  });

  it('an aborted batch releases its rows; the rebuild knows the grant was given', async () => {
    await earn('alice', 10);
    magi.grants.add('hive:alice'); // the cache does not know yet: the batch asks for a grant
    vi.spyOn(magi.api, 'read').mockImplementationOnce(async () => [{ ok: true, ret: { perBatch: '50000', perDay: '250000', mintedToday: '0' } }])
      .mockImplementationOnce(async () => [{ ok: true, ret: { granted: false } }]);
    await mintTick();
    await mintTick(); // follows it: aborted
    const [first] = token.batches.values();
    expect(first.status).toBe('failed');
    expect(ledger.rows[0].mint ?? null).toBeNull();
    await mintTick(Date.now() + config.POINTS_MINT_INTERVAL_MIN * 60_000 + 1);
    expect(magi.calls.at(-1)!.payload.to).toEqual([['hive:alice', '10', 'w']]);
  });

  it('no answer for 10 minutes: the same id again; "already used" means it landed', async () => {
    await earn('alice', 10);
    magi.grants.add('hive:alice');
    magi.state.auto = false;
    const t0 = Date.now();
    await mintTick(t0);
    await mintTick(t0 + 5 * 60_000);
    expect(magi.calls).toHaveLength(1);
    await mintTick(t0 + 11 * 60_000);
    expect(magi.calls).toHaveLength(2);
    expect(magi.calls[1].payload.id).toBe(magi.calls[0].payload.id);
    magi.txs.set(magi.calls[1].tx, { status: 'failed', error: 'Batch id already used' });
    await mintTick(t0 + 12 * 60_000);
    expect([...token.batches.values()][0].status).toBe('ok');
  });

  it('a crash after saving a batch but before claiming its rows never mints them twice', async () => {
    await earn('alice', 10);
    magi.grants.add('hive:alice');
    const b = (await buildMintBatch({ room: 50_000 }))!;
    await token.saveBatch(b); // ...and the process died here
    expect(ledger.rows[0].mint ?? null).toBeNull();
    await mintTick(); // claims, then sends the saved batch
    expect(ledger.rows[0].mint).toBe(b.id);
    await mintTick(); // confirmed
    await mintTick(Date.now() + config.POINTS_MINT_INTERVAL_MIN * 60_000 + 1);
    expect(magi.calls.filter((c) => c.action === 'mintBatch')).toHaveLength(1);
    expect(magi.balances.get('hive:alice')).toBe(10);
  });

  it('stays under the per-batch cap and what is left of the day', async () => {
    for (const u of ['alice', 'bob', 'carol']) { magi.grants.add(`hive:${u}`); await earn(u, 400); }
    const b = await buildMintBatch({ room: 900 });
    expect(b!.rows.map((r) => r[0])).toEqual(['hive:alice', 'hive:bob']);
    expect(b!.total).toBe(800);
    magi.state.mintedToday = 250_000;
    await mintTick();
    expect(magi.calls).toHaveLength(0);
  });

  it('a grant request with no earnings gets its own row', async () => {
    await token.requestGrant('carol');
    const b = await buildMintBatch({ room: 50_000 });
    expect(b!.rows).toEqual([['hive:carol', String(POINTS_START), 'g']]);
  });
});

describe('spending: burn first, then grant', () => {
  const purpose = { type: 'boost' as const, room: 'r1', message: 'hi', recipient: 'host', minUsd: 0 };
  let completed: unknown[];
  beforeEach(() => {
    completed = [];
    registerSpendCompleter('boost', async (s) => { completed.push(s.amount); return { boosted: s.amount }; });
  });

  it('the server signs the burn as the user; Mongo and the ledger follow', async () => {
    magi.balances.set('hive:alice', 5000);
    await points.apply(new Map([['alice', 4000]]));
    const res = await spendOnChain('alice', 2500, purpose, { waitMs: 0 });
    expect(res.state).toBe('done');
    expect(magi.calls[0]).toMatchObject({ user: 'alice', action: 'burn', payload: { amount: '2500' } });
    expect(magi.balances.get('hive:alice')).toBe(2500);
    expect(await points.get('alice')).toBe(POINTS_START + 4000 - 2500);
    expect(ledger.rows.at(-1)).toMatchObject({ user: 'alice', delta: -2500, kind: 'spend', mint: 'burn' });
    expect(completed).toEqual([2500]);
    if (res.state === 'done') expect(res.result).toEqual({ boosted: 2500 });
  });

  it('too few on chain: nothing broadcast; says what is on the way and asks for the grant', async () => {
    await earn('alice', 300);
    const err = await spendOnChain('alice', 2500, purpose).catch((e) => e) as PointsSpendError;
    expect(err).toBeInstanceOf(PointsSpendError);
    expect(err.code).toBe('insufficient');
    expect(err.extra).toEqual({ onChain: 0, unminted: 300 + POINTS_START });
    expect(magi.calls).toHaveLength(0);
    expect(await token.grantRequests()).toEqual(['alice']);
  });

  it('no posting authority (or no signer key): a 428 with the op for the wallet', async () => {
    magi.balances.set('hive:alice', 5000);
    magi.state.missingAuthority = true;
    const err = await spendOnChain('alice', 2500, purpose).catch((e) => e) as PointsSpendError;
    expect(err.status).toBe(428);
    const [type, op] = err.extra.op as [string, { id: string; required_posting_auths: string[]; json: string }];
    expect(type).toBe('custom_json');
    expect(op.id).toBe('vsc.call');
    expect(op.required_posting_auths).toEqual(['alice']);
    expect(JSON.parse(op.json)).toMatchObject({ caller: 'hive:alice', contract_id: 'vsc1test', action: 'burn', payload: '{"amount":"2500"}' });
    magi.state.missingAuthority = false;
    (config as { POINTS_SPEND_SIGNER_POSTING_KEY: string }).POINTS_SPEND_SIGNER_POSTING_KEY = '';
    expect((await spendOnChain('alice', 2500, purpose).catch((e) => e) as PointsSpendError).status).toBe(428);
  });

  it('a burn the wallet signed: must be exactly this spend, and pays once', async () => {
    magi.balances.set('hive:alice', 5000);
    const tx = 'ab'.repeat(20);
    magi.apply(tx, 'alice', 'burn', { amount: '2500' });
    await expect(spendOnChain('alice', 2600, purpose, { burnTx: tx })).rejects.toMatchObject({ code: 'invalid' });
    await expect(spendOnChain('bob', 2500, purpose, { burnTx: tx })).rejects.toMatchObject({ code: 'invalid' });
    const ok = await spendOnChain('alice', 2500, purpose, { burnTx: tx, waitMs: 0 });
    expect(ok.state).toBe('done');
    expect(ok.spend.signedBy).toBe('user');
    await expect(spendOnChain('alice', 2500, purpose, { burnTx: tx })).rejects.toMatchObject({ code: 'used', status: 409 });
    expect(completed).toEqual([2500]);
  });

  it('the contract aborts: nothing granted', async () => {
    magi.balances.set('hive:alice', 5000);
    vi.spyOn(magi.api, 'read').mockResolvedValueOnce([{ ok: true, ret: { balance: '9000' } }]);
    magi.balances.set('hive:alice', 100);
    await expect(spendOnChain('alice', 2500, purpose, { waitMs: 0 })).rejects.toMatchObject({ code: 'insufficient' });
    expect(completed).toEqual([]);
    expect([...token.spends.values()][0].status).toBe('failed');
  });

  it('slow to confirm: pending now, finished by the follower later', async () => {
    magi.balances.set('hive:alice', 5000);
    magi.state.auto = false;
    const res = await spendOnChain('alice', 2500, purpose, { waitMs: 0 });
    expect(res.state).toBe('pending');
    expect(completed).toEqual([]);
    const { tx, user, action, payload } = magi.calls[0];
    magi.apply(tx, user, action, payload);
    await spendTick();
    expect(completed).toEqual([2500]);
    expect((await token.getSpend(res.spend.id))!.status).toBe('ok');
  });

  it('paid but it cannot happen any more: refunded, minted with the next batch', async () => {
    magi.balances.set('hive:alice', 5000);
    registerSpendCompleter('boost', async () => { throw new Error('The stream ended.'); });
    await points.apply(new Map([['alice', 4000]]));
    await expect(spendOnChain('alice', 2500, purpose, { waitMs: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await points.get('alice')).toBe(POINTS_START + 4000);
    expect(ledger.rows.at(-1)).toMatchObject({ user: 'alice', delta: 2500, kind: 'refund' });
    expect(ledger.rows.at(-1)!.mint ?? null).toBeNull();
  });
});

describe('prediction stakes', () => {
  const stake = (user: string, option: number, amount: number, poll = 'p1') => spendOnChain(user, amount, { type: 'stake', room: 'r1', poll, option }, { waitMs: 0 });
  beforeEach(() => {
    registerSpendCompleter('stake', async () => ({}));
    for (const u of ['alice', 'bob', 'carol']) magi.balances.set(`hive:${u}`, 10_000);
  });

  it('the winners split the pot from the confirmed burns, once', async () => {
    await stake('alice', 0, 300);
    await stake('alice', 0, 100);
    await stake('bob', 1, 600);
    const out = await settlePrediction('p1', 0);
    expect(out).toEqual(new Map([['alice', 1000]]));
    expect(ledger.rows.at(-1)).toMatchObject({ user: 'alice', delta: 1000, kind: 'prediction' });
    expect((await settlePrediction('p1', 0)).size).toBe(0);
  });

  it('cancelled, or nobody on the winning side: every stake comes back', async () => {
    await stake('alice', 0, 300);
    await stake('bob', 0, 200);
    expect(await settlePrediction('p1', 1)).toEqual(new Map([['alice', 300], ['bob', 200]]));
    await stake('carol', 1, 50, 'p2');
    expect(await settlePrediction('p2', null)).toEqual(new Map([['carol', 50]]));
  });

  it('a prediction that is gone (a restart) refunds its stakes', async () => {
    await stake('alice', 0, 300);
    setStakeLiveCheck(() => true);
    expect(await refundOrphanStakes(Date.now() + 120_000)).toBe(0);
    setStakeLiveCheck(() => false);
    expect(await refundOrphanStakes(Date.now())).toBe(0); // a minute of grace
    expect(await refundOrphanStakes(Date.now() + 120_000)).toBe(1);
    expect(ledger.rows.at(-1)).toMatchObject({ user: 'alice', delta: 300, kind: 'refund' });
    expect(await refundOrphanStakes(Date.now() + 120_000)).toBe(0);
    setStakeLiveCheck(() => true);
  });
});

describe('a prediction with the token, end to end', () => {
  it('stakes count once burned, the resolution mints the winners, a cancel refunds', async () => {
    const polls = await import('../../src/lib/polls.js');
    polls.resetPolls();
    polls.setPollStores({ archive: polls.memoryPollArchive() });
    for (const u of ['alice', 'bob']) magi.balances.set(`hive:${u}`, 5000);
    const p = polls.createPoll('room1', 'carol', { kind: 'prediction', question: 'Who wins?', options: ['A', 'B'], durationSec: 60 }, null);
    await polls.stake('room1', p.id, 'alice', 0, 300);
    await polls.stake('room1', p.id, 'bob', 1, 100);
    expect(p.stakes.get('alice')).toEqual({ option: 0, amount: 300 });
    expect(p.chainStakes).toBe(true);
    expect(magi.balances.get('hive:alice')).toBe(4700);
    expect(await points.get('alice')).toBe(POINTS_START - 300);
    await polls.endPoll('room1', p.id);
    await polls.resolvePrediction('room1', p.id, 0);
    expect(ledger.rows.at(-1)).toMatchObject({ user: 'alice', delta: 400, kind: 'prediction' });
    expect(await points.get('alice')).toBe(POINTS_START + 100);
    expect(await points.get('bob')).toBe(POINTS_START - 100);

    const q = polls.createPoll('room1', 'carol', { kind: 'prediction', question: 'Again?', options: ['A', 'B'], durationSec: 60 }, null);
    await polls.stake('room1', q.id, 'bob', 1, 50);
    await polls.cancelPoll('room1', q.id);
    expect(ledger.rows.at(-1)).toMatchObject({ user: 'bob', delta: 50, kind: 'refund' });
    polls.resetPolls();
  });
});
