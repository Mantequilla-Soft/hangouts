import { describe, it, expect, vi, beforeAll } from 'vitest';
import { wordGuessPlugin } from '../../src/games/word-guess.js';

// Mock the MongoDB word-collection module so tests run without a database
vi.mock('../../src/lib/word-collection.js', () => ({
  findCollection: vi.fn((id: string) => {
    const collections: Record<string, { id: string; name: string; words: string[] }> = {
      animals: { id: 'animals', name: 'Animals', words: ['elephant', 'rhinoceros', 'crocodile', 'giraffe', 'penguin', 'octopus', 'kangaroo', 'chameleon', 'wolverine', 'armadillo', 'orangutan', 'platypus'] },
      food:    { id: 'food',    name: 'Food',    words: ['pizza', 'sushi', 'taco', 'croissant', 'ramen', 'avocado', 'pineapple', 'lasagna', 'hummus', 'paella', 'dumpling', 'kimchi'] },
      movies:  { id: 'movies',  name: 'Movies',  words: ['inception', 'titanic', 'avatar', 'gladiator', 'interstellar', 'parasite', 'joker', 'oppenheimer', 'dune', 'matrix', 'jaws', 'shrek'] },
    };
    return Promise.resolve(collections[id] ?? null);
  }),
}));

const PARTICIPANTS = ['alice', 'bob', 'carol', 'dave'];

describe('wordGuessPlugin metadata', () => {
  it('has the correct id', () => {
    expect(wordGuessPlugin.id).toBe('word-guess');
  });

  it('supports 2–12 players', () => {
    expect(wordGuessPlugin.minPlayers).toBe(2);
    expect(wordGuessPlugin.maxPlayers).toBe(12);
  });
});

describe('wordGuessPlugin.onStart', () => {
  it('assigns a unique word to each participant', async () => {
    const { state } = await wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    const assignments = (state as { assignments: Record<string, string> }).assignments;
    const words = Object.values(assignments);
    expect(new Set(words).size).toBe(words.length);
    expect(Object.keys(assignments)).toEqual(expect.arrayContaining(PARTICIPANTS));
  });

  it("each player sees others' words but myWord is null", async () => {
    const { payloads } = await wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    for (const identity of PARTICIPANTS) {
      const view = payloads[identity] as { myWord: null; others: { identity: string; word: string }[] };
      expect(view.myWord).toBeNull();
      expect(view.others).toHaveLength(PARTICIPANTS.length - 1);
      expect(view.others.map((o) => o.identity)).not.toContain(identity);
    }
  });

  it("each player sees the correct word for every other player", async () => {
    const { state, payloads } = await wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    const assignments = (state as { assignments: Record<string, string> }).assignments;
    for (const identity of PARTICIPANTS) {
      const view = payloads[identity] as { others: { identity: string; word: string }[] };
      for (const other of view.others) {
        expect(other.word).toBe(assignments[other.identity]);
      }
    }
  });

  it('defaults to animals theme', async () => {
    const { state } = await wordGuessPlugin.onStart({ participants: ['alice', 'bob'] });
    expect((state as { theme: string }).theme).toBe('animals');
  });

  it('accepts an explicit theme', async () => {
    const { state } = await wordGuessPlugin.onStart({ participants: ['alice', 'bob'], config: { theme: 'food' } });
    expect((state as { theme: string }).theme).toBe('food');
  });

  it('falls back to animals for an unknown theme', async () => {
    const { state } = await wordGuessPlugin.onStart({ participants: ['alice', 'bob'], config: { theme: 'made-up' } });
    expect((state as { theme: string }).theme).toBe('animals');
  });

  it('accepts custom words and marks theme as custom', async () => {
    const customWords = ['sword', 'shield', 'bow', 'axe', 'staff', 'dagger'];
    const { state } = await wordGuessPlugin.onStart({ participants: ['alice', 'bob'], config: { customWords } });
    const s = state as { theme: string; assignments: Record<string, string> };
    expect(s.theme).toBe('custom');
    for (const word of Object.values(s.assignments)) {
      expect(customWords).toContain(word);
    }
  });

  it('includes a broadcast with theme and playerCount', async () => {
    const { broadcast } = await wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    expect(broadcast).toMatchObject({ theme: 'animals', playerCount: 4 });
  });

  it('works with the minimum of 2 players', async () => {
    const { payloads } = await wordGuessPlugin.onStart({ participants: ['alice', 'bob'] });
    expect(Object.keys(payloads)).toHaveLength(2);
  });

  it('initialises the guessed list as empty', async () => {
    const { state } = await wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    expect((state as { guessed: string[] }).guessed).toEqual([]);
  });
});

