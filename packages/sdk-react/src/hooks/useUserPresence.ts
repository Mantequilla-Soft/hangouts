import { useState, useEffect, useCallback } from 'react';
import type { UserPresence } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

const DEFAULT_POLL_INTERVAL = 15_000;

export function useUserPresence(username: string, opts?: { pollInterval?: number }) {
  const { apiClient } = useHangoutsContext();
  const [presence, setPresence] = useState<UserPresence | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;

  const refetch = useCallback(async () => {
    if (!username) return;
    try {
      const data = await apiClient.getUserPresence(username);
      setPresence(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check presence');
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, username]);

  useEffect(() => {
    setPresence(null);
    setIsLoading(true);
    refetch();
    const interval = setInterval(refetch, pollInterval);
    return () => clearInterval(interval);
  }, [refetch, pollInterval]);

  return { presence, isLoading, error, refetch };
}
