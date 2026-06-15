import { useState, useEffect, useCallback, useRef } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import { useHangoutsContext } from '../context/HangoutsContext.js';

export interface Stroke {
  id: string;
  points: [number, number][];
  color: string;
  width: number;
}

export type FastDrawPhase = 'drawing' | 'reveal' | 'game_over';

export interface FastDrawConfig {
  theme?: string;
  customWords?: string[];
  roundDuration?: number;
  winThreshold?: number;
}

export interface UseFastDrawOptions {
  roomName: string;
}

export interface UseFastDrawResult {
  active: boolean;
  phase: FastDrawPhase;
  isDrawer: boolean;
  currentDrawer: string;
  word: string | null;
  wordLength: number;
  scores: Record<string, number>;
  myScore: number;
  winners: string[];
  roundNumber: number;
  roundStartedAt: number;
  roundDuration: number;
  revealEndsAt: number | null;
  guesser: string | null;
  revealedWord: string | null;
  strokeSnapshot: Stroke[];
  isSpectator: boolean;
  error: string | null;
  isLoading: boolean;
  startGame: (config?: FastDrawConfig) => Promise<void>;
  submitGuess: (word: string) => Promise<void>;
  syncCanvas: (strokes: Stroke[]) => void;
  endGame: () => Promise<void>;
}

interface RoundStartBroadcast {
  type: 'fast_draw_round_start';
  drawer: string;
  wordLength: number;
  roundStartedAt: number;
  roundDuration: number;
  roundNumber: number;
  scores: Record<string, number>;
}

interface CorrectBroadcast {
  type: 'fast_draw_correct';
  guesser: string;
  word: string;
  scores: Record<string, number>;
  revealEndsAt: number;
}

interface TimeExpiredBroadcast {
  type: 'fast_draw_time_expired';
  word: string;
  scores: Record<string, number>;
  revealEndsAt: number;
}

interface GameOverBroadcast {
  type: 'fast_draw_game_over';
  winners: string[];
  scores: Record<string, number>;
  word: string;
}

type FastDrawBroadcast = RoundStartBroadcast | CorrectBroadcast | TimeExpiredBroadcast | GameOverBroadcast;

interface PlayerPayload {
  role: 'drawer' | 'guesser';
  word?: string;
  wordLength?: number;
  roundDuration: number;
  roundStartedAt: number;
}

interface SpectatorState {
  phase: FastDrawPhase;
  drawer: string;
  wordLength: number;
  revealedWord: string | null;
  scores: Record<string, number>;
  winners: string[];
  roundNumber: number;
  roundStartedAt: number;
  roundDuration: number;
  revealEndsAt: number | null;
  guesser: string | null;
  strokeSnapshot: Stroke[];
}

