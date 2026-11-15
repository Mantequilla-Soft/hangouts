import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ParticipantInfo_State } from '@livekit/protocol';
import {
  BATTLE_DURATIONS, DROP_GRACE_MS, INVITE_TTL_MS, LEAD_IN_MS, SETTLE_GRACE_MS, BattleError,
  addBoost, battleBusy, battleCandidates, boostCounts, decideWinner, eligibility, endBattle, endBattleBy,
  getBattle, inviteBattle, linkToken, pendingBattleTimers, readBattle, recordBattleBoost, respondBattle,
  settleBattle, sideOf, sideOfHost, startBattle, other, type Battle,
} from '../../src/lib/battles.js';

vi.mock('../../src/lib/livekit.js', () => ({ roomService: {} }));

/** Stateful LiveKit fake: rooms with metadata, and who is connected where. */
function fakeLk() {
  const rooms = new Map<string, { name: string; metadata: string }>();
  const present = new Map<string, string[]>();
  const lk = {
    rooms,
    present,
    listRooms: vi.fn(async (names?: string[]) => [...rooms.values()]
      .filter((r) => !names || names.includes(r.name)).map((r) => ({ ...r }))),
    updateRoomMetadata: vi.fn(async (name: string, metadata: string) => {
      const r = rooms.get(name);
      if (!r) throw new Error('Room not found');
      r.metadata = metadata;
    }),
    listParticipants: vi.fn(async (name: string) => (present.get(name) ?? [])
      .map((identity) => ({ identity, state: ParticipantInfo_State.ACTIVE }))),
    meta: (name: string) => JSON.parse(rooms.get(name)!.metadata) as Record<string, unknown>,
    battle: (name: string) => readBattle(JSON.parse(rooms.get(name)!.metadata)),
    stream(name: string, host: string, extra: Record<string, unknown> = {}) {
      rooms.set(name, {
        name,
        metadata: JSON.stringify({
          host, mode: 'standalone', broadcasting: true, title: `${host} live`,
          createdAt: '2026-11-15T10:00:00.000Z', ...extra,
        }),
      });
      present.set(name, [host]);
    },
  };
  return lk;
}

const T0 = Date.parse('2026-11-15T12:00:00.000Z');

function baseBattle(over: Partial<Battle> = {}): Battle {
  return {
    id: 'b1', state: 'invited', durationSec: 300,
    a: { host: 'badadib', room: 'badadib-aaa', hbd: 0, count: 0 },
    b: { host: 'fan', room: 'fan-bbb', hbd: 0, count: 0 },
    invitedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + INVITE_TTL_MS).toISOString(),
    ...over,
  };
}

