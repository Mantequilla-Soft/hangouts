import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Read when lib/pointsToken.ts loads: answer "pending" at once.
vi.hoisted(() => { process.env.POINTS_SPEND_WAIT_MS = '0'; });

const hive = vi.hoisted(() => ({ accounts: new Set<string>(['fan', 'alice', 'bob', 'carol']) }));
vi.mock('../../src/lib/hive.js', () => ({
  hiveClient: {
    database: {
      getAccounts: vi.fn(async (names: string[]) => names.filter((n) => hive.accounts.has(n)).map((name) => ({ name }))),
    },
  },
}));

/** Live rooms by name: their metadata. */
const lk = vi.hoisted(() => ({
  rooms: new Map<string, Record<string, unknown>>(),
  sent: [] as Array<{ room: string; topic: string; payload: Record<string, unknown> }>,
}));
vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms]
      .filter(([n]) => !names || names.includes(n))
      .map(([name, meta]) => ({ name, metadata: JSON.stringify(meta), numParticipants: 1 }))),
    listParticipants: vi.fn().mockResolvedValue([]),
    updateRoomMetadata: vi.fn(async (name: string, meta: string) => { lk.rooms.set(name, JSON.parse(meta)); }),
    sendData: vi.fn(async (room: string, data: Uint8Array, _kind: unknown, opts: { topic: string }) => {
      lk.sent.push({ room, topic: opts.topic, payload: JSON.parse(new TextDecoder().decode(data)) });
    }),
  },
  generateRoomName: vi.fn().mockReturnValue('test-room'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

const pro = vi.hoisted(() => ({ premium: new Set<string>(), status: new Map<string, Record<string, unknown>>(), grants: [] as string[] }));
vi.mock('../../src/lib/users.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/users.js')>()),
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn(async (u: string) => pro.premium.has(u)),
  getUserStatus: vi.fn(async (u: string) => ({ banned: false, premium: pro.premium.has(u) })),
  getPremiumStatus: vi.fn(async (u: string) => ({
    username: u, premium: pro.premium.has(u), premium_source: null, premium_expires_at: null, testing_started: null, ...(pro.status.get(u) ?? {}),
  })),
  grantProPass: vi.fn(async (u: string) => { pro.grants.push(u); return { ok: true, expiresAt: '2026-11-30T00:00:00.000Z' }; }),
}));

import { buildApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { makeToken } from '../setup.js';
import { setMagiApi, type MagiApi, type MagiTx } from '../../src/lib/magi.js';
import { POINTS_START, memoryPointsStore, setPointsStore } from '../../src/lib/points.js';
import { memoryLedgerStore, setLedgerStore } from '../../src/lib/pointsLedger.js';
import { memoryTokenStore, resetPointsToken, setTokenEnabled, setTokenStore, spendTick } from '../../src/lib/pointsToken.js';
import { memoryAwardStore, setAwardStore, awardDailyLogin, loginStreak, utcDay } from '../../src/lib/pointsAwards.js';
import { memoryShopStores, setShopStores, shopStores, sweepShop, monthOf } from '../../src/lib/pointsShop.js';
import { memoryLiveShopStores, setLiveShopStores, streamExtraMs, sweepShopRooms, EXTRA_MINUTES_MS } from '../../src/lib/shopLive.js';
import { memoryAccountShopStores, setAccountShopStores, accountShopStores } from '../../src/lib/shopAccount.js';
import { setShopCheckerFetch, setShopCheckerRetryDelays } from '../../src/lib/shopChecker.js';
import { streamCapMs, FREE_STREAM_CAP_MS } from '../../src/lib/headlessStreams.js';
import { resetPolls, activePoll } from '../../src/lib/polls.js';

const SECRET = 'checker-secret-for-tests';
const ROOM = 'alice-abc1234';
let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};

