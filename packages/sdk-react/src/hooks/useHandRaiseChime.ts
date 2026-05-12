import { useCallback, useEffect, useRef } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import type { HandRaiseEvent } from '@snapie/hangouts-core';

const TOPIC = 'hand-raise';
const THROTTLE_MS = 2_000;

/**
 * Synthesize a soft two-note ascending chime (C6 → E6) via Web Audio API.
 * No bundled audio asset — keeps the SDK tarball clean and dodges file
 * path resolution in consumer bundlers. The chime is ~0.3s and peaks at
 * the supplied volume (0–1).
 *
 * Notes:
 * - AudioContext may be in 'suspended' state if the browser hasn't
 *   received a recent user gesture. We attempt resume() but swallow any
 *   rejection — a missed chime is fine, a thrown error inside a message
 *   handler is not.
 * - We create a fresh AudioContext per chime so we don't hold a long-
 *   lived context open. The OS/browser will GC it shortly after the
 *   stop() callbacks fire.
 */
function playHandRaiseChime(volume: number): void {
  const Ctx = (typeof window !== 'undefined'
    ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined);
  if (!Ctx) return;

  let ctx: AudioContext;
  try { ctx = new Ctx(); } catch { return; }

  const playNote = (freq: number, startOffset: number, duration: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime + startOffset;
    // Attack: 5 ms ramp up to volume; decay: exponential to silence.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.start(start);
    osc.stop(start + duration);
  };

  void ctx.resume().catch(() => { /* autoplay blocked — chime swallowed */ });
  playNote(1046.5, 0,    0.30); // C6
  playNote(1318.5, 0.08, 0.30); // E6 — slight offset for arpeggio feel

  // Close the context after both notes finish to release audio resources.
  setTimeout(() => { void ctx.close().catch(() => { /* ignore */ }); }, 600);
}

/**
 * Plays a subtle chime on the local speakers whenever any *other*
 * participant raises their hand. Intended to give hosts an unmissable
 * audio cue without polluting the recording (this is local-only — the
 * sound is not pushed back into the LiveKit publish path, and the
 * egress browser does not mount <HangoutsRoom>).
 *
 * Guardrails:
 * - Skip lowering events (only `raised: true` triggers a chime).
 * - Skip the local participant's own raises.
 * - Throttle to one chime per THROTTLE_MS to handle bursts of hands.
 * - All audio failures (suspended context, autoplay block) swallowed.
 */
export function useHandRaiseChime(enabled: boolean, volume = 0.3): void {
  const { localParticipant } = useLocalParticipant();
  const lastChimeAtRef = useRef(0);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    if (!enabled) return;
    let event: HandRaiseEvent;
    try {
      event = JSON.parse(new TextDecoder().decode(msg.payload)) as HandRaiseEvent;
    } catch {
      return;
    }
    if (event.type !== 'hand_raise') return;
    if (!event.raised) return;
    if (event.identity === localParticipant?.identity) return;

    const now = Date.now();
    if (now - lastChimeAtRef.current < THROTTLE_MS) return;
    lastChimeAtRef.current = now;

    playHandRaiseChime(volume);
  }, [enabled, volume, localParticipant?.identity]);

  useDataChannel(TOPIC, onMessage);

  // Reset the throttle when the listener mounts/unmounts so a remount
  // (e.g. host transfer flow) doesn't carry over a stale "just chimed"
  // window from the previous instance.
  useEffect(() => {
    lastChimeAtRef.current = 0;
  }, []);
}
