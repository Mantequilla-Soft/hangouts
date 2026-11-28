import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { POINTS_START, applyPointsNow, earnForChat, flushPoints, memoryPointsStore, resetPointsEarning, setPointsStore } from '../../src/lib/points.js';
import { encodePointsLog, memoryLedgerStore, setLedgerStore } from '../../src/lib/pointsLedger.js';
import {
  EXTERNAL_KINDS, LOGIN_POINTS, RANK_POINTS, REMIX_PER_DAY, REMIX_POINTS, awardDailyLogin, awardPoints, awardScheduledStart,
  awardsConfig, isoWeek, memoryAwardStore, setAccountCreatedLookup, setAwardBanCheck, setAwardStore, type AwardInput,
} from '../../src/lib/pointsAwards.js';
import { doubleState, pointsMultiplier } from '../../src/lib/pointsEvents.js';

let points: ReturnType<typeof memoryPointsStore>;
let ledger: ReturnType<typeof memoryLedgerStore>;
let created: number | null;
let lookups: number;
const cfg = config as { POINTS_DOUBLE_WEEKENDS: boolean; POINTS_DOUBLE_WINDOWS: string };

beforeEach(() => {
  points = memoryPointsStore();
  setPointsStore(points);
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  setAwardStore(memoryAwardStore());
  setAwardBanCheck(async () => false);
  created = null;
  lookups = 0;
  setAccountCreatedLookup(async () => { lookups += 1; return created; });
  resetPointsEarning();
});
afterEach(() => {
  cfg.POINTS_DOUBLE_WEEKENDS = false;
  cfg.POINTS_DOUBLE_WINDOWS = '';
});

// Thursday 2026-11-26, 12:00 UTC.
const day = Date.UTC(2026, 10, 26, 12);
const D = 24 * 3600_000;
const dayStr = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Each outcome as 'ok:<points>' or its reason. */
async function pay(items: AwardInput[], at = day, external = false): Promise<string[]> {
  return (await awardPoints(items, at, { external })).map((o) => (o.awarded ? `ok:${o.points}` : o.reason));
}

describe('daily login', () => {
  it('one point per UTC day, logged with no ref', async () => {
    expect(await awardDailyLogin('Alice', day)).toBe(true);
    expect(await awardDailyLogin('alice', day + 3600_000)).toBe(false);
    expect(await awardDailyLogin('alice', day + 24 * 3600_000)).toBe(true);
    expect(await points.get('alice')).toBe(POINTS_START + 2 * LOGIN_POINTS);
    expect(ledger.rows[0]).toMatchObject({ user: 'alice', delta: 1, kind: 'login' });
    expect(ledger.rows[0].ref).toBeUndefined();
  });

  it('not for guests or the OBS ingress', async () => {
    expect(await awardDailyLogin('guest-abc123', day)).toBe(false);
    expect(await awardDailyLogin('obs-ingress-x', day)).toBe(false);
  });

  it('a login id must name its own account', async () => {
    expect(await pay([{ id: 'login:bob:2026-11-26', user: 'alice', kind: 'login' }])).toEqual(['invalid']);
  });
});

describe('streak', () => {
  const loginDays = async (from: number, n: number) => { for (let i = 0; i < n; i += 1) await awardDailyLogin('alice', from + i * D); };
  const streaks = () => ledger.rows.filter((r) => r.kind === 'streak').map((r) => `${r.ref}:${r.delta}`);

  it('20 points on day 7 of a run, once per run', async () => {
    await loginDays(day, 6);
    expect(streaks()).toEqual([]);
    await loginDays(day + 6 * D, 3);
    expect(streaks()).toEqual(['7:20']);
  });

  it('100 more on day 30', async () => {
    await loginDays(day, 31);
    expect(streaks()).toEqual(['7:20', '30:100']);
  });

  it('a broken run starts over', async () => {
    await loginDays(day, 5);
    // Day 6 missed: days 7 to 12 are a run of 6.
    await loginDays(day + 6 * D, 6);
    expect(streaks()).toEqual([]);
    await loginDays(day + 12 * D, 1);
    expect(streaks()).toEqual(['7:20']);
    // Its id carries the run's first day.
    expect(ledger.rows.find((r) => r.kind === 'streak')).toBeTruthy();
  });

  it('the id carries the run start, so a resend pays nothing', async () => {
    await loginDays(day, 7);
    expect(await pay([{ id: `streak:alice:${dayStr(day)}:7`, user: 'alice', kind: 'streak' }], day + 7 * D)).toEqual(['already']);
  });
});

