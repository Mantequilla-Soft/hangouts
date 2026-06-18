import type { FastDrawGameResult } from './types.js';

const MEDALS = ['🥇', '🥈', '🥉'];

/** Builds a shareable text recap of a finished Fast Draw game — final
 *  scoreboard plus the winner(s) — for the host to post as a snap.
 *  Posting itself is the embedding app's job; this just formats the data
 *  already on `GameResultPayload.result` into something worth pasting. */
export function formatFastDrawRecap(result: FastDrawGameResult): string {
  const rawTheme = result.theme || 'Unknown';
  const theme = rawTheme.charAt(0).toUpperCase() + rawTheme.slice(1);
  const ranked = Object.entries(result.scores).sort(([, a], [, b]) => b - a);
  const lines: string[] = [`🎨 ${theme} Fast Draw — ${result.roundNumber} round${result.roundNumber === 1 ? '' : 's'}!`];

  if (result.winners.length > 1) {
    const points = result.scores[result.winners[0]!];
    lines.push(`🏆 Tie! ${result.winners.join(' & ')} both reached ${points} points!`);
  } else if (result.winners.length === 1) {
    lines.push(`🏆 ${result.winners[0]} wins with ${result.scores[result.winners[0]!]} points!`);
  }

  ranked.forEach(([identity, score], i) => {
    if (result.winners.includes(identity)) return; // already named in the trophy line above
    const rank = MEDALS[i] ?? `${i + 1}.`;
    lines.push(`${rank} ${identity} — ${score}`);
  });

  return lines.join('\n');
}
