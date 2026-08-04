import { createContext, useContext } from 'react';
import type { HangoutsApiClient, AiohaLike } from '@snapie/hangouts-core';
import type { ResolvedProConfig } from '../lib/vscContract.js';

export interface HangoutsContextValue {
  apiClient: HangoutsApiClient;
  apiBaseUrl: string;
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
  /**
   * Pro (premium) configuration, already resolved against the 3Speak mainnet
   * defaults. Always present — an integrator who passes nothing still gets a
   * working checkout.
   */
  pro: ResolvedProConfig;
  /** Resolved light/dark, or null when the app sets none (system preference
   *  then applies). Mirrored onto `document.body` by the provider so portalled
   *  dialogs inherit it. */
  theme: string | null;
  /** Resolved host for `/premium/*` — `premiumApiBaseUrl` or `apiBaseUrl`. */
  premiumApiBaseUrl: string;
  /** Obtain a hangouts session on demand. See `HangoutsProviderProps`. */
  onRequestAuth?: () => Promise<string | null | void>;
}

export const HangoutsContext = createContext<HangoutsContextValue | null>(null);

export function useHangoutsContext(): HangoutsContextValue {
  const ctx = useContext(HangoutsContext);
  if (!ctx) {
    throw new Error('useHangoutsContext must be used within a <HangoutsProvider>');
  }
  return ctx;
}
