import { FREE_STREAM_CAP_LABEL, PRO_STREAM_CAP_LABEL } from './streamLimits.js';

export interface ProPerk {
  icon: string;
  /** Short label — a few words. This is what someone scanning the page reads. */
  title: string;
  /** One line of detail, shown under the title. Say what the FREE tier gets, so
   *  the offer is concrete rather than just "better". */
  body: string;
}

export interface ProPerkGroup {
  id: string;
  heading: string;
  /** Shown on the group's tab tile. */
  icon: string;
  perks: ProPerk[];
}

/**
 * Streaming perks — the single source for BOTH the upsell dialog (shown next to
 * the locked stream options) and the plans page. Defining them once is
 * deliberate: the two surfaces previously listed different things, so a host
 * could be promised something on one screen and not see it on the other.
 *
 * Only perks that are ACTUALLY enforced belong here, so the offer stays honest:
 *  - stream length, quality, watermark and the recording/clip checkboxes are
 *    gated in this SDK (StandaloneStudio + CreateRoomDialog)
 *  - RTMP restream and the DVR clip endpoint are gated server-side
 *    (streaming.ts / dvr.ts both 402 for non-premium)
 *
 * Durations come from `streamLimits`, never typed out, so changing a cap cannot
 * leave this advertising the old number.
 */
export const STREAM_PERKS: ProPerk[] = [
  { icon: '⏳', title: 'Longer streams', body: `Up to ${PRO_STREAM_CAP_LABEL} instead of ${FREE_STREAM_CAP_LABEL}.` },
  { icon: '🎬', title: 'Recordings & VODs', body: 'Publish the replay as a video, or download it.' },
  { icon: '✂️', title: 'Viewer clips', body: 'Viewers can save the last 30 seconds while you are live.' },
  { icon: '📡', title: 'RTMP restream', body: 'Broadcast to other platforms at the same time.' },
  { icon: '📶', title: 'High quality', body: 'Free streams are capped at medium.' },
  { icon: '🚫', title: 'No watermark', body: 'Free streams carry a small platform mark.' },
];

export const UPLOAD_PERKS: ProPerk[] = [
  { icon: '🎞️', title: '1080p encoding', body: 'Free uploads stay at standard resolution.' },
  { icon: '⚡', title: 'Priority queue', body: 'Your uploads are encoded first.' },
  { icon: '📦', title: 'Higher upload limits', body: 'Bigger files, and more of them.' },
];

/** Everything that isn't uploads or streaming. Kept as one group on purpose:
 *  as separate Earnings and Reach tabs they held a single perk each, which left
 *  most of the fixed-height panel empty. */
export const BONUS_PERKS: ProPerk[] = [
  {
    icon: '💰',
    title: 'Keep 100% of your rewards',
    body: 'The standard 11% platform + encoder fee is waived on your posts.',
  },
  { icon: '🌍', title: '15 translation languages', body: 'Five on the free tier, and Pro jobs run first.' },
];

/**
 * The plans-page perk list, grouped into tabs so the column stays short instead
 * of running the full height of the page. Uploads leads: it is what most people
 * on the wallet page are subscribing for. The stream upsell overrides this with
 * `initialGroupId="streaming"` so "See plans" opens on what was just read.
 */
export const PRO_PERK_GROUPS: ProPerkGroup[] = [
  { id: 'uploads', heading: 'Uploads', icon: '⬆️', perks: UPLOAD_PERKS },
  { id: 'streaming', heading: 'Live streaming', icon: '🎥', perks: STREAM_PERKS },
  { id: 'bonus', heading: 'Bonus', icon: '💎', perks: BONUS_PERKS },
];

/** Shown under the groups — not a perk, so it doesn't get a bullet of its own. */
export const PRO_PERKS_FOOTNOTE = 'New benefits are added to your plan automatically.';

/** Flat one-line form, for integrators still passing/expecting plain strings. */
export function flattenPerks(groups: ProPerkGroup[] = PRO_PERK_GROUPS): string[] {
  return groups.flatMap((g) => g.perks.map((p) => `${p.title} — ${p.body}`));
}
