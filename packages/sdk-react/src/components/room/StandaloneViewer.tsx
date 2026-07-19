import { useEffect, useMemo, useState } from 'react';
import { useParticipants, useTracks, VideoTrack } from '@livekit/components-react';
import { Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import type { BoostConfig } from '@snapie/hangouts-core';

type ViewerQuality = 'auto' | 'high' | 'medium' | 'low' | 'audio';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { ChatPanel } from './ChatPanel.js';
import { BoostOverlay } from './BoostOverlay.js';
import { SendBoostDialog } from './SendBoostDialog.js';

export interface StandaloneViewerProps {
  roomName: string;
  title: string;
  /** The streamer's identity — the only participant whose video we show. */
  hostIdentity: string | null;
  onLeave: () => void;
  isGuest?: boolean;
  boostConfig?: BoostConfig;
  /** Embed mode: render ONLY the program video (with a LIVE badge, viewer
   *  count and quality selector overlaid) — no header, no chat, no leave.
   *  For dropping the live player into a host page's own layout (e.g. the
   *  3Speak watch page). The integrator owns title/description/actions. */
  embed?: boolean;
}

/**
 * Watch-side of a standalone (one-man livestream) room. The host
 * publishes a single client-composited program feed; this component
 * renders that feed verbatim — so every viewer sees exactly what the
 * streamer sees in their studio preview — plus the room chat.
 * There is no attendees section in standalone mode by design.
 */
export function StandaloneViewer({ roomName, title, hostIdentity, onLeave, isGuest = false, boostConfig, embed = false }: StandaloneViewerProps) {
  const { isAuthenticated, username } = useHangoutsContext();
  const participants = useParticipants();
  const [boostDialogOpen, setBoostDialogOpen] = useState(false);
  const [quality, setQuality] = useState<ViewerQuality>('auto');

  // The studio publishes its composite with source=Camera. Prefer the
  // host's track; fall back to any remote camera track so a host-identity
  // mismatch degrades to "still watchable" instead of a black screen.
  const cameraTracks = useTracks([Track.Source.Camera]);
  const programTrack = useMemo(() => {
    const remote = cameraTracks.filter((t) => !t.participant.isLocal);
    return remote.find((t) => t.participant.identity === hostIdentity) ?? remote[0] ?? null;
  }, [cameraTracks, hostIdentity]);

  // Apply the viewer's quality choice to the program publication. Works via
  // the simulcast layers the studio publishes: High/Medium/Low pick a layer
  // (still adapts below it), Audio only stops the video download entirely,
  // Auto lets adaptiveStream manage it.
  useEffect(() => {
    const pub = programTrack?.publication as RemoteTrackPublication | undefined;
    if (!pub || typeof pub.setVideoQuality !== 'function') return;
    if (quality === 'audio') {
      pub.setEnabled(false);
      return;
    }
    pub.setEnabled(true);
    if (quality === 'high') pub.setVideoQuality(VideoQuality.HIGH);
    else if (quality === 'medium') pub.setVideoQuality(VideoQuality.MEDIUM);
    else if (quality === 'low') pub.setVideoQuality(VideoQuality.LOW);
    else pub.setVideoQuality(VideoQuality.HIGH); // 'auto' → allow up to full; adaptiveStream trims
  }, [quality, programTrack]);

  const hostPresent = participants.some((p) => p.identity === hostIdentity);
  const viewerCount = participants.filter(
    (p) => p.identity !== hostIdentity && !p.identity.startsWith('obs-'),
  ).length;

  const showBoostButton = boostConfig?.enabled !== false && isAuthenticated && !isGuest && !!username;

  const qualitySelect = (
    <label className="hh-studio__quality" title="Playback quality">
      <span aria-hidden="true">⚙️</span>
      <select value={quality} onChange={(e) => setQuality(e.target.value as ViewerQuality)} aria-label="Playback quality">
        <option value="auto">Auto</option>
        <option value="high">Highest</option>
        <option value="medium">Medium</option>
        <option value="low">Low · data saver</option>
        <option value="audio">Audio only</option>
      </select>
    </label>
  );

  // Embed mode — just the program video with overlaid live badge + controls.
  if (embed) {
    return (
      <div className="hh-studio__program hh-studio__program--embed">
        {programTrack ? (
          <VideoTrack trackRef={programTrack} className="hh-studio__program-video" />
        ) : (
          <div className="hh-studio__program-placeholder">
            {hostPresent ? 'Stream is starting…' : 'The streamer is offline'}
          </div>
        )}
        <div className="hh-studio__embed-top">
          <span className={`hh-studio__embed-live${hostPresent ? '' : ' hh-studio__embed-live--off'}`}>
            {hostPresent ? '● LIVE' : '○ OFFLINE'}
          </span>
          <span className="hh-studio__embed-viewers" title="Viewers watching">👁 {viewerCount}</span>
          {qualitySelect}
          {showBoostButton && (
            <button className="hh-btn hh-btn--boost hh-btn--small" onClick={() => setBoostDialogOpen(true)}>💸 Boost</button>
          )}
        </div>
        <BoostOverlay />
        {boostDialogOpen && (
          <SendBoostDialog roomName={roomName} boostConfig={boostConfig ?? { enabled: true, minBoostUsd: 0 }} onClose={() => setBoostDialogOpen(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="hh-studio hh-studio--viewer">
      <header className="hh-studio__header">
        <span className={`hh-studio__live${hostPresent ? '' : ' hh-studio__live--off'}`}>
          {hostPresent ? '● LIVE' : '○ OFFLINE'}
        </span>
        <h2 className="hh-studio__title">{title}</h2>
        <span className="hh-studio__viewers" title="Viewers watching">👁 {viewerCount}</span>
        <div className="hh-studio__header-actions">
          {qualitySelect}
          {showBoostButton && (
            <button className="hh-btn hh-btn--boost hh-btn--small" onClick={() => setBoostDialogOpen(true)}>
              💸 Boost
            </button>
          )}
          <button className="hh-btn hh-btn--secondary hh-btn--small" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      <div className="hh-studio__body hh-studio__body--viewer">
        <div className="hh-studio__program">
          {programTrack ? (
            <VideoTrack trackRef={programTrack} className="hh-studio__program-video" />
          ) : (
            <div className="hh-studio__program-placeholder">
              {hostPresent ? 'Stream is starting…' : 'The streamer is offline'}
            </div>
          )}
          <BoostOverlay />
        </div>

        <aside className="hh-studio__chat">
          <ChatPanel isGuest={isGuest} />
        </aside>
      </div>

      {boostDialogOpen && (
        <SendBoostDialog
          roomName={roomName}
          boostConfig={boostConfig ?? { enabled: true, minBoostUsd: 0 }}
          onClose={() => setBoostDialogOpen(false)}
        />
      )}
    </div>
  );
}
