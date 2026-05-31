import { useRef, useEffect, useState, type MouseEvent } from 'react';
import { useIsSpeaking, VideoTrack } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { Track } from 'livekit-client';
import type { ParticipantRole } from '@snapie/hangouts-core';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';
import { useParticipantVolumes } from '../../hooks/useParticipantVolumes.js';
import { HostControlsPanel } from './HostControlsPanel.js';
import { HeadphonesIcon } from '../icons/HeadphonesIcon.js';

export interface ParticipantTileProps {
  participant: Participant;
  role: ParticipantRole;
  isHandRaised?: boolean;
  isCurrentUserHost?: boolean;
  roomName?: string;
  size?: 'large' | 'normal' | 'small';
  /** Reserved for parent-controlled menus; the tile manages its own panel state. */
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
  videoEnabled = false,
}: ParticipantTileProps) {
  const isSpeaking = useIsSpeaking(participant);
  // Guest identities (`guest-{random}`) have no Hive account, so the
  // avatar service returns the generic Hive default — replace with a
  // dedicated listener icon and a generic "Guest" label below.
  const isGuest = participant.identity.startsWith('guest-');
  const avatarUrl = useHiveAvatar(participant.identity);
  const displayName = participant.name || (isGuest ? 'Guest' : participant.identity);
  const isMuted = role !== 'listener' && !participant.isMicrophoneEnabled;
  const cameraPublication = participant.getTrackPublication(Track.Source.Camera);
  const hasVideo = videoEnabled && cameraPublication?.track && !cameraPublication.isMuted;
  const tileRef = useRef<HTMLDivElement>(null);

  // Per-tile host menu state. Opened via the ⋮ button at the top-right
  // — the tile body itself is reserved for the click-to-focus handler in
  // the parent (SpeakerStage), so we no longer toggle on a body click.
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const isLocal = participant.isLocal;
  // Host can act on all non-local participants — guests get ban instead of kick.
  const showMenuButton = isCurrentUserHost && !isLocal;

  // Volume control is broadcast on the room's data channel so the host's
  // changes also apply to every other listener and to the headless
  // egress browser running the recording. Local-only setVolume wouldn't
  // affect either of those — see useParticipantVolumes for details.
  const { volumes, setParticipantVolume } = useParticipantVolumes();
  const volume = volumes.get(participant.identity) ?? 1;
  const handleVolumeChange = (next: number) => {
    setParticipantVolume(participant.identity, next);
  };
  const showVolumeSlider = role !== 'listener';

  const handleMenuButtonClick = (e: MouseEvent) => {
    e.stopPropagation();
    // Capture the trigger's rect so the popup can be positioned via
    // viewport-fixed coordinates after portaling to <body>.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    console.log('[Hangouts] tile menu click', { identity: participant.identity, rect });
    setAnchorRect(rect);
    setMenuOpen((v) => !v);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    const onDoc = (e: Event) => {
      const target = e.target as Node;
      // Tile contains the trigger; portaled panel is OUTSIDE the tile in
      // the DOM, so we also exclude clicks on `.hh-host-panel`.
      if (tileRef.current && tileRef.current.contains(target)) return;
      const panel = (target as HTMLElement).closest?.('.hh-host-panel');
      if (panel) return;
      setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('click', onDoc), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDoc);
    };
  }, [menuOpen]);

  const classes = [
    'hh-tile',
    size === 'large' && 'hh-tile--large',
    size === 'small' && 'hh-tile--small',
    isSpeaking && 'hh-tile--speaking',
    isMuted && 'hh-tile--muted',
    isGuest && 'hh-tile--guest',
  ].filter(Boolean).join(' ');

  // Compact circular variant for the audience row — keeps the original
  // avatar-with-name-below shape so listener strips stay readable.
  if (size === 'small') {
    return (
      <div className={classes} ref={tileRef}>
        <div className="hh-tile__avatar-wrap">
          {isGuest ? (
            <span className="hh-tile__avatar hh-tile__guest-icon" title="Guest listener">
              <HeadphonesIcon size={20} />
            </span>
          ) : (
            <img className="hh-tile__avatar" src={avatarUrl} alt={participant.identity} />
          )}
          {isHandRaised && <span className="hh-tile__hand">✋</span>}
        </div>
        <span className="hh-tile__name">{displayName}</span>
        {showMenuButton && (
          <>
            <button
              className="hh-tile__menu-btn hh-tile__menu-btn--small"
              onClick={handleMenuButtonClick}
              aria-label="Participant options"
              title="Participant options"
            >
              ⋮
            </button>
            {menuOpen && roomName && (
              <HostControlsPanel
                identity={participant.identity}
                role={role}
                roomName={roomName}
                onClose={() => setMenuOpen(false)}
                volume={showVolumeSlider ? volume : undefined}
                onVolumeChange={showVolumeSlider ? handleVolumeChange : undefined}
                inline
                anchorRect={anchorRect}
              />
            )}
          </>
        )}
      </div>
    );
  }

  // Speaker variant — Zoom-style 16:9 card with media on top and an
  // overlaid info row at the bottom (name, role, mic, hand).
  return (
    <div className={classes} ref={tileRef}>
      <div className="hh-tile__media">
        {hasVideo ? (
          <VideoTrack
            trackRef={{ participant, publication: cameraPublication!, source: Track.Source.Camera }}
            className="hh-tile__video"
          />
        ) : (
          <div className="hh-tile__placeholder">
            <img className="hh-tile__avatar" src={avatarUrl} alt={participant.identity} />
          </div>
        )}
        {isHandRaised && <span className="hh-tile__hand">✋</span>}
      </div>

      {showMenuButton && (
        <button
          className="hh-tile__menu-btn"
          onClick={handleMenuButtonClick}
          aria-label="Participant options"
          title="Participant options"
        >
          ⋮
        </button>
      )}

      <div className="hh-tile__overlay">
        {isMuted && <span className="hh-tile__mute" title="Muted">🔇</span>}
        <span className="hh-tile__name">{displayName}</span>
        {role === 'host' && <span className="hh-tile__role">Host</span>}
        {isGuest && <span className="hh-tile__guest-badge">Guest</span>}
      </div>

      {menuOpen && roomName && isCurrentUserHost && (
        <HostControlsPanel
          identity={participant.identity}
          role={role}
          roomName={roomName}
          onClose={() => setMenuOpen(false)}
          volume={showVolumeSlider ? volume : undefined}
          onVolumeChange={showVolumeSlider ? handleVolumeChange : undefined}
          inline
          anchorRect={anchorRect}
        />
      )}
    </div>
  );
}