const chain = { balance: 0 };
const txs = new Map<string, MagiTx>();
let n = 0;
const magi: MagiApi = {
  async read(calls) { return calls.map(() => ({ ok: true, ret: { balance: String(chain.balance), granted: true } })); },
  async tx(id) { return txs.get(id) ?? null; },
  async call(user, _key, action, payload) {
    const tx = (++n).toString(16).padStart(40, '0');
    txs.set(tx, { status: 'ok', caller: `hive:${user}`, contract: 'vsc1test', action, payload: JSON.stringify(payload) });
    return tx;
  },
};

/** The checker: answers to /points/grant/check and PUT /points/grant, recorded. */
const checker = {
  check: { ok: true } as Record<string, unknown>,
  grants: [] as Array<{ status: number; body: Record<string, unknown> }>,
  puts: [] as Array<Record<string, unknown>>,
  checks: [] as string[],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://checker.test/points/grant/check?')) { checker.checks.push(url); return json(200, checker.check); }
  if (url === 'https://checker.test/points/grant' && init?.method === 'PUT') {
    checker.puts.push(JSON.parse(String(init.body)));
    const next = checker.grants.shift() ?? { status: 200, body: { ok: true } };
    return json(next.status, next.body);
  }
  return json(404, { message: 'Not found' });
});

