import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParticipants } from '@livekit/components-react';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { useStreamContext } from './StandaloneWatch.js';
import type { BoostConfig } from '@snapie/hangouts-core';

interface Props {
  roomName: string;
  boostConfig: BoostConfig;
  onClose: () => void;
  /** Wrap the signing call so the integrator can show its own "approve in your
   *  wallet" UI — e.g. 3Speak's HiveAuth waiting overlay, so a HiveAuth user
   *  knows to open their app and sign. Defaults to running the op directly, so
   *  Keychain / HiveSigner are unaffected. */
  signWrapper?: <T>(op: () => Promise<T>, message?: string) => Promise<T>;
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

export function SendBoostDialog({ roomName, boostConfig, onClose, signWrapper }: Props) {
  const { apiBaseUrl, username, aioha } = useHangoutsContext();
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
  const [asset, setAsset] = useState<'HBD' | 'HIVE'>('HBD');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfigLoading(true);
    setConfigError(null);
    fetch(`${apiBaseUrl}/boosts/config`)
      .then((r) => r.json() as Promise<{ enabled: boolean; platformAccount: string; feePercent?: number }>)
      .then((cfg) => {
        if (!cfg.enabled) {
          setConfigError('Boosts are not enabled on this server');
          setPlatformAccount(null);
        } else if (!cfg.platformAccount) {
          setConfigError('Platform wallet not configured');
          setPlatformAccount(null);
        } else {
          setPlatformAccount(cfg.platformAccount);
          setFeePercent(typeof cfg.feePercent === 'number' && Number.isFinite(cfg.feePercent) ? cfg.feePercent : null);
        }
        setConfigLoading(false);
      })
      .catch((err: unknown) => {
        setPlatformAccount(null);
        setConfigError(`Could not reach boost config: ${err instanceof Error ? err.message : String(err)}`);
        setConfigLoading(false);
      });
  }, [apiBaseUrl]);

  const send = useCallback(async () => {
    if (!username || !platformAccount) return;
    const amtNum = parseFloat(amount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) { setError('Enter a valid amount'); return; }
    if (!message.trim()) { setError('Enter a message'); return; }
    // REFUSE to send below the room's minimum. The server accepts these and
    // broadcasts them, but the on-screen overlay filters them out — so without
    // this the money leaves the sender's wallet and nothing whatsoever appears,
    // with no error to explain it. Only enforceable for HBD, whose $1 peg we
    // can rely on; the HIVE rate isn't known client-side.
    const min = boostConfig.minBoostUsd ?? 0;
    if (min > 0 && asset === 'HBD' && amtNum < min) {
      setError(`This stream's minimum is $${min.toFixed(2)}. A smaller boost won't show on screen.`);
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
      const msg = 'Approve the boost in your HiveAuth app';
      // Capture into consts so the narrowing survives into the arrow closure
      // below; call() keeps `this` bound to the aioha instance.
      const a = aioha;
      const transfer = a?.transfer;
      if (a && transfer) {
        const result = await runSign(() => transfer.call(a, platformAccount, amtNum, asset, memo), msg);
        if (!result.success) throw new Error(result.error || 'Transfer failed');
      } else {
        await runSign(() => keychainTransfer(username, platformAccount, amtStr, memo, asset), msg);
      }
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed');
      setStatus('error');
    }
  }, [username, platformAccount, amount, asset, message, roomName, aioha, activeRecipient]);

  return createPortal(
    <div className="hh-boost-dialog__overlay" onClick={onClose}>
      <div className="hh-boost-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Send a Boost">
        <div className="hh-boost-dialog__header">
          <span>🚀 Send a Boost</span>
          <button className="hh-boost-dialog__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {status === 'done' ? (
          <div className="hh-boost-dialog__body hh-boost-dialog__body--success">
            <div className="hh-boost-dialog__success-icon">✅</div>
            <p>Boost sent! It'll appear on screen in a moment.</p>
            <button className="hh-btn hh-btn--primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className="hh-boost-dialog__body">
              <div className="hh-boost-dialog__amount-row">
                <input
                  className="hh-boost-dialog__amount"
                  type="number"
                  min="0.001"
                  step="0.001"
                  placeholder="0.000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={status === 'sending'}
                />
                <select
                  className="hh-boost-dialog__asset"
                  value={asset}
                  onChange={(e) => setAsset(e.target.value as 'HBD' | 'HIVE')}
                  disabled={status === 'sending'}
                >
                  <option value="HBD">HBD</option>
                  <option value="HIVE">HIVE</option>
                </select>
              </div>

              {recipients.length > 1 && (
                <div className="hh-boost-dialog__recipients">
                  <span className="hh-boost-dialog__recipients-label">Boost</span>
                  {recipients.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`hh-boost-dialog__recipient${activeRecipient === id ? ' is-active' : ''}`}
                      onClick={() => setRecipient(id)}
                      disabled={status === 'sending'}
                    >
                      @{id}
                      {id === hostIdentity && <em> · host</em>}
                    </button>
                  ))}
                </div>
              )}

              <p className="hh-boost-dialog__rate-hint">
                {asset === 'HBD'
                  ? '1 HBD = $1.00 — pegged to USD'
                  : 'HIVE price varies with the market'}
              </p>

              {boostConfig.minBoostUsd > 0 && (
                <p className="hh-boost-dialog__hint">
                  Minimum ${boostConfig.minBoostUsd.toFixed(2)} USD to appear on screen
                </p>
              )}

              {feePercent !== null && feePercent > 0 && (
                <p className="hh-boost-dialog__hint">
                  {`${feePercent}% platform fee — @${activeRecipient ?? roomName.split('-')[0]} receives ${(100 - feePercent)}%`}
                  {(() => {
                    const amt = parseFloat(amount);
                    if (!Number.isFinite(amt) || amt <= 0) return null;
                    return ` (${(amt * (100 - feePercent) / 100).toFixed(3)} ${asset})`;
                  })()}
                </p>
              )}

              <textarea
                className="hh-boost-dialog__message"
                placeholder={`Your message (max ${BOOST_MESSAGE_MAX} characters)`}
                maxLength={BOOST_MESSAGE_MAX}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={status === 'sending'}
              />
              <div className="hh-boost-dialog__char-count">{message.length} / {BOOST_MESSAGE_MAX}</div>

              {error && <p className="hh-boost-dialog__error">{error}</p>}
              {configError && <p className="hh-boost-dialog__error">{configError}</p>}
            </div>

            <div className="hh-boost-dialog__footer">
              <button className="hh-btn hh-btn--secondary" onClick={onClose} disabled={status === 'sending'}>
                Cancel
              </button>
              <button
                className="hh-btn hh-btn--primary"
                onClick={send}
                disabled={status === 'sending' || configLoading || !platformAccount}
              >
                {configLoading ? 'Loading…' : status === 'sending' ? 'Sending…' : 'Send Boost'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
