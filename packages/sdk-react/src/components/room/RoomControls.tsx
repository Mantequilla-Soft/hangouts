import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant, useLocalParticipantPermissions, useParticipants, useRoomInfo } from '@livekit/components-react';
import type { StreamPlatform } from '@snapie/hangouts-core';
import { useChat } from '../../hooks/useChat.js';
import { useHandRaise } from '../../hooks/useHandRaise.js';
import { useStreaming } from '../../hooks/useStreaming.js';
import { RecordingControls } from './RecordingControls.js';
import { StreamingPanel, StopStreamingPanel } from './StreamingPanel.js';

export interface RoomControlsProps {
  isHost: boolean;
  /** Listen-only guest — hides every speak / chat / hand-raise affordance. */
  isGuest?: boolean;
  roomName: string;
  onLeave: () => void;
  onEndRoom?: () => void;
  /** Transfer host role to another participant and leave. Host-only. */
  onTransferHost?: (newHost: string) => void | Promise<void>;
  /** Set the live/recording layout. Host-only. */
  onSetLayout?: (layout: 'speaker' | 'grid' | 'single') => void | Promise<void>;
  /** Identity of the current host — used to filter the hand-over picker. */
  hostIdentity?: string | null;
  /** Hands a finished video recording to the integrator. Without this
   *  the post-stop dialog hides the Upload button for video. */
  onVideoHandoff?: (file: { blob: Blob; filename: string; duration: number; size: number }) => void;
  /** Hands a finished audio recording to the integrator. Without this
   *  the post-stop dialog hides the Upload button for audio. */
  onAudioHandoff?: (file: { blob: Blob; filename: string; duration: number; size: number }) => void;
  videoEnabled?: boolean;
  /** Whether the room was created with video mode on — used to determine streaming layout */
  roomVideoEnabled?: boolean;
  /** Whether the chat sidebar is currently open. */
  chatOpen?: boolean;
  /** Toggle the chat sidebar. When provided, a chat button appears in the controls. */
  onToggleChat?: () => void;
}

