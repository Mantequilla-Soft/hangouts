import { useState } from 'react';
import type { Room } from '@snapie/hangouts-core';
import { useHangoutsAuth } from '../../hooks/useHangoutsAuth.js';
import { useRoomList } from '../../hooks/useRoomList.js';
import { RoomCard } from './RoomCard.js';
import { CreateRoomDialog } from './CreateRoomDialog.js';

export interface RoomLobbyProps {
  onJoinRoom: (roomName: string) => void;
  onRoomCreated?: (room: Room) => void;
}

export function RoomLobby({ onJoinRoom, onRoomCreated }: RoomLobbyProps) {
  const auth = useHangoutsAuth();
  const { rooms, isLoading, error } = useRoomList();
  const [showCreate, setShowCreate] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');

  // Login screen
  if (!auth.isAuthenticated) {
    return (
      <div className="hh-lobby">
        <h1 className="hh-lobby__title">Hive Hangouts</h1>
        <div className="hh-lobby__auth">
          <p>Sign in with your Hive account to join or create audio rooms.</p>
          {!auth.isKeychainAvailable && (
            <p style={{ color: '#e31337' }}>
              Hive Keychain extension not detected. Please install it to continue.
            </p>
          )}
          <div>
            <input
              className="hh-lobby__auth-input"
              type="text"
              placeholder="Hive username"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loginUsername && auth.login(loginUsername)}
            />
            <button
              className="hh-btn hh-btn--primary"
              disabled={!loginUsername || auth.isLoading || !auth.isKeychainAvailable}
              onClick={() => auth.login(loginUsername)}
            >
              {auth.isLoading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
          {auth.error && <p style={{ color: '#e31337', marginTop: '0.5rem' }}>{auth.error}</p>}
        </div>
      </div>
    );
  }

  const handleCreated = (room: Room) => {
    setShowCreate(false);
    onRoomCreated?.(room);
    onJoinRoom(room.name);
  };

  return (
    <div className="hh-lobby">
      <div className="hh-lobby__header">
        <h1 className="hh-lobby__title">Hangouts</h1>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem', color: '#666' }}>@{auth.username}</span>
          <button className="hh-btn hh-btn--primary hh-btn--small" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? 'Cancel' : '+ New room'}
          </button>
          <button className="hh-btn hh-btn--secondary hh-btn--small" onClick={auth.logout}>
            Logout
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateRoomDialog
          onCreated={handleCreated}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {isLoading && <div className="hh-lobby__empty">Loading rooms...</div>}
      {error && <div className="hh-lobby__empty" style={{ color: '#e31337' }}>{error}</div>}

      {!isLoading && rooms.length === 0 && (
        <div className="hh-lobby__empty">
          No active rooms. Start one!
        </div>
      )}

      {rooms.map((room) => (
        <RoomCard key={room.name} room={room} onJoin={onJoinRoom} />
      ))}
    </div>
  );
}
