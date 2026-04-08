import { useState } from 'react';
import type { StreamPlatform } from '@snapie/hangouts-core';

const DEFAULT_BG = 'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmdU1V8Eefmv5E77Ct6hNG8A3f9b75dZmVS6ZVvw5ynnrn';

const LS_KEYS: Record<StreamPlatform, string> = {
  youtube: 'hh-yt-key',
  twitch: 'hh-tw-key',
};
const LS_BG_KEY = 'hh-stream-bg';

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
  onStart: (platform: StreamPlatform, streamKey: string, bgUrl: string) => void;
  onClose: () => void;
}

export interface StopStreamingPanelProps {
  platform: StreamPlatform;
  isLoading: boolean;
  error: string | null;
  onStop: () => void;
  onClose: () => void;
}

export function StreamingPanel({ videoEnabled, isLoading, error, onStart, onClose }: StreamingPanelProps) {
  const [platform, setPlatform] = useState<StreamPlatform>('youtube');
  const [streamKey, setStreamKey] = useState(() => loadFromStorage(LS_KEYS[platform]));
  const [bgUrl, setBgUrl] = useState(() => loadFromStorage(LS_BG_KEY));

  const handlePlatformChange = (p: StreamPlatform) => {
    setPlatform(p);
    setStreamKey(loadFromStorage(LS_KEYS[p]));
  };

  const handleStart = () => {
    saveToStorage(LS_KEYS[platform], streamKey);
    if (!videoEnabled) saveToStorage(LS_BG_KEY, bgUrl);
    onStart(platform, streamKey, bgUrl || DEFAULT_BG);
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

export function StopStreamingPanel({ platform, isLoading, error, onStop, onClose }: StopStreamingPanelProps) {
  return (
    <div className="hh-streaming-panel hh-streaming-panel--compact">
      <div className="hh-streaming-panel__header">
        <span className="hh-streaming-panel__indicator">● LIVE on {platform}</span>
        <button className="hh-btn hh-btn--icon hh-btn--secondary" onClick={onClose} title="Close">✕</button>
      </div>
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
