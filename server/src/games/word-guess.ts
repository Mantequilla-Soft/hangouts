import type { GamePlugin, GameStartParams, GameStartResult, GameActionParams, GameActionResult } from '../lib/game-types.js';

const THEMES: Record<string, string[]> = {
  animals: ['elephant', 'rhinoceros', 'crocodile', 'giraffe', 'hippopotamus', 'cheetah', 'penguin', 'flamingo', 'octopus', 'platypus', 'kangaroo', 'orangutan'],
  food: ['pizza', 'sushi', 'taco', 'croissant', 'ramen', 'avocado', 'pineapple', 'lasagna', 'hummus', 'paella', 'dumpling', 'kimchi'],
  movies: ['inception', 'titanic', 'avatar', 'gladiator', 'interstellar', 'parasite', 'joker', 'oppenheimer', 'dune', 'matrix', 'jaws', 'shrek'],
};

interface WordGuessConfig {
  theme?: string;
  customWords?: string[];
}

interface WordGuessState {
  assignments: Record<string, string>;
  theme: string;
  startedAt: number;
  guessed: string[];
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const wordGuessPlugin: GamePlugin = {
  id: 'word-guess',
  name: 'Word Guess',
  description: "Each player is secretly assigned a word. Everyone can see everyone else's word but their own. Ask questions, then guess your word!",
  minPlayers: 2,
  maxPlayers: 12,

  onStart(params: GameStartParams): GameStartResult {
    const cfg = (params.config ?? {}) as WordGuessConfig;
    const theme = cfg.theme && THEMES[cfg.theme] ? cfg.theme : 'animals';
    const wordPool = cfg.customWords?.length ? cfg.customWords : THEMES[theme]!;

    const shuffledWords = shuffle(wordPool);
    const assignments: Record<string, string> = {};
    params.participants.forEach((identity, i) => {
      assignments[identity] = shuffledWords[i % shuffledWords.length]!;
    });

    const state: WordGuessState = {
      assignments,
      theme: cfg.customWords?.length ? 'custom' : theme,
      startedAt: Date.now(),
      guessed: [],
    };

    const payloads: Record<string, unknown> = {};
    for (const identity of params.participants) {
      payloads[identity] = {
        myWord: null,
        others: params.participants
          .filter((p) => p !== identity)
          .map((p) => ({ identity: p, word: assignments[p] })),
        theme: state.theme,
      };
    }

    return {
      state,
      payloads,
      broadcast: { theme: state.theme, playerCount: params.participants.length },
    };
  },

  onAction(params: GameActionParams): GameActionResult {
    const state = params.state as WordGuessState;
    const action = params.action as { type: string; word?: string };

    if (action.type !== 'guess' || !action.word) {
      return { state };
    }

    const correctWord = state.assignments[params.from];
    if (correctWord === undefined) return { state };

    const correct = action.word.trim().toLowerCase() === correctWord.toLowerCase();

    if (!correct) {
      return {
        state,
        broadcast: { type: 'guess_result', identity: params.from, correct: false },
      };
    }

    if (state.guessed.includes(params.from)) {
      return { state };
    }

    const newState: WordGuessState = {
      ...state,
      guessed: [...state.guessed, params.from],
    };
    const allGuessed = params.participants.every((p) => newState.guessed.includes(p));

    return {
      state: newState,
      broadcast: {
        type: 'guess_result',
        identity: params.from,
        correct: true,
        word: correctWord,
        allGuessed,
      },
      ended: allGuessed,
    };
  },
};
