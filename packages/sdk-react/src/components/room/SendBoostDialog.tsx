import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import type { BoostConfig } from '@snapie/hangouts-core';

interface Props {
  roomName: string;
  boostConfig: BoostConfig;
  onClose: () => void;
}

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

export function SendBoostDialog({ roomName, boostConfig, onClose }: Props) {
  const { apiClient, username, aioha } = useHangoutsContext();
  const [platformAccount, setPlatformAccount] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState<'HBD' | 'HIVE'>('HBD');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guard against older sdk-core versions where getBoostConfig doesn't exist yet.
    try {
      const maybeConfig = (apiClient as typeof apiClient & { getBoostConfig?: () => Promise<{ platformAccount: string }> }).getBoostConfig?.();
      if (!maybeConfig) { setPlatformAccount(null); return; }
      maybeConfig
        .then((cfg) => setPlatformAccount(cfg.platformAccount || null))
        .catch(() => setPlatformAccount(null));
    } catch {
      setPlatformAccount(null);
    }
  }, [apiClient]);

  const send = useCallback(async () => {
    if (!username || !platformAccount) return;
    const amtNum = parseFloat(amount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) { setError('Enter a valid amount'); return; }
    if (!message.trim()) { setError('Enter a message'); return; }

    const amtStr = amtNum.toFixed(3);
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const memo = JSON.stringify({
      version: 1,
      room: roomName,
      message: message.trim().slice(0, 280),
      sender: username,
      nonce,
    });

    setStatus('sending');
    setError(null);

    try {
      if (aioha?.transfer) {
        const result = await aioha.transfer(platformAccount, amtNum, asset, memo);
        if (!result.success) throw new Error(result.error || 'Transfer failed');
      } else {
        await keychainTransfer(username, platformAccount, amtStr, memo, asset);
      }
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed');
      setStatus('error');
    }
  }, [username, platformAccount, amount, asset, message, roomName, aioha]);

  return createPortal(
    <div className="hh-boost-dialog__overlay" onClick={onClose}>
      <div className="hh-boost-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Send a Boost">
        <div className="hh-boost-dialog__header">
          <span>💸 Send a Boost</span>
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

              {boostConfig.minBoostUsd > 0 && (
                <p className="hh-boost-dialog__hint">
                  Minimum ${boostConfig.minBoostUsd.toFixed(2)} USD to appear on screen
                </p>
              )}

              <textarea
                className="hh-boost-dialog__message"
                placeholder="Your message (max 280 characters)"
                maxLength={280}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={status === 'sending'}
              />
              <div className="hh-boost-dialog__char-count">{message.length} / 280</div>

              {error && <p className="hh-boost-dialog__error">{error}</p>}
            </div>

            <div className="hh-boost-dialog__footer">
              <button className="hh-btn hh-btn--secondary" onClick={onClose} disabled={status === 'sending'}>
                Cancel
              </button>
              <button
                className="hh-btn hh-btn--primary"
                onClick={send}
                disabled={status === 'sending' || !platformAccount}
              >
                {status === 'sending' ? 'Sending…' : 'Send Boost'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