export function useFastDraw({ roomName }: UseFastDrawOptions): UseFastDrawResult {
  const { apiClient: api } = useHangoutsContext();
  const { localParticipant } = useLocalParticipant();
  const identity = localParticipant?.identity ?? '';

  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<FastDrawPhase>('drawing');
  const [currentDrawer, setCurrentDrawer] = useState('');
  const [word, setWord] = useState<string | null>(null);
  const [wordLength, setWordLength] = useState(0);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [winners, setWinners] = useState<string[]>([]);
  const [roundNumber, setRoundNumber] = useState(1);
  const [roundStartedAt, setRoundStartedAt] = useState(0);
  const [roundDuration, setRoundDuration] = useState(60);
  const [revealEndsAt, setRevealEndsAt] = useState<number | null>(null);
  const [guesser, setGuesser] = useState<string | null>(null);
  const [revealedWord, setRevealedWord] = useState<string | null>(null);
  const [strokeSnapshot, setStrokeSnapshot] = useState<Stroke[]>([]);
  const [isSpectator, setIsSpectator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetState = useCallback(() => {
    setActive(false);
    setPhase('drawing');
    setCurrentDrawer('');
    setWord(null);
    setWordLength(0);
    setScores({});
    setWinners([]);
    setRoundNumber(1);
    setRoundStartedAt(0);
    setRoundDuration(60);
    setRevealEndsAt(null);
    setGuesser(null);
    setRevealedWord(null);
    setStrokeSnapshot([]);
    setIsSpectator(false);
  }, []);

  const hydrate = useCallback(async () => {
    if (!api) return;
    try {
      const game = await api.getActiveGame(roomName);
      if (!game || game.gameId !== 'fast-draw') { resetState(); return; }
      setActive(true);
      const spectator = game.isSpectator ?? false;
      setIsSpectator(spectator);
      if (spectator) {
        const s = game.state as SpectatorState | null;
        if (s) {
          setPhase(s.phase);
          setCurrentDrawer(s.drawer);
          setWordLength(s.wordLength);
          setRevealedWord(s.revealedWord);
          setScores(s.scores);
          setWinners(s.winners ?? []);
          setRoundNumber(s.roundNumber);
          setRoundStartedAt(s.roundStartedAt);
          setRoundDuration(s.roundDuration);
          setRevealEndsAt(s.revealEndsAt);
          setGuesser(s.guesser);
          setStrokeSnapshot(s.strokeSnapshot ?? []);
        }
      } else {
        const board = game.boardState as SpectatorState | null;
        const payload = game.state as PlayerPayload | null;
        if (board) {
          setPhase(board.phase);
          setCurrentDrawer(board.drawer);
          setWordLength(board.wordLength);
          setRevealedWord(board.revealedWord);
          setScores(board.scores);
          setWinners(board.winners ?? []);
          setRoundNumber(board.roundNumber);
          setRoundStartedAt(board.roundStartedAt);
          setRoundDuration(board.roundDuration);
          setRevealEndsAt(board.revealEndsAt);
          setGuesser(board.guesser);
          setStrokeSnapshot(board.strokeSnapshot ?? []);
        }
        if (payload) {
          if (payload.role === 'drawer' && payload.word) setWord(payload.word);
          if (payload.role === 'guesser' && payload.wordLength) setWordLength(payload.wordLength);
          if (!board) {
            setRoundStartedAt(payload.roundStartedAt);
            setRoundDuration(payload.roundDuration);
          }
        }
      }
    } catch { /* leave state as-is if unreachable */ }
  }, [api, roomName, resetState]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  // Auto-advance timer: fires advance_round when drawing or reveal timer expires
  useEffect(() => {
    if (!active || phase === 'game_over' || !api) return;
    const target = phase === 'drawing'
      ? roundStartedAt + roundDuration * 1000
      : (revealEndsAt ?? 0);
    const ms = target - Date.now();
    const send = () => void api.sendGameAction(roomName, { type: 'advance_round' }).catch(() => {});
    if (ms <= 0) { send(); return; }
    const t = setTimeout(send, ms);
    return () => clearTimeout(t);
  }, [active, phase, roundStartedAt, roundDuration, revealEndsAt, api, roomName]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as { type: string; [k: string]: unknown };

      if (parsed.type === 'game:started' && parsed.gameId === 'fast-draw') {
        setActive(true);
        void hydrate();
        return;
      }

      if (parsed.type === 'game:state') {
        const payload = parsed.payload as PlayerPayload | null;
        if (!payload) return;
        if (payload.role === 'drawer' && payload.word) {
          setWord(payload.word);
          setCurrentDrawer(identity);
          setIsSpectator(false);
        }
        if (payload.role === 'guesser') {
          setWord(null);
          setWordLength(payload.wordLength ?? 0);
          setIsSpectator(false);
        }
        setRoundStartedAt(payload.roundStartedAt);
        setRoundDuration(payload.roundDuration);
        return;
      }

      if (parsed.type === 'game:broadcast') {
        const p = parsed.payload as FastDrawBroadcast;
        if (!p?.type) return;

        if (p.type === 'fast_draw_round_start') {
          setPhase('drawing');
          setCurrentDrawer(p.drawer);
          setWordLength(p.wordLength);
          setRevealedWord(null);
          setScores(p.scores);
          setRoundNumber(p.roundNumber);
          setRoundStartedAt(p.roundStartedAt);
          setRoundDuration(p.roundDuration);
          setRevealEndsAt(null);
          setGuesser(null);
          setStrokeSnapshot([]);
          if (p.drawer !== identity) setWord(null);
          return;
        }

        if (p.type === 'fast_draw_correct') {
          setPhase('reveal');
          setGuesser(p.guesser);
          setRevealedWord(p.word);
          setScores(p.scores);
          setRevealEndsAt(p.revealEndsAt);
          return;
        }

        if (p.type === 'fast_draw_time_expired') {
          setPhase('reveal');
          setRevealedWord(p.word);
          setScores(p.scores);
          setRevealEndsAt(p.revealEndsAt);
          setGuesser(null);
          return;
        }

        if (p.type === 'fast_draw_game_over') {
          setPhase('game_over');
          setWinners(p.winners);
          setScores(p.scores);
          setRevealedWord(p.word);
          return;
        }
        return;
      }

      if (parsed.type === 'game:feedback') {
        setError(parsed.message as string);
        return;
      }

      if (parsed.type === 'game:ended') {
        resetState();
        return;
      }
    } catch { /* ignore malformed */ }
  }, [hydrate, identity, resetState]);

  useDataChannel('game', onMessage);

  const startGame = useCallback(async (config?: FastDrawConfig) => {
    if (!api) return;
    setIsLoading(true); setError(null);
    try { await api.startGame(roomName, 'fast-draw', config); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to start game'); }
    finally { setIsLoading(false); }
  }, [api, roomName]);

  const submitGuess = useCallback(async (guessWord: string) => {
    if (!api) return;
    setError(null);
    try { await api.sendGameAction(roomName, { type: 'guess', word: guessWord }); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to submit guess'); }
  }, [api, roomName]);

  const syncCanvas = useCallback((strokes: Stroke[]) => {
    if (!api) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      void api.sendGameAction(roomName, { type: 'canvas_sync', strokes }).catch(() => {});
    }, 500);
  }, [api, roomName]);

  const endGame = useCallback(async () => {
    if (!api) return;
    setIsLoading(true); setError(null);
    try { await api.endGame(roomName); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to end game'); }
    finally { setIsLoading(false); }
  }, [api, roomName]);

  const isDrawer = active && currentDrawer === identity && !isSpectator;
  const myScore = scores[identity] ?? 0;

  return {
    active, phase, isDrawer, currentDrawer, word, wordLength,
    scores, myScore, winners, roundNumber, roundStartedAt, roundDuration,
    revealEndsAt, guesser, revealedWord, strokeSnapshot, isSpectator,
    error, isLoading, startGame, submitGuess, syncCanvas, endGame,
  };
}
