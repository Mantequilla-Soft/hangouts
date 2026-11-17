import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import type { BoostConfig } from '@snapie/hangouts-core';
import {
  alertSettings,
  boostPresets,
  boostSpeechText,
  DEFAULT_BOOST_PRESETS,
  GOAL_POSITIONS,
  MAX_BOOST_PRESETS,
  parsePresetsInput,
  readBoostGoal,
  tiersEnabled,
  type BoostAlertSettings,
  type BoostRoomConfig,
  type GoalPosition,
} from '../../lib/boostGoals.js';

const GOAL_POSITION_LABELS: Record<GoalPosition, string> = {
  bottom: 'Bottom',
  top: 'Top',
  'top-right': 'Small, top right',
  'bottom-right': 'Small, bottom right',
  'bottom-left': 'Small, bottom left',
};
import { playBoostChime, speakBoost } from '../../lib/boostChime.js';

/** What PATCH /rooms/:name/boost takes. */
export interface BoostSettingsUpdate {
  enabled?: boolean;
  minBoostUsd?: number;
  creatorPayoutAccount?: string;
  /** null removes the goal. */
  goal?: { title: string; targetHbd: number; position?: GoalPosition } | null;
  tiers?: boolean;
  alerts?: BoostAlertSettings;
  /** [] goes back to the default amounts. */
  presets?: number[];
}

async function patchBoostConfig(
  apiBaseUrl: string,
  sessionToken: string | null,
  roomName: string,
  config: BoostSettingsUpdate,
): Promise<BoostRoomConfig> {
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
  const data = await res.json() as { boost: BoostRoomConfig };
  return data.boost;
}

interface Props {
  roomName: string;
  /** The room's boost block as stored (old fields and the goal / tiers /
   *  alerts / presets). */
  currentConfig: BoostConfig | BoostRoomConfig | undefined;
  onClose: () => void;
  onSaved: (config: BoostRoomConfig) => void;
  /** In a panel of the host's page (the studio's Boosts tab) rather than a
   *  floating dialog: no close button, Escape or outside click, and it stays
   *  open after saving. */
  embedded?: boolean;
}

