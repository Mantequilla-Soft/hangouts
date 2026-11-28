/**
 * The viewer-facing text of the live-interaction pieces: the poll and
 * prediction card, the raid banner, and the server's lines in chat (a raid,
 * and the points shop's highlight, reward and bounty lines). Integrators that
 * translate pass `labels` (any subset; the rest stays English), like
 * BoostLabels. Placeholders are `{name}` and are filled by the SDK.
 */
export interface LiveLabels {
  /** {name} {count}: the line in the target's chat when a raid arrives. */
  raidLine: string;
  /** {host}: the banner's title while a raid counts down. */
  raidTitle: string;
  /** {title} {seconds}: what happens next. */
  raidBody: string;
  raidGoNow: string;
  raidStay: string;
  pollBadge: string;
  predictionBadge: string;
  /** {time}: e.g. 0:42 */
  endsIn: string;
  finalResults: string;
  /** {count} */
  votes: string;
  youVoted: string;
  signInToVote: string;
  voteFailed: string;
  /** {points} */
  pot: string;
  /** {points} */
  balance: string;
  stakeButton: string;
  stakePlaceholder: string;
  /** {points} {option} */
  yourStake: string;
  waitingForResult: string;
  /** {option} */
  outcomeWon: string;
  /** {points}: what the viewer got back from a resolved prediction. */
  youWon: string;
  cancelled: string;
  close: string;
  /** The folded line of a finished poll in the chat opens it again. */
  showResult: string;
  hideResult: string;
  /** Points shop lines in chat. The tag on a highlighted message. */
  highlightTag: string;
  /** {name} {title}: a viewer redeemed one of the host's channel rewards. */
  rewardLine: string;
  /** {name} {title} {points}: a viewer put up a bounty. */
  bountyLine: string;
  /** {name} {title} {points}: the host completed a bounty. */
  bountyDoneLine: string;
  /** Over the highlighted message pinned on top of the chat. */
  pinnedTag: string;
  /** The small mark next to a channel supporter's name (its tooltip). */
  supporterMark: string;
  /** The sticker row in the emoji tray. */
  stickersRow: string;
}

export const DEFAULT_LIVE_LABELS: LiveLabels = {
  raidLine: '{name} is raiding with {count} viewers',
  raidTitle: '@{host} is raiding another stream',
  raidBody: 'Everyone watching goes along to {title} in {seconds} s.',
  raidGoNow: 'Go now',
  raidStay: 'Stay here',
  pollBadge: 'Poll',
  predictionBadge: 'Prediction',
  endsIn: 'Ends in {time}',
  finalResults: 'Final results',
  votes: 'Votes: {count}',
  youVoted: 'You voted',
  signInToVote: 'Sign in to vote',
  voteFailed: 'That did not work. Try again.',
  pot: 'Pot: {points} points',
  balance: 'You have {points} points',
  stakeButton: 'Stake',
  stakePlaceholder: 'Points',
  yourStake: 'You put {points} points on {option}',
  waitingForResult: 'Waiting for the result',
  outcomeWon: '{option} won',
  youWon: 'You got {points} points back',
  cancelled: 'Cancelled, everyone keeps their points',
  close: 'Close',
  showResult: 'Show the result',
  hideResult: 'Hide the result',
  highlightTag: 'Highlighted',
  rewardLine: '@{name} redeemed {title}',
  bountyLine: '@{name} put up a bounty: {title} ({points} points)',
  bountyDoneLine: '@{name} completed: {title} ({points} points)',
  pinnedTag: 'Pinned',
  supporterMark: 'Channel supporter',
  stickersRow: 'Stickers',
};

export function liveLabels(labels?: Partial<LiveLabels>): LiveLabels {
  if (!labels) return DEFAULT_LIVE_LABELS;
  const out = { ...DEFAULT_LIVE_LABELS };
  for (const [k, v] of Object.entries(labels)) {
    if (typeof v === 'string' && v) (out as unknown as Record<string, string>)[k] = v;
  }
  return out;
}

/** Fill `{name}` placeholders. Unknown ones stay as they are. */
export function fillLabel(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** 0:42, 3:05, 1:02:09 */
export function clockLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