describe('battle model (pure)', () => {
  it('reads a stored battle defensively', () => {
    expect(readBattle({})).toBeNull();
    expect(readBattle({ battle: 'x' })).toBeNull();
    expect(readBattle({ battle: { id: 'x', state: 'weird', a: {}, b: {} } })).toBeNull();
    expect(readBattle({ battle: { id: 'x', state: 'live', a: { host: 'a' }, b: { host: 'b', room: 'r' } } })).toBeNull();
    const b = readBattle({ battle: { ...baseBattle(), durationSec: 42, a: { host: 'badadib', room: 'r1', hbd: -3, count: 'x', title: 'Hi' }, winner: null, endReason: 'ended', endedBy: 'fan' } });
    expect(b?.durationSec).toBe(300);
    expect(b?.a).toEqual({ host: 'badadib', room: 'r1', title: 'Hi', hbd: 0, count: 0 });
    expect(b?.winner).toBeNull();
    expect(b?.endReason).toBe('ended');
    expect(b?.endedBy).toBe('fan');
    const bare = readBattle({ battle: { id: 'x', state: 'ended', a: { host: 'a', room: 'r' }, b: { host: 'b', room: 's' } } });
    expect(bare?.invitedAt).toBe(new Date(0).toISOString());
    expect(bare?.winner).toBeUndefined();
  });

  it('knows busy, sides and the boost window', () => {
    const inv = baseBattle();
    expect(battleBusy(null)).toBe(false);
    expect(battleBusy(inv, T0)).toBe(true);
    expect(battleBusy(inv, T0 + INVITE_TTL_MS)).toBe(false);
    const live = startBattle(inv, T0);
    expect(battleBusy(live, T0 + 10 * 60_000)).toBe(true);
    expect(battleBusy(endBattle(live, 'time', T0), T0)).toBe(false);
    expect(sideOf(inv, 'badadib-aaa')).toBe('a');
    expect(sideOf(inv, 'fan-bbb')).toBe('b');
    expect(sideOf(inv, 'nope')).toBeNull();
    expect(sideOfHost(inv, 'fan')).toBe('b');
    expect(sideOfHost(inv, 'badadib')).toBe('a');
    expect(sideOfHost(inv, 'x')).toBeNull();
    expect(other('a')).toBe('b');
    expect(other('b')).toBe('a');

    expect(live.startedAt).toBe(new Date(T0 + LEAD_IN_MS).toISOString());
    expect(Date.parse(live.endsAt!) - Date.parse(live.startedAt!)).toBe(300_000);
    expect(Date.parse(live.settleAt!) - Date.parse(live.endsAt!)).toBe(SETTLE_GRACE_MS);
    expect(boostCounts(inv, T0)).toBe(false);
    expect(boostCounts(live, T0)).toBe(false); // lead-in
    expect(boostCounts(live, T0 + LEAD_IN_MS)).toBe(true);
    expect(boostCounts(live, Date.parse(live.endsAt!))).toBe(true);
    expect(boostCounts(live, Date.parse(live.endsAt!) + 1)).toBe(false);
    expect(boostCounts(live, NaN)).toBe(false);
  });

  it('adds boosts and decides the winner', () => {
    let b = startBattle(baseBattle(), T0);
    expect(decideWinner(b)).toBe('tie');
    b = addBoost(b, 'a', 1.2345);
    b = addBoost(b, 'b', 2);
    b = addBoost(b, 'a', -5);
    expect(b.a).toMatchObject({ hbd: 1.235, count: 2 });
    expect(decideWinner(b)).toBe('b');
    expect(decideWinner(addBoost(b, 'a', 5))).toBe('a');
    expect(endBattle(b, 'time', T0).winner).toBe('b');
    const early = endBattle(b, 'ended', T0, 'fan');
    expect(early).toMatchObject({ state: 'ended', winner: null, endReason: 'ended', endedBy: 'fan' });
  });

  it('says why a room cannot battle', () => {
    const ok = { mode: 'standalone', broadcasting: true };
    expect(eligibility(null)).toMatch(/ended/);
    expect(eligibility({ mode: 'conference' })).toMatch(/live streams/);
    expect(eligibility({ ...ok, headless: true })).toMatch(/OBS/);
    expect(eligibility({ mode: 'standalone' })).toMatch(/not live/);
    expect(eligibility({ ...ok, collabGuest: 'x' })).toMatch(/guest/);
    expect(eligibility({ ...ok, battle: baseBattle() }, T0)).toMatch(/already/);
    expect(eligibility({ ...ok, battle: baseBattle() }, T0 + INVITE_TTL_MS)).toBeNull();
    expect(eligibility(ok)).toBeNull();
  });
});

