import type { WordGuessGameResult } from './types.js';

const MEDALS = ['🥇', '🥈', '🥉'];

/** Builds a shareable text recap of a finished Word Guess round — a ranked
 *  leaderboard plus the full word reveal — for the host to post as a snap.
 *  Posting itself is the embedding app's job; this just formats the data
 *  already on `GameResultPayload.result` into something worth pasting. */
export function formatWordGuessRecap(result: WordGuessGameResult): string {
  const lines: string[] = [`🏁 ${result.theme} Word Guess Race!`];

  result.leaderboard.forEach((entry, i) => {
    const rank = MEDALS[i] ?? `${entry.place}.`;
    const time = (entry.solveTimeMs / 1000).toFixed(1);
    const tries = entry.wrongAttempts > 0
      ? ` (${entry.wrongAttempts} ${entry.wrongAttempts === 1 ? 'try' : 'tries'})`
      : '';
    lines.push(`${rank} ${entry.identity} — ${time}s${tries}`);
  });

  const finished = new Set(result.leaderboard.map((e) => e.identity));
  const unfinished = Object.entries(result.words).filter(([identity]) => !finished.has(identity));
  if (unfinished.length > 0) {
    const list = unfinished.map(([identity, word]) => `${identity} (was ${word.toUpperCase()})`).join(', ');
    lines.push(`❌ Didn't finish: ${list}`);
  }

  const reveal = Object.entries(result.words)
    .map(([identity, word]) => `${identity}=${word.toUpperCase()}`)
    .join(', ');
  lines.push('', `🔍 Reveal: ${reveal}`);

  return lines.join('\n');
}