describe('week5', () => {
  // 2026-11-23 is a Monday.
  const monday = Date.UTC(2026, 10, 23, 9);

  it('25 points on the 5th sign-in day of an ISO week', async () => {
    for (const d of [0, 1, 3, 4]) await awardDailyLogin('alice', monday + d * D);
    expect(ledger.rows.some((r) => r.kind === 'week5')).toBe(false);
    await awardDailyLogin('alice', monday + 6 * D);
    expect(ledger.rows.filter((r) => r.kind === 'week5').map((r) => r.delta)).toEqual([25]);
  });

  it('five days across two weeks are not five in one', async () => {
    // Friday to Tuesday.
    for (let d = 4; d <= 8; d += 1) await awardDailyLogin('alice', monday + d * D);
    expect(ledger.rows.some((r) => r.kind === 'week5')).toBe(false);
  });

  it('ISO weeks at the year end', () => {
    expect(isoWeek(Date.UTC(2026, 10, 26))).toBe('2026-W48');
    expect(isoWeek(Date.UTC(2026, 11, 31))).toBe('2026-W53');
    expect(isoWeek(Date.UTC(2027, 0, 3))).toBe('2026-W53');
    expect(isoWeek(Date.UTC(2027, 0, 4))).toBe('2027-W01');
  });
});

describe('anniversary', () => {
  it('on or after the day, once a year, with the years as ref', async () => {
    created = Date.UTC(2020, 11, 1, 8);
    await awardDailyLogin('alice', day);
    expect(ledger.rows.some((r) => r.kind === 'anniv')).toBe(false);
    await awardDailyLogin('alice', Date.UTC(2026, 11, 3, 10));
    expect(ledger.rows.filter((r) => r.kind === 'anniv').map((r) => `${r.ref}:${r.delta}`)).toEqual(['6:100']);
    const asked = lookups;
    await awardDailyLogin('alice', Date.UTC(2026, 11, 4, 10));
    // Paid this year: Hive is not asked again.
    expect(lookups).toBe(asked);
    expect(ledger.rows.filter((r) => r.kind === 'anniv')).toHaveLength(1);
  });

  it('nothing in the first year', async () => {
    created = Date.UTC(2026, 0, 10);
    await awardDailyLogin('alice', day);
    expect(ledger.rows.some((r) => r.kind === 'anniv')).toBe(false);
  });
});