export function RoomControls({ isHost, isGuest = false, roomName, onLeave, onEndRoom, onTransferHost, onSetLayout, hostIdentity, onVideoHandoff, onAudioHandoff, videoEnabled = false, roomVideoEnabled = false, chatOpen, onToggleChat }: RoomControlsProps) {
  // After a host transfer, the LiveKit metadata is the source of truth —
  // useRoomInfo re-renders on metadata changes, so the UI flips correctly
  // for both the old and new host without anyone having to reconnect.
  const roomInfo = useRoomInfo();
  const liveMeta = useMemo(() => {
    if (!roomInfo.metadata) return {} as { host?: string; recordLayout?: 'speaker' | 'grid' | 'single' };
    try { return JSON.parse(roomInfo.metadata); }
    catch { return {}; }
  }, [roomInfo.metadata]);
  const liveHost = liveMeta.host;
  const liveLayout: 'speaker' | 'grid' | 'single' = liveMeta.recordLayout ?? 'grid';
  const { localParticipant } = useLocalParticipant();
  // useLocalParticipant doesn't re-render on permission changes, so a
  // listener promoted to speaker would never see their share buttons
  // appear. useLocalParticipantPermissions subscribes to the
  // ParticipantPermissionsChanged event and updates in real time.
  const permissions = useLocalParticipantPermissions();
  const canPublish = permissions?.canPublish ?? false;
  // Reactive host detection: prefer the live metadata when present,
  // otherwise fall back to the prop set at join time.
  const effectiveIsHost = liveHost
    ? localParticipant?.identity === liveHost
    : isHost;
  const isMuted = !localParticipant?.isMicrophoneEnabled;
  const isCameraOn = localParticipant?.isCameraEnabled ?? false;
  const isScreenSharing = localParticipant?.isScreenShareEnabled ?? false;
  const { isRaised, raiseHand, lowerHand } = useHandRaise();
  const prevCanPublish = useRef(canPublish);
  const [showStreaming, setShowStreaming] = useState(false);
  const [viewerUrl, setViewerUrl] = useState('');
  const { isStreaming, platform, isLoading, error, startStream, stopStream } = useStreaming(roomName);

  // Host-only menu state for the End-Room dropdown ("End for everyone" /
  // "Hand over and leave"). Closed on outside-click and Escape.
  const [endMenuOpen, setEndMenuOpen] = useState(false);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const endMenuRef = useRef<HTMLDivElement>(null);
  const closeEndMenu = () => {
    setEndMenuOpen(false);
    setHandoverOpen(false);
  };
  useEffect(() => {
    if (!endMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      // Use composedPath, NOT contains: by the time this listener fires,
      // React may have already unmounted the button that was clicked
      // (e.g., clicking "Hand over and leave" replaces the menu panel),
      // so `endMenuRef.current.contains(e.target)` returns false for a
      // target that no longer exists in the DOM. composedPath captures
      // the propagation chain at dispatch time, so the menu's outer div
      // is still in it even after the inner button vanishes.
      const inside = !!endMenuRef.current && e.composedPath().includes(endMenuRef.current);
      if (!inside) closeEndMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeEndMenu(); };
    setTimeout(() => document.addEventListener('click', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [endMenuOpen]);

  const participants = useParticipants();
  // Hand-over picker: anyone who can publish, excluding ourselves. After
  // transfer the new host's UI flips via effectiveIsHost; using
  // localParticipant.identity here keeps the filter correct even if
  // hostIdentity (set at join time) is stale.
  const handoverCandidates = participants.filter(
    (p) => p.identity !== localParticipant?.identity && p.permissions?.canPublish,
  );
  // Silence the unused-prop lint when present — kept for API compatibility
  // and possible future use (e.g., showing the original host's name).
  void hostIdentity;

  // Unread badge: count messages received while chat is closed.
  const { messages } = useChat();
  const lastSeenLength = useRef(messages.length);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (chatOpen) {
      lastSeenLength.current = messages.length;
      setUnread(0);
    } else {
      setUnread(Math.max(0, messages.length - lastSeenLength.current));
    }
  }, [chatOpen, messages.length]);

  // On promotion: lower the hand if it was raised, but leave mic and
  // camera OFF until the new speaker explicitly turns them on. Auto-
  // unmuting after a promote is too aggressive — the speaker has no
  // chance to compose themselves before the room hears them.
  useEffect(() => {
    if (canPublish && !prevCanPublish.current) {
      if (isRaised) lowerHand();
    }
    prevCanPublish.current = canPublish;
  }, [canPublish, isRaised, lowerHand]);

  const toggleMute = async () => {
    if (!localParticipant) return;
    await localParticipant.setMicrophoneEnabled(isMuted);
  };

  const handleStart = async (p: StreamPlatform, streamKey: string, bgUrl: string, url: string) => {
    setViewerUrl(url);
    await startStream(p, streamKey, bgUrl, roomVideoEnabled);
    setShowStreaming(false); // auto-close setup panel after going live
  };

  const handleStop = async () => {
    await stopStream();
    setShowStreaming(false);
  };

  return (
    <div className="hh-controls">
      {/* Left: share/self actions — hidden entirely for listen-only
          guests since they can't publish, chat, or raise their hand. */}
      <div className="hh-controls__group hh-controls__group--left">
        {!isGuest && canPublish && (
          <button
            className={`hh-btn hh-btn--icon ${isMuted ? 'hh-btn--danger' : 'hh-btn--secondary'}`}
            onClick={toggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? '🔇' : '🎙️'}
          </button>
        )}

        {!isGuest && videoEnabled && canPublish && (
          <button
            className={`hh-btn hh-btn--icon ${isCameraOn ? 'hh-btn--secondary' : 'hh-btn--danger'}`}
            onClick={() => localParticipant?.setCameraEnabled(!isCameraOn)}
            title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
          >
            {isCameraOn ? '📹' : '📷'}
          </button>
        )}

        {!isGuest && videoEnabled && canPublish && (
          // Tagged with hh-btn--screenshare so a CSS @media rule can hide
          // it on phones — getDisplayMedia is rarely supported and the
          // result is unusable on small screens anyway.
          <button
            className={`hh-btn hh-btn--icon hh-btn--screenshare ${isScreenSharing ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
            onClick={() => localParticipant?.setScreenShareEnabled(!isScreenSharing)}
            title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
          >
            🖥️
          </button>
        )}

        {!isGuest && (!canPublish || isRaised) && (
          <button
            className={`hh-btn ${isRaised ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
            onClick={isRaised ? lowerHand : raiseHand}
          >
            ✋ {isRaised ? 'Lower hand' : 'Raise hand'}
          </button>
        )}

        {onToggleChat && !chatOpen && (
          // Chat is closed → show an icon toggle here so the user can re-open it.
          // When the chat panel is on screen it has its own ›-collapse arrow,
          // so this button is hidden then.
          <button
            className="hh-btn hh-btn--icon hh-btn--secondary hh-controls__chat-btn"
            onClick={onToggleChat}
            title="Show chat"
            aria-label="Show chat"
          >
            💬
            {unread > 0 && (
              <span className="hh-controls__chat-badge">{unread}</span>
            )}
          </button>
        )}
      </div>

      {/* Right: host actions + leave (leave sits with the host group so the
          row stays balanced for non-hosts who only see Leave on the right) */}
      <div className="hh-controls__group hh-controls__group--right">
        {effectiveIsHost && <RecordingControls roomName={roomName} onVideoHandoff={onVideoHandoff} onAudioHandoff={onAudioHandoff} />}

        {effectiveIsHost && onSetLayout && (
          // The native <select> overlays the entire label as a fully
          // transparent layer so clicking ANYWHERE on the button opens
          // the dropdown — not just on the chevron at the right.
          <label className="hh-btn hh-btn--secondary hh-controls__layout">
            <span className="hh-controls__layout-label">Layout</span>
            <span className="hh-controls__layout-value">
              {liveLayout === 'grid' ? '▦ Grid' : '◉ Active speaker'}
            </span>
            <span className="hh-controls__layout-chevron" aria-hidden="true">▾</span>
            <select
              value={liveLayout === 'single' ? 'speaker' : liveLayout}
              onChange={(e) => onSetLayout(e.target.value as 'speaker' | 'grid')}
              className="hh-controls__layout-select"
              aria-label="Room layout"
            >
              <option value="grid">▦ Grid</option>
              <option value="speaker">◉ Active speaker</option>
            </select>
          </label>
        )}

        {effectiveIsHost && (
          <button
            className={`hh-btn ${isStreaming ? 'hh-btn--live' : showStreaming ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
            onClick={() => setShowStreaming((v) => !v)}
            title={isStreaming ? 'Live — click to stop' : 'Go Live'}
          >
            🔴 {isStreaming ? 'Live' : 'Go Live'}
          </button>
        )}

        {effectiveIsHost && onEndRoom ? (
          // Host: dropdown combines "End for everyone" + "Hand over and leave".
          // Plain Leave is hidden because hosts ending without choosing one
          // would orphan the room state.
          <div className="hh-end-menu" ref={endMenuRef}>
            <button
              className="hh-btn hh-btn--danger hh-end-menu__trigger"
              onClick={() => setEndMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={endMenuOpen}
            >
              End room <span className="hh-end-menu__chevron">▾</span>
            </button>
            {endMenuOpen && !handoverOpen && (
              <div className="hh-end-menu__panel" role="menu">
                <button
                  className="hh-end-menu__item hh-end-menu__item--danger"
                  role="menuitem"
                  onClick={() => {
                    const msg = handoverCandidates.length > 0
                      ? 'End the room for everyone? Consider handing over to a co-host first.'
                      : 'End the room for everyone? This will disconnect all participants.';
                    closeEndMenu();
                    if (window.confirm(msg)) onEndRoom();
                  }}
                >
                  End for everyone
                </button>
                <button
                  className="hh-end-menu__item"
                  role="menuitem"
                  disabled={!onTransferHost || handoverCandidates.length === 0}
                  onClick={() => setHandoverOpen(true)}
                >
                  Hand over and leave
                  {handoverCandidates.length === 0 && (
                    <span className="hh-end-menu__hint"> (no eligible speakers)</span>
                  )}
                </button>
              </div>
            )}
            {endMenuOpen && handoverOpen && (
              <div className="hh-end-menu__panel" role="menu">
                <div className="hh-end-menu__heading">Pick the new host</div>
                {handoverCandidates.map((p) => (
                  <button
                    key={p.identity}
                    className="hh-end-menu__item"
                    role="menuitem"
                    onClick={() => {
                      closeEndMenu();
                      onTransferHost?.(p.identity);
                    }}
                  >
                    @{p.identity}
                  </button>
                ))}
                <button
                  className="hh-end-menu__item hh-end-menu__item--subtle"
                  role="menuitem"
                  onClick={() => setHandoverOpen(false)}
                >
                  ← Back
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="hh-btn hh-btn--secondary" onClick={onLeave}>
            Leave
          </button>
        )}
      </div>

      {effectiveIsHost && showStreaming && !isStreaming && (
        <StreamingPanel
          videoEnabled={roomVideoEnabled}
          isLoading={isLoading}
          error={error}
          onStart={handleStart}
          onClose={() => setShowStreaming(false)}
        />
      )}

      {effectiveIsHost && showStreaming && isStreaming && platform && (
        <StopStreamingPanel
          platform={platform}
          viewerUrl={viewerUrl}
          isLoading={isLoading}
          error={error}
          onStop={handleStop}
          onClose={() => setShowStreaming(false)}
        />
      )}
    </div>
  );
}
