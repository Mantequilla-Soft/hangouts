import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants } from '@livekit/components-react';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { useStreamContext } from './StandaloneWatch.js';
import type { BoostConfig } from '@snapie/hangouts-core';
import { useRoomBoost } from '../../hooks/useRoomBoost.js';
import { fillLabel } from '../../lib/boostGoals.js';
import { boostLabels, type BoostLabels } from '../../lib/boostLabels.js';
import { StreamBoostGoal, BoostTopSupporters } from './StreamBoostGoal.js';

interface Props {
  roomName: string;
  boostConfig: BoostConfig;
  onClose: () => void;
  /** Wrap the signing call so the integrator can show its own "approve in your
   *  wallet" UI — e.g. 3Speak's HiveAuth waiting overlay, so a HiveAuth user
   *  knows to open their app and sign. Defaults to running the op directly, so
   *  Keychain / HiveSigner are unaffected. */
  signWrapper?: <T>(op: () => Promise<T>, message?: string) => Promise<T>;
  /** The dialog's text, for integrators that translate it (see BoostLabels).
   *  Anything left out stays English. */
  labels?: Partial<BoostLabels>;
}

/**
 * Boost messages are burned into the stream, so length is a screen-real-estate
 * decision, not a storage one — one viewer should not be able to cover half the
 * video. The server trims to the same figure, since a memo can be crafted by
 * hand without going through this dialog at all.
 */
export const BOOST_MESSAGE_MAX = 140;

function keychainTransfer(
  username: string,
  to: string,
  amount: string,
  memo: string,
  asset: 'HIVE' | 'HBD',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const kc = (window as unknown as Record<string, unknown>).hive_keychain as {
      requestTransfer: (
        from: string,
        to: string,
        amount: string,
        memo: string,
        asset: string,
        cb: (resp: { success: boolean; message?: string }) => void,
        enforce: boolean,
      ) => void;
    } | undefined;
    if (!kc) { reject(new Error('Hive Keychain is not installed')); return; }
    kc.requestTransfer(username, to, amount, memo, asset, (resp) => {
      if (resp.success) resolve();
      else reject(new Error(resp.message || 'Transfer cancelled'));
    }, false);
  });
}

