import type { GamePlugin, GameStartParams, GameStartResult, GameActionParams, GameActionResult } from '../lib/game-types.js';
import { findCollection } from '../lib/word-collection.js';

// Fallback used only when MongoDB is unavailable
const FALLBACK_WORDS = ['elephant', 'rhinoceros', 'crocodile', 'giraffe', 'penguin', 'octopus', 'kangaroo', 'chameleon'];

interface WordGuessConfig {
  theme?: string;
  customWords?: string[];
}

interface WordGuessState {
  assignments: Record<string, string>;
  theme: string;
  startedAt: number;
  guessed: string[];
  guessedAt: Record<string, number>;
  wrongAttempts: Record<string, number>;
}

interface WordGuessLeaderboardEntry {
  identity: string;
  place: number;
  word: string;
  solveTimeMs: number;
  wrongAttempts: number;
}

/** Built fresh on every start/action so spectatorState (and therefore the
 *  GET hydrate response and the final game:ended result) is never stale —
 *  unlike the old `{theme, playerCount}` shape, which froze at onStart and
 *  never updated. `words` is the full reveal: every player already sees
 *  everyone else's word during play via their personalized payload, so
 *  there's nothing more secret being exposed here than already exists. */
function buildSpectatorState(state: WordGuessState, participants: string[]) {
  const leaderboard: WordGuessLeaderboardEntry[] = state.guessed.map((identity, i) => ({
    identity,
    place: i + 1,
    word: state.assignments[identity]!,
    solveTimeMs: state.guessedAt[identity]! - state.startedAt,
    wrongAttempts: state.wrongAttempts[identity] ?? 0,
  }));
  return {
    theme: state.theme,
    playerCount: participants.length,
    words: state.assignments,
    leaderboard,
  };
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

  async onStart(params: GameStartParams): Promise<GameStartResult> {
    const cfg = (params.config ?? {}) as WordGuessConfig;

    let wordPool: string[];
    let resolvedTheme: string;

    if (cfg.customWords?.length) {
      wordPool = cfg.customWords;
      resolvedTheme = 'custom';
    } else {
      const themeId = cfg.theme ?? 'animals';
      const collection = await findCollection(themeId);
      wordPool = collection?.words ?? FALLBACK_WORDS;
      resolvedTheme = collection ? themeId : 'animals';
    }

    const shuffledWords = shuffle(wordPool);
    const assignments: Record<string, string> = {};
    params.participants.forEach((identity, i) => {
      assignments[identity] = shuffledWords[i % shuffledWords.length]!;
    });

    const state: WordGuessState = {
      assignments,
      theme: resolvedTheme,
      startedAt: Date.now(),
      guessed: [],
      guessedAt: {},
      wrongAttempts: {},
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
      spectatorState: buildSpectatorState(state, params.participants),
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
      const newState: WordGuessState = {
        ...state,
        wrongAttempts: { ...state.wrongAttempts, [params.from]: (state.wrongAttempts[params.from] ?? 0) + 1 },
      };
      return {
        state: newState,
        broadcast: { type: 'guess_result', identity: params.from, correct: false },
        spectatorState: buildSpectatorState(newState, params.participants),
      };
    }

    if (state.guessed.includes(params.from)) {
      return { state, spectatorState: buildSpectatorState(state, params.participants) };
    }

    const newState: WordGuessState = {
      ...state,
      guessed: [...state.guessed, params.from],
      guessedAt: { ...state.guessedAt, [params.from]: Date.now() },
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
      spectatorState: buildSpectatorState(newState, params.participants),
      ended: allGuessed,
    };
  },
};
