import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Read when lib/pointsToken.ts loads: answer "pending" at once.
vi.hoisted(() => { process.env.POINTS_SPEND_WAIT_MS = '0'; });

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(),
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
import { memoryAwardStore, setAccountCreatedLookup, setAwardBanCheck, setAwardStore } from '../../src/lib/pointsAwards.js';
import { memoryWatchMinuteStore, setWatchMinuteStore } from '../../src/lib/pointsQuests.js';
import { memoryTokenStore, resetPointsToken, setTokenEnabled, setTokenStore } from '../../src/lib/pointsToken.js';

const ROOM = 'alice-room-abc123';
let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};
const chain = { balance: 0, missingAuthority: false, pending: false };
const txs = new Map<string, MagiTx>();
let n = 0;

const magi: MagiApi = {
  async read(calls) { return calls.map(() => ({ ok: true, ret: { balance: String(chain.balance), granted: true } })); },
  async tx(id) { return txs.get(id) ?? null; },
  async call(user, _key, action, payload) {
    if (chain.missingAuthority) throw new Error('missing required posting authority');
    const tx = (++n).toString(16).padStart(40, '0');
    txs.set(tx, chain.pending ? { status: 'pending' } : { status: 'ok', caller: `hive:${user}`, contract: 'vsc1test', action, payload: JSON.stringify(payload) });
    return tx;
  },
};

beforeAll(async () => {
  (config as { POINTS_TOKEN_CONTRACT: string }).POINTS_TOKEN_CONTRACT = 'vsc1test';
  (config as { POINTS_SPEND_SIGNER_POSTING_KEY: string }).POINTS_SPEND_SIGNER_POSTING_KEY = 'signer-key';
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = 'checker-secret-for-tests';
  app = await buildApp();
  for (const u of ['alice', 'fan']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});
afterAll(() => {
  (config as { POINTS_TOKEN_CONTRACT: string }).POINTS_TOKEN_CONTRACT = '';
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
  setTokenEnabled(null);
});

let points: ReturnType<typeof memoryPointsStore>;
beforeEach(async () => {
  vi.clearAllMocks();
  points = memoryPointsStore();
  setPointsStore(points);
  setLedgerStore(memoryLedgerStore());
  setAwardStore(memoryAwardStore());
  setAwardBanCheck(async () => false);
  setAccountCreatedLookup(async () => null);
  setWatchMinuteStore(memoryWatchMinuteStore());
  const store = memoryTokenStore();
  store.airdrop = true;
  setTokenStore(store);
  setTokenEnabled(true);
  resetPointsToken();
  setMagiApi(magi);
  Object.assign(chain, { balance: 0, missingAuthority: false, pending: false });
  const { roomService } = await import('../../src/lib/livekit.js');
  vi.mocked(roomService.listRooms).mockResolvedValue([{
    name: ROOM,
    metadata: JSON.stringify({ host: 'alice', mode: 'standalone', boost: { enabled: true, creatorPayoutAccount: 'alice' } }),
  }] as never);
});

const boost = (payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url: `/rooms/${ROOM}/boosts/points`, headers: auth.fan, payload: { amount: 2500, message: 'go!', ...payload },
});

describe('a points boost with the token', () => {
  it('burns, then boosts: 201 with the event', async () => {
    chain.balance = 3000;
    await points.apply(new Map([['fan', 2000]]));
    const res = await boost();
    expect(res.statusCode).toBe(201);
    expect(res.json().boost).toMatchObject({ asset: 'POINTS', amount: '2500', sender: 'fan' });
    expect(res.json().balance).toBe(POINTS_START + 2000 - 2500);
  });

  it('too few on chain: 400 with what is ready and what is on the way', async () => {
    chain.balance = 100;
    const res = await boost();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'insufficient', onChain: 100 });
  });

  it('no posting authority: 428 with the op, then the wallet-signed burn goes through', async () => {
    chain.balance = 3000;
    chain.missingAuthority = true;
    const res = await boost();
    expect(res.statusCode).toBe(428);
    expect(res.json().code).toBe('sign');
    expect(res.json().op[0]).toBe('custom_json');
    const tx = 'cd'.repeat(20);
    txs.set(tx, { status: 'ok', caller: 'hive:fan', contract: 'vsc1test', action: 'burn', payload: '{"amount":"2500"}' });
    const again = await boost({ burnTx: tx });
    expect(again.statusCode).toBe(201);
  });

  it('slow chain: 202 pending, then GET /points/spends/:id shows it done', async () => {
    chain.balance = 3000;
    chain.pending = true;
    const res = await boost();
    expect(res.statusCode).toBe(202);
    const { spendId } = res.json();
    const status = await app.inject({ method: 'GET', url: `/points/spends/${spendId}`, headers: auth.fan });
    expect(status.json()).toMatchObject({ status: 'sent', type: 'boost', amount: 2500 });
    // Somebody else's spend is not found.
    expect((await app.inject({ method: 'GET', url: `/points/spends/${spendId}`, headers: auth.alice })).statusCode).toBe(404);
  });
});

describe('POST /points/daily', () => {
  it('one point a day for the signed-in account', async () => {
    const first = await app.inject({ method: 'POST', url: '/points/daily', headers: auth.fan });
    expect(first.json()).toMatchObject({ awarded: true, points: 1, balance: POINTS_START + 1 });
    const second = await app.inject({ method: 'POST', url: '/points/daily', headers: auth.fan });
    expect(second.json()).toMatchObject({ awarded: false, points: 0 });
    expect((await app.inject({ method: 'POST', url: '/points/daily' })).statusCode).toBe(401);
  });
});

