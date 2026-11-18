import { useEffect, useRef } from 'react';
import { Track, type RemoteTrackPublication, type TrackPublication } from 'livekit-client';

/**
 * Notices a browser that cannot show an H.264 video track.
 *
 * OBS streams are forwarded as OBS encodes them, in H.264, without re-encoding
 * on the server (that cost about one CPU core per stream). Nearly every browser
 * plays H.264, but some cannot: Firefox before (or without) its OpenH264
 * add-on, LibreWolf and Tor Browser, Chromium builds without the licensed
 * codecs. Their own codec lists can claim H.264 anyway, so asking up front is
 * no use. What they do instead is show nothing: the SFU cannot bind the track
 * ("codec is not supported by remote"), or bytes arrive and no frame is ever
 * decoded. So we watch: an H.264 track that stays without a single decoded
 * frame for UNDECODABLE_MS of visible, unpaused time is one this browser can't
 * show, and the caller switches to something it can (HLS for a viewer, a
 * re-encoded address for the studio).
 */

/** Visible time without a decoded frame before giving up on the track. Above
 *  the 1-2 s keyframe interval the OBS guide asks for, with room for a slow
 *  first keyframe. */
export const UNDECODABLE_MS = 12_000;

/** One look at the track, once a second. */
export interface DecodeSample {
  /** The publication is H.264. Others are never judged: every browser decodes VP8. */
  h264: boolean;
  /** The page is visible, the publication unmuted and the stream not paused by
   *  the SFU (adaptive stream pauses a video nobody can see). */
  eligible: boolean;
  /** Frames decoded so far; 0 while not subscribed. */
  framesDecoded: number;
}

export interface DecodeWatch {
  /** Visible, eligible time so far without a frame. */
  waitedMs: number;
  /** Frames arrived: this track is fine, stop judging it. */
  ok: boolean;
  /** Already reported. */
  fired: boolean;
}

export const INITIAL_DECODE_WATCH: DecodeWatch = { waitedMs: 0, ok: false, fired: false };

/** Advance the watch by one sample `stepMs` after the last. `fire` is true on
 *  the one step that decides the track can't be shown. */
export function stepDecodeWatch(w: DecodeWatch, s: DecodeSample, stepMs: number, limitMs = UNDECODABLE_MS): DecodeWatch & { fire: boolean } {
  if (w.ok || w.fired) return { ...w, fire: false };
  if (s.framesDecoded > 0) return { ...w, ok: true, fire: false };
  if (!s.h264 || !s.eligible) return { ...w, fire: false };
  const waitedMs = w.waitedMs + stepMs;
  if (waitedMs >= limitMs) return { waitedMs, ok: false, fired: true, fire: true };
  return { waitedMs, ok: false, fired: false, fire: false };
}

export function isH264(pub: Pick<TrackPublication, 'mimeType'> | null | undefined): boolean {
  return /h264/i.test(pub?.mimeType ?? '');
}

/** Read one sample from a live publication. */
export async function sampleDecode(pub: RemoteTrackPublication): Promise<DecodeSample> {
  const track = pub.videoTrack as (RemoteTrackPublication['videoTrack'] & {
    getReceiverStats?: () => Promise<{ framesDecoded?: number } | undefined>;
  }) | undefined;
  let framesDecoded = 0;
  try { framesDecoded = (await track?.getReceiverStats?.())?.framesDecoded ?? 0; } catch { /* no stats yet */ }
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  const paused = track?.streamState === Track.StreamState.Paused;
  return { h264: isH264(pub), eligible: visible && !pub.isMuted && !paused, framesDecoded };
}

/**
 * Calls `onUndecodable` once when `pub` (an H.264 video) can't be shown here.
 * Starts over for a new publication. Pass null to stop watching.
 */
export function useUndecodableVideo(
  pub: RemoteTrackPublication | null | undefined,
  onUndecodable: () => void,
  limitMs = UNDECODABLE_MS,
): void {
  const cb = useRef(onUndecodable);
  cb.current = onUndecodable;
  const sid = pub?.trackSid ?? null;
  useEffect(() => {
    if (!pub) return undefined;
    let watch: DecodeWatch = INITIAL_DECODE_WATCH;
    let stopped = false;
    const STEP = 1000;
    const timer = setInterval(() => {
      void sampleDecode(pub).then((s) => {
        if (stopped) return;
        const next = stepDecodeWatch(watch, s, STEP, limitMs);
        watch = next;
        if (next.ok || next.fired) clearInterval(timer);
        if (next.fire) cb.current();
      });
    }, STEP);
    return () => { stopped = true; clearInterval(timer); };
    // A new track (sid) starts a new watch; the publication object itself may
    // be re-created by the room hooks for the same track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, limitMs]);
}
