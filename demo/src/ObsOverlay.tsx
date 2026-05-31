import { useMemo, useEffect, useRef, useState } from 'react';
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
import { useChat } from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const LIVEKIT_URL  = import.meta.env.VITE_LIVEKIT_URL || 'wss://livekit.3speak.tv';

function parseShow(raw: string | null): Set<string> {
  if (!raw) return new Set(['speakers', 'chat', 'audience']);
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// ─── Read-only chat feed (no input) ────────────────────────────────────────

const OBS_MAX_MESSAGES = 8; // only show recent messages — no scrolling needed

function ObsChatFeed() {
  const { messages } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Always scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Only show the most recent N messages so the overlay stays current without scrolling
  const recent = messages.slice(-OBS_MAX_MESSAGES);

  return (
    <div className="hh-chat" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="hh-chat__messages" style={{ flex: 1, overflowY: 'hidden' }}>
        {recent.length === 0 && (
          <div className="hh-chat__empty">No messages yet</div>
        )}
        {recent.map((msg) => (
          <div key={msg.id} className="hh-chat__msg">
            <div className="hh-chat__msg-body">
              <span className="hh-chat__msg-name">{msg.name}</span>
              <span className="hh-chat__msg-text">{msg.text}</span>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
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
