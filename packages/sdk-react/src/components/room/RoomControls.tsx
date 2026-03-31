import { useLocalParticipant } from '@livekit/components-react';
import { useHandRaise } from '../../hooks/useHandRaise.js';
import { RecordingControls } from './RecordingControls.js';

export interface RoomControlsProps {
  isHost: boolean;
  roomName: string;
  onLeave: () => void;
  onEndRoom?: () => void;
  onRecordingUploaded?: (result: { permlink: string; cid: string; playUrl: string }) => void;
}

export function RoomControls({ isHost, roomName, onLeave, onEndRoom, onRecordingUploaded }: RoomControlsProps) {
  const { localParticipant } = useLocalParticipant();
  const canPublish = localParticipant?.permissions?.canPublish ?? false;
  const isMuted = !localParticipant?.isMicrophoneEnabled;
  const { isRaised, raiseHand, lowerHand } = useHandRaise();

  const toggleMute = async () => {
    if (!localParticipant) return;
    await localParticipant.setMicrophoneEnabled(isMuted);
  };

  return (
    <div className="hh-controls">
      {canPublish && (
        <button
          className={`hh-btn hh-btn--icon ${isMuted ? 'hh-btn--danger' : 'hh-btn--secondary'}`}
          onClick={toggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? '🔇' : '🎙️'}
        </button>
      )}

      {!canPublish && (
        <button
          className={`hh-btn ${isRaised ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
          onClick={isRaised ? lowerHand : raiseHand}
        >
          ✋ {isRaised ? 'Lower hand' : 'Raise hand'}
        </button>
      )}

      <button className="hh-btn hh-btn--secondary" onClick={onLeave}>
        Leave
      </button>

      {isHost && <RecordingControls roomName={roomName} onUploaded={onRecordingUploaded} />}

      {isHost && onEndRoom && (
        <button className="hh-btn hh-btn--danger" onClick={onEndRoom}>
          End room
        </button>
      )}
    </div>
  );
}
