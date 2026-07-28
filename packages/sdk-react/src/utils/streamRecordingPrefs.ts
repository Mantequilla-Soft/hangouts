/**
 * The host's recording preferences for a standalone stream.
 *
 * Set in TWO places — the create-room dialog (so the choice is made before the
 * studio even opens) and the studio's post tab (so it can still be changed
 * right up until Start) — which is why they live here rather than in either
 * component. Both read and write the same localStorage keys, so whichever the
 * host touched last wins and the studio always opens showing their real choice.
 */

/** "Replace the stream with a video when it ends." */
export const AUTO_VOD_KEY = 'hh-studio-auto-vod';

/** "Record the session and download it when it ends." */
export const AUTO_DL_KEY = 'hh-studio-auto-download';

/** "Let viewers clip the last 30 seconds" (Pro). Defaults ON (pass def=true). */
export const ALLOW_CLIPS_KEY = 'hh-studio-allow-clips';

export function readPref(key: string, def = false): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? def : v === '1';
  } catch { return def; }
}

export function writePref(key: string, value: boolean): void {
  try { window.localStorage.setItem(key, value ? '1' : '0'); } catch { /* non-critical */ }
}
