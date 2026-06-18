import { useState, useEffect, useCallback, useRef } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import type { WordGuessGameResult } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

export interface UseWordGuessOptions {
  roomName: string;
}

export interface WordGuessEvent {
  identity: string;
  correct: boolean;
  word?: string;
  timestamp: number;
}

export interface UseWordGuessResult {
  active: boolean;
  gameId: string | null;
  participants: string[];
  myWord: string | null;
  others: Array<{ identity: string; word: string }>;
  guessed: Set<string>;
  hasGuessed: boolean;
  theme: string | null;
  events: WordGuessEvent[];
  /** Leaderboard + full word reveal for the round that just ended. Persists
   *  until the next round starts; null if no round has ended yet. */
  recap: WordGuessGameResult | null;
  isLoading: boolean;
  error: string | null;
  startGame: (config?: { theme?: string }) => Promise<void>;
  guess: (word: string) => Promise<void>;
  endGame: () => Promise<void>;
}

interface WordGuessPayload {
  myWord: string | null;
  others: Array<{ identity: string; word: string }>;
  theme: string;
}

interface GuessResultBroadcast {
  type: 'guess_result';
  identity: string;
  correct: boolean;
  word?: string;
  allGuessed?: boolean;
}

export function useWordGuess({ roomName }: UseWordGuessOptions): UseWordGuessResult {
  const { apiClient: api } = useHangoutsContext();
  const { localParticipant } = useLocalParticipant();
  const identity = localParticipant?.identity ?? '';

  const [active, setActive] = useState(false);
  const [gameId, setGameId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [myWord, setMyWord] = useState<string | null>(null);
  const [others, setOthers] = useState<Array<{ identity: string; word: string }>>([]);
  const [guessed, setGuessed] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<string | null>(null);
  const [events, setEvents] = useState<WordGuessEvent[]>([]);
  const [recap, setRecap] = useState<WordGuessGameResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback(async () => {
    if (!api) return;
    try {
      const game = await api.getActiveGame(roomName);
      if (!game) {
        setActive(false);
        setGameId(null);
        setParticipants([]);
        setMyWord(null);
        setOthers([]);
        setGuessed(new Set());
        setTheme(null);
        setEvents([]);
        return;
      }
      setActive(true);
      setGameId(game.gameId);
      setParticipants(game.participants);
      const payload = game.state as WordGuessPayload | null;
      if (payload) {
        setMyWord(payload.myWord);
        setOthers(payload.others ?? []);
        setTheme(payload.theme ?? null);
      }
    } catch {
      // If we can't reach the server, leave state as-is
    }
  }, [api, roomName]);

  // Hydrate on mount (handles late joiners + page refreshes)
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const parsed = JSON.parse(text) as { type: string; [key: string]: unknown };

      if (parsed.type === 'game:started') {
        // Re-fetch personalized state — data-channel game:state arrives
        // immediately after, but hydrate() is the reliable path for the
        // starting host whose hook may not yet be subscribed.
        setActive(true);
        setGameId(parsed.gameId as string ?? null);
        setParticipants((parsed.participants as string[]) ?? []);
        setGuessed(new Set());
        setEvents([]);
        setRecap(null);
        void hydrate();
        return;
      }

      if (parsed.type === 'game:state') {
        const payload = parsed.payload as WordGuessPayload | null;
        if (payload) {
          setMyWord(payload.myWord);
          setOthers(payload.others ?? []);
          setTheme(payload.theme ?? null);
        }
        return;
      }

      if (parsed.type === 'game:broadcast') {
        const p = parsed.payload as GuessResultBroadcast;
        if (p?.type === 'guess_result') {
          const event: WordGuessEvent = {
            identity: p.identity,
            correct: p.correct,
            word: p.word,
            timestamp: Date.now(),
          };
          setEvents((prev) => [...prev, event]);
          if (p.correct) {
            setGuessed((prev) => new Set([...prev, p.identity]));
          }
        }
        return;
      }

      if (parsed.type === 'game:ended') {
        setActive(false);
        setGameId(null);
        setParticipants([]);
        setMyWord(null);
        setOthers([]);
        setGuessed(new Set());
        setTheme(null);
        setRecap((parsed.result as WordGuessGameResult | null) ?? null);
        return;
      }
    } catch { /* ignore malformed */ }
  }, [hydrate]);

  useDataChannel('game', onMessage);

  const startGame = useCallback(async (config?: { theme?: string }) => {
    if (!api) return;
    setIsLoading(true);
    setError(null);
    try {
      await api.startGame(roomName, 'word-guess', config);
      await hydrate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start game');
    } finally {
      setIsLoading(false);
    }
  }, [api, roomName, hydrate]);

  const guess = useCallback(async (word: string) => {
    if (!api || !word.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      await api.sendGameAction(roomName, { type: 'guess', word: word.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit guess');
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

  const hasGuessed = guessed.has(identity);

  return {
    active,
    gameId,
    participants,
    myWord,
    others,
    guessed,
    hasGuessed,
    theme,
    events,
    recap,
    isLoading,
    error,
    startGame,
    guess,
    endGame,
  };
}
