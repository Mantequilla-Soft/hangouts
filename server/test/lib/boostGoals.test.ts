import { describe, expect, it, vi } from 'vitest';
import {
  addBoostToStats,
  boostSummary,
  emptyStats,
  MAX_TRACKED_SUPPORTERS,
  parseBoostExtras,
  readGoal,
  readStats,
  recordBoostTally,
  restampGoal,
} from '../../src/lib/boostGoals.js';

vi.mock('../../src/lib/livekit.js', () => ({ roomService: { listRooms: vi.fn(), updateRoomMetadata: vi.fn() } }));

const NOW = new Date('2026-11-15T12:00:00Z');

describe('parseBoostExtras', () => {
  const apply = (body: Parameters<typeof parseBoostExtras>[0], start: Record<string, unknown> = {}) => {
    const r = parseBoostExtras(body);
    if (!r.ok) throw new Error(r.error);
    return r.apply(start);
  };

  it('stores a goal with a trimmed title and a rounded target', () => {
    expect(apply({ goal: { title: '  a   new  mic ', targetHbd: 50.12345 } })).toEqual({ goal: { title: 'a new mic', targetHbd: 50.123 } });
  });

  it('stores where the bar goes, and refuses an unknown place', () => {
    expect(apply({ goal: { title: 'mic', targetHbd: 5, position: 'top-right' } })).toEqual({ goal: { title: 'mic', targetHbd: 5, position: 'top-right' } });
    expect(parseBoostExtras({ goal: { targetHbd: 5, position: 'middle' } })).toEqual({ ok: false, error: 'Unknown goal position' });
  });

  it('a goal without a title is fine, null removes the goal', () => {
    expect(apply({ goal: { targetHbd: 10 } })).toEqual({ goal: { title: '', targetHbd: 10 } });
    expect(apply({ goal: null }, { goal: { title: 'x', targetHbd: 5 }, enabled: true })).toEqual({ enabled: true });
  });

  it('refuses a zero, negative, huge or missing target and a long title', () => {
    for (const goal of [{ targetHbd: 0 }, { targetHbd: -1 }, { targetHbd: 2_000_000 }, { targetHbd: Number.NaN }, { title: 'x'.repeat(81), targetHbd: 5 }]) {
      expect(parseBoostExtras({ goal }).ok).toBe(false);
    }
  });

  it('switches tiers on and off', () => {
    expect(apply({ tiers: false })).toEqual({ tiers: false });
    expect(apply({ tiers: true }, { tiers: false })).toEqual({ tiers: true });
  });

  it('merges alert toggles into the stored ones', () => {
    expect(apply({ alerts: { tts: true } }, { alerts: { sound: false, ttsMinHbd: 2 } })).toEqual({ alerts: { sound: false, tts: true, ttsMinHbd: 2 } });
    expect(apply({ alerts: { sound: true, ttsMinHbd: 1.23456 } })).toEqual({ alerts: { sound: true, ttsMinHbd: 1.235 } });
    // Read-aloud messages paid with points: the host's off switch is kept.
    expect(apply({ alerts: { readAloud: false } }, { alerts: { tts: true } })).toEqual({ alerts: { tts: true, readAloud: false } });
  });

  it('refuses a negative or huge TTS minimum', () => {
    expect(parseBoostExtras({ alerts: { ttsMinHbd: -1 } }).ok).toBe(false);
    expect(parseBoostExtras({ alerts: { ttsMinHbd: 1e9 } }).ok).toBe(false);
  });

  it('rounds, dedupes and sorts presets; an empty list goes back to the defaults', () => {
    expect(apply({ presets: [25, 5, 5.0001, 1] })).toEqual({ presets: [1, 5, 25] });
    expect(apply({ presets: [] }, { presets: [3] })).toEqual({});
  });

  it('refuses too many presets and amounts that are zero, negative or huge', () => {
    expect(parseBoostExtras({ presets: [1, 2, 3, 4, 5, 6, 7] }).ok).toBe(false);
    expect(parseBoostExtras({ presets: [0] }).ok).toBe(false);
    expect(parseBoostExtras({ presets: [0.0001] }).ok).toBe(false);
    expect(parseBoostExtras({ presets: [-2] }).ok).toBe(false);
    expect(parseBoostExtras({ presets: [200_000] }).ok).toBe(false);
  });

  it('leaves everything alone when no new field is sent', () => {
    expect(apply({}, { enabled: true, goal: { title: 'g', targetHbd: 1 } })).toEqual({ enabled: true, goal: { title: 'g', targetHbd: 1 } });
  });
});