beforeAll(async () => {
  (config as { POINTS_TOKEN_CONTRACT: string }).POINTS_TOKEN_CONTRACT = 'vsc1test';
  (config as { POINTS_SPEND_SIGNER_POSTING_KEY: string }).POINTS_SPEND_SIGNER_POSTING_KEY = 'signer-key';
  (config as { CHECKER_URL: string }).CHECKER_URL = 'https://checker.test/';
  app = await buildApp({ logger: false });
  for (const u of ['fan', 'alice', 'bob', 'carol']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});
afterAll(() => {
  (config as { POINTS_TOKEN_CONTRACT: string }).POINTS_TOKEN_CONTRACT = '';
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
  setTokenEnabled(null);
  setShopCheckerFetch(null);
  setShopCheckerRetryDelays([1000, 3000, 6000]);
  setShopStores(null);
  setLiveShopStores(null);
  setAccountShopStores(null);
});

let points: ReturnType<typeof memoryPointsStore>;
let ledger: ReturnType<typeof memoryLedgerStore>;
beforeEach(() => {
  points = memoryPointsStore();
  setPointsStore(points);
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  const token = memoryTokenStore();
  token.airdrop = true;
  setTokenStore(token);
  setTokenEnabled(false);
  resetPointsToken();
  setMagiApi(magi);
  setAwardStore(memoryAwardStore());
  setShopStores(memoryShopStores());
  setLiveShopStores(memoryLiveShopStores());
  setAccountShopStores(memoryAccountShopStores());
  setShopCheckerFetch(fakeFetch as unknown as typeof fetch);
  setShopCheckerRetryDelays([0, 0, 0]);
  Object.assign(checker, { check: { ok: true }, grants: [], puts: [], checks: [] });
  (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = SECRET;
  lk.rooms.clear();
  lk.rooms.set(ROOM, { host: 'alice', mode: 'standalone' });
  lk.sent.length = 0;
  pro.premium.clear();
  pro.status.clear();
  pro.grants.length = 0;
  resetPolls();
  for (const u of ['fan', 'alice', 'bob', 'carol']) points.balances.set(u, 100_000);
});

// A fresh address per request: the routes allow a few a minute per IP.
let ip = 0;
const addr = () => `10.1.${Math.floor(++ip / 250)}.${ip % 250}`;
const shop = (item: string, body: Record<string, unknown> = {}, who = 'fan') => app.inject({
  method: 'POST', url: '/points/shop/buy', headers: auth[who], remoteAddress: addr(), payload: { item, ...body },
});
const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: unknown) => app.inject({
  method, url, ...(who ? { headers: auth[who] } : {}), remoteAddress: addr(), ...(payload !== undefined ? { payload } : {}),
});
const bal = (u: string) => points.balances.get(u) ?? POINTS_START;

describe('GET /points/shop', () => {
  it('lists every item with its price; checker items only with the checker secret', async () => {
    let res = await call('GET', '/points/shop');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.highlight).toMatchObject({ enabled: true, price: 500 });
    expect(body.items.proday).toMatchObject({ enabled: true, price: 50_000 });
    expect(body.items.publishslot).toMatchObject({ enabled: true, price: 25_000 });
    expect(body.cosmetics['color-gold']).toEqual({ kind: 'color', price: 2000 });
    expect(body.stickers.fire).toBe('🔥');
    (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
    res = await call('GET', '/points/shop');
    expect(res.json().items.publishslot.enabled).toBe(false);
    expect(res.json().items.spotlight.enabled).toBe(false);
  });

  it('turns down what is unknown, or off', async () => {
    expect((await shop('nothing')).statusCode).toBe(404);
    (config as { POINTS_AWARD_SECRET: string }).POINTS_AWARD_SECRET = '';
    expect((await shop('publishslot', { kind: 'video' })).statusCode).toBe(404);
    expect(bal('fan')).toBe(100_000);
  });

  it('needs a session, and the points', async () => {
    expect((await app.inject({ method: 'POST', url: '/points/shop/buy', payload: { item: 'highlight' } })).statusCode).toBe(401);
    points.balances.set('fan', 10);
    const res = await shop('highlight', { room: ROOM, text: 'hi' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('insufficient');
  });
});

describe('live items', () => {
  it('highlight: a pinned chat line, the points spent and counted for the host', async () => {
    const res = await shop('highlight', { room: ROOM, text: '  Great   stream! ' });
    expect(res.statusCode).toBe(201);
    expect(res.json().order).toMatchObject({ item: 'highlight', status: 'done', price: 500, channel: 'alice' });
    expect(bal('fan')).toBe(99_500);
    const line = lk.sent.find((s) => s.topic === 'chat');
    expect(line?.payload).toMatchObject({ type: 'system', text: 'Great stream!', system: { kind: 'highlight', from: 'fan' } });
    expect((lk.rooms.get(ROOM)?.pinnedChat as { text: string }).text).toBe('Great stream!');
    const sup = await call('GET', '/channels/alice/supporters');
    expect(sup.json().top).toEqual([{ user: 'fan', points: 500 }]);
  });

  it('highlight: a stream that is not live costs nothing', async () => {
    const res = await shop('highlight', { room: 'bob-zzz9999', text: 'hi' });
    expect(res.statusCode).toBe(404);
    expect(bal('fan')).toBe(100_000);
  });

  it('readaloud: an event on the boost topic, unless the host switched it off', async () => {
    let res = await shop('readaloud', { room: ROOM, text: 'Hello Alice' });
    expect(res.statusCode).toBe(201);
    expect(lk.sent.find((s) => s.topic === 'boost')?.payload).toMatchObject({ type: 'readaloud', sender: 'fan', message: 'Hello Alice' });
    lk.rooms.set(ROOM, { host: 'alice', boost: { alerts: { readAloud: false } } });
    res = await shop('readaloud', { room: ROOM, text: 'again' });
    expect(res.statusCode).toBe(409);
    expect(bal('fan')).toBe(99_000);
  });

  it('suggestpoll: held for the host; accept runs it, reject gives the points back', async () => {
    const res = await shop('suggestpoll', { room: ROOM, question: 'Next game?', options: ['Chess', 'Go'] });
    expect(res.statusCode).toBe(201);
    expect(res.json().order.status).toBe('held');
    expect(bal('fan')).toBe(98_000);
    const list = await call('GET', `/rooms/${ROOM}/poll-suggestions`);
    const [s] = list.json().suggestions;
    expect(s).toMatchObject({ from: 'fan', question: 'Next game?', options: ['Chess', 'Go'] });
    expect((await call('POST', `/rooms/${ROOM}/poll-suggestions/${s.id}/accept`, 'fan', {})).statusCode).toBe(403);
    const ok = await call('POST', `/rooms/${ROOM}/poll-suggestions/${s.id}/accept`, 'alice', { durationSec: 30 });
    expect(ok.statusCode).toBe(201);
    expect(activePoll(ROOM)?.question).toBe('Next game?');
    expect((await shopStores().orders.findOne({ id: s.id }))?.status).toBe('done');

    const two = await shop('suggestpoll', { room: ROOM, question: 'Snack?', options: ['Yes', 'No'] });
    await call('POST', `/rooms/${ROOM}/poll-suggestions/${two.json().order.id}/reject`, 'alice', {});
    expect(bal('fan')).toBe(98_000);
    expect(ledger.rows.some((r) => r.kind === 'refund' && r.user === 'fan' && r.delta === 2000)).toBe(true);
  });

  it('suggestpoll: the host cannot suggest, options are checked, and an ended stream refunds', async () => {
    expect((await shop('suggestpoll', { room: ROOM, question: 'Q', options: ['A', 'B'] }, 'alice')).statusCode).toBe(400);
    expect((await shop('suggestpoll', { room: ROOM, question: 'Q', options: ['A'] })).statusCode).toBe(400);
    expect((await shop('suggestpoll', { room: ROOM, question: 'Q', options: ['A', 'a'] })).statusCode).toBe(400);
    await shop('suggestpoll', { room: ROOM, question: 'Q', options: ['A', 'B'] });
    expect(bal('fan')).toBe(98_000);
    await sweepShopRooms(new Set());
    expect(bal('fan')).toBe(100_000);
  });

  it('rewards: the host sets them, a viewer redeems, the host works the queue', async () => {
    const saved = await call('PUT', '/channels/rewards', 'alice', { rewards: [
      { title: 'Pick the next game', cost: 3000, prompt: true },
      { title: 'Ten push-ups', cost: 1000 },
      { title: 'Off', cost: 500, enabled: false },
    ] });
    expect(saved.statusCode).toBe(200);
    const [pick, push, off] = saved.json().rewards;
    expect((await call('GET', '/channels/alice/rewards')).json().rewards).toHaveLength(3);
    expect((await call('PUT', '/channels/rewards', 'alice', { rewards: [{ title: 'Cheap', cost: 5 }] })).statusCode).toBe(400);

    expect((await shop('reward', { room: ROOM, rewardId: pick.id })).statusCode).toBe(400); // needs the text
    expect((await shop('reward', { room: ROOM, rewardId: off.id })).statusCode).toBe(404);
    const a = await shop('reward', { room: ROOM, rewardId: pick.id, input: 'Chess' });
    const b = await shop('reward', { room: ROOM, rewardId: push.id }, 'bob');
    expect(a.statusCode).toBe(201);
    expect(bal('fan')).toBe(97_000);
    expect(lk.sent.some((s) => s.topic === 'rewards' && s.payload.type === 'reward-redeemed')).toBe(true);

    expect((await call('GET', `/rooms/${ROOM}/rewards/queue`, 'fan')).statusCode).toBe(403);
    const queue = (await call('GET', `/rooms/${ROOM}/rewards/queue`, 'alice')).json().queue;
    expect(queue.map((q: { title: string; input?: string }) => [q.title, q.input])).toEqual([['Pick the next game', 'Chess'], ['Ten push-ups', undefined]]);
    await call('POST', `/rooms/${ROOM}/rewards/${a.json().order.id}/done`, 'alice');
    await call('POST', `/rooms/${ROOM}/rewards/${b.json().order.id}/refund`, 'alice');
    expect(bal('fan')).toBe(97_000);
    expect(bal('bob')).toBe(100_000);
    expect((await call('GET', `/rooms/${ROOM}/rewards/queue`, 'alice')).json().queue).toEqual([]);
    expect((await call('POST', `/rooms/${ROOM}/rewards/${a.json().order.id}/done`, 'alice')).statusCode).toBe(404);
  });

  it('bounty: pledges add up; done pays the host, declined gives them back', async () => {
    const first = await shop('bounty', { room: ROOM, text: 'Sing a song', amount: 500 });
    expect(first.statusCode).toBe(201);
    const id = first.json().order.result.bounty.id;
    await shop('bounty', { room: ROOM, bountyId: id, amount: 700 }, 'bob');
    let open = (await call('GET', `/rooms/${ROOM}/bounties`)).json().bounties;
    expect(open[0]).toMatchObject({ id, total: 1200, backers: 2, text: 'Sing a song' });
    expect((await shop('bounty', { room: ROOM, text: 'x', amount: 10 })).statusCode).toBe(400);
    expect((await call('POST', `/rooms/${ROOM}/bounties/${id}/done`, 'fan')).statusCode).toBe(403);
    const done = await call('POST', `/rooms/${ROOM}/bounties/${id}/done`, 'alice');
    expect(done.json().bounty.status).toBe('done');
    expect(bal('alice')).toBe(101_200);
    expect(ledger.rows.filter((r) => r.kind === 'payout').map((r) => r.delta)).toEqual([500, 700]);

    const next = await shop('bounty', { room: ROOM, text: 'Dance', amount: 300 });
    await call('POST', `/rooms/${ROOM}/bounties/${next.json().order.result.bounty.id}/decline`, 'alice');
    expect(bal('fan')).toBe(99_500);
    open = (await call('GET', `/rooms/${ROOM}/bounties`)).json().bounties;
    expect(open).toEqual([]);
  });

  it('stickers: unlocked once per channel', async () => {
    expect((await shop('stickers', { channel: '@alice' })).statusCode).toBe(201);
    expect((await shop('stickers', { channel: 'alice' })).statusCode).toBe(409);
    expect((await call('GET', '/users/fan/cosmetics')).json().stickers).toEqual(['alice']);
  });

  it('minutes: 30 more for today, never for Pro, at most four a day', async () => {
    expect((await shop('minutes')).statusCode).toBe(201);
    expect(await streamExtraMs('fan')).toBe(EXTRA_MINUTES_MS);
    expect((await call('GET', '/points/stream-extra', 'fan')).json().extraMs).toBe(EXTRA_MINUTES_MS);
    expect(streamCapMs(false, EXTRA_MINUTES_MS)).toBe(FREE_STREAM_CAP_MS + EXTRA_MINUTES_MS);
    for (let i = 0; i < 3; i += 1) await shop('minutes');
    expect((await shop('minutes')).statusCode).toBe(429);
    pro.premium.add('bob');
    expect((await shop('minutes', {}, 'bob')).statusCode).toBe(409);
  });
});

describe('account items', () => {
  it('cosmetics: bought, given, worn only when owned', async () => {
    expect((await shop('cosmetic', { id: 'color-gold' })).statusCode).toBe(201);
    expect((await shop('cosmetic', { id: 'color-gold' })).statusCode).toBe(409);
    expect((await shop('cosmetic', { id: 'frame-neon', to: 'bob' })).statusCode).toBe(201);
    expect((await shop('cosmetic', { id: 'frame-neon', to: 'nobody' })).statusCode).toBe(404);
    expect((await shop('cosmetic', { id: 'hat' })).statusCode).toBe(404);
    expect(bal('fan')).toBe(100_000 - 2000 - 5000);

    expect((await call('PUT', '/points/cosmetics', 'fan', { frame: 'frame-neon' })).statusCode).toBe(400);
    const worn = await call('PUT', '/points/cosmetics', 'fan', { color: 'color-gold' });
    expect(worn.json()).toMatchObject({ owned: ['color-gold'], equipped: { color: 'color-gold' } });
    expect((await call('GET', '/users/bob/cosmetics')).json().owned).toEqual(['frame-neon']);
    const off = await call('PUT', '/points/cosmetics', 'fan', { color: null });
    expect(off.json().equipped).toEqual({});
  });

  it('proday: a day of Pro, also as a gift; never over a subscription', async () => {
    expect((await shop('proday')).statusCode).toBe(201);
    expect((await shop('proday', { to: 'bob' })).statusCode).toBe(201);
    expect(pro.grants).toEqual(['fan', 'bob']);
    expect(bal('fan')).toBe(0);
    pro.premium.add('carol');
    pro.status.set('carol', { premium_source: 'subs', premium_expires_at: null });
    points.balances.set('fan', 100_000);
    const res = await shop('proday', { to: 'carol' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('already_pro');
    expect(bal('fan')).toBe(100_000);
  });

  it('audiolong: a 20-minute grant for snapieaudio, three open at most, not for Pro', async () => {
    for (let i = 0; i < 3; i += 1) expect((await shop('audiolong')).statusCode).toBe(201);
    expect((await shop('audiolong')).statusCode).toBe(429);
    const grants = (await call('GET', '/points/audio-grants', 'fan')).json().grants;
    expect(grants).toHaveLength(3);
    expect(grants[0].extraSeconds).toBe(1200);
    expect((accountShopStores().audio as unknown as { docs: { usedAt: null; spendId: string }[] }).docs[0].usedAt).toBeNull();
    pro.premium.add('bob');
    expect((await shop('audiolong', {}, 'bob')).statusCode).toBe(409);
  });

  it('streakfreeze: covers a missed day so the streak goes on, two a month', async () => {
    const DAY = 86_400_000;
    const now = Date.now();
    // Signed in 4 and 3 days ago, missed 2 days ago, signed in yesterday.
    for (const d of [4, 3, 1]) await awardDailyLogin('fan', now - d * DAY);
    expect((await loginStreak('fan', now)).run).toBe(1);
    const streak = (await call('GET', '/points/streak', 'fan')).json();
    expect(streak.missed).toContain(utcDay(now - 2 * DAY));
    expect(streak.missed).not.toContain(utcDay(now - 1 * DAY));
    expect(streak.freezesLeft).toBe(2);
    expect((await shop('streakfreeze', { day: utcDay(now - 1 * DAY) })).statusCode).toBe(409);
    expect((await shop('streakfreeze', { day: utcDay(now - 2 * DAY) })).statusCode).toBe(201);
    expect((await loginStreak('fan', now)).run).toBe(4);
    await shop('streakfreeze', { day: utcDay(now - 5 * DAY) });
    const third = await shop('streakfreeze', { day: utcDay(now - 6 * DAY) });
    // Two a month (a month boundary in between would allow the third).
    if (monthOf(now) === monthOf(now - 6 * DAY)) expect(third.statusCode).toBe(429);
  });

  it('supporters: per channel, the badge past the minimum, and the monthly board', async () => {
    await shop('bounty', { room: ROOM, text: 'Juggle', amount: 12_000 });
    await shop('highlight', { room: ROOM, text: 'hey' }, 'bob');
    const id = (await call('GET', `/rooms/${ROOM}/bounties`)).json().bounties[0].id;
    await call('POST', `/rooms/${ROOM}/bounties/${id}/done`, 'alice');
    const sup = (await call('GET', '/channels/alice/supporters')).json();
    expect(sup.top).toEqual([{ user: 'fan', points: 12_000 }, { user: 'bob', points: 500 }]);
    expect(sup.badges).toEqual(['fan']);
    const board = (await call('GET', '/points/supporters')).json();
    expect(board.top[0]).toEqual({ user: 'fan', points: 12_000, channels: 1 });
  });
});

describe('content requests', () => {
  it('delivered and approved: the creator gets the points', async () => {
    const res = await shop('request', { creator: 'alice', text: 'A video about Hive witnesses', amount: 2000 });
    expect(res.statusCode).toBe(201);
    const id = res.json().order.id;
    expect((await call('GET', '/points/requests?role=creator', 'alice')).json().requests[0]).toMatchObject({ id, from: 'fan', state: 'open' });
    expect((await call('GET', '/channels/alice/requests')).json().requests).toHaveLength(1);
    expect((await call('POST', `/points/requests/${id}/approve`, 'fan', {})).statusCode).toBe(409);
    expect((await call('POST', `/points/requests/${id}/deliver`, 'bob', { permlink: 'abc' })).statusCode).toBe(403);
    const d = await call('POST', `/points/requests/${id}/deliver`, 'alice', { permlink: 'witness-video' });
    expect(d.json().request).toMatchObject({ state: 'delivered', permlink: 'witness-video' });
    expect((await call('POST', `/points/requests/${id}/cancel`, 'fan', {})).statusCode).toBe(409);
    const ok = await call('POST', `/points/requests/${id}/approve`, 'fan', {});
    expect(ok.json().request.state).toBe('done');
    expect(bal('alice')).toBe(102_000);
    expect(bal('fan')).toBe(98_000);
  });

  it('declined or taken back: the points come back; not for yourself, not too few', async () => {
    expect((await shop('request', { creator: 'fan', text: 'x', amount: 2000 })).statusCode).toBe(400);
    expect((await shop('request', { creator: 'alice', text: 'x', amount: 10 })).statusCode).toBe(400);
    const a = (await shop('request', { creator: 'alice', text: 'One', amount: 2000 })).json().order.id;
    const b = (await shop('request', { creator: 'alice', text: 'Two', amount: 3000 })).json().order.id;
    await call('POST', `/points/requests/${a}/decline`, 'alice', {});
    await call('POST', `/points/requests/${b}/cancel`, 'fan', {});
    expect(bal('fan')).toBe(100_000);
  });

  it('time runs out: delivered pays the creator, never delivered comes back', async () => {
    const a = (await shop('request', { creator: 'alice', text: 'One', amount: 2000 })).json().order.id;
    const b = (await shop('request', { creator: 'bob', text: 'Two', amount: 3000 })).json().order.id;
    await call('POST', `/points/requests/${a}/deliver`, 'alice', { permlink: 'one' });
    await sweepShop(Date.now() + 15 * 86_400_000);
    expect(bal('alice')).toBe(102_000);
    expect(bal('bob')).toBe(100_000);
    expect(bal('fan')).toBe(98_000);
    expect((await shopStores().orders.findOne({ id: b }))?.status).toBe('refunded');
  });
});

describe('checker items', () => {
  it('asks the checker first: a refusal costs nothing', async () => {
    checker.check = { ok: false, error: 'not_a_live_story', message: 'That Story is over.' };
    const res = await shop('story48', { author: 'fan', permlink: 'my-story' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_a_live_story', message: 'That Story is over.' });
    expect(bal('fan')).toBe(100_000);
    expect(checker.puts).toEqual([]);
  });

  it('books the grant under the spend, with the item fields', async () => {
    const res = await shop('publishslot', { kind: 'short' });
    expect(res.statusCode).toBe(201);
    expect(checker.checks[0]).toContain('item=publishslot');
    expect(checker.puts[0]).toMatchObject({ item: 'publishslot', user: 'fan', kind: 'short', points: 25_000 });
    expect(typeof checker.puts[0].spendId).toBe('string');
    expect(bal('fan')).toBe(75_000);
  });

  it('a grant the checker turns down gives the points back', async () => {
    checker.grants.push({ status: 409, body: { error: 'ended', message: 'The premiere is over.' } });
    const res = await shop('premierefront', { owner: 'alice', permlink: 'premiere' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Your points are back.');
    expect(bal('fan')).toBe(100_000);
  });

  it('only your own Story or video; ad credit is priced per HBD', async () => {
    expect((await shop('story48', { author: 'alice', permlink: 's' })).statusCode).toBe(403);
    expect((await shop('encode', { author: 'alice', permlink: 's' })).statusCode).toBe(403);
    expect((await shop('encode', { author: 'fan', permlink: 'my-video' })).statusCode).toBe(201);
    const ad = await shop('adcredit', { campaignId: 'abcdef123456', hbd: 1.5 });
    expect(ad.statusCode).toBe(201);
    expect(ad.json().order.price).toBe(15_000);
    expect(checker.puts.at(-1)).toMatchObject({ item: 'adcredit', campaignId: 'abcdef123456', hbd: 1.5 });
    expect((await shop('storyfreeze', { day: 'yesterday' })).statusCode).toBe(400);
  });
});

describe('home spotlight auction', () => {
  it('the top bid stays, lower ones come back, and the week start books the winner', async () => {
    expect((await shop('spotlight', { author: 'fan', permlink: 'v', bid: 100 })).statusCode).toBe(409);
    expect((await shop('spotlight', { author: 'fan', permlink: 'v', bid: 20_000 })).statusCode).toBe(201);
    expect((await shop('spotlight', { author: 'bob', permlink: 'w', bid: 20_500 }, 'bob')).statusCode).toBe(409);
    expect((await shop('spotlight', { author: 'bob', permlink: 'w', bid: 21_000 }, 'bob')).statusCode).toBe(201);
    expect(bal('fan')).toBe(100_000);
    expect(bal('bob')).toBe(79_000);
    const state = (await call('GET', '/points/spotlight', 'bob')).json();
    expect(state.top).toMatchObject({ bid: 21_000, author: 'bob', permlink: 'w', mine: true });

    await sweepShop(state.endsAt + 1000);
    const grant = checker.puts.find((p) => p.item === 'spotlight');
    expect(grant).toMatchObject({ user: 'bob', author: 'bob', permlink: 'w', week: state.week, bid: 21_000 });
    expect(bal('bob')).toBe(79_000);
    expect((await call('GET', '/points/spotlight')).json().top).toBeNull();
  });

  it('a winner the checker refuses comes back', async () => {
    await shop('spotlight', { author: 'fan', permlink: 'v', bid: 20_000 });
    checker.grants.push({ status: 409, body: { error: 'ineligible' } });
    const { endsAt } = (await call('GET', '/points/spotlight')).json();
    await sweepShop(endsAt + 1000);
    expect(bal('fan')).toBe(100_000);
  });
});

describe('with the 3SP token', () => {
  it('a shop order burns first and happens once the burn is confirmed', async () => {
    setTokenEnabled(true);
    chain.balance = 50_000;
    const res = await shop('highlight', { room: ROOM, text: 'on chain' });
    expect(res.statusCode).toBe(201);
    const order = res.json().order;
    expect(order).toMatchObject({ status: 'done', spendId: expect.any(String) });
    expect(lk.sent.some((s) => s.topic === 'chat' && s.payload.text === 'on chain')).toBe(true);
    expect(ledger.rows.some((r) => r.kind === 'spend' && r.user === 'fan' && r.delta === -500 && r.ref === 'shop:highlight:alice')).toBe(true);
    expect((await call('GET', `/points/shop/orders/${order.id}`, 'fan')).json().order.status).toBe('done');
    expect((await call('GET', `/points/shop/orders/${order.id}`, 'bob')).statusCode).toBe(404);
  });

  it('a burned order that cannot happen any more is refunded', async () => {
    setTokenEnabled(true);
    chain.balance = 50_000;
    const { roomService } = await import('../../src/lib/livekit.js');
    vi.mocked(roomService.sendData).mockRejectedValueOnce(new Error('room gone'));
    const res = await shop('readaloud', { room: ROOM, text: 'too late' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Your points are back.');
    const [order] = await shopStores().orders.find({ item: 'readaloud' });
    expect(order.status).toBe('refunded');
    expect(ledger.rows.some((r) => r.kind === 'refund' && r.user === 'fan' && r.delta === 1000)).toBe(true);
  });
});
