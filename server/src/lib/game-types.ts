export interface GamePlugin {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  onStart(params: GameStartParams): Promise<GameStartResult> | GameStartResult;
  onAction(params: GameActionParams): GameActionResult;
}

export interface GameStartParams {
  participants: string[];
  config?: unknown;
}

export interface GameStartResult {
  state: unknown;
  payloads: Record<string, unknown>;
  broadcast?: unknown;
  spectatorState?: unknown;
}

export interface GameActionParams {
  from: string;
  action: unknown;
  state: unknown;
  participants: string[];
}

export interface GameActionResult {
  state: unknown;
  payloads?: Record<string, unknown>;
  broadcast?: unknown;
  ended?: boolean;
  feedback?: { to: string; message: string };
}

export interface GameInfo {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
}

export interface GameSession {
  plugin: GamePlugin;
  state: unknown;
  participants: string[];
  payloads: Record<string, unknown>;
  spectatorState?: unknown;
  roomName: string;
  gameId: string;
  startedAt: number;
}
