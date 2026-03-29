import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { HangoutsApiClient } from '@snapie/hangouts-core';
import { HangoutsContext } from './HangoutsContext.js';

export interface HangoutsProviderProps {
  apiBaseUrl: string;
  livekitServerUrl?: string;
  sessionToken?: string;
  username?: string;
  children: ReactNode;
}

export function HangoutsProvider({
  apiBaseUrl,
  livekitServerUrl = 'wss://livekit.3speak.tv',
  sessionToken,
  username: externalUsername,
  children,
}: HangoutsProviderProps) {
  const apiClient = useMemo(
    () => new HangoutsApiClient({ baseUrl: apiBaseUrl }),
    [apiBaseUrl],
  );

  const [username, setUsername] = useState<string | null>(externalUsername ?? null);

  // Support external session token (e.g., from React Native host app)
  useEffect(() => {
    if (sessionToken) {
      apiClient.setSessionToken(sessionToken);
      if (externalUsername) setUsername(externalUsername);
    }
  }, [sessionToken, externalUsername, apiClient]);

  const setAuth = (name: string | null) => {
    setUsername(name);
    if (!name) apiClient.clearSessionToken();
  };

  const value = useMemo(() => ({
    apiClient,
    livekitServerUrl,
    username,
    isAuthenticated: !!username && !!apiClient.getSessionToken(),
    setAuth,
  }), [apiClient, livekitServerUrl, username]);

  return (
    <HangoutsContext.Provider value={value}>
      {children}
    </HangoutsContext.Provider>
  );
}
