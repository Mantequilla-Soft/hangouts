import { useState } from 'react';
import { useIsSpeaking } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import type { ParticipantRole } from '@hive-hangouts/core';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';
import { HostControlsPanel } from './HostControlsPanel.js';

export interface ParticipantTileProps {
  participant: Participant;
  role: ParticipantRole;
  isHandRaised?: boolean;
  isCurrentUserHost?: boolean;
  roomName?: string;
  size?: 'normal' | 'small';
}

export function ParticipantTile({
  participant,
  role,
  isHandRaised = false,
  isCurrentUserHost = false,
  roomName,
  size = 'normal',
}: ParticipantTileProps) {
  const isSpeaking = useIsSpeaking(participant);
  const avatarUrl = useHiveAvatar(participant.identity);
  const isMuted = role !== 'listener' && !participant.isMicrophoneEnabled;
  const [showPanel, setShowPanel] = useState(false);

  const classes = [
    'hh-tile',
    size === 'small' && 'hh-tile--small',
    isSpeaking && 'hh-tile--speaking',
    isMuted && 'hh-tile--muted',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      onClick={() => isCurrentUserHost && setShowPanel(!showPanel)}
    >
      <div className="hh-tile__avatar-wrap">
        <img
          className="hh-tile__avatar"
          src={avatarUrl}
          alt={participant.identity}
        />
        {isHandRaised && <span className="hh-tile__hand">✋</span>}
      </div>
      <span className="hh-tile__name">{participant.identity}</span>
      {role === 'host' && <span className="hh-tile__role">Host</span>}

      {showPanel && isCurrentUserHost && roomName && (
        <HostControlsPanel
          identity={participant.identity}
          role={role}
          roomName={roomName}
          onClose={() => setShowPanel(false)}
        />
      )}
    </div>
  );
}
