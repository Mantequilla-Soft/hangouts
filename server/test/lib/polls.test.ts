import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POINTS_START, PollError, activePoll, cancelPoll, createPoll, endPoll, listRoomPolls, memoryPointsStore,
  memoryPollArchive, onPollChange, payouts, pointsBalance, resetPolls, resolvePrediction, setPollStores,
  stake, sweepPolls, toView, vote,
} from '../../src/lib/polls.js';

let points: ReturnType<typeof memoryPointsStore>;
let archive: ReturnType<typeof memoryPollArchive>;
const changes: string[] = [];

beforeEach(() => {
  resetPolls();
  points = memoryPointsStore();
  archive = memoryPollArchive();
  setPollStores({ points, archive });
  changes.length = 0;
  onPollChange((p) => changes.push(`${p.kind}:${p.status}`));
});
afterEach(() => { vi.useRealTimers(); });

const poll = (over: Partial<{ kind: 'poll' | 'prediction'; question: string; options: string[]; durationSec: number }> = {}) => (
  createPoll('room1', 'badadib', { kind: 'poll', question: 'Next game?', options: ['Chess', 'Draw'], durationSec: 60, ...over }, 42)
);
const prediction = () => poll({ kind: 'prediction', question: 'Will I win?', options: ['Yes', 'No'], durationSec: 120 });

async function rejects(fn: () => unknown, status: number) {
  try { await fn(); } catch (err) { expect(err).toBeInstanceOf(PollError); expect((err as PollError).status).toBe(status); return; }
  throw new Error('expected a PollError');
}

describe('createPoll', () => {
  it('starts a poll with its stream offset and tells the room', () => {
    const p = poll();
    expect(activePoll('room1')).toBe(p);
    expect(toView(p)).toMatchObject({ kind: 'poll', question: 'Next game?', total: 0, status: 'open', offset: 42 });
    expect(toView(p).options).toEqual([{ label: 'Chess', votes: 0 }, { label: 'Draw', votes: 0 }]);
    expect(changes).toEqual(['poll:open']);
  });

  it('validates question, options and timer, and runs one at a time', async () => {
    await rejects(() => poll({ question: '  ' }), 400);
    await rejects(() => poll({ options: ['only'] }), 400);
    await rejects(() => poll({ options: ['a', 'b', 'c', 'd', 'e'] }), 400);
    await rejects(() => poll({ options: ['Same', 'same'] }), 400);
    await rejects(() => poll({ durationSec: 5 }), 400);
    await rejects(() => poll({ durationSec: 601 }), 400);
    await rejects(() => poll({ kind: 'prediction', options: ['a', 'b', 'c'] }), 400);
    poll();
    await rejects(() => poll(), 409);
  });

  it('caps how many polls one stream can run', async () => {
    for (let i = 0; i < 60; i++) { const p = poll(); await cancelPoll('room1', p.id); }
    await rejects(() => poll(), 429);
  });
});

