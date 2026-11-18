import { beforeEach, describe, expect, it } from 'vitest';
import { ParticipantInfo_Kind } from '@livekit/protocol';
import {
  BATTLE_POINTS, BOOST_POINTS_MAX, CHAT_POINTS_PER_MIN_MAX, PAIR_REWARD_GAP_MS, POINTS_START, RAID_POINTS,
  STREAM_POINTS_PER_MIN, WATCH_POINTS_PER_MIN, boostReward, chatWords, earnForBattle, earnForBoost, earnForChat,
  earnForRaid, memoryPointsStore, minuteRewards, pointsAccount, resetPointsEarning, setPointsStore, spendPoints,
} from '../../src/lib/points.js';

let store: ReturnType<typeof memoryPointsStore>;
// award() is fire-and-forget; the memory store applies synchronously inside it.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store = memoryPointsStore();
  setPointsStore(store);
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
    expect(out.get('fan')).toBe(WATCH_POINTS_PER_MIN);
    expect(out.get('fan2')).toBe(WATCH_POINTS_PER_MIN);
    expect(out.get('badadib')).toBe(STREAM_POINTS_PER_MIN);
    expect(out.has('guest-x1')).toBe(false);
  });

  it('a guest audience is enough for the host; HLS viewers count too', () => {
    const hls = p('fan', { permission: { canSubscribe: false } });
    expect(minuteRewards([{ metadata: live(), participants: [studio, p('guest-a1')] }]).get('badadib')).toBe(STREAM_POINTS_PER_MIN);
    expect(minuteRewards([{ metadata: live(), participants: [studio, hls] }]).get('fan')).toBe(WATCH_POINTS_PER_MIN);
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
    expect(minuteRewards([{ metadata: live(), participants: [obs, p('fan')] }]).get('badadib')).toBe(STREAM_POINTS_PER_MIN);
  });

  it('once per account across tabs and streams; a streamer watching elsewhere earns as a streamer', () => {
    const other = { metadata: live({ host: 'fan2' }), participants: [p('fan2', { tracks: [{}] }), p('fan'), p('badadib~watch')] };
    const out = minuteRewards([{ metadata: live(), participants: [studio, p('fan'), p('fan')] }, other]);
    expect(out.get('fan')).toBe(WATCH_POINTS_PER_MIN);
    expect(out.get('badadib')).toBe(STREAM_POINTS_PER_MIN);
    expect(out.get('fan2')).toBe(STREAM_POINTS_PER_MIN);
  });

  it('a collab guest on air earns as a streamer, not as a viewer', () => {
    const out = minuteRewards([{ metadata: live({ collabGuest: 'fan2' }), participants: [studio, p('fan2'), p('fan')] }]);
    expect(out.get('fan2')).toBe(STREAM_POINTS_PER_MIN);
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
    expect(await spendPoints('fan', 600)).toBe(POINTS_START - 600);
    expect(await spendPoints('fan', 600)).toBeNull();
    expect(store.balances.get('fan')).toBe(POINTS_START - 600);
  });
});
