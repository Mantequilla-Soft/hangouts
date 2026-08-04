import { useCallback, useEffect, useState } from 'react';
import type { HangoutsApiClient, PremiumStatus } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';

/**
 * Premium status, read from the hangouts API.
 *
 * Module-level cache so the same username isn't refetched by every component
 * that wants to know (padlocked checkboxes, the upsell, the plans page).
 * Entries expire after `CACHE_TTL_MS`, and failed lookups are cached as
 * not-premium for the same window so an outage doesn't hammer the endpoint.
 *
 * Keyed by `baseUrl|username` because two providers in one page can legitimately
 * point at different deployments.
 */
const cache = new Map<string, { value: PremiumStatus; expires: number }>();
const inflight = new Map<string, Promise<PremiumStatus>>();
const CACHE_TTL_MS = 60_000;

function notPremium(username: string): PremiumStatus {
  return {
    username,
    premium: false,
    premium_source: null,
    premium_expires_at: null,
    testing_started: null,
    testing_available: false,
    testing_hours: 24,
  };
}

/** Drop cached entries for a user so the next read hits the server. */
export function invalidatePremiumStatus(username?: string): void {
  if (!username) {
    cache.clear();
    return;
  }
  const suffix = `|${username.toLowerCase()}`;
  for (const key of [...cache.keys()]) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

async function fetchPremium(apiClient: HangoutsApiClient, baseUrl: string, username: string): Promise<PremiumStatus> {
  const key = `${baseUrl}|${username.toLowerCase()}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.value;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = apiClient
    .getPremiumStatus(username)
    .catch(() => notPremium(username.toLowerCase()));

  inflight.set(key, promise);
  const value = await promise;
  inflight.delete(key);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

export interface UsePremiumStatusResult {
  /** `null` while the first lookup is in flight. */
  status: PremiumStatus | null;
  isPremium: boolean;
  /** True once the first lookup has settled (either way). */
  loaded: boolean;
  /** Re-read, bypassing the cache. */
  refresh: () => Promise<void>;
}

/**
 * Premium status for a Hive username. Pass nothing to use the signed-in user.
 *
 * `isPremium` is false while loading, so callers render the locked state first
 * and unlock on resolve — never the other way round, which would flash paid
 * features at free users.
 */
export function usePremiumStatus(
  username?: string | null,
  options?: { enabled?: boolean },
): UsePremiumStatusResult {
  const { apiClient, premiumApiBaseUrl: apiBaseUrl, username: contextUsername } = useHangoutsContext();
  // `enabled: false` skips the lookup entirely — used by components whose
  // caller supplied an explicit `isPremium` override, so a host app that
  // already knows the answer doesn't pay for a request that would be ignored.
  const enabled = options?.enabled !== false;
  const name = enabled ? (username === undefined ? contextUsername : username) : null;

  const [state, setState] = useState<PremiumStatus | null>(() => {
    if (!name) return null;
    const cached = cache.get(`${apiBaseUrl}|${name.toLowerCase()}`);
    return cached && cached.expires > Date.now() ? cached.value : null;
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!name) {
      setState(null);
      setLoaded(true);
      return undefined;
    }
    let cancelled = false;
    fetchPremium(apiClient, apiBaseUrl, name).then((value) => {
      if (cancelled) return;
      setState(value);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [apiClient, apiBaseUrl, name]);

  const refresh = useCallback(async () => {
    if (!name) return;
    invalidatePremiumStatus(name);
    const value = await fetchPremium(apiClient, apiBaseUrl, name);
    setState(value);
    setLoaded(true);
  }, [apiClient, apiBaseUrl, name]);

  return {
    status: state,
    isPremium: state?.premium === true,
    loaded,
    refresh,
  };
}
