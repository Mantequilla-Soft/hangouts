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
    try {
      const result = await recording.stopRecording();
      console.log('[Hangouts] Recording stopped:', result);
      setShowUpload(true);
    } catch (err) {
      console.error('[Hangouts] Failed to stop recording:', err);
    }
  };

  const handleUpload = async () => {
    try {
      const tags = ['hangout', 'podcast', 'hive'];
      const result = await recording.uploadRecording(uploadTitle || undefined, tags);
      console.log('[Hangouts] Upload complete:', result);
      // Don't hide the dialog — show the result
    } catch (err) {
      console.error('[Hangouts] Upload failed:', err);
    }
  };

  const handleDiscard = () => {
    setShowUpload(false);
    setUploadTitle('');
  };

  // Show upload result
  if (recording.uploadResult) {
    return (
      <div className="hh-recording-upload">
        <div className="hh-recording-upload__success">
          Uploaded to IPFS
        </div>
        <a
          href={recording.uploadResult.playUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hh-recording-upload__link"
        >
          {recording.uploadResult.playUrl}
        </a>
        <button
          className="hh-btn hh-btn--secondary hh-btn--small"
          onClick={handleDiscard}
        >
          Done
        </button>
      </div>
    );
  }

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
            onClick={handleDiscard}
          >
            Discard
          </button>
        </div>
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
