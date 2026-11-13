import { describe, it, expect } from 'vitest';
import {
  buildLichessAnalysisUrl,
  formatFastDrawRecap,
  formatWordGuessRecap,
  HangoutsApiError,
  type FastDrawGameResult,
  type WordGuessGameResult,
} from '../src/index.js';

describe('buildLichessAnalysisUrl', () => {
  it('joins the moves with underscores into an analysis board URL', () => {
    expect(buildLichessAnalysisUrl(['e4', 'e5', 'Nf3'])).toBe('https://lichess.org/analysis/pgn/e4_e5_Nf3');
  });

  it('URL-encodes each move', () => {
    expect(buildLichessAnalysisUrl(['e4', 'Qxf7#', 'O-O+'])).toBe('https://lichess.org/analysis/pgn/e4_Qxf7%23_O-O%2B');
  });

  it('gives the bare board for a game with no moves', () => {
    expect(buildLichessAnalysisUrl([])).toBe('https://lichess.org/analysis/pgn/');
  });
});

describe('HangoutsApiError', () => {
  it('carries the status, message and body and is named for instanceof-free checks', () => {
    const err = new HangoutsApiError(418, 'teapot', { a: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HangoutsApiError');
    expect(err.status).toBe(418);
    expect(err.message).toBe('teapot');
    expect(err.body).toEqual({ a: 1 });
  });
});

function fastDraw(overrides: Partial<FastDrawGameResult> = {}): FastDrawGameResult {
  return {
    phase: 'game_over',
    theme: 'animals',
    winners: ['alice'],
    scores: { alice: 9, bob: 5, carol: 3, dave: 1 },
    roundNumber: 4,
    drawer: 'bob',
    revealedWord: 'cat',
    ...overrides,
  };
}

describe('formatFastDrawRecap', () => {
  it('names a single winner and ranks everyone else by score', () => {
    expect(formatFastDrawRecap(fastDraw())).toBe([
      '🎨 Animals Fast Draw — 4 rounds!',
      '🏆 alice wins with 9 points!',
      '🥈 bob — 5',
      '🥉 carol — 3',
      '4. dave — 1',
    ].join('\n'));
  });

  it('announces a tie and leaves the tied winners out of the ranking', () => {
    const text = formatFastDrawRecap(fastDraw({ winners: ['alice', 'bob'], scores: { alice: 7, bob: 7, carol: 2 } }));
    expect(text.split('\n')).toEqual([
      '🎨 Animals Fast Draw — 4 rounds!',
      '🏆 Tie! alice & bob both reached 7 points!',
      '🥉 carol — 2',
    ]);
  });

  it('says "round" for a one round game and lists everyone when nobody won', () => {
    const text = formatFastDrawRecap(fastDraw({ roundNumber: 1, winners: [], scores: { bob: 2, alice: 4 } }));
    expect(text.split('\n')).toEqual([
      '🎨 Animals Fast Draw — 1 round!',
      '🥇 alice — 4',
      '🥈 bob — 2',
    ]);
  });

  it('calls a missing theme Unknown', () => {
    expect(formatFastDrawRecap(fastDraw({ theme: '' })).split('\n')[0]).toBe('🎨 Unknown Fast Draw — 4 rounds!');
  });
});

function wordGuess(overrides: Partial<WordGuessGameResult> = {}): WordGuessGameResult {
  return {
    theme: 'philosophers',
    playerCount: 3,
    words: { alice: 'kant', bob: 'hume', carol: 'locke' },
    leaderboard: [
      { identity: 'alice', place: 1, word: 'kant', solveTimeMs: 12_340, wrongAttempts: 0 },
      { identity: 'bob', place: 2, word: 'hume', solveTimeMs: 20_000, wrongAttempts: 1 },
    ],
    ...overrides,
  };
}

describe('formatWordGuessRecap', () => {
  it('ranks finishers with medals, times and tries, lists who did not finish and reveals every word', () => {
    expect(formatWordGuessRecap(wordGuess())).toBe([
      '🏁 Philosophers Word Guess Race!',
      '🥇 alice — 12.3s',
      '🥈 bob — 20.0s (1 try)',
      "❌ Didn't finish: carol (was LOCKE)",
      '',
      '🔍 Reveal: alice=KANT, bob=HUME, carol=LOCKE',
    ].join('\n'));
  });

  it('uses the finish place past the third and pluralises tries', () => {
    const leaderboard = ['a', 'b', 'c', 'd'].map((identity, i) => ({
      identity, place: i + 1, word: 'w', solveTimeMs: 1000 * (i + 1), wrongAttempts: i === 3 ? 3 : 0,
    }));
    const lines = formatWordGuessRecap(wordGuess({ leaderboard, words: { a: 'w', b: 'w', c: 'w', d: 'w' } })).split('\n');
    expect(lines[4]).toBe('4. d — 4.0s (3 tries)');
    expect(lines.some((l) => l.startsWith('❌'))).toBe(false);
  });

  it('calls a missing theme Unknown and handles a round nobody finished', () => {
    const lines = formatWordGuessRecap(wordGuess({ theme: '', leaderboard: [], words: { alice: 'kant' } })).split('\n');
    expect(lines).toEqual([
      '🏁 Unknown Word Guess Race!',
      "❌ Didn't finish: alice (was KANT)",
      '',
      '🔍 Reveal: alice=KANT',
    ]);
  });
});
