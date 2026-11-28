/**
 * The points shop's text: the viewers' "Use points" menu and its dialogs, the
 * studio's host panels (suggested polls, channel rewards, bounties), the
 * read-aloud alert and setting, and the extra stream time button.
 * Integrators that translate pass `labels` (any subset; the rest stays
 * English), like LiveLabels. Placeholders are `{name}` and are filled by the SDK.
 * The chat's own lines (highlight, reward, bounty, pinned, stickers) are in
 * LiveLabels, next to the raid line.
 */
export interface ShopLabels {
  // The viewers' menu.
  usePoints: string;
  menuTitle: string;
  /** {points} */
  balance: string;
  /** {points} */
  pointsPrice: string;
  itemHighlight: string;
  itemHighlightHint: string;
  itemReadAloud: string;
  itemReadAloudHint: string;
  itemSuggestPoll: string;
  itemSuggestPollHint: string;
  itemReward: string;
  itemRewardHint: string;
  itemBounty: string;
  itemBountyHint: string;
  itemStickers: string;
  itemStickersHint: string;
  stickersOwned: string;
  unavailable: string;
  // The dialogs.
  /** {max} */
  messagePlaceholder: string;
  questionPlaceholder: string;
  /** {n} */
  optionPlaceholder: string;
  addOption: string;
  /** {n} */
  removeOption: string;
  rewardInputPlaceholder: string;
  noRewards: string;
  /** {points} */
  rewardCostTag: string;
  rewardAsksText: string;
  bountyOpen: string;
  bountyNew: string;
  bountyTextPlaceholder: string;
  bountyAmount: string;
  /** {min} */
  bountyMin: string;
  /** {points} {count} */
  bountyBackers: string;
  /** {points} */
  buy: string;
  buying: string;
  confirming: string;
  back: string;
  close: string;
  done: string;
  successHighlight: string;
  successReadAloud: string;
  successSuggestPoll: string;
  successReward: string;
  successBounty: string;
  successStickers: string;
  errSignIn: string;
  errText: string;
  errQuestion: string;
  /** {min} */
  errAmount: string;
  /** {points} */
  errBalance: string;
  errFailed: string;
  // The studio's host panels.
  tabRewards: string;
  tabBounties: string;
  suggestionsTitle: string;
  suggestionsEmpty: string;
  /** {name} */
  suggestionFrom: string;
  suggestionTimer: string;
  suggestionRun: string;
  suggestionDecline: string;
  rewardsIntro: string;
  queueTitle: string;
  queueEmpty: string;
  /** {name} {title} */
  queueLine: string;
  queueDone: string;
  queueRefund: string;
  rewardsTitle: string;
  rewardName: string;
  rewardNamePlaceholder: string;
  rewardCost: string;
  rewardPrompt: string;
  rewardEnabled: string;
  rewardRemove: string;
  rewardAdd: string;
  /** {max} */
  rewardsMax: string;
  rewardsSave: string;
  rewardsSaved: string;
  saving: string;
  errRewardName: string;
  /** {min} {max} */
  errRewardCost: string;
  bountiesIntro: string;
  bountiesEmpty: string;
  /** {name} */
  bountyBy: string;
  bountyDone: string;
  bountyDecline: string;
  loading: string;
  // Read-aloud.
  readAloudTitle: string;
  /** {name} {message} */
  readAloudAlert: string;
  /** {name} {message}: what the speech synthesis says. */
  readAloudSpeech: string;
  readAloudToggle: string;
  readAloudHint: string;
  readAloudLocalOnly: string;
  // Extra stream time.
  /** {minutes} {points} */
  buyMinutes: string;
  buyMinutesBusy: string;
  /** {minutes} */
  minutesAdded: string;
}

