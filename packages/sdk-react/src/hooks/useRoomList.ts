import { useState, useEffect, useCallback } from 'react';
import type { Room } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

const POLL_INTERVAL = 10_000;

export function useRoomList() {
  const { apiClient } = useHangoutsContext();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiClient.listRooms();
      setRooms(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rooms');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  return { rooms, isLoading, error, refresh };
}
