import { useCallback, useEffect, useRef, useState } from 'react';
import { Track, type LocalParticipant } from 'livekit-client';
import { useHangoutsContext } from '../context/HangoutsContext.js';
import { VerticalOutput } from '../lib/verticalOutput.js';
import {
  STUDIO_VERTICAL_TRACK, readVerticalPrefs, writeVerticalPrefs, verticalBitrate,
  type VerticalFollow, type VerticalMode, type VerticalPrefs,
} from '../lib/verticalCrop.js';

/** How often a moving (following) crop is reported to the room metadata. */
export const VERTICAL_META_EVERY_MS = 3000;
/** Smallest move worth a metadata write. */
const META_MIN_MOVE = 0.015;

export interface VerticalOutputApi {
  prefs: VerticalPrefs;
  /** The phone version applies here (desktop, landscape studio). */
  available: boolean;
  setMode: (m: VerticalMode) => void;
  setFollow: (f: VerticalFollow) => void;
  /** Place the crop by hand (the preview box). Stops following. */
  setManual: (x: number) => void;
  /** Read by the compositor and the preview box every frame. */
  output: VerticalOutput;
  /** The vertical video is being published. */
  publishing: boolean;
  error: string;
}

/**
 * The studio side of H19: the host's phone version setting, publishing the
 * vertical track while it is on, and telling the room where the crop is
 * (`PATCH /rooms/:name/vertical`), so viewers without the track and clips can
 * use the same framing.
 */
export function useVerticalOutput(opts: {
  roomName: string;
  localParticipant: LocalParticipant | undefined;
  /** The program has been published (the room connection is up). */
  published: boolean;
  /** Desktop + landscape: a phone studio is already vertical. */
  available: boolean;
  programHeight: number;
  programMaxBitrate: number;
  degradePref: RTCDegradationPreference;
}): VerticalOutputApi {
  const { roomName, localParticipant, published, available, programHeight, programMaxBitrate, degradePref } = opts;
  const { username, apiBaseUrl, apiClient } = useHangoutsContext();
  const [prefs, setPrefs] = useState<VerticalPrefs>(() => readVerticalPrefs(username));
  const outputRef = useRef<VerticalOutput | null>(null);
  if (!outputRef.current) outputRef.current = new VerticalOutput();
  const output = outputRef.current;
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');

  const loadedFor = useRef(username);
  useEffect(() => {
    if (!username || loadedFor.current === username) return;
    loadedFor.current = username;
    setPrefs(readVerticalPrefs(username));
  }, [username]);
  useEffect(() => { if (username) writeVerticalPrefs(username, prefs); }, [username, prefs]);

  const mode: VerticalMode = available ? prefs.mode : 'off';
  output.mode = mode;
  output.follow = prefs.follow;
  output.manual = prefs.x;

  const setMode = useCallback((m: VerticalMode) => setPrefs((p) => ({ ...p, mode: m })), []);
  const setFollow = useCallback((f: VerticalFollow) => setPrefs((p) => ({ ...p, follow: f })), []);
  const setManual = useCallback((x: number) => {
    const v = Math.min(1, Math.max(0, x));
    output.manual = v;
    output.follow = 'manual';
    setPrefs((p) => ({ ...p, x: v, follow: 'manual' }));
  }, [output]);

  // ---- publish the vertical track while the mode asks for it --------------
  const wantTrack = mode === 'track' && published && !!localParticipant;
  useEffect(() => {
    if (!wantTrack || !localParticipant) return undefined;
    let cancelled = false;
    let pubTrack: MediaStreamTrack | null = null;
    (async () => {
      const track = output.track(programHeight);
      if (!track) { setError('This browser cannot make the phone version.'); return; }
      try {
        await localParticipant.publishTrack(track, {
          name: STUDIO_VERTICAL_TRACK,
          // Unknown, not Camera: nothing that looks for "the camera" (the
          // watch page's player, the recorder, ParticipantTile) may pick the
          // phone crop by accident.
          source: Track.Source.Unknown,
          // One layer: a ~400x720 picture gains little from simulcast, and a
          // third and fourth encode on the host's machine costs a lot.
          simulcast: false,
          videoEncoding: { maxBitrate: verticalBitrate(programMaxBitrate), maxFramerate: 30 },
          degradationPreference: degradePref,
        });
        if (cancelled) { try { await localParticipant.unpublishTrack(track, true); } catch { /* gone */ } return; }
        pubTrack = track;
        setPublishing(true);
        setError('');
      } catch (err) {
        if (!cancelled) setError(`Could not send the phone version: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
      setPublishing(false);
      if (pubTrack) { void localParticipant.unpublishTrack(pubTrack, true).catch(() => { /* gone */ }); }
      output.release();
    };
    // degradePref is applied at publish only: changing it mid-stream is rare
    // and the program's own preference change does not republish either.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantTrack, localParticipant, programHeight, programMaxBitrate, output]);

  // ---- tell the room where the crop is ------------------------------------
  const lastSentRef = useRef<{ key: string; x: number } | null>(null);
  const send = useCallback(async (force: boolean) => {
    if (!roomName || !apiBaseUrl) return;
    const on = mode !== 'off';
    // Nothing was ever reported and it is off: no write at all.
    if (!on && !lastSentRef.current) return;
    const body = { on, x: Math.round(output.center * 1000) / 1000, w: Math.round(output.widthFrac * 1000) / 1000, follow: output.follow, track: mode === 'track' };
    const key = `${body.on}|${body.follow}|${body.track}|${body.w}`;
    const last = lastSentRef.current;
    if (!force && last && last.key === key && Math.abs(last.x - body.x) < META_MIN_MOVE) return;
    lastSentRef.current = { key, x: body.x };
    try {
      const token = apiClient.getSessionToken?.();
      await fetch(`${apiBaseUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomName)}/vertical`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch { /* best effort: viewers fall back to the centre */ }
  }, [roomName, apiBaseUrl, apiClient, mode, output]);

  useEffect(() => {
    if (!published) return undefined;
    // Let the compositor take a step first so the centre is the real one.
    const first = window.setTimeout(() => { void send(false); }, 400);
    if (mode === 'off') return () => window.clearTimeout(first);
    const t = window.setInterval(() => { void send(false); }, VERTICAL_META_EVERY_MS);
    return () => { window.clearTimeout(first); window.clearInterval(t); };
  }, [published, mode, prefs.follow, prefs.x, send]);

  return { prefs, available, setMode, setFollow, setManual, output, publishing, error };
}
