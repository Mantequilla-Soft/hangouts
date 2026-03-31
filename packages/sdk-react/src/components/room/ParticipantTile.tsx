import { useState, useRef, type MouseEvent } from 'react';
import { useIsSpeaking } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import type { ParticipantRole } from '@snapie/hangouts-core';
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
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });
  const tileRef = useRef<HTMLDivElement>(null);

  const handleClick = (e: MouseEvent) => {
    if (!isCurrentUserHost) return;

    if (showPanel) {
      setShowPanel(false);
      return;
    }

    // Position panel near the click, clamped to viewport
    const rect = tileRef.current?.getBoundingClientRect();
    if (rect) {
      const top = Math.min(rect.bottom + 4, window.innerHeight - 200);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 160));
      setPanelPos({ top, left });
    }
    setShowPanel(true);
  };

  const classes = [
    'hh-tile',
    size === 'small' && 'hh-tile--small',
    isSpeaking && 'hh-tile--speaking',
    isMuted && 'hh-tile--muted',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} ref={tileRef} onClick={handleClick}>
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
          position={panelPos}
        />
      )}
    </div>
  );
}
