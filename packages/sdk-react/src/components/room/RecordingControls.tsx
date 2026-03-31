import { useState } from 'react';
import { useRecording } from '../../hooks/useRecording.js';

export interface RecordingControlsProps {
  roomName: string;
}

export function RecordingControls({ roomName }: RecordingControlsProps) {
  const recording = useRecording(roomName);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');

  const handleStop = async () => {
    await recording.stopRecording();
    setShowUpload(true);
  };

  const handleUpload = async () => {
    const tags = ['hangout', 'podcast', 'hive'];
    await recording.uploadRecording(uploadTitle || undefined, tags);
    setShowUpload(false);
    setUploadTitle('');
  };

  // Show upload dialog after recording stops
  if (showUpload && recording.filePath) {
    return (
      <div className="hh-recording-upload">
        <div className="hh-recording-upload__info">
          Recording ready ({Math.round(recording.duration || 0)}s)
        </div>
        <input
          className="hh-create-dialog__input"
          type="text"
          placeholder="Title (optional, defaults to room name)"
          value={uploadTitle}
          onChange={(e) => setUploadTitle(e.target.value)}
        />
        <div className="hh-recording-upload__actions">
          <button
            className="hh-btn hh-btn--primary hh-btn--small"
            onClick={handleUpload}
            disabled={recording.isLoading}
          >
            {recording.isLoading ? 'Uploading...' : 'Upload to IPFS'}
          </button>
          <button
            className="hh-btn hh-btn--secondary hh-btn--small"
            onClick={() => setShowUpload(false)}
          >
            Discard
          </button>
        </div>
        {recording.uploadResult && (
          <div className="hh-recording-upload__success">
            Uploaded! Play: {recording.uploadResult.playUrl}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      className={`hh-btn hh-btn--small ${recording.isRecording ? 'hh-btn--danger' : 'hh-btn--secondary'}`}
      onClick={recording.isRecording ? handleStop : recording.startRecording}
      disabled={recording.isLoading}
    >
      {recording.isRecording ? '⏹ Stop Rec' : '⏺ Record'}
    </button>
  );
}

export function RecordingIndicator({ isRecording }: { isRecording: boolean }) {
  if (!isRecording) return null;

  return (
    <span className="hh-recording-indicator">
      <span className="hh-recording-indicator__dot" />
      REC
    </span>
  );
}
