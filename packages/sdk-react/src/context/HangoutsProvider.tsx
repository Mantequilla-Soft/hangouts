import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { HangoutsApiClient, type AiohaLike } from '@snapie/hangouts-core';
import { HangoutsContext } from './HangoutsContext.js';
import { resolveProConfig, type ProConfig } from '../lib/vscContract.js';

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
  /**
   * Optional Pro (premium) configuration — VSC endpoints, contract address and
   * offer ids for the subscription checkout. Every field defaults to the
   * 3Speak mainnet value, so omitting this entirely still yields a working
   * plans page and upsell.
   */
  pro?: ProConfig;
  /**
   * Light/dark for the SDK's own surfaces. Optional: when omitted the provider
   * reads whatever `data-hh-theme` your app already sets on an ancestor, so an
   * integrator that themes a wrapper div needs to change nothing.
   *
   * Either way the resolved value is mirrored onto `document.body`, which is
   * what makes DIALOGS follow the theme — every SDK dialog portals to
   * `document.body` and so sits OUTSIDE a wrapper div, where it would
   * otherwise inherit the light `:root` defaults.
   */
  theme?: 'light' | 'dark';
  /**
   * Optional separate host for the Pro/premium endpoints (`/premium/*`).
   * Defaults to `apiBaseUrl`. Use this when your rooms API and your premium
   * API are different deployments — without it the Pro flow silently degrades
   * to "not premium, no trial offered" whenever the rooms host has no
   * `/premium` routes.
   */
  premiumApiBaseUrl?: string;
  /**
   * Obtain a hangouts session token on demand, for apps that sign in lazily
   * rather than on every page load. Called only from an explicit user action
   * (currently: clicking "Try Pro free"), never automatically — so it will not
   * pop a wallet prompt at you unprompted. Return the token if you have it, so
   * the SDK can use it immediately instead of waiting a render for
   * `sessionToken` to propagate.
   */
  onRequestAuth?: () => Promise<string | null | void>;
  children: ReactNode;
}

export function HangoutsProvider({
  apiBaseUrl,
  livekitServerUrl = 'wss://livekit.3speak.tv',
  sessionToken,
  username: externalUsername,
  imageServerApiKey,
  aioha,
  pro,
  theme,
  premiumApiBaseUrl,
  onRequestAuth,
  children,
}: HangoutsProviderProps) {
  const apiClient = useMemo(() => {
    const client = new HangoutsApiClient({ baseUrl: apiBaseUrl, premiumBaseUrl: premiumApiBaseUrl });
    // Sync init: child component effects (e.g. HangoutsRoom.join) fire before
    // parent effects in React, so the token must be on the client before the
    // first render completes — not deferred to a useEffect.
    if (sessionToken) client.setSessionToken(sessionToken);
    return client;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, premiumApiBaseUrl]); // intentionally excludes sessionToken — updates handled by useEffect below

  // Detected from the host app's own `data-hh-theme` when no `theme` prop is
  // given. Null means "nothing set" — in which case we stamp nothing and the
  // stylesheet's `prefers-color-scheme` fallback takes over, which is the
  // correct behaviour rather than forcing light.
  const [detectedTheme, setDetectedTheme] = useState<string | null>(null);
  const resolvedTheme = theme ?? detectedTheme;

  useEffect(() => {
    if (theme || typeof document === 'undefined') return undefined;
    const read = () => {
      // Skip <body> and <html>: the effect below stamps the resolved theme onto
      // body, and matching our own mirror here would make detection
      // self-referential — the app could later switch its wrapper to light and
      // we'd keep reading the stale value we wrote ourselves.
      const el = document.querySelector('[data-hh-theme]:not(body):not(html)');
      setDetectedTheme(el?.getAttribute('data-hh-theme') || null);
    };
    read();
    // The host app can flip its theme at runtime; watch for both the attribute
    // changing value and a themed element being added/removed.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-hh-theme'],
    });
    return () => observer.disconnect();
  }, [theme]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const { body } = document;
    // Only clean up if we are still the one who set it — two providers on a
    // page shouldn't have the first to unmount strip the survivor's theme.
    const previous = body.getAttribute('data-hh-theme');
    if (!resolvedTheme) return undefined;
    body.setAttribute('data-hh-theme', resolvedTheme);
    return () => {
      if (body.getAttribute('data-hh-theme') === resolvedTheme) {
        if (previous) body.setAttribute('data-hh-theme', previous);
        else body.removeAttribute('data-hh-theme');
      }
    };
  }, [resolvedTheme]);

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

  // `pro` is almost always written as an inline object literal, so memoising on
  // its identity would rebuild the whole context every render. Key on the
  // scalar fields instead, and on the identity of the two function overrides.
  const proKey = JSON.stringify([
    pro?.network, pro?.graphqlUrl, pro?.hasuraUrl,
    pro?.subsContractId, pro?.subOfferId, pro?.onetimeOfferId, pro?.trialEnabled,
  ]);
  const proConfig = useMemo(
    () => resolveProConfig(pro),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [proKey, pro?.broadcastOps, pro?.getUsername],
  );

  const value = useMemo(() => ({
    apiClient,
    apiBaseUrl,
    livekitServerUrl,
    username,
    isAuthenticated: !!username && !!activeToken,
    setAuth,
    imageServerApiKey,
    aioha,
    pro: proConfig,
    theme: resolvedTheme,
    premiumApiBaseUrl: premiumApiBaseUrl || apiBaseUrl,
    onRequestAuth,
  }), [apiClient, apiBaseUrl, livekitServerUrl, username, activeToken, imageServerApiKey, aioha, proConfig, resolvedTheme, premiumApiBaseUrl, onRequestAuth]);

  return (
    <HangoutsContext.Provider value={value}>
      {children}
    </HangoutsContext.Provider>
  );
}
