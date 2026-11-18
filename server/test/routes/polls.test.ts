import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';
import { POINTS_START, memoryPointsStore, memoryPollArchive, resetPolls, setPollStores } from '../../src/lib/polls.js';
import { resetPollBroadcasts } from '../../src/routes/polls.js';

const lk = vi.hoisted(() => ({ rooms: new Map<string, { name: string; metadata: string }>() }));

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(async (names?: string[]) => [...lk.rooms.values()].filter((r) => !names || names.includes(r.name))),
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

const ROOM = 'badadib-poll1';
let app: FastifyInstance;
const auth: Record<string, { authorization: string }> = {};

beforeAll(async () => {
  app = await buildApp();
  for (const u of ['badadib', 'fan', 'fan2']) auth[u] = { authorization: `Bearer ${await makeToken(u)}` };
});

beforeEach(() => {
  vi.clearAllMocks();
  lk.rooms.clear();
  lk.rooms.set(ROOM, { name: ROOM, metadata: JSON.stringify({ host: 'badadib', mode: 'standalone', liveAt: new Date(Date.now() - 90_000).toISOString() }) });
  resetPolls();
  resetPollBroadcasts();
  setPollStores({ points: memoryPointsStore(), archive: memoryPollArchive() });
});
afterEach(() => { vi.useRealTimers(); });

const create = (payload: Record<string, unknown>, who = 'badadib') => app.inject({
  method: 'POST', url: `/rooms/${ROOM}/polls`, headers: auth[who], payload,
});

async function sentPolls() {
  const { roomService } = await import('../../src/lib/livekit.js');
  return vi.mocked(roomService.sendData).mock.calls
    .filter((c) => (c[3] as { topic: string }).topic === 'poll')
    .map((c) => JSON.parse(new TextDecoder().decode(c[1] as Uint8Array)));
}

describe('poll routes', () => {
  it('the host starts a poll, viewers vote once, results go to the room', async () => {
    const res = await create({ question: 'Next game?', options: ['Chess', 'Draw'], durationSec: 60 });
    expect(res.statusCode).toBe(201);
    const { poll } = res.json();
    expect(poll.offset).toBeGreaterThanOrEqual(89);
    const v = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/vote`, headers: auth.fan, payload: { option: 1 } });
    expect(v.statusCode).toBe(200);
    expect(v.json().myVote).toBe(1);
    const again = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/vote`, headers: auth.fan, payload: { option: 0 } });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toBe('You already voted.');

    const active = await app.inject({ method: 'GET', url: `/rooms/${ROOM}/polls/active`, headers: auth.fan });
    expect(active.json()).toMatchObject({ poll: { id: poll.id, total: 1 }, myVote: 1 });
    const anon = await app.inject({ method: 'GET', url: `/rooms/${ROOM}/polls/active` });
    expect(anon.json().myVote).toBeUndefined();

    const sent = await sentPolls();
    expect(sent[0]).toMatchObject({ type: 'poll', poll: { id: poll.id, status: 'open' } });
  });

  it('throttles result broadcasts while votes pour in, then sends the latest', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { poll } = (await create({ question: 'Q?', options: ['A', 'B'], durationSec: 60 })).json();
    await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/vote`, headers: auth.fan, payload: { option: 0 } });
    await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/vote`, headers: auth.fan2, payload: { option: 1 } });
    expect(await sentPolls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    const sent = await sentPolls();
    expect(sent).toHaveLength(2);
    expect(sent[1].poll.total).toBe(2);
  });

  it('only the host starts or ends one, and a bad poll is a 400', async () => {
    expect((await create({ question: 'Q?', options: ['A', 'B'], durationSec: 60 }, 'fan')).statusCode).toBe(403);
    expect((await create({ question: 'Q?', options: ['A'], durationSec: 60 })).statusCode).toBe(400);
    lk.rooms.clear();
    expect((await create({ question: 'Q?', options: ['A', 'B'], durationSec: 60 })).statusCode).toBe(404);
  });

  it('runs a prediction end to end: stake, lock, resolve, points and the archive', async () => {
    const { poll } = (await create({ kind: 'prediction', question: 'Win?', options: ['Yes', 'No'], durationSec: 60 })).json();
    const s1 = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/stake`, headers: auth.fan, payload: { option: 0, amount: 100 } });
    expect(s1.statusCode).toBe(200);
    expect(s1.json()).toMatchObject({ balance: POINTS_START - 100, myStake: { option: 0, amount: 100 } });
    await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/stake`, headers: auth.fan2, payload: { option: 1, amount: 300 } });
    const tooMuch = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/stake`, headers: auth.fan2, payload: { option: 1, amount: POINTS_START } });
    expect(tooMuch.statusCode).toBe(400);

    const mine = await app.inject({ method: 'GET', url: `/rooms/${ROOM}/polls/active`, headers: auth.fan });
    expect(mine.json()).toMatchObject({ myStake: { option: 0, amount: 100 }, balance: POINTS_START - 100 });

    expect((await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/end`, headers: auth.fan, payload: {} })).statusCode).toBe(403);
    const ended = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/end`, headers: auth.badadib, payload: {} });
    expect(ended.json().poll.status).toBe('locked');
    const resolved = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/resolve`, headers: auth.badadib, payload: { winner: 0 } });
    expect(resolved.json().poll).toMatchObject({ status: 'resolved', winner: 0 });

    const bal = await app.inject({ method: 'GET', url: '/points/badadib', headers: auth.fan });
    expect(bal.json()).toEqual({ channel: 'badadib', balance: POINTS_START + 300 });
    const lost = await app.inject({ method: 'GET', url: '/points/BadAdib', headers: auth.fan2 });
    expect(lost.json().balance).toBe(POINTS_START - 300);
    const own = await app.inject({ method: 'GET', url: '/points', headers: auth.fan });
    expect(own.json()).toEqual({ balance: POINTS_START + 300 });
    // The wallet reads anyone's balance without a session, with the earning rules.
    const pub = await app.inject({ method: 'GET', url: '/users/Fan/points' });
    expect(pub.json()).toMatchObject({ account: 'fan', balance: POINTS_START + 300, expiresAt: null, start: POINTS_START, ttlDays: 90, boostMin: 2500 });
    expect(pub.json().earn).toMatchObject({ watchPerMin: 10, streamPerMin: 100, raid: 500, boostMax: 2000 });
    expect((await app.inject({ method: 'GET', url: '/users/x/points' })).statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: `/rooms/${ROOM}/polls` });
    expect(list.json().polls).toHaveLength(1);
    expect(list.json().polls[0]).toMatchObject({ kind: 'prediction', status: 'resolved', pot: 400 });
  });

  it('the host cancels; a later action on it is a 404', async () => {
    const { poll } = (await create({ question: 'Q?', options: ['A', 'B'], durationSec: 60 })).json();
    const c = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/cancel`, headers: auth.badadib, payload: {} });
    expect(c.json().poll.status).toBe('closed');
    const again = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/cancel`, headers: auth.badadib, payload: {} });
    expect(again.statusCode).toBe(404);
  });

  it('voting needs a session', async () => {
    const { poll } = (await create({ question: 'Q?', options: ['A', 'B'], durationSec: 60 })).json();
    const res = await app.inject({ method: 'POST', url: `/rooms/${ROOM}/polls/${poll.id}/vote`, payload: { option: 0 } });
    expect(res.statusCode).toBe(401);
  });
});
