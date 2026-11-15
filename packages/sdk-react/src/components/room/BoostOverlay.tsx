import { useCallback, useEffect, useState } from 'react';
import { useBoostStore, type BoostEvent } from '../../hooks/useBoosts.js';
import { useRoomBoost } from '../../hooks/useRoomBoost.js';
import { boostDisplayMs, boostTier, pickPinnedBoosts } from '../../lib/boostGoals.js';

function formatBoostAmount(amount: string, asset: string, usdAmount: number): string {
  return `${amount} ${asset} ($${usdAmount.toFixed(2)})`;
}

interface BoostCardProps {
  boost: BoostEvent;
  onDismiss: () => void;
  /** How long this card stays: its tier's time, or the fixed time. */
  displayMs: number;
  /** The amount tier's CSS modifier, or null with tiers off. */
  tier: number | null;
}

function BoostCard({ boost, onDismiss, displayMs, tier }: BoostCardProps) {
  const [fading, setFading] = useState(false);

  const dismiss = useCallback(() => {
    if (fading) return;
    setFading(true);
    setTimeout(onDismiss, 400);
  }, [fading, onDismiss]);

  // Auto-dismiss once its display window is up.
  useEffect(() => {
    const timer = setTimeout(dismiss, displayMs);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`hh-boost-overlay__item${tier !== null ? ` hh-boost-overlay__item--tier-${tier}` : ''}${fading ? ' hh-boost-overlay__item--fading' : ''}`}>
      <button
        className="hh-boost-overlay__dismiss"
        onClick={dismiss}
        aria-label="Dismiss boost"
      >
        ✕
      </button>
      <div className="hh-boost-overlay__top">
        <span className="hh-boost-overlay__label">🚀 Boost</span>
        <span className="hh-boost-overlay__amount">
          {formatBoostAmount(boost.amount, boost.asset, boost.usdAmount)}
        </span>
      </div>
      <div className="hh-boost-overlay__from">
        from @{boost.displayName || boost.sender}
      </div>
      <div className="hh-boost-overlay__message">{boost.message}</div>
    </div>
  );
}

/**
 * What this client has already put on screen, at MODULE level.
 *
 * It used to be component state, but the boost list itself outlives the overlay
 * (it lives in context and sessionStorage). So any remount of the overlay —
 * which happens on things as unrelated as a collab guest leaving the stage —
 * cleared the "already dismissed" set and replayed every boost still in the
 * store. Module scope means a remount can't forget.
 */
const firstShownAt = new Map<string, number>();
const dismissedIds = new Set<string>();

export function BoostOverlay() {
  const boosts = useBoostStore();
  const { tiersOn } = useRoomBoost();
  const [, bumpRender] = useState(0);

  const dismiss = useCallback((id: string) => {
    dismissedIds.add(id);
    bumpRender((n) => n + 1);
  }, []);

  const now = Date.now();
  const candidates = boosts.filter((b) => {
    if (b.belowMinimum || dismissedIds.has(b.id)) return false;
    const windowMs = boostDisplayMs(b.usdAmount, tiersOn);
    const shownAt = firstShownAt.get(b.id);
    if (shownAt !== undefined) {
      // Mid-flight when we remounted: let it finish its time on screen.
      return now - shownAt < windowMs;
    }
    // Never shown here. Only announce it if it's actually NEW: sessionStorage
    // replays the whole list after a reload, and a boost from ten minutes ago
    // popping up as if it just arrived is worse than missing it.
    return now - b.timestamp < windowMs;
  });
  // At most five; with tiers on, the big ones keep their place.
  const visible = pickPinnedBoosts(
    candidates.map((b) => ({ ...b, timestamp: firstShownAt.get(b.id) ?? b.timestamp })),
    now,
    tiersOn,
    5,
  );
  for (const b of visible) if (!firstShownAt.has(b.id)) firstShownAt.set(b.id, now);

  if (visible.length === 0) return null;

  return (
    <div className="hh-boost-overlay" aria-live="polite">
      {visible.map((boost) => (
        <BoostCard
          key={boost.id}
          boost={boost}
          displayMs={boostDisplayMs(boost.usdAmount, tiersOn)}
          tier={tiersOn ? boostTier(boost.usdAmount).level : null}
          onDismiss={() => dismiss(boost.id)}
        />
      ))}
    </div>
  );
}
