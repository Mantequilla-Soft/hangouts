import { beforeEach, describe, expect, it } from 'vitest';
import { ParticipantInfo_Kind } from '@livekit/protocol';
import {
  BATTLE_POINTS, BOOST_POINTS_MAX, CHAT_POINTS_PER_MIN_MAX, PAIR_REWARD_GAP_MS, POINTS_START, RAID_POINTS,
  STREAM_POINTS_PER_MIN, WATCH_POINTS_PER_MIN, boostReward, chatWords, earnForBattle, earnForBoost, earnForChat,
  earnForRaid, flushPoints, memoryPointsStore, minuteRewards, pointsAccount, pointsHistory, resetPointsEarning,
  setPointsStore, spendPoints,
} from '../../src/lib/points.js';
import {
  decodePointsLog, encodePointsLog, logPendingToChain, memoryLedgerStore, newRow, replayPointsLog, setLedgerStore,
  setPointsLogWriter,
} from '../../src/lib/pointsLedger.js';

let store: ReturnType<typeof memoryPointsStore>;
let ledger: ReturnType<typeof memoryLedgerStore>;
// Earnings are paid out with the batch.
const flush = () => flushPoints(Date.now(), { chain: false });

beforeEach(() => {
  store = memoryPointsStore();
  setPointsStore(store);
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  setPointsLogWriter(null);
  resetPointsEarning();
});

const live = (extra: Record<string, unknown> = {}) => JSON.stringify({
  mode: 'standalone', host: 'badadib', liveAt: '2026-11-18T10:00:00Z', ...extra,
});
const p = (identity: string, extra: Record<string, unknown> = {}) => ({ identity, kind: ParticipantInfo_Kind.STANDARD, tracks: [], ...extra });
const studio = p('badadib', { tracks: [{}] });

describe('who earns', () => {
  it('only Hive accounts; the host second device is the host', () => {
    expect(pointsAccount('Fan1')).toBe('fan1');
    expect(pointsAccount('badadib~watch')).toBe('badadib');
    expect(pointsAccount('guest-abc123')).toBeNull();
    expect(pointsAccount('obs-ingress-room')).toBeNull();
    expect(pointsAccount(undefined)).toBeNull();
  });
});

describe('a minute of watching and streaming', () => {
  it('viewers earn 10, the host 100 while live with an audience', () => {
    const out = minuteRewards([{ metadata: live(), participants: [studio, p('fan'), p('fan2'), p('guest-x1')] }]);
    expect(out.get('fan')).toEqual({ points: WATCH_POINTS_PER_MIN, kind: 'watch' });
    expect(out.get('fan2')?.points).toBe(WATCH_POINTS_PER_MIN);
    expect(out.get('badadib')).toEqual({ points: STREAM_POINTS_PER_MIN, kind: 'stream' });
    expect(out.has('guest-x1')).toBe(false);
  });

  it('a guest audience is enough for the host; HLS viewers count too', () => {
    const hls = p('fan', { permission: { canSubscribe: false } });
    expect(minuteRewards([{ metadata: live(), participants: [studio, p('guest-a1')] }]).get('badadib')?.points).toBe(STREAM_POINTS_PER_MIN);
    expect(minuteRewards([{ metadata: live(), participants: [studio, hls] }]).get('fan')?.points).toBe(WATCH_POINTS_PER_MIN);
  });

  it('nothing for an empty stream, one that never went live, a hangout, or egress', () => {
    expect(minuteRewards([{ metadata: live(), participants: [studio] }]).size).toBe(0);
    expect(minuteRewards([{ metadata: live({ liveAt: undefined }), participants: [studio, p('fan')] }]).size).toBe(0);
    expect(minuteRewards([{ metadata: JSON.stringify({ host: 'badadib' }), participants: [studio, p('fan')] }]).size).toBe(0);
    const egress = p('EG_abc', { kind: ParticipantInfo_Kind.EGRESS });
    expect(minuteRewards([{ metadata: live(), participants: [studio, egress] }]).size).toBe(0);
  });

  it('the host earns nothing when nobody sends a picture; an OBS ingress counts', () => {
    expect(minuteRewards([{ metadata: live(), participants: [p('fan')] }]).get('badadib')).toBeUndefined();
    const obs = p('obs-ingress-badadib', { kind: ParticipantInfo_Kind.INGRESS, tracks: [{}] });
    expect(minuteRewards([{ metadata: live(), participants: [obs, p('fan')] }]).get('badadib')?.points).toBe(STREAM_POINTS_PER_MIN);
  });

  it('once per account across tabs and streams; a streamer watching elsewhere earns as a streamer', () => {
    const other = { metadata: live({ host: 'fan2' }), participants: [p('fan2', { tracks: [{}] }), p('fan'), p('badadib~watch')] };
    const out = minuteRewards([{ metadata: live(), participants: [studio, p('fan'), p('fan')] }, other]);
    expect(out.get('fan')?.points).toBe(WATCH_POINTS_PER_MIN);
    expect(out.get('badadib')?.points).toBe(STREAM_POINTS_PER_MIN);
    expect(out.get('fan2')?.points).toBe(STREAM_POINTS_PER_MIN);
  });

  it('a collab guest on air earns as a streamer, not as a viewer', () => {
    const out = minuteRewards([{ metadata: live({ collabGuest: 'fan2' }), participants: [studio, p('fan2'), p('fan')] }]);
    expect(out.get('fan2')?.points).toBe(STREAM_POINTS_PER_MIN);
  });
});

