import { useMemo, useEffect, useState } from 'react';
import {
  LiveKitRoom,
  useRoomInfo,
} from '@livekit/components-react';
import {
  HangoutsProvider,
  HangoutsApiClient,
  SpeakerStage,
  AudienceSection,
} from '@snapie/hangouts-react';
import { useChat, useBoosts } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const LIVEKIT_URL  = import.meta.env.VITE_LIVEKIT_URL || 'wss://livekit.3speak.tv';

function parseShow(raw: string | null): Set<string> {
  if (!raw) return new Set(['speakers', 'chat', 'audience', 'boost']);
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// ─── Read-only chat feed (no input) ────────────────────────────────────────

// Keep a generous buffer — the container height clips naturally at the top,
// so taller OBS windows show more messages without any config change.
const OBS_MSG_BUFFER = 60;

function ObsChatFeed() {
  const { messages } = useChat();

  const recent = messages.slice(-OBS_MSG_BUFFER);

  return (
    <div className="hh-chat" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* justify-content:flex-end pins messages to the bottom — new messages
          push old ones upward and off the top edge automatically. No scroll
          needed; the container height determines how many messages are visible. */}
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', flex: 1, overflow: 'hidden', padding: '0.75rem', gap: '0.5rem' }}>
        {recent.map((msg) => (
          <div key={msg.id} className="hh-chat__msg" style={{ flexShrink: 0 }}>
            <div className="hh-chat__msg-body">
              <span className="hh-chat__msg-name">{msg.name}</span>
              <span className="hh-chat__msg-text">{msg.text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ObsBoostFeed() {
  const { boosts } = useBoosts();
  const recent = boosts.slice(-12);

  return (
    <div className="hh-chat" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', flex: 1, overflow: 'hidden', padding: '0.75rem', gap: '0.5rem' }}>
        {recent.map((boost) => (
          <div key={boost.id} className="hh-chat__msg" style={{ flexShrink: 0 }}>
            <div className="hh-chat__msg-body">
              <span className="hh-chat__msg-name">
                Boost @{boost.displayName || boost.sender}
              </span>
              <span className="hh-chat__msg-text">
                {boost.message} - {boost.amount} {boost.asset}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Inside-LiveKit wrapper ─────────────────────────────────────────────────

interface RoomMeta {
  host?: string;
  recordLayout?: 'speaker' | 'grid' | 'single';
}

function useRoomMeta(): RoomMeta {
  const { metadata } = useRoomInfo();
  return useMemo(() => {
    if (!metadata) return {};
    try { return JSON.parse(metadata) as RoomMeta; } catch { return {}; }
  }, [metadata]);
}

function ObsRoomContent({ roomName, show }: { roomName: string; show: Set<string> }) {
  const meta = useRoomMeta();
  const host = meta.host ?? '';

  return (
    <div className="hh-obs">
      {show.has('speakers') && (
        <div className="hh-room__stage" style={{ flex: show.size > 1 ? '1' : undefined }}>
          <SpeakerStage
            hostIdentity={host}
            roomName={roomName}
            videoEnabled={true}
          />
        </div>
      )}
      {show.has('chat') && (
        <ObsChatFeed />
      )}
      {show.has('boost') && (
        <ObsBoostFeed />
      )}
      {show.has('audience') && (
        <AudienceSection
          hostIdentity={host}
          roomName={roomName}
        />
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function ObsOverlay() {
  const params  = new URLSearchParams(window.location.search);
  const roomName = params.get('room') ?? '';
  const show     = parseShow(params.get('show'));

  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomName) { setError('No room specified'); return; }
    const client = new HangoutsApiClient({ baseUrl: API_BASE_URL });
    client.joinAsObserver(roomName)
      .then(res => setToken(res.token))
      .catch(() => setError('Room not found or unavailable'));
  }, [roomName]);

  // Make the page body transparent for OBS
  useEffect(() => {
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    return () => {
      document.body.style.background = '';
      document.documentElement.style.background = '';
    };
  }, []);

  if (error) return null; // blank transparent frame on error — graceful in OBS

  if (!token) {
    return (
      <div className="hh-obs">
        <div className="hh-obs__connecting">Connecting…</div>
      </div>
    );
  }

  return (
    <HangoutsProvider apiBaseUrl={API_BASE_URL} livekitServerUrl={LIVEKIT_URL}>
      <LiveKitRoom
        token={token}
        serverUrl={LIVEKIT_URL}
        connect
        audio={false}
        video={false}
      >
        {/* No RoomAudioRenderer — OBS captures audio from desktop output, not the browser embed */}
        <ObsRoomContent roomName={roomName} show={show} />
      </LiveKitRoom>
    </HangoutsProvider>
  );
}
