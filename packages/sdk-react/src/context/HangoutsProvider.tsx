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
  const [activeToken, setActiveToken] = useState<string | null>(sessionToken ?? null);

  useEffect(() => {
    if (sessionToken) {
      apiClient.setSessionToken(sessionToken);
      setActiveToken(sessionToken);
      if (externalUsername) setUsername(externalUsername);
    } else {
      apiClient.clearSessionToken();
      setActiveToken(null);
    }
  }, [sessionToken, externalUsername, apiClient]);

  const setAuth = (name: string | null) => {
    setUsername(name);
    if (!name) {
      apiClient.clearSessionToken();
      setActiveToken(null);
    } else {
      setActiveToken(apiClient.getSessionToken());
    }
  };

  const value = useMemo(() => ({
    apiClient,
    livekitServerUrl,
    username,
    isAuthenticated: !!username && !!activeToken,
    setAuth,
  }), [apiClient, livekitServerUrl, username, activeToken]);

  return (
    <HangoutsContext.Provider value={value}>
      {children}
    </HangoutsContext.Provider>
  );
}