describe('leaderboard #1', () => {
  it('100 points per board and month, once', async () => {
    const [a, b, c] = await awardPoints([
      { id: 'rank:2026-11:video_uploads', user: 'alice', kind: 'rank' },
      { id: 'rank:2026-11:video_uploads', user: 'alice', kind: 'rank' },
      { id: 'rank:2026-11:streams', user: 'alice', kind: 'rank' },
    ], day);
    expect(a).toEqual({ id: 'rank:2026-11:video_uploads', awarded: true, points: RANK_POINTS });
    expect(b).toMatchObject({ awarded: false, reason: 'already' });
    expect(c).toMatchObject({ awarded: true });
    expect(await points.get('alice')).toBe(POINTS_START + 2 * RANK_POINTS);
    expect(ledger.rows[0]).toMatchObject({ kind: 'rank', ref: '2026-11:video_uploads' });
  });

  it('refuses ids that are not a month and a board, and unknown kinds', async () => {
    const out = await awardPoints([
      { id: 'rank:2026-13:streams', user: 'alice', kind: 'rank' },
      { id: 'rank:whenever', user: 'alice', kind: 'rank' },
      { id: 'login:alice:2026-11-26', user: 'alice', kind: 'bonus' },
    ], day);
    expect(out.map((o) => !o.awarded && o.reason)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(ledger.rows).toHaveLength(0);
  });
});

describe('remix and reaction', () => {
  const remix = (n: number, ref = `bob/source-${n}`, user = 'alice') => ({ id: `remix:${user}/my-remix-${n}`, user, kind: 'remix', ref });

  it('to the maker, once per source post, at most REMIX_PER_DAY a day', async () => {
    const out = await awardPoints([remix(1), remix(2, 'bob/source-1'), remix(3), remix(4), remix(5)], day);
    expect(out.map((o) => (o.awarded ? 'ok' : o.reason))).toEqual(['ok', 'already', 'ok', 'ok', 'limit']);
    expect(await points.get('alice')).toBe(POINTS_START + REMIX_PER_DAY * REMIX_POINTS);
    // The next UTC day: room again.
    expect((await awardPoints([remix(5)], day + 24 * 3600_000))[0].awarded).toBe(true);
  });

  it('not for remixing your own post; the source must be a post', async () => {
    const out = await awardPoints([remix(1, 'alice/own-video'), remix(2, 'not a post')], day);
    expect(out.map((o) => !o.awarded && o.reason)).toEqual(['own', 'invalid']);
  });
});

describe('the checker kinds', () => {
  it('each pays its amount once', async () => {
    const items: AwardInput[] = [
      { id: 'first5:alice:2026-11-25', user: 'alice', kind: 'first5' },
      { id: 'premiere:alice:bob/launch', user: 'alice', kind: 'premiere' },
      { id: 'playlist:alice:64b7f0c2a1b2c3d4e5f60718', user: 'alice', kind: 'playlist' },
      { id: 'first:alice:video', user: 'alice', kind: 'first' },
      { id: 'reach:alice/my-video', user: 'alice', kind: 'reach' },
      { id: 'storystreak:alice:2026-11-26', user: 'alice', kind: 'storystreak' },
      { id: 'challenge:2026-W48:alice/my-short', user: 'alice', kind: 'challenge' },
      { id: 'community:alice:hive-181335', user: 'alice', kind: 'community' },
      { id: 'reply:alice/re-bob-my-video-20261126', user: 'alice', kind: 'reply', ref: 'bob' },
      { id: 'remixed:bob/remix-of-yours', user: 'alice', kind: 'remixed', ref: 'alice/my-video' },
      { id: 'premheld:64b7f0c2a1b2c3d4e5f60718', user: 'alice', kind: 'premheld' },
    ];
    expect(await pay(items)).toEqual(['ok:10', 'ok:25', 'ok:20', 'ok:500', 'ok:100', 'ok:50', 'ok:200', 'ok:10', 'ok:5', 'ok:50', 'ok:50']);
    expect(await pay(items)).toEqual(items.map(() => 'already'));
    expect(ledger.rows.find((r) => r.kind === 'premiere')?.ref).toBe('bob/launch');
    expect(ledger.rows.find((r) => r.kind === 'reach')?.ref).toBe('alice/my-video');
    expect(ledger.rows.find((r) => r.kind === 'remixed')?.ref).toBe('alice/my-video');
  });

  it('vodtime and listen: 2 a minute, at most 120 a day; units are needed', async () => {
    expect(await pay([
      { id: 'vodtime:alice:2026-11-25', user: 'alice', kind: 'vodtime', units: 30 },
      { id: 'listen:alice:2026-11-25', user: 'alice', kind: 'listen', units: 100 },
      { id: 'vodtime:alice:2026-11-24', user: 'alice', kind: 'vodtime', units: 0 },
      { id: 'listen:alice:2026-11-24', user: 'alice', kind: 'listen' },
    ])).toEqual(['ok:60', 'ok:120', 'invalid', 'invalid']);
  });

  it('tip: 100 plus 100 per HBD (units in milli-HBD), at most 2,000, not to yourself', async () => {
    expect(await pay([
      { id: 'tip:lnd-abc123', user: 'alice', kind: 'tip', ref: 'bob', units: 2500 },
      { id: 'tip:' + 'ab'.repeat(20), user: 'alice', kind: 'tip', ref: 'bob', units: 50_000 },
      { id: 'tip:lnd-own123', user: 'alice', kind: 'tip', ref: 'alice', units: 1000 },
      { id: 'tip:lnd-zero12', user: 'alice', kind: 'tip', ref: 'bob', units: 0 },
    ])).toEqual(['ok:350', 'ok:2000', 'own', 'invalid']);
  });

  it('followers and referral pay by milestone and side', async () => {
    expect(await pay([
      { id: 'followers:alice:10', user: 'alice', kind: 'followers' },
      { id: 'followers:alice:100', user: 'alice', kind: 'followers' },
      { id: 'followers:alice:1000', user: 'alice', kind: 'followers' },
      { id: 'followers:alice:50', user: 'alice', kind: 'followers' },
      { id: 'referral:newbie', user: 'alice', kind: 'referral' },
      { id: 'invited:newbie', user: 'newbie', kind: 'referral', ref: 'alice' },
      { id: 'referral:alice', user: 'alice', kind: 'referral' },
    ])).toEqual(['ok:100', 'ok:500', 'ok:2000', 'invalid', 'ok:1000', 'ok:250', 'own']);
    // The invitee's row is its own kind, so the wallet can tell the two sides apart.
    expect(ledger.rows.filter((r) => r.kind === 'referral').map((r) => `${r.user}:${r.ref}`)).toEqual(['alice:newbie']);
    expect(ledger.rows.filter((r) => r.kind === 'invited').map((r) => `${r.user}:${r.ref}`)).toEqual(['newbie:alice']);
  });

  it('nothing for your own content', async () => {
    expect(await pay([
      { id: 'finish:alice:alice/mine', user: 'alice', kind: 'finish' },
      { id: 'premiere:alice:alice/mine', user: 'alice', kind: 'premiere' },
      { id: 'tag:alice:alice/mine:music', user: 'alice', kind: 'tag' },
      { id: 'reply:alice/re-mine', user: 'alice', kind: 'reply', ref: 'alice' },
      { id: 'remixed:alice/self-remix', user: 'alice', kind: 'remixed', ref: 'alice/my-video' },
    ])).toEqual(['own', 'own', 'own', 'own', 'own']);
  });

  it('ids must name the account they pay', async () => {
    expect(await pay([
      { id: 'finish:bob:carol/video', user: 'alice', kind: 'finish' },
      { id: 'reach:bob/video', user: 'alice', kind: 'reach' },
      { id: 'challenge:2026-W48:bob/short', user: 'alice', kind: 'challenge' },
      { id: 'remixed:bob/remix', user: 'alice', kind: 'remixed', ref: 'carol/source' },
    ])).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
  });

  it('daily and lifetime caps', async () => {
    const finishes = Array.from({ length: 11 }, (_, i) => ({ id: `finish:alice:bob/v${i}`, user: 'alice', kind: 'finish' }));
    expect((await pay(finishes)).slice(-2)).toEqual(['ok:5', 'limit']);
    const tags = Array.from({ length: 21 }, (_, i) => ({ id: `tag:alice:bob/v${i}:music`, user: 'alice', kind: 'tag' }));
    expect((await pay(tags)).slice(-2)).toEqual(['ok:1', 'limit']);
    const lists = Array.from({ length: 4 }, (_, i) => ({ id: `playlist:alice:list${i}`, user: 'alice', kind: 'playlist' }));
    expect(await pay(lists)).toEqual(['ok:20', 'ok:20', 'ok:20', 'limit']);
    const replies = Array.from({ length: 11 }, (_, i) => ({ id: `reply:alice/re-${i}`, user: 'alice', kind: 'reply', ref: 'bob' }));
    expect((await pay(replies)).slice(-2)).toEqual(['ok:5', 'limit']);
    // Communities: 5 ever, whatever the day.
    const comms = (from: number) => Array.from({ length: 3 }, (_, i) => ({ id: `community:alice:hive-${from + i}`, user: 'alice', kind: 'community' }));
    expect(await pay(comms(100))).toEqual(['ok:10', 'ok:10', 'ok:10']);
    expect(await pay(comms(200), day + 3 * D)).toEqual(['ok:10', 'ok:10', 'limit']);
    // A resent award at the cap is "already", not "limit" (the cap counts it).
    expect(await pay([tags[0], comms(100)[0]], day + 3 * D)).toEqual(['already', 'already']);
    expect(await pay([tags[19]])).toEqual(['already']);
  });

  it('the checker may not send this server\'s kinds, nor a first stream', async () => {
    expect(await pay([
      { id: 'pwa:alice', user: 'alice', kind: 'pwa' },
      { id: 'quest:finish3:2026-W48:alice', user: 'alice', kind: 'quest', ref: 'finish3' },
      { id: 'first:alice:stream', user: 'alice', kind: 'first' },
      { id: 'first:alice:podcast', user: 'alice', kind: 'first' },
    ], day, true)).toEqual(['invalid', 'invalid', 'invalid', 'ok:500']);
    expect(EXTERNAL_KINDS).toContain('vodtime');
    expect(EXTERNAL_KINDS).not.toContain('login');
    expect(EXTERNAL_KINDS).not.toContain('collab');
  });

  it('banned accounts earn nothing', async () => {
    setAwardBanCheck(async (u) => u === 'spammer');
    expect(await pay([{ id: 'first5:spammer:2026-11-25', user: 'spammer', kind: 'first5' }])).toEqual(['banned']);
    expect(await points.get('spammer')).toBe(POINTS_START);
  });
});

describe('this server\'s kinds', () => {
  it('collab: both hosts of a sorted pair, the other as ref', async () => {
    expect(await pay([
      { id: 'collab:2026-11-26:alice+bob:alice', user: 'alice', kind: 'collab' },
      { id: 'collab:2026-11-26:alice+bob:bob', user: 'bob', kind: 'collab' },
      { id: 'collab:2026-11-26:bob+alice:bob', user: 'bob', kind: 'collab' },
      { id: 'collab:2026-11-26:alice+bob:carol', user: 'carol', kind: 'collab' },
    ])).toEqual(['ok:100', 'ok:100', 'invalid', 'invalid']);
    expect(ledger.rows.map((r) => `${r.user}:${r.ref}`)).toEqual(['alice:bob', 'bob:alice']);
  });

  it('raided, clip and pollvote: not your own, with their caps', async () => {
    expect(await pay([
      { id: 'raided:a1b2c3d4e5', user: 'alice', kind: 'raided', ref: 'bob' },
      { id: 'raided:a1b2c3d4e6', user: 'alice', kind: 'raided', ref: 'alice' },
      { id: 'clip:aaaaaaaaaaaa', user: 'alice', kind: 'clip', ref: 'alice' },
    ])).toEqual(['ok:100', 'own', 'own']);
    const clips = Array.from({ length: 6 }, (_, i) => ({ id: `clip:${'ab'.repeat(8)}${i}`, user: 'alice', kind: 'clip', ref: 'bob' }));
    expect((await pay(clips)).slice(-2)).toEqual(['ok:10', 'limit']);
    const votes = Array.from({ length: 6 }, (_, i) => ({ id: `pollvote:bob-r${i}-abcd1234:alice`, user: 'alice', kind: 'pollvote', ref: `bob-r${i}` }));
    expect((await pay(votes)).slice(-2)).toEqual(['ok:5', 'limit']);
  });

  it('peak10, party, pwa and first stream, once each', async () => {
    const items: AwardInput[] = [
      { id: 'peak10:alice', user: 'alice', kind: 'peak10' },
      { id: 'party:alice-abc1234:2026-11-26', user: 'alice', kind: 'party' },
      { id: 'pwa:alice', user: 'alice', kind: 'pwa' },
      { id: 'first:alice:stream', user: 'alice', kind: 'first' },
    ];
    expect(await pay(items)).toEqual(['ok:200', 'ok:200', 'ok:50', 'ok:500']);
    expect(await pay(items, day + 30 * D)).toEqual(['already', 'already', 'already', 'already']);
    expect(ledger.rows.find((r) => r.kind === 'party')?.ref).toBe('alice-abc1234');
  });

  it('premheld: started within 15 minutes of an event scheduled an hour ahead', async () => {
    const ev = (id: string, at: number, createdAt: number) => ({
      id, hostUsername: 'alice', scheduledAt: new Date(at).toISOString(), createdAt: new Date(createdAt).toISOString(),
    });
    expect(await awardScheduledStart(ev('64b7f0c2a1b2c3d4e5f60711', day + 10 * 60_000, day - 2 * D), day)).toBe(true);
    // Too late, and scheduled only a moment before.
    expect(await awardScheduledStart(ev('64b7f0c2a1b2c3d4e5f60712', day - 20 * 60_000, day - 2 * D), day)).toBe(false);
    expect(await awardScheduledStart(ev('64b7f0c2a1b2c3d4e5f60713', day + 5 * 60_000, day - 10 * 60_000), day)).toBe(false);
  });
});

describe('the ledger and the chain', () => {
  it('rows carry the kind and ref; viewing refs stay off the chain', async () => {
    await pay([
      { id: 'finish:alice:bob/video', user: 'alice', kind: 'finish' },
      { id: 'reach:alice/my-video', user: 'alice', kind: 'reach' },
    ]);
    expect(ledger.rows.map((r) => `${r.kind}:${r.ref}`)).toEqual(['finish:bob/video', 'reach:alice/my-video']);
    const [{ json }] = encodePointsLog(ledger.rows);
    const m = JSON.parse(json).m as unknown[][];
    expect(m[0]).toEqual(['alice', 5, 'fi', 0]);
    expect(m[1]).toEqual(['alice', 100, 'rc', 0, 'alice/my-video']);
  });

  it('every kind has a config entry', () => {
    const c = awardsConfig();
    expect(c.login).toBe(1);
    expect(c.vodtime).toEqual({ perUnit: 2, maxPerDay: 120 });
    expect(c.listen).toEqual({ perUnit: 2, maxPerDay: 120 });
    expect(c.tip).toEqual({ amount: 100, perHbd: 100, max: 2000 });
    expect(c.reach).toEqual({ amount: 100, minViewers: 20 });
    expect(c.community).toEqual({ amount: 10, maxEver: 5 });
    expect(c.finish).toEqual({ amount: 5, perDay: 10 });
    expect(c.streak).toEqual({ amounts: { 7: 20, 30: 100 } });
    expect(c.followers).toEqual({ amounts: { 10: 100, 100: 500, 1000: 2000 } });
    expect(Object.keys(c)).toHaveLength(32);
  });
});

describe('double points', () => {
  const window = `${new Date(day - 3600_000).toISOString()}/${new Date(day + 3600_000).toISOString()}`;

  it('off: x1; in a window: awards pay x2, refunds do not', async () => {
    expect(await pay([{ id: 'first5:alice:2026-11-25', user: 'alice', kind: 'first5' }])).toEqual(['ok:10']);
    cfg.POINTS_DOUBLE_WINDOWS = window;
    expect(await pay([{ id: 'first5:alice:2026-11-26', user: 'alice', kind: 'first5' }])).toEqual(['ok:20']);
    expect(ledger.rows.at(-1)).toMatchObject({ kind: 'first5', delta: 20 });
    await applyPointsNow(new Map([['bob', 500]]), 'refund', undefined, day);
    expect(await points.get('bob')).toBe(POINTS_START + 500);
    // Outside the window again.
    expect(await pay([{ id: 'first5:alice:2026-11-27', user: 'alice', kind: 'first5' }], day + D)).toEqual(['ok:10']);
  });

  it('earnings counted in a window pay x2 when the batch is paid', async () => {
    cfg.POINTS_DOUBLE_WINDOWS = window;
    earnForChat('alice', 'three whole words', day);
    await flushPoints(day + 3 * 3600_000, { chain: false });
    expect(await points.get('alice')).toBe(POINTS_START + 6);
  });

  it('weekends: Saturday to the end of Sunday, UTC', () => {
    cfg.POINTS_DOUBLE_WEEKENDS = true;
    const saturday = Date.UTC(2026, 10, 28);
    expect(pointsMultiplier('watch', saturday - 1)).toBe(1);
    expect(pointsMultiplier('watch', saturday)).toBe(2);
    expect(pointsMultiplier('watch', saturday + 2 * D - 1)).toBe(2);
    expect(pointsMultiplier('prediction', saturday)).toBe(1);
    expect(pointsMultiplier('watch', saturday + 2 * D)).toBe(1);
    expect(doubleState(day)).toEqual({ active: false, next: new Date(saturday).toISOString() });
    expect(doubleState(saturday + D)).toEqual({ active: true, until: new Date(saturday + 2 * D).toISOString(), next: new Date(saturday + 7 * D).toISOString() });
  });

  it('a window touching a weekend runs on to its end', () => {
    cfg.POINTS_DOUBLE_WEEKENDS = true;
    const saturday = Date.UTC(2026, 10, 28);
    cfg.POINTS_DOUBLE_WINDOWS = `${new Date(saturday - 6 * 3600_000).toISOString()}/${new Date(saturday + 3600_000).toISOString()}, junk/also-junk`;
    expect(doubleState(saturday - 3600_000)).toMatchObject({ active: true, until: new Date(saturday + 2 * D).toISOString() });
  });
});
