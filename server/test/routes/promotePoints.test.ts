import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Read when lib/pointsToken.ts loads: answer "pending" at once.
vi.hoisted(() => { process.env.POINTS_SPEND_WAIT_MS = '0'; });

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
import { POINTS_START, memoryPointsStore, setPointsStore } from '../../src/lib/points.js';
import { memoryLedgerStore, setLedgerStore } from '../../src/lib/pointsLedger.js';
import { memoryTokenStore, resetPointsToken, setTokenEnabled, setTokenStore, spendTick } from '../../src/lib/pointsToken.js';
import { setPromoteFetch, setPromoteRetryDelays } from '../../src/lib/promotePoints.js';

const SECRET = 'checker-secret-for-tests';
const UNTIL = '2026-11-28T12:00:00.000Z';
let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};
const chain = { balance: 0, pending: false };
const txs = new Map<string, MagiTx>();
let n = 0;

const magi: MagiApi = {
  async read(calls) { return calls.map(() => ({ ok: true, ret: { balance: String(chain.balance), granted: true } })); },
  async tx(id) { return txs.get(id) ?? null; },
  async call(user, _key, action, payload) {
    const tx = (++n).toString(16).padStart(40, '0');
    txs.set(tx, chain.pending ? { status: 'pending' } : { status: 'ok', caller: `hive:${user}`, contract: 'vsc1test', action, payload: JSON.stringify(payload) });
    return tx;
  },
};

/** The checker: what /promote/eligible says and the answers PUT /promote/points gives, in turn. */
const checker = {
  down: false,
  eligible: { success: true, eligible: true, promotedUntil: null, maxDays: 7 } as Record<string, unknown>,
  credits: [] as Array<{ status: number; body: Record<string, unknown> }>,
  puts: [] as Array<{ headers: Record<string, string>; body: Record<string, unknown> }>,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (checker.down) throw new TypeError('fetch failed');
  if (url.startsWith('https://checker.test/promote/eligible/')) return json(200, checker.eligible);
  if (url === 'https://checker.test/promote/points' && init?.method === 'PUT') {
    checker.puts.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = checker.credits.shift() ?? { status: 200, body: { success: true, promotedUntil: UNTIL, addedDays: 1 } };
    return json(next.status, next.body);
  }
  return json(404, { message: 'Not found' });
});

