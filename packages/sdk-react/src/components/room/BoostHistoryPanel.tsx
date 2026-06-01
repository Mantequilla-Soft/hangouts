import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBoosts, type BoostEvent } from '../../hooks/useBoosts.js';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function BoostHistoryItem({ boost }: { boost: BoostEvent }) {
  return (
    <div className="hh-boost-history__item">
      <div className="hh-boost-history__item-header">
        <span className="hh-boost-history__sender">
          @{boost.displayName || boost.sender}
        </span>
        <span className="hh-boost-history__amount">
          {boost.amount} {boost.asset}
          <span className="hh-boost-history__usd"> (${boost.usdAmount.toFixed(2)})</span>
        </span>
      </div>
      <p className="hh-boost-history__message">{boost.message}</p>
      <div className="hh-boost-history__time">{formatTime(boost.timestamp)}</div>
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function BoostHistoryPanel({ onClose }: Props) {
  const { boosts } = useBoosts();
  const reversed = [...boosts].reverse();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click — same pattern as the end-room menu
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !e.composedPath().includes(panelRef.current)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => document.addEventListener('click', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="hh-boost-history" ref={panelRef}>
      <div className="hh-boost-history__header">
        <span>💰 Superchat History</span>
        <button
          className="hh-boost-history__close"
          onClick={onClose}
          aria-label="Close superchat history"
        >
          ✕
        </button>
      </div>
      <div className="hh-boost-history__list">
        {reversed.length === 0 ? (
          <p className="hh-boost-history__empty">No superchats yet this session</p>
        ) : (
          reversed.map((boost) => (
            <BoostHistoryItem key={boost.id} boost={boost} />
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
