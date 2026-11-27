import { beforeEach, describe, expect, it } from 'vitest';
import { memoryPointsStore, minuteRewards, setPointsStore, type SampleRoom } from '../../src/lib/points.js';
import { memoryLedgerStore, newRow, setLedgerStore } from '../../src/lib/pointsLedger.js';
import { memoryAwardStore, setAwardBanCheck, setAwardStore } from '../../src/lib/pointsAwards.js';
import { memoryWatchMinuteStore, resetQuestMemory, setWatchMinuteStore } from '../../src/lib/pointsQuests.js';
import { resetStreamAwards, streamMinute } from '../../src/lib/pointsStreamAwards.js';

let ledger: ReturnType<typeof memoryLedgerStore>;
let watch: ReturnType<typeof memoryWatchMinuteStore>;

beforeEach(() => {
  setPointsStore(memoryPointsStore());
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  setAwardStore(memoryAwardStore());
  setAwardBanCheck(async () => false);
  watch = memoryWatchMinuteStore();
  setWatchMinuteStore(watch);
  resetQuestMemory();
  resetStreamAwards();
});

const day = Date.UTC(2026, 10, 26, 12);
const MIN = 60_000;

function room(opts: { name?: string; host?: string; guest?: string; viewers?: string[]; guestHere?: boolean }): SampleRoom {
  const host = opts.host ?? 'alice';
  const meta = { mode: 'standalone', host, liveAt: new Date(day - 3600_000).toISOString(), ...(opts.guest ? { collabGuest: opts.guest } : {}) };
  return {
    name: opts.name ?? `${host}-abc1234`,
    metadata: JSON.stringify(meta),
    participants: [
      { identity: host, tracks: [{}] },
      ...(opts.guest && opts.guestHere !== false ? [{ identity: opts.guest, tracks: [{}] }] : []),
      ...(opts.viewers ?? []).map((identity) => ({ identity })),
    ],
  };
}

async function minutes(n: number, rooms: () => SampleRoom[], from = day) {
  for (let i = 0; i < n; i += 1) {
    const list = rooms();
    await streamMinute(list, minuteRewards(list), from + i * MIN);
  }
}
const paid = (kind: string) => ledger.rows.filter((r) => r.kind === kind).map((r) => `${r.user}:${r.delta}${r.ref ? `:${r.ref}` : ''}`);

describe('collab', () => {
  it('both hosts after 10 minutes together, once per pair per day', async () => {
    await minutes(9, () => [room({ guest: 'bob' })]);
    expect(paid('collab')).toEqual([]);
    await minutes(5, () => [room({ guest: 'bob' })], day + 9 * MIN);
    expect(paid('collab')).toEqual(['alice:100:bob', 'bob:100:alice']);
    // A second collab of the pair that day, in another stream: nothing.
    await minutes(12, () => [room({ name: 'bob-zzz9999', host: 'bob', guest: 'alice' })], day + 3600_000);
    expect(paid('collab')).toHaveLength(2);
  });

  it('a guest who is not there does not count', async () => {
    await minutes(12, () => [room({ guest: 'bob', guestHere: false })]);
    expect(paid('collab')).toEqual([]);
  });
});

describe('watch party', () => {
  const five = ['v1fan', 'v2fan', 'v3fan', 'v4fan', 'v5fan'];

  it('200 to the host when 5 signed-in viewers stayed 30 minutes', async () => {
    await minutes(29, () => [room({ viewers: five })]);
    expect(paid('party')).toEqual([]);
    await minutes(3, () => [room({ viewers: five })], day + 29 * MIN);
    expect(paid('party')).toEqual(['alice:200:alice-abc1234']);
  });

  it('guests and 4 viewers are not a party', async () => {
    await minutes(31, () => [room({ viewers: [...five.slice(0, 4), 'guest-abc', 'guest-def'] })]);
    expect(paid('party')).toEqual([]);
  });
});

describe('peak10', () => {
  it('200 once ever for 10 signed-in viewers at once, not counting the host', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `fan${i}aa`);
    await minutes(2, () => [room({ viewers: [...nine, 'alice~watch', 'guest-x1', 'obs-ingress'] })]);
    expect(paid('peak10')).toEqual([]);
    await minutes(2, () => [room({ viewers: [...nine, 'fan9aa'] })], day + 2 * MIN);
    expect(paid('peak10')).toEqual(['alice:200']);
    resetStreamAwards();
    await minutes(1, () => [room({ name: 'alice-new0000', viewers: [...nine, 'fan9aa'] })], day + 30 * 24 * 3600_000);
    expect(paid('peak10')).toHaveLength(1);
  });
});

describe('first stream', () => {
  it('500 for a first stream', async () => {
    await minutes(3, () => [room({})]);
    expect(paid('first')).toEqual(['alice:500:stream']);
  });

  it('nothing for someone who streamed before POINTS_FIRSTS_SINCE', async () => {
    await ledger.insert([newRow('alice', 100, 'stream', Date.UTC(2026, 10, 10))]);
    await minutes(3, () => [room({})]);
    expect(paid('first')).toEqual([]);
  });
});

describe('live watching for the quest', () => {
  it('counts a minute per signed-in viewer, not the hosts', async () => {
    await minutes(3, () => [room({ guest: 'bob', viewers: ['fanone', 'guest-1'] })]);
    expect(await watch.get('fanone', '2026-W48')).toBe(3);
    expect(await watch.get('alice', '2026-W48')).toBe(0);
    expect(await watch.get('bob', '2026-W48')).toBe(0);
  });
});