beforeAll(async () => {
  (config as { POINTS_TOKEN_CONTRACT: string }).POINTS_TOKEN_CONTRACT = 'vsc1test';
  (config as { POINTS_SPEND_SIGNER_POSTING_KEY: string }).POINTS_SPEND_SIGNER_POSTING_KEY = 'signer-key';
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = SECRET;
  (config as { CHECKER_URL: string }).CHECKER_URL = 'https://checker.test/';
  app = await buildApp({ logger: false });
  for (const u of ['fan', 'alice']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});
afterAll(() => {
  (config as { POINTS_TOKEN_CONTRACT: string }).POINTS_TOKEN_CONTRACT = '';
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
  setTokenEnabled(null);
  setPromoteFetch(null);
  setPromoteRetryDelays([1000, 3000, 6000]);
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
  setTokenEnabled(true);
  resetPointsToken();
  setMagiApi(magi);
  Object.assign(chain, { balance: 0, pending: false });
  Object.assign(checker, { down: false, eligible: { success: true, eligible: true, promotedUntil: null, maxDays: 7 }, credits: [], puts: [] });
  setPromoteFetch(fakeFetch as unknown as typeof fetch);
  setPromoteRetryDelays([0, 0, 0]);
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = SECRET;
});

// A fresh address per request: the route allows 10 a minute per IP.
let ip = 0;
const promote = (payload: Record<string, unknown> = {}, headers = auth.fan) => app.inject({
  method: 'POST', url: '/points/promote', headers, remoteAddress: `10.0.${Math.floor(++ip / 250)}.${ip % 250}`,
  payload: { author: 'alice', permlink: 'my-video-1', days: 2, ...payload },
});

describe('GET /points/promote/quote', () => {
  it('the price per 24 h, the longest run and whether it is on', async () => {
    const res = await app.inject({ method: 'GET', url: '/points/promote/quote' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ per24h: 5000, maxDays: 7, enabled: true });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
    expect((await app.inject({ method: 'GET', url: '/points/promote/quote' })).json().enabled).toBe(false);
  });
});

describe('POST /points/promote: checks', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/points/promote', payload: { author: 'alice', permlink: 'x', days: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('validates the body', async () => {
    for (const bad of [{ days: 0 }, { days: 8 }, { days: 1.5 }, { author: 'A' }, { author: 'Alice' }, { permlink: 'has space' }, { permlink: '' }, { burnTx: 'nope' }]) {
      expect((await promote(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('404 without the checker secret', async () => {
    (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
    expect((await promote()).statusCode).toBe(404);
  });

  it('a video that cannot be promoted: 409 ineligible with the reason, nothing spent', async () => {
    chain.balance = 50_000;
    checker.eligible = { success: true, eligible: false, reason: 'short', promotedUntil: null, maxDays: 7 };
    const res = await promote();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ineligible', reason: 'short' });
    expect(token.spends.size).toBe(0);
    expect(fakeFetch.mock.calls[0][0]).toBe('https://checker.test/promote/eligible/alice/my-video-1');
  });

  it('more days than still fit: 400 too_long with maxDays', async () => {
    checker.eligible = { success: true, eligible: true, promotedUntil: UNTIL, maxDays: 1 };
    const res = await promote({ days: 2 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'too_long', maxDays: 1 });
  });

  it('checker unreachable: 503', async () => {
    checker.down = true;
    const res = await promote();
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('unavailable');
  });
});

describe('POST /points/promote without the token (Mongo balance)', () => {
  beforeEach(() => { setTokenEnabled(false); });

  it('spends per24h * days, books it under an m- id: 201 with promotedUntil and balance', async () => {
    await points.apply(new Map([['fan', 20_000]]));
    const res = await promote({ days: 3 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ promotedUntil: UNTIL, balance: POINTS_START + 20_000 - 15_000 });
    expect(checker.puts).toHaveLength(1);
    expect(checker.puts[0].headers['x-points-award-secret']).toBe(SECRET);
    expect(checker.puts[0].body).toMatchObject({ author: 'alice', permlink: 'my-video-1', days: 3, user: 'fan', points: 15_000 });
    expect(String(checker.puts[0].body.spendId)).toMatch(/^m-[0-9a-f]{16}$/);
    expect(ledger.rows).toEqual([expect.objectContaining({ user: 'fan', delta: -15_000, kind: 'spend', ref: 'promote:alice/my-video-1' })]);
  });

  it('too few points: 400 insufficient, nothing booked', async () => {
    const res = await promote({ days: 7 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('insufficient');
    expect(checker.puts).toHaveLength(0);
  });

  it('the checker turns it down: 409 and the points are back', async () => {
    await points.apply(new Map([['fan', 20_000]]));
    checker.credits.push({ status: 409, body: { success: false, code: 'too_long', maxDays: 0 } });
    const res = await promote();
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Your points are back\.$/);
    expect(await points.get('fan')).toBe(POINTS_START + 20_000);
    expect(ledger.rows.map((r) => [r.kind, r.delta, r.ref])).toEqual([
      ['spend', -10_000, 'promote:alice/my-video-1'], ['refund', 10_000, 'promote:alice/my-video-1'],
    ]);
  });

  it('the checker keeps failing: 503 after the retries, points back', async () => {
    await points.apply(new Map([['fan', 20_000]]));
    checker.credits.push(...Array.from({ length: 4 }, () => ({ status: 502, body: {} })));
    const res = await promote();
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/Your points are back\.$/);
    expect(checker.puts).toHaveLength(4);
    expect(new Set(checker.puts.map((p) => p.body.spendId)).size).toBe(1);
    expect(await points.get('fan')).toBe(POINTS_START + 20_000);
  });
});

describe('POST /points/promote with the token', () => {
  it('burns, then books under the spend id: 201', async () => {
    chain.balance = 20_000;
    await points.apply(new Map([['fan', 19_000]]));
    const res = await promote();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ promotedUntil: UNTIL, balance: POINTS_START + 19_000 - 10_000 });
    const [spend] = [...token.spends.values()];
    expect(spend).toMatchObject({ status: 'ok', amount: 10_000, purpose: { type: 'promote', room: 'promote:alice/my-video-1', author: 'alice', permlink: 'my-video-1', days: 2 } });
    expect(checker.puts[0].body).toMatchObject({ spendId: spend.id, days: 2, points: 10_000 });
    expect(ledger.rows).toEqual([expect.objectContaining({ delta: -10_000, kind: 'spend', ref: 'promote:alice/my-video-1', mint: 'burn' })]);
  });

  it('slow chain: 202 pending, the follower books it once, and /points/spends/:id carries promotedUntil', async () => {
    chain.balance = 20_000;
    chain.pending = true;
    const res = await promote();
    expect(res.statusCode).toBe(202);
    const { spendId } = res.json();
    const before = await app.inject({ method: 'GET', url: `/points/spends/${spendId}`, headers: auth.fan });
    expect(before.json()).toMatchObject({ status: 'sent', type: 'promote', amount: 10_000 });
    expect(before.json().promotedUntil).toBeUndefined();
    expect(checker.puts).toHaveLength(0);

    const spend = token.spends.get(spendId)!;
    txs.set(spend.tx, { status: 'ok', caller: 'hive:fan', contract: 'vsc1test', action: 'burn', payload: '{"amount":"10000"}' });
    await spendTick();
    await spendTick();
    expect(checker.puts).toHaveLength(1);
    expect(checker.puts[0].body.spendId).toBe(spendId);
    const after = await app.inject({ method: 'GET', url: `/points/spends/${spendId}`, headers: auth.fan });
    expect(after.json()).toMatchObject({ status: 'ok', type: 'promote', promotedUntil: UNTIL });
  });

  it('the completer retries a 5xx with the same spend id, then books it', async () => {
    chain.balance = 20_000;
    checker.credits.push({ status: 503, body: {} }, { status: 500, body: {} });
    const res = await promote();
    expect(res.statusCode).toBe(201);
    expect(res.json().promotedUntil).toBe(UNTIL);
    expect(checker.puts).toHaveLength(3);
    expect(new Set(checker.puts.map((p) => p.body.spendId)).size).toBe(1);
  });

  it('a definitive 409 refunds the burn: 409, spend refunded, points back', async () => {
    chain.balance = 20_000;
    await points.apply(new Map([['fan', 19_000]]));
    checker.credits.push({ status: 409, body: { success: false, code: 'ineligible', reason: 'unavailable' } });
    const res = await promote();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'failed', message: 'That video cannot be promoted. Your points are back.' });
    expect(checker.puts).toHaveLength(1);
    const [spend] = [...token.spends.values()];
    expect(spend.status).toBe('refunded');
    expect(await points.get('fan')).toBe(POINTS_START + 19_000);
    expect(ledger.rows.map((r) => [r.kind, r.delta, r.ref])).toEqual([
      ['spend', -10_000, 'promote:alice/my-video-1'], ['refund', 10_000, 'promote:alice/my-video-1'],
    ]);
    const status = await app.inject({ method: 'GET', url: `/points/spends/${spend.id}`, headers: auth.fan });
    expect(status.json()).toMatchObject({ status: 'refunded', type: 'promote' });
    expect(status.json().promotedUntil).toBeUndefined();
  });

  it('a burn confirmed while the booking still runs reads as pending', async () => {
    const id = 'sp-booking-1';
    await token.insertSpend({
      id, user: 'fan', amount: 5000, tx: 'ab'.repeat(20), signedBy: 'server', status: 'ok', createdAt: Date.now(), doneAt: Date.now(),
      purpose: { type: 'promote', room: 'promote:alice/my-video-1', author: 'alice', permlink: 'my-video-1', days: 1 },
    });
    const res = await app.inject({ method: 'GET', url: `/points/spends/${id}`, headers: auth.fan });
    expect(res.json()).toMatchObject({ status: 'sent', type: 'promote' });
  });
});
