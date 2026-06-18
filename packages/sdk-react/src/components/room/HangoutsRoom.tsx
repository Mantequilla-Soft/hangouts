import { useEffect, useRef, useState } from 'react';
import { LiveKitRoom, RoomAudioRenderer, StartAudio } from '@livekit/components-react';
import { useDataChannel } from '@livekit/components-react';
import type { GameResultPayload } from '@snapie/hangouts-core';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { useHandRaiseChime } from '../../hooks/useHandRaiseChime.js';
import { RoomHeader } from './RoomHeader.js';
import { SpeakerStage } from './SpeakerStage.js';
import { AudienceSection } from './AudienceSection.js';
import { RoomControls } from './RoomControls.js';
import { ChatPanel } from './ChatPanel.js';
import { GamePanel } from './GamePanel.js';
import { WordGuessStage } from './WordGuessStage.js';
import { HangoutsErrorBoundary } from './HangoutsErrorBoundary.js';
import { GuestNameModal } from '../lobby/GuestNameModal.js';
import { BoostOverlay } from './BoostOverlay.js';
import { BoostStoreProvider } from '../../hooks/useBoosts.js';

/** Prevents the screen from sleeping while the user is in a room.
 *  Acquires a WakeLock on mount, releases on unmount, and re-acquires
 *  when the tab returns to the foreground (the browser releases it
 *  automatically on visibility change). */
function WakeLockGuard() {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return;

    let lock: WakeLockSentinel | null = null;

    const acquire = async () => {
      try {
        lock = await (navigator as Navigator & { wakeLock: { request(type: string): Promise<WakeLockSentinel> } }).wakeLock.request('screen');
      } catch {
        // WakeLock denied or not supported — fail silently
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      lock?.release();
    };
  }, []);

  return null;
}

/** Mounts the hand-raise chime listener inside the LiveKit room. The
 *  hook must be a descendant of <LiveKitRoom> for useDataChannel to
 *  resolve its context; a tiny render-null component keeps that
 *  positioning explicit. */
function HandRaiseChimeListener({ enabled }: { enabled: boolean }) {
  useHandRaiseChime(enabled);
  return null;
}

/** Listens for game lifecycle events on the 'game' data channel topic
 *  so HangoutsRoom can auto-open/close the game panel without needing
 *  the GamePanel itself to be mounted. */
function GameNotificationListener({
  onGameStarted,
  onGameEnded,
}: {
  onGameStarted: (gameId: string) => void;
  onGameEnded: (payload?: GameResultPayload) => void;
}) {
  useDataChannel('game', (msg) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as {
        type: string;
        gameId?: string;
        players?: string[];
        startedAt?: number;
        endedAt?: number;
        duration?: number;
        result?: unknown;
      };
      if (parsed.type === 'game:started') onGameStarted(parsed.gameId ?? '');
      if (parsed.type === 'game:ended') {
        const payload: GameResultPayload | undefined = parsed.gameId ? {
          gameId: parsed.gameId,
          players: parsed.players ?? [],
          startedAt: parsed.startedAt ?? 0,
          endedAt: parsed.endedAt ?? Date.now(),
          duration: parsed.duration ?? 0,
          result: parsed.result ?? null,
        } : undefined;
        onGameEnded(payload);
      }
    } catch { /* ignore malformed */ }
  });
  return null;
}

