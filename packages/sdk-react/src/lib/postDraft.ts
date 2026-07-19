/**
 * The host's last-used stream post details, remembered in the browser.
 *
 * Shared by BOTH the create-room dialog and the studio's post composer, so
 * whatever you typed last time comes back pre-filled wherever you set it —
 * and edits made in the studio carry over to the next room you create.
 */
export const POST_DRAFT_KEY = 'hh-studio-post-draft';

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

export function readPostDraft(): PostDraft {
  try {
    const raw = window.localStorage.getItem(POST_DRAFT_KEY);
    return raw ? (JSON.parse(raw) as PostDraft) : {};
  } catch {
    return {};
  }
}

/** Merge a partial draft over what's stored. Never throws (storage may be
 *  full, disabled, or blocked in a privacy context). */
export function writePostDraft(patch: PostDraft): void {
  try {
    const next = { ...readPostDraft(), ...patch };
    window.localStorage.setItem(POST_DRAFT_KEY, JSON.stringify(next));
  } catch {
    /* non-critical */
  }
}
