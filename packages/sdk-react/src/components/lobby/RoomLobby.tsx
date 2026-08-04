import { useState, type ReactNode } from 'react';
import type { Room } from '@snapie/hangouts-core';
import { useHangoutsAuth } from '../../hooks/useHangoutsAuth.js';
import { useRoomList } from '../../hooks/useRoomList.js';
import { RoomCard } from './RoomCard.js';
import { CreateRoomDialog, type AnnounceType } from './CreateRoomDialog.js';
import type { RoomMode } from '@snapie/hangouts-core';

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
  /** Offer the "Quick snap" announcement type. ON by default; passed straight
   *  through to CreateRoomDialog. When false, announcements are post-only and
   *  the snap/post toggle is hidden. */
  allowSnapAnnounce?: boolean;
  /** Suppress the built-in "No active rooms. Start one!" empty state. OFF by
   *  default (the message shows). Integrators that present their own live
   *  listing / empty state can turn it off so it never appears. */
  hideEmptyState?: boolean;
  /** Land straight in the create-room wizard, never the lobby list — for
   *  integrators that host their own room listing elsewhere. OFF by default.
   *  The mode tiles still show (unlike a `defaultMode` deep-link). When the
   *  authed host cancels, `onCreateCancel` is called (e.g. navigate home);
   *  without it, cancelling falls back to the lobby. */
  createOnly?: boolean;
  /** Called when the host cancels the wizard in `createOnly` mode. */
  onCreateCancel?: () => void;
  /** Premium OVERRIDE, passed to CreateRoomDialog to unlock the recording
   *  options. Leave unset (the default): the SDK resolves premium itself from
   *  the hangouts API, so an integrator does not have to wire it. Pass a
   *  boolean only to force the answer. */
  isPremium?: boolean;
  /** Which kind of room the create dialog opens on. Straight through to
   *  CreateRoomDialog — see `defaultMode` there. */
  defaultMode?: RoomMode;
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

export function RoomLobby({ onJoinRoom, onRoomCreated, allowGuestBrowse = false, allowStandalone = false, defaultCreateOpen = false, renderAnnounceOptions, renderDescriptionEditor, fetchRooms, isPremium, defaultMode, allowSnapAnnounce = true, hideEmptyState = false, createOnly = false, onCreateCancel }: RoomLobbyProps) {
  const auth = useHangoutsAuth();
  const { rooms, isLoading, error } = useRoomList(fetchRooms);
  const [showCreate, setShowCreate] = useState(defaultCreateOpen);
  /**
   * Came straight from a "Group chat" / "Start stream" menu item, i.e. the host
   * already said what they want. The lobby's title, room list and New-room
   * button are all answers to a question they've already answered, so show just
   * the form. Cancelling drops back to the full lobby rather than a dead end.
   */
  const [directCreate, setDirectCreate] = useState(defaultCreateOpen && !!defaultMode);
  const leaveDirectCreate = () => { setDirectCreate(false); setShowCreate(false); };
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

  if ((directCreate || createOnly) && auth.isAuthenticated) {
    return (
      <div className="hh-lobby hh-lobby--direct">
        <CreateRoomDialog
          onCreated={handleCreated}
          onCancel={createOnly ? (onCreateCancel ?? leaveDirectCreate) : leaveDirectCreate}
          allowStandalone={allowStandalone}
          renderAnnounceOptions={renderAnnounceOptions}
          renderDescriptionEditor={renderDescriptionEditor}
          isPremium={isPremium}
          defaultMode={defaultMode}
          allowSnapAnnounce={allowSnapAnnounce}
        />
      </div>
    );
  }

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
          defaultMode={defaultMode}
          allowSnapAnnounce={allowSnapAnnounce}
          renderDescriptionEditor={renderDescriptionEditor}
        />
      )}

      {isLoading && <div className="hh-lobby__empty">Loading rooms...</div>}
      {error && <div className="hh-lobby__empty" style={{ color: '#e31337' }}>{error}</div>}

      {!isLoading && !hideEmptyState && rooms.length === 0 && (
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
