import { useState, useEffect } from 'react';
import { HangoutsProvider, RoomLobby, HangoutsRoom } from '@hive-hangouts/react';
import '@hive-hangouts/react/src/styles/hangouts.css';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'wss://livekit.3speak.tv';

function getRoomFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/room\/([\w-]+)$/);
  return match ? match[1] : null;
}

export default function App() {
  const [activeRoom, setActiveRoom] = useState<string | null>(getRoomFromUrl);

  // Sync URL with room state
  useEffect(() => {
    if (activeRoom) {
      window.history.pushState(null, '', `/room/${activeRoom}`);
    } else if (window.location.pathname !== '/') {
      window.history.pushState(null, '', '/');
    }
  }, [activeRoom]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => setActiveRoom(getRoomFromUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <HangoutsProvider apiBaseUrl={API_BASE_URL} livekitServerUrl={LIVEKIT_URL}>
      {activeRoom ? (
        <HangoutsRoom
          roomName={activeRoom}
          onLeave={() => setActiveRoom(null)}
        />
      ) : (
        <RoomLobby
          onJoinRoom={(roomName) => setActiveRoom(roomName)}
        />
      )}
    </HangoutsProvider>
  );
}
