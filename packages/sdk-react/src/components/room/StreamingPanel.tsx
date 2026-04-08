import { useState } from 'react';
import type { StreamPlatform } from '@snapie/hangouts-core';
import { useStreaming } from '../../hooks/useStreaming.js';

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
  roomName: string;
  videoEnabled: boolean;
  onClose: () => void;
}

export function StreamingPanel({ roomName, videoEnabled, onClose }: StreamingPanelProps) {
  const [platform, setPlatform] = useState<StreamPlatform>('youtube');
  const [streamKey, setStreamKey] = useState(() => loadFromStorage(LS_KEYS[platform]));
  const [bgUrl, setBgUrl] = useState(() => loadFromStorage(LS_BG_KEY));
  const { isStreaming, isLoading, error, startStream, stopStream } = useStreaming(roomName);

  const handlePlatformChange = (p: StreamPlatform) => {
    setPlatform(p);
    setStreamKey(loadFromStorage(LS_KEYS[p]));
  };

  const handleStart = async () => {
    saveToStorage(LS_KEYS[platform], streamKey);
    if (!videoEnabled) saveToStorage(LS_BG_KEY, bgUrl);
    await startStream(platform, streamKey, bgUrl || DEFAULT_BG, videoEnabled);
  };

  const handleStop = async () => {
    await stopStream();
    onClose();
  };

  return (
    <div className="hh-streaming-panel">
      <div className="hh-streaming-panel__header">
        <span>Go Live</span>
        <button className="hh-btn hh-btn--icon hh-btn--secondary" onClick={onClose} title="Close">✕</button>
      </div>

      {!isStreaming ? (
        <>
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
        </>
      ) : (
        <div className="hh-streaming-panel__live">
          <span className="hh-streaming-panel__indicator">● LIVE on {platform}</span>
          {error && <p className="hh-streaming-panel__error">{error}</p>}
          <button
            className="hh-btn hh-btn--danger hh-btn--full"
            onClick={handleStop}
            disabled={isLoading}
          >
            {isLoading ? 'Stopping...' : 'Stop Stream'}
          </button>
        </div>
      )}
    </div>
  );
}
