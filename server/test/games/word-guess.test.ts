import { describe, it, expect } from 'vitest';
import { wordGuessPlugin } from '../../src/games/word-guess.js';

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
  it('assigns a unique word to each participant', () => {
    const { state } = wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    const assignments = (state as { assignments: Record<string, string> }).assignments;
    const words = Object.values(assignments);
    expect(new Set(words).size).toBe(words.length);
    expect(Object.keys(assignments)).toEqual(expect.arrayContaining(PARTICIPANTS));
  });

  it("each player sees others' words but myWord is null", () => {
    const { payloads } = wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    for (const identity of PARTICIPANTS) {
      const view = payloads[identity] as { myWord: null; others: { identity: string; word: string }[] };
      expect(view.myWord).toBeNull();
      expect(view.others).toHaveLength(PARTICIPANTS.length - 1);
      expect(view.others.map((o) => o.identity)).not.toContain(identity);
    }
  });

  it("each player sees the correct word for every other player", () => {
    const { state, payloads } = wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    const assignments = (state as { assignments: Record<string, string> }).assignments;
    for (const identity of PARTICIPANTS) {
      const view = payloads[identity] as { others: { identity: string; word: string }[] };
      for (const other of view.others) {
        expect(other.word).toBe(assignments[other.identity]);
      }
    }
  });

  it('defaults to animals theme', () => {
    const { state } = wordGuessPlugin.onStart({ participants: ['alice', 'bob'] });
    expect((state as { theme: string }).theme).toBe('animals');
  });

  it('accepts an explicit theme', () => {
    const { state } = wordGuessPlugin.onStart({ participants: ['alice', 'bob'], config: { theme: 'food' } });
    expect((state as { theme: string }).theme).toBe('food');
  });

  it('falls back to animals for an unknown theme', () => {
    const { state } = wordGuessPlugin.onStart({ participants: ['alice', 'bob'], config: { theme: 'made-up' } });
    expect((state as { theme: string }).theme).toBe('animals');
  });

  it('accepts custom words and marks theme as custom', () => {
    const customWords = ['sword', 'shield', 'bow', 'axe', 'staff', 'dagger'];
    const { state } = wordGuessPlugin.onStart({ participants: ['alice', 'bob'], config: { customWords } });
    const s = state as { theme: string; assignments: Record<string, string> };
    expect(s.theme).toBe('custom');
    for (const word of Object.values(s.assignments)) {
      expect(customWords).toContain(word);
    }
  });

  it('includes a broadcast with theme and playerCount', () => {
    const { broadcast } = wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    expect(broadcast).toMatchObject({ theme: 'animals', playerCount: 4 });
  });

  it('works with the minimum of 2 players', () => {
    const { payloads } = wordGuessPlugin.onStart({ participants: ['alice', 'bob'] });
    expect(Object.keys(payloads)).toHaveLength(2);
  });

  it('initialises the guessed list as empty', () => {
    const { state } = wordGuessPlugin.onStart({ participants: PARTICIPANTS });
    expect((state as { guessed: string[] }).guessed).toEqual([]);
  });
});

describe('wordGuessPlugin.onAction — guess', () => {
  function startAndGetState(participants = PARTICIPANTS) {
    const { state } = wordGuessPlugin.onStart({ participants });
    return state as { assignments: Record<string, string>; guessed: string[]; theme: string; startedAt: number };
  }

  it('broadcasts correct:true when the guess matches the assigned word', () => {
    const state = startAndGetState();
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

  it('broadcasts correct:false when the guess is wrong', () => {
    const state = startAndGetState();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: 'zzz-definitely-wrong' },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.broadcast as { correct: boolean }).correct).toBe(false);
  });

  it('is case-insensitive', () => {
    const state = startAndGetState();
    const aliceWord = state.assignments['alice']!.toUpperCase();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.broadcast as { correct: boolean }).correct).toBe(true);
  });

  it('trims whitespace before comparing', () => {
    const state = startAndGetState();
    const aliceWord = `  ${state.assignments['alice']!}  `;
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.broadcast as { correct: boolean }).correct).toBe(true);
  });

  it('adds guesser to state.guessed on a correct guess', () => {
    const state = startAndGetState();
    const aliceWord = state.assignments['alice']!;
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect((result.state as { guessed: string[] }).guessed).toContain('alice');
  });

  it('does not end the game when not all players have guessed', () => {
    const state = startAndGetState();
    const aliceWord = state.assignments['alice']!;
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'guess', word: aliceWord },
      state,
      participants: PARTICIPANTS,
    });
    expect(result.ended).toBeFalsy();
  });

  it('ends the game when all players have guessed correctly', () => {
    let state = startAndGetState();
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

  it('ignores an unknown action type', () => {
    const state = startAndGetState();
    const result = wordGuessPlugin.onAction({
      from: 'alice',
      action: { type: 'chat', message: 'hello' },
      state,
      participants: PARTICIPANTS,
    });
    expect(result.broadcast).toBeUndefined();
    expect(result.state).toBe(state);
  });

  it('ignores a duplicate correct guess from the same player', () => {
    const state = startAndGetState();
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
    // Second call returns unchanged state with no broadcast
    expect((secondResult.state as { guessed: string[] }).guessed.filter((g) => g === 'alice')).toHaveLength(1);
  });
});
