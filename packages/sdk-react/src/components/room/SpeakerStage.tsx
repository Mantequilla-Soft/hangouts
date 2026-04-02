import { useState } from 'react';
import { useParticipants, useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { getParticipantRole } from '../../hooks/useParticipantRole.js';
import { ParticipantTile } from './ParticipantTile.js';
import { ScreenShareView } from './ScreenShareView.js';

export interface SpeakerStageProps {
  hostIdentity: string | null;
  isCurrentUserHost: boolean;
  roomName: string;
  videoEnabled?: boolean;
}

export function SpeakerStage({ hostIdentity, isCurrentUserHost, roomName, videoEnabled = false }: SpeakerStageProps) {
  const participants = useParticipants();
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);
  const hasScreenShare = videoEnabled && screenShareTracks.length > 0;

  const speakers = participants.filter(
    (p) => p.permissions?.canPublish,
  );

  // Split speakers into video-on and audio-only
  const speakersWithVideo = videoEnabled
    ? speakers.filter((p) => {
        const cam = p.getTrackPublication(Track.Source.Camera);
        return cam?.track && !cam.isMuted;
      })
    : [];
  const speakersAudioOnly = videoEnabled
    ? speakers.filter((p) => {
        const cam = p.getTrackPublication(Track.Source.Camera);
        return !cam?.track || cam.isMuted;
      })
    : speakers;

  return (
    <div className="hh-stage">
      {videoEnabled && <ScreenShareView />}
      <div className="hh-stage__label">Speakers</div>

      {speakersWithVideo.length > 0 && (
        <div className={`hh-stage__video-row ${hasScreenShare ? 'hh-stage__video-row--compact' : ''}`}>
          {speakersWithVideo.map((p) => (
            <ParticipantTile
              key={p.identity}
              participant={p}
              role={getParticipantRole(p, hostIdentity)}
              isCurrentUserHost={isCurrentUserHost}
              roomName={roomName}
              isPanelOpen={activePanel === p.identity}
              onTogglePanel={() => setActivePanel(activePanel === p.identity ? null : p.identity)}
              videoEnabled={videoEnabled}
              size="large"
            />
          ))}
        </div>
      )}

      {speakersAudioOnly.length > 0 && (
        <div className={`hh-stage__grid ${hasScreenShare ? 'hh-stage__grid--compact' : ''}`}>
          {speakersAudioOnly.map((p) => (
            <ParticipantTile
              key={p.identity}
              participant={p}
              role={getParticipantRole(p, hostIdentity)}
              isCurrentUserHost={isCurrentUserHost}
              roomName={roomName}
              isPanelOpen={activePanel === p.identity}
              onTogglePanel={() => setActivePanel(activePanel === p.identity ? null : p.identity)}
              videoEnabled={videoEnabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