describe('battle flow (LiveKit metadata)', () => {
  let lk: ReturnType<typeof fakeLk>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    lk = fakeLk();
    lk.stream('badadib-aaa', 'badadib');
    lk.stream('fan-bbb', 'fan');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('invites by name, writes the same battle to both rooms, and the invite expires', async () => {
    const b = await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: '@Fan', durationSec: 180 }, lk);
    expect(b).toMatchObject({ state: 'invited', durationSec: 180, a: { host: 'badadib', room: 'badadib-aaa', title: 'badadib live' }, b: { host: 'fan', room: 'fan-bbb' } });
    expect(lk.battle('badadib-aaa')).toEqual(b);
    expect(lk.battle('fan-bbb')).toEqual(b);
    expect(pendingBattleTimers()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(INVITE_TTL_MS + 10);
    expect(lk.battle('fan-bbb')).toMatchObject({ state: 'ended', endReason: 'expired', winner: null });
    expect(lk.battle('badadib-aaa')?.state).toBe('ended');
  });

  it('invites by room name too and refuses the wrong cases', async () => {
    const reject = (p: Promise<unknown>) => p.then(() => null, (e: BattleError) => e);
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 120 }, lk))).toMatchObject({ status: 400, code: 'bad_duration' });
    expect(await reject(inviteBattle({ room: 'zzz', by: 'badadib', opponent: 'fan', durationSec: 180 }, lk))).toMatchObject({ status: 404 });
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'fan', opponent: 'fan', durationSec: 180 }, lk))).toMatchObject({ status: 403 });
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'nobody', durationSec: 180 }, lk))).toMatchObject({ code: 'no_stream' });
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: '  ', durationSec: 180 }, lk))).toMatchObject({ code: 'no_stream' });
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'badadib-aaa', durationSec: 180 }, lk))).toMatchObject({ code: 'self' });

    lk.stream('obs-room', 'obsfan', { headless: true });
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'obs-room', durationSec: 180 }, lk))).toMatchObject({ code: 'opponent_not_eligible', message: expect.stringMatching(/OBS/) });

    lk.present.set('fan-bbb', ['fan~watch']);
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan-bbb', durationSec: 180 }, lk))).toMatchObject({ code: 'opponent_away' });
    lk.present.set('fan-bbb', ['fan']);

    lk.stream('badadib-aaa', 'badadib', { broadcasting: false });
    expect(await reject(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 180 }, lk))).toMatchObject({ code: 'not_eligible' });
    lk.stream('badadib-aaa', 'badadib');

    const ok = await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan-bbb', durationSec: 600 }, lk);
    expect(ok.b.room).toBe('fan-bbb');
    // Someone else can't invite either side while the invite is open.
    lk.stream('third-ccc', 'third');
    expect(await reject(inviteBattle({ room: 'third-ccc', by: 'third', opponent: 'fan', durationSec: 180 }, lk))).toMatchObject({ code: 'opponent_not_eligible' });
  });

  it('picks the newest live room of a host and treats an unreachable LiveKit as present', async () => {
    lk.stream('fan-old', 'fan', { createdAt: '2026-11-15T08:00:00.000Z' });
    lk.listParticipants.mockRejectedValueOnce(new Error('down'));
    const b = await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    expect(b.b.room).toBe('fan-bbb');
  });

  it('rolls back the opponent when our own room was claimed meanwhile', async () => {
    const realMutate = lk.updateRoomMetadata.getMockImplementation()!;
    let calls = 0;
    lk.listRooms.mockImplementation(async (names?: string[]) => {
      // After the opponent claim, someone else's invite lands in our room.
      if (names?.[0] === 'badadib-aaa' && ++calls === 2) {
        const meta = lk.meta('badadib-aaa');
        await realMutate('badadib-aaa', JSON.stringify({ ...meta, battle: { ...baseBattle({ id: 'zz', a: { host: 'x', room: 'x-r', hbd: 0, count: 0 }, b: { host: 'badadib', room: 'badadib-aaa', hbd: 0, count: 0 } }) } }));
      }
      return [...lk.rooms.values()].filter((r) => !names || names.includes(r.name)).map((r) => ({ ...r }));
    });
    await expect(inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk)).rejects.toMatchObject({ code: 'not_eligible' });
    expect(lk.battle('fan-bbb')).toMatchObject({ state: 'ended', endReason: 'cancelled' });
    expect(lk.battle('badadib-aaa')?.id).toBe('zz');
  });

  it('accept starts the clock, boosts fill the meter, the timer settles with a winner', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 180 }, lk);
    await expect(respondBattle({ room: 'badadib-aaa', by: 'badadib', accept: true }, lk)).rejects.toMatchObject({ code: 'not_invited' });
    await expect(respondBattle({ room: 'fan-bbb', by: 'badadib', accept: true }, lk)).rejects.toMatchObject({ status: 403 });
    const live = await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    expect(live.state).toBe('live');
    expect(lk.battle('badadib-aaa')).toEqual(live);

    const start = Date.parse(live.startedAt!);
    const end = Date.parse(live.endsAt!);
    expect(await recordBattleBoost('badadib-aaa', { hbd: 5, atMs: start - 1 }, lk)).toBe(false);
    expect(await recordBattleBoost('badadib-aaa', { hbd: 2, atMs: start + 1000 }, lk)).toBe(true);
    expect(await recordBattleBoost('fan-bbb', { hbd: 1, atMs: start + 2000 }, lk)).toBe(true);
    expect(await recordBattleBoost('badadib-aaa', { hbd: 3, atMs: end }, lk)).toBe(true);
    expect(await recordBattleBoost('fan-bbb', { hbd: 50, atMs: end + 1 }, lk)).toBe(false);
    expect(await recordBattleBoost('other-room', { hbd: 50, atMs: start + 1 }, lk)).toBe(false);
    expect(lk.battle('fan-bbb')).toMatchObject({ a: { hbd: 5, count: 2 }, b: { hbd: 1, count: 1 } });
    expect(lk.battle('badadib-aaa')).toMatchObject({ a: { hbd: 5 }, b: { hbd: 1 } });

    await expect(settleBattle({ room: 'fan-bbb', by: 'fan' }, lk)).rejects.toMatchObject({ code: 'not_yet' });
    await vi.advanceTimersByTimeAsync(LEAD_IN_MS + 180_000 + SETTLE_GRACE_MS + 10);
    expect(lk.battle('fan-bbb')).toMatchObject({ state: 'ended', endReason: 'time', winner: 'a' });
    expect(lk.battle('badadib-aaa')?.winner).toBe('a');
    // A late boost after the result changes nothing.
    expect(await recordBattleBoost('fan-bbb', { hbd: 9, atMs: end - 5 }, lk)).toBe(false);
    // Settling again is a no-op.
    expect((await settleBattle({ room: 'fan-bbb' }, lk)).winner).toBe('a');
  });

  it('a studio can settle after a restart (no timer), only as a host', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 180 }, lk);
    const live = await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    const after = Date.parse(live.settleAt!) + 1;
    await expect(settleBattle({ room: 'fan-bbb', by: 'stranger', now: after }, lk)).rejects.toMatchObject({ status: 403 });
    const done = await settleBattle({ room: 'badadib-aaa', by: 'badadib', now: after }, lk);
    expect(done).toMatchObject({ state: 'ended', winner: 'tie' });
    await expect(settleBattle({ room: 'nope' }, lk)).rejects.toMatchObject({ status: 404 });
  });

  it('decline, withdraw and expired invites', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    const d = await respondBattle({ room: 'fan-bbb', by: 'fan', accept: false }, lk);
    expect(d).toMatchObject({ state: 'ended', endReason: 'declined', endedBy: 'fan' });
    await expect(respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk)).rejects.toMatchObject({ code: 'expired' });

    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    expect(await endBattleBy({ room: 'badadib-aaa', by: 'badadib' }, lk)).toMatchObject({ endReason: 'cancelled' });
    // Ending an ended battle returns it unchanged.
    expect(await endBattleBy({ room: 'badadib-aaa', by: 'badadib' }, lk)).toMatchObject({ endReason: 'cancelled' });

    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    expect(await endBattleBy({ room: 'fan-bbb', by: 'fan' }, lk)).toMatchObject({ endReason: 'declined' });

    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    await expect(respondBattle({ room: 'fan-bbb', by: 'fan', accept: true, now: T0 + INVITE_TTL_MS }, lk)).rejects.toMatchObject({ code: 'expired' });
  });

  it('accept re-checks both streams', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    const meta = lk.meta('badadib-aaa');
    lk.rooms.get('badadib-aaa')!.metadata = JSON.stringify({ ...meta, collabGuest: 'someone' });
    await expect(respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk)).rejects.toMatchObject({ code: 'not_eligible', message: expect.stringMatching(/guest/) });
    expect(lk.battle('fan-bbb')).toMatchObject({ state: 'ended', endReason: 'cancelled' });

    lk.stream('badadib-aaa', 'badadib');
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    // The challenger's room lost the battle (e.g. it was recreated).
    lk.stream('badadib-aaa', 'badadib');
    await expect(respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk)).rejects.toMatchObject({ message: 'The invite was withdrawn' });
  });

  it('ending early gives no winner; after the clock it is a normal result', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    const live = await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    await recordBattleBoost('badadib-aaa', { hbd: 4, atMs: Date.parse(live.startedAt!) + 1 }, lk);
    const early = await endBattleBy({ room: 'badadib-aaa', by: 'badadib', reason: 'ended' }, lk);
    expect(early).toMatchObject({ state: 'ended', endReason: 'ended', winner: null, endedBy: 'badadib' });
    expect(lk.battle('fan-bbb')?.state).toBe('ended');

    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 180 }, lk);
    const l2 = await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    await recordBattleBoost('fan-bbb', { hbd: 1, atMs: Date.parse(l2.startedAt!) + 1 }, lk);
    const late = await endBattleBy({ room: 'badadib-aaa', by: 'badadib', now: Date.parse(l2.endsAt!) + 1 }, lk);
    expect(late).toMatchObject({ endReason: 'time', winner: 'b' });
  });

  it('a drop is only accepted when the other host is really gone', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    await expect(endBattleBy({ room: 'badadib-aaa', by: 'badadib', reason: 'dropped' }, lk)).rejects.toMatchObject({ code: 'still_here' });
    lk.present.set('fan-bbb', []);
    vi.setSystemTime(T0 + DROP_GRACE_MS);
    const d = await endBattleBy({ room: 'badadib-aaa', by: 'badadib', reason: 'dropped' }, lk);
    expect(d).toMatchObject({ endReason: 'dropped', winner: null, endedBy: 'fan' });
  });

  it('a stream that ended (room deleted) counts as dropped at once', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    lk.rooms.delete('fan-bbb');
    const d = await endBattleBy({ room: 'badadib-aaa', by: 'badadib', reason: 'dropped' }, lk);
    expect(d).toMatchObject({ endReason: 'dropped', endedBy: 'fan' });
    expect(lk.battle('badadib-aaa')?.state).toBe('ended');
  });

  it('a boost for a room that vanished still counts on the other side', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    const live = await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    const real = lk.updateRoomMetadata.getMockImplementation()!;
    lk.updateRoomMetadata.mockImplementation(async (name: string, m: string) => {
      if (name === 'fan-bbb') throw new Error('Room not found');
      return real(name, m);
    });
    expect(await recordBattleBoost('badadib-aaa', { hbd: 1, atMs: Date.parse(live.startedAt!) + 5 }, lk)).toBe(true);
    expect(lk.battle('badadib-aaa')?.a.hbd).toBe(1);
    expect(await recordBattleBoost('gone', { hbd: 1, atMs: T0 }, lk)).toBe(false);
  });

  it('link tokens: only for a running battle, for the OTHER room, hidden and subscribe-only', async () => {
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    await expect(linkToken({ room: 'badadib-aaa', by: 'badadib' }, lk)).rejects.toMatchObject({ code: 'not_live' });
    const live = await respondBattle({ room: 'fan-bbb', by: 'fan', accept: true }, lk);
    const link = await linkToken({ room: 'badadib-aaa', by: 'badadib' }, lk);
    expect(link).toMatchObject({ room: 'fan-bbb', host: 'fan', identity: 'obs-battle-badadib' });
    const payload = JSON.parse(Buffer.from(link.token.split('.')[1], 'base64url').toString());
    expect(payload.video).toMatchObject({ room: 'fan-bbb', roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, hidden: true });
    expect(payload.sub).toBe('obs-battle-badadib');
    const back = await linkToken({ room: 'fan-bbb', by: 'fan' }, lk);
    expect(back.room).toBe('badadib-aaa');
    await expect(linkToken({ room: 'fan-bbb', by: 'badadib' }, lk)).rejects.toMatchObject({ status: 403 });
    await expect(linkToken({ room: 'fan-bbb', by: 'fan', now: Date.parse(live.settleAt!) + 60_000 }, lk)).rejects.toMatchObject({ code: 'not_live' });
  });

  it('lists candidates without unlisted, busy, OBS or own streams', async () => {
    lk.stream('hidden-r', 'hiddenhost', { visibility: 'unlisted' });
    lk.stream('obs-r', 'obshost', { headless: true });
    lk.stream('guest-r', 'guesthost', { collabGuest: 'g' });
    lk.stream('post-r', 'posthost', { post: { title: 'My post', thumbnail: 'https://img/x.jpg' } });
    lk.rooms.set('blank', { name: 'blank', metadata: JSON.stringify({ mode: 'standalone', broadcasting: true }) });
    const list = await battleCandidates('badadib', lk);
    expect(list.map((c) => c.room).sort()).toEqual(['fan-bbb', 'post-r']);
    expect(list.find((c) => c.room === 'post-r')).toEqual({ room: 'post-r', host: 'posthost', title: 'My post', thumbnail: 'https://img/x.jpg' });
    for (let i = 0; i < 40; i += 1) lk.stream(`many-${i}`, `host${i}`);
    expect((await battleCandidates('badadib', lk)).length).toBeLessThanOrEqual(30);
  });

  it('getBattle returns the public battle or 404', async () => {
    expect(await getBattle('fan-bbb', lk)).toBeNull();
    await inviteBattle({ room: 'badadib-aaa', by: 'badadib', opponent: 'fan', durationSec: 300 }, lk);
    expect((await getBattle('fan-bbb', lk))?.state).toBe('invited');
    await expect(getBattle('nope', lk)).rejects.toMatchObject({ status: 404 });
    await expect(endBattleBy({ room: 'nope', by: 'x' }, lk)).rejects.toMatchObject({ status: 404 });
    lk.stream('plain', 'plainhost');
    await expect(endBattleBy({ room: 'plain', by: 'plainhost' }, lk)).rejects.toMatchObject({ code: 'no_battle' });
    await expect(settleBattle({ room: 'plain' }, lk)).rejects.toMatchObject({ code: 'no_battle' });
  });

  it('has the three durations', () => {
    expect([...BATTLE_DURATIONS]).toEqual([180, 300, 600]);
  });
});
