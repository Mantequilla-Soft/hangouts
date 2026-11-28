import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Read when lib/pointsToken.ts loads: answer "pending" at once.
vi.hoisted(() => { process.env.POINTS_SPEND_WAIT_MS = '0'; });

const hive = vi.hoisted(() => ({ accounts: new Set<string>(['fan', 'alice', 'bob']), down: false }));
vi.mock('../../src/lib/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn(async (names: string[]) => {
        if (hive.down) throw new Error('node down');
        return names.filter((n) => hive.accounts.has(n)).map((name) => ({ name }));
      }),
    },
  },
}));
vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn().mockResolvedValue([]),
    listParticipants: vi.fn().mockResolvedValue([]),
    updateRoomMetadata: vi.fn(),
    sendData: vi.fn().mockResolvedValue(undefined),
  },
  generateRoomName: vi.fn().mockReturnValue('test-room'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));
vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

import { buildApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { makeToken } from '../setup.js';
import { setMagiApi, type MagiApi, type MagiTx } from '../../src/lib/magi.js';
import { memoryPointsStore, setPointsStore } from '../../src/lib/points.js';
import { memoryLedgerStore, setLedgerStore } from '../../src/lib/pointsLedger.js';
import { pointsMultiplier } from '../../src/lib/pointsEvents.js';
import { memoryTokenStore, resetPointsToken, setTokenEnabled, setTokenStore, spendTick } from '../../src/lib/pointsToken.js';

let app: FastifyInstance;
let auth: { authorization: string };
const chain = { balance: 0, pending: false };
const txs = new Map<string, MagiTx>();
const calls: Array<{ user: string; action: string; payload: Record<string, unknown> }> = [];
let n = 0;

const magi: MagiApi = {
  async read(cs) { return cs.map(() => ({ ok: true, ret: { balance: String(chain.balance), granted: true } })); },
  async tx(id) { return txs.get(id) ?? null; },
  async call(user, _key, action, payload) {
    calls.push({ user, action, payload });
    const tx = (++n).toString(16).padStart(40, '0');
    txs.set(tx, chain.pending ? { status: 'pending' } : { status: 'ok', caller: `hive:${user}`, contract: 'vsc1test', action, payload: JSON.stringify(payload) });
    return tx;
  },
};

const cfg = config as { POINTS_TOKEN_CONTRACT: string; POINTS_SPEND_SIGNER_POSTING_KEY: string; POINTS_DOUBLE_WINDOWS: string };
beforeAll(async () => {
  cfg.POINTS_TOKEN_CONTRACT = 'vsc1test';
  cfg.POINTS_SPEND_SIGNER_POSTING_KEY = 'signer-key';
  app = await buildApp({ logger: false });
  auth = { authorization: `Bearer ${await makeToken('fan')}` };
});
afterAll(() => {
  cfg.POINTS_TOKEN_CONTRACT = '';
  cfg.POINTS_SPEND_SIGNER_POSTING_KEY = '';
  cfg.POINTS_DOUBLE_WINDOWS = '';
  setTokenEnabled(null);
});

let points: ReturnType<typeof memoryPointsStore>;
let ledger: ReturnType<typeof memoryLedgerStore>;
let token: ReturnType<typeof memoryTokenStore>;
beforeEach(() => {
  points = memoryPointsStore();
  setPointsStore(points);
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  token = memoryTokenStore();
  token.airdrop = true;
  setTokenStore(token);
  setTokenEnabled(false);
  resetPointsToken();
  setMagiApi(magi);
  Object.assign(chain, { balance: 0, pending: false });
  Object.assign(hive, { down: false });
  calls.length = 0;
  cfg.POINTS_SPEND_SIGNER_POSTING_KEY = 'signer-key';
  cfg.POINTS_DOUBLE_WINDOWS = '';
});

// A fresh address per request: the route allows 10 a minute per IP.
let ip = 0;
const send = (payload: Record<string, unknown>, headers: Record<string, string> = auth) => app.inject({
  method: 'POST', url: '/points/transfer', headers, remoteAddress: `10.1.${Math.floor(++ip / 250)}.${ip % 250}`, payload,
});
const rows = () => ledger.rows.map((r) => ({ user: r.user, delta: r.delta, kind: r.kind, ref: r.ref, mint: r.mint ?? null }));

describe('POST /points/transfer: checks', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/points/transfer', payload: { to: 'alice', amount: 5 } });
    expect(res.statusCode).toBe(401);
  });

  it('validates the body', async () => {
    for (const bad of [{ to: 'alice', amount: 0 }, { to: 'alice', amount: 1.5 }, { to: 'Alice', amount: 1 }, { to: 'a', amount: 1 }, { amount: 1 }, { to: 'alice' }, { to: 'alice', amount: 1, post: 'nope' }, { to: 'alice', amount: 1, burnTx: 'x' }]) {
      expect((await send(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('not to yourself, not to an account that does not exist, a tip only to the post\'s author', async () => {
    expect((await send({ to: 'fan', amount: 5 })).json()).toMatchObject({ code: 'invalid' });
    const none = await send({ to: 'nobody', amount: 5 });
    expect(none.statusCode).toBe(400);
    expect(none.json().message).toBe('There is no Hive account @nobody.');
    expect((await send({ to: 'alice', amount: 5, post: 'bob/a-video' })).json()).toMatchObject({ code: 'invalid' });
    expect(points.balances.size).toBe(0);
  });

  it('503 when Hive cannot say whether the account exists', async () => {
    hive.down = true;
    expect((await send({ to: 'alice', amount: 5 })).statusCode).toBe(503);
  });
});

describe('POST /points/transfer before the token', () => {
  it('moves the Mongo balances at once, a transfer row on each side', async () => {
    points.balances.set('fan', 1500);
    const res = await send({ to: '@alice', amount: 400 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ balance: 1100, to: 'alice', amount: 400 });
    expect(points.balances.get('fan')).toBe(1100);
    expect(points.balances.get('alice')).toBe(1400);
    expect(rows()).toEqual([
      { user: 'fan', delta: -400, kind: 'transfer', ref: 'alice', mint: null },
      { user: 'alice', delta: 400, kind: 'transfer', ref: 'fan', mint: null },
    ]);
    expect(calls).toEqual([]);
  });

  it('a points tip keeps the post as the sender\'s ref', async () => {
    points.balances.set('fan', 1500);
    expect((await send({ to: 'alice', amount: 100, post: 'alice/my-video-1' })).statusCode).toBe(201);
    expect(rows()[0]).toMatchObject({ user: 'fan', ref: 'alice/my-video-1' });
    expect(rows()[1]).toMatchObject({ user: 'alice', ref: 'fan' });
  });

  it('too few points: nothing moves', async () => {
    points.balances.set('fan', 50);
    const res = await send({ to: 'alice', amount: 400 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('insufficient');
    expect(points.balances.get('fan')).toBe(50);
    expect(points.balances.has('alice')).toBe(false);
    expect(ledger.rows).toEqual([]);
  });

  it('never doubled, even inside a double-points window', async () => {
    cfg.POINTS_DOUBLE_WINDOWS = `${new Date(Date.now() - 60_000).toISOString()}/${new Date(Date.now() + 3_600_000).toISOString()}`;
    expect(pointsMultiplier('watch')).toBe(2);
    expect(pointsMultiplier('transfer')).toBe(1);
    points.balances.set('fan', 1500);
    await send({ to: 'alice', amount: 400 });
    expect(points.balances.get('alice')).toBe(1400);
  });
});

describe('POST /points/transfer with the token', () => {
  beforeEach(() => { setTokenEnabled(true); chain.balance = 5000; });

  it('a Magi transfer as the sender, signed by @threespeak; both sides follow once it is confirmed, never minted again', async () => {
    points.balances.set('fan', 5000);
    const res = await send({ to: 'alice', amount: 700 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ balance: 4300, to: 'alice', amount: 700 });
    expect(calls).toEqual([{ user: 'fan', action: 'transfer', payload: { to: 'hive:alice', amount: '700' } }]);
    expect(points.balances.get('alice')).toBe(1700);
    expect(rows()).toEqual([
      { user: 'fan', delta: -700, kind: 'transfer', ref: 'alice', mint: 'chain' },
      { user: 'alice', delta: 700, kind: 'transfer', ref: 'fan', mint: 'chain' },
    ]);
    // Nothing for the mint queue: alice's 700 are on Magi already.
    expect(await ledger.unminted(10)).toEqual([]);
  });

  it('pending until Magi answers, then finished in the background', async () => {
    points.balances.set('fan', 5000);
    chain.pending = true;
    const res = await send({ to: 'alice', amount: 700 });
    expect(res.statusCode).toBe(202);
    const { spendId } = res.json();
    expect(points.balances.get('fan')).toBe(5000);
    const [tx] = [...txs.entries()].at(-1)!;
    txs.set(tx, { status: 'ok', caller: 'hive:fan', contract: 'vsc1test', action: 'transfer', payload: JSON.stringify({ to: 'hive:alice', amount: '700' }) });
    await spendTick();
    expect(points.balances.get('fan')).toBe(4300);
    expect(points.balances.get('alice')).toBe(1700);
    const status = await app.inject({ method: 'GET', url: `/points/spends/${spendId}`, headers: auth });
    expect(status.json()).toMatchObject({ status: 'ok', type: 'transfer', amount: 700 });
  });

  it('without a signer the wallet signs the transfer (428 with the op), then the request comes back with its txid', async () => {
    cfg.POINTS_SPEND_SIGNER_POSTING_KEY = '';
    points.balances.set('fan', 5000);
    const first = await send({ to: 'alice', amount: 300 });
    expect(first.statusCode).toBe(428);
    const op = first.json().op;
    expect(op[0]).toBe('custom_json');
    expect(JSON.parse(op[1].json)).toMatchObject({ action: 'transfer', payload: JSON.stringify({ to: 'hive:alice', amount: '300' }) });
    // The wallet broadcast it: Magi confirms the user's own call.
    const tx = 'ab'.repeat(20);
    txs.set(tx, { status: 'ok', caller: 'hive:fan', contract: 'vsc1test', action: 'transfer', payload: JSON.stringify({ to: 'hive:alice', amount: '300' }) });
    const again = await send({ to: 'alice', amount: 300, burnTx: tx });
    expect(again.statusCode).toBe(201);
    expect(points.balances.get('alice')).toBe(1300);
  });

  it('a txid of a different call is refused: a burn, or a transfer to someone else', async () => {
    points.balances.set('fan', 5000);
    const burn = 'cd'.repeat(20);
    txs.set(burn, { status: 'ok', caller: 'hive:fan', contract: 'vsc1test', action: 'burn', payload: JSON.stringify({ amount: '300' }) });
    expect((await send({ to: 'alice', amount: 300, burnTx: burn })).json()).toMatchObject({ code: 'invalid' });
    const other = 'ef'.repeat(20);
    txs.set(other, { status: 'ok', caller: 'hive:fan', contract: 'vsc1test', action: 'transfer', payload: JSON.stringify({ to: 'hive:bob', amount: '300' }) });
    expect((await send({ to: 'alice', amount: 300, burnTx: other })).json()).toMatchObject({ code: 'invalid' });
    expect(points.balances.get('fan')).toBe(5000);
  });

  it('not enough points on Magi: nothing is sent', async () => {
    points.balances.set('fan', 5000);
    chain.balance = 100;
    const res = await send({ to: 'alice', amount: 700 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('insufficient');
    expect(calls).toEqual([]);
  });
});