export function BoostSettingsPanel({ roomName, currentConfig, onClose, onSaved, embedded = false }: Props) {
  const { apiClient, apiBaseUrl } = useHangoutsContext();
  const panelRef = useRef<HTMLDivElement>(null);
  const goal = readBoostGoal(currentConfig);
  const alerts = alertSettings(currentConfig);

  const [enabled, setEnabled] = useState(currentConfig?.enabled ?? true);
  const [minUsd, setMinUsd] = useState(
    currentConfig?.minBoostUsd !== undefined ? String(currentConfig.minBoostUsd) : '0',
  );
  const [payoutAccount, setPayoutAccount] = useState(currentConfig?.creatorPayoutAccount ?? '');
  const [goalTitle, setGoalTitle] = useState(goal?.title ?? '');
  const [goalTarget, setGoalTarget] = useState(goal ? String(goal.targetHbd) : '');
  const [goalPosition, setGoalPosition] = useState<GoalPosition>(goal?.position ?? 'bottom');
  const [tiers, setTiers] = useState(tiersEnabled(currentConfig));
  const [sound, setSound] = useState(alerts.sound);
  const [tts, setTts] = useState(alerts.tts);
  const [ttsMin, setTtsMin] = useState(String(alerts.ttsMinHbd));
  const [presets, setPresets] = useState(boostPresets(currentConfig).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (embedded) return undefined;
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
  }, [onClose, embedded]);

  const tryAlert = useCallback(() => {
    if (sound) playBoostChime('boost', 2);
    if (tts) speakBoost(boostSpeechText({ sender: 'badadib', amount: '5.000', asset: 'HBD', message: 'This is how a boost sounds.' }));
  }, [sound, tts]);

  const save = useCallback(async () => {
    const parsed = parseFloat(minUsd);
    if (!Number.isFinite(parsed) || parsed < 0) { setError('Enter a valid minimum (0 = no minimum)'); return; }

    // An empty goal amount removes the goal; a title alone is not a goal.
    let goalUpdate: BoostSettingsUpdate['goal'] = null;
    if (goalTarget.trim()) {
      const target = parseFloat(goalTarget);
      if (!Number.isFinite(target) || target <= 0) { setError('Enter a goal amount above 0, or leave it empty for no goal'); return; }
      goalUpdate = { title: goalTitle.trim(), targetHbd: target, position: goalPosition };
    }

    const ttsMinNum = parseFloat(ttsMin);
    if (!Number.isFinite(ttsMinNum) || ttsMinNum < 0) { setError('Enter a valid minimum for reading boosts aloud'); return; }

    const presetList = parsePresetsInput(presets);
    if (presetList === null) { setError('Preset amounts must be numbers above 0, separated by commas'); return; }
    if (presetList.length > MAX_BOOST_PRESETS) { setError(`At most ${MAX_BOOST_PRESETS} preset amounts`); return; }
    // The defaults, unchanged, are stored as "use the defaults" ([]), so a
    // later change of the SDK's defaults reaches this room too.
    const sameAsDefault = presetList.length === DEFAULT_BOOST_PRESETS.length
      && [...presetList].sort((a, b) => a - b).every((n, i) => n === DEFAULT_BOOST_PRESETS[i]);

    setSaving(true);
    setError(null);
    try {
      const boost = await patchBoostConfig(
        apiBaseUrl,
        apiClient.getSessionToken(),
        roomName,
        {
          enabled,
          minBoostUsd: parsed,
          creatorPayoutAccount: payoutAccount.trim() || undefined,
          goal: goalUpdate,
          tiers,
          alerts: { sound, tts, ttsMinHbd: ttsMinNum },
          presets: sameAsDefault ? [] : presetList,
        },
      );
      onSaved(boost);
      setSaved(true);
      if (embedded) setTimeout(() => setSaved(false), 2500);
      else setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [apiBaseUrl, apiClient, roomName, enabled, minUsd, payoutAccount, goalTitle, goalTarget, goalPosition, tiers, sound, tts, ttsMin, presets, onSaved, onClose, embedded]);

  const panel = (
    <div
      className={`hh-boost-settings${embedded ? ' hh-boost-settings--embedded' : ''}`}
      ref={panelRef}
      role={embedded ? 'region' : 'dialog'}
      aria-label="Boost settings"
    >
      {!embedded && (
        <div className="hh-boost-settings__header">
          <span><span className="hh-boost-settings__icon" aria-hidden="true">⚙️</span> Boost settings</span>
          <button className="hh-boost-settings__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
      )}
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

        <div className="hh-boost-settings__section">
          <span className="hh-boost-settings__section-title">Goal</span>
          <span className="hh-boost-settings__hint">
            Viewers see a bar filling up with the boosts paid to you on this stream. HIVE boosts count at their HBD value when they arrive. Leave the amount empty for no goal.
          </span>
          <label className="hh-boost-settings__field">
            <span className="hh-boost-settings__label">What it's for</span>
            <input
              className="hh-boost-settings__input"
              type="text"
              maxLength={80}
              placeholder="A new mic"
              value={goalTitle}
              onChange={(e) => setGoalTitle(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="hh-boost-settings__field">
            <span className="hh-boost-settings__label">Goal amount (HBD)</span>
            <input
              className="hh-boost-settings__input"
              type="number"
              min="0"
              step="0.001"
              placeholder="50"
              value={goalTarget}
              onChange={(e) => setGoalTarget(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="hh-boost-settings__field">
            <span className="hh-boost-settings__label">Where viewers see it</span>
            <select
              className="hh-boost-settings__input"
              value={goalPosition}
              onChange={(e) => setGoalPosition(e.target.value as GoalPosition)}
              disabled={saving}
            >
              {GOAL_POSITIONS.map((p) => <option key={p} value={p}>{GOAL_POSITION_LABELS[p]}</option>)}
            </select>
          </label>
        </div>

        <div className="hh-boost-settings__section">
          <span className="hh-boost-settings__section-title">On screen</span>
          <label className="hh-boost-settings__row">
            <span>Amount tiers</span>
            <input type="checkbox" checked={tiers} onChange={(e) => setTiers(e.target.checked)} disabled={saving} />
          </label>
          <span className="hh-boost-settings__hint">
            Bigger boosts stand out more and stay up longer: under 1 HBD 15 seconds, 1 to 5 HBD 30 seconds, 5 to 20 HBD 1 minute, 20 HBD and more 2 minutes. Off: every boost stays 30 seconds.
          </span>
        </div>

        <div className="hh-boost-settings__section">
          <span className="hh-boost-settings__section-title">Alerts in the studio</span>
          <label className="hh-boost-settings__row">
            <span>Play a sound for each boost</span>
            <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} disabled={saving} />
          </label>
          <label className="hh-boost-settings__row">
            <span>Read boosts aloud</span>
            <input type="checkbox" checked={tts} onChange={(e) => setTts(e.target.checked)} disabled={saving} />
          </label>
          {tts && (
            <label className="hh-boost-settings__field">
              <span className="hh-boost-settings__label">Read aloud from (HBD)</span>
              <input
                className="hh-boost-settings__input"
                type="number"
                min="0"
                step="0.01"
                value={ttsMin}
                onChange={(e) => setTtsMin(e.target.value)}
                disabled={saving}
              />
            </label>
          )}
          <span className="hh-boost-settings__hint">They play on this device, not in the stream.</span>
          {(sound || tts) && (
            <button type="button" className="hh-btn hh-btn--secondary hh-btn--small hh-boost-settings__try" onClick={tryAlert}>
              Try it
            </button>
          )}
        </div>

        <label className="hh-boost-settings__field">
          <span className="hh-boost-settings__label">Preset amounts</span>
          <span className="hh-boost-settings__hint">
            {`The quick picks in the viewers' boost dialog, up to ${MAX_BOOST_PRESETS}, separated by commas. Empty: ${DEFAULT_BOOST_PRESETS.join(', ')}.`}
          </span>
          <input
            className="hh-boost-settings__input"
            type="text"
            inputMode="decimal"
            placeholder={DEFAULT_BOOST_PRESETS.join(', ')}
            value={presets}
            onChange={(e) => setPresets(e.target.value)}
            disabled={saving}
          />
        </label>

        {error && <p className="hh-boost-settings__error">{error}</p>}
        {saved && <p className="hh-boost-settings__saved">✓ Saved</p>}
      </div>
      <div className="hh-boost-settings__footer">
        {!embedded && <button className="hh-btn hh-btn--secondary" onClick={onClose} disabled={saving}>Cancel</button>}
        <button className="hh-btn hh-btn--primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
  return embedded ? panel : createPortal(panel, document.body);
}
