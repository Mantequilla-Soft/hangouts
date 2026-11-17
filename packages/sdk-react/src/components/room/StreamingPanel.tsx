import { useState } from 'react';
import type { StreamPlatform } from '../../hooks/useStreaming.js';

const DEFAULT_BG = 'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmdU1V8Eefmv5E77Ct6hNG8A3f9b75dZmVS6ZVvw5ynnrn';

const PLATFORMS: StreamPlatform[] = ['youtube', 'twitch', 'custom'];
const PLATFORM_LABELS: Record<StreamPlatform, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  custom: 'Other',
};
const LIVE_ON: Record<StreamPlatform, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  custom: 'your own server',
};

const LS_STREAM_KEYS: Record<StreamPlatform, string> = {
  youtube: 'hh-yt-key',
  twitch: 'hh-tw-key',
  custom: 'hh-custom-key',
};
const LS_VIEWER_URLS: Record<StreamPlatform, string> = {
  youtube: 'hh-yt-url',
  twitch: 'hh-tw-url',
  custom: 'hh-custom-url',
};
const LS_BG_KEY = 'hh-stream-bg';
const LS_SERVER_URL = 'hh-custom-server';

const VIEWER_URL_PLACEHOLDERS: Record<StreamPlatform, string> = {
  youtube: 'youtube.com/live/...',
  twitch: 'twitch.tv/yourchannel',
  custom: 'kick.com/yourchannel',
};

// The server checks it properly (public address only); this just keeps Go Live
// off until something that looks like a server URL is in.
const SERVER_URL_RE = /^rtmps?:\/\/[^\s/]+/i;

/** A custom destination as the server takes it: server URL and key joined the way OBS does it. */
export function customStreamTarget(serverUrl: string, streamKey: string): string | null {
  const server = serverUrl.trim().replace(/\/+$/, '');
  const key = streamKey.trim();
  return SERVER_URL_RE.test(server) && key ? `${server}/${key}` : null;
}

