import { useEffect, useRef } from 'react';
import { boostSpeechText, boostTier, planBoostAlert, type ResolvedAlertSettings } from '../lib/boostGoals.js';
import { playBoostChime, speakBoost } from '../lib/boostChime.js';
import type { BoostEvent } from './useBoosts.js';

export interface BoostAlertOptions {
  /** What is read aloud: {name} {amount} {asset} {message}. */
  speechTemplate?: string;
  /** BCP-47 language for the speech voice; the browser's default otherwise. */
  speechLang?: string;
  /** Turn every alert off (e.g. a surface that only shows the list). */
  muted?: boolean;
}

/**
 * Ids already alerted, at module level like BoostOverlay's bookkeeping: the
 * boost list outlives any one component (context + sessionStorage), and a
 * remount must not chime every boost again.
 */
const alerted = new Set<string>();

/**
 * Chime and (optionally) read aloud each NEW boost, per the host's alert
 * settings. The list present on the first run is taken as already heard: it
 * is what sessionStorage restored after a reload, not news.
 */
export function useBoostAlerts(
  boosts: readonly BoostEvent[],
  settings: ResolvedAlertSettings,
  options: BoostAlertOptions = {},
): void {
  const primed = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      for (const b of boosts) alerted.add(b.id);
      return;
    }
    const now = Date.now();
    for (const b of boosts) {
      if (alerted.has(b.id)) continue;
      alerted.add(b.id);
      if (optionsRef.current.muted) continue;
      const plan = planBoostAlert(b, settingsRef.current, now);
      if (plan.chime) playBoostChime('boost', boostTier(b.usdAmount).level);
      if (plan.speak) speakBoost(boostSpeechText(b, optionsRef.current.speechTemplate), optionsRef.current.speechLang);
    }
  }, [boosts]);
}
