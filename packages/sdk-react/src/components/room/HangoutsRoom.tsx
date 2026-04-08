import { useEffect } from 'react';
import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { RoomHeader } from './RoomHeader.js';
import { SpeakerStage } from './SpeakerStage.js';
import { AudienceSection } from './AudienceSection.js';
import { RoomControls } from './RoomControls.js';
import { ChatPanel } from './ChatPanel.js';
import { HangoutsErrorBoundary } from './HangoutsErrorBoundary.js';

export interface HangoutsRoomProps {
  roomName: string;
  onLeave?: () => void;
  onError?: (error: Error) => void;
  /** When true, removes min-height and fits within parent container. Use when embedding in modals or panels. */
  embedded?: boolean;
  /** Optional max height for the room container (e.g., "80vh", "600px"). */
  maxHeight?: string;
  /** Called when the host uploads a recording to IPFS. */
  onRecordingUploaded?: (result: { permlink: string; cid: string; playUrl: string }) => void;
  /** Enable video and screen sharing for speakers. Default: false (audio-only). */
  video?: boolean;
}

export function HangoutsRoom({ roomName, onLeave, onError, embedded = false, maxHeight, onRecordingUploaded, video = false }: HangoutsRoomProps) {
  const room = useHangoutsRoom();

  useEffect(() => {
    if (!room.livekitToken) {
      room.join(roomName);
    }
  }, [roomName]);

  if (room.isLoading || !room.livekitToken) {
    return <div className="hh-room">Connecting...</div>;
  }

  const handleLeave = () => {
    room.leave();
    onLeave?.();
  };

  const handleEndRoom = async () => {
    await room.endRoom();
    onLeave?.();
  };

  // Use room metadata title if available, otherwise the room name
  const title = room.roomMeta?.title ?? roomName;
  const host = room.roomMeta?.host ?? '';

  // All users can view video; only premium users can publish camera or screen share
  const videoEnabled = video;
  const canPublishVideo = video && room.isPremium;

  return (
    <HangoutsErrorBoundary onError={onError}>
      <LiveKitRoom
        token={room.livekitToken}
        serverUrl={room.livekitServerUrl}
        connect={true}
        audio={true}
        video={canPublishVideo}
        onDisconnected={handleLeave}
      >
        <RoomAudioRenderer />
        <div
          className={`hh-room ${embedded ? 'hh-room--embedded' : ''}`}
          style={maxHeight ? { maxHeight } : undefined}
        >
          <RoomHeader title={title} host={host} roomName={roomName} />
          <div className="hh-room__content">
            <SpeakerStage
              hostIdentity={host}
              isCurrentUserHost={room.isHost}
              roomName={roomName}
              videoEnabled={videoEnabled}
            />
            <AudienceSection
              hostIdentity={host}
              isCurrentUserHost={room.isHost}
              roomName={roomName}
            />
            <ChatPanel />
          </div>
          <RoomControls
            isHost={room.isHost}
            roomName={roomName}
            onLeave={handleLeave}
            onEndRoom={room.isHost ? handleEndRoom : undefined}
            onRecordingUploaded={onRecordingUploaded}
            videoEnabled={canPublishVideo}
          />
        </div>
      </LiveKitRoom>
    </HangoutsErrorBoundary>
  );
}
