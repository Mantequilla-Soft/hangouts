import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_BACKLOG_MAX, addBacklogMessage, clampTimestamp, flushBacklog, getBacklog, purgeBacklogIdentity,
  removeBacklogMessage, resetBacklogs, setBacklogStore, sweepBacklogs, mongoBacklogStore,
  type BacklogMessage, type BacklogStore,
} from '../../src/lib/chatBacklog.js';

function fakeStore(saved: Record<string, BacklogMessage[]> = {}) {
  const inserted: Array<{ room: string; messages: BacklogMessage[] }> = [];
  const store: BacklogStore & { inserted: typeof inserted; removed: string[]; purged: string[] } = {
    inserted,
    removed: [],
    purged: [],
    insert: vi.fn(async (room, messages) => { inserted.push({ room, messages }); }),
    remove: vi.fn(async (_room, ids) => { store.removed.push(...ids); }),
    removeIdentity: vi.fn(async (_room, identity) => { store.purged.push(identity); }),
    load: vi.fn(async (room) => saved[room] ?? []),
  };
  return store;
}

const msg = (n: number, identity = 'fan', at = 1_000_000 + n): BacklogMessage => ({
  id: `${identity}-${at}`, identity, name: identity, text: `hello ${n}`, timestamp: at,
});

beforeEach(() => { resetBacklogs(); });
afterEach(() => { setBacklogStore(null); vi.useRealTimers(); });

describe('chat backlog ring', () => {
  it('keeps lines in time order and ignores a duplicate id', async () => {
    setBacklogStore(null);
    expect(addBacklogMessage('r', msg(2))).toBe(true);
    expect(addBacklogMessage('r', msg(1))).toBe(true);
    expect(addBacklogMessage('r', msg(2))).toBe(false);
    const lines = await getBacklog('r');
    expect(lines.map((m) => m.text)).toEqual(['hello 1', 'hello 2']);
  });

  it('is bounded: only the newest CHAT_BACKLOG_MAX lines stay', async () => {
    setBacklogStore(null);
    for (let i = 0; i < CHAT_BACKLOG_MAX + 25; i++) addBacklogMessage('r', msg(i));
    const lines = await getBacklog('r');
    expect(lines).toHaveLength(CHAT_BACKLOG_MAX);
    expect(lines[0].text).toBe('hello 25');
    expect((await getBacklog('r', 3)).map((m) => m.text)).toEqual([
      `hello ${CHAT_BACKLOG_MAX + 22}`, `hello ${CHAT_BACKLOG_MAX + 23}`, `hello ${CHAT_BACKLOG_MAX + 24}`,
    ]);
  });

  it('cuts overlong text and names and keeps a system line', async () => {
    setBacklogStore(null);
    addBacklogMessage('r', { ...msg(1), name: 'n'.repeat(200), text: 'x'.repeat(900), system: { kind: 'raid', from: 'badadib', viewers: 4 } });
    const [line] = await getBacklog('r');
    expect(line.text).toHaveLength(500);
    expect(line.name).toHaveLength(64);
    expect(line.system).toEqual({ kind: 'raid', from: 'badadib', viewers: 4 });
  });

  it('removes one line and purges a banned chatter', async () => {
    const store = fakeStore();
    setBacklogStore(store);
    addBacklogMessage('r', msg(1, 'fan'));
    addBacklogMessage('r', msg(2, 'guest-abc'));
    addBacklogMessage('r', msg(3, 'guest-abc'));
    expect(await removeBacklogMessage('r', 'fan-1000001')).toBe(true);
    expect(await removeBacklogMessage('r', 'nope')).toBe(false);
    expect(await purgeBacklogIdentity('r', 'guest-abc')).toBe(2);
    expect(await getBacklog('r')).toEqual([]);
    expect(store.removed).toContain('fan-1000001');
    expect(store.purged).toEqual(['guest-abc']);
    // Nothing deleted is written by the next flush.
    await flushBacklog();
    expect(store.inserted).toEqual([]);
  });

  it('writes in batches per room on the flush timer, not per message', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    setBacklogStore(store);
    addBacklogMessage('a', msg(1));
    addBacklogMessage('a', msg(2));
    addBacklogMessage('b', msg(3));
    expect(store.insert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.insert).toHaveBeenCalledTimes(2);
    expect(store.inserted.find((b) => b.room === 'a')!.messages).toHaveLength(2);
  });

  it('a failed flush is logged, never thrown', async () => {
    const store = fakeStore();
    store.insert = vi.fn(async () => { throw new Error('down'); });
    setBacklogStore(store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addBacklogMessage('r', msg(1));
    await expect(flushBacklog()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('after a restart, reads the saved copy once and merges new lines into it', async () => {
    const store = fakeStore({ r: [msg(1), msg(2)] });
    setBacklogStore(store);
    addBacklogMessage('r', msg(3));
    addBacklogMessage('r', msg(2));
    const lines = await getBacklog('r');
    expect(lines.map((m) => m.text)).toEqual(['hello 1', 'hello 2', 'hello 3']);
    await getBacklog('r');
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('a failed load still answers with what is in memory', async () => {
    const store = fakeStore();
    store.load = vi.fn(async () => { throw new Error('down'); });
    setBacklogStore(store);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    addBacklogMessage('r', msg(1));
    expect((await getBacklog('r')).map((m) => m.text)).toEqual(['hello 1']);
    warn.mockRestore();
  });

  it('forgets rings of rooms that are gone', async () => {
    const store = fakeStore();
    setBacklogStore(store);
    addBacklogMessage('gone', msg(1));
    addBacklogMessage('here', msg(2));
    sweepBacklogs(new Set(['here']));
    expect(await getBacklog('gone')).toEqual([]);
    expect(await getBacklog('here')).toHaveLength(1);
  });
});

describe('clampTimestamp', () => {
  it('keeps a sane time and pulls a wrong clock back to about now', () => {
    const now = 10_000_000;
    expect(clampTimestamp(now - 1000, now)).toBe(now - 1000);
    expect(clampTimestamp(now + 999_999, now)).toBe(now + 5000);
    expect(clampTimestamp(1, now)).toBe(now - 60_000);
    expect(clampTimestamp('x', now)).toBe(now);
  });
});

describe('mongoBacklogStore without a database', () => {
  it('does nothing and loads nothing', async () => {
    await expect(mongoBacklogStore.insert('r', [msg(1)])).resolves.toBeUndefined();
    await expect(mongoBacklogStore.remove('r', ['x'])).resolves.toBeUndefined();
    await expect(mongoBacklogStore.removeIdentity('r', 'fan')).resolves.toBeUndefined();
    await expect(mongoBacklogStore.load('r', 10)).resolves.toEqual([]);
  });
});
