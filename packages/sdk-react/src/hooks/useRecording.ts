import { useState, useCallback, useEffect, useRef } from 'react';
import type { RecordingMode, RecordingLayout, RecordingFileResult } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

interface RecordingState {
  isRecording: boolean;
  mode: RecordingMode | null;
  layout: RecordingLayout;
  filePath: string | null;
  duration: number | null;
  /** Token for fetching the video recording (set after stop, video mode only). */
  downloadToken: string | null;
  uploadResult: { permlink: string; cid: string; playUrl: string } | null;
  /** Result of the most recent fetchVideoFile call. */
  videoFile: RecordingFileResult | null;
  elapsed: number;
}

const INITIAL: RecordingState = {
  isRecording: false,
  mode: null,
  layout: 'speaker',
  filePath: null,
  duration: null,
  downloadToken: null,
  uploadResult: null,
  videoFile: null,
  elapsed: 0,
};

export function useRecording(roomName: string | null) {
  const { apiClient } = useHangoutsContext();
  const [state, setState] = useState<RecordingState>(INITIAL);
  const [isLoading, setIsLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Timer: count up every second while recording
  useEffect(() => {
    if (state.isRecording) {
      setState((prev) => ({ ...prev, elapsed: 0 }));
      timerRef.current = setInterval(() => {
        setState((prev) => ({ ...prev, elapsed: prev.elapsed + 1 }));
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state.isRecording]);

  // Reflect current server state on mount so listeners see recordings too
  useEffect(() => {
    if (!roomName) return;
    apiClient.getRecordingStatus(roomName).then((status) => {
      setState((prev) => ({
        ...prev,
        isRecording: status.recording,
        mode: status.mode ?? prev.mode,
        layout: status.layout ?? prev.layout,
      }));
    }).catch(() => { /* tolerate */ });
  }, [roomName, apiClient]);

  const startRecording = useCallback(async (opts?: { mode?: RecordingMode; layout?: RecordingLayout }) => {
    if (!roomName) return;
    setIsLoading(true);
    try {
      const result = await apiClient.startRecording(roomName, opts);
      setState({
        ...INITIAL,
        isRecording: true,
        mode: result.mode,
        layout: result.layout,
      });
    } finally {
      setIsLoading(false);
    }
  }, [roomName, apiClient]);

  const stopRecording = useCallback(async () => {
    if (!roomName) return;
    setIsLoading(true);
    try {
      const result = await apiClient.stopRecording(roomName);
      setState((prev) => ({
        ...prev,
        isRecording: false,
        mode: result.mode,
        layout: result.layout,
        filePath: result.filePath,
        duration: result.duration,
        downloadToken: result.downloadToken ?? null,
      }));
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [roomName, apiClient]);

  /** Switch layout live during a video recording. No-op for audio. */
  const setLayout = useCallback(async (layout: RecordingLayout) => {
    if (!roomName) return;
    setIsLoading(true);
    try {
      const result = await apiClient.setRecordingLayout(roomName, layout);
      setState((prev) => ({ ...prev, layout: result.layout }));
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [roomName, apiClient]);

  const uploadRecording = useCallback(async (title?: string, tags?: string[]) => {
    if (!roomName || !state.filePath) return;
    setIsLoading(true);
    try {
      const result = await apiClient.uploadRecording(roomName, state.filePath, state.duration ?? undefined, title, tags);
      setState((prev) => ({ ...prev, uploadResult: result }));
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [roomName, state.filePath, state.duration, apiClient]);

  /**
   * Stream the recorded MP4 from the server back to the browser as a Blob,
   * then hand it off to the long-form /studio flow via window.__pwaSharedFile
   * — the same channel StudioPage uses for the PWA share-target / "Open with"
   * pickup. The user's normal /studio upload (TUS to video.3speak.tv) runs
   * with their own auth from there.
   */
  const fetchVideoFile = useCallback(async (): Promise<RecordingFileResult | null> => {
    if (!roomName || !state.downloadToken) return null;
    setIsLoading(true);
    try {
      const result = await apiClient.fetchRecordingFile(roomName, state.downloadToken);
      setState((prev) => ({ ...prev, videoFile: result }));
      return result;
    } finally {
      setIsLoading(false);
    }
  }, [roomName, state.downloadToken, apiClient]);

  /**
   * Convenience: fetch the file, park it in the browser's Cache API at the
   * `share-target-cache`/`/shared-video` slot, then send the user to /studio.
   *
   * StudioPage's existing PWA share-target handler reads from this exact
   * cache entry on `?shared=true` and treats the blob like a freshly-picked
   * file. The Cache API survives full page reloads (window.__pwaSharedFile
   * does not), so a `window.location.href` navigation is safe.
   */
  const handOffToStudio = useCallback(async (studioPath = '/studio'): Promise<boolean> => {
    const result = state.videoFile ?? await fetchVideoFile();
    if (!result) return false;
    const cache = await caches.open('share-target-cache');
    await cache.put(
      '/shared-video',
      new Response(result.blob, {
        headers: {
          'Content-Type': result.blob.type || 'video/mp4',
          'X-File-Name': result.filename,
        },
      }),
    );
    const sep = studioPath.includes('?') ? '&' : '?';
    window.location.href = `${studioPath}${sep}shared=true`;
    return true;
  }, [state.videoFile, fetchVideoFile]);

  /**
   * Trigger a local browser download of the recording. Useful when the host
   * doesn't want to publish to 3Speak immediately — they get the MP4 file
   * to disk for their own use.
   */
  const downloadVideoFile = useCallback(async (): Promise<boolean> => {
    const result = state.videoFile ?? await fetchVideoFile();
    if (!result) return false;
    const url = URL.createObjectURL(result.blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: result.filename,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
    return true;
  }, [state.videoFile, fetchVideoFile]);

  const reset = useCallback(() => setState(INITIAL), []);

  return {
    ...state,
    isLoading,
    startRecording,
    stopRecording,
    setLayout,
    uploadRecording,
    fetchVideoFile,
    handOffToStudio,
    downloadVideoFile,
    reset,
  };
}