export interface HangoutsRoomProps {
  roomName: string;
  onLeave?: () => void;
  onError?: (error: Error) => void;
  /** When true, removes min-height and fits within parent container. Use when embedding in modals or panels. */
  embedded?: boolean;
  /** Optional max height for the room container (e.g., "80vh", "600px"). */
  maxHeight?: string;
  /**
   * Hands a finished VIDEO recording to the integrator. The Upload
   * button in the post-stop dialog only renders when this is set —
   * without it, the host can still Download or Dismiss the recording
   * but has no built-in publish path. The integrator chooses the
   * destination (3Speak Studio, S3, etc.).
   */
  onVideoHandoff?: (file: { blob: Blob; filename: string; duration: number; size: number }) => void;
  /**
   * Hands a finished AUDIO recording to the integrator. Same gating
   * and ownership story as `onVideoHandoff`.
   */
  onAudioHandoff?: (file: { blob: Blob; filename: string; duration: number; size: number }) => void;
  /** Enable video and screen sharing for speakers. Default: false (audio-only). */
  video?: boolean;
  /**
   * When true, an unauthenticated viewer auto-joins as a listen-only
   * guest (server `/listen` endpoint). Authenticated users still
   * follow the normal `join` flow. Default: false (the integrator
   * gates the room behind their own sign-in screen).
   */
  guestFallback?: boolean;
  /**
   * Returns the URL the Share button should copy. Receives the room
   * name and the origin hostname stored in metadata (the site that
   * created the room) so the integrator can route shares back to a
   * surface where the recipient still has session/auth. Return null
   * to hide the button.
   */
  getShareUrl?: (roomName: string, origin: string | undefined) => string | null;
  /**
   * Play a subtle local chime when another participant raises their
   * hand. The sound is local-only (Web Audio synth, not pushed into
   * the LiveKit publish path) and the egress recording browser does
   * not mount this component, so recordings stay clean. The hook
   * skips the local user's own raises and throttles to one chime per
   * two seconds to handle bursts. Default: true.
   */
  notificationSounds?: boolean;
  /**
   * Base URL where the OBS overlay page is hosted. Defaults to
   * "https://hangout.3speak.tv" — the canonical hosted overlay.
   * Override to point at your own deployment, or pass "" to hide the button.
   */
  obsBaseUrl?: string;
  /**
   * When true, replaces the mute toggle with a push-to-talk button for speakers.
   * Hold the button or press spacebar to speak — release to mute again.
   * Has no effect for listen-only guests.
   */
  pushToTalk?: boolean;
  /**
   * Called when a game session ends (win, resign, or host abort).
   * Receives a structured snapshot of the final game state — use it to
   * post a Hive custom_json, create a snap, or log results.
   *
   * Cast `result` to `ChessGameResult` or `FastDrawGameResult` based on `gameId`.
   * Not called when the server has no session data (very old server version).
   */
  onGameEnd?: (result: GameResultPayload) => void;
  /**
   * Fires whenever the room's active game changes: a game's id when one
   * starts (or is already running when you join — late joiners get this
   * from a hydration fetch, not a live event, so it still fires), and
   * `null` once it ends. Use this to gate a "confirm before leaving" prompt
   * on your own close/leave button — accidentally leaving mid-game is a
   * worse experience than one extra confirmation tap.
   *
   * Mirrors the SDK's own internal game-tracking state exactly, including
   * the few-second delay before clearing to `null` after a game ends (so
   * the signal matches what's still visible on screen, not just the wire
   * event).
   */
  onActiveGameChange?: (gameId: string | null) => void;
}

