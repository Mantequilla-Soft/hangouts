import { useState, useEffect, useCallback, useRef } from 'react';
import { Chess } from 'chess.js';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import { useHangoutsContext } from '../context/HangoutsContext.js';

export interface UseChessOptions {
  roomName: string;
}

export type ChessGameStatus = 'playing' | 'checkmate' | 'draw' | 'stalemate' | 'resigned';

export interface UseChessResult {
  active: boolean;
  fen: string;
  myColor: 'w' | 'b' | null;
  players: { w: string; b: string } | null;
  turn: 'w' | 'b';
  status: ChessGameStatus;
  winner: string | null;
  moveHistory: string[];
  isMyTurn: boolean;
  isSpectator: boolean;
  isLoading: boolean;
  error: string | null;
  startGame: () => Promise<void>;
  makeMove: (from: string, to: string, promotion?: string) => boolean;
  resign: () => Promise<void>;
  endGame: () => Promise<void>;
}

interface ChessPayload {
  color: 'w' | 'b';
  players: { w: string; b: string };
}

interface ChessStartBroadcast {
  fen: string;
  players: { w: string; b: string };
}

interface ChessMoveBroadcast {
  type: 'chess_move';
  from: string;
  to: string;
  san: string;
  fen: string;
  turn: 'w' | 'b';
  check: boolean;
  moveHistory: string[];
}

interface ChessGameOverBroadcast {
  type: 'chess_game_over';
  result: ChessGameStatus;
  winner?: string;
  fen: string;
  moveHistory: string[];
}

interface ChessSpectatorState {
  fen: string;
  players: { w: string; b: string };
  turn: 'w' | 'b';
  status: ChessGameStatus;
  moveHistory: string[];
}

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function useChess({ roomName }: UseChessOptions): UseChessResult {
  const { apiClient: api } = useHangoutsContext();
  const { localParticipant } = useLocalParticipant();
  const identity = localParticipant?.identity ?? '';

  const [active, setActive] = useState(false);
  const [localFen, setLocalFen] = useState(STARTING_FEN);
  const [myColor, setMyColor] = useState<'w' | 'b' | null>(null);
  const [players, setPlayers] = useState<{ w: string; b: string } | null>(null);
  const [turn, setTurn] = useState<'w' | 'b'>('w');
  const [status, setStatus] = useState<ChessGameStatus>('playing');
  const [winner, setWinner] = useState<string | null>(null);
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [isSpectator, setIsSpectator] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a ref for makeMove to read without stale closure issues
  const localFenRef = useRef(localFen);
  useEffect(() => { localFenRef.current = localFen; }, [localFen]);

  const resetState = useCallback(() => {
    setActive(false);
    setLocalFen(STARTING_FEN);
    setMyColor(null);
    setPlayers(null);
    setTurn('w');
    setStatus('playing');
    setWinner(null);
    setMoveHistory([]);
    setIsSpectator(false);
  }, []);

  const hydrate = useCallback(async () => {
    if (!api) return;
    try {
      const game = await api.getActiveGame(roomName);
      if (!game || game.gameId !== 'chess') {
        resetState();
        return;
      }
      setActive(true);
      const spectator = game.isSpectator ?? false;
      setIsSpectator(spectator);
      if (spectator) {
        const s = game.state as ChessSpectatorState | null;
        if (s) {
          setLocalFen(s.fen);
          setPlayers(s.players);
          setTurn(s.turn);
          setStatus(s.status);
          setMoveHistory(s.moveHistory ?? []);
        }
      } else {
        const payload = game.state as ChessPayload | null;
        if (payload) {
          setMyColor(payload.color);
          setPlayers(payload.players);
        }
      }
    } catch {
      // Leave state as-is if server unreachable
    }
  }, [api, roomName, resetState]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const parsed = JSON.parse(text) as { type: string; [key: string]: unknown };

      if (parsed.type === 'game:started' && (parsed.gameId as string) === 'chess') {
        const broadcast = parsed.broadcast as ChessStartBroadcast | null;
        setActive(true);
        setStatus('playing');
        setWinner(null);
        setMoveHistory([]);
        if (broadcast) {
          setLocalFen(broadcast.fen);
          setPlayers(broadcast.players);
          setTurn('w');
        }
        void hydrate();
        return;
      }

      if (parsed.type === 'game:state') {
        const payload = parsed.payload as ChessPayload | null;
        if (payload?.color) {
          setMyColor(payload.color);
          setPlayers(payload.players);
          setIsSpectator(false);
        }
        return;
      }

      if (parsed.type === 'game:broadcast') {
        const p = parsed.payload as ChessMoveBroadcast | ChessGameOverBroadcast;
        if (p?.type === 'chess_move') {
          setLocalFen(p.fen);
          setTurn(p.turn);
          setMoveHistory(p.moveHistory ?? []);
          localFenRef.current = p.fen;
        } else if (p?.type === 'chess_game_over') {
          setLocalFen(p.fen ?? localFenRef.current);
          setMoveHistory(p.moveHistory ?? []);
          setStatus(p.result);
          setWinner(p.winner ?? null);
        }
        return;
      }

      if (parsed.type === 'game:feedback') {
        setError(parsed.message as string);
        // Reset localFen to server-confirmed position on any rejection
        setLocalFen(localFenRef.current);
        return;
      }

      if (parsed.type === 'game:ended') {
        resetState();
        return;
      }
    } catch { /* ignore malformed */ }
  }, [hydrate, resetState]);

  useDataChannel('game', onMessage);

  // Synchronous — used directly in react-chessboard's onPieceDrop
  const makeMove = useCallback((from: string, to: string, promotion = 'q'): boolean => {
    if (!api || isSpectator) return false;
    const chess = new Chess(localFenRef.current);
    let move: ReturnType<Chess['move']>;
    try {
      move = chess.move({ from, to, promotion });
    } catch {
      return false;
    }
    if (!move) return false;

    const newFen = chess.fen();
    setLocalFen(newFen);
    localFenRef.current = newFen;
    setError(null);
    void api.sendGameAction(roomName, { type: 'move', from, to, promotion })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Move failed');
      });
    return true;
  }, [api, roomName, isSpectator]);

  const startGame = useCallback(async () => {
    if (!api) return;
    setIsLoading(true);
    setError(null);
    try {
      await api.startGame(roomName, 'chess');
      await hydrate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start game');
    } finally {
      setIsLoading(false);
    }
  }, [api, roomName, hydrate]);

  const resign = useCallback(async () => {
    if (!api) return;
    setIsLoading(true);
    setError(null);
    try {
      await api.sendGameAction(roomName, { type: 'resign' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resign');
    } finally {
      setIsLoading(false);
    }
  }, [api, roomName]);

  const endGame = useCallback(async () => {
    if (!api) return;
    setIsLoading(true);
    setError(null);
    try {
      await api.endGame(roomName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end game');
    } finally {
      setIsLoading(false);
    }
  }, [api, roomName]);

  const chess = new Chess(localFen);
  const liveTurn = chess.turn();

  const isMyTurn = !isSpectator && myColor !== null && liveTurn === myColor && status === 'playing';

  return {
    active,
    fen: localFen,
    myColor,
    players,
    turn: liveTurn,
    status,
    winner,
    moveHistory,
    isMyTurn,
    isSpectator,
    isLoading,
    error,
    startGame,
    makeMove,
    resign,
    endGame,
  };
}
