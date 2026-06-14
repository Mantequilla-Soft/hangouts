import { useState, useEffect, useCallback } from 'react';
import type { HangoutsEvent, EventStatus } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

const DEFAULT_POLL_INTERVAL = 30_000;

export function useEventList(opts?: {
  status?: EventStatus;
  host?: string;
  limit?: number;
  pollInterval?: number;
}) {
  const { apiClient } = useHangoutsContext();
  const [events, setEvents] = useState<HangoutsEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const status = opts?.status;
  const host = opts?.host;
  const limit = opts?.limit;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;

  const refetch = useCallback(async () => {
    try {
      const data = await apiClient.listEvents({ status, host, limit });
      setEvents(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, status, host, limit]);

  useEffect(() => {
    refetch();
    const interval = setInterval(refetch, pollInterval);
    return () => clearInterval(interval);
  }, [refetch, pollInterval]);

  return { events, isLoading, error, refetch };
}