describe('readGoal / readStats', () => {
  it('reads a stored goal and ignores a broken one', () => {
    expect(readGoal({ boost: { goal: { title: 'mic', targetHbd: 50 } } })).toEqual({ title: 'mic', targetHbd: 50 });
    expect(readGoal({ boost: { goal: { targetHbd: 50 } } })).toEqual({ title: '', targetHbd: 50 });
    expect(readGoal({ boost: { goal: { targetHbd: 50, position: 'top' } } })).toEqual({ title: '', targetHbd: 50, position: 'top' });
    expect(readGoal({ boost: { goal: { targetHbd: 50, position: 'nowhere' } } })).toEqual({ title: '', targetHbd: 50 });
    expect(readGoal({ boost: { goal: { title: 'mic', targetHbd: 'lots' } } })).toBeNull();
    expect(readGoal({ boost: ['x'] })).toBeNull();
    expect(readGoal({})).toBeNull();
  });

  it('reads a tally defensively', () => {
    expect(readStats({})).toEqual(emptyStats());
    expect(readStats({ boostStats: 'junk' })).toEqual(emptyStats());
    expect(readStats({
      boostStats: {
        count: 2, totalHbd: -4, goalHbd: 'x',
        supporters: [{ account: 'fan', hbd: 3, count: 2, displayName: 'Fan' }, { hbd: 1 }, null],
        goalReachedAt: '2026-11-15T00:00:00Z', goalReachedFor: 3,
      },
    })).toEqual({
      count: 2, totalHbd: 0, goalHbd: 0,
      supporters: [{ account: 'fan', displayName: 'Fan', hbd: 3, count: 2 }],
      goalReachedAt: '2026-11-15T00:00:00Z', goalReachedFor: 3,
    });
    expect(readStats({ boostStats: { supporters: 'no' } }).supporters).toEqual([]);
  });
});

describe('addBoostToStats', () => {
  const goal = { title: 'mic', targetHbd: 10 };

  it('adds to the totals and to the sender, biggest supporter first', () => {
    let s = emptyStats();
    s = addBoostToStats(s, { account: 'fan', hbd: 2, countsToGoal: true }, goal, NOW).stats;
    s = addBoostToStats(s, { account: 'badadib', displayName: 'Bada', hbd: 3.5, countsToGoal: true }, goal, NOW).stats;
    s = addBoostToStats(s, { account: 'fan', displayName: 'Fan', hbd: 2, countsToGoal: true }, goal, NOW).stats;
    expect(s).toEqual({
      count: 3, totalHbd: 7.5, goalHbd: 7.5,
      supporters: [
        { account: 'fan', displayName: 'Fan', hbd: 4, count: 2 },
        { account: 'badadib', displayName: 'Bada', hbd: 3.5, count: 1 },
      ],
    });
  });

  it('a boost to a collab guest counts in the totals but not towards the goal', () => {
    const { stats } = addBoostToStats(emptyStats(), { account: 'fan', hbd: 4, countsToGoal: false }, goal, NOW);
    expect(stats.totalHbd).toBe(4);
    expect(stats.goalHbd).toBe(0);
  });

  it('flags the boost that reaches the goal, and only that one', () => {
    let r = addBoostToStats(emptyStats(), { account: 'fan', hbd: 9, countsToGoal: true }, goal, NOW);
    expect(r.reachedNow).toBe(false);
    r = addBoostToStats(r.stats, { account: 'fan', hbd: 1, countsToGoal: true }, goal, NOW);
    expect(r.reachedNow).toBe(true);
    expect(r.stats.goalReachedAt).toBe(NOW.toISOString());
    expect(r.stats.goalReachedFor).toBe(10);
    r = addBoostToStats(r.stats, { account: 'fan', hbd: 1, countsToGoal: true }, goal, new Date('2026-11-15T13:00:00Z'));
    expect(r.reachedNow).toBe(false);
    expect(r.stats.goalReachedAt).toBe(NOW.toISOString());
  });

  it('without a goal nothing is ever reached', () => {
    expect(addBoostToStats(emptyStats(), { account: 'fan', hbd: 99, countsToGoal: true }, null, NOW).reachedNow).toBe(false);
  });

  it('keeps only the biggest supporters once the list is full', () => {
    let s = emptyStats();
    for (let i = 0; i < MAX_TRACKED_SUPPORTERS; i += 1) {
      s = addBoostToStats(s, { account: `fan${i}`, hbd: i + 1, countsToGoal: true }, null, NOW).stats;
    }
    s = addBoostToStats(s, { account: 'newfan', hbd: 0.5, countsToGoal: true }, null, NOW).stats;
    expect(s.supporters).toHaveLength(MAX_TRACKED_SUPPORTERS);
    expect(s.supporters.some((x) => x.account === 'newfan')).toBe(false);
    expect(s.supporters[0].account).toBe(`fan${MAX_TRACKED_SUPPORTERS - 1}`);
    expect(s.count).toBe(MAX_TRACKED_SUPPORTERS + 1);
  });

  it('ignores a negative amount', () => {
    expect(addBoostToStats(emptyStats(), { account: 'fan', hbd: -5, countsToGoal: true }, null, NOW).stats.totalHbd).toBe(0);
  });
});