describe('POST /points/awards', () => {
  const send = (headers: Record<string, string>) => app.inject({
    method: 'POST', url: '/points/awards', headers,
    payload: { awards: [{ id: 'rank:2026-11:streams', user: 'fan', kind: 'rank' }] },
  });

  it('needs the shared secret', async () => {
    expect((await send({})).statusCode).toBe(401);
    expect((await send({ 'x-points-award-secret': 'wrong' })).statusCode).toBe(401);
    const ok = await send({ 'x-points-award-secret': 'checker-secret-for-tests' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results).toEqual([{ id: 'rank:2026-11:streams', awarded: true, points: 100 }]);
    expect(await points.get('fan')).toBe(POINTS_START + 100);
  });

  it('only the checker\'s kinds come from outside (a login is ours)', async () => {
    for (const kind of ['login', 'collab', 'pwa', 'quest', 'streak']) {
      const res = await app.inject({
        method: 'POST', url: '/points/awards', headers: { 'x-points-award-secret': 'checker-secret-for-tests' },
        payload: { awards: [{ id: `${kind}:fan:2026-11-26`, user: 'fan', kind }] },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  const checker = (awards: unknown[]) => app.inject({
    method: 'POST', url: '/points/awards', headers: { 'x-points-award-secret': 'checker-secret-for-tests' }, payload: { awards },
  });

  it('the new kinds, with units', async () => {
    const res = await checker([
      { id: 'vodtime:fan:2026-11-25', user: 'fan', kind: 'vodtime', units: 45 },
      { id: 'finish:fan:alice/stream-vod', user: 'fan', kind: 'finish', ref: 'alice/stream-vod' },
      { id: 'tip:lnd-abcdef', user: 'fan', kind: 'tip', ref: 'alice', units: 1000 },
      { id: 'first:fan:stream', user: 'fan', kind: 'first' },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { awarded: boolean; points?: number; reason?: string }) => r.points ?? r.reason))
      .toEqual([90, 5, 200, 'invalid']);
    expect(await points.get('fan')).toBe(POINTS_START + 295);
  });

  it('units must be a whole number', async () => {
    expect((await checker([{ id: 'listen:fan:2026-11-25', user: 'fan', kind: 'listen', units: 2.5 }])).statusCode).toBe(400);
    expect((await checker([{ id: 'listen:fan:2026-11-25', user: 'fan', kind: 'listen', units: -1 }])).statusCode).toBe(400);
  });
});

describe('GET /points/awards/config', () => {
  it('every kind with its amounts and limits', async () => {
    const res = await app.inject({ method: 'GET', url: '/points/awards/config' });
    expect(res.json()).toMatchObject({
      login: 1, rank: 100, remix: 100, remixPerDay: 3,
      kinds: {
        login: 1, first5: 10, vodtime: { perUnit: 2, maxPerDay: 120 }, tip: { amount: 100, perHbd: 100, max: 2000 },
        streak: { amounts: { 7: 20, 30: 100 } }, reach: { amount: 100, minViewers: 20 }, quest: 300, pwa: 50,
      },
      transfer: { min: 1, max: 10_000_000 },
    });
  });
});

describe('GET /points/events', () => {
  afterAll(() => { (config as { POINTS_DOUBLE_WINDOWS: string }).POINTS_DOUBLE_WINDOWS = ''; });

  it('whether double points are on, cached a minute', async () => {
    const off = await app.inject({ method: 'GET', url: '/points/events' });
    expect(off.json()).toEqual({ double: { active: false } });
    expect(off.headers['cache-control']).toBe('public, max-age=60');
    const end = new Date(Date.now() + 3600_000).toISOString();
    (config as { POINTS_DOUBLE_WINDOWS: string }).POINTS_DOUBLE_WINDOWS = `${new Date(Date.now() - 60_000).toISOString()}/${end}`;
    expect((await app.inject({ method: 'GET', url: '/points/events' })).json()).toEqual({ double: { active: true, until: end } });
  });
});

describe('GET /points/quests', () => {
  it('the week\'s quests with progress', async () => {
    const res = await app.inject({ method: 'GET', url: '/points/quests?user=Fan' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(body.quests).toHaveLength(3);
    expect(body.quests[0]).toMatchObject({ progress: 0, done: false, points: 300 });
    expect(body.quests[0].title_key).toBe(`wallet.points.quests.${body.quests[0].id}`);
  });

  it('a Hive account is needed', async () => {
    expect((await app.inject({ method: 'GET', url: '/points/quests?user=guest-123' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/points/quests' })).statusCode).toBe(400);
  });
});

describe('POST /points/pwa', () => {
  it('50 once ever: 200, then 409', async () => {
    expect((await app.inject({ method: 'POST', url: '/points/pwa' })).statusCode).toBe(401);
    const first = await app.inject({ method: 'POST', url: '/points/pwa', headers: auth.fan });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ awarded: true, points: 50, balance: POINTS_START + 50 });
    const again = await app.inject({ method: 'POST', url: '/points/pwa', headers: auth.fan });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ awarded: false, points: 0 });
  });
});
