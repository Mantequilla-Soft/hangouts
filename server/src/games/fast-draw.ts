import { findCollection } from '../lib/word-collection.js';
import type { GamePlugin, GameStartParams, GameStartResult, GameActionParams, GameActionResult } from '../lib/game-types.js';

export interface Stroke {
  id: string;
  points: [number, number][];
  color: string;
  width: number;
}

interface FastDrawState {
  phase: 'drawing' | 'reveal' | 'game_over';
  drawerOrder: string[];
  currentDrawerIndex: number;
  currentWord: string;
  wordQueue: string[];
  roundStartedAt: number;
  roundDuration: number;
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
  winThreshold?: number;
}

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
    revealedWord: state.phase !== 'drawing' ? state.currentWord : null,
    scores: state.scores,
    winners: state.winners,
    roundNumber: state.roundNumber,
    roundStartedAt: state.roundStartedAt,
    roundDuration: state.roundDuration,
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
        ? { role: 'drawer', word: currentWord, roundDuration, roundStartedAt: state.roundStartedAt }
        : { role: 'guesser', wordLength: currentWord.length, roundDuration, roundStartedAt: state.roundStartedAt };
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
      const newState: FastDrawState = { ...state, strokeSnapshot: (action.strokes ?? []) };
      return { state: newState, spectatorState: buildSpectatorState(newState) };
    }

    if (action.type === 'guess') {
      if (from === currentDrawer) {
        return { state, feedback: { to: from, message: 'The drawer cannot guess' } };
      }
      if (state.phase !== 'drawing') {
        return { state, feedback: { to: from, message: 'Round is not active' } };
      }
      if (Date.now() >= state.roundStartedAt + state.roundDuration * 1000) {
        return { state, feedback: { to: from, message: 'Time has expired' } };
      }

      const guess = (action.word ?? '').trim().toLowerCase();
      const target = state.currentWord.trim().toLowerCase();

      if (guess !== target) {
        return { state, feedback: { to: from, message: 'Not quite!' } };
      }

      // Correct guess
      const newScores = { ...state.scores, [from]: state.scores[from]! + 1, [currentDrawer]: state.scores[currentDrawer]! + 1 };
      const revealEndsAt = Date.now() + 4000;
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
        const revealEndsAt = Date.now() + 4000;
        const newState: FastDrawState = { ...state, phase: 'reveal', revealEndsAt };
        return {
          state: newState,
          spectatorState: buildSpectatorState(newState),
          broadcast: { type: 'fast_draw_time_expired', word: state.currentWord, scores: state.scores, revealEndsAt },
        };
      }

      if (state.phase === 'reveal') {
        if (state.revealEndsAt && Date.now() < state.revealEndsAt) {
          return { state };
        }
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
          revealEndsAt: null,
          guesser: null,
          strokeSnapshot: [],
          roundNumber,
        };

        const payloads: Record<string, unknown> = {};
        for (const p of state.drawerOrder) {
          payloads[p] = p === nextDrawer
            ? { role: 'drawer', word: nextWord, roundDuration: state.roundDuration, roundStartedAt }
            : { role: 'guesser', wordLength: nextWord.length, roundDuration: state.roundDuration, roundStartedAt };
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
