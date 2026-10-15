import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RoomAudio } from './RoomAudio.js';
import { LiveKitRoom,  StartAudio, useParticipants, useTracks, VideoTrack, useRoomInfo, useConnectionState } from '@livekit/components-react';
import { ConnectionState, Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import type { BoostConfig } from '@snapie/hangouts-core';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { BoostStoreProvider } from '../../hooks/useBoosts.js';

/**
 * Composable watch-side of a standalone stream. Unlike <StandaloneViewer>
 * (a self-contained full viewer), this connects the room and exposes the
 * live pieces (<StreamVideo>, <StreamViewerCount>, <StreamQualityControl>,
 * plus <ChatPanel>) so an integrator can lay them out in their OWN page —
 * e.g. drop the video into a watch-page player slot, the viewer count next
 * to the title, and the chat in a sidebar.
 *
 * Auto-joins with NO name prompt: authenticated users join as themselves
 * (can chat); everyone else auto-joins as an anonymous guest (watch-only,
 * chat is read-only).
 */
interface StreamCtxValue {
  hostIdentity: string | null;
  isGuest: boolean;
  roomName: string;
  boostConfig?: BoostConfig;
  /** The broadcast is portrait, i.e. it came from the MOBILE studio. Only that
   *  studio has the Guests panel for accepting collab requests, so it also
   *  tells a viewer whether asking to join can lead anywhere. */
  portrait?: boolean;
}
const StreamContext = createContext<StreamCtxValue>({ hostIdentity: null, isGuest: true, roomName: '' });
export const useStreamContext = () => useContext(StreamContext);

export interface StandaloneWatchProps {
  roomName: string;
  children: ReactNode;
  /** Shown while connecting. */
  connecting?: ReactNode;
  /** Silence the stream's sound without leaving the room, e.g. while the page
   *  plays an ad over it. The picture keeps running underneath. */
  audioMuted?: boolean;
}

export function StandaloneWatch({ roomName, children, connecting, audioMuted = false }: StandaloneWatchProps) {
  const room = useHangoutsRoom();
  const { isAuthenticated } = useHangoutsContext();
  const joinedForRef = useRef<string | null>(null);
  const upgradeFailedRef = useRef<string | null>(null);

  useEffect(() => {
    // A cold load (opening a stream by URL) authenticates AFTER the first
    // render, so we grab a guest token first. The room token lives in shared
    // state and survives a remount, so without this the viewer is stuck as a
    // guest for the whole session — wrong chat name, and the server blocks
    // their messages. Upgrade the connection once the session lands.
    // An upgrade that already failed for this room is not retried: the fallback
    // below listens as a guest again, which would otherwise re-trigger it forever.
    const upgradeToAuthed = isAuthenticated && !!room.livekitToken && room.isGuest
      && upgradeFailedRef.current !== roomName;
    if (room.livekitToken && !upgradeToAuthed) return;
    if (joinedForRef.current === roomName && !upgradeToAuthed) return;
    joinedForRef.current = roomName;
    (async () => {
      try {
        if (isAuthenticated) await room.join(roomName);
        else await room.listen(roomName);
      } catch {
        if (isAuthenticated) upgradeFailedRef.current = roomName;
        // Authed join failed (not a participant / token issue) — fall back
        // to an anonymous guest listen so watching still works.
        try { await room.listen(roomName); } catch { /* room gone */ }
      }
    })();
    // livekitToken / isGuest explicitly: the upgrade has to be re-checked when a
    // guest listen that was already in flight completes, even if `room` itself
    // is the same object.
  }, [roomName, isAuthenticated, room, room.livekitToken, room.isGuest]);

  if (!room.livekitToken) {
    return <>{connecting ?? <div className="hh-stream-connecting">Connecting to the stream…</div>}</>;
  }

  return (
    <LiveKitRoom
      token={room.livekitToken}
      serverUrl={room.livekitServerUrl}
      connect={true}
      audio={false}
      video={false}
      options={{ adaptiveStream: true, dynacast: true }}
    >
      <StreamContextBridge roomName={roomName} isGuest={room.isGuest} joinMeta={room.roomMeta}>
        <RoomAudio programOnly muted={audioMuted} />
        <StartAudio label="Click to enable audio" className="hh-start-audio" />
        <BoostStoreProvider roomName={roomName} minBoostUsd={room.roomMeta?.boost?.minBoostUsd ?? 0}>
          {children}
        </BoostStoreProvider>
      </StreamContextBridge>
    </LiveKitRoom>
  );
}

/**
 * Provides StreamContext from the LIVE room metadata (reactive to the host's
 * "Start" / metadata updates), not the join-time snapshot. A viewer who joined
 * during standby otherwise never sees `portrait` flip true, so CollabRequest
 * stays hidden and they can't ask to join the stage until they refresh. Falls
 * back to the join-time meta until the first metadata sync lands.
 */
function StreamContextBridge({ roomName, isGuest, joinMeta, children }: {
  roomName: string;
  isGuest: boolean;
  joinMeta: unknown;
  children: ReactNode;
}) {
  const roomInfo = useRoomInfo();
  const meta = useMemo((): { host?: string; boost?: BoostConfig; portrait?: boolean } => {
    if (roomInfo.metadata) {
      try { return JSON.parse(roomInfo.metadata); } catch { /* fall back below */ }
    }
    return (joinMeta as { host?: string; boost?: BoostConfig; portrait?: boolean }) ?? {};
  }, [roomInfo.metadata, joinMeta]);
  return (
    <StreamContext.Provider value={{
      hostIdentity: meta.host ?? null,
      isGuest,
      roomName,
      boostConfig: meta.boost,
      portrait: meta.portrait,
    }}>
      {children}
    </StreamContext.Provider>
  );
}

/** Resolve the streamer's program track (the composited Camera source). */
function useProgramTrack() {
  const { hostIdentity } = useStreamContext();
  const cameraTracks = useTracks([Track.Source.Camera]);
  return useMemo(() => {
    const remote = cameraTracks.filter((t) => !t.participant.isLocal);
    return remote.find((t) => t.participant.identity === hostIdentity) ?? remote[0] ?? null;
  }, [cameraTracks, hostIdentity]);
}

/** True when the streamer is connected and publishing. */
export function useStreamLive() {
  const { hostIdentity } = useStreamContext();
  const participants = useParticipants();
  return participants.some((p) => p.identity === hostIdentity);
}

export interface StreamVideoProps {
  /** Overlay a small LIVE/OFFLINE badge (top-left). Default true. */
  showLiveBadge?: boolean;
}
/** How long after connecting an absent host still counts as "not here yet"
 *  rather than offline. The participant list arrives a moment after the room
 *  connects, so without this every viewer saw "The streamer is offline" flash
 *  before a perfectly live stream appeared. */
const OFFLINE_GRACE_MS = 4000;

/** True once the room has been connected for OFFLINE_GRACE_MS, and from then
 *  on. A connection that drops after that (the stream ended, the room closed)
 *  is NOT "connecting" again: it stays settled, so the viewer reads "offline". */
function useConnectionSettled(): boolean {
  const state = useConnectionState();
  const [settled, setSettled] = useState(false);
  const wasConnected = useRef(false);
  useEffect(() => {
    if (state === ConnectionState.Connected) {
      wasConnected.current = true;
      const timer = setTimeout(() => setSettled(true), OFFLINE_GRACE_MS);
      return () => clearTimeout(timer);
    }
    if (state === ConnectionState.Disconnected && wasConnected.current) setSettled(true);
    // Connecting / Reconnecting: keep what we had.
    return undefined;
  }, [state]);
  return settled;
}

export function StreamVideo({ showLiveBadge = true }: StreamVideoProps) {
  const track = useProgramTrack();
  const live = useStreamLive();
  const settled = useConnectionSettled();
  const placeholder = live ? 'Stream is starting…' : (settled ? 'The streamer is offline' : 'Connecting…');
  return (
    <div className="hh-stream-video">
      {track ? (
        <VideoTrack trackRef={track} className="hh-stream-video__el" />
      ) : (
        <div className="hh-stream-video__placeholder">{placeholder}</div>
      )}
      {showLiveBadge && (live || settled) && (
        <span className={`hh-stream-badge${live ? '' : ' hh-stream-badge--off'}`}>{live ? '● LIVE' : '○ OFFLINE'}</span>
      )}
      {/* No <BoostOverlay/> here on purpose. The studio now composites boosts
          into the program canvas, so they're already in the picture — and in
          the recording, and in any player. Rendering the DOM overlay on top of
          that showed every boost twice. */}
    </div>
  );
}

export interface StreamViewerCountProps {
  /** Render the label from the count. Default: "N watching right now". */
  render?: (count: number) => ReactNode;
}
export function StreamViewerCount({ render }: StreamViewerCountProps) {
  const { hostIdentity } = useStreamContext();
  const participants = useParticipants();
  const count = participants.filter((p) => p.identity !== hostIdentity && !p.identity.startsWith('obs-')).length;
  return <span className="hh-stream-viewers">{render ? render(count) : `${count} watching right now`}</span>;
}

type ViewerQuality = 'auto' | 'high' | 'medium' | 'low' | 'audio';
export function StreamQualityControl() {
  const track = useProgramTrack();
  const [quality, setQuality] = useState<ViewerQuality>('auto');
  useEffect(() => {
    const pub = track?.publication as RemoteTrackPublication | undefined;
    if (!pub || typeof pub.setVideoQuality !== 'function') return;
    if (quality === 'audio') { pub.setEnabled(false); return; }
    pub.setEnabled(true);
    if (quality === 'high') pub.setVideoQuality(VideoQuality.HIGH);
    else if (quality === 'medium') pub.setVideoQuality(VideoQuality.MEDIUM);
    else if (quality === 'low') pub.setVideoQuality(VideoQuality.LOW);
    else pub.setVideoQuality(VideoQuality.HIGH);
  }, [quality, track]);
  return (
    <label className="hh-stream-quality" title="Playback quality">
      <select value={quality} onChange={(e) => setQuality(e.target.value as ViewerQuality)} aria-label="Playback quality">
        <option value="auto">Auto</option>
        <option value="high">Highest</option>
        <option value="medium">Medium</option>
        <option value="low">Low · data saver</option>
        <option value="audio">Audio only</option>
      </select>
    </label>
  );
}
