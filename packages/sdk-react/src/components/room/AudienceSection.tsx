import { useParticipants } from '@livekit/components-react';
import { getParticipantRole } from '../../hooks/useParticipantRole.js';
import { useHandRaise } from '../../hooks/useHandRaise.js';
import { ParticipantTile } from './ParticipantTile.js';

export interface AudienceSectionProps {
  hostIdentity: string | null;
  isCurrentUserHost: boolean;
  roomName: string;
}

export function AudienceSection({ hostIdentity, isCurrentUserHost, roomName }: AudienceSectionProps) {
  const participants = useParticipants();
  const { raisedHands } = useHandRaise();

  const listeners = participants.filter(
    (p) => !p.permissions?.canPublish,
  );

  if (listeners.length === 0) return null;

  return (
    <div className="hh-audience">
      <div className="hh-audience__label">Listeners ({listeners.length})</div>
      <div className="hh-audience__grid">
        {listeners.map((p) => (
          <ParticipantTile
            key={p.identity}
            participant={p}
            role={getParticipantRole(p, hostIdentity)}
            isHandRaised={raisedHands.has(p.identity)}
            isCurrentUserHost={isCurrentUserHost}
            roomName={roomName}
            size="small"
          />
        ))}
      </div>
    </div>
  );
}
