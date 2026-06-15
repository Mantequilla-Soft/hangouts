import { describe, it, expect } from 'vitest';
import { chessPlugin } from '../../src/games/chess.ts';

const PLAYERS = ['alice', 'bob'];

function startAndGetState() {
  const result = chessPlugin.onStart({ participants: PLAYERS });
  const state = result.state as {
    fen: string;
    players: { w: string; b: string };
    status: string;
    moveHistory: string[];
  };
  return { result, state };
}

describe('chessPlugin metadata', () => {
  it('has id chess', () => expect(chessPlugin.id).toBe('chess'));
  it('requires exactly 2 players', () => {
    expect(chessPlugin.minPlayers).toBe(2);
    expect(chessPlugin.maxPlayers).toBe(2);
  });
});

describe('chessPlugin.onStart', () => {
  it('assigns one player white and one black', () => {
    const { state } = startAndGetState();
    expect([state.players.w, state.players.b]).toEqual(expect.arrayContaining(PLAYERS));
    expect(state.players.w).not.toBe(state.players.b);
  });

  it('returns a valid starting FEN', () => {
    const { state } = startAndGetState();
    expect(state.fen).toMatch(/^rnbqkbnr/);
    expect(state.status).toBe('playing');
    expect(state.moveHistory).toEqual([]);
  });

  it('sends each player their color in payloads', () => {
    const { result, state } = startAndGetState();
    const wPayload = result.payloads[state.players.w] as { color: string; players: { w: string; b: string } };
    const bPayload = result.payloads[state.players.b] as { color: string; players: { w: string; b: string } };
    expect(wPayload.color).toBe('w');
    expect(bPayload.color).toBe('b');
    expect(wPayload.players).toEqual(state.players);
  });

  it('includes spectatorState with fen and players', () => {
    const { result, state } = startAndGetState();
    const spectator = result.spectatorState as { fen: string; players: { w: string; b: string }; status: string };
    expect(spectator.fen).toBe(state.fen);
    expect(spectator.players).toEqual(state.players);
    expect(spectator.status).toBe('playing');
  });
});

describe('chessPlugin.onAction — move', () => {
  it('accepts a legal opening move and updates FEN', () => {
    const { result, state } = startAndGetState();
    const white = state.players.w;
    const actionResult = chessPlugin.onAction({
      from: white,
      action: { type: 'move', from: 'e2', to: 'e4' },
      state: result.state,
      participants: PLAYERS,
    });
    const newState = actionResult.state as { fen: string; moveHistory: string[] };
    expect(newState.fen).not.toBe(state.fen);
    expect(newState.moveHistory).toHaveLength(1);
    expect(newState.moveHistory[0]).toBe('e4');
    expect(actionResult.ended).toBeFalsy();
    expect(actionResult.feedback).toBeUndefined();
  });

  it('broadcasts chess_move with fen and san', () => {
    const { result, state } = startAndGetState();
    const white = state.players.w;
    const actionResult = chessPlugin.onAction({
      from: white,
      action: { type: 'move', from: 'e2', to: 'e4' },
      state: result.state,
      participants: PLAYERS,
    });
    const broadcast = actionResult.broadcast as { type: string; san: string; fen: string; turn: string };
    expect(broadcast.type).toBe('chess_move');
    expect(broadcast.san).toBe('e4');
    expect(broadcast.turn).toBe('b');
  });

  it('rejects an illegal move and returns feedback', () => {
    const { result, state } = startAndGetState();
    const white = state.players.w;
    const actionResult = chessPlugin.onAction({
      from: white,
      action: { type: 'move', from: 'e2', to: 'e5' },  // illegal
      state: result.state,
      participants: PLAYERS,
    });
    const unchanged = actionResult.state as { fen: string };
    expect(unchanged.fen).toBe(state.fen);
    expect(actionResult.feedback).toBeDefined();
    expect(actionResult.feedback!.to).toBe(white);
    expect(actionResult.broadcast).toBeUndefined();
  });

  it('rejects a move when it is not the players turn', () => {
    const { result, state } = startAndGetState();
    const black = state.players.b;
    const actionResult = chessPlugin.onAction({
      from: black,
      action: { type: 'move', from: 'e7', to: 'e5' },
      state: result.state,
      participants: PLAYERS,
    });
    expect(actionResult.feedback).toBeDefined();
    expect(actionResult.feedback!.to).toBe(black);
  });

  it('detects checkmate and ends the game', () => {
    // Scholar's mate: 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#
    const { result, state } = startAndGetState();
    const w = state.players.w;
    const b = state.players.b;

    const moves: Array<{ from: string; action: { type: 'move'; from: string; to: string } }> = [
      { from: w, action: { type: 'move', from: 'e2', to: 'e4' } },
      { from: b, action: { type: 'move', from: 'e7', to: 'e5' } },
      { from: w, action: { type: 'move', from: 'd1', to: 'h5' } },
      { from: b, action: { type: 'move', from: 'b8', to: 'c6' } },
      { from: w, action: { type: 'move', from: 'f1', to: 'c4' } },
      { from: b, action: { type: 'move', from: 'g8', to: 'f6' } },
    ];

    let currentState = result.state;
    for (const m of moves) {
      const r = chessPlugin.onAction({ from: m.from, action: m.action, state: currentState, participants: PLAYERS });
      currentState = r.state;
    }

    // Checkmate move
    const mateResult = chessPlugin.onAction({
      from: w,
      action: { type: 'move', from: 'h5', to: 'f7' },
      state: currentState,
      participants: PLAYERS,
    });

    expect(mateResult.ended).toBe(true);
    const finalState = mateResult.state as { status: string; winner: string };
    expect(finalState.status).toBe('checkmate');
    expect(finalState.winner).toBe(w);
    const broadcast = mateResult.broadcast as { type: string; result: string };
    expect(broadcast.type).toBe('chess_game_over');
    expect(broadcast.result).toBe('checkmate');
  });
});

describe('chessPlugin.onAction — resign', () => {
  it('marks the other player as winner', () => {
    const { result, state } = startAndGetState();
    const black = state.players.b;
    const white = state.players.w;
    const actionResult = chessPlugin.onAction({
      from: black,
      action: { type: 'resign' },
      state: result.state,
      participants: PLAYERS,
    });
    expect(actionResult.ended).toBe(true);
    const finalState = actionResult.state as { status: string; winner: string };
    expect(finalState.status).toBe('resigned');
    expect(finalState.winner).toBe(white);
    const broadcast = actionResult.broadcast as { type: string; result: string; winner: string };
    expect(broadcast.type).toBe('chess_game_over');
    expect(broadcast.result).toBe('resigned');
    expect(broadcast.winner).toBe(white);
  });
});
