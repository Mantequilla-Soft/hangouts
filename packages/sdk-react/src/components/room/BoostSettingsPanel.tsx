import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import type { BoostConfig } from '@snapie/hangouts-core';

async function patchBoostConfig(
  apiBaseUrl: string,
  sessionToken: string | null,
  roomName: string,
  config: { enabled?: boolean; minBoostUsd?: number; creatorPayoutAccount?: string },
): Promise<BoostConfig> {
  const res = await fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/boost`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `Save failed (${res.status})`);
  }
  const data = await res.json() as { boost: BoostConfig };
  return data.boost;
}

interface Props {
  roomName: string;
  currentConfig: BoostConfig | undefined;
  onClose: () => void;
  onSaved: (config: BoostConfig) => void;
}

export function BoostSettingsPanel({ roomName, currentConfig, onClose, onSaved }: Props) {
  const { apiClient, apiBaseUrl } = useHangoutsContext();
  const panelRef = useRef<HTMLDivElement>(null);

  const [enabled, setEnabled] = useState(currentConfig?.enabled ?? true);
  const [minUsd, setMinUsd] = useState(
    currentConfig?.minBoostUsd !== undefined ? String(currentConfig.minBoostUsd) : '0',
  );
  const [payoutAccount, setPayoutAccount] = useState(currentConfig?.creatorPayoutAccount ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !e.composedPath().includes(panelRef.current)) onClose();
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => document.addEventListener('click', onDoc), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDoc);
    };
  }, [onClose]);

  const save = useCallback(async () => {
    const parsed = parseFloat(minUsd);
    if (!Number.isFinite(parsed) || parsed < 0) { setError('Enter a valid minimum (0 = no minimum)'); return; }
    setSaving(true);
    setError(null);
    try {
      const boost = await patchBoostConfig(
        apiBaseUrl,
        apiClient.getSessionToken(),
        roomName,
        { enabled, minBoostUsd: parsed, creatorPayoutAccount: payoutAccount.trim() || undefined },
      );
      onSaved(boost);
      setSaved(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [apiBaseUrl, apiClient, roomName, enabled, minUsd, payoutAccount, onSaved, onClose]);

  return createPortal(
    <div className="hh-boost-settings" ref={panelRef} role="dialog" aria-label="Boost settings">
      <div className="hh-boost-settings__header">
        <span>⚙️ Boost Settings</span>
        <button className="hh-boost-settings__close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="hh-boost-settings__body">
        <label className="hh-boost-settings__row">
          <span>Enable boosts</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={saving}
          />
        </label>

        <label className="hh-boost-settings__field">
          <span className="hh-boost-settings__label">Minimum to show on screen (USD)</span>
          <span className="hh-boost-settings__hint">Below this amount: host gets paid, message stays hidden. 0 = show all.</span>
          <input
            className="hh-boost-settings__input"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={minUsd}
            onChange={(e) => setMinUsd(e.target.value)}
            disabled={saving}
          />
        </label>

        <label className="hh-boost-settings__field">
          <span className="hh-boost-settings__label">Payout account (optional)</span>
          <span className="hh-boost-settings__hint">Hive account that receives the host share. Defaults to your account.</span>
          <input
            className="hh-boost-settings__input"
            type="text"
            placeholder="your-hive-account"
            value={payoutAccount}
            onChange={(e) => setPayoutAccount(e.target.value)}
            disabled={saving}
          />
        </label>

        {error && <p className="hh-boost-settings__error">{error}</p>}
        {saved && <p className="hh-boost-settings__saved">✓ Saved</p>}
      </div>
      <div className="hh-boost-settings__footer">
        <button className="hh-btn hh-btn--secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="hh-btn hh-btn--primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
