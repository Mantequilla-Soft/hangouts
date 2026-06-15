import type { GamePlugin, GameInfo } from './game-types.js';

export class GameRegistry {
  private plugins = new Map<string, GamePlugin>();

  register(plugin: GamePlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  get(id: string): GamePlugin | undefined {
    return this.plugins.get(id);
  }

  list(): GameInfo[] {
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      minPlayers: p.minPlayers,
      maxPlayers: p.maxPlayers,
    }));
  }
}

export const gameRegistry = new GameRegistry();
