import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { POINTS_START, memoryPointsStore, setPointsStore } from '../../src/lib/points.js';
import { memoryLedgerStore, setLedgerStore } from '../../src/lib/pointsLedger.js';
import { awardPoints, memoryAwardStore, setAwardBanCheck, setAwardStore } from '../../src/lib/pointsAwards.js';
import {
  QUESTS, QUESTS_PER_WEEK, QUEST_POINTS, activeQuests, memoryWatchMinuteStore, noteLiveWatch, questProgress,
  resetQuestMemory, setWatchMinuteStore,
} from '../../src/lib/pointsQuests.js';

let points: ReturnType<typeof memoryPointsStore>;
let ledger: ReturnType<typeof memoryLedgerStore>;
const cfg = config as { POINTS_QUESTS: string };

beforeEach(() => {
  points = memoryPointsStore();
  setPointsStore(points);
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  setAwardStore(memoryAwardStore());
  setAwardBanCheck(async () => false);
  setWatchMinuteStore(memoryWatchMinuteStore());
  resetQuestMemory();
  cfg.POINTS_QUESTS = 'finish3,listen30,live30';
});
afterEach(() => { cfg.POINTS_QUESTS = ''; });

// Thursday of 2026-W48 (Monday 2026-11-23).
const day = Date.UTC(2026, 10, 26, 12);
const D = 24 * 3600_000;
const quests = () => ledger.rows.filter((r) => r.kind === 'quest').map((r) => `${r.ref}:${r.delta}`);
const finish = (n: number, at = day) => awardPoints([{ id: `finish:alice:bob/v${n}-${at}`, user: 'alice', kind: 'finish' }], at);

describe('the week\'s quests', () => {
  it('three of the built-in set, rotating by ISO week', () => {
    cfg.POINTS_QUESTS = '';
    const a = activeQuests(day).map((q) => q.id);
    const b = activeQuests(day + 7 * D).map((q) => q.id);
    expect(a).toHaveLength(QUESTS_PER_WEEK);
    expect(new Set(a).size).toBe(QUESTS_PER_WEEK);
    expect(b).not.toEqual(a);
    expect(QUESTS.map((q) => q.id)).toEqual(['finish3', 'listen30', 'pollvote2', 'tag5', 'live30']);
  });

  it('POINTS_QUESTS fixes the set', () => {
    cfg.POINTS_QUESTS = 'tag5, pollvote2';
    expect(activeQuests(day).map((q) => q.id)).toEqual(['pollvote2', 'tag5']);
  });
});

describe('progress and payout', () => {
  it('3 videos to the end: 300 points once', async () => {
    await finish(1);
    await finish(2);
    expect((await questProgress('alice', day)).quests[0]).toEqual({
      id: 'finish3', kind: 'finish', target: 3, progress: 2, done: false, points: QUEST_POINTS, title_key: 'wallet.points.quests.finish3',
    });
    await finish(3);
    await finish(4);
    expect(quests()).toEqual(['finish3:300']);
    const view = await questProgress('alice', day);
    expect(view.week).toBe('2026-W48');
    // Capped at the target.
    expect(view.quests[0]).toMatchObject({ progress: 3, done: true });
    expect(await points.get('alice')).toBe(POINTS_START + 4 * 5 + 300);
  });

  it('only this week counts', async () => {
    // Sunday of the week before.
    const lastWeek = Date.UTC(2026, 10, 22, 20);
    await finish(1, lastWeek);
    await finish(2, lastWeek);
    await finish(3);
    expect((await questProgress('alice', day)).quests[0].progress).toBe(1);
    expect(quests()).toEqual([]);
  });

  it('listening sums the minutes', async () => {
    await awardPoints([{ id: 'listen:alice:2026-11-24', user: 'alice', kind: 'listen', units: 20 }], day);
    expect(quests()).toEqual([]);
    await awardPoints([{ id: 'listen:alice:2026-11-25', user: 'alice', kind: 'listen', units: 15 }], day);
    expect(quests()).toEqual(['listen30:300']);
  });

  it('live watching: 30 sampler minutes', async () => {
    for (let i = 0; i < 29; i += 1) await noteLiveWatch(['alice', 'bob'], day + i * 60_000);
    expect(quests()).toEqual([]);
    expect((await questProgress('alice', day)).quests[2]).toMatchObject({ id: 'live30', progress: 29 });
    await noteLiveWatch(['alice'], day + 30 * 60_000);
    await noteLiveWatch(['alice'], day + 31 * 60_000);
    expect(ledger.rows.filter((r) => r.kind === 'quest').map((r) => `${r.user}:${r.ref}`)).toEqual(['alice:live30']);
  });

  it('a quest not running this week pays nothing', async () => {
    cfg.POINTS_QUESTS = 'tag5';
    for (let i = 0; i < 4; i += 1) await finish(i);
    expect(quests()).toEqual([]);
  });
});
