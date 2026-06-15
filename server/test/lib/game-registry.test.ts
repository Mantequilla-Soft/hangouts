import { describe, it, expect, beforeEach } from 'vitest';
import { GameRegistry } from '../../src/lib/game-registry.js';
import type { GamePlugin } from '../../src/lib/game-types.js';

function makePlugin(id: string): GamePlugin {
  return {
    id,
    name: `Game ${id}`,
    description: `Test game ${id}`,
    minPlayers: 2,
    maxPlayers: 8,
    onStart: () => ({ state: {}, payloads: {} }),
    onAction: () => ({ state: {} }),
  };
}

describe('GameRegistry', () => {
  let registry: GameRegistry;

  beforeEach(() => {
    registry = new GameRegistry();
  });

  it('returns undefined for an unknown game id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('retrieves a registered plugin by id', () => {
    const plugin = makePlugin('my-game');
    registry.register(plugin);
    expect(registry.get('my-game')).toBe(plugin);
  });

  it('lists all registered plugins', () => {
    registry.register(makePlugin('game-a'));
    registry.register(makePlugin('game-b'));
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((g) => g.id)).toContain('game-a');
    expect(list.map((g) => g.id)).toContain('game-b');
  });

  it('list entries expose only GameInfo fields (not onStart/onAction)', () => {
    registry.register(makePlugin('game-a'));
    const [info] = registry.list();
    expect(info).toHaveProperty('id', 'game-a');
    expect(info).toHaveProperty('name');
    expect(info).toHaveProperty('description');
    expect(info).toHaveProperty('minPlayers');
    expect(info).toHaveProperty('maxPlayers');
    expect(info).not.toHaveProperty('onStart');
    expect(info).not.toHaveProperty('onAction');
  });

  it('returns an empty list when no plugins are registered', () => {
    expect(registry.list()).toEqual([]);
  });

  it('overwrites a plugin with the same id', () => {
    registry.register(makePlugin('game-a'));
    registry.register({ ...makePlugin('game-a'), name: 'Updated Name' });
    expect(registry.get('game-a')?.name).toBe('Updated Name');
    expect(registry.list()).toHaveLength(1);
  });
});
