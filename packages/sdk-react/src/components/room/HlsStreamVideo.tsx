import { useEffect, useRef, useState } from 'react';

/**
 * Plays a stream's live HLS playlist (backlog idea H1: viewers past the
 * server's HLS_VIEWER_THRESHOLD, or on a poor connection, get the picture over
 * HLS while chat keeps running over the room connection).
 *
 * The egress needs a few seconds to write the first segments, so the player
 * first waits for the playlist to exist. hls.js plays it where Media Source
 * Extensions exist (also Managed Media Source on newer iPhones); otherwise the
 * browser's own HLS (Safari). Fatal errors restart the whole cycle, and if no
 * playlist turns up within UNAVAILABLE_MS, `onUnavailable` lets the caller
 * rejoin (the server then hands out WebRTC while HLS is down).
 *
 * Renders the same `video.hh-stream-video__el` element the WebRTC picture
 * uses, so integrators' styling and crop code keep working.
 */
const POLL_MS = 1500;
const UNAVAILABLE_MS = 30_000;

type HlsModule = typeof import('hls.js');

export interface HlsStreamVideoProps {
  url: string;
  /** Silence the sound (e.g. while the page plays an ad over the stream). */
  muted?: boolean;
  /** Shown over the video until the first frame plays. */
  placeholder?: string;
  /** Label of the button shown when the browser blocked sound on autoplay. */
  startAudioLabel?: string;
  /** No playlist within 30 s, or playback impossible in this browser. */
  onUnavailable?: () => void;
}

export function HlsStreamVideo({
  url, muted = false, placeholder = 'Stream is starting…', startAudioLabel = 'Click to enable audio', onUnavailable,
}: HlsStreamVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // The browser refused to start with sound: we play muted until a tap.
  const [blockedSound, setBlockedSound] = useState(false);
  // Bumped on a fatal error to rebuild the player from scratch.
  const [attempt, setAttempt] = useState(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    let hls: InstanceType<HlsModule['default']> | null = null;
    const startedAt = Date.now();
    setPlaying(false);

    const play = () => {
      video.muted = mutedRef.current;
      video.play().catch((err: unknown) => {
        if (cancelled || (err as { name?: string })?.name !== 'NotAllowedError') return;
        // Autoplay with sound refused: start muted, offer a tap for sound.
        video.muted = true;
        setBlockedSound(true);
        video.play().catch(() => { /* still refused; the tap starts it */ });
      });
    };
    const restart = () => { if (!cancelled) setTimeout(() => { if (!cancelled) setAttempt((a) => a + 1); }, POLL_MS); };

    (async () => {
      // Wait for the playlist (the egress is still starting, or restarting).
      while (!cancelled) {
        const ok = await fetch(url, { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
        if (ok) break;
        if (Date.now() - startedAt > UNAVAILABLE_MS) { onUnavailableRef.current?.(); return; }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (cancelled) return;
      const mod: HlsModule | null = await import('hls.js').catch(() => null);
      if (cancelled) return;
      const Hls = mod?.default;
      if (Hls && Hls.isSupported()) {
        hls = new Hls({
          // 2 s segments: start two segments behind live and catch up a little
          // faster than real time when we fall behind, rather than jumping.
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 6,
          maxLiveSyncPlaybackRate: 1.1,
          backBufferLength: 30,
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || !hls) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
          hls.destroy();
          hls = null;
          restart();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.addEventListener('loadedmetadata', play, { once: true });
      } else {
        onUnavailableRef.current?.();
      }
    })();

    const onPlaying = () => setPlaying(true);
    const onError = () => { if (!hls) restart(); };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);
    return () => {
      cancelled = true;
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error', onError);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, attempt]);

  // Follow the caller's mute switch (an ad starting or ending) without
  // rebuilding the player.
  useEffect(() => {
    const video = videoRef.current;
    if (video && !blockedSound) video.muted = muted;
  }, [muted, blockedSound]);

  const enableSound = () => {
    const video = videoRef.current;
    if (!video) return;
    setBlockedSound(false);
    video.muted = mutedRef.current;
    video.play().catch(() => { /* ignore */ });
  };

  return (
    <>
      <video ref={videoRef} className="hh-stream-video__el" playsInline autoPlay data-delivery="hls" />
      {!playing && <div className="hh-stream-video__placeholder hh-stream-video__placeholder--over">{placeholder}</div>}
      {blockedSound && !muted && (
        <button type="button" className="hh-start-audio" onClick={enableSound}>{startAudioLabel}</button>
      )}
    </>
  );
}
