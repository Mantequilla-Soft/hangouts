import { Chess } from 'chess.js';
import type { GamePlugin, GameStartParams, GameStartResult, GameActionParams, GameActionResult } from '../lib/game-types.js';

interface ChessState {
  fen: string;
  players: { w: string; b: string };
  status: 'playing' | 'checkmate' | 'draw' | 'stalemate' | 'resigned' | 'timeout';
  winner?: string;
  moveHistory: string[];
  timeControl: number | null;   // ms per side, null = untimed
  whiteClock: number | null;    // ms remaining for white
  blackClock: number | null;    // ms remaining for black
  lastMoveAt: number | null;    // timestamp of last confirmed move
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

interface ChessClaimTimeoutAction {
  type: 'claim_timeout';
}

type ChessAction = ChessMoveAction | ChessResignAction | ChessClaimTimeoutAction;

interface ChessConfig {
  timeControl?: number; // seconds per side
}

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
    const config = (params.config ?? {}) as ChessConfig;
    const tcMs = config.timeControl ? config.timeControl * 1000 : null;

    const shuffled = [...params.participants].sort(() => Math.random() - 0.5);
    const players = { w: shuffled[0]!, b: shuffled[1]! };
    const chess = new Chess();
    const fen = chess.fen();

    const state: ChessState = {
      fen,
      players,
      status: 'playing',
      moveHistory: [],
      timeControl: tcMs,
      whiteClock: tcMs,
      blackClock: tcMs,
      lastMoveAt: tcMs ? Date.now() : null,
    };

    const spectatorState = { fen, players, turn: 'w' as const, status: 'playing', moveHistory: [], timeControl: tcMs, whiteClock: tcMs, blackClock: tcMs };

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
        broadcast: { type: 'chess_game_over', result: 'resigned', winner, whiteClock: state.whiteClock, blackClock: state.blackClock },
        spectatorState: { fen: state.fen, players: state.players, turn: state.fen.split(' ')[1] as 'w' | 'b', status: 'resigned', winner, moveHistory: state.moveHistory, timeControl: state.timeControl, whiteClock: state.whiteClock, blackClock: state.blackClock },
        ended: true,
      };
    }

    if (action.type === 'claim_timeout') {
      if (state.timeControl === null) return { state };
      const currentTurn = new Chess(state.fen).turn();
      const activePlayer = state.players[currentTurn];
      if (params.from === activePlayer) {
        return { state, feedback: { to: params.from, message: 'Cannot claim timeout against yourself' } };
      }
      const elapsed = state.lastMoveAt ? Date.now() - state.lastMoveAt : 0;
      const activeClock = currentTurn === 'w' ? (state.whiteClock ?? 0) : (state.blackClock ?? 0);
      if (activeClock - elapsed > 0) {
        return { state, feedback: { to: params.from, message: 'Opponent still has time' } };
      }
      const winner = params.from;
      const newState: ChessState = { ...state, status: 'timeout', winner };
      return {
        state: newState,
        broadcast: { type: 'chess_game_over', result: 'timeout', winner, whiteClock: state.whiteClock, blackClock: state.blackClock },
        spectatorState: { fen: state.fen, players: state.players, turn: null, status: 'timeout', winner, moveHistory: state.moveHistory, timeControl: state.timeControl, whiteClock: state.whiteClock, blackClock: state.blackClock },
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

    // Clock deduction — only for timed games, after confirming move is legal
    let whiteClock = state.whiteClock;
    let blackClock = state.blackClock;
    let lastMoveAt = state.lastMoveAt;
    if (state.timeControl !== null && lastMoveAt !== null) {
      const elapsed = Date.now() - lastMoveAt;
      if (playerColor === 'w') whiteClock = Math.max(0, (whiteClock ?? 0) - elapsed);
      else                      blackClock = Math.max(0, (blackClock ?? 0) - elapsed);
      lastMoveAt = Date.now();

      if ((whiteClock ?? 0) <= 0 || (blackClock ?? 0) <= 0) {
        const timeoutWinner = playerColor === 'w' ? state.players.b : state.players.w;
        const newHistory = [...state.moveHistory, move.san];
        const newFen = chess.fen();
        const timeoutState: ChessState = { ...state, fen: newFen, status: 'timeout', winner: timeoutWinner, moveHistory: newHistory, whiteClock, blackClock, lastMoveAt };
        return {
          state: timeoutState,
          broadcast: { type: 'chess_game_over', result: 'timeout', winner: timeoutWinner, fen: newFen, moveHistory: newHistory, whiteClock, blackClock },
          spectatorState: { fen: newFen, players: state.players, turn: null, status: 'timeout', winner: timeoutWinner, moveHistory: newHistory, timeControl: state.timeControl, whiteClock, blackClock },
          ended: true,
        };
      }
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
    const newState: ChessState = { ...state, fen: newFen, status, winner, moveHistory: newHistory, whiteClock, blackClock, lastMoveAt };

    const broadcastPayload = ended
      ? { type: 'chess_game_over', result: status, winner, fen: newFen, moveHistory: newHistory, whiteClock, blackClock }
      : { type: 'chess_move', from: action.from, to: action.to, san: move.san, fen: newFen, turn: chess.turn(), check: chess.inCheck(), moveHistory: newHistory, whiteClock, blackClock };

    const spectatorState = { fen: newFen, players: state.players, turn: ended ? null : chess.turn(), status, winner: winner ?? null, moveHistory: newHistory, timeControl: state.timeControl, whiteClock, blackClock };
    return { state: newState, broadcast: broadcastPayload, spectatorState, ended };
  },
};
