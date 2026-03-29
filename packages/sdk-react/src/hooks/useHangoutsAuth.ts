import { useState, useCallback } from 'react';
import { loginWithKeychain, isKeychainAvailable } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

export function useHangoutsAuth() {
  const { apiClient, username, isAuthenticated, setAuth } = useHangoutsContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (user: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const session = await loginWithKeychain(apiClient, user);
      setAuth(session.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, setAuth]);

  const logout = useCallback(() => {
    setAuth(null);
  }, [setAuth]);

  return {
    username,
    isAuthenticated,
    isKeychainAvailable: isKeychainAvailable(),
    login,
    logout,
    isLoading,
    error,
  };
}
