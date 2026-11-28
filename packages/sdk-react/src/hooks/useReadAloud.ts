import { useEffect, useRef, useState } from 'react';
import { speakBoost } from '../lib/boostChime.js';
import { readReadAloudPacket } from '../lib/dataTrust.js';
import { fillLabel } from '../lib/liveLabels.js';
import { planReadAloud, type ReadAloudEvent } from '../lib/pointsShop.js';
import { DEFAULT_SHOP_LABELS } from '../lib/shopLabels.js';
import { useServerTopic } from './useShopHost.js';

export interface ReadAloudOptions {
  /** What is spoken: {name} {message}. Default ShopLabels.readAloudSpeech. */
  speechTemplate?: string;
  /** BCP-47 language for the voice; the browser's default otherwise. */
  speechLang?: string;
  /** Show them, never speak. */
  muted?: boolean;
  /** How long one stays in the returned list (default 20 s). */
  showMs?: number;
}

/** Ids already spoken, at module level like useBoostAlerts: a remount, or a
 *  second surface in the same page, must not read a message twice. */
const spoken = new Set<string>();

/**
 * Read-aloud messages a viewer bought in the points shop, from the `boost`
 * topic (server only, lib/dataTrust.ts). Each new one is spoken with the
 * boost voice when the host reads boosts aloud and has not switched these
 * off (planReadAloud), and stays in the returned list for a few seconds so
 * the studio can show it.
 */
export function useReadAloud(
  settings: { tts: boolean; readAloud?: boolean },
  options: ReadAloudOptions = {},
): ReadAloudEvent[] {
  const [recent, setRecent] = useState<ReadAloudEvent[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useServerTopic('boost', (payload, from) => {
    const event = readReadAloudPacket(payload, from);
    if (!event || spoken.has(event.id)) return;
    spoken.add(event.id);
    const o = optionsRef.current;
    if (!o.muted && planReadAloud(event, settingsRef.current)) {
      speakBoost(fillLabel(o.speechTemplate ?? DEFAULT_SHOP_LABELS.readAloudSpeech, { name: event.sender, message: event.message }), o.speechLang);
    }
    setRecent((l) => [...l.filter((e) => e.id !== event.id), event].slice(-3));
  });

  // Each one goes after a while.
  const first = recent[0];
  useEffect(() => {
    if (!first) return undefined;
    const t = setTimeout(() => setRecent((l) => l.filter((e) => e.id !== first.id)), optionsRef.current.showMs ?? 20_000);
    return () => clearTimeout(t);
  }, [first]);

  return recent;
}

/** Test helper. */
export function __resetReadAloud(): void { spoken.clear(); }