export function HangoutsRoom({ roomName, onLeave, onError, embedded = false, maxHeight, onVideoHandoff, onAudioHandoff, video = false, guestFallback = false, getShareUrl, notificationSounds = true, obsBaseUrl = 'https://hangout.3speak.tv', pushToTalk = false, onGameEnd, onActiveGameChange }: HangoutsRoomProps) {
  const room = useHangoutsRoom();
  const { isAuthenticated, apiClient } = useHangoutsContext();
  // Default chat closed on mobile — the stage needs the space more than the sidebar does.
  const [chatOpen, setChatOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 768 : true,
  );
  const [gameOpen, setGameOpen] = useState(false);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [showGuestModal, setShowGuestModal] = useState(false);

  useEffect(() => {
    onActiveGameChange?.(activeGameId);
  }, [activeGameId, onActiveGameChange]);
  // Mirror the host's chat-open state into room metadata so the egress
  // template knows whether to render the chat panel in the recording.
  // Non-hosts toggling their own chat does NOT propagate — recording
  // follows the host's view.
  const lastChatPushRef = useRef<string>('');
  useEffect(() => {
    if (!room.isHost || !room.roomName) return;
    const key = `${chatOpen ? '1' : '0'}:${activeGameId ?? ''}`;
    if (lastChatPushRef.current === key) return;
    lastChatPushRef.current = key;
    room.setViewState?.({ chatOpen, activeGameId }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[Hangouts] Failed to push chatOpen:', err);
    });
  }, [chatOpen, activeGameId, room.isHost, room.roomName, room.setViewState, room]);

  // Module-level dedup so React 18 StrictMode (which mounts effects twice in
  // dev) doesn't fire a second `room.join()` while the first is still in
  // flight. Without this, the API issues two LiveKit tokens, the second
  // WebSocket connection knocks out the first as a duplicate identity, and
  // the room appears to open and close immediately.
  const joinedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (room.livekitToken) return;
    if (joinedForRef.current === roomName) return;
    if (isAuthenticated) {
      joinedForRef.current = roomName;
      room.join(roomName);
    } else if (guestFallback) {
      // Unauthenticated visitor — show the name modal before joining.
      // Set the ref now so StrictMode double-mount doesn't show it twice.
      joinedForRef.current = roomName;
      setShowGuestModal(true);
    }
  }, [roomName, isAuthenticated, guestFallback, room]);

  // Seed activeGameId on join so late-joiners and audience members see any
  // game that was already running when they arrived (they miss game:started).
  useEffect(() => {
    if (!room.livekitToken || !isAuthenticated) return;
    apiClient.getActiveGame(roomName)
      .then((game) => {
        if (game) {
          setActiveGameId(game.gameId);
          setGameOpen(false); // game goes to center — no picker sidebar needed
        }
      })
      .catch(() => { /* no active game or server unreachable — fine */ });
  }, [room.livekitToken, roomName, isAuthenticated, apiClient]);

  if (showGuestModal) {
    return (
      <GuestNameModal
        roomTitle={room.roomMeta?.title}
        onJoin={async (displayName) => {
          setShowGuestModal(false);
          await room.listen(roomName, displayName);
        }}
        onSignIn={() => {
          // Navigate back to the lobby where the user can sign in with Hive.
          setShowGuestModal(false);
          joinedForRef.current = null;
          onLeave?.();
        }}
        onCancel={onLeave ? () => {
          setShowGuestModal(false);
          joinedForRef.current = null;
          onLeave();
        } : undefined}
      />
    );
  }

  if (room.isLoading || !room.livekitToken) {
    return <div className="hh-room">Connecting...</div>;
  }

  const handleLeave = () => {
    room.leave();
    onLeave?.();
  };

  const handleEndRoom = async () => {
    try {
      await room.endRoom();
      onLeave?.();
    } catch (err) {
      // Surface failures so the host gets feedback instead of staring at
      // a button that "does nothing" — e.g., expired session or the
      // server thinking someone else owns the room.
      console.error('[Hangouts] End room failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Couldn't end the room: ${msg}`);
    }
  };

  const handleTransferHost = async (newHost: string) => {
    if (!room.roomName) return;
    try {
      await room.transferHost(newHost);
    } catch (err) {
      console.error('[Hangouts] Transfer host failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Couldn't transfer host: ${msg}`);
      return;
    }
    // Once metadata.host points elsewhere, the server treats us as a
    // regular speaker — leave to drop the LiveKit connection. The new
    // host's client picks up the metadata change via Room events.
    handleLeave();
  };

  // Use room metadata title if available, otherwise the room name
  const title = room.roomMeta?.title ?? roomName;
  const host = room.roomMeta?.host ?? '';
  const description = room.roomMeta?.description;
  const backgroundImage = room.roomMeta?.backgroundImage;

  // Any speaker (host or promoted listener) can publish camera/screen share when
  // the room is in video mode. Premium status is enforced server-side on
  // recording only — publishing has no marginal cost beyond LiveKit's relay.
  const videoEnabled = video;
  const canPublishVideo = video;

  // When a game is active it occupies the center stage area — the game picker
  // sidebar is not shown and the chat mutual-exclusion is lifted.
  const gameIsCenter = !!activeGameId;

  return (
    <HangoutsErrorBoundary onError={onError}>
      <LiveKitRoom
        token={room.livekitToken}
        serverUrl={room.livekitServerUrl}
        connect={true}
        // Guests are listen-only — never request mic/camera access.
        audio={!room.isGuest}
        video={!room.isGuest && canPublishVideo}
        onDisconnected={handleLeave}
      >
        <RoomAudioRenderer />
        {/* Browser autoplay policies block <audio>.play() until the page has a
            fresh user gesture *and* room.startAudio() has been called. Hosts
            get that gesture from their mic-publish prompt, but guests who
            land in via /listen have nothing to unlock playback — they'd see
            speakers' tiles and hear silence. StartAudio renders a button
            only when LiveKit reports audio playback is blocked. */}
        <StartAudio label="Click to enable audio" className="hh-start-audio" />
        <HandRaiseChimeListener enabled={notificationSounds} />
        <GameNotificationListener
          onGameStarted={(gameId) => { setActiveGameId(gameId); setGameOpen(false); }}
          onGameEnded={(payload) => {
            if (payload) onGameEnd?.(payload);
            // Delay layout exit so players can see the final board state
            // and winner banner before the game panel disappears.
            setTimeout(() => { setActiveGameId(null); setGameOpen(false); }, 6000);
          }}
        />
        <WakeLockGuard />
        <BoostStoreProvider roomName={roomName} minBoostUsd={room.roomMeta?.boost?.minBoostUsd ?? 0}>
        <div
          className={`hh-room ${embedded ? 'hh-room--embedded' : ''}`}
          style={maxHeight ? { maxHeight } : undefined}
        >
          {backgroundImage && (
            // Absolute-positioned bg layer so the room thumbnail always
            // covers the full modal regardless of internal flex shrinking
            // or padding. Children stack above it via z-index.
            <div
              className="hh-room__bg"
              style={{ backgroundImage: `url("${backgroundImage}")` }}
              aria-hidden="true"
            />
          )}
          <RoomHeader
            title={title}
            description={description}
            roomName={roomName}
            isGuest={room.isGuest}
            shareUrl={getShareUrl ? getShareUrl(roomName, room.roomMeta?.origin) : null}
          />
          <div className="hh-room__content">
            {/* Listeners column — hidden when a game is center-stage to
                recover horizontal space for the game board. Kept in DOM
                (not conditionally rendered) so AudienceSection subscriptions
                stay live; visibility is toggled via CSS class only. */}
            <aside className={`hh-room__listeners${gameIsCenter ? ' hh-room__listeners--hidden' : ''}`}>
              <AudienceSection
                hostIdentity={host}
                isCurrentUserHost={room.isHost}
                roomName={roomName}
              />
            </aside>
            <div className="hh-room__main">
              {/* Speaker area / game center — layout depends on active game type */}
              {gameIsCenter && activeGameId === 'word-guess' ? (
                /* Word Guess: faces ARE the game — full grid with word badges, no speaker strip */
                <div className="hh-room__game-area">
                  <WordGuessStage
                    roomName={roomName}
                    isHost={room.isHost}
                    hostIdentity={host}
                    videoEnabled={videoEnabled}
                  />
                </div>
              ) : gameIsCenter ? (
                /* Chess / Fast Draw: compact speaker strip above the board */
                <>
                  <div className="hh-room__game-strip">
                    <SpeakerStage
                      hostIdentity={host}
                      isCurrentUserHost={room.isHost}
                      roomName={roomName}
                      videoEnabled={videoEnabled}
                      chatOpen={chatOpen}
                      gameMode={true}
                    />
                    <BoostOverlay />
                  </div>
                  <div className="hh-room__game-area">
                    <GamePanel
                      roomName={roomName}
                      isHost={room.isHost}
                      activeGameId={activeGameId}
                    />
                  </div>
                </>
              ) : (
                /* No active game: full speaker stage */
                <div className="hh-room__stage">
                  <SpeakerStage
                    hostIdentity={host}
                    isCurrentUserHost={room.isHost}
                    roomName={roomName}
                    videoEnabled={videoEnabled}
                    chatOpen={chatOpen}
                  />
                  <BoostOverlay />
                </div>
              )}

              <RoomControls
                isHost={room.isHost}
                isGuest={room.isGuest}
                roomName={roomName}
                boostConfig={room.roomMeta?.boost}
                onLeave={handleLeave}
                // Pass host handlers unconditionally — RoomControls reads
                // live host status from room metadata via useRoomInfo, so
                // a participant promoted via host transfer flips into the
                // host UI mid-session. Gating these on the stale join-time
                // `room.isHost` froze the new host on the Leave button.
                onEndRoom={handleEndRoom}
                onTransferHost={handleTransferHost}
                onSetLayout={room.setLayout}
                hostIdentity={host}
                onVideoHandoff={onVideoHandoff}
                onAudioHandoff={onAudioHandoff}
                videoEnabled={canPublishVideo}
                roomVideoEnabled={video}
                obsBaseUrl={obsBaseUrl}
                chatOpen={chatOpen}
                onToggleChat={() => {
                  // In game-center mode, chat can coexist with the game —
                  // only close the game picker when toggling chat normally.
                  if (!gameIsCenter) setGameOpen(false);
                  setChatOpen((v) => !v);
                }}
                gameOpen={gameOpen}
                onToggleGame={() => { setChatOpen(false); setGameOpen((v) => !v); }}
                activeGameId={activeGameId}
                pushToTalk={pushToTalk}
              />
            </div>

            {/* Chat sidebar — independently toggleable in all states */}
            <aside className={`hh-room__sidebar${chatOpen ? '' : ' hh-room__sidebar--hidden'}`}>
              <ChatPanel
                onClose={() => setChatOpen(false)}
                isGuest={room.isGuest}
              />
            </aside>

            {/* Game picker sidebar — only mounted when no game is running.
                When gameIsCenter, GamePanel lives in hh-room__game-area instead. */}
            {!gameIsCenter && (
              <aside className={`hh-room__sidebar${gameOpen ? '' : ' hh-room__sidebar--hidden'}`}>
                <GamePanel
                  roomName={roomName}
                  isHost={room.isHost}
                  onClose={() => setGameOpen(false)}
                  activeGameId={null}
                />
              </aside>
            )}
          </div>
        </div>
        </BoostStoreProvider>
      </LiveKitRoom>
    </HangoutsErrorBoundary>
  );
}
