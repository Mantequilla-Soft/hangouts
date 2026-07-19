import { useState, type ReactNode } from 'react';
import type { Room } from '@snapie/hangouts-core';
import { useHangoutsAuth } from '../../hooks/useHangoutsAuth.js';
import { useRoomList } from '../../hooks/useRoomList.js';
import { RoomCard } from './RoomCard.js';
import { CreateRoomDialog, type AnnounceType } from './CreateRoomDialog.js';

export interface RoomLobbyProps {
  onJoinRoom: (roomName: string) => void;
  /** Fired when the user creates a room. The second argument carries
   *  the announcement preference the user picked in the create dialog
   *  (whether to post on Hive, and as a snap or a full post). Optional
   *  second arg preserves backwards compatibility with older integrators. */
  onRoomCreated?: (room: Room, options?: { notifyOnHive: boolean; announceType: AnnounceType }) => void;
  /** When true, unauthenticated visitors see the room list and can
   *  join as listen-only guests instead of being shown the sign-in
   *  form. Create / host actions stay hidden for guests. Default
   *  false to preserve the original auth-gated behaviour. */
  allowGuestBrowse?: boolean;
  /** Expose the "Standalone livestream studio" mode in the create dialog.
   *  Off by default — hides the mode dropdown so all rooms are conferences. */
  allowStandalone?: boolean;
  /** Renders integrator-owned Hive announcement controls (payout,
   *  beneficiaries, community picker) inside the create dialog. Passed
   *  straight through to CreateRoomDialog. */
  renderAnnounceOptions?: (announceType: AnnounceType) => ReactNode;
  /** 3Speak Pro host — passed to CreateRoomDialog to unlock the recording
   *  options. */
  isPremium?: boolean;
  /** Replaces the create dialog's built-in description field with an
   *  integrator markdown editor (e.g. 3Speak's MarkdownComposer). */
  renderDescriptionEditor?: (value: string, onChange: (v: string) => void) => ReactNode;
  /** Open the create-room form immediately on mount — for integrators whose
   *  "Go live" entry point should land on the form rather than the lobby list.
   *  Still gated on being signed in, so it appears once auth lands. */
  defaultCreateOpen?: boolean;
  /** Override where the room list comes from — e.g. aggregated across several
   *  OpenPods deployments. Must be stable (useCallback) or the poll restarts. */
  fetchRooms?: () => Promise<Room[]>;
}

export function RoomLobby({ onJoinRoom, onRoomCreated, allowGuestBrowse = false, allowStandalone = false, defaultCreateOpen = false, renderAnnounceOptions, renderDescriptionEditor, fetchRooms, isPremium = false }: RoomLobbyProps) {
  const auth = useHangoutsAuth();
  const { rooms, isLoading, error } = useRoomList(fetchRooms);
  const [showCreate, setShowCreate] = useState(defaultCreateOpen);
  const [loginUsername, setLoginUsername] = useState('');

  // Login screen — skipped when the integrator opted in to guest
  // browsing, in which case unauth visitors fall straight through to
  // the rooms list (Create button stays hidden until they sign in).
  if (!auth.isAuthenticated && !allowGuestBrowse) {
    return (
      <div className="hh-lobby">
        <h1 className="hh-lobby__title">OpenPods Rooms</h1>
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

  const handleCreated = (room: Room, options: { notifyOnHive: boolean; announceType: AnnounceType }) => {
    setShowCreate(false);
    onRoomCreated?.(room, options);
    onJoinRoom(room.name);
  };

  return (
    <div className="hh-lobby">
      <div className="hh-lobby__header">
        <h1 className="hh-lobby__title">OpenPods Rooms</h1>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {auth.isAuthenticated ? (
            <>
              <span style={{ fontSize: '0.85rem', color: '#666' }}>@{auth.username}</span>
              <button className="hh-btn hh-btn--primary hh-btn--small" onClick={() => setShowCreate(!showCreate)}>
                {showCreate ? 'Cancel' : '+ New room'}
              </button>
              <button className="hh-btn hh-btn--secondary hh-btn--small" onClick={auth.logout}>
                Logout
              </button>
            </>
          ) : (
            <span style={{ fontSize: '0.85rem', color: '#666' }}>Browsing as guest</span>
          )}
        </div>
      </div>

      {auth.isAuthenticated && showCreate && (
        <CreateRoomDialog
          onCreated={handleCreated}
          onCancel={() => setShowCreate(false)}
          allowStandalone={allowStandalone}
          renderAnnounceOptions={renderAnnounceOptions}
          isPremium={isPremium}
          renderDescriptionEditor={renderDescriptionEditor}
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
