import { useEffect, useState } from 'react';
import { usePolls, type CreatePollInput } from '../../hooks/usePolls.js';
import { clockLabel, fillLabel, liveLabels, type LiveLabels } from '../../lib/liveLabels.js';
import { isFinished, leaders, optionShare, payoutFor, type PollStake, type PollView } from '../../lib/polls.js';
import { useStreamContext } from './StandaloneWatch.js';

/** A clock that ticks while `on`, for the time left. */
function useNow(on: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [on, everyMs]);
  return now;
}

export interface PollCardViewProps {
  poll: PollView;
  now: number;
  labels?: Partial<LiveLabels>;
  myVote?: number | null;
  myStake?: PollStake | null;
  balance?: number | null;
  /** Signed in: may vote or stake. */
  canVote: boolean;
  busy?: boolean;
  error?: string | null;
  onVote?: (option: number) => void;
  onStake?: (option: number, amount: number) => void;
  onDismiss?: () => void;
}

/** The poll or prediction card (no state of its own beyond the stake box). */
export function PollCardView({
  poll, now, labels, myVote = null, myStake = null, balance = null, canVote, busy = false, error = null,
  onVote, onStake, onDismiss,
}: PollCardViewProps) {
  const L = liveLabels(labels);
  const [amount, setAmount] = useState('');
  const finished = isFinished(poll);
  const open = poll.status === 'open' && poll.endsAt > now;
  const prediction = poll.kind === 'prediction';
  const lead = finished || poll.status === 'locked' ? leaders(poll) : [];
  const winner = poll.status === 'resolved' ? poll.winner : undefined;
  // A poll shows its results once you voted or it is no longer open; a
  // prediction always shows how the pot is split (that is what you bet on).
  const showResults = prediction || !open || myVote !== null || !canVote;
  const amt = Math.floor(Number(amount));
  // `balance` is what is left to stake (the server takes your stake off it).
  const amountOk = Number.isFinite(amt) && amt >= 1 && (balance === null || amt <= balance);

  let status: string;
  if (poll.status === 'cancelled') status = L.cancelled;
  else if (winner !== undefined) status = fillLabel(L.outcomeWon, { option: poll.options[winner]?.label ?? '' });
  else if (finished) status = L.finalResults;
  else if (poll.status === 'locked' || !open) status = prediction ? L.waitingForResult : L.finalResults;
  else status = fillLabel(L.endsIn, { time: clockLabel((poll.endsAt - now) / 1000) });

  return (
    <section className={`hh-poll hh-poll--${poll.kind}${finished ? ' hh-poll--done' : ''}`} aria-label={poll.question}>
      <header className="hh-poll__head">
        <span className="hh-poll__badge">{prediction ? L.predictionBadge : L.pollBadge}</span>
        <span className="hh-poll__status num" role="timer">{status}</span>
        {onDismiss && finished && (
          <button type="button" className="hh-poll__close" onClick={onDismiss} aria-label={L.close} title={L.close}>✕</button>
        )}
      </header>
      <p className="hh-poll__question">{poll.question}</p>
      <ol className="hh-poll__options">
        {poll.options.map((o, i) => {
          const share = optionShare(poll, i);
          const mine = myVote === i || myStake?.option === i;
          const won = winner === i || (winner === undefined && lead.includes(i) && finished);
          return (
            <li key={i} className={`hh-poll__opt${mine ? ' is-mine' : ''}${won ? ' is-winner' : ''}`}>
              {showResults ? (
                <div className="hh-poll__result">
                  <span className="hh-poll__bar" style={{ width: `${share}%` }} aria-hidden="true" />
                  <span className="hh-poll__label">{o.label}{mine ? ' ✓' : ''}</span>
                  <span className="hh-poll__pct num">{prediction ? `${o.points ?? 0}` : `${share}%`}</span>
                </div>
              ) : (
                <button
                  type="button"
                  className="hh-poll__choice"
                  disabled={busy}
                  onClick={() => onVote?.(i)}
                >
                  {o.label}
                </button>
              )}
              {prediction && open && canVote && (!myStake || myStake.option === i) && (
                <button
                  type="button"
                  className="hh-btn hh-btn--small hh-poll__stake-btn"
                  disabled={busy || !amountOk}
                  onClick={() => { onStake?.(i, amt); setAmount(''); }}
                >
                  {L.stakeButton}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {prediction && open && canVote && (
        <div className="hh-poll__stake">
          <input
            className="hh-poll__amount"
            type="number"
            inputMode="numeric"
            min={1}
            max={balance ?? undefined}
            value={amount}
            placeholder={L.stakePlaceholder}
            aria-label={L.stakePlaceholder}
            onChange={(e) => setAmount(e.target.value)}
          />
          {balance !== null && <span className="hh-poll__balance num">{fillLabel(L.balance, { points: balance })}</span>}
        </div>
      )}
      <footer className="hh-poll__foot">
        <span className="num">{prediction ? fillLabel(L.pot, { points: poll.pot ?? 0 }) : fillLabel(L.votes, { count: poll.total })}</span>
        {myStake && (
          <span>
            {winner !== undefined && winner === myStake.option
              ? fillLabel(L.youWon, { points: payoutFor(poll, myStake) })
              : fillLabel(L.yourStake, { points: myStake.amount, option: poll.options[myStake.option]?.label ?? '' })}
          </span>
        )}
        {!myStake && myVote !== null && <span>{L.youVoted}</span>}
        {!canVote && open && <span>{L.signInToVote}</span>}
      </footer>
      {error && <p className="hh-poll__error" role="alert">{L.voteFailed}</p>}
    </section>
  );
}

export interface StreamPollCardProps {
  /** Defaults to the stream's room (inside StandaloneWatch). */
  roomName?: string;
  labels?: Partial<LiveLabels>;
  className?: string;
}

/**
 * The viewer's card for the poll or prediction running in the stream. Renders
 * nothing when none is running. ChatPanel shows it above the messages.
 */
export function StreamPollCard({ roomName, labels, className }: StreamPollCardProps) {
  const ctxRoom = useStreamContext().roomName;
  const room = roomName ?? ctxRoom;
  const polls = usePolls(room);
  const now = useNow(!!polls.poll && polls.poll.status === 'open');
  if (!room || !polls.poll) return null;
  return (
    <div className={className}>
      <PollCardView
        poll={polls.poll}
        now={now}
        labels={labels}
        myVote={polls.myVote}
        myStake={polls.myStake}
        balance={polls.balance}
        canVote={polls.isAuthenticated}
        busy={polls.busy}
        error={polls.error}
        onVote={(o) => { void polls.vote(o); }}
        onStake={(o, a) => { void polls.stake(o, a); }}
        onDismiss={polls.dismiss}
      />
    </div>
  );
}

const DURATIONS = [30, 60, 120, 300];
const PREDICTION_WINDOWS = [60, 120, 300, 600];

function fmtDuration(sec: number): string {
  return sec < 60 ? `${sec} s` : `${sec / 60} min`;
}

/**
 * Host controls: start a poll (2 to 4 options, a timer) or a prediction (two
 * outcomes, a staking window), watch the results come in, end it early, and
 * resolve or cancel a prediction. English, like the rest of the studio.
 */
export function PollHostPanel({ roomName }: { roomName: string }) {
  const polls = usePolls(roomName);
  const [kind, setKind] = useState<'poll' | 'prediction'>('poll');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [duration, setDuration] = useState(60);
  const now = useNow(!!polls.poll && polls.poll.status === 'open');
  const p = polls.poll;
  const running = !!p && !isFinished(p);

  const pickKind = (k: 'poll' | 'prediction') => {
    setKind(k);
    setDuration(k === 'poll' ? 60 : 120);
    setOptions((o) => (k === 'prediction' ? [o[0] ?? '', o[1] ?? ''] : o));
  };
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const canStart = !!question.trim() && filled.length >= 2 && new Set(filled.map((o) => o.toLowerCase())).size === filled.length && !polls.busy;

  const start = async () => {
    const input: CreatePollInput = { kind, question: question.trim(), options: filled, durationSec: duration };
    if (await polls.create(input)) { setQuestion(''); setOptions(['', '']); }
  };

  return (
    <div className="hh-pollhost">
      {p && (
        <PollCardView poll={p} now={now} canVote={false} onDismiss={polls.dismiss} />
      )}
      {running && (
        <div className="hh-pollhost__actions">
          {p!.kind === 'poll' && <button type="button" className="hh-btn hh-btn--small" disabled={polls.busy} onClick={() => void polls.end()}>End poll now</button>}
          {p!.kind === 'prediction' && p!.status === 'open' && (
            <button type="button" className="hh-btn hh-btn--small" disabled={polls.busy} onClick={() => void polls.end()}>Stop taking points</button>
          )}
          {p!.kind === 'prediction' && p!.options.map((o, i) => (
            <button key={i} type="button" className="hh-btn hh-btn--primary hh-btn--small" disabled={polls.busy} onClick={() => void polls.resolve(i)}>
              “{o.label}” won
            </button>
          ))}
          <button type="button" className="hh-btn hh-btn--small hh-btn--danger" disabled={polls.busy} onClick={() => void polls.cancel()}>
            {p!.kind === 'prediction' ? 'Cancel and give points back' : 'Cancel'}
          </button>
        </div>
      )}
      {!running && (
        <form className="hh-pollhost__form" onSubmit={(e) => { e.preventDefault(); if (canStart) void start(); }}>
          <div className="hh-pollhost__kinds" role="radiogroup" aria-label="Type">
            <button type="button" role="radio" aria-checked={kind === 'poll'} className={`hh-pollhost__kind${kind === 'poll' ? ' is-on' : ''}`} onClick={() => pickKind('poll')}>
              📊 Poll
              <em>2 to 4 options, one vote per Hive account</em>
            </button>
            <button type="button" role="radio" aria-checked={kind === 'prediction'} className={`hh-pollhost__kind${kind === 'prediction' ? ' is-on' : ''}`} onClick={() => pickKind('prediction')}>
              🔮 Prediction
              <em>Two outcomes, viewers stake channel points (not money)</em>
            </button>
          </div>
          <input className="hh-pollhost__input" value={question} maxLength={140} placeholder={kind === 'poll' ? 'Ask your viewers something' : 'What will happen?'} aria-label="Question" onChange={(e) => setQuestion(e.target.value)} />
          {options.map((o, i) => (
            <div className="hh-pollhost__opt" key={i}>
              <input
                className="hh-pollhost__input"
                value={o}
                maxLength={60}
                placeholder={kind === 'prediction' ? (i === 0 ? 'Outcome 1, e.g. Yes' : 'Outcome 2, e.g. No') : `Option ${i + 1}`}
                aria-label={`Option ${i + 1}`}
                onChange={(e) => setOptions((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {kind === 'poll' && options.length > 2 && (
                <button type="button" className="hh-pollhost__remove" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((all) => all.filter((_, j) => j !== i))}>✕</button>
              )}
            </div>
          ))}
          {kind === 'poll' && options.length < 4 && (
            <button type="button" className="hh-btn hh-btn--small" onClick={() => setOptions((all) => [...all, ''])}>＋ Add option</button>
          )}
          <div className="hh-pollhost__durations" role="radiogroup" aria-label={kind === 'poll' ? 'Timer' : 'Time to stake'}>
            <span>{kind === 'poll' ? 'Timer' : 'Time to stake'}</span>
            {(kind === 'poll' ? DURATIONS : PREDICTION_WINDOWS).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={duration === d} className={`hh-pollhost__chip${duration === d ? ' is-on' : ''}`} onClick={() => setDuration(d)}>{fmtDuration(d)}</button>
            ))}
          </div>
          <button type="submit" className="hh-btn hh-btn--primary" disabled={!canStart}>
            {kind === 'poll' ? 'Start poll' : 'Start prediction'}
          </button>
        </form>
      )}
      {polls.error && <p className="hh-pollhost__error" role="alert">{polls.error}</p>}
    </div>
  );
}
