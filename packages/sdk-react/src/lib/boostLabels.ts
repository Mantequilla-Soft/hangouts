/**
 * The viewer-facing boost text: the Send a Boost dialog, the goal bar and the
 * top supporters list. Integrators that translate pass `labels` (any subset;
 * the rest stays English), the same way as CreateRoomDialog's labels.
 * Placeholders are `{name}` and are filled by the SDK.
 */
export interface BoostLabels {
  dialogTitle: string;
  close: string;
  success: string;
  done: string;
  /** Above the preset amount buttons. */
  presetsLabel: string;
  /** The amount box's placeholder, for an amount of your own. */
  customAmount: string;
  /** Before the recipient buttons when a guest is on air. */
  recipientsLabel: string;
  hostTag: string;
  rateHbd: string;
  rateHive: string;
  /** {min} */
  minimumHint: string;
  /** {fee} {recipient} {share} */
  feeHint: string;
  /** {amount} {asset}: what the recipient gets, after feeHint. */
  feeAmount: string;
  /** {max} */
  messagePlaceholder: string;
  cancel: string;
  send: string;
  sending: string;
  loading: string;
  errAmount: string;
  errMessage: string;
  /** {min} */
  errMinimum: string;
  errNotEnabled: string;
  errNoWallet: string;
  /** {error} */
  errConfig: string;
  errTransfer: string;
  approveHiveAuth: string;
  /** The goal bar's name when the host gave the goal no title. */
  goalDefaultTitle: string;
  /** {progress} {target} */
  goalProgress: string;
  goalReached: string;
  topSupporters: string;
  /** {amount} */
  supporterAmount: string;
  /** The asset picker's entry for paying with channel points. */
  assetPoints: string;
  /** {points}: a points amount, e.g. on the preset buttons. */
  pointsAmount: string;
  /** {points} */
  pointsBalance: string;
  /** Under the amount when paying with points. */
  pointsHint: string;
  /** {min} */
  errPointsMinimum: string;
  /** {points} */
  errPointsBalance: string;
  /** On the send button while a points spend waits for the chain. */
  pointsConfirming: string;
  errSignIn: string;
}

export const DEFAULT_BOOST_LABELS: BoostLabels = {
  dialogTitle: 'Send a Boost',
  close: 'Close',
  success: "Boost sent! It'll appear on screen in a moment.",
  done: 'Done',
  presetsLabel: 'Amount',
  customAmount: 'Other amount',
  recipientsLabel: 'Boost',
  hostTag: 'host',
  rateHbd: '1 HBD = $1.00, pegged to USD',
  rateHive: 'HIVE price varies with the market',
  minimumHint: 'Minimum ${min} USD to appear on screen',
  feeHint: '{fee}% platform fee, @{recipient} receives {share}%',
  feeAmount: '({amount} {asset})',
  messagePlaceholder: 'Your message (max {max} characters)',
  cancel: 'Cancel',
  send: 'Send Boost',
  sending: 'Sending…',
  loading: 'Loading…',
  errAmount: 'Enter a valid amount',
  errMessage: 'Enter a message',
  errMinimum: "This stream's minimum is ${min}. A smaller boost won't show on screen.",
  errNotEnabled: 'Boosts are not enabled on this server',
  errNoWallet: 'Platform wallet not configured',
  errConfig: 'Could not reach boost config: {error}',
  errTransfer: 'Transfer failed',
  approveHiveAuth: 'Approve the boost in your HiveAuth app',
  goalDefaultTitle: 'Boost goal',
  goalProgress: '{progress} / {target} HBD',
  goalReached: 'Goal reached!',
  topSupporters: 'Top supporters',
  supporterAmount: '{amount} HBD',
  assetPoints: 'Points',
  pointsAmount: '{points} points',
  pointsBalance: 'You have {points} points.',
  pointsHint: 'Points are spent, the streamer gets no money. Earn points by watching, chatting, streaming and boosting.',
  errPointsMinimum: 'A points boost is at least {min} points.',
  errPointsBalance: 'You only have {points} points.',
  pointsConfirming: 'Confirming your points...',
  errSignIn: 'Sign in to boost with points.',
};

/** Defaults plus the integrator's text; an empty or missing entry keeps English. */
export function boostLabels(labels?: Partial<BoostLabels>): BoostLabels {
  if (!labels) return DEFAULT_BOOST_LABELS;
  const given = Object.fromEntries(
    Object.entries(labels).filter(([, v]) => typeof v === 'string' && v.length > 0),
  ) as Partial<BoostLabels>;
  return { ...DEFAULT_BOOST_LABELS, ...given };
}