export const DEFAULT_SHOP_LABELS: ShopLabels = {
  usePoints: 'Use points',
  menuTitle: 'Spend your points',
  balance: 'You have {points} points',
  pointsPrice: '{points} points',
  itemHighlight: 'Highlight a message',
  itemHighlightHint: 'Your message stands out and stays pinned on top of the chat for a minute.',
  itemReadAloud: 'Read-aloud message',
  itemReadAloudHint: 'The stream reads your message aloud.',
  itemSuggestPoll: 'Suggest a poll',
  itemSuggestPollHint: 'The host can run it. If they do not, your points come back.',
  itemReward: 'Channel rewards',
  itemRewardHint: "Redeem one of the host's rewards.",
  itemBounty: 'Bounty',
  itemBountyHint: 'Pool points on a challenge. The host gets them when it is done, otherwise they come back.',
  itemStickers: 'Unlock stickers',
  itemStickersHint: "Big stickers in this channel's chat, for good.",
  stickersOwned: 'You have these stickers.',
  unavailable: 'Not available right now.',
  messagePlaceholder: 'Your message (max {max} characters)',
  questionPlaceholder: 'Your question',
  optionPlaceholder: 'Option {n}',
  addOption: '+ Add option',
  removeOption: 'Remove option {n}',
  rewardInputPlaceholder: 'What should the host know?',
  noRewards: 'This channel has no rewards yet.',
  rewardCostTag: '{points} points',
  rewardAsksText: 'Asks for text',
  bountyOpen: 'Open bounties',
  bountyNew: 'Start a bounty',
  bountyTextPlaceholder: 'The challenge, e.g. sing a song',
  bountyAmount: 'Points',
  bountyMin: 'At least {min} points.',
  bountyBackers: '{points} points from {count} backers',
  buy: 'Buy for {points} points',
  buying: 'Buying...',
  confirming: 'Confirming your points...',
  back: 'Back',
  close: 'Close',
  done: 'Done',
  successHighlight: 'Your message is highlighted.',
  successReadAloud: 'Your message is on its way to the stream.',
  successSuggestPoll: 'Sent to the host. If they do not run it, your points come back.',
  successReward: 'Redeemed. The host sees it in their queue.',
  successBounty: 'Your points are on the bounty.',
  successStickers: 'Stickers unlocked. Find them in the chat emoji tray.',
  errSignIn: 'Sign in to use your points.',
  errText: 'Write your message.',
  errQuestion: 'Ask a question and give 2 to 4 different options.',
  errAmount: 'Enter at least {min} points.',
  errBalance: 'You only have {points} points.',
  errFailed: 'That did not work. Try again.',
  tabRewards: 'Rewards',
  tabBounties: 'Bounties',
  suggestionsTitle: 'Suggested by viewers',
  suggestionsEmpty: 'No suggestions yet. Viewers can suggest a poll with their points.',
  suggestionFrom: 'from @{name}',
  suggestionTimer: 'Timer',
  suggestionRun: 'Run',
  suggestionDecline: 'Decline',
  rewardsIntro: 'Rewards your viewers redeem with points. You decide what they are.',
  queueTitle: 'Redeemed',
  queueEmpty: 'Nothing waiting.',
  queueLine: '@{name}: {title}',
  queueDone: 'Done',
  queueRefund: 'Refund',
  rewardsTitle: 'Your rewards',
  rewardName: 'Name',
  rewardNamePlaceholder: 'Pick the next game',
  rewardCost: 'Cost (points)',
  rewardPrompt: 'Asks for text',
  rewardEnabled: 'On',
  rewardRemove: 'Remove',
  rewardAdd: '+ Add a reward',
  rewardsMax: 'At most {max} rewards.',
  rewardsSave: 'Save rewards',
  rewardsSaved: 'Saved',
  saving: 'Saving...',
  errRewardName: 'Every reward needs a name.',
  errRewardCost: 'A reward costs {min} to {max} points.',
  bountiesIntro: 'Viewers pool points on challenges. Done pays you every pledge, Decline gives them back.',
  bountiesEmpty: 'No open bounties.',
  bountyBy: 'started by @{name}',
  bountyDone: 'Done',
  bountyDecline: 'Decline',
  loading: 'Loading...',
  readAloudTitle: 'Read aloud',
  readAloudAlert: '@{name}: {message}',
  readAloudSpeech: '{name} says: {message}',
  readAloudToggle: 'Read-aloud messages paid with points',
  readAloudHint: 'Read aloud like a boost, whatever the minimum. Needs "Read boosts aloud".',
  readAloudLocalOnly: 'Kept on this device only: this server does not store the setting yet, so viewers can still buy read-aloud messages.',
  buyMinutes: '+{minutes} min for {points} points',
  buyMinutesBusy: 'Adding time...',
  minutesAdded: '{minutes} more minutes for today.',
};

/** Defaults plus the integrator's text; an empty or missing entry keeps English. */
export function shopLabels(labels?: Partial<ShopLabels>): ShopLabels {
  if (!labels) return DEFAULT_SHOP_LABELS;
  const out = { ...DEFAULT_SHOP_LABELS };
  for (const [k, v] of Object.entries(labels)) {
    if (typeof v === 'string' && v) (out as unknown as Record<string, string>)[k] = v;
  }
  return out;
}

/** 12,500 */
export const pointsText = (n: number) => Math.round(n).toLocaleString('en-US');
