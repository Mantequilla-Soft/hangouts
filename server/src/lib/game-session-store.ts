import type { GamePlugin, GameSession } from './game-types.js';

export class GameSessionStore {
  private sessions = new Map<string, GameSession>();

  start(
    roomName: string,
    plugin: GamePlugin,
    state: unknown,
    participants: string[],
    payloads: Record<string, unknown>,
  ): GameSession {
    const session: GameSession = {
      plugin,
      state,
      participants,
      payloads,
      roomName,
      gameId: plugin.id,
      startedAt: Date.now(),
    };
    this.sessions.set(roomName, session);
    return session;
  }

  get(roomName: string): GameSession | undefined {
    return this.sessions.get(roomName);
  }

  end(roomName: string): boolean {
    return this.sessions.delete(roomName);
  }
}

export const gameSessionStore = new GameSessionStore();
