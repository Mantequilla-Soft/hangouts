import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { HangoutsApiClient, type AiohaLike } from '@snapie/hangouts-core';
import { HangoutsContext } from './HangoutsContext.js';

export interface HangoutsProviderProps {
  apiBaseUrl: string;
  livekitServerUrl?: string;
  sessionToken?: string;
  username?: string;
  imageServerApiKey?: string;
  /**
   * Optional Aioha instance. When provided, `useHangoutsAuth` signs the
   * server challenge through Aioha (so any provider the consumer registered
   * works: Keychain, HiveAuth, PeakVault, MetaMask Snap, Ledger). When
   * omitted, the hook falls back to direct Hive Keychain.
   */
  aioha?: AiohaLike;
  children: ReactNode;
}

export function HangoutsProvider({
  apiBaseUrl,
  livekitServerUrl = 'wss://livekit.3speak.tv',
  sessionToken,
  username: externalUsername,
  imageServerApiKey,
  aioha,
  children,
}: HangoutsProviderProps) {
  const apiClient = useMemo(() => {
    const client = new HangoutsApiClient({ baseUrl: apiBaseUrl });
    // Sync init: child component effects (e.g. HangoutsRoom.join) fire before
    // parent effects in React, so the token must be on the client before the
    // first render completes — not deferred to a useEffect.
    if (sessionToken) client.setSessionToken(sessionToken);
    return client;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl]); // intentionally excludes sessionToken — updates handled by useEffect below

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
    imageServerApiKey,
    aioha,
  }), [apiClient, livekitServerUrl, username, activeToken, imageServerApiKey, aioha]);

  return (
    <HangoutsContext.Provider value={value}>
      {children}
    </HangoutsContext.Provider>
  );
}
