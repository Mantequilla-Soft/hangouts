import { useState, useCallback } from 'react';
import type { StreamPlatform } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

interface StreamingState {
  isStreaming: boolean;
  egressId: string | null;
  platform: StreamPlatform | null;
}

export function useStreaming(roomName: string | null) {
  const { apiClient } = useHangoutsContext();
  const [state, setState] = useState<StreamingState>({
    isStreaming: false,
    egressId: null,
    platform: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startStream = useCallback(async (
    platform: StreamPlatform,
    streamKey: string,
    backgroundImageUrl?: string,
    videoEnabled?: boolean,
  ) => {
    if (!roomName) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await apiClient.startStream(roomName, platform, streamKey, backgroundImageUrl, videoEnabled);
      setState({ isStreaming: true, egressId: result.egressId, platform });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start stream');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, roomName]);

  const stopStream = useCallback(async () => {
    if (!roomName) return;
    setIsLoading(true);
    setError(null);
    try {
      await apiClient.stopStream(roomName);
      setState({ isStreaming: false, egressId: null, platform: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop stream');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, roomName]);

  return {
    ...state,
    isLoading,
    error,
    startStream,
    stopStream,
  };
}
