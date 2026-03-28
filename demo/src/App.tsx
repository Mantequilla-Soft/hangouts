import { useState } from 'react';
import { HangoutsProvider, RoomLobby, HangoutsRoom } from '@hive-hangouts/react';
import '@hive-hangouts/react/src/styles/hangouts.css';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'wss://livekit.3speak.tv';

export default function App() {
  const [activeRoom, setActiveRoom] = useState<string | null>(null);

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
