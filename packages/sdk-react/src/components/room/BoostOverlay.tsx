import { useCallback, useEffect, useState } from 'react';
import { useBoostStore, type BoostEvent } from '../../hooks/useBoosts.js';

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

  // Auto-dismiss after 30 seconds
  useEffect(() => {
    const timer = setTimeout(dismiss, 30_000);
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
        <span className="hh-boost-overlay__label">Boost</span>
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

export function BoostOverlay() {
  const boosts = useBoostStore();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set([...prev, id]));
  }, []);

  const visible = boosts.filter((b) => !dismissed.has(b.id)).slice(-5);

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
