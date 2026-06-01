import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBoostStore, type BoostEvent } from '../../hooks/useBoosts.js';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function BoostHistoryItem({ boost }: { boost: BoostEvent }) {
  return (
    <div className={`hh-boost-history__item${boost.belowMinimum ? ' hh-boost-history__item--below-min' : ''}`}>
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
      <div className="hh-boost-history__item-footer">
        <span className="hh-boost-history__time">{formatTime(boost.timestamp)}</span>
        {boost.belowMinimum && (
          <span className="hh-boost-history__badge">below minimum</span>
        )}
      </div>
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function BoostHistoryPanel({ onClose }: Props) {
  const boosts = useBoostStore();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new boosts arrive — newest at bottom, same as chat
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [boosts.length]);

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
        <span>💰 Boost History</span>
        <button
          className="hh-boost-history__close"
          onClick={onClose}
          aria-label="Close boost history"
        >
          ✕
        </button>
      </div>
      <div className="hh-boost-history__list" ref={listRef}>
        {boosts.length === 0 ? (
          <p className="hh-boost-history__empty">No boosts yet this session</p>
        ) : (
          boosts.map((boost) => (
            <BoostHistoryItem key={boost.id} boost={boost} />
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
