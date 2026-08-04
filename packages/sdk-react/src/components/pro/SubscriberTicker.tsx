import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PremiumSubscriber } from '@snapie/hangouts-core';
import { useHangoutsContext } from '../../context/HangoutsContext.js';

export interface SubscriberTickerProps {
  /** Called when a subscriber is clicked. Omit to render them as plain text. */
  onSelectUser?: (username: string) => void;
  /** Max subscribers to load. */
  limit?: number;
}

const avatar = (u: string) => `https://images.hive.blog/u/${u}/avatar/small`;

/**
 * Horizontal marquee of current Pro users; click for the full list.
 * Renders nothing until at least one subscriber loads, so a deployment with no
 * subscribers (or an unreachable API) simply shows no ticker rather than an
 * empty shell.
 */
export function SubscriberTicker({ onSelectUser, limit = 2000 }: SubscriberTickerProps) {
  const { apiClient } = useHangoutsContext();
  const [subs, setSubs] = useState<PremiumSubscriber[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .listPremiumUsers(limit)
      .then((list) => { if (!cancelled) setSubs(list); })
      .catch(() => { /* best-effort — the ticker is decorative */ });
    return () => { cancelled = true; };
  }, [apiClient, limit]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Duplicated so the marquee can loop seamlessly.
  const loop = useMemo(() => [...subs, ...subs], [subs]);
  if (subs.length === 0) return null;

  const select = (u: string) => { setOpen(false); onSelectUser?.(u); };

  return (
    <>
      <div
        className="hh-subticker"
        onClick={() => setOpen(true)}
        title="See all Pro users"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') setOpen(true); }}
      >
        <span className="hh-subticker__label">
          👑 {subs.length} Pro user{subs.length !== 1 ? 's' : ''}
        </span>
        <div className="hh-subticker__viewport">
          <div
            className="hh-subticker__track"
            style={{ animationDuration: `${Math.max(20, subs.length * 3)}s` }}
          >
            {loop.map((s, i) => (
              <span className="hh-subticker__item" key={`${s.username}-${i}`}>
                <img src={avatar(s.username)} alt="" loading="lazy" />
                @{s.username}
              </span>
            ))}
          </div>
        </div>
      </div>

      {open && createPortal(
        <div className="hh-submodal__overlay" onClick={() => setOpen(false)}>
          <div className="hh-submodal" onClick={(e) => e.stopPropagation()}>
            <div className="hh-submodal__header">
              <h3>👑 Pro users ({subs.length})</h3>
              <button className="hh-submodal__close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="hh-submodal__list">
              {subs.map((s) => (
                <button
                  type="button"
                  className="hh-submodal__item"
                  key={s.username}
                  onClick={() => select(s.username)}
                  disabled={!onSelectUser}
                >
                  <img src={avatar(s.username)} alt="" loading="lazy" />
                  <span className="hh-submodal__name">@{s.username}</span>
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
