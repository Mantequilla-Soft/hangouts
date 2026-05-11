import { useState, useEffect } from 'react';
import {
  HangoutsProvider,
  RoomLobby,
  HangoutsRoom,
  useHangoutsAuth,
} from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';
import { EgressTemplate } from './EgressTemplate.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'wss://livekit.3speak.tv';
const IMAGE_SERVER_API_KEY = import.meta.env.VITE_IMAGE_SERVER_API_KEY;

function getRoomFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/room\/([\w-]+)$/);
  return match ? match[1] : null;
}

function getInitialTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem('hh-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Tiny Keychain sign-in button used on the lobby. The SDK's RoomLobby
// shows its own `@username + Logout` cluster once authenticated, so we
// only render this when the user isn't signed in yet.
//
// We deliberately don't gate the button on isKeychainAvailable. The
// Keychain extension injects `window.hive_keychain` asynchronously and
// there's no event we can subscribe to, so checking once at render
// risks a false negative when the page beats the extension. If
// Keychain genuinely isn't installed by the time the user clicks, the
// SDK throws a clear "Hive Keychain extension is not installed" error
// which surfaces in the alert below.
function SignInButton() {
  const { isAuthenticated, login, isLoading } = useHangoutsAuth();
  if (isAuthenticated) return null;
  const onClick = async () => {
    const name = window.prompt('Hive username:');
    if (!name) return;
    try {
      await login(name.trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(msg);
    }
  };
  return (
    <button className="hh-btn hh-btn--primary hh-btn--small" disabled={isLoading} onClick={onClick}>
      {isLoading ? 'Signing in…' : 'Sign In'}
    </button>
  );
}

function MainApp() {
  const [activeRoom, setActiveRoom] = useState<string | null>(getRoomFromUrl);
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('hh-theme', next);
  };

  useEffect(() => {
    if (activeRoom) {
      window.history.pushState(null, '', `/room/${activeRoom}`);
    } else if (window.location.pathname !== '/') {
      window.history.pushState(null, '', '/');
    }
  }, [activeRoom]);

  useEffect(() => {
    const onPopState = () => setActiveRoom(getRoomFromUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <div data-hh-theme={theme} className="hh-app">
      <HangoutsProvider
        apiBaseUrl={API_BASE_URL}
        livekitServerUrl={LIVEKIT_URL}
        imageServerApiKey={IMAGE_SERVER_API_KEY}
      >
        {!activeRoom && (
          <div className="hh-app__theme-toggle" style={{ display: 'flex', gap: '0.5rem' }}>
            <SignInButton />
            <button onClick={toggleTheme} className="hh-btn hh-btn--secondary hh-btn--small">
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>
        )}
        {activeRoom ? (
          <div className="hh-demo-overlay">
            <div className="hh-demo-modal" data-hh-theme={theme}>
              <HangoutsRoom
                roomName={activeRoom}
                onLeave={() => setActiveRoom(null)}
                embedded
                video
                guestFallback
              />
            </div>
          </div>
        ) : (
          <RoomLobby
            onJoinRoom={(roomName) => setActiveRoom(roomName)}
            allowGuestBrowse
          />
        )}
      </HangoutsProvider>
    </div>
  );
}

export default function App() {
  if (window.location.pathname.startsWith('/egress-template')) {
    return <EgressTemplate />;
  }
  return <MainApp />;
}
