import { useState } from 'react';
import type { StreamPlatform } from '@snapie/hangouts-core';

const DEFAULT_BG = 'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmdU1V8Eefmv5E77Ct6hNG8A3f9b75dZmVS6ZVvw5ynnrn';

const LS_STREAM_KEYS: Record<StreamPlatform, string> = {
  youtube: 'hh-yt-key',
  twitch: 'hh-tw-key',
};
const LS_VIEWER_URLS: Record<StreamPlatform, string> = {
  youtube: 'hh-yt-url',
  twitch: 'hh-tw-url',
};
const LS_BG_KEY = 'hh-stream-bg';

const VIEWER_URL_PLACEHOLDERS: Record<StreamPlatform, string> = {
  youtube: 'youtube.com/live/...',
  twitch: 'twitch.tv/yourchannel',
};

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

  const handlePlatformChange = (p: StreamPlatform) => {
    setPlatform(p);
    setStreamKey(loadFromStorage(LS_STREAM_KEYS[p]));
    setViewerUrl(loadFromStorage(LS_VIEWER_URLS[p]));
  };

  const handleStart = () => {
    saveToStorage(LS_STREAM_KEYS[platform], streamKey);
    saveToStorage(LS_VIEWER_URLS[platform], viewerUrl);
    if (!videoEnabled) saveToStorage(LS_BG_KEY, bgUrl);
    onStart(platform, streamKey, bgUrl || DEFAULT_BG, viewerUrl);
  };

  return (
    <div className="hh-streaming-panel">
      <div className="hh-streaming-panel__header">
        <span>Go Live</span>
        <button className="hh-btn hh-btn--icon hh-btn--secondary" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="hh-streaming-panel__tabs">
        <button
          className={`hh-btn hh-btn--small ${platform === 'youtube' ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
          onClick={() => handlePlatformChange('youtube')}
        >
          YouTube
        </button>
        <button
          className={`hh-btn hh-btn--small ${platform === 'twitch' ? 'hh-btn--primary' : 'hh-btn--secondary'}`}
          onClick={() => handlePlatformChange('twitch')}
        >
          Twitch
        </button>
      </div>

      <div className="hh-streaming-panel__field">
        <label className="hh-streaming-panel__label">
          {platform === 'youtube' ? 'YouTube' : 'Twitch'} Stream Key
        </label>
        <input
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
        disabled={!streamKey.trim() || isLoading}
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
        <span className="hh-streaming-panel__indicator">● LIVE on {platform}</span>
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