describe('chat', () => {
  it('a point a word, at most 20 a message and 50 a minute', async () => {
    expect(chatWords('hello  there, friend')).toBe(3);
    expect(chatWords('🔥 🔥 !!!')).toBe(0);
    expect(chatWords(Array(40).fill('word').join(' '))).toBe(20);
    const t = 1_800_000_000_000;
    expect(earnForChat('fan', Array(30).fill('w').join(' '), t)).toBe(20);
    expect(earnForChat('fan', Array(30).fill('w').join(' '), t + 1000)).toBe(20);
    expect(earnForChat('fan', Array(30).fill('w').join(' '), t + 2000)).toBe(CHAT_POINTS_PER_MIN_MAX - 40);
    expect(earnForChat('fan', 'more words', t + 3000)).toBe(0);
    expect(earnForChat('fan', 'next minute', t + 60_000)).toBe(2);
    expect(earnForChat('guest-x1', 'hi there', t)).toBe(0);
    await flush();
    expect(store.balances.get('fan')).toBe(POINTS_START + CHAT_POINTS_PER_MIN_MAX + 2);
  });
});

describe('boosts, raids and battles', () => {
  it('a boost earns 100 plus 100 per HBD, at most 2,000', () => {
    expect(boostReward(0.5)).toBe(150);
    expect(boostReward(5)).toBe(600);
    expect(boostReward(100)).toBe(BOOST_POINTS_MAX);
    expect(boostReward(0)).toBe(0);
    expect(earnForBoost('fan', 1)).toBe(200);
    expect(earnForBoost('guest-x1', 1)).toBe(0);
  });

  it('a raid pays the raider once an hour for the same pair', async () => {
    const t = 1_800_000_000_000;
    expect(earnForRaid('badadib', 'fan2', t)).toBe(RAID_POINTS);
    expect(earnForRaid('fan2', 'badadib', t + 60_000)).toBe(0);
    expect(earnForRaid('badadib', 'fan2', t + PAIR_REWARD_GAP_MS)).toBe(RAID_POINTS);
    await flush();
    expect(store.balances.get('badadib')).toBe(POINTS_START + 2 * RAID_POINTS);
    expect(store.balances.has('fan2')).toBe(false);
  });

  it('a full-time battle pays both hosts, once an hour per pair', async () => {
    const t = 1_800_000_000_000;
    expect(earnForBattle('badadib', 'fan2', t)).toBe(BATTLE_POINTS);
    expect(earnForBattle('fan2', 'badadib', t + 1000)).toBe(0);
    await flush();
    expect(store.balances.get('badadib')).toBe(POINTS_START + BATTLE_POINTS);
    expect(store.balances.get('fan2')).toBe(POINTS_START + BATTLE_POINTS);
  });
});

