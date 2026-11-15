import { describe, expect, it } from 'vitest';
import {
  ALERT_FRESH_MS,
  BOOST_BASE_DISPLAY_MS,
  BOOST_TIERS,
  DEFAULT_BOOST_PRESETS,
  DEFAULT_TTS_MIN_HBD,
  GOAL_NEWS_MS,
  alertSettings,
  boostDisplayMs,
  boostPresets,
  boostSpeechText,
  boostTier,
  boostTierColorVar,
  fillLabel,
  formatHbd,
  goalJustReached,
  goalProgress,
  parsePresetsInput,
  parseRoomMeta,
  pickPinnedBoosts,
  planBoostAlert,
  readBoostConfig,
  readBoostGoal,
  readBoostStats,
  tiersEnabled,
  topSupporters,
} from '../src/lib/boostGoals.js';

describe('room metadata readers', () => {
  it('parseRoomMeta survives empty and broken JSON', () => {
    expect(parseRoomMeta(undefined)).toEqual({});
    expect(parseRoomMeta('')).toEqual({});
    expect(parseRoomMeta('{nope')).toEqual({});
    expect(parseRoomMeta('[1,2]')).toEqual({});
    expect(parseRoomMeta('{"host":"badadib"}')).toEqual({ host: 'badadib' });
  });

  it('readBoostConfig and readBoostGoal', () => {
    expect(readBoostConfig({})).toBeUndefined();
    expect(readBoostConfig({ boost: ['x'] })).toBeUndefined();
    const config = readBoostConfig({ boost: { enabled: true, goal: { title: 'mic', targetHbd: 50 } } });
    expect(readBoostGoal(config)).toEqual({ title: 'mic', targetHbd: 50 });
    expect(readBoostGoal({ goal: { targetHbd: 5 } as never })).toEqual({ title: '', targetHbd: 5 });
    expect(readBoostGoal({ goal: { title: 'x', targetHbd: 0 } })).toBeNull();
    expect(readBoostGoal(undefined)).toBeNull();
  });

  it('readBoostStats is defensive', () => {
    expect(readBoostStats({})).toEqual({ count: 0, totalHbd: 0, goalHbd: 0, supporters: [] });
    expect(readBoostStats({
      boostStats: {
        count: 2, totalHbd: 3, goalHbd: -1,
        supporters: [{ account: 'fan', hbd: 3, count: 2 }, { account: '' }, 'x'],
        goalReachedAt: 't', goalReachedFor: 3,
      },
    })).toEqual({
      count: 2, totalHbd: 3, goalHbd: 0,
      supporters: [{ account: 'fan', hbd: 3, count: 2 }],
      goalReachedAt: 't', goalReachedFor: 3,
    });
  });
});

describe('goalProgress and topSupporters', () => {
  const stats = { count: 3, totalHbd: 30, goalHbd: 25, supporters: [] };

  it('fraction is clamped and reached flips at the target', () => {
    expect(goalProgress({ title: 'mic', targetHbd: 50 }, stats)).toEqual({ title: 'mic', targetHbd: 50, progressHbd: 25, fraction: 0.5, reached: false });
    expect(goalProgress({ title: '', targetHbd: 20 }, stats)).toMatchObject({ fraction: 1, reached: true });
    expect(goalProgress({ title: '', targetHbd: 25 }, stats)?.reached).toBe(true);
    expect(goalProgress(null, stats)).toBeNull();
  });

  it('top supporters: biggest first, five at most', () => {
    const supporters = [1, 7, 3, 9, 2, 8].map((hbd, i) => ({ account: `fan${i}`, hbd, count: 1 }));
    expect(topSupporters({ ...stats, supporters }).map((s) => s.hbd)).toEqual([9, 8, 7, 3, 2]);
    expect(topSupporters({ ...stats, supporters }, 2)).toHaveLength(2);
  });
});