describe('vote', () => {
  it('counts one vote per account', async () => {
    const p = poll();
    vote('room1', p.id, 'fan', 1);
    vote('room1', p.id, 'badadib', 0);
    await rejects(() => vote('room1', p.id, 'fan', 0), 409);
    await rejects(() => vote('room1', p.id, 'other', 5), 400);
    await rejects(() => vote('room1', 'wrong-id', 'other', 0), 404);
    expect(toView(p).options.map((o) => o.votes)).toEqual([1, 1]);
    expect(toView(p).total).toBe(2);
  });

  it('closes on its timer and archives the result', async () => {
    vi.useFakeTimers();
    const p = poll({ durationSec: 15 });
    vote('room1', p.id, 'fan', 0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(activePoll('room1')).toBeNull();
    expect(p.status).toBe('closed');
    const [saved] = await listRoomPolls('room1');
    expect(saved).toMatchObject({ id: p.id, status: 'closed', total: 1, offset: 42 });
    await rejects(() => vote('room1', p.id, 'late', 0), 404);
  });

  it('a stake is refused on a poll and a vote on a prediction', async () => {
    const p = poll();
    await rejects(() => stake('room1', p.id, 'fan', 0, 10), 400);
    await cancelPoll('room1', p.id);
    const q = prediction();
    await rejects(() => vote('room1', q.id, 'fan', 0), 400);
  });
});

describe('predictions', () => {
  it('stakes points within the balance, one side per viewer, never the host', async () => {
    const p = prediction();
    const first = await stake('room1', p.id, 'fan', 0, 300);
    expect(first.balance).toBe(POINTS_START - 300);
    const more = await stake('room1', p.id, 'fan', 0, 200);
    expect(more.balance).toBe(POINTS_START - 500);
    await rejects(() => stake('room1', p.id, 'fan', 1, 10), 409);
    await rejects(() => stake('room1', p.id, 'fan', 0, POINTS_START), 400);
    await rejects(() => stake('room1', p.id, 'fan', 0, 0), 400);
    await rejects(() => stake('room1', p.id, 'badadib', 0, 10), 403);
    await rejects(() => stake('room1', p.id, 'x', 3, 10), 400);
    expect(toView(p).options[0]).toEqual({ label: 'Yes', votes: 1, points: 500 });
    expect(toView(p).pot).toBe(500);
  });

  it('locks when the window closes, then the host resolves and winners split the pot', async () => {
    vi.useFakeTimers();
    const p = prediction();
    await stake('room1', p.id, 'a', 0, 100);
    await stake('room1', p.id, 'b', 0, 300);
    await stake('room1', p.id, 'c', 1, 400);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.status).toBe('locked');
    await rejects(() => stake('room1', p.id, 'd', 0, 10), 409);
    await resolvePrediction('room1', p.id, 0);
    // Pot 800, winning pool 400: a gets 200 back (+100), b 600 (+300), c loses 400.
    expect(await pointsBalance('a')).toBe(POINTS_START + 100);
    expect(await pointsBalance('b')).toBe(POINTS_START + 300);
    expect(await pointsBalance('c')).toBe(POINTS_START - 400);
    // One balance across all streams: no per-channel copy.
    expect(points.balances.get('a')).toBe(POINTS_START + 100);
    const [saved] = await listRoomPolls('room1');
    expect(saved).toMatchObject({ status: 'resolved', winner: 0, pot: 800 });
    expect(changes).toEqual(expect.arrayContaining(['prediction:locked', 'prediction:resolved']));
  });

  it('nobody on the winning side: everybody keeps their points', () => {
    const p = prediction();
    p.stakes.set('a', { option: 1, amount: 50 });
    expect(payouts(p, 0).size).toBe(0);
  });

  it('the host can close the window early, cancel, or let an unresolved one lapse', async () => {
    vi.useFakeTimers();
    const p = prediction();
    await stake('room1', p.id, 'fan', 1, 100);
    await endPoll('room1', p.id);
    expect(p.status).toBe('locked');
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000 + 1000);
    expect(p.status).toBe('cancelled');
    expect(await pointsBalance('fan')).toBe(POINTS_START);

    const q = prediction();
    await cancelPoll('room1', q.id);
    expect(q.status).toBe('cancelled');
    await rejects(() => resolvePrediction('room1', q.id, 0), 404);
  });

  it('resolve checks the kind and the outcome', async () => {
    const p = poll();
    await rejects(() => resolvePrediction('room1', p.id, 0), 400);
    await endPoll('room1', p.id);
    expect(p.status).toBe('closed');
    const q = prediction();
    await rejects(() => resolvePrediction('room1', q.id, 4), 400);
  });

  it('a balance never goes below zero in the memory store', async () => {
    await points.apply(new Map([['fan', -5000]]));
    expect(await pointsBalance('fan')).toBe(0);
  });
});

describe('sweepPolls', () => {
  it('ends the poll of a room that is gone', async () => {
    const p = poll();
    sweepPolls(new Set(['other']));
    expect(activePoll('room1')).toBeNull();
    expect(p.status).toBe('closed');
  });

  it('an archive failure is logged, not thrown', async () => {
    setPollStores({ archive: { save: async () => { throw new Error('down'); }, list: async () => [] } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = poll();
    await expect(cancelPoll('room1', p.id)).resolves.toBe(p);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
