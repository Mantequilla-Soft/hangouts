import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RoomAudio } from './RoomAudio.js';
import { LiveKitRoom,  StartAudio, useParticipants, useTracks, VideoTrack } from '@livekit/components-react';
import { Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import type { BoostConfig } from '@snapie/hangouts-core';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { BoostStoreProvider } from '../../hooks/useBoosts.js';
import { BoostOverlay } from './BoostOverlay.js';

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
}
const StreamContext = createContext<StreamCtxValue>({ hostIdentity: null, isGuest: true, roomName: '' });
export const useStreamContext = () => useContext(StreamContext);

export interface StandaloneWatchProps {
  roomName: string;
  children: ReactNode;
  /** Shown while connecting. */
  connecting?: ReactNode;
}

export function StandaloneWatch({ roomName, children, connecting }: StandaloneWatchProps) {
  const room = useHangoutsRoom();
  const { isAuthenticated } = useHangoutsContext();
  const joinedForRef = useRef<string | null>(null);

  useEffect(() => {
    // A cold load (opening a stream by URL) authenticates AFTER the first
    // render, so we grab a guest token first. The room token lives in shared
    // state and survives a remount, so without this the viewer is stuck as a
    // guest for the whole session — wrong chat name, and the server blocks
    // their messages. Upgrade the connection once the session lands.
    const upgradeToAuthed = isAuthenticated && !!room.livekitToken && room.isGuest;
    if (room.livekitToken && !upgradeToAuthed) return;
    if (joinedForRef.current === roomName && !upgradeToAuthed) return;
    joinedForRef.current = roomName;
    (async () => {
      try {
        if (isAuthenticated) await room.join(roomName);
        else await room.listen(roomName);
      } catch {
        // Authed join failed (not a participant / token issue) — fall back
        // to an anonymous guest listen so watching still works.
        try { await room.listen(roomName); } catch { /* room gone */ }
      }
    })();
  }, [roomName, isAuthenticated, room]);

  if (!room.livekitToken) {
    return <>{connecting ?? <div className="hh-stream-connecting">Connecting to the stream…</div>}</>;
  }

  const hostIdentity = room.roomMeta?.host ?? null;
  return (
    <StreamContext.Provider value={{ hostIdentity, isGuest: room.isGuest, roomName, boostConfig: room.roomMeta?.boost }}>
      <LiveKitRoom
        token={room.livekitToken}
        serverUrl={room.livekitServerUrl}
        connect={true}
        audio={false}
        video={false}
        options={{ adaptiveStream: true, dynacast: true }}
      >
        <RoomAudio />
        <StartAudio label="Click to enable audio" className="hh-start-audio" />
        <BoostStoreProvider roomName={roomName} minBoostUsd={room.roomMeta?.boost?.minBoostUsd ?? 0}>
          {children}
        </BoostStoreProvider>
      </LiveKitRoom>
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
export function StreamVideo({ showLiveBadge = true }: StreamVideoProps) {
  const track = useProgramTrack();
  const live = useStreamLive();
  return (
    <div className="hh-stream-video">
      {track ? (
        <VideoTrack trackRef={track} className="hh-stream-video__el" />
      ) : (
        <div className="hh-stream-video__placeholder">{live ? 'Stream is starting…' : 'The streamer is offline'}</div>
      )}
      {showLiveBadge && (
        <span className={`hh-stream-badge${live ? '' : ' hh-stream-badge--off'}`}>{live ? '● LIVE' : '○ OFFLINE'}</span>
      )}
      <BoostOverlay />
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
