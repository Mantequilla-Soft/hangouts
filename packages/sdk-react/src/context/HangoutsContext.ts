import { createContext, useContext } from 'react';
import type { HangoutsApiClient } from '@hive-hangouts/core';

export interface HangoutsContextValue {
  apiClient: HangoutsApiClient;
  livekitServerUrl: string;
  username: string | null;
  isAuthenticated: boolean;
  setAuth: (username: string | null) => void;
}

export const HangoutsContext = createContext<HangoutsContextValue | null>(null);

export function useHangoutsContext(): HangoutsContextValue {
  const ctx = useContext(HangoutsContext);
  if (!ctx) {
    throw new Error('useHangoutsContext must be used within a <HangoutsProvider>');
  }
  return ctx;
}
