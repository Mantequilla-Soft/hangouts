import { useEffect, useMemo, useRef, useState } from 'react';
import { useParticipants, useTracks, useRoomInfo } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { getParticipantRole } from '../../hooks/useParticipantRole.js';
import { usePermissionsTick } from '../../hooks/usePermissionsTick.js';
import { useLiveHost } from '../../hooks/useLiveHost.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { ParticipantTile } from './ParticipantTile.js';
import { ScreenShareView } from './ScreenShareView.js';

export interface SpeakerStageProps {
  /** Join-time fallback host used until live metadata loads. The live
   *  host is read reactively, so a transfer mid-session updates the
   *  focus, layout permissions, and per-tile host menus immediately. */
  hostIdentity: string | null;
  /** Ignored — derived from live metadata via useLiveHost. */
  isCurrentUserHost?: boolean;
  roomName: string;
  videoEnabled?: boolean;
  /** When false, the rail of small tiles moves to the right of the focus
   *  area (where the chat used to live) instead of stacking below it. */
  chatOpen?: boolean;
}

export function SpeakerStage({
  hostIdentity: fallbackHost,
  roomName,
  videoEnabled = false,
  chatOpen = true,
}: SpeakerStageProps) {
  const { hostIdentity, isCurrentUserHost } = useLiveHost(fallbackHost);
  usePermissionsTick(); // re-render when any participant's canPublish changes
  const participants = useParticipants();
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const screenShareTracks = useTracks([Track.Source.ScreenShare]);
  const hasScreenShare = videoEnabled && screenShareTracks.length > 0;

  // Live layout from room metadata — host changes apply to every viewer
  // and to the recording (egress reads the same field).
  const roomInfo = useRoomInfo();
  const layoutMode: 'speaker' | 'grid' | 'single' = useMemo(() => {
    if (!roomInfo.metadata) return 'grid';
    try {
      const m = JSON.parse(roomInfo.metadata) as { recordLayout?: 'speaker' | 'grid' | 'single' };
      return m.recordLayout ?? 'grid';
    } catch { return 'grid'; }
  }, [roomInfo.metadata]);

  // Focused-tile mode: clicking a tile enlarges it; remaining tiles drop
  // into a side strip. ESC clears focus.
  const [focusedIdentity, setFocusedIdentity] = useState<string | null>(null);
  // When the user clicks the "Grid" pill we suppress the screen share's
  // automatic primary-focus, otherwise clearing focusedIdentity would
  // immediately promote the share back to the main area and the user
  // would feel the button "did nothing". Reset the suppression when the
  // share itself toggles or the layout changes so the next time a share
  // starts we still default to focusing on it.
  const [suppressScreenAutoFocus, setSuppressScreenAutoFocus] = useState(false);
  useEffect(() => {
    if (!focusedIdentity) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocusedIdentity(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusedIdentity]);
  useEffect(() => {
    setSuppressScreenAutoFocus(false);
  }, [hasScreenShare, layoutMode]);

  // Mirror the host's transient view-state (focused speaker, grid
  // override) into room metadata so the egress template can render the
  // same layout via useRoomInfo. We use metadata (not the data channel)
  // because metadata updates propagate reliably to the headless
  // recording browser, while the data channel didn't (the egress's
  // RoomComposite client doesn't seem to surface every topic). Only
  // pushed by the host so non-host clicks don't hijack the recording.
  const { apiClient } = useHangoutsContext();
  const lastPushedRef = useRef<string>('');
  useEffect(() => {
    if (!isCurrentUserHost || !roomName) return;
    const key = `${focusedIdentity ?? ''}:${suppressScreenAutoFocus ? 1 : 0}`;
    if (lastPushedRef.current === key) return;
    lastPushedRef.current = key;
    apiClient
      .setRoomViewState(roomName, { focusedIdentity, suppressScreenAutoFocus })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[Hangouts] Failed to push view state:', err);
      });
  }, [isCurrentUserHost, roomName, focusedIdentity, suppressScreenAutoFocus, apiClient]);

  const speakers = participants.filter((p) => p.permissions?.canPublish);
  if (speakers.length === 0) return null;

  // Resolve the active focus from the layout mode + explicit click:
  //   grid    → only focus on click (else show full grid)
  //   speaker → click wins, otherwise the host (so recording defaults sane)
  //   single  → click wins, otherwise the host; carousel hidden entirely
  // Special case: a 1-speaker room with NO screen share uses focus
  // styling so the lone webcam stays centered at 16:9. When that lone
  // speaker is sharing their screen, fallback-focus is suppressed so
  // the screen share can take the stage by default (and the user can
  // toggle between webcam and share by clicking the rail tiles).
  const explicitFocus = focusedIdentity
    ? speakers.find((p) => p.identity === focusedIdentity)
    : null;
  const aloneSpeakerNoShare = speakers.length === 1 && !hasScreenShare;
  const fallbackFocus = (
    layoutMode === 'speaker' ||
    layoutMode === 'single' ||
    aloneSpeakerNoShare
  )
    ? speakers.find((p) => p.identity === hostIdentity) ?? speakers[0]
    : null;
  const focusedSpeaker = explicitFocus ?? fallbackFocus;

  // Decide what owns the focus area:
  //   - explicit speaker focus wins
  //   - else, an active screen share takes the stage (it's the natural focal point)
  //   - else, no focus (we render the grid)
  type Primary = { kind: 'speaker' } | { kind: 'screen' } | null;
  const primary: Primary = focusedSpeaker
    ? { kind: 'speaker' }
    : (hasScreenShare && !suppressScreenAutoFocus ? { kind: 'screen' } : null);

  const showCarousel = layoutMode !== 'single';
  const isCompact = !!primary;
  // When chat is collapsed AND we're in compact mode, lay the stage out
  // horizontally so the rail of small tiles sits in the freed-up chat
  // space on the right — focus area gets the maximum width.
  const railOnRight = isCompact && !chatOpen;

  const railSpeakers = speakers.filter((p) => p.identity !== focusedSpeaker?.identity);
  // In grid mode the screen share is intentionally NOT a grid cell — it
  // would crowd the speaker tiles. Instead it floats as a small tile in
  // the bottom-right that the user can click to bring back to focus.
  // In focus/compact mode it joins the carousel as before.
  const inGridMode = !primary && layoutMode === 'grid';
  const showScreenInRail = hasScreenShare && primary?.kind !== 'screen' && !inGridMode;
  const showScreenThumbnail = hasScreenShare && inGridMode;

  return (
    <div className={`hh-stage ${isCompact ? 'hh-stage--compact' : ''} ${railOnRight ? 'hh-stage--row' : ''}`}>
      {primary?.kind === 'screen' && (
        <div className="hh-stage__focus hh-stage__focus--screen">
          <ScreenShareView />
        </div>
      )}

      {primary?.kind === 'speaker' && focusedSpeaker && (
        <div className="hh-stage__focus">
          {speakers.length > 1 && (
            <button
              className="hh-stage__back-to-grid"
              onClick={() => {
                setFocusedIdentity(null);
                // Also suppress screen-share auto-focus so the user
                // actually sees the grid even with a share active.
                setSuppressScreenAutoFocus(true);
              }}
              title="Back to grid view (Esc)"
              aria-label="Back to grid view"
            >
              ⊞ Grid
            </button>
          )}
          <ParticipantTile
            key={focusedSpeaker.identity}
            participant={focusedSpeaker}
            role={getParticipantRole(focusedSpeaker, hostIdentity)}
            isCurrentUserHost={isCurrentUserHost}
            roomName={roomName}
            isPanelOpen={activePanel === focusedSpeaker.identity}
            onTogglePanel={() => setActivePanel(activePanel === focusedSpeaker.identity ? null : focusedSpeaker.identity)}
            videoEnabled={videoEnabled}
          />
        </div>
      )}

      {showCarousel && (
        <div className={`hh-stage__grid ${isCompact ? 'hh-stage__grid--compact' : ''}`}>
          {showScreenInRail && (
            <div
              className="hh-stage__cell hh-stage__cell--screen"
              onClick={() => {
                setFocusedIdentity(null);
                setSuppressScreenAutoFocus(false);
              }}
              title="Click to bring the screen share back to the stage"
            >
              <ScreenShareView />
            </div>
          )}
          {railSpeakers.map((p) => (
            <div
              key={p.identity}
              className="hh-stage__cell"
              onClick={(e) => {
                // Don't claim the click if the inner tile is opening a host
                // controls panel — let its own handler run instead.
                if ((e.target as HTMLElement).closest('.hh-host-panel')) return;
                if ((e.target as HTMLElement).closest('.hh-tile__menu-btn')) return;
                setFocusedIdentity(p.identity);
              }}
              title="Click to focus this speaker"
            >
              <ParticipantTile
                participant={p}
                role={getParticipantRole(p, hostIdentity)}
                isCurrentUserHost={isCurrentUserHost}
                roomName={roomName}
                isPanelOpen={activePanel === p.identity}
                onTogglePanel={() => setActivePanel(activePanel === p.identity ? null : p.identity)}
                videoEnabled={videoEnabled}
              />
            </div>
          ))}
        </div>
      )}

      {showScreenThumbnail && (
        <div
          className="hh-stage__screen-thumb"
          onClick={() => {
            // Bring the screen share back to the focus area.
            setFocusedIdentity(null);
            setSuppressScreenAutoFocus(false);
          }}
          title="Click to bring the screen share back to the stage"
        >
          <ScreenShareView />
        </div>
      )}
    </div>
  );
}
