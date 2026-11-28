import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPointsStore, resetPointsEarning, setPointsStore } from '../../src/lib/points.js';
import { memoryLedgerStore, setLedgerStore } from '../../src/lib/pointsLedger.js';
import { memoryAwardStore, setAwardBanCheck, setAwardStore } from '../../src/lib/pointsAwards.js';
import { createPoll, memoryPollArchive, resetPolls, setPollStores, vote } from '../../src/lib/polls.js';
import { memoryClipStore, registerClip, setClipStore } from '../../src/lib/streamClips.js';
import { RAID_COUNTDOWN_SEC, resetRaids, startRaid } from '../../src/lib/raids.js';

let ledger: ReturnType<typeof memoryLedgerStore>;

beforeEach(() => {
  const points = memoryPointsStore();
  setPointsStore(points);
  ledger = memoryLedgerStore();
  setLedgerStore(ledger);
  setAwardStore(memoryAwardStore());
  setAwardBanCheck(async () => false);
  resetPointsEarning();
  resetPolls();
  setPollStores({ points, archive: memoryPollArchive() });
  setClipStore(memoryClipStore());
  resetRaids();
});
afterEach(() => { vi.useRealTimers(); });

const rows = (kind: string) => ledger.rows.filter((r) => r.kind === kind).map((r) => `${r.user}:${r.delta}:${r.ref}`);

describe('awards from the code that sees the event', () => {
  it('a vote in someone else\'s poll: pollvote, not in your own room', async () => {
    const p = createPoll('alice-room1', 'alice', { kind: 'poll', question: 'Next?', options: ['A', 'B'], durationSec: 60 }, null);
    vote('alice-room1', p.id, 'fan', 0);
    vote('alice-room1', p.id, 'alice', 1);
    await vi.waitFor(() => expect(rows('pollvote')).toEqual(['fan:5:alice-room1']));
  });

  it('a viewer clip of someone else\'s stream: clip, with the streamer as ref', async () => {
    const base = { room: 'alice-r1', host: 'alice', source: 'viewer' as const, file: 'f.mp4', offsetSec: 60, durationSec: 30 };
    await registerClip({ ...base, clipper: 'fan' });
    await registerClip({ ...base, clipper: 'alice' });
    await registerClip({ ...base, clipper: null, source: 'auto' });
    await vi.waitFor(() => expect(rows('clip')).toEqual(['fan:10:alice']));
  });

  it('a raid that paid the raider: raided for the one raided', async () => {
    vi.useFakeTimers();
    startRaid({ from: 'alice', fromRoom: 'alice-r1', target: { roomName: 'bob-r1', host: 'bob', title: 'Hi' }, viewers: 3 }, () => undefined);
    await vi.advanceTimersByTimeAsync(RAID_COUNTDOWN_SEC * 1000 + 10);
    vi.useRealTimers();
    await vi.waitFor(() => expect(rows('raided')).toEqual(['bob:100:alice']));
  });
});
