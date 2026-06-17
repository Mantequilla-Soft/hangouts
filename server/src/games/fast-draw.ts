import { findCollection } from '../lib/word-collection.js';
import type { GamePlugin, GameStartParams, GameStartResult, GameActionParams, GameActionResult } from '../lib/game-types.js';

export interface Stroke {
  id: string;
  points: [number, number][];
  color: string;
  width: number;
}

interface FastDrawState {
  phase: 'drawing' | 'guessing' | 'reveal' | 'game_over';
  drawerOrder: string[];
  currentDrawerIndex: number;
  currentWord: string;
  wordQueue: string[];
  roundStartedAt: number;
  roundDuration: number;
  guessDuration: number;
  guessPhaseStartedAt: number | null;
  revealEndsAt: number | null;
  scores: Record<string, number>;
  winThreshold: number;
  winners: string[];
  roundNumber: number;
  guesser: string | null;
  theme: string;
  strokeSnapshot: Stroke[];
}

interface FastDrawConfig {
  theme?: string;
  customWords?: string[];
  roundDuration?: number;
  guessDuration?: number;
  winThreshold?: number;
}

const REVEAL_DURATION_MS = 10_000;

const FALLBACK_WORDS = [
  'elephant', 'rhinoceros', 'crocodile', 'giraffe', 'penguin',
  'octopus', 'kangaroo', 'chameleon', 'wolverine', 'armadillo',
  'pizza', 'sushi', 'taco', 'ramen', 'avocado',
  'inception', 'titanic', 'avatar', 'gladiator', 'matrix',
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function buildSpectatorState(state: FastDrawState) {
  return {
    phase: state.phase,
    drawer: state.drawerOrder[state.currentDrawerIndex],
    wordLength: state.currentWord.length,
    revealedWord: (state.phase === 'reveal' || state.phase === 'game_over') ? state.currentWord : null,
    scores: state.scores,
    winners: state.winners,
    roundNumber: state.roundNumber,
    roundStartedAt: state.roundStartedAt,
    roundDuration: state.roundDuration,
    guessPhaseStartedAt: state.guessPhaseStartedAt,
    guessDuration: state.guessDuration,
    revealEndsAt: state.revealEndsAt,
    guesser: state.guesser,
    strokeSnapshot: state.strokeSnapshot,
  };
}

export const fastDrawPlugin: GamePlugin = {
  id: 'fast-draw',
  name: 'Fast Draw',
  description: 'Draw a word, guess a word. First to 5 points wins.',
  minPlayers: 3,
  maxPlayers: 12,

  async onStart(params: GameStartParams): Promise<GameStartResult> {
    const config = (params.config ?? {}) as FastDrawConfig;
    const theme = config.theme ?? 'animals';
    const roundDuration = config.roundDuration ?? 60;
    const guessDuration = config.guessDuration ?? roundDuration;
    const winThreshold = config.winThreshold ?? 5;

    let words: string[];
    if (config.customWords?.length) {
      words = shuffle(config.customWords);
    } else {
      const collection = await findCollection(theme);
      words = shuffle(collection?.words ?? FALLBACK_WORDS);
    }
    // Pre-load enough words for many rounds; slice so queue has 50 entries
    const wordQueue = [...words, ...shuffle(words), ...shuffle(words)].slice(0, 50);
    const currentWord = wordQueue.shift()!;

    const drawerOrder = shuffle(params.participants);
    const scores: Record<string, number> = {};
    for (const p of params.participants) scores[p] = 0;

    const state: FastDrawState = {
      phase: 'drawing',
      drawerOrder,
      currentDrawerIndex: 0,
      currentWord,
      wordQueue,
      roundStartedAt: Date.now(),
      roundDuration,
      guessDuration,
      guessPhaseStartedAt: null,
      revealEndsAt: null,
      scores,
      winThreshold,
      winners: [],
      roundNumber: 1,
      guesser: null,
      theme,
      strokeSnapshot: [],
    };

    const drawer = drawerOrder[0]!;
    const payloads: Record<string, unknown> = {};
    for (const p of params.participants) {
      payloads[p] = p === drawer
        ? { role: 'drawer', word: currentWord, roundDuration, guessDuration, roundStartedAt: state.roundStartedAt }
        : { role: 'guesser', wordLength: currentWord.length, roundDuration, guessDuration, roundStartedAt: state.roundStartedAt };
    }

    return {
      state,
      payloads,
      broadcast: {
        type: 'fast_draw_round_start',
        drawer,
        wordLength: currentWord.length,
        roundStartedAt: state.roundStartedAt,
        roundDuration,
        guessDuration,
        roundNumber: 1,
        scores,
      },
      spectatorState: buildSpectatorState(state),
    };
  },

  onAction(params: GameActionParams): GameActionResult {
    const state = params.state as FastDrawState;
    const action = params.action as { type: string; word?: string; strokes?: Stroke[] };
    const from = params.from;

    const currentDrawer = state.drawerOrder[state.currentDrawerIndex]!;

    if (action.type === 'canvas_sync') {
      if (from !== currentDrawer) {
        return { state, feedback: { to: from, message: 'Only the drawer can sync the canvas' } };
      }
      if (state.phase !== 'drawing') {
        return { state, feedback: { to: from, message: 'Drawing time is over' } };
      }
      const newState: FastDrawState = { ...state, strokeSnapshot: (action.strokes ?? []) };
      return { state: newState, spectatorState: buildSpectatorState(newState) };
    }

    if (action.type === 'guess') {
      if (from === currentDrawer) {
        return { state, feedback: { to: from, message: 'The drawer cannot guess' } };
      }
      if (state.phase !== 'drawing' && state.phase !== 'guessing') {
        return { state, feedback: { to: from, message: 'Round is not active' } };
      }
      const deadline = state.phase === 'drawing'
        ? state.roundStartedAt + state.roundDuration * 1000
        : state.guessPhaseStartedAt! + state.guessDuration * 1000;
      if (Date.now() >= deadline) {
        return { state, feedback: { to: from, message: 'Time has expired' } };
      }

      const guess = (action.word ?? '').trim().toLowerCase();
      const target = state.currentWord.trim().toLowerCase();

      if (guess !== target) {
        return { state, feedback: { to: from, message: 'Not quite!' } };
      }

      // Correct guess — go to reveal and wait for host to advance (or auto-advance fallback)
      const newScores = { ...state.scores, [from]: state.scores[from]! + 1, [currentDrawer]: state.scores[currentDrawer]! + 1 };
      const revealEndsAt = Date.now() + REVEAL_DURATION_MS;
      const newState: FastDrawState = { ...state, phase: 'reveal', guesser: from, scores: newScores, revealEndsAt };

      const winners = Object.entries(newScores)
        .filter(([, s]) => s >= state.winThreshold)
        .map(([p]) => p);

      if (winners.length > 0) {
        const gameOverState: FastDrawState = { ...newState, phase: 'game_over', winners };
        return {
          state: gameOverState,
          spectatorState: buildSpectatorState(gameOverState),
          broadcast: { type: 'fast_draw_game_over', winners, scores: newScores, word: state.currentWord },
          ended: true,
        };
      }

      return {
        state: newState,
        spectatorState: buildSpectatorState(newState),
        broadcast: { type: 'fast_draw_correct', guesser: from, word: state.currentWord, scores: newScores, revealEndsAt },
      };
    }

    if (action.type === 'advance_round') {
      if (state.phase === 'game_over') return { state };

      if (state.phase === 'drawing') {
        if (Date.now() < state.roundStartedAt + state.roundDuration * 1000) {
          return { state, feedback: { to: from, message: 'Round is still active' } };
        }
        // Drawing time expired — canvas freezes, but guessing keeps going for one more window
        const guessPhaseStartedAt = Date.now();
        const newState: FastDrawState = { ...state, phase: 'guessing', guessPhaseStartedAt };
        return {
          state: newState,
          spectatorState: buildSpectatorState(newState),
          broadcast: { type: 'fast_draw_drawing_ended', guessPhaseStartedAt, guessDuration: state.guessDuration, scores: state.scores },
        };
      }

      if (state.phase === 'guessing') {
        if (Date.now() < state.guessPhaseStartedAt! + state.guessDuration * 1000) {
          return { state, feedback: { to: from, message: 'Guessing window is still active' } };
        }
        // Guessing time also expired with no correct guess — reveal and wait for host (or auto-advance)
        const revealEndsAt = Date.now() + REVEAL_DURATION_MS;
        const newState: FastDrawState = { ...state, phase: 'reveal', revealEndsAt };
        return {
          state: newState,
          spectatorState: buildSpectatorState(newState),
          broadcast: { type: 'fast_draw_time_expired', word: state.currentWord, scores: state.scores, revealEndsAt },
        };
      }

      if (state.phase === 'reveal') {
        // No time guard — host controls when the next round starts
        // Advance to next round
        const nextIndex = (state.currentDrawerIndex + 1) % state.drawerOrder.length;
        const nextDrawer = state.drawerOrder[nextIndex]!;
        const wordQueue = [...state.wordQueue];
        const nextWord = wordQueue.shift() ?? shuffle(FALLBACK_WORDS)[0]!;
        const roundStartedAt = Date.now();
        const roundNumber = state.roundNumber + 1;

        const newState: FastDrawState = {
          ...state,
          phase: 'drawing',
          currentDrawerIndex: nextIndex,
          currentWord: nextWord,
          wordQueue,
          roundStartedAt,
          guessPhaseStartedAt: null,
          revealEndsAt: null,
          guesser: null,
          strokeSnapshot: [],
          roundNumber,
        };

        const payloads: Record<string, unknown> = {};
        for (const p of state.drawerOrder) {
          payloads[p] = p === nextDrawer
            ? { role: 'drawer', word: nextWord, roundDuration: state.roundDuration, guessDuration: state.guessDuration, roundStartedAt }
            : { role: 'guesser', wordLength: nextWord.length, roundDuration: state.roundDuration, guessDuration: state.guessDuration, roundStartedAt };
        }

        return {
          state: newState,
          payloads,
          spectatorState: buildSpectatorState(newState),
          broadcast: {
            type: 'fast_draw_round_start',
            drawer: nextDrawer,
            wordLength: nextWord.length,
            roundStartedAt,
            roundDuration: state.roundDuration,
            guessDuration: state.guessDuration,
            roundNumber,
            scores: state.scores,
          },
        };
      }

      return { state };
    }

    return { state };
  },
};
