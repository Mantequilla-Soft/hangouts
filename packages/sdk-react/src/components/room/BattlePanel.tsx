import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BattleCandidate, StudioBattle } from '../../hooks/useBattle.js';
import { BATTLE_DURATIONS, battleRemainingMs, formatBattleClock } from '../../lib/battle.js';
import { StreamBattleBar } from './StreamBattleBar.js';

const minutes = (sec: number) => Math.round(sec / 60);

/**
 * The incoming invite, for the invited host: who, how long, Accept / Decline.
 * The studio shows it over the preview the moment it arrives, wherever the
 * host is looking, and inside the battle panel.
 */
export function BattleInviteCard({ battle, className }: { battle: StudioBattle; className?: string }) {
  const b = battle.battle;
  if (!b || battle.phase !== 'invited' || battle.side !== 'b') return null;
  const left = formatBattleClock(battleRemainingMs(b, battle.now));
  return (
    <div className={`hh-battle-invite${className ? ` ${className}` : ''}`} role="alertdialog" aria-label="Battle invite">
      <div className="hh-battle-invite__text">
        <strong>@{b.a.host}</strong> challenges you to a {minutes(b.durationSec)} minute battle.
        <span className="hh-battle-invite__sub"> Your viewers and theirs see you side by side; boosts decide who wins, and each of you keeps your own. Answer within {left}.</span>
      </div>
      {battle.error && <p className="hh-battle-panel__error">{battle.error}</p>}
      <div className="hh-battle-invite__actions">
        <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={battle.busy} onClick={() => void battle.respond(false)}>Decline</button>
        <button type="button" className="hh-btn hh-btn--primary hh-btn--small" disabled={battle.busy} onClick={() => void battle.respond(true)}>Accept</button>
      </div>
    </div>
  );
}

export interface BattlePanelProps {
  battle: StudioBattle;
  /** The stream is live (Start was hit): battles are between live streams. */
  streamLive: boolean;
  /** A collab guest is on air: one or the other. */
  hasGuest: boolean;
  onClose: () => void;
}

/**
 * The studio's battle panel: pick 3, 5 or 10 minutes, invite a live stream
 * from the list or by name, follow the invite, and end a running battle.
 */
