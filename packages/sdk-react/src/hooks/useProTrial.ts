import { useCallback, useState } from 'react';
import { HangoutsApiError } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../context/HangoutsContext.js';
import { usePremiumStatus } from './usePremiumStatus.js';

export interface UseProTrialResult {
  /** Whether to render a "Try Pro free" button at all. */
  canTrial: boolean;
  /** Trial length the server will grant, in hours. */
  trialHours: number;
  pending: boolean;
  /** Last failure, for inline display. Cleared on the next attempt. */
  error: string | null;
  /** Set once the claim succeeds, so the caller can show a confirmation. */
  claimedUntil: string | null;
  /** Claim the trial. Resolves true on success. */
  start: () => Promise<boolean>;
}

/**
 * The one-per-lifetime free Pro trial.
 *
 * Eligibility is decided by the server, not by a client flag: `testing_started`
 * is sticky for life and `testing_available` reflects whether the deployment
 * offers trials at all. That means the button can never be shown when the
 * claim would only be refused.
 */
export function useProTrial(): UseProTrialResult {
  const { apiClient, isAuthenticated, username, pro, onRequestAuth } = useHangoutsContext();
  const { status, refresh } = usePremiumStatus(username);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimedUntil, setClaimedUntil] = useState<string | null>(null);

  const alreadyUsed = !!status?.testing_started || !!status?.premium;
  // `pro.trialEnabled` is an explicit integrator override; unset means follow
  // the server, which is the only thing that actually decides the outcome.
  const enabled = pro.trialEnabled ?? status?.testing_available ?? false;
  // Showing the button only when already authenticated would hide it on any
  // page that hasn't signed in to hangouts yet. If the app can obtain a session
  // on demand (`onRequestAuth`), offer it and sign in when it is clicked.
  const canTrial = enabled && !!username && !!status && !alreadyUsed
    && (isAuthenticated || !!onRequestAuth);

  const start = useCallback(async (): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      if (!isAuthenticated && onRequestAuth) {
        // Set the token straight onto the client: the provider picks it up via
        // a prop→effect round trip, which would not have landed before the
        // POST below fires.
        const token = await onRequestAuth();
        if (typeof token === 'string' && token) apiClient.setSessionToken(token);
      }
      const res = await apiClient.startProTrial();
      setClaimedUntil(res.expiresAt);
      // Premium is cached both here and for 60s on the server's read path, so
      // an explicit refresh is what stops the studio opening on the free tier.
      await refresh();
      return true;
    } catch (err) {
      if (err instanceof HangoutsApiError) {
        setError(err.message || `Could not start the trial (${err.status}).`);
      } else {
        setError('Could not reach the Pro trial service — try again in a moment.');
      }
      return false;
    } finally {
      setPending(false);
    }
  }, [apiClient, pending, refresh, isAuthenticated, onRequestAuth]);

  return {
    canTrial,
    trialHours: status?.testing_hours ?? 24,
    pending,
    error,
    claimedUntil,
    start,
  };
}
