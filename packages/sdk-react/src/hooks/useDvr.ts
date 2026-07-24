import { useState, useCallback } from 'react';
import { useHangoutsContext } from '../context/HangoutsContext.js';

/**
 * DVR controls (Pro): start/stop a rolling segment recording while live, then
 * clip the last ~30s into a shareable MP4. `clip` takes the API base URL so it
 * can return an absolute link the host can copy or share.
 */
export function useDvr(roomName: string | null) {
  const { apiClient } = useHangoutsContext();
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastClip, setLastClip] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (!roomName) return;
    setBusy(true); setError(null);
    try { await apiClient.startDvr(roomName); setRecording(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start DVR'); }
    finally { setBusy(false); }
  }, [apiClient, roomName]);

  const stop = useCallback(async () => {
    if (!roomName) return;
    setBusy(true); setError(null);
    try { await apiClient.stopDvr(roomName); setRecording(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not stop DVR'); }
    finally { setBusy(false); }
  }, [apiClient, roomName]);

  const clip = useCallback(async (apiBaseUrl: string): Promise<string | null> => {
    if (!roomName) return null;
    setBusy(true); setError(null);
    try {
      const r = await apiClient.clipDvr(roomName);
      const url = `${apiBaseUrl.replace(/\/$/, '')}${r.path}`;
      setLastClip(url);
      return url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make a clip');
      return null;
    } finally { setBusy(false); }
  }, [apiClient, roomName]);

  return { recording, busy, error, lastClip, start, stop, clip };
}
