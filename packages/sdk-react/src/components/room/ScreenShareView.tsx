import { useTracks, VideoTrack } from '@livekit/components-react';
import { Track } from 'livekit-client';

export function ScreenShareView() {
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);

  if (screenShareTracks.length === 0) return null;

  const trackRef = screenShareTracks[0];

  return (
    <div className="hh-screen-share">
      <VideoTrack trackRef={trackRef} className="hh-screen-share__video" />
      <div className="hh-screen-share__label">
        {trackRef.participant.identity} is sharing their screen
      </div>
    </div>
  );
}