describe('tiers', () => {
  it('brackets: under 1, 1 to 5, 5 to 20, 20 and up', () => {
    expect([0.5, 0.999, 1, 4.99, 5, 19.99, 20, 500].map((n) => boostTier(n).level)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('bigger tiers stay longer; tiers off means the fixed time', () => {
    const times = BOOST_TIERS.map((t) => t.displayMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(boostDisplayMs(25, true)).toBe(120_000);
    expect(boostDisplayMs(0.5, true)).toBe(15_000);
    expect(boostDisplayMs(25, false)).toBe(BOOST_BASE_DISPLAY_MS);
  });

  it('tiers default to on', () => {
    expect(tiersEnabled(undefined)).toBe(true);
    expect(tiersEnabled({})).toBe(true);
    expect(tiersEnabled({ tiers: false })).toBe(false);
  });

  it('colours come only from existing theme tokens', () => {
    expect([0, 1, 2, 3].map(boostTierColorVar)).toEqual(['--hh-text-muted', '--hh-success', '--hh-primary', '--hh-pro-gold']);
  });
});

describe('pickPinnedBoosts', () => {
  const now = 1_000_000;
  const b = (id: string, usdAmount: number, ageMs: number, belowMinimum = false) => ({ id, usdAmount, timestamp: now - ageMs, belowMinimum });

  it('drops expired and hidden boosts, by each tier\'s own time', () => {
    const list = [b('small-old', 0.5, 20_000), b('big-old', 25, 100_000), b('hidden', 5, 1000, true), b('fresh', 2, 1000)];
    expect(pickPinnedBoosts(list, now, true, 5).map((x) => x.id)).toEqual(['big-old', 'fresh']);
    // Tiers off: the fixed 30 s for everything.
    expect(pickPinnedBoosts(list, now, false, 5).map((x) => x.id)).toEqual(['small-old', 'fresh']);
  });

  it('with more than fit, the bigger tiers keep their slot, the rest are the newest', () => {
    const list = [b('big', 30, 50_000), b('a', 1, 3000), b('c', 2, 1000), b('d', 0.5, 500)];
    expect(pickPinnedBoosts(list, now, true, 2).map((x) => x.id)).toEqual(['big', 'c']);
  });

  it('tiers off: simply the newest', () => {
    const list = [b('big', 30, 20_000), b('a', 1, 3000), b('c', 2, 1000)];
    expect(pickPinnedBoosts(list, now, false, 2).map((x) => x.id)).toEqual(['a', 'c']);
  });
});

describe('presets', () => {
  it('the host\'s presets, sorted and capped, or the defaults', () => {
    expect(boostPresets(undefined)).toEqual([...DEFAULT_BOOST_PRESETS]);
    expect(boostPresets({ presets: [] })).toEqual([...DEFAULT_BOOST_PRESETS]);
    expect(boostPresets({ presets: [10, 2, 2, -1, Number.NaN as number] })).toEqual([2, 10]);
    expect(boostPresets({ presets: [9, 8, 7, 6, 5, 4, 3, 2] })).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('parsePresetsInput reads commas and spaces and refuses junk', () => {
    expect(parsePresetsInput('1, 5 10;25')).toEqual([1, 5, 10, 25]);
    expect(parsePresetsInput('  ')).toEqual([]);
    expect(parsePresetsInput('2.12345')).toEqual([2.123]);
    expect(parsePresetsInput('5, abc')).toBeNull();
    expect(parsePresetsInput('-1')).toBeNull();
    expect(parsePresetsInput('0.0001')).toBeNull();
  });
});

describe('alerts', () => {
  const now = 5_000_000;

  it('defaults: chime on, read aloud off, from 5 HBD', () => {
    expect(alertSettings(undefined)).toEqual({ sound: true, tts: false, ttsMinHbd: DEFAULT_TTS_MIN_HBD });
    expect(alertSettings({ alerts: { sound: false, tts: true, ttsMinHbd: 2 } })).toEqual({ sound: false, tts: true, ttsMinHbd: 2 });
    expect(alertSettings({ alerts: { ttsMinHbd: -3 } }).ttsMinHbd).toBe(DEFAULT_TTS_MIN_HBD);
  });

  it('planBoostAlert: chime per setting, speech from the minimum, nothing for hidden or stale', () => {
    const on = { sound: true, tts: true, ttsMinHbd: 5 };
    expect(planBoostAlert({ id: 'a', usdAmount: 10, timestamp: now - 1000 }, on, now)).toEqual({ chime: true, speak: true });
    expect(planBoostAlert({ id: 'a', usdAmount: 2, timestamp: now - 1000 }, on, now)).toEqual({ chime: true, speak: false });
    expect(planBoostAlert({ id: 'a', usdAmount: 10, timestamp: now - 1000, belowMinimum: true }, on, now)).toEqual({ chime: false, speak: false });
    expect(planBoostAlert({ id: 'a', usdAmount: 10, timestamp: now - ALERT_FRESH_MS }, on, now)).toEqual({ chime: false, speak: false });
    expect(planBoostAlert({ id: 'a', usdAmount: 10, timestamp: now }, { ...on, sound: false, tts: false }, now)).toEqual({ chime: false, speak: false });
  });

  it('boostSpeechText reads the name, a tidy amount and the message', () => {
    expect(boostSpeechText({ sender: 'fan', amount: '5.000', asset: 'HBD', message: 'Great  stream!' })).toBe('fan boosted 5 HBD. Great stream!');
    expect(boostSpeechText({ sender: 'fan', displayName: 'Fan', amount: '2.500', asset: 'HIVE', message: 'hi' }, '{name}: {amount} {asset}, {message}')).toBe('Fan: 2.5 HIVE, hi');
  });
});

describe('small helpers', () => {
  it('fillLabel fills known placeholders and leaves the rest', () => {
    expect(fillLabel('{a} of {b} {c}', { a: 1, b: 'two' })).toBe('1 of two {c}');
  });

  it('formatHbd', () => {
    expect(formatHbd(50)).toBe('50');
    expect(formatHbd(12.5)).toBe('12.5');
    expect(formatHbd(0.25)).toBe('0.25');
    expect(formatHbd(0)).toBe('0');
    expect(formatHbd(1234.56)).toBe('1235');
    // Whole amounts from 100 up keep their zeros (100 once read as "1").
    expect(formatHbd(100)).toBe('100');
    expect(formatHbd(150)).toBe('150');
    expect(formatHbd(1000)).toBe('1000');
    expect(formatHbd(Number.NaN)).toBe('0');
  });

  it('goalJustReached: only a new, recent stamp after the first look', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const fresh = '2026-11-15T11:59:30Z';
    expect(goalJustReached(undefined, fresh, true, now)).toBe(false);
    expect(goalJustReached(undefined, fresh, false, now)).toBe(true);
    expect(goalJustReached(fresh, fresh, false, now)).toBe(false);
    expect(goalJustReached(fresh, undefined, false, now)).toBe(false);
    expect(goalJustReached(undefined, new Date(now - GOAL_NEWS_MS - 1).toISOString(), false, now)).toBe(false);
    expect(goalJustReached(undefined, 'not a date', false, now)).toBe(true);
    expect(goalJustReached(undefined, fresh, false)).toBe(true);
  });
});