describe('spending', () => {
  it('takes points only when the balance covers them', async () => {
    expect(await spendPoints('fan', 600, 'badadib-live')).toBe(POINTS_START - 600);
    expect(await spendPoints('fan', 600)).toBeNull();
    expect(store.balances.get('fan')).toBe(POINTS_START - 600);
    expect(ledger.rows).toMatchObject([{ user: 'fan', delta: -600, kind: 'spend', ref: 'badadib-live', tx: null }]);
  });
});

describe('the ledger and the Hive log', () => {
  it('a batch pays out once per account and kind, with no stream on watching and chat', async () => {
    earnForChat('fan', 'hello there', 1_800_000_000_000);
    earnForChat('fan', 'and again', 1_800_000_000_500);
    earnForRaid('badadib', 'fan2');
    expect(store.balances.has('fan')).toBe(false); // not before the batch
    await flush();
    expect(store.balances.get('fan')).toBe(POINTS_START + 4);
    expect(ledger.rows.map((r) => [r.user, r.delta, r.kind, r.ref])).toEqual([
      ['fan', 4, 'chat', undefined],
      ['badadib', RAID_POINTS, 'raid', 'fan2'],
    ]);
    expect((await pointsHistory('Fan', 10)).map((r) => r.delta)).toEqual([4]);
  });

  it('logs unlogged rows as custom_json and keeps them for the next try when Hive fails', async () => {
    await ledger.insert([newRow('fan', 10, 'watch', 1_800_000_000_000), newRow('badadib', -2500, 'spend', 1_800_000_030_000, 'x-room')]);
    const sent: string[] = [];
    setPointsLogWriter(async () => { throw new Error('down'); });
    expect(await logPendingToChain()).toBe(0);
    expect(ledger.rows.every((r) => r.tx === null)).toBe(true);
    setPointsLogWriter(async (json) => { sent.push(json); return 'tx1'; });
    expect(await logPendingToChain()).toBe(1);
    expect(ledger.rows.every((r) => r.tx === 'tx1')).toBe(true);
    expect(JSON.parse(sent[0])).toEqual({ v: 1, at: 1_800_000_000, m: [['fan', 10, 'w', 0], ['badadib', -2500, 'x', 30, 'x-room']] });
    expect(await logPendingToChain()).toBe(0);
  });

  it('splits big batches under the custom_json size limit and decodes them back', () => {
    const rows = Array.from({ length: 600 }, (_, i) => newRow(`user${i}`, 10, 'watch', 1_800_000_000_000));
    const payloads = encodePointsLog(rows);
    expect(payloads.length).toBeGreaterThan(1);
    for (const p of payloads) expect(Buffer.byteLength(p.json)).toBeLessThanOrEqual(7600);
    const back = payloads.flatMap((p) => decodePointsLog(p.json) ?? []);
    expect(back).toHaveLength(600);
    expect(back[0]).toEqual({ user: 'user0', delta: 10, kind: 'watch', at: 1_800_000_000_000 });
    expect(decodePointsLog('{"v":2}')).toBeNull();
    expect(decodePointsLog('nope')).toBeNull();
  });

  it('a replay rebuilds balances with the start amount, the floor of 0 and the 90-day reset', () => {
    const day = 24 * 60 * 60 * 1000;
    const balances = replayPointsLog([
      { user: 'fan', delta: 500, kind: 'boost', at: 0 },
      { user: 'fan', delta: -2000, kind: 'prediction', at: day },
      { user: 'fan2', delta: 10, kind: 'watch', at: day },
      { user: 'fan2', delta: 10, kind: 'watch', at: day + 91 * day },
    ], POINTS_START, 90 * day);
    expect(balances.get('fan')?.balance).toBe(0);
    expect(balances.get('fan2')?.balance).toBe(POINTS_START + 10);
  });
});