export function BattlePanel({ battle, streamLive, hasGuest, onClose }: BattlePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState<number>(300);
  const [name, setName] = useState('');
  const [list, setList] = useState<BattleCandidate[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const { phase, side, them } = battle;
  const b = battle.battle;
  const idle = !phase || phase === 'result';
  const canInvite = idle && streamLive && !hasGuest;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !e.composedPath().includes(panelRef.current)) onClose();
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => document.addEventListener('click', onDoc), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDoc);
    };
  }, [onClose]);

  const { candidates } = battle;
  const load = useCallback(async () => {
    setListError(null);
    try { setList(await candidates()); } catch (err) {
      setList([]);
      setListError(err instanceof Error ? err.message : 'Could not load the live streams');
    }
  }, [candidates]);
  useEffect(() => { if (canInvite) void load(); }, [canInvite, load]);

  const invite = async (opponent: string) => {
    if (!opponent.trim()) return;
    if (await battle.invite(opponent.trim(), duration)) setName('');
  };

  return createPortal(
    <div className="hh-battle-panel" ref={panelRef} role="dialog" aria-label="Live battle">
      <div className="hh-battle-panel__header">
        <span><span className="hh-battle-panel__icon" aria-hidden="true">⚔️</span> Live battle</span>
        <button type="button" className="hh-battle-panel__close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="hh-battle-panel__body">
        {(battle.onAir || phase === 'result') && <StreamBattleBar variant="inline" all host={battle.me?.host} />}

        {battle.onAir && (
          <>
            <label className="hh-battle-panel__row">
              <span>Hear @{them?.host} in your headphones</span>
              <input type="checkbox" checked={battle.hear} onChange={(e) => battle.setHear(e.target.checked)} />
            </label>
            <p className="hh-battle-panel__hint">
              Your viewers hear both of you either way. {battle.link.connected ? '' : 'Connecting to the other stream…'}
            </p>
            {confirmEnd ? (
              <div className="hh-battle-panel__confirm">
                <span>End the battle now? Nobody wins a battle that ends early.</span>
                <div className="hh-battle-panel__actions">
                  <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" onClick={() => setConfirmEnd(false)}>Keep going</button>
                  <button type="button" className="hh-btn hh-btn--danger hh-btn--small" disabled={battle.busy} onClick={() => { setConfirmEnd(false); void battle.end(); }}>End battle</button>
                </div>
              </div>
            ) : (
              <button type="button" className="hh-btn hh-btn--danger hh-btn--small hh-battle-panel__end" onClick={() => setConfirmEnd(true)}>End battle</button>
            )}
          </>
        )}

        {phase === 'invited' && side === 'a' && b && (
          <div className="hh-battle-panel__waiting">
            <span>Waiting for <strong>@{b.b.host}</strong> to accept · {formatBattleClock(battleRemainingMs(b, battle.now))}</span>
            <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={battle.busy} onClick={() => void battle.end()}>Withdraw</button>
          </div>
        )}
        <BattleInviteCard battle={battle} />

        {idle && (
          <>
            <p className="hh-battle-panel__hint">
              Challenge another live stream. You both appear side by side on both streams for the set time, and the
              boosts each of you gets in that time decide the winner. Each of you keeps your own boosts.
            </p>
            {!streamLive && <p className="hh-battle-panel__note">Go live first (or resume): battles are between two live streams.</p>}
            {hasGuest && <p className="hh-battle-panel__note">Remove your guest first: a battle takes the whole screen.</p>}
            <div className="hh-battle-panel__field">
              <span className="hh-battle-panel__label">How long</span>
              <div className="hh-battle-panel__chips" role="radiogroup" aria-label="Battle length">
                {BATTLE_DURATIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={duration === d}
                    className={`hh-battle-panel__chip${duration === d ? ' hh-battle-panel__chip--on' : ''}`}
                    onClick={() => setDuration(d)}
                  >{minutes(d)} min</button>
                ))}
              </div>
            </div>
            <form className="hh-battle-panel__field" onSubmit={(e) => { e.preventDefault(); void invite(name); }}>
              <span className="hh-battle-panel__label">Invite by name</span>
              <div className="hh-battle-panel__inline">
                <input
                  className="hh-battle-panel__input"
                  type="text"
                  placeholder="hive-account"
                  value={name}
                  maxLength={64}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canInvite || battle.busy}
                />
                <button type="submit" className="hh-btn hh-btn--primary hh-btn--small" disabled={!canInvite || battle.busy || !name.trim()}>Invite</button>
              </div>
            </form>
            <div className="hh-battle-panel__field">
              <span className="hh-battle-panel__label">
                Live now
                <button type="button" className="hh-battle-panel__refresh" onClick={() => void load()} disabled={!canInvite} aria-label="Refresh the list">↻</button>
              </span>
              {listError && <p className="hh-battle-panel__error">{listError}</p>}
              {list && list.length === 0 && !listError && <p className="hh-battle-panel__hint">No other live streams can battle right now.</p>}
              {list && list.length > 0 && (
                <ul className="hh-battle-panel__list">
                  {list.map((c) => (
                    <li key={c.room} className="hh-battle-panel__item">
                      <span className="hh-battle-panel__who">
                        <span className="hh-battle-panel__host">@{c.host}</span>
                        {c.title && <span className="hh-battle-panel__title">{c.title}</span>}
                      </span>
                      <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={!canInvite || battle.busy} onClick={() => void invite(c.room)}>Invite</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
        {battle.error && !(phase === 'invited' && side === 'b') && <p className="hh-battle-panel__error" role="alert">{battle.error}</p>}
      </div>
    </div>,
    document.body,
  );
}