function loadFromStorage(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function saveToStorage(key: string, value: string) {
  try { if (value) localStorage.setItem(key, value); } catch { /* ignore */ }
}

export interface StreamingPanelProps {
  videoEnabled: boolean;
  isLoading: boolean;
  error: string | null;
  /** For `custom`, `streamKey` is the server URL and key joined into one rtmp(s) URL. */
  onStart: (platform: StreamPlatform, streamKey: string, bgUrl: string, viewerUrl: string) => void;
  onClose: () => void;
}

export interface StopStreamingPanelProps {
  platform: StreamPlatform;
  viewerUrl: string;
  isLoading: boolean;
  error: string | null;
  onStop: () => void;
  onClose: () => void;
}

export function StreamingPanel({ videoEnabled, isLoading, error, onStart, onClose }: StreamingPanelProps) {
  const [platform, setPlatform] = useState<StreamPlatform>('youtube');
  const [streamKey, setStreamKey] = useState(() => loadFromStorage(LS_STREAM_KEYS[platform]));
  const [viewerUrl, setViewerUrl] = useState(() => loadFromStorage(LS_VIEWER_URLS[platform]));
  const [bgUrl, setBgUrl] = useState(() => loadFromStorage(LS_BG_KEY));
  const [serverUrl, setServerUrl] = useState(() => loadFromStorage(LS_SERVER_URL));
  const custom = platform === 'custom';
  const ready = custom ? !!customStreamTarget(serverUrl, streamKey) : !!streamKey.trim();

  const handlePlatformChange = (p: StreamPlatform) => {
    setPlatform(p);
    setStreamKey(loadFromStorage(LS_STREAM_KEYS[p]));
    setViewerUrl(loadFromStorage(LS_VIEWER_URLS[p]));
  };

  const handleStart = () => {
    saveToStorage(LS_STREAM_KEYS[platform], streamKey);
    saveToStorage(LS_VIEWER_URLS[platform], viewerUrl);
    if (!videoEnabled) saveToStorage(LS_BG_KEY, bgUrl);
    if (custom) saveToStorage(LS_SERVER_URL, serverUrl.trim());
    const key = custom ? customStreamTarget(serverUrl, streamKey) : streamKey.trim();
    if (!key) return;
    onStart(platform, key, bgUrl || DEFAULT_BG, viewerUrl);
  };

  return (
    <div className="hh-streaming-panel">
      <div className="hh-streaming-panel__header">
        <span>Go Live</span>
        <button className="hh-btn hh-btn--icon hh-btn--secondary" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="hh-streaming-panel__tabs">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            className={`hh-btn hh-btn--small ${platform === p ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
            aria-pressed={platform === p}
            onClick={() => handlePlatformChange(p)}
          >
            {PLATFORM_LABELS[p]}
          </button>
        ))}
      </div>

      {custom && (
        <div className="hh-streaming-panel__field">
          <label className="hh-streaming-panel__label" htmlFor="hh-stream-server">
            Server URL <span className="hh-streaming-panel__hint">(from the platform's stream settings)</span>
          </label>
          <input
            id="hh-stream-server"
            className="hh-streaming-panel__input"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="rtmp://live.restream.io/live"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
          <p className="hh-streaming-panel__note">
            Restream.io, Kick, Facebook or any service that gives you a server URL and a stream key.
          </p>
        </div>
      )}

      <div className="hh-streaming-panel__field">
        <label className="hh-streaming-panel__label" htmlFor="hh-stream-key">
          {custom ? 'Stream Key' : `${PLATFORM_LABELS[platform]} Stream Key`}
        </label>
        <input
          id="hh-stream-key"
          className="hh-streaming-panel__input"
          type="password"
          placeholder="Paste your stream key"
          value={streamKey}
          onChange={(e) => setStreamKey(e.target.value)}
        />
      </div>

      <div className="hh-streaming-panel__field">
        <label className="hh-streaming-panel__label">
          Viewer URL <span className="hh-streaming-panel__hint">(optional — to share)</span>
        </label>
        <input
          className="hh-streaming-panel__input"
          type="url"
          placeholder={VIEWER_URL_PLACEHOLDERS[platform]}
          value={viewerUrl}
          onChange={(e) => setViewerUrl(e.target.value)}
        />
      </div>

      {!videoEnabled && (
        <div className="hh-streaming-panel__field">
          <label className="hh-streaming-panel__label">
            Background Image URL <span className="hh-streaming-panel__hint">(optional)</span>
          </label>
          <input
            className="hh-streaming-panel__input"
            type="url"
            placeholder="Leave blank for default 3speak background"
            value={bgUrl}
            onChange={(e) => setBgUrl(e.target.value)}
          />
        </div>
      )}

      {error && <p className="hh-streaming-panel__error">{error}</p>}

      <button
        className="hh-btn hh-btn--primary hh-btn--full"
        onClick={handleStart}
        disabled={!ready || isLoading}
      >
        {isLoading ? 'Starting...' : '🔴 Go Live'}
      </button>
    </div>
  );
}

export function StopStreamingPanel({ platform, viewerUrl, isLoading, error, onStop, onClose }: StopStreamingPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(viewerUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="hh-streaming-panel hh-streaming-panel--compact">
      <div className="hh-streaming-panel__header">
        <span className="hh-streaming-panel__indicator">● LIVE on {LIVE_ON[platform]}</span>
        <button className="hh-btn hh-btn--icon hh-btn--secondary" onClick={onClose} title="Close">✕</button>
      </div>

      {viewerUrl && (
        <div className="hh-streaming-panel__viewer-url">
          <span className="hh-streaming-panel__url-text" title={viewerUrl}>{viewerUrl}</span>
          <button
            className="hh-btn hh-btn--small hh-btn--secondary"
            onClick={handleCopy}
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      )}

      {error && <p className="hh-streaming-panel__error">{error}</p>}
      <button
        className="hh-btn hh-btn--danger hh-btn--full"
        onClick={onStop}
        disabled={isLoading}
      >
        {isLoading ? 'Stopping...' : 'Stop Stream'}
      </button>
    </div>
  );
}
