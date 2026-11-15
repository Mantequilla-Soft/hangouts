import { useCallback, useContext, useEffect, useState } from 'react';
import { HangoutsContext } from '../../context/HangoutsContext.js';
import { useRaid, type RaidTargetInfo } from '../../hooks/useRaid.js';

interface Target extends RaidTargetInfo {
  viewers: number;
  thumbnail?: string;
}

/**
 * Host controls for raids: the live 3Speak streams they can send their viewers
 * to, a countdown with Cancel once they pick one, and the switch for incoming
 * raids. English, like the rest of the studio.
 */
export function RaidHostPanel({ roomName }: { roomName: string }) {
  const ctx = useContext(HangoutsContext);
  const apiBaseUrl = ctx?.apiBaseUrl;
  const { raid } = useRaid(roomName);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [accept, setAccept] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<RaidTargetInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const headers = useCallback((): Record<string, string> => {
    const token = ctx?.apiClient.getSessionToken();
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }, [ctx]);

  const load = useCallback(async () => {
    if (!apiBaseUrl || !roomName) return;
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/raid/targets`, { headers: headers() });
      const body = await res.json().catch(() => ({})) as { targets?: Target[]; cooldownUntil?: number | null; message?: string };
      if (!res.ok) { setError(body.message || 'Could not load live streams.'); setTargets([]); return; }
      setTargets(Array.isArray(body.targets) ? body.targets : []);
      setCooldownUntil(typeof body.cooldownUntil === 'number' ? body.cooldownUntil : null);
    } catch {
      setError('Could not load live streams.');
      setTargets([]);
    }
  }, [apiBaseUrl, roomName, headers]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    fetch(`${apiBaseUrl}/raids/settings`, { headers: headers() })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (typeof body?.acceptRaids === 'boolean') setAccept(body.acceptRaids); })
      .catch(() => {});
  }, [apiBaseUrl, headers]);

  useEffect(() => {
    if (!raid && !cooldownUntil) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [raid, cooldownUntil]);

  useEffect(() => { if (raid?.go) setSentTo(raid.target); }, [raid?.go, raid?.target]);

  const start = async (t: Target) => {
    if (!apiBaseUrl) return;
    setBusy(true);
    setError(null);
    setSentTo(null);
    try {
      const res = await fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/raid`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ target: t.roomName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        setError(body.message || 'The raid did not start.');
        void load();
      }
    } catch {
      setError('The raid did not start.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!apiBaseUrl) return;
    setBusy(true);
    try {
      await fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/raid`, { method: 'DELETE', headers: headers() });
    } catch { /* the countdown simply runs out */ } finally { setBusy(false); }
  };

  const toggleAccept = async (next: boolean) => {
    if (!apiBaseUrl) return;
    setAccept(next);
    try {
      const res = await fetch(`${apiBaseUrl}/raids/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify({ acceptRaids: next }) });
      if (!res.ok) setAccept(!next);
    } catch { setAccept(!next); }
  };

  const counting = raid && !raid.go ? Math.max(0, Math.ceil((raid.endsAtLocal - now) / 1000)) : null;
  const cooling = cooldownUntil && cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 60000) : 0;

  return (
    <div className="hh-raidhost">
      <p className="hh-settings__intro">
        Send everyone watching to another live 3Speak stream. They get a short countdown, then move over, and that chat sees your raid arrive.
      </p>

      {counting !== null && raid && (
        <div className="hh-raidhost__pending" role="status">
          <span className="hh-raid__count num" aria-hidden="true">{counting}</span>
          <span>Raiding <strong>@{raid.target.host}</strong> with {raid.viewers} viewers</span>
          <button type="button" className="hh-btn hh-btn--small hh-btn--danger" disabled={busy} onClick={() => void cancel()}>Cancel</button>
        </div>
      )}
      {sentTo && counting === null && (
        <p className="hh-raidhost__sent" role="status">Your viewers are on their way to @{sentTo.host}. You can end your stream now.</p>
      )}

      <div className="hh-raidhost__head">
        <strong>Live now</strong>
        <button type="button" className="hh-btn hh-btn--small" onClick={() => void load()} disabled={busy}>Refresh</button>
      </div>
      {targets === null && <p className="hh-raidhost__empty">Loading…</p>}
      {targets !== null && targets.length === 0 && <p className="hh-raidhost__empty">Nobody else is live right now.</p>}
      {targets && targets.length > 0 && (
        <ul className="hh-raidhost__list">
          {targets.map((t) => (
            <li key={t.roomName} className="hh-raidhost__row">
              <span className="hh-raidhost__info">
                <span className="hh-raidhost__title">{t.title}</span>
                <span className="hh-raidhost__meta">@{t.host} · {t.viewers} watching</span>
              </span>
              <button
                type="button"
                className="hh-btn hh-btn--primary hh-btn--small"
                disabled={busy || counting !== null || cooling > 0}
                onClick={() => void start(t)}
              >
                Raid
              </button>
            </li>
          ))}
        </ul>
      )}
      {cooling > 0 && counting === null && <p className="hh-raidhost__empty">You can raid again in {cooling} min.</p>}
      {error && <p className="hh-pollhost__error" role="alert">{error}</p>}

      {accept !== null && (
        <label className="hh-post__vod hh-raidhost__accept">
          <input type="checkbox" checked={accept} onChange={(e) => void toggleAccept(e.target.checked)} />
          <span>
            Accept raids from other streamers
            <em className="hh-post__vod-hint">Off: nobody can send their viewers to your streams.</em>
          </span>
        </label>
      )}
    </div>
  );
}
