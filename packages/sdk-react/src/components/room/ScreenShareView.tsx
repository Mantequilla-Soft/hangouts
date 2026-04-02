import { useRef, useCallback } from 'react';
import { useTracks, VideoTrack } from '@livekit/components-react';
import { Track } from 'livekit-client';

export function ScreenShareView() {
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;

    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen();
    }
  }, []);

  if (screenShareTracks.length === 0) return null;

  const trackRef = screenShareTracks[0];

  return (
    <div className="hh-screen-share" ref={containerRef}>
      <VideoTrack trackRef={trackRef} className="hh-screen-share__video" />
      <div className="hh-screen-share__bar">
        <span className="hh-screen-share__label">
          {trackRef.participant.identity} is sharing their screen
        </span>
        <button
          className="hh-screen-share__fullscreen"
          onClick={toggleFullscreen}
          title="Toggle fullscreen"
        >
          ⛶
        </button>
      </div>
    </div>
  );
}
