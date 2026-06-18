import { useCallback, useState } from 'react';

const STORAGE_KEY = 'hh-ptt-preference';

function readStoredPreference(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : raw === 'true';
  } catch {
    return null;
  }
}

export interface UsePttPreferenceResult {
  /** Whether push-to-talk mode is on for this user, on this device. */
  pttEnabled: boolean;
  /** Flip the user's personal preference and persist it. */
  togglePtt: () => void;
}

/**
 * Push-to-talk vs. mute-toggle is a personal preference, not a room setting —
 * one person liking hold-to-talk shouldn't force it (or forbid it) for
 * everyone else in the room. Stored in localStorage so it's per-device/user
 * and carries across every room, independent of whatever `defaultValue` the
 * embedding app passes in for first-time visitors.
 */
export function usePttPreference(defaultValue: boolean): UsePttPreferenceResult {
  const [pttEnabled, setPttEnabled] = useState(() => readStoredPreference() ?? defaultValue);

  const togglePtt = useCallback(() => {
    setPttEnabled((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(STORAGE_KEY, String(next)); }
      catch { /* private mode / storage disabled — preference just won't persist */ }
      return next;
    });
  }, []);

  return { pttEnabled, togglePtt };
}
