/**
 * The host's last-used stream post details, remembered in the browser.
 *
 * Shared by BOTH the create-room dialog and the studio's post composer, so
 * whatever you typed last time comes back pre-filled wherever you set it —
 * and edits made in the studio carry over to the next room you create.
 */
export const POST_DRAFT_KEY = 'hh-studio-post-draft';

/** Room mode. Drafts are stored PER MODE — see draftKey below. */
export type DraftMode = 'conference' | 'standalone';

/**
 * A conference and a stream are different kinds of thing, and their setups have
 * nothing to do with each other: a group chat is typically unlisted with no
 * Hive announcement, a stream is public and announced. Sharing one draft meant
 * creating one clobbered the other's defaults, so each mode keeps its own.
 *
 * The unsuffixed key stays the STANDALONE draft: the studio's post composer
 * reads and writes it directly, and streams are what it has always held.
 */
export function draftKey(mode?: DraftMode): string {
  return mode === 'conference' ? `${POST_DRAFT_KEY}-conference` : POST_DRAFT_KEY;
}

export interface PostDraft {
  title?: string;
  description?: string;
  /** Background / thumbnail image URL. */
  thumbnail?: string;
  tags?: string[];
  language?: string;
  /** Create-dialog only: last chosen room mode and access level. Both are
   *  shown as selected tiles when the dialog opens, so restoring them is
   *  visible rather than a hidden surprise. */
  mode?: 'conference' | 'standalone';
  visibility?: 'public' | 'hive-internal' | 'unlisted';
  /** Create-dialog boost setup. */
  boostEnabled?: boolean;
  minBoostUsd?: string;
  creatorPayoutAccount?: string;
  /** Create-dialog Hive announcement choice: whether to announce at all, and
   *  as a short snap or a full post. */
  notifyOnHive?: boolean;
  announceType?: 'snap' | 'post';
}

export function readPostDraft(mode?: DraftMode): PostDraft {
  try {
    const raw = window.localStorage.getItem(draftKey(mode));
    return raw ? (JSON.parse(raw) as PostDraft) : {};
  } catch {
    return {};
  }
}

/** Merge a partial draft over what's stored. Never throws (storage may be
 *  full, disabled, or blocked in a privacy context). */
export function writePostDraft(patch: PostDraft, mode?: DraftMode): void {
  try {
    const next = { ...readPostDraft(mode), ...patch };
    window.localStorage.setItem(draftKey(mode), JSON.stringify(next));
  } catch {
    /* non-critical */
  }
}
