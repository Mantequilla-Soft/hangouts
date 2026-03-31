import { useState, useCallback, useEffect } from 'react';
import { useHangoutsContext } from '../context/HangoutsContext.js';

interface RecordingState {
  isRecording: boolean;
  filePath: string | null;
  duration: number | null;
  uploadResult: { permlink: string; cid: string; playUrl: string } | null;
}

export function useRecording(roomName: string | null) {
  const { apiClient } = useHangoutsContext();
  const [state, setState] = useState<RecordingState>({
    isRecording: false,
    filePath: null,
    duration: null,
    uploadResult: null,
  });
  const [isLoading, setIsLoading] = useState(false);

  // Check recording status on mount
  useEffect(() => {
    if (!roomName) return;
    apiClient.getRecordingStatus(roomName).then((status) => {
      setState((prev) => ({ ...prev, isRecording: status.recording }));
    }).catch(() => {});
  }, [roomName, apiClient]);

  const startRecording = useCallback(async () => {
    if (!roomName) return;
    setIsLoading(true);
    try {
      await apiClient.startRecording(roomName);
      setState((prev) => ({ ...prev, isRecording: true, filePath: null, duration: null, uploadResult: null }));
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
        filePath: result.filePath,
        duration: result.duration,
      }));
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
  }, [roomName, state.filePath, apiClient]);

  return {
    ...state,
    isLoading,
    startRecording,
    stopRecording,
    uploadRecording,
  };
}