describe('restampGoal', () => {
  const reached = { ...emptyStats(), goalHbd: 12, goalReachedAt: '2026-11-15T10:00:00.000Z', goalReachedFor: 10 };

  it('raising the target past the progress clears "reached"', () => {
    const s = restampGoal(reached, { title: '', targetHbd: 20 }, NOW);
    expect(s.goalReachedAt).toBeUndefined();
    expect(s.goalReachedFor).toBeUndefined();
  });

  it('removing the goal clears "reached"', () => {
    expect(restampGoal(reached, null, NOW).goalReachedAt).toBeUndefined();
  });

  it('the same target keeps the original time', () => {
    expect(restampGoal(reached, { title: 'renamed', targetHbd: 10 }, NOW).goalReachedAt).toBe('2026-11-15T10:00:00.000Z');
  });

  it('a new target already covered counts as reached now', () => {
    const s = restampGoal(reached, { title: '', targetHbd: 12 }, NOW);
    expect(s.goalReachedAt).toBe(NOW.toISOString());
    expect(s.goalReachedFor).toBe(12);
    expect(restampGoal({ ...emptyStats(), goalHbd: 5 }, { title: '', targetHbd: 5 }, NOW).goalReachedAt).toBe(NOW.toISOString());
  });
});

describe('boostSummary', () => {
  it('reports the goal with progress, the totals and the top 5', () => {
    const supporters = Array.from({ length: 7 }, (_, i) => ({ account: `fan${i}`, hbd: 7 - i, count: 1 }));
    const summary = boostSummary({
      boost: { goal: { title: 'mic', targetHbd: 20 } },
      boostStats: { count: 7, totalHbd: 28, goalHbd: 25, supporters, goalReachedAt: 'then', goalReachedFor: 20 },
    });
    expect(summary.goal).toEqual({ title: 'mic', targetHbd: 20, progressHbd: 25, reached: true, reachedAt: 'then' });
    expect(summary.count).toBe(7);
    expect(summary.totalHbd).toBe(28);
    expect(summary.top.map((s) => s.account)).toEqual(['fan0', 'fan1', 'fan2', 'fan3', 'fan4']);
  });

  it('no goal and no boosts', () => {
    expect(boostSummary({})).toEqual({ goal: null, count: 0, totalHbd: 0, top: [] });
    expect(boostSummary({ boost: { goal: { targetHbd: 5 } } }).goal).toEqual({ title: '', targetHbd: 5, progressHbd: 0, reached: false });
  });
});

describe('recordBoostTally', () => {
  function fakeLk(meta: Record<string, unknown>) {
    const state = { metadata: JSON.stringify(meta) };
    return {
      state,
      listRooms: vi.fn(async () => [{ name: 'r', metadata: state.metadata }]),
      updateRoomMetadata: vi.fn(async (_n: string, m: string) => { state.metadata = m; }),
    };
  }

  it('writes the tally into the room metadata and keeps everything else', async () => {
    const lk = fakeLk({ host: 'badadib', title: 'keep', boost: { goal: { title: 'mic', targetHbd: 3 } } });
    const r1 = await recordBoostTally('r', { account: 'fan', hbd: 2, countsToGoal: true }, lk as never);
    const r2 = await recordBoostTally('r', { account: 'fan', hbd: 2, countsToGoal: true }, lk as never);
    expect(r1.reachedNow).toBe(false);
    expect(r2.reachedNow).toBe(true);
    const meta = JSON.parse(lk.state.metadata);
    expect(meta.title).toBe('keep');
    expect(meta.boostStats).toMatchObject({ count: 2, totalHbd: 4, goalHbd: 4, supporters: [{ account: 'fan', hbd: 4, count: 2 }], goalReachedFor: 3 });
  });

  it('two boosts at the same moment both count (per-room lock)', async () => {
    const lk = fakeLk({ host: 'badadib' });
    await Promise.all([
      recordBoostTally('r', { account: 'fan', hbd: 1, countsToGoal: true }, lk as never),
      recordBoostTally('r', { account: 'badadib', hbd: 2, countsToGoal: true }, lk as never),
    ]);
    expect(JSON.parse(lk.state.metadata).boostStats.count).toBe(2);
  });

  it('throws when the room is gone (the listener catches it)', async () => {
    const lk = { listRooms: vi.fn(async () => []), updateRoomMetadata: vi.fn() };
    await expect(recordBoostTally('r', { account: 'fan', hbd: 1, countsToGoal: true }, lk as never)).rejects.toThrow(/not found/i);
  });
});
