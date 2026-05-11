import { useState, useCallback } from 'react';
import {
  loginWithKeychain,
  loginWithAioha,
  isKeychainAvailable,
} from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

export function useHangoutsAuth() {
  const { apiClient, username, isAuthenticated, setAuth, aioha } = useHangoutsContext();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Sign in to the hangouts server.
   *
   * Aioha path (preferred when an `aioha` instance was passed to
   * `<HangoutsProvider>`): the user can already be logged in via any Aioha
   * provider (Keychain, HiveAuth, PeakVault, MetaMask Snap, Ledger). If they
   * are, `user` is optional and we read the identity from Aioha. If not,
   * the consumer is expected to drive Aioha's own login UI before calling.
   *
   * Keychain fallback: requires Hive Keychain installed and a username.
   */
  const login = useCallback(async (user?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      if (aioha) {
        const session = await loginWithAioha(apiClient, aioha, user);
        setAuth(session.username);
        return;
      }
      if (!user) {
        throw new Error('Username required when signing in without Aioha');
      }
      const session = await loginWithKeychain(apiClient, user);
      setAuth(session.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, setAuth, aioha]);

  const logout = useCallback(() => {
    setAuth(null);
  }, [setAuth]);

  return {
    username,
    isAuthenticated,
    /** True when Aioha is wired up OR Hive Keychain is installed. */
    canSignIn: !!aioha || isKeychainAvailable(),
    /** Kept for backwards compat — prefer `canSignIn` going forward. */
    isKeychainAvailable: isKeychainAvailable(),
    /** True when an Aioha instance was passed to <HangoutsProvider>. */
    isAiohaAvailable: !!aioha,
    login,
    logout,
    isLoading,
    error,
  };
}
