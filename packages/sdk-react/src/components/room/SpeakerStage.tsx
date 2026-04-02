import { useState } from 'react';
import { useParticipants } from '@livekit/components-react';
import { getParticipantRole } from '../../hooks/useParticipantRole.js';
import { ParticipantTile } from './ParticipantTile.js';

export interface SpeakerStageProps {
  hostIdentity: string | null;
  isCurrentUserHost: boolean;
  roomName: string;
}

export function SpeakerStage({ hostIdentity, isCurrentUserHost, roomName }: SpeakerStageProps) {
  const participants = useParticipants();
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const speakers = participants.filter(
    (p) => p.permissions?.canPublish,
  );

  return (
    <div className="hh-stage">
      <div className="hh-stage__label">Speakers</div>
      <div className="hh-stage__grid">
        {speakers.map((p) => (
          <ParticipantTile
            key={p.identity}
            participant={p}
            role={getParticipantRole(p, hostIdentity)}
            isCurrentUserHost={isCurrentUserHost}
            roomName={roomName}
            isPanelOpen={activePanel === p.identity}
            onTogglePanel={() => setActivePanel(activePanel === p.identity ? null : p.identity)}
          />
        ))}
      </div>
    </div>
  );
}
