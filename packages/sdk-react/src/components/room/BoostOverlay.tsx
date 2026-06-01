import { useMemo } from 'react';
import { useBoosts } from '../../hooks/useBoosts.js';

function formatBoostAmount(amount: string, asset: string, usdAmount: number): string {
  return `${amount} ${asset} ($${usdAmount.toFixed(2)})`;
}

export function BoostOverlay() {
  const { boosts } = useBoosts();
  const latest = useMemo(() => boosts.slice(-3).reverse(), [boosts]);

  if (latest.length === 0) return null;

  return (
    <div className="hh-boost-overlay" aria-live="polite">
      {latest.map((boost) => (
        <div key={boost.id} className="hh-boost-overlay__item">
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
      ))}
    </div>
  );
}
