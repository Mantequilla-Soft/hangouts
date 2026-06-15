import { Chess } from 'chess.js';
import type { GamePlugin, GameStartParams, GameStartResult, GameActionParams, GameActionResult } from '../lib/game-types.js';

interface ChessState {
  fen: string;
  players: { w: string; b: string };
  status: 'playing' | 'checkmate' | 'draw' | 'stalemate' | 'resigned';
  winner?: string;
  moveHistory: string[];
}

interface ChessMoveAction {
  type: 'move';
  from: string;
  to: string;
  promotion?: string;
}

interface ChessResignAction {
  type: 'resign';
}

type ChessAction = ChessMoveAction | ChessResignAction;

function colorOf(identity: string, players: { w: string; b: string }): 'w' | 'b' | null {
  if (players.w === identity) return 'w';
  if (players.b === identity) return 'b';
  return null;
}

export const chessPlugin: GamePlugin = {
  id: 'chess',
  name: 'Chess',
  description: 'Classic 2-player chess. Colors are assigned randomly at game start.',
  minPlayers: 2,
  maxPlayers: 2,

  onStart(params: GameStartParams): GameStartResult {
    const shuffled = [...params.participants].sort(() => Math.random() - 0.5);
    const players = { w: shuffled[0]!, b: shuffled[1]! };
    const chess = new Chess();
    const fen = chess.fen();

    const state: ChessState = {
      fen,
      players,
      status: 'playing',
      moveHistory: [],
    };

    const spectatorState = { fen, players, turn: 'w' as const, status: 'playing', moveHistory: [] };

    return {
      state,
      payloads: {
        [players.w]: { color: 'w', players },
        [players.b]: { color: 'b', players },
      },
      broadcast: { fen, players },
      spectatorState,
    };
  },

  onAction(params: GameActionParams): GameActionResult {
    const state = params.state as ChessState;
    const action = params.action as ChessAction;

    if (state.status !== 'playing') {
      return { state };
    }

    if (action.type === 'resign') {
      const color = colorOf(params.from, state.players);
      if (!color) return { state };
      const winner = color === 'w' ? state.players.b : state.players.w;
      const newState: ChessState = { ...state, status: 'resigned', winner };
      return {
        state: newState,
        broadcast: { type: 'chess_game_over', result: 'resigned', winner },
        ended: true,
      };
    }

    if (action.type !== 'move') {
      return { state };
    }

    const playerColor = colorOf(params.from, state.players);
    if (!playerColor) {
      return { state, feedback: { to: params.from, message: 'You are not a player in this game' } };
    }

    const chess = new Chess(state.fen);
    if (chess.turn() !== playerColor) {
      return { state, feedback: { to: params.from, message: 'Not your turn' } };
    }

    let move: ReturnType<Chess['move']>;
    try {
      move = chess.move({ from: action.from, to: action.to, promotion: action.promotion ?? 'q' });
    } catch {
      return { state, feedback: { to: params.from, message: 'Illegal move' } };
    }

    let status: ChessState['status'] = 'playing';
    let winner: string | undefined;
    let ended = false;

    if (chess.isCheckmate()) {
      status = 'checkmate';
      winner = params.from;
      ended = true;
    } else if (chess.isDraw()) {
      status = chess.isStalemate() ? 'stalemate' : 'draw';
      ended = true;
    }

    const newFen = chess.fen();
    const newHistory = [...state.moveHistory, move.san];
    const newState: ChessState = { ...state, fen: newFen, status, winner, moveHistory: newHistory };

    const broadcastPayload = ended
      ? { type: 'chess_game_over', result: status, winner, fen: newFen, moveHistory: newHistory }
      : { type: 'chess_move', from: action.from, to: action.to, san: move.san, fen: newFen, turn: chess.turn(), check: chess.inCheck(), moveHistory: newHistory };

    return { state: newState, broadcast: broadcastPayload, ended };
  },
};
