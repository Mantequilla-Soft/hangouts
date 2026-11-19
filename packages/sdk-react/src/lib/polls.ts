/**
 * Polls and predictions as the server sends them (hangouts server
 * routes/polls.ts), plus the small bits of math the cards show.
 */

export type PollKind = 'poll' | 'prediction';
export type PollStatus = 'open' | 'locked' | 'closed' | 'resolved' | 'cancelled';

export interface PollOptionView {
  label: string;
  /** Votes (poll) or how many viewers staked on it (prediction). */
  votes: number;
  /** Points staked on it (prediction). */
  points?: number;
}

export interface PollView {
  id: string;
  room: string;
  host: string;
  kind: PollKind;
  question: string;
  options: PollOptionView[];
  total: number;
  pot?: number;
  status: PollStatus;
  createdAt: number;
  endsAt: number;
  endedAt?: number;
  offset: number | null;
  winner?: number;
}

export interface PollStake { option: number; amount: number }

export function parsePoll(raw: unknown): PollView | null {
  const p = raw as PollView;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.question !== 'string' || !Array.isArray(p.options)) return null;
  if (p.kind !== 'poll' && p.kind !== 'prediction') return null;
  return p;
}

export function isFinished(p: PollView): boolean {
  return p.status === 'closed' || p.status === 'resolved' || p.status === 'cancelled';
}

/** Share of the votes (poll) or of the pot (prediction), 0 to 100, one decimal. */
export function optionShare(p: PollView, index: number): number {
  const o = p.options[index];
  if (!o) return 0;
  if (p.kind === 'prediction') {
    const pot = p.pot ?? p.options.reduce((s, x) => s + (x.points ?? 0), 0);
    return pot > 0 ? Math.round(((o.points ?? 0) / pot) * 1000) / 10 : 0;
  }
  return p.total > 0 ? Math.round((o.votes / p.total) * 1000) / 10 : 0;
}

/** The option(s) in the lead: the most votes, or the most points. */
export function leaders(p: PollView): number[] {
  const score = (o: PollOptionView) => (p.kind === 'prediction' ? (o.points ?? 0) : o.votes);
  const top = Math.max(0, ...p.options.map(score));
  if (top === 0) return [];
  return p.options.map((o, i) => (score(o) === top ? i : -1)).filter((i) => i >= 0);
}

/** What a winning stake pays back (the stake plus its share of the losing side). */
export function payoutFor(p: PollView, stake: PollStake): number {
  const winPool = p.options[stake.option]?.points ?? 0;
  const pot = p.pot ?? p.options.reduce((s, x) => s + (x.points ?? 0), 0);
  if (winPool <= 0) return stake.amount;
  return Math.floor((stake.amount * pot) / winPool);
}

/** A finished poll's result stays open in the chat this long, then folds to one line. */
export const RESULT_OPEN_MS = 5 * 60_000;

/** When a finished poll ended (an older server sent no endedAt: its timer end). */
export function endedAt(p: PollView): number {
  return p.endedAt ?? p.endsAt;
}

/** The stream's finished polls, oldest first: `p` added or updated in place. Unfinished ones are not results. */
export function addResult(list: PollView[], p: PollView): PollView[] {
  if (!isFinished(p)) return list;
  const i = list.findIndex((x) => x.id === p.id);
  const next = i >= 0 ? list.map((x, j) => (j === i ? p : x)) : [...list, p];
  return next.sort((a, b) => endedAt(a) - endedAt(b));
}

/** The server's list of a stream's finished polls (GET /rooms/:name/polls). */
export function parsePollList(raw: unknown): PollView[] {
  const list = (raw as { polls?: unknown })?.polls;
  if (!Array.isArray(list)) return [];
  return list.map(parsePoll).filter((p): p is PollView => !!p).reduce(addResult, [] as PollView[]);
}

/** One line for a folded result: who won, the leading option(s), or that it was called off. */
export function resultSummary(p: PollView, L: { outcomeWon: string; finalResults: string; cancelled: string }): string {
  if (p.status === 'cancelled') return L.cancelled;
  const won = p.winner !== undefined ? [p.winner] : leaders(p);
  if (!won.length) return L.finalResults;
  return L.outcomeWon.replace('{option}', won.map((i) => p.options[i]?.label ?? '').join(' / '));
}
