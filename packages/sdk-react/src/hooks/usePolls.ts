import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useDataChannel } from '@livekit/components-react';
import { HangoutsContext } from '../context/HangoutsContext.js';
import { isFinished, parsePoll, type PollKind, type PollStake, type PollView } from '../lib/polls.js';

export interface CreatePollInput {
  kind: PollKind;
  question: string;
  options: string[];
  durationSec: number;
}

/** How long a finished poll's results stay on the viewer's card. */
export const FINISHED_VISIBLE_MS = 30_000;

/**
 * The poll or prediction running in `roomName`: fetched once on mount, then
 * kept current from the `poll` data topic the server broadcasts on every
 * change. Viewer actions (vote, stake) and host actions (create, end, resolve,
 * cancel) go to the hangouts server with the session.
 */
export function usePolls(roomName: string) {
  const ctx = useContext(HangoutsContext);
  const apiBaseUrl = ctx?.apiBaseUrl;
  const [poll, setPoll] = useState<PollView | null>(null);
  const [myVote, setMyVote] = useState<number | null>(null);
  const [myStake, setMyStake] = useState<PollStake | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollIdRef = useRef<string | null>(null);

  const headers = useCallback((): Record<string, string> => {
    const token = ctx?.apiClient.getSessionToken();
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }, [ctx]);

  const take = useCallback((next: PollView | null) => {
    if (next && next.id !== pollIdRef.current) {
      setMyVote(null);
      setMyStake(null);
      setError(null);
    }
    pollIdRef.current = next?.id ?? null;
    setPoll(next);
  }, []);

  const refresh = useCallback(async () => {
    if (!roomName || !apiBaseUrl) return;
    try {
      const res = await fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/polls/active`, { headers: headers() });
      if (!res.ok) return;
      const body = await res.json() as { poll?: unknown; myVote?: number; myStake?: PollStake; balance?: number };
      take(parsePoll(body.poll));
      if (typeof body.myVote === 'number') setMyVote(body.myVote);
      if (body.myStake) setMyStake(body.myStake);
      if (typeof body.balance === 'number') setBalance(body.balance);
    } catch { /* an older server: no polls */ }
  }, [roomName, apiBaseUrl, headers, take]);

  // `isAuthenticated` too: signing in mid-stream brings back "you voted".
  useEffect(() => { void refresh(); }, [refresh, ctx?.isAuthenticated]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as { type?: string; poll?: unknown };
      if (parsed.type !== 'poll') return;
      const p = parsePoll(parsed.poll);
      if (p) take(p);
    } catch { /* ignore malformed */ }
  }, [take]);
  useDataChannel('poll', onMessage);

  // A finished poll's results stay a while, then the card goes.
  useEffect(() => {
    if (!poll || !isFinished(poll)) return undefined;
    const left = (poll.endedAt ?? Date.now()) + FINISHED_VISIBLE_MS - Date.now();
    const t = setTimeout(() => { if (pollIdRef.current === poll.id) take(null); }, Math.max(1000, left));
    return () => clearTimeout(t);
  }, [poll, take]);

  // A resolved prediction moved points: read the new balance once.
  useEffect(() => {
    if (!poll || poll.status !== 'resolved' || !myStake || !apiBaseUrl || !ctx?.isAuthenticated) return;
    fetch(`${apiBaseUrl}/points/${encodeURIComponent(poll.host)}`, { headers: headers() })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (typeof body?.balance === 'number') setBalance(body.balance); })
      .catch(() => {});
  }, [poll?.status, poll?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = useCallback(async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
    if (!apiBaseUrl) return null;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/polls${path}`, {
        method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}),
      });
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof json.message === 'string' ? json.message : `Failed (${res.status})`);
        return null;
      }
      const p = parsePoll(json.poll);
      if (p) take(p);
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      return null;
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl, roomName, headers, take]);

  const vote = useCallback(async (option: number) => {
    if (!poll) return false;
    const r = await call(`/${encodeURIComponent(poll.id)}/vote`, { option });
    if (r) setMyVote(option);
    return !!r;
  }, [poll, call]);

  const stake = useCallback(async (option: number, amount: number) => {
    if (!poll) return false;
    const r = await call(`/${encodeURIComponent(poll.id)}/stake`, { option, amount });
    if (r?.myStake) setMyStake(r.myStake as PollStake);
    if (typeof r?.balance === 'number') setBalance(r.balance);
    return !!r;
  }, [poll, call]);

  const create = useCallback((input: CreatePollInput) => call('', input).then((r) => !!r), [call]);
  const end = useCallback(() => (poll ? call(`/${encodeURIComponent(poll.id)}/end`, {}).then((r) => !!r) : Promise.resolve(false)), [poll, call]);
  const resolve = useCallback((winner: number) => (poll ? call(`/${encodeURIComponent(poll.id)}/resolve`, { winner }).then((r) => !!r) : Promise.resolve(false)), [poll, call]);
  const cancel = useCallback(() => (poll ? call(`/${encodeURIComponent(poll.id)}/cancel`, {}).then((r) => !!r) : Promise.resolve(false)), [poll, call]);
  const dismiss = useCallback(() => take(null), [take]);

  return {
    poll, myVote, myStake, balance, busy, error,
    isAuthenticated: !!ctx?.isAuthenticated,
    vote, stake, create, end, resolve, cancel, dismiss, refresh,
  };
}
