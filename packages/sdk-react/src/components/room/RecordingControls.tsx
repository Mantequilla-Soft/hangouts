import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecordingMode, RecordingLayout } from '@snapie/hangouts-core';
import { useRecording } from '../../hooks/useRecording.js';

export interface RecordingControlsProps {
  roomName: string;
  /** Hand a finished VIDEO recording to the integrator. When omitted,
   *  the post-stop dialog hides the Upload button for video — the host
   *  can still Download or Dismiss. The SDK no longer carries a default
   *  studio URL; integrators own the publish destination. */
  onVideoHandoff?: (file: { blob: Blob; filename: string; duration: number; size: number }) => void;
  /** Hand a finished AUDIO recording to the integrator. Same gating as
   *  `onVideoHandoff`: omit it to suppress the Upload button. */
  onAudioHandoff?: (file: { blob: Blob; filename: string; duration: number; size: number }) => void;
  /** Default mode picked when there's no existing session. */
  defaultMode?: RecordingMode;
  /** Default layout for video recordings. */
  defaultLayout?: RecordingLayout;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function RecordingControls({
  roomName,
  onVideoHandoff,
  onAudioHandoff,
  defaultMode = 'audio',
  defaultLayout = 'grid',
}: RecordingControlsProps) {
  const recording = useRecording(roomName);
  const [pendingMode, setPendingMode] = useState<RecordingMode>(defaultMode);
  const [showUpload, setShowUpload] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const handleStart = async () => {
    setStartError(null);
    try {
      // Layout is taken from the room metadata (set via the host's Layout
      // dropdown); recording follows the live view WYSIWYG.
      await recording.startRecording({ mode: pendingMode, layout: defaultLayout });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start recording';
      setStartError(msg);
    }
  };

  const handleStop = async () => {
    try {
      await recording.stopRecording();
      setShowUpload(true);
    } catch (err) {
      console.error('[Hangouts] Failed to stop recording:', err);
    }
  };

  const handleDiscard = () => {
    setShowUpload(false);
    recording.reset();
  };

  const handleDownloadFile = async () => {
    // Same path for audio and video — the hook fetches via downloadToken
    // and triggers a browser download regardless of MIME type.
    try {
      await recording.downloadVideoFile();
    } catch (err) {
      console.error('[Hangouts] Recording download failed:', err);
    }
  };

  /**
   * Hand the recorded blob to the integrator. The SDK no longer ships
   * a default publish destination — the host's frontend is responsible
   * for routing the file into its own studio / podcast / IPFS / etc.
   * flow with the host's own auth.
   */
  const handleHandoff = async (
    callback: (file: { blob: Blob; filename: string; duration: number; size: number }) => void,
  ) => {
    try {
      const file = recording.videoFile ?? await recording.fetchVideoFile();
      if (!file) return;
      callback(file);
      // Reset local state so the integrator's flow runs clean and the
      // host returns to the idle Record button when they come back.
      handleDiscard();
    } catch (err) {
      console.error('[Hangouts] Recording handoff failed:', err);
    }
  };

  // Post-stop dialog: pick what to do with the file. Upload is gated on
  // the integrator wiring the matching handoff callback for the mode
  // that was recorded — Download and Dismiss are always available so
  // the host can still rescue or discard the recording.
  if (showUpload && recording.filePath) {
    const isVideo = recording.mode === 'video';
    const handoffCallback = isVideo ? onVideoHandoff : onAudioHandoff;
    return (
      <div className="hh-recording-upload">
        <div className="hh-recording-upload__info">
          {isVideo ? 'Video' : 'Audio'} recording ready ({Math.round(recording.duration || 0)}s)
        </div>

        <div className="hh-recording-upload__actions">
          {handoffCallback && (
            <button
              className="hh-btn hh-btn--primary hh-btn--small"
              onClick={() => handleHandoff(handoffCallback)}
              disabled={recording.isLoading}
            >
              {recording.isLoading ? 'Fetching…' : '⬆ Upload'}
            </button>
          )}
          <button
            className="hh-btn hh-btn--secondary hh-btn--small"
            onClick={handleDownloadFile}
            disabled={recording.isLoading}
            title={isVideo ? 'Download the MP4 to your computer' : 'Download the audio file to your computer'}
          >
            ⬇ Download
          </button>
          <button className="hh-btn hh-btn--secondary hh-btn--small" onClick={handleDiscard}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // Active recording: just stop. Layout follows the room-level "Layout"
  // host control — recording is WYSIWYG with the live view.
  if (recording.isRecording) {
    return (
      <div className="hh-recording-active">
        <button
          className="hh-btn hh-btn--small hh-btn--danger"
          onClick={handleStop}
          disabled={recording.isLoading}
        >
          ⏹ Stop ({formatTime(recording.elapsed)})
        </button>
      </div>
    );
  }

  // Idle: pick audio/video mode and start. Layout is no longer set here —
  // the host's room-layout dropdown drives both the live view and the
  // recording so they match (WYSIWYG).
  return (
    <div className="hh-recording-idle">
      <select
        className="hh-btn hh-btn--small hh-btn--secondary"
        value={pendingMode}
        onChange={(e) => setPendingMode(e.target.value as RecordingMode)}
        disabled={recording.isLoading}
        title="Recording mode"
      >
        <option value="audio">🎙️ Audio</option>
        <option value="video">🎥 Video</option>
      </select>

      <button
        className="hh-btn hh-btn--small hh-btn--secondary"
        onClick={handleStart}
        disabled={recording.isLoading}
      >
        ⏺ Record
      </button>

      {startError && (
        <RecordingStartErrorModal
          message={startError}
          onClose={() => setStartError(null)}
        />
      )}
    </div>
  );
}

/**
 * Modal that surfaces start-recording failures (e.g. the "Video
 * recording requires a 3Speak Pro subscription" gate). Centered
 * floating card with backdrop + dismiss button — much harder to miss
 * than the previous inline red text.
 */
function RecordingStartErrorModal({ message, onClose }: { message: string; onClose: () => void }) {
  // Highlight the premium-gate case with a friendlier title; fall back
  // to a generic "Couldn't start recording" header for other failures.
  const isPremiumGate = /pro subscription|premium/i.test(message);
  // Portal to <body> so the backdrop-filter on `.hh-controls` (an
  // ancestor of this component) doesn't trap our fixed-positioned
  // overlay — fixed positioning is contained by ancestors that create
  // a stacking context via transform/filter/backdrop-filter, which
  // would otherwise pin this modal to the controls bar instead of the
  // viewport.
  const overlay = (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          background: 'rgba(28, 28, 42, 0.98)',
          color: '#fff',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 12,
          maxWidth: 420,
          width: '100%',
          padding: '1.25rem 1.4rem',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.65)',
        }}
      >
        <div style={{
          fontSize: '1.05rem',
          fontWeight: 700,
          marginBottom: '0.5rem',
        }}>
          {isPremiumGate ? 'Pro subscription required' : "Couldn't start recording"}
        </div>
        <div style={{
          fontSize: '0.9rem',
          lineHeight: 1.45,
          color: 'rgba(255, 255, 255, 0.85)',
          marginBottom: '1rem',
        }}>
          {message}
          {isPremiumGate && (
            <>
              <br /><br />
              Both audio and video recordings require an active <strong>3Speak Pro</strong> subscription. Hosts can still go live and chat for free — only the recording capture is gated.
            </>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="hh-btn hh-btn--primary"
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return overlay;
  return createPortal(overlay, document.body);
}

export interface RecordingIndicatorProps {
  isRecording: boolean;
  elapsed?: number;
}

export function RecordingIndicator({ isRecording, elapsed = 0 }: RecordingIndicatorProps) {
  if (!isRecording) return null;

  return (
    <span className="hh-recording-indicator">
      <span className="hh-recording-indicator__dot" />
      REC {formatTime(elapsed)}
    </span>
  );
}