describe('wordGuessPlugin.onAction — guess', () => {
  async function startAndGetState(participants = PARTICIPANTS) {
    const { state } = await wordGuessPlugin.onStart({ participants });
    return state as { assignments: Record<string, string>; guessed: string[]; theme: string; startedAt: number };
  }

  it('broadcasts correct:true when the guess matches the assigned word', async () => {
    const state = await startAndGetState();
    const aliceWord = state.assignments['alice']!;
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.broadcast as { correct: boolean; identity: string }).correct).toBe(true);
    expect((result.broadcast as { identity: string }).identity).toBe('alice');
  });

  it('broadcasts correct:false when the guess is wrong', async () => {
    const state = await startAndGetState();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: 'zzz-definitely-wrong' },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.broadcast as { correct: boolean }).correct).toBe(false);
  });

  it('is case-insensitive', async () => {
    const state = await startAndGetState();
    const aliceWord = state.assignments['alice']!.toUpperCase();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.broadcast as { correct: boolean }).correct).toBe(true);
  });

  it('trims whitespace before comparing', async () => {
    const state = await startAndGetState();
    const aliceWord = `  ${state.assignments['alice']!}  `;
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.broadcast as { correct: boolean }).correct).toBe(true);
  });

  it('adds guesser to state.guessed on a correct guess', async () => {
    const state = await startAndGetState();
    const aliceWord = state.assignments['alice']!;
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.state as { guessed: string[] }).guessed).toContain('alice');
  });

  it('does not end the game when not all players have guessed', async () => {
    const state = await startAndGetState();
    const aliceWord = state.assignments['alice']!;
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect(result.ended).toBeFalsy();
  });

  it('ends the game when all players have guessed correctly', async () => {
    let state = await startAndGetState();
    let lastResult;
    for (const p of PARTICIPANTS) {
      lastResult = wordGuessPlugin.onAction({
        from: p,
        action: { type: 'guess', word: state.assignments[p]! },
        state,
        participants: PARTICIPANTS,
      });
      state = lastResult.state as typeof state;
    }
    expect(lastResult?.ended).toBe(true);
  });

  it('ignores an unknown action type', async () => {
    const state = await startAndGetState();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'chat', message: 'hello' },
      state,
      participants: PARTICIPANTS,
    });
    expect(result.broadcast).toBeUndefined();
    expect(result.state).toBe(state);
  });

  it('ignores a duplicate correct guess from the same player', async () => {
    const state = await startAndGetState();
    const aliceWord = state.assignments['alice']!;
    const firstResult = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    const secondResult = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state: firstResult.state,
      participants: PARTICIPANTS,
    });
    expect((secondResult.state as { guessed: string[] }).guessed.filter((g) => g === 'alice')).toHaveLength(1);
  });
});

