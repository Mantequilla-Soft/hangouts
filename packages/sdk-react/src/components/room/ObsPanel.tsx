import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface ObsPanelProps {
  roomName: string;
  obsBaseUrl: string;
  onClose: () => void;
  anchorRect?: DOMRect | null;
}

const STYLE_ID = 'hh-obs-panel-styles';

const css = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap');

  @keyframes hh-obs-slide-up {
    from { opacity: 0; transform: translateY(12px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)    scale(1);    }
  }
  @keyframes hh-obs-copy-pulse {
    0%   { box-shadow: 0 0 0 0   rgba(34,197,94,0.6); }
    60%  { box-shadow: 0 0 0 10px rgba(34,197,94,0);  }
    100% { box-shadow: 0 0 0 0   rgba(34,197,94,0);   }
  }
  @keyframes hh-obs-copied-in {
    from { transform: scale(0.9); opacity: 0.6; }
    to   { transform: scale(1);   opacity: 1;   }
  }

  .hh-obs-panel {
    position: fixed;
    z-index: 9999;
    width: 340px;
    background: rgba(9, 9, 13, 0.93);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 14px;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 24px 64px rgba(0,0,0,0.7),
      0 4px 16px rgba(0,0,0,0.4);
    padding: 18px 20px 16px;
    font-family: 'DM Sans', system-ui, sans-serif;
    animation: hh-obs-slide-up 0.22s cubic-bezier(0.16,1,0.3,1) forwards;
    box-sizing: border-box;
  }

  .hh-obs-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .hh-obs-panel__title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    font-weight: 600;
    color: rgba(255,255,255,0.92);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .hh-obs-panel__title-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #e31337;
    box-shadow: 0 0 8px rgba(227,19,55,0.7);
    flex-shrink: 0;
  }

  .hh-obs-panel__close {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: none;
    background: rgba(255,255,255,0.07);
    color: rgba(255,255,255,0.45);
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
    flex-shrink: 0;
  }
  .hh-obs-panel__close:hover {
    background: rgba(255,255,255,0.13);
    color: rgba(255,255,255,0.85);
  }

  .hh-obs-panel__divider {
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.07) 30%, rgba(255,255,255,0.07) 70%, transparent);
    margin-bottom: 14px;
  }

  .hh-obs-panel__label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.35);
    margin-bottom: 8px;
  }

  .hh-obs-panel__checks {
    display: flex;
    gap: 6px;
    margin-bottom: 14px;
  }

  .hh-obs-panel__check {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 4px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.04);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    user-select: none;
    font-size: 11.5px;
    font-weight: 500;
    color: rgba(255,255,255,0.55);
  }
  .hh-obs-panel__check:hover {
    background: rgba(255,255,255,0.07);
  }
  .hh-obs-panel__check--on {
    background: rgba(227,19,55,0.12);
    border-color: rgba(227,19,55,0.35);
    color: rgba(255,255,255,0.88);
  }
  .hh-obs-panel__check--on:hover {
    background: rgba(227,19,55,0.17);
  }

  .hh-obs-panel__box {
    width: 13px;
    height: 13px;
    border-radius: 3px;
    border: 1.5px solid rgba(255,255,255,0.2);
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, border-color 0.15s;
  }
  .hh-obs-panel__check--on .hh-obs-panel__box {
    background: #e31337;
    border-color: #e31337;
  }
  .hh-obs-panel__check-icon {
    font-size: 8px;
    color: white;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .hh-obs-panel__check--on .hh-obs-panel__check-icon {
    opacity: 1;
  }

  .hh-obs-panel__url-wrap {
    position: relative;
    margin-bottom: 10px;
  }

  .hh-obs-panel__url {
    width: 100%;
    padding: 9px 12px;
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    color: rgba(255,255,255,0.7);
    font-family: 'IBM Plex Mono', 'Courier New', monospace;
    font-size: 10px;
    line-height: 1.5;
    word-break: break-all;
    box-sizing: border-box;
    min-height: 52px;
    display: flex;
    align-items: center;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .hh-obs-panel__url--valid {
    border-color: rgba(34,197,94,0.25);
    box-shadow: 0 0 0 1px rgba(34,197,94,0.08) inset, 0 0 12px rgba(34,197,94,0.06);
  }
  .hh-obs-panel__url--invalid {
    border-color: rgba(255,255,255,0.05);
    color: rgba(255,255,255,0.3);
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 11px;
    font-style: italic;
  }

  .hh-obs-panel__copy {
    width: 100%;
    padding: 9px;
    border: none;
    border-radius: 8px;
    background: #e31337;
    color: white;
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
    margin-bottom: 10px;
    box-shadow: 0 2px 12px rgba(227,19,55,0.3);
  }
  .hh-obs-panel__copy:hover:not(:disabled) {
    background: #ff2244;
    transform: translateY(-1px);
    box-shadow: 0 4px 18px rgba(227,19,55,0.45);
  }
  .hh-obs-panel__copy:active:not(:disabled) {
    transform: translateY(0);
  }
  .hh-obs-panel__copy:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    box-shadow: none;
  }
  .hh-obs-panel__copy--copied {
    background: #16a34a !important;
    box-shadow: 0 2px 12px rgba(22,163,74,0.4) !important;
    animation: hh-obs-copied-in 0.18s ease forwards, hh-obs-copy-pulse 0.5s ease forwards !important;
  }

  .hh-obs-panel__hint {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    font-size: 10.5px;
    color: rgba(255,255,255,0.28);
    line-height: 1.5;
  }
  .hh-obs-panel__hint-icon {
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 10px;
  }
`;

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

export function ObsPanel({ roomName, obsBaseUrl, onClose, anchorRect }: ObsPanelProps) {
  const [speakers, setSpeakers] = useState(true);
  const [chat, setChat]         = useState(true);
  const [audience, setAudience] = useState(true);
  const [copied, setCopied]     = useState(false);

  useEffect(() => { injectStyles(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const show = [
    speakers && 'speakers',
    chat     && 'chat',
    audience && 'audience',
  ].filter(Boolean) as string[];

  const hasSelection = show.length > 0;
  const url = hasSelection
    ? `${obsBaseUrl}/obs?room=${encodeURIComponent(roomName)}&show=${show.join(',')}`
    : null;

  const handleCopy = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [url]);

  // Position: appear above the anchor button, or bottom-center fallback
  const PANEL_W = 340;
  let style: React.CSSProperties;
  if (anchorRect) {
    const top = Math.max(8, anchorRect.top - 8); // will use bottom anchor below
    const left = Math.max(8, Math.min(anchorRect.right - PANEL_W, window.innerWidth - PANEL_W - 8));
    // Position bottom of panel just above the trigger
    style = { bottom: window.innerHeight - anchorRect.top + 8, left, top: 'auto' };
  } else {
    style = { bottom: 80, left: '50%', transform: 'translateX(-50%)' };
  }

  const panel = (
    <div className="hh-obs-panel" style={style} onClick={e => e.stopPropagation()}>
      <div className="hh-obs-panel__header">
        <div className="hh-obs-panel__title">
          <span className="hh-obs-panel__title-dot" />
          OBS Browser Source
        </div>
        <button className="hh-obs-panel__close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="hh-obs-panel__divider" />

      <div className="hh-obs-panel__label">Include panels</div>
      <div className="hh-obs-panel__checks">
        {([
          { key: 'speakers', label: 'Speakers', val: speakers, set: setSpeakers },
          { key: 'chat',     label: 'Chat',     val: chat,     set: setChat     },
          { key: 'audience', label: 'Audience', val: audience, set: setAudience },
        ] as const).map(({ key, label, val, set }) => (
          <div
            key={key}
            className={`hh-obs-panel__check${val ? ' hh-obs-panel__check--on' : ''}`}
            onClick={() => set(v => !v)}
            role="checkbox"
            aria-checked={val}
            tabIndex={0}
            onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); set(v => !v); } }}
          >
            <span className="hh-obs-panel__box">
              <span className="hh-obs-panel__check-icon">✓</span>
            </span>
            {label}
          </div>
        ))}
      </div>

      <div className="hh-obs-panel__label">Browser source URL</div>
      <div className="hh-obs-panel__url-wrap">
        <div className={`hh-obs-panel__url${url ? ' hh-obs-panel__url--valid' : ' hh-obs-panel__url--invalid'}`}>
          {url ?? 'Select at least one panel'}
        </div>
      </div>

      <button
        className={`hh-obs-panel__copy${copied ? ' hh-obs-panel__copy--copied' : ''}`}
        onClick={handleCopy}
        disabled={!hasSelection}
      >
        {copied ? '✓ Copied!' : 'Copy link'}
      </button>

      <div className="hh-obs-panel__hint">
        <span className="hh-obs-panel__hint-icon">📋</span>
        <span>OBS → Sources → Browser Source → paste URL → enable <em>Allow transparency</em></span>
      </div>
    </div>
  );

  if (typeof document !== 'undefined') {
    return createPortal(panel, document.body);
  }
  return panel;
}
