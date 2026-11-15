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
