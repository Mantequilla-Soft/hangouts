import { useEffect } from 'react';
import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { RoomHeader } from './RoomHeader.js';
import { SpeakerStage } from './SpeakerStage.js';
import { AudienceSection } from './AudienceSection.js';
import { RoomControls } from './RoomControls.js';

export interface HangoutsRoomProps {
  roomName: string;
  onLeave?: () => void;
}

export function HangoutsRoom({ roomName, onLeave }: HangoutsRoomProps) {
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

  return (
    <LiveKitRoom
      token={room.livekitToken}
      serverUrl={room.livekitServerUrl}
      connect={true}
      audio={room.isHost}
      onDisconnected={handleLeave}
    >
      <RoomAudioRenderer />
      <div className="hh-room">
        <RoomHeader title={title} host={host} />
        <SpeakerStage
          hostIdentity={host}
          isCurrentUserHost={room.isHost}
          roomName={roomName}
        />
        <AudienceSection
          hostIdentity={host}
          isCurrentUserHost={room.isHost}
          roomName={roomName}
        />
        <RoomControls
          isHost={room.isHost}
          onLeave={handleLeave}
          onEndRoom={room.isHost ? handleEndRoom : undefined}
        />
      </div>
    </LiveKitRoom>
  );
}
