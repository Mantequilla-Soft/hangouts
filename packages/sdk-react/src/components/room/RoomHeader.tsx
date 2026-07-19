import { useState } from 'react';
import { useParticipants } from '@livekit/components-react';
import { useRecording } from '../../hooks/useRecording.js';
import { RecordingIndicator } from './RecordingControls.js';
import { HeadphonesIcon } from '../icons/HeadphonesIcon.js';
import { renderMarkdown, stripMarkdown, truncate } from '../../lib/markdown.js';

export interface RoomHeaderProps {
  title: string;
  /** Kept for API compatibility; the host is shown via their participant tile, not in the header. */
  host?: string;
  description?: string;
  roomName?: string;
  /** When true, show a small badge so the user knows they're in
   *  listen-only mode and what they can/can't do. */
  isGuest?: boolean;
  /** When set, renders a Share button that copies this URL on click
   *  (and tries Web Share API first on mobile). Integrators compute
   *  the URL from room metadata so the SDK stays generic. */
  shareUrl?: string | null;
}

export function RoomHeader({ title, description, roomName, isGuest, shareUrl }: RoomHeaderProps) {
  const participants = useParticipants();
  const recording = useRecording(roomName ?? null);
  const [copied, setCopied] = useState(false);
  const [descOpen, setDescOpen] = useState(false);

  // Under the title we show a PLAIN one-liner: markdown syntax stripped and cut
  // to 50 characters. The full text (rendered) lives behind "Show more".
  const descPlain = stripMarkdown(description || '');
  const descPreview = truncate(descPlain, 50);

  // Split the participant count into "speaking" vs "listening".
  // Exclude obs- observer identities — they're OBS overlay connections, not real people.
  const realParticipants = participants.filter((p) => !p.identity.startsWith('obs-'));
  const guestCount = realParticipants.filter((p) => p.identity.startsWith('guest-')).length;
  const speakerCount = realParticipants.length - guestCount;

  const handleShare = async () => {
    if (!shareUrl) return;
    // Prefer the OS share sheet on mobile; fall back to clipboard. The
    // share-sheet path is also gated to secure contexts on most browsers,
    // matching the clipboard requirement.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url: shareUrl });
        return;
      } catch {
        // user cancelled or browser refused — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link', shareUrl);
    }
  };

  return (
    <div className="hh-room__header">
      <div className="hh-room__title-block">
        <h2 className="hh-room__title">
          {title} <RecordingIndicator isRecording={recording.isRecording} elapsed={recording.elapsed} />
        </h2>
        {descPlain && (
          <p className="hh-room__description">
            {descPreview.text}
            {descPreview.truncated && (
              <button type="button" className="hh-room__description-more" onClick={() => setDescOpen(true)}>
                Show more
              </button>
            )}
          </p>
        )}
        {isGuest && (
          <span className="hh-room__guest-badge" title="You're listening as a guest. Sign in with Hive Keychain to speak or chat.">
            <HeadphonesIcon size={14} />
            Listening as guest
          </span>
        )}
      </div>
      <div className="hh-room__header-right">
        <div className="hh-room__count">
          {guestCount > 0
            ? `${speakerCount} in conversation · ${guestCount} listening`
            : `${realParticipants.length} in room`}
        </div>
        {shareUrl && (
          <button
            type="button"
            className="hh-btn hh-btn--secondary hh-btn--small hh-room__share"
            onClick={handleShare}
            title={copied ? 'Link copied!' : 'Copy share link'}
          >
            {copied ? '✓ Copied' : '🔗 Share'}
          </button>
        )}
      </div>

      {descOpen && (
        <div className="hh-room__desc-overlay" onClick={(e) => { if (e.target === e.currentTarget) setDescOpen(false); }}>
          <div className="hh-room__desc-modal" role="dialog" aria-label="Room description">
            <div className="hh-room__desc-head">
              <span>{title}</span>
              <button type="button" className="hh-room__desc-close" onClick={() => setDescOpen(false)} title="Close">×</button>
            </div>
            <div
              className="hh-room__desc-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(description || '') }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
