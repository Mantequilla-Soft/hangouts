import { useCallback, useEffect, useState } from 'react';
import { useBoostStore, BOOST_DISPLAY_MS, type BoostEvent } from '../../hooks/useBoosts.js';

function formatBoostAmount(amount: string, asset: string, usdAmount: number): string {
  return `${amount} ${asset} ($${usdAmount.toFixed(2)})`;
}

interface BoostCardProps {
  boost: BoostEvent;
  onDismiss: () => void;
}

function BoostCard({ boost, onDismiss }: BoostCardProps) {
  const [fading, setFading] = useState(false);

  const dismiss = useCallback(() => {
    if (fading) return;
    setFading(true);
    setTimeout(onDismiss, 400);
  }, [fading, onDismiss]);

  // Auto-dismiss once the shared display window is up.
  useEffect(() => {
    const timer = setTimeout(dismiss, BOOST_DISPLAY_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`hh-boost-overlay__item${fading ? ' hh-boost-overlay__item--fading' : ''}`}>
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
  const [, bumpRender] = useState(0);

  const dismiss = useCallback((id: string) => {
    dismissedIds.add(id);
    bumpRender((n) => n + 1);
  }, []);

  const now = Date.now();
  const visible = boosts
    .filter((b) => {
      if (b.belowMinimum || dismissedIds.has(b.id)) return false;
      const shownAt = firstShownAt.get(b.id);
      if (shownAt !== undefined) {
        // Mid-flight when we remounted — let it finish its time on screen.
        return now - shownAt < BOOST_DISPLAY_MS;
      }
      // Never shown here. Only announce it if it's actually NEW: sessionStorage
      // replays the whole list after a reload, and a boost from ten minutes ago
      // popping up as if it just arrived is worse than missing it.
      if (now - b.timestamp >= BOOST_DISPLAY_MS) return false;
      firstShownAt.set(b.id, now);
      return true;
    })
    .slice(-5);

  if (visible.length === 0) return null;

  return (
    <div className="hh-boost-overlay" aria-live="polite">
      {visible.map((boost) => (
        <BoostCard
          key={boost.id}
          boost={boost}
          onDismiss={() => dismiss(boost.id)}
        />
      ))}
    </div>
  );
}
