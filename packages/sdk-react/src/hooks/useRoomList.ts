import { useState, useEffect, useCallback } from 'react';
import type { Room } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

const POLL_INTERVAL = 10_000;

/**
 * @param fetchRooms Optional override for WHERE the list comes from. Integrators
 *   running several OpenPods deployments pass a fetcher that aggregates across
 *   all of them — joining still works by room name, since the room's own host is
 *   resolved at join time.
 */
export function useRoomList(fetchRooms?: () => Promise<Room[]>) {
  const { apiClient } = useHangoutsContext();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = fetchRooms ? await fetchRooms() : await apiClient.listRooms();
      setRooms(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rooms');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, fetchRooms]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refresh]);

  return { rooms, isLoading, error, refresh };
}
