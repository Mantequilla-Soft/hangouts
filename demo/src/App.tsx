import { useState, useEffect, useCallback } from 'react';
import {
  HangoutsProvider,
  RoomLobby,
  HangoutsRoom,
  useHangoutsAuth,
  useHangoutsContext,
  useEventList,
  type HangoutsEvent,
  type CreateEventInput,
} from '@snapie/hangouts-react';
import '@snapie/hangouts-react/src/styles/hangouts.css';
import { EgressTemplate } from './EgressTemplate.js';
import { ObsOverlay } from './ObsOverlay.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3002';
const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || 'wss://livekit.3speak.tv';
const IMAGE_SERVER_API_KEY = import.meta.env.VITE_IMAGE_SERVER_API_KEY;

type LobbyTab = 'live' | 'upcoming';

function getRoomFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/room\/([\w-]+)$/);
  return match ? match[1] : null;
}

function getInitialTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem('hh-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ─── Sign-in button ────────────────────────────────────────────────────────

function SignInButton() {
  const { isAuthenticated, login, isLoading } = useHangoutsAuth();
  if (isAuthenticated) return null;
  const onClick = async () => {
    const name = window.prompt('Hive username:');
    if (!name) return;
    try {
      await login(name.trim());
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <button className="hh-btn hh-btn--primary hh-btn--small" disabled={isLoading} onClick={onClick}>
      {isLoading ? 'Signing in…' : 'Sign In'}
    </button>
  );
}

// ─── Schedule event form ───────────────────────────────────────────────────

interface ScheduleFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

function ScheduleEventForm({ onCreated, onCancel }: ScheduleFormProps) {
  const { apiClient } = useHangoutsContext();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const minDateTime = new Date(Date.now() + 5 * 60 * 1000)
    .toISOString()
    .slice(0, 16);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const input: CreateEventInput = {
        title: title.trim(),
        description: description.trim() || undefined,
        scheduledAt: new Date(scheduledAt).toISOString(),
        visibility,
        tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      };
      await apiClient.createEvent(input);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to schedule event');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hh-event-form-overlay" onClick={onCancel}>
      <form
        className="hh-event-form"
        onClick={e => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3 className="hh-event-form__title">Schedule an Event</h3>

        <label className="hh-event-form__label">
          Title *
          <input
            className="hh-event-form__input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Weekly AMA"
            maxLength={100}
            required
          />
        </label>

        <label className="hh-event-form__label">
          Description
          <textarea
            className="hh-event-form__input hh-event-form__textarea"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Tell listeners what this is about…"
            maxLength={500}
            rows={3}
          />
        </label>

        <label className="hh-event-form__label">
          Date & time *
          <input
            type="datetime-local"
            className="hh-event-form__input"
            value={scheduledAt}
            min={minDateTime}
            onChange={e => setScheduledAt(e.target.value)}
            required
          />
        </label>

        <label className="hh-event-form__label">
          Visibility
          <select
            className="hh-event-form__input"
            value={visibility}
            onChange={e => setVisibility(e.target.value as 'public' | 'unlisted')}
          >
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
          </select>
        </label>

        <label className="hh-event-form__label">
          Tags (comma-separated)
          <input
            className="hh-event-form__input"
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder="ama, hive, defi"
          />
        </label>

        {error && <p className="hh-event-form__error">{error}</p>}

        <div className="hh-event-form__actions">
          <button type="button" className="hh-btn hh-btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="hh-btn hh-btn--primary" disabled={saving}>
            {saving ? 'Scheduling…' : 'Schedule Event'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Single event card ─────────────────────────────────────────────────────

interface EventCardProps {
  event: HangoutsEvent;
  currentUsername: string | null;
  onJoin: (roomName: string) => void;
  onRefresh: () => void;
}

function EventCard({ event, currentUsername, onJoin, onRefresh }: EventCardProps) {
  const { apiClient } = useHangoutsContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isHost = currentUsername === event.hostUsername;
  const isAttending = currentUsername ? event.attendees.includes(currentUsername) : false;
  const isLive = event.status === 'live';

  const scheduledDate = new Date(event.scheduledAt);
  const dateStr = scheduledDate.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  const timeStr = scheduledDate.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, [onRefresh]);

  const handleAttend = () => act(() =>
    isAttending ? apiClient.unattendEvent(event.id) : apiClient.attendEvent(event.id)
  );

  const handleGoLive = () => act(async () => {
    const { event: started, token } = await apiClient.startEvent(event.id);
    onJoin(started.roomName!);
    return token;
  });

  const handleCancel = () => {
    if (!window.confirm('Cancel this event?')) return;
    act(() => apiClient.cancelEvent(event.id));
  };

  return (
    <div className={`hh-event-card ${isLive ? 'hh-event-card--live' : ''}`}>
      <div className="hh-event-card__header">
        <div className="hh-event-card__meta">
          {isLive && <span className="hh-event-card__live-badge">● LIVE</span>}
          <span className="hh-event-card__host">@{event.hostUsername}</span>
          {event.visibility === 'unlisted' && (
            <span className="hh-event-card__unlisted">unlisted</span>
          )}
        </div>
        <div className="hh-event-card__time">{dateStr} · {timeStr}</div>
      </div>

      <h3 className="hh-event-card__title">{event.title}</h3>

      {event.description && (
        <p className="hh-event-card__description">{event.description}</p>
      )}

      {event.tags && event.tags.length > 0 && (
        <div className="hh-event-card__tags">
          {event.tags.map(tag => (
            <span key={tag} className="hh-event-card__tag">#{tag}</span>
          ))}
        </div>
      )}

      <div className="hh-event-card__footer">
        <span className="hh-event-card__attendees">
          {event.attendeeCount} {event.attendeeCount === 1 ? 'person' : 'people'} attending
        </span>

        <div className="hh-event-card__actions">
          {error && <span className="hh-event-card__error">{error}</span>}

          {isLive && event.roomName && (
            <button
              className="hh-btn hh-btn--primary hh-btn--small"
              onClick={() => onJoin(event.roomName!)}
            >
              Join Now
            </button>
          )}

          {!isLive && currentUsername && (
            <button
              className={`hh-btn hh-btn--small ${isAttending ? 'hh-btn--secondary' : 'hh-btn--outline'}`}
              disabled={busy}
              onClick={handleAttend}
            >
              {busy ? '…' : isAttending ? '✓ Attending' : 'Attend'}
            </button>
          )}

          {isHost && !isLive && event.status === 'scheduled' && (
            <>
              <button
                className="hh-btn hh-btn--primary hh-btn--small"
                disabled={busy}
                onClick={handleGoLive}
              >
                {busy ? 'Starting…' : 'Go Live'}
              </button>
              <button
                className="hh-btn hh-btn--ghost hh-btn--small"
                disabled={busy}
                onClick={handleCancel}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Events lobby tab ──────────────────────────────────────────────────────

interface EventsLobbyProps {
  onJoinRoom: (roomName: string) => void;
}

function EventsLobby({ onJoinRoom }: EventsLobbyProps) {
  const { username, isAuthenticated } = useHangoutsContext();
  const [showForm, setShowForm] = useState(false);

  const { events: scheduled, isLoading: loadingScheduled, refetch: refetchScheduled } =
    useEventList({ status: 'scheduled', limit: 20, pollInterval: 30_000 });

  const { events: live, isLoading: loadingLive, refetch: refetchLive } =
    useEventList({ status: 'live', pollInterval: 15_000 });

  const refresh = useCallback(() => {
    refetchScheduled();
    refetchLive();
  }, [refetchScheduled, refetchLive]);

  const liveEvents = live.filter(e => e.roomName);
  const loading = loadingScheduled && loadingLive;

  return (
    <div className="hh-events-lobby">
      <div className="hh-events-lobby__header">
        <h2 className="hh-events-lobby__heading">Upcoming Events</h2>
        {isAuthenticated && (
          <button
            className="hh-btn hh-btn--primary hh-btn--small"
            onClick={() => setShowForm(true)}
          >
            + Schedule
          </button>
        )}
      </div>

      {loading && <p className="hh-events-lobby__empty">Loading events…</p>}

      {!loading && liveEvents.length === 0 && scheduled.length === 0 && (
        <div className="hh-events-lobby__empty">
          <p>No upcoming events.</p>
          {isAuthenticated && (
            <p>
              <button className="hh-btn hh-btn--outline hh-btn--small" onClick={() => setShowForm(true)}>
                Schedule the first one
              </button>
            </p>
          )}
        </div>
      )}

      {liveEvents.length > 0 && (
        <section className="hh-events-lobby__section">
          <h3 className="hh-events-lobby__section-title">● Live Now</h3>
          {liveEvents.map(ev => (
            <EventCard
              key={ev.id}
              event={ev}
              currentUsername={username}
              onJoin={onJoinRoom}
              onRefresh={refresh}
            />
          ))}
        </section>
      )}

      {scheduled.length > 0 && (
        <section className="hh-events-lobby__section">
          {liveEvents.length > 0 && (
            <h3 className="hh-events-lobby__section-title">Scheduled</h3>
          )}
          {scheduled.map(ev => (
            <EventCard
              key={ev.id}
              event={ev}
              currentUsername={username}
              onJoin={onJoinRoom}
              onRefresh={refresh}
            />
          ))}
        </section>
      )}

      {showForm && (
        <ScheduleEventForm
          onCreated={() => { setShowForm(false); refresh(); }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

// ─── Main app ──────────────────────────────────────────────────────────────

function MainApp() {
  const [activeRoom, setActiveRoom] = useState<string | null>(getRoomFromUrl);
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [lobbyTab, setLobbyTab] = useState<LobbyTab>('live');
  const [pushToTalk, setPushToTalk] = useState(false);

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
              <div className="hh-demo-room-bar">
                <label className="hh-demo-ptt-toggle">
                  <input
                    type="checkbox"
                    checked={pushToTalk}
                    onChange={(e) => setPushToTalk(e.target.checked)}
                  />
                  Push to Talk <span className="hh-demo-ptt-hint">(Space)</span>
                </label>
              </div>
              <HangoutsRoom
                roomName={activeRoom}
                onLeave={() => setActiveRoom(null)}
                embedded
                video
                guestFallback
                obsBaseUrl={window.location.origin}
                pushToTalk={pushToTalk}
              />
            </div>
          </div>
        ) : (
          <div className="hh-lobby-wrapper">
            <div className="hh-lobby-tabs">
              <button
                className={`hh-lobby-tab ${lobbyTab === 'live' ? 'hh-lobby-tab--active' : ''}`}
                onClick={() => setLobbyTab('live')}
              >
                Live Now
              </button>
              <button
                className={`hh-lobby-tab ${lobbyTab === 'upcoming' ? 'hh-lobby-tab--active' : ''}`}
                onClick={() => setLobbyTab('upcoming')}
              >
                Upcoming
              </button>
            </div>

            {lobbyTab === 'live' && (
              <RoomLobby
                onJoinRoom={(roomName) => setActiveRoom(roomName)}
                allowGuestBrowse
              />
            )}

            {lobbyTab === 'upcoming' && (
              <EventsLobby onJoinRoom={(roomName) => setActiveRoom(roomName)} />
            )}
          </div>
        )}
      </HangoutsProvider>
    </div>
  );
}

export default function App() {
  if (window.location.pathname.startsWith('/egress-template')) {
    return <EgressTemplate />;
  }
  if (window.location.pathname === '/obs') {
    return <ObsOverlay />;
  }
  return <MainApp />;
}
