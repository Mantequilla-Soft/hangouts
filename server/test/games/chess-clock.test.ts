import { describe, it, expect, vi, afterEach } from 'vitest';
import { chessPlugin } from '../../src/games/chess.ts';

const PLAYERS = ['alice', 'bob'];

function startWithClock(timeControlSecs?: number) {
  return chessPlugin.onStart({
    participants: PLAYERS,
    config: timeControlSecs ? { timeControl: timeControlSecs } : {},
  });
}

function getState(result: ReturnType<typeof startWithClock>) {
  return result.state as {
    fen: string;
    players: { w: string; b: string };
    status: string;
    moveHistory: string[];
    timeControl: number | null;
    whiteClock: number | null;
    blackClock: number | null;
    lastMoveAt: number | null;
    winner?: string;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chess clock — onStart', () => {
  it('initialises clocks when timeControl is provided', () => {
    const result = startWithClock(300);
    const state = getState(result);
    expect(state.timeControl).toBe(300_000);
    expect(state.whiteClock).toBe(300_000);
    expect(state.blackClock).toBe(300_000);
    expect(state.lastMoveAt).toBeTypeOf('number');
  });

  it('leaves clocks null when no timeControl', () => {
    const result = startWithClock();
    const state = getState(result);
    expect(state.timeControl).toBeNull();
    expect(state.whiteClock).toBeNull();
    expect(state.blackClock).toBeNull();
    expect(state.lastMoveAt).toBeNull();
  });

  it('includes clock values in spectatorState', () => {
    const result = startWithClock(180);
    const spec = result.spectatorState as { timeControl: number; whiteClock: number; blackClock: number };
    expect(spec.timeControl).toBe(180_000);
    expect(spec.whiteClock).toBe(180_000);
    expect(spec.blackClock).toBe(180_000);
  });
});

describe('chess clock — move deduction', () => {
  it('deducts elapsed time from the moving player\'s clock', () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0);          // onStart lastMoveAt
    const result = startWithClock(300);
    const state = getState(result);
    const white = state.players.w;

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 5_000);    // 5 seconds later
    const actionResult = chessPlugin.onAction({
      from: white,
      action: { type: 'move', from: 'e2', to: 'e4' },
      state: result.state,
      participants: PLAYERS,
    });
    const newState = actionResult.state as typeof state;
    expect(newState.whiteClock).toBe(295_000);   // 300s - 5s
    expect(newState.blackClock).toBe(300_000);   // unchanged
    expect(newState.lastMoveAt).toBe(t0 + 5_000);
  });

  it('includes whiteClock and blackClock in chess_move broadcast', () => {
    const t0 = 2_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0);
    const result = startWithClock(60);
    const state = getState(result);

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3_000);
    const actionResult = chessPlugin.onAction({
      from: state.players.w,
      action: { type: 'move', from: 'e2', to: 'e4' },
      state: result.state,
      participants: PLAYERS,
    });
    const broadcast = actionResult.broadcast as { type: string; whiteClock: number; blackClock: number };
    expect(broadcast.type).toBe('chess_move');
    expect(broadcast.whiteClock).toBe(57_000);
    expect(broadcast.blackClock).toBe(60_000);
  });

  it('does not touch clocks in an untimed game', () => {
    const result = startWithClock();
    const state = getState(result);
    const white = state.players.w;
    const actionResult = chessPlugin.onAction({
      from: white,
      action: { type: 'move', from: 'e2', to: 'e4' },
      state: result.state,
      participants: PLAYERS,
    });
    const newState = actionResult.state as typeof state;
    expect(newState.whiteClock).toBeNull();
    expect(newState.blackClock).toBeNull();
  });
});

describe('chess clock — timeout on move', () => {
  it('triggers timeout when mover\'s clock expires', () => {
    const t0 = 3_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0);
    const result = startWithClock(5);    // 5 seconds
    const state = getState(result);
    const white = state.players.w;
    const black = state.players.b;

    // 6 seconds pass — white clock is now 0 when they try to move
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 6_000);
    const actionResult = chessPlugin.onAction({
      from: white,
      action: { type: 'move', from: 'e2', to: 'e4' },
      state: result.state,
      participants: PLAYERS,
    });

    expect(actionResult.ended).toBe(true);
    const finalState = actionResult.state as typeof state;
    expect(finalState.status).toBe('timeout');
    expect(finalState.winner).toBe(black);
    const broadcast = actionResult.broadcast as { type: string; result: string; winner: string };
    expect(broadcast.type).toBe('chess_game_over');
    expect(broadcast.result).toBe('timeout');
    expect(broadcast.winner).toBe(black);
  });
});

describe('chess clock — claim_timeout', () => {
  it('grants win when opponent clock has expired', () => {
    const t0 = 4_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0);
    const result = startWithClock(5);
    const state = getState(result);
    const white = state.players.w;
    const black = state.players.b;
    // White is the active player at start; black claims after 6 seconds
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 6_000);
    const actionResult = chessPlugin.onAction({
      from: black,
      action: { type: 'claim_timeout' },
      state: result.state,
      participants: PLAYERS,
    });
    expect(actionResult.ended).toBe(true);
    const finalState = actionResult.state as typeof state;
    expect(finalState.status).toBe('timeout');
    expect(finalState.winner).toBe(black);
  });

  it('returns feedback when opponent still has time', () => {
    const t0 = 5_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0);
    const result = startWithClock(300);
    const state = getState(result);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3_000);
    const actionResult = chessPlugin.onAction({
      from: state.players.b,
      action: { type: 'claim_timeout' },
      state: result.state,
      participants: PLAYERS,
    });
    expect(actionResult.ended).toBeFalsy();
    expect(actionResult.feedback).toBeDefined();
  });

  it('returns feedback when active player tries to claim against themselves', () => {
    const t0 = 6_000_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(t0);
    const result = startWithClock(5);
    const state = getState(result);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 6_000);
    const actionResult = chessPlugin.onAction({
      from: state.players.w,  // white is active and tries to claim timeout
      action: { type: 'claim_timeout' },
      state: result.state,
      participants: PLAYERS,
    });
    expect(actionResult.ended).toBeFalsy();
    expect(actionResult.feedback).toBeDefined();
  });

  it('is a no-op on an untimed game', () => {
    const result = startWithClock();
    const state = getState(result);
    const actionResult = chessPlugin.onAction({
      from: state.players.b,
      action: { type: 'claim_timeout' },
      state: result.state,
      participants: PLAYERS,
    });
    expect(actionResult.ended).toBeFalsy();
    expect(actionResult.feedback).toBeUndefined();
    const unchanged = actionResult.state as typeof state;
    expect(unchanged.fen).toBe(state.fen);
  });
});
