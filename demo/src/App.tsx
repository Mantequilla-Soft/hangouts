import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import {
  HangoutsProvider,
  RoomLobby,
  HangoutsRoom,
  useHangoutsAuth,
} from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';
import { Aioha, KeyTypes } from '@aioha/aioha';
import { AiohaProvider, AiohaModal, useAioha } from '@aioha/react-ui';
import '@aioha/react-ui/dist/build.css';
import { EgressTemplate } from './EgressTemplate.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'wss://livekit.3speak.tv';
const IMAGE_SERVER_API_KEY = import.meta.env.VITE_IMAGE_SERVER_API_KEY;

// Module-level singleton: Aioha holds session state (persisted to
// localStorage) and re-instantiating it would lose the logged-in user
// across React re-renders. setup() registers the providers we want to
// offer in the modal (Keychain + PeakVault auto-detect from the page;
// HiveAuth needs an app identity).
const aioha = new Aioha();
aioha.setup({
  hiveauth: {
    name: 'Hive Hangouts',
    description: 'Live audio rooms on Hive',
  },
});

function getRoomFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/room\/([\w-]+)$/);
  return match ? match[1] : null;
}

function getInitialTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem('hh-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Once the user finishes Aioha's login flow (any provider), exchange
// that session for a hangouts session token. Runs inside HangoutsProvider
// so useHangoutsAuth() can see the api client.
function AuthBridge() {
  const { user } = useAioha();
  const { isAuthenticated, isLoading, login, logout } = useHangoutsAuth();

  useEffect(() => {
    if (user && !isAuthenticated && !isLoading) {
      void login(user).catch(() => { /* surfaced inside useHangoutsAuth().error */ });
    }
    if (!user && isAuthenticated) {
      logout();
    }
  }, [user, isAuthenticated, isLoading, login, logout]);

  return null;
}

function ConnectButton({ onOpen }: { onOpen: () => void }) {
  const { user, aioha: ai } = useAioha();
  if (user) {
    return (
      <button
        className="hh-btn hh-btn--secondary hh-btn--small"
        onClick={() => void ai.logout()}
        title={`Signed in as @${user}`}
      >
        Disconnect
      </button>
    );
  }
  return (
    <button className="hh-btn hh-btn--primary hh-btn--small" onClick={onOpen}>
      Connect Wallet
    </button>
  );
}

function MainApp() {
  const [activeRoom, setActiveRoom] = useState<string | null>(getRoomFromUrl);
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [modalOpen, setModalOpen] = useState(false);

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
      <div className="hh-app__theme-toggle" style={{ display: 'flex', gap: '0.5rem' }}>
        <ConnectButton onOpen={() => setModalOpen(true)} />
        <button onClick={toggleTheme} className="hh-btn hh-btn--secondary hh-btn--small">
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
      </div>
      <HangoutsProvider
        apiBaseUrl={API_BASE_URL}
        livekitServerUrl={LIVEKIT_URL}
        imageServerApiKey={IMAGE_SERVER_API_KEY}
        aioha={aioha}
      >
        <AuthBridge />
        {activeRoom ? (
          <HangoutsRoom
            roomName={activeRoom}
            onLeave={() => setActiveRoom(null)}
            embedded
            video
          />
        ) : (
          <RoomLobby
            onJoinRoom={(roomName) => setActiveRoom(roomName)}
            allowGuestBrowse
          />
        )}
      </HangoutsProvider>
      <AiohaModal
        displayed={modalOpen}
        onClose={setModalOpen as Dispatch<SetStateAction<boolean>>}
        loginTitle="Sign in to Hangouts"
        loginOptions={{
          msg: 'Sign in to Hive Hangouts',
          keyType: KeyTypes.Posting,
        }}
      />
    </div>
  );
}

export default function App() {
  if (window.location.pathname.startsWith('/egress-template')) {
    return <EgressTemplate />;
  }
  return (
    <AiohaProvider aioha={aioha}>
      <MainApp />
    </AiohaProvider>
  );
}
