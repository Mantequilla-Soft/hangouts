import { useEffect, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import type { StreamPlatform } from '@snapie/hangouts-core';
import { useHandRaise } from '../../hooks/useHandRaise.js';
import { useStreaming } from '../../hooks/useStreaming.js';
import { RecordingControls } from './RecordingControls.js';
import { StreamingPanel, StopStreamingPanel } from './StreamingPanel.js';

export interface RoomControlsProps {
  isHost: boolean;
  roomName: string;
  onLeave: () => void;
  onEndRoom?: () => void;
  onRecordingUploaded?: (result: { permlink: string; cid: string; playUrl: string }) => void;
  videoEnabled?: boolean;
  /** Whether the room was created with video mode on — used to determine streaming layout */
  roomVideoEnabled?: boolean;
}

export function RoomControls({ isHost, roomName, onLeave, onEndRoom, onRecordingUploaded, videoEnabled = false, roomVideoEnabled = false }: RoomControlsProps) {
  const { localParticipant } = useLocalParticipant();
  const canPublish = localParticipant?.permissions?.canPublish ?? false;
  const isMuted = !localParticipant?.isMicrophoneEnabled;
  const isCameraOn = localParticipant?.isCameraEnabled ?? false;
  const isScreenSharing = localParticipant?.isScreenShareEnabled ?? false;
  const { isRaised, raiseHand, lowerHand } = useHandRaise();
  const prevCanPublish = useRef(canPublish);
  const [showStreaming, setShowStreaming] = useState(false);
  const [viewerUrl, setViewerUrl] = useState('');
  const { isStreaming, platform, isLoading, error, startStream, stopStream } = useStreaming(roomName);

  // Auto-lower hand when promoted
  useEffect(() => {
    if (canPublish && !prevCanPublish.current && isRaised) {
      lowerHand();
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
      {canPublish && (
        <button
          className={`hh-btn hh-btn--icon ${isMuted ? 'hh-btn--danger' : 'hh-btn--secondary'}`}
          onClick={toggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? '🔇' : '🎙️'}
        </button>
      )}

      {videoEnabled && canPublish && (
        <button
          className={`hh-btn hh-btn--icon ${isCameraOn ? 'hh-btn--secondary' : 'hh-btn--danger'}`}
          onClick={() => localParticipant?.setCameraEnabled(!isCameraOn)}
          title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
        >
          {isCameraOn ? '📹' : '📷'}
        </button>
      )}

      {videoEnabled && canPublish && (
        <button
          className={`hh-btn hh-btn--icon ${isScreenSharing ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
          onClick={() => localParticipant?.setScreenShareEnabled(!isScreenSharing)}
          title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
        >
          🖥️
        </button>
      )}

      {(!canPublish || isRaised) && (
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

      {isHost && (
        <button
          className={`hh-btn hh-btn--icon ${isStreaming ? 'hh-btn--live' : showStreaming ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
          onClick={() => setShowStreaming((v) => !v)}
          title={isStreaming ? 'Live — click to stop' : 'Go Live'}
        >
          🔴
        </button>
      )}

      {isHost && onEndRoom && (
        <button className="hh-btn hh-btn--danger" onClick={onEndRoom}>
          End room
        </button>
      )}

      {isHost && showStreaming && !isStreaming && (
        <StreamingPanel
          videoEnabled={roomVideoEnabled}
          isLoading={isLoading}
          error={error}
          onStart={handleStart}
          onClose={() => setShowStreaming(false)}
        />
      )}

      {isHost && showStreaming && isStreaming && platform && (
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
