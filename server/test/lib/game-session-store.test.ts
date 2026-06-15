import { describe, it, expect, beforeEach } from 'vitest';
import { GameSessionStore } from '../../src/lib/game-session-store.js';
import type { GamePlugin } from '../../src/lib/game-types.js';

const mockPlugin: GamePlugin = {
  id: 'test-game',
  name: 'Test Game',
  description: 'A test game',
  minPlayers: 2,
  maxPlayers: 8,
  onStart: () => ({ state: {}, payloads: {} }),
  onAction: () => ({ state: {} }),
};

describe('GameSessionStore', () => {
  let store: GameSessionStore;

  beforeEach(() => {
    store = new GameSessionStore();
  });

  it('returns undefined when no session exists for a room', () => {
    expect(store.get('room-xyz')).toBeUndefined();
  });

  it('stores and retrieves a session by room name', () => {
    const payloads = { alice: { myWord: null, others: [] } };
    store.start('room-1', mockPlugin, { key: 'val' }, ['alice', 'bob'], payloads);

    const session = store.get('room-1');
    expect(session).toBeDefined();
    expect(session?.gameId).toBe('test-game');
    expect(session?.participants).toEqual(['alice', 'bob']);
    expect(session?.payloads).toBe(payloads);
    expect(session?.roomName).toBe('room-1');
  });

  it('rooms are isolated from each other', () => {
    store.start('room-1', mockPlugin, {}, ['alice'], { alice: {} });
    store.start('room-2', mockPlugin, {}, ['bob'], { bob: {} });

    expect(store.get('room-1')?.participants).toEqual(['alice']);
    expect(store.get('room-2')?.participants).toEqual(['bob']);
  });

  it('end removes the session and returns true', () => {
    store.start('room-1', mockPlugin, {}, ['alice'], {});
    expect(store.end('room-1')).toBe(true);
    expect(store.get('room-1')).toBeUndefined();
  });

  it('end returns false when no session exists', () => {
    expect(store.end('nonexistent')).toBe(false);
  });

  it('starting a new game in the same room replaces the previous session', () => {
    store.start('room-1', mockPlugin, {}, ['alice', 'bob'], {});
    store.start('room-1', { ...mockPlugin, id: 'new-game' }, {}, ['carol'], {});

    const session = store.get('room-1');
    expect(session?.gameId).toBe('new-game');
    expect(session?.participants).toEqual(['carol']);
  });

  it('records a startedAt timestamp', () => {
    const before = Date.now();
    store.start('room-1', mockPlugin, {}, ['alice'], {});
    const after = Date.now();

    const session = store.get('room-1')!;
    expect(session.startedAt).toBeGreaterThanOrEqual(before);
    expect(session.startedAt).toBeLessThanOrEqual(after);
  });

  it('start returns the newly created session', () => {
    const session = store.start('room-1', mockPlugin, { foo: 'bar' }, ['alice'], {});
    expect(session.gameId).toBe('test-game');
    expect(session.state).toEqual({ foo: 'bar' });
  });
});
