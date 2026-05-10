import { createContext, useContext } from 'react';
import type { HangoutsApiClient, AiohaLike } from '@snapie/hangouts-core';

export interface HangoutsContextValue {
  apiClient: HangoutsApiClient;
  livekitServerUrl: string;
  username: string | null;
  isAuthenticated: boolean;
  setAuth: (username: string | null) => void;
  imageServerApiKey?: string;
  /**
   * Optional Aioha instance. When provided, the SDK signs hangouts
   * challenges through Aioha (so any provider the consumer registered —
   * Keychain, HiveAuth, PeakVault, MetaMask Snap, Ledger, etc. — works).
   * When absent, the SDK falls back to direct Hive Keychain.
   */
  aioha?: AiohaLike;
}

export const HangoutsContext = createContext<HangoutsContextValue | null>(null);

export function useHangoutsContext(): HangoutsContextValue {
  const ctx = useContext(HangoutsContext);
  if (!ctx) {
    throw new Error('useHangoutsContext must be used within a <HangoutsProvider>');
  }
  return ctx;
}
