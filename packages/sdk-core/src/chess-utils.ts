/**
 * Builds a Lichess analysis-board URL that replays a finished game move by
 * move, with zero API calls — Lichess loads any PGN move list passed in the
 * `/analysis/pgn/<moves>` path, no auth or import step required.
 * See https://lichess.org/api#tag/Games/operation/gameImport (description).
 */
export function buildLichessAnalysisUrl(moveHistory: string[]): string {
  return `https://lichess.org/analysis/pgn/${moveHistory.map(encodeURIComponent).join('_')}`;
}