describe('wordGuessPlugin.onAction — spectatorState (leaderboard + reveal)', () => {
  async function startAndGetState(participants = PARTICIPANTS) {
    const { state } = await wordGuessPlugin.onStart({ participants });
    return state as { assignments: Record<string, string>; guessed: string[]; theme: string; startedAt: number };
  }

  it('includes the full word reveal from the very first action, even on a wrong guess', async () => {
    const state = await startAndGetState();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: 'zzz-definitely-wrong' },
      state,
      participants: PARTICIPANTS,
    });
    const spectatorState = result.spectatorState as { words: Record<string, string> };
    expect(spectatorState.words).toEqual(state.assignments);
  });

  it('increments wrongAttempts on a wrong guess without affecting the leaderboard', async () => {
    const state = await startAndGetState();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: 'zzz-definitely-wrong' },
      state,
      participants: PARTICIPANTS,
    });
    const spectatorState = result.spectatorState as { leaderboard: unknown[] };
    expect(spectatorState.leaderboard).toEqual([]);
    expect((result.state as { wrongAttempts: Record<string, number> }).wrongAttempts['alice']).toBe(1);
  });

  it('accumulates wrongAttempts across repeated wrong guesses from the same player', async () => {
    let state = await startAndGetState();
    for (let i = 0; i < 3; i++) {
      const result = wordGuessPlugin.onAction({
        from: 'alice',
        action: { type: 'guess', word: 'zzz-definitely-wrong' },
        state,
        participants: PARTICIPANTS,
      });
      state = result.state as typeof state;
    }
    expect((state as unknown as { wrongAttempts: Record<string, number> }).wrongAttempts['alice']).toBe(3);
  });

  it('adds a leaderboard entry with place, word, solveTimeMs and wrongAttempts on a correct guess', async () => {
    const state = await startAndGetState();
    const aliceWord = state.assignments['alice']!;
    // One wrong guess first, so wrongAttempts should show up on the eventual entry
    const afterWrong = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: 'zzz-definitely-wrong' },
      state,
      participants: PARTICIPANTS,
    });
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state: afterWrong.state,
      participants: PARTICIPANTS,
    });
    const spectatorState = result.spectatorState as {
      leaderboard: Array<{ identity: string; place: number; word: string; solveTimeMs: number; wrongAttempts: number }>;
    };
    expect(spectatorState.leaderboard).toHaveLength(1);
    const entry = spectatorState.leaderboard[0]!;
    expect(entry.identity).toBe('alice');
    expect(entry.place).toBe(1);
    expect(entry.word).toBe(aliceWord);
    expect(entry.wrongAttempts).toBe(1);
    expect(entry.solveTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('orders the leaderboard by finish order and assigns sequential places', async () => {
    let state = await startAndGetState();
    let lastResult;
    // Guess in a deliberately different order than PARTICIPANTS
    for (const p of ['carol', 'alice', 'dave', 'bob']) {
      lastResult = wordGuessPlugin.onAction({
        from: p,
        action: { type: 'guess', word: state.assignments[p]! },
        state,
        participants: PARTICIPANTS,
      });
      state = lastResult.state as typeof state;
    }
    const spectatorState = lastResult!.spectatorState as { leaderboard: Array<{ identity: string; place: number }> };
    expect(spectatorState.leaderboard.map((e) => e.identity)).toEqual(['carol', 'alice', 'dave', 'bob']);
    expect(spectatorState.leaderboard.map((e) => e.place)).toEqual([1, 2, 3, 4]);
  });

  it('final spectatorState on game end contains every participant in the leaderboard plus the full reveal', async () => {
    let state = await startAndGetState();
    let lastResult;
    for (const p of PARTICIPANTS) {
      lastResult = wordGuessPlugin.onAction({
        from: p,
        action: { type: 'guess', word: state.assignments[p]! },
        state,
        participants: PARTICIPANTS,
      });
      state = lastResult.state as typeof state;
    }
    expect(lastResult?.ended).toBe(true);
    const spectatorState = lastResult!.spectatorState as {
      words: Record<string, string>;
      leaderboard: Array<{ identity: string }>;
    };
    expect(spectatorState.leaderboard).toHaveLength(PARTICIPANTS.length);
    expect(spectatorState.words).toEqual(state.assignments);
  });

  it('a host-abort mid-round still has a partial leaderboard and the full reveal in spectatorState', async () => {
    const state = await startAndGetState();
    // Only alice finishes before the host ends the round early
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: state.assignments['alice']! },
      state,
      participants: PARTICIPANTS,
    });
    const spectatorState = result.spectatorState as {
      words: Record<string, string>;
      leaderboard: Array<{ identity: string }>;
    };
    // This is exactly what DELETE /rooms/:name/game reads as `abortedSession.spectatorState`
    expect(spectatorState.leaderboard.map((e) => e.identity)).toEqual(['alice']);
    expect(spectatorState.words).toEqual(state.assignments);
  });
});
