import { useState } from 'react';
import { useParticipants } from '@livekit/components-react';
import { getParticipantRole } from '../../hooks/useParticipantRole.js';
import { useHandRaise } from '../../hooks/useHandRaise.js';
import { usePermissionsTick } from '../../hooks/usePermissionsTick.js';
import { useLiveHost } from '../../hooks/useLiveHost.js';
import { ParticipantTile } from './ParticipantTile.js';

export interface AudienceSectionProps {
  /** Join-time host identity used as a fallback until live metadata loads.
   *  The live host is read reactively from room metadata so post-transfer
   *  host status takes effect without reconnecting. */
  hostIdentity: string | null;
  /** Ignored — kept for API compatibility. The component derives its own
   *  isCurrentUserHost from useLiveHost so the new host gets the ⋮ menu
   *  the instant the metadata change lands. */
  isCurrentUserHost?: boolean;
  roomName: string;
}

export function AudienceSection({ hostIdentity: fallbackHost, roomName }: AudienceSectionProps) {
  usePermissionsTick();
  const participants = useParticipants();
  const { raisedHands } = useHandRaise();
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const { hostIdentity, isCurrentUserHost } = useLiveHost(fallbackHost);

  const listeners = participants.filter(
    (p) => !p.permissions?.canPublish && !p.identity.startsWith('obs-'),
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
            isPanelOpen={activePanel === p.identity}
            onTogglePanel={() => setActivePanel(activePanel === p.identity ? null : p.identity)}
          />
        ))}
      </div>
    </div>
  );
}