export function SendBoostDialog({ roomName, boostConfig, onClose, signWrapper, labels }: Props) {
  const { apiBaseUrl, apiClient, username, aioha } = useHangoutsContext();
  const L = useMemo(() => boostLabels(labels), [labels]);
  // The host's preset amounts (or the defaults), live from the room metadata.
  const { presets } = useRoomBoost();
  const [platformAccount, setPlatformAccount] = useState<string | null>(null);
  const [feePercent, setFeePercent] = useState<number | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  // Who can be boosted: whoever is actually ON CAMERA. That's the host, plus a
  // collab guest when one has been brought on. Anonymous viewers are excluded —
  // a guest identity is regenerated per visit, so paying one is paying nobody.
  const participants = useParticipants();
  const { hostIdentity } = useStreamContext();
  const recipients = useMemo(() => {
    const onAir = participants
      .filter((p) => p.permissions?.canPublish && !p.identity.startsWith('obs-') && !p.identity.startsWith('guest-'))
      .map((p) => p.identity);
    // Host first, and always present even if their publication hasn't landed
    // in this client's participant list yet.
    const ordered = hostIdentity ? [hostIdentity, ...onAir.filter((i) => i !== hostIdentity)] : onAir;
    return [...new Set(ordered)];
  }, [participants, hostIdentity]);

  const [recipient, setRecipient] = useState<string | null>(null);
  // Default to the host, and re-point if the pick leaves (guest removed).
  const activeRecipient = recipient && recipients.includes(recipient) ? recipient : recipients[0] ?? null;

  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState<'HBD' | 'HIVE' | 'POINTS'>('HBD');
  const points = asset === 'POINTS';
  // Paying with channel points: the server's minimum, how many points make
  // 1 HBD (for the host's "minimum to show"), and the viewer's balance.
  const [pointsCfg, setPointsCfg] = useState<{ min: number; perHbd: number } | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfigLoading(true);
    setConfigError(null);
    fetch(`${apiBaseUrl}/boosts/config`)
      .then((r) => r.json() as Promise<{ enabled: boolean; platformAccount: string; feePercent?: number; points?: { min: number; perHbd: number } }>)
      .then((cfg) => {
        if (cfg.points && cfg.points.min > 0 && cfg.points.perHbd > 0) setPointsCfg(cfg.points);
        if (!cfg.enabled) {
          setConfigError(L.errNotEnabled);
          setPlatformAccount(null);
        } else if (!cfg.platformAccount) {
          setConfigError(L.errNoWallet);
          setPlatformAccount(null);
        } else {
          setPlatformAccount(cfg.platformAccount);
          setFeePercent(typeof cfg.feePercent === 'number' && Number.isFinite(cfg.feePercent) ? cfg.feePercent : null);
        }
        setConfigLoading(false);
      })
      .catch((err: unknown) => {
        setPlatformAccount(null);
        setConfigError(fillLabel(L.errConfig, { error: err instanceof Error ? err.message : String(err) }));
        setConfigLoading(false);
      });
  }, [apiBaseUrl]);

  // The balance, once the viewer picks points (and again after a points boost).
  const authHeaders = useCallback((): Record<string, string> => {
    const token = apiClient.getSessionToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [apiClient]);
  useEffect(() => {
    if (!points || !username) return;
    fetch(`${apiBaseUrl}/points`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() as Promise<{ balance?: number }> : null))
      .then((b) => { if (typeof b?.balance === 'number') setBalance(b.balance); })
      .catch(() => { /* the server says so when they send */ });
  }, [points, username, apiBaseUrl, authHeaders]);

  // The smallest points boost: the server's minimum, or more when the host's
  // "minimum to show" asks for it (a smaller one would never appear).
  const pointsMin = pointsCfg
    ? Math.max(pointsCfg.min, Math.ceil((boostConfig.minBoostUsd ?? 0) * pointsCfg.perHbd))
    : 0;
  const pointsPresets = pointsMin > 0 ? [pointsMin, pointsMin * 2, pointsMin * 4] : [];

  const sendPoints = useCallback(async () => {
    if (!username) { setError(L.errSignIn); return; }
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) { setError(L.errAmount); return; }
    if (amt < pointsMin) { setError(fillLabel(L.errPointsMinimum, { min: pointsMin.toLocaleString('en-US') })); return; }
    if (balance !== null && amt > balance) { setError(fillLabel(L.errPointsBalance, { points: balance.toLocaleString('en-US') })); return; }
    if (!message.trim()) { setError(L.errMessage); return; }
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/boosts/points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          amount: amt,
          message: message.trim().slice(0, BOOST_MESSAGE_MAX),
          ...(activeRecipient ? { recipient: activeRecipient } : {}),
        }),
      });
      const body = await res.json().catch(() => ({})) as { balance?: number; message?: string };
      if (!res.ok) throw new Error(body.message || L.errTransfer);
      if (typeof body.balance === 'number') setBalance(body.balance);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : L.errTransfer);
      setStatus('error');
    }
  }, [username, amount, pointsMin, balance, message, apiBaseUrl, roomName, activeRecipient, authHeaders, L]);

  const send = useCallback(async () => {
    if (!username || !platformAccount || asset === 'POINTS') return;
    const amtNum = parseFloat(amount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) { setError(L.errAmount); return; }
    if (!message.trim()) { setError(L.errMessage); return; }
    // REFUSE to send below the room's minimum. The server accepts these and
    // broadcasts them, but the on-screen overlay filters them out — so without
    // this the money leaves the sender's wallet and nothing whatsoever appears,
    // with no error to explain it. Only enforceable for HBD, whose $1 peg we
    // can rely on; the HIVE rate isn't known client-side.
    const min = boostConfig.minBoostUsd ?? 0;
    if (min > 0 && asset === 'HBD' && amtNum < min) {
      setError(fillLabel(L.errMinimum, { min: min.toFixed(2) }));
      return;
    }

    const amtStr = amtNum.toFixed(3);
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const memo = JSON.stringify({
      version: 1,
      room: roomName,
      message: message.trim().slice(0, BOOST_MESSAGE_MAX),
      sender: username,
      nonce,
      // Only meaningful when someone other than the host is on air; the server
      // re-checks it against the room either way.
      ...(activeRecipient ? { recipient: activeRecipient } : {}),
    });

    setStatus('sending');
    setError(null);

    try {
      const runSign = signWrapper ?? (<T,>(op: () => Promise<T>) => op());
      const msg = L.approveHiveAuth;
      // Capture into consts so the narrowing survives into the arrow closure
      // below; call() keeps `this` bound to the aioha instance.
      const a = aioha;
      const transfer = a?.transfer;
      if (a && transfer) {
        const result = await runSign(() => transfer.call(a, platformAccount, amtNum, asset, memo), msg);
        if (!result.success) throw new Error(result.error || L.errTransfer);
      } else {
        await runSign(() => keychainTransfer(username, platformAccount, amtStr, memo, asset), msg);
      }
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : L.errTransfer);
      setStatus('error');
    }
  }, [username, platformAccount, amount, asset, message, roomName, aioha, activeRecipient, L, boostConfig.minBoostUsd, signWrapper]);

  const amountNum = parseFloat(amount);
  const minUsd = boostConfig.minBoostUsd ?? 0;

  return createPortal(
    <div className="hh-boost-dialog__overlay" onClick={onClose}>
      <div className="hh-boost-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={L.dialogTitle}>
        <div className="hh-boost-dialog__header">
          <span><span className="hh-boost-dialog__icon" aria-hidden="true">🚀</span> {L.dialogTitle}</span>
          <button className="hh-boost-dialog__close" onClick={onClose} aria-label={L.close}>✕</button>
        </div>

        {status === 'done' ? (
          <div className="hh-boost-dialog__body hh-boost-dialog__body--success">
            <div className="hh-boost-dialog__success-icon">✅</div>
            <p>{L.success}</p>
            <button className="hh-btn hh-btn--primary" onClick={onClose}>{L.done}</button>
          </div>
        ) : (
          <>
            <div className="hh-boost-dialog__body">
              <StreamBoostGoal variant="inline" labels={labels} />

              <div className="hh-boost-dialog__presets" role="group" aria-label={L.presetsLabel}>
                {(points ? pointsPresets : presets).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`hh-boost-dialog__preset${amountNum === p ? ' is-active' : ''}`}
                    aria-pressed={amountNum === p}
                    // Below the minimum a boost won't show on screen, so the
                    // dialog refuses it anyway (HBD only, see send()).
                    disabled={status === 'sending' || (asset === 'HBD' && minUsd > 0 && p < minUsd) || (points && balance !== null && p > balance)}
                    onClick={() => { setAmount(String(p)); setError(null); }}
                  >
                    {points ? fillLabel(L.pointsAmount, { points: p.toLocaleString('en-US') }) : `${p} ${asset}`}
                  </button>
                ))}
              </div>

              <div className="hh-boost-dialog__amount-row">
                <input
                  className="hh-boost-dialog__amount"
                  type="number"
                  min={points ? pointsMin || 1 : 0.001}
                  step={points ? 1 : 0.001}
                  placeholder={L.customAmount}
                  aria-label={L.customAmount}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={status === 'sending'}
                />
                <select
                  className="hh-boost-dialog__asset"
                  value={asset}
                  onChange={(e) => { setAsset(e.target.value as 'HBD' | 'HIVE' | 'POINTS'); setAmount(''); setError(null); }}
                  disabled={status === 'sending'}
                >
                  <option value="HBD">HBD</option>
                  <option value="HIVE">HIVE</option>
                  {pointsCfg && <option value="POINTS">{L.assetPoints}</option>}
                </select>
              </div>

              {recipients.length > 1 && (
                <div className="hh-boost-dialog__recipients">
                  <span className="hh-boost-dialog__recipients-label">{L.recipientsLabel}</span>
                  {recipients.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`hh-boost-dialog__recipient${activeRecipient === id ? ' is-active' : ''}`}
                      onClick={() => setRecipient(id)}
                      disabled={status === 'sending'}
                    >
                      @{id}
                      {id === hostIdentity && <em> · {L.hostTag}</em>}
                    </button>
                  ))}
                </div>
              )}

              {points ? (
                <p className="hh-boost-dialog__rate-hint">
                  {balance !== null && <strong>{fillLabel(L.pointsBalance, { points: balance.toLocaleString('en-US') })} </strong>}
                  {L.pointsHint}
                </p>
              ) : (
                <p className="hh-boost-dialog__rate-hint">
                  {asset === 'HBD' ? L.rateHbd : L.rateHive}
                </p>
              )}

              {!points && boostConfig.minBoostUsd > 0 && (
                <p className="hh-boost-dialog__hint">
                  {fillLabel(L.minimumHint, { min: boostConfig.minBoostUsd.toFixed(2) })}
                </p>
              )}

              {!points && feePercent !== null && feePercent > 0 && (
                <p className="hh-boost-dialog__hint">
                  {fillLabel(L.feeHint, { fee: feePercent, recipient: activeRecipient ?? roomName.split('-')[0], share: 100 - feePercent })}
                  {Number.isFinite(amountNum) && amountNum > 0
                    ? ` ${fillLabel(L.feeAmount, { amount: (amountNum * (100 - feePercent) / 100).toFixed(3), asset })}`
                    : null}
                </p>
              )}

              <textarea
                className="hh-boost-dialog__message"
                placeholder={fillLabel(L.messagePlaceholder, { max: BOOST_MESSAGE_MAX })}
                maxLength={BOOST_MESSAGE_MAX}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={status === 'sending'}
              />
              <div className="hh-boost-dialog__char-count">{message.length} / {BOOST_MESSAGE_MAX}</div>

              {error && <p className="hh-boost-dialog__error">{error}</p>}
              {configError && !points && <p className="hh-boost-dialog__error">{configError}</p>}

              <BoostTopSupporters labels={labels} className="hh-boost-dialog__top" />
            </div>

            <div className="hh-boost-dialog__footer">
              <button className="hh-btn hh-btn--secondary" onClick={onClose} disabled={status === 'sending'}>
                {L.cancel}
              </button>
              <button
                className="hh-btn hh-btn--primary"
                onClick={points ? sendPoints : send}
                disabled={status === 'sending' || configLoading || (!points && !platformAccount)}
              >
                {configLoading ? L.loading : status === 'sending' ? L.sending : L.send}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
