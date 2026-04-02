import { useRef, useEffect, type MouseEvent } from 'react';
import { useIsSpeaking, VideoTrack } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { Track } from 'livekit-client';
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
  isPanelOpen?: boolean;
  onTogglePanel?: () => void;
  videoEnabled?: boolean;
}

export function ParticipantTile({
  participant,
  role,
  isHandRaised = false,
  isCurrentUserHost = false,
  roomName,
  size = 'normal',
  isPanelOpen = false,
  onTogglePanel,
  videoEnabled = false,
}: ParticipantTileProps) {
  const isSpeaking = useIsSpeaking(participant);
  const avatarUrl = useHiveAvatar(participant.identity);
  const isMuted = role !== 'listener' && !participant.isMicrophoneEnabled;
  const cameraPublication = participant.getTrackPublication(Track.Source.Camera);
  const hasVideo = videoEnabled && cameraPublication?.track && !cameraPublication.isMuted;
  const panelPos = useRef({ top: 0, left: 0 });
  const tileRef = useRef<HTMLDivElement>(null);

  const handleClick = (e: MouseEvent) => {
    if (!isCurrentUserHost || !onTogglePanel) return;

    // Calculate position before toggling
    if (!isPanelOpen) {
      const rect = tileRef.current?.getBoundingClientRect();
      if (rect) {
        panelPos.current = {
          top: Math.min(rect.bottom + 4, window.innerHeight - 200),
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 160)),
        };
      }
    }
    onTogglePanel();
  };

  // Close on Escape
  useEffect(() => {
    if (!isPanelOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onTogglePanel?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPanelOpen, onTogglePanel]);

  // Close on click outside
  useEffect(() => {
    if (!isPanelOpen) return;
    const handleClickOutside = (e: Event) => {
      if (tileRef.current && !tileRef.current.contains(e.target as Node)) {
        onTogglePanel?.();
      }
    };
    // Delay to avoid catching the opening click
    setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [isPanelOpen, onTogglePanel]);

  const classes = [
    'hh-tile',
    size === 'small' && 'hh-tile--small',
    isSpeaking && 'hh-tile--speaking',
    isMuted && 'hh-tile--muted',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} ref={tileRef} onClick={handleClick}>
      <div className="hh-tile__avatar-wrap">
        {hasVideo ? (
          <VideoTrack
            trackRef={{ participant, publication: cameraPublication!, source: Track.Source.Camera }}
            className="hh-tile__video"
          />
        ) : (
          <img
            className="hh-tile__avatar"
            src={avatarUrl}
            alt={participant.identity}
          />
        )}
        {isHandRaised && <span className="hh-tile__hand">✋</span>}
      </div>
      <span className="hh-tile__name">{participant.identity}</span>
      {role === 'host' && <span className="hh-tile__role">Host</span>}

      {isPanelOpen && isCurrentUserHost && roomName && (
        <HostControlsPanel
          identity={participant.identity}
          role={role}
          roomName={roomName}
          onClose={() => onTogglePanel?.()}
          position={panelPos.current}
        />
      )}
    </div>
  );
}
