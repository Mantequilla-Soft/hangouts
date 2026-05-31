import * as React from 'react';
import { useState, useEffect, useRef } from 'react';

export interface GuestNameModalProps {
  roomTitle?: string;
  onJoin: (displayName: string) => void;
  onSignIn: () => void;
  onCancel?: () => void;
}

const STYLE_ID = 'hh-guest-modal-styles';

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;1,9..144,300&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap');

  @keyframes hh-gm-backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes hh-gm-card-in {
    from { opacity: 0; transform: translateY(18px) scale(0.965); }
    to   { opacity: 1; transform: translateY(0)    scale(1);     }
  }
  @keyframes hh-gm-error-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0);    }
  }

  .hh-gm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    padding: 16px;
    animation: hh-gm-backdrop-in 0.2s ease forwards;
  }

  .hh-gm-card {
    background: var(--hh-surface, #141414);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.03) inset,
      0 40px 100px rgba(0, 0, 0, 0.65),
      0 8px 28px rgba(0, 0, 0, 0.35);
    width: 100%;
    max-width: 408px;
    padding: 38px 34px 32px;
    position: relative;
    animation: hh-gm-card-in 0.28s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    box-sizing: border-box;
  }

  .hh-gm-close {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: none;
    background: rgba(255, 255, 255, 0.06);
    color: var(--hh-text-muted, #777);
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
    flex-shrink: 0;
  }
  .hh-gm-close:hover {
    background: rgba(255, 255, 255, 0.11);
    color: var(--hh-text, #f0f0f0);
  }

  .hh-gm-live-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 22px;
    font-size: 11px;
    font-weight: 500;
    color: var(--hh-text-muted, #888);
    letter-spacing: 0.03em;
  }
  .hh-gm-live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ef4444;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2);
    flex-shrink: 0;
  }
  .hh-gm-live-room {
    color: var(--hh-text, #e8e8e8);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 260px;
  }

  .hh-gm-heading {
    font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
    font-size: 28px;
    font-weight: 300;
    font-style: italic;
    line-height: 1.15;
    color: var(--hh-text, #f2f2f2);
    margin: 0 0 8px;
    letter-spacing: -0.02em;
  }

  .hh-gm-subtext {
    font-size: 13px;
    color: var(--hh-text-muted, #777);
    margin: 0 0 26px;
    line-height: 1.55;
  }

  .hh-gm-input-wrap {
    margin-bottom: 4px;
  }

  .hh-gm-input {
    width: 100%;
    height: 50px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 11px;
    color: var(--hh-text, #f0f0f0);
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    font-size: 15px;
    font-weight: 400;
    padding: 0 16px;
    outline: none;
    transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
    box-sizing: border-box;
    caret-color: var(--hh-accent, #a78bfa);
    -webkit-appearance: none;
  }
  .hh-gm-input::placeholder {
    color: rgba(255, 255, 255, 0.22);
  }
  .hh-gm-input:focus {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--hh-accent, #7c6aed);
    box-shadow: 0 0 0 3.5px rgba(124, 106, 237, 0.14);
  }
  .hh-gm-input--error {
    border-color: #f87171 !important;
    box-shadow: 0 0 0 3.5px rgba(248, 113, 113, 0.11) !important;
  }

  .hh-gm-error {
    font-size: 12px;
    font-weight: 500;
    color: #f87171;
    margin: 8px 0 0 2px;
    animation: hh-gm-error-in 0.18s ease forwards;
    line-height: 1.4;
  }

  .hh-gm-error-spacer {
    height: 22px;
  }

  .hh-gm-btn-primary {
    width: 100%;
    height: 50px;
    background: var(--hh-accent, #7c3aed);
    color: #fff;
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
    border: none;
    border-radius: 11px;
    cursor: pointer;
    margin-top: 14px;
    transition: box-shadow 0.18s, opacity 0.18s, transform 0.12s;
    position: relative;
    overflow: hidden;
  }
  .hh-gm-btn-primary--ready {
    box-shadow: 0 4px 22px rgba(124, 58, 237, 0.38);
  }
  .hh-gm-btn-primary--ready:hover {
    box-shadow: 0 6px 32px rgba(124, 58, 237, 0.58);
    transform: translateY(-1px);
  }
  .hh-gm-btn-primary--ready:active {
    transform: translateY(0);
    box-shadow: 0 2px 12px rgba(124, 58, 237, 0.28);
  }
  .hh-gm-btn-primary--inactive {
    opacity: 0.38;
    cursor: default;
  }

  .hh-gm-sep {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 22px 0 18px;
  }
  .hh-gm-sep::before,
  .hh-gm-sep::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(255, 255, 255, 0.07);
  }
  .hh-gm-sep-label {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.25);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .hh-gm-signin {
    width: 100%;
    text-align: center;
    font-size: 13px;
    color: var(--hh-text-muted, #777);
    background: none;
    border: none;
    cursor: pointer;
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    transition: color 0.15s;
    padding: 0;
    line-height: 1.5;
  }
  .hh-gm-signin:hover {
    color: var(--hh-text, #ddd);
  }
  .hh-gm-signin-cta {
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: rgba(255, 255, 255, 0.2);
    transition: text-decoration-color 0.15s;
  }
  .hh-gm-signin:hover .hh-gm-signin-cta {
    text-decoration-color: rgba(255, 255, 255, 0.55);
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

export function GuestNameModal({ roomTitle, onJoin, onSignIn, onCancel }: GuestNameModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    injectStyles();
    // Defer focus so the modal animation doesn't fight the browser
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const trimmed = name.trim();
  const isValid = trimmed.length >= 2;

  const handleJoin = () => {
    if (!isValid) {
      setError('Please enter at least 2 characters');
      inputRef.current?.focus();
      return;
    }
    onJoin(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleJoin();
  };

  return (
    <div className="hh-gm-backdrop" onClick={onCancel}>
      <div className="hh-gm-card" onClick={(e) => e.stopPropagation()}>

        {onCancel && (
          <button className="hh-gm-close" onClick={onCancel} aria-label="Close">✕</button>
        )}

        {roomTitle && (
          <div className="hh-gm-live-pill">
            <span className="hh-gm-live-dot" />
            Live ·{' '}
            <span className="hh-gm-live-room">{roomTitle}</span>
          </div>
        )}

        <h2 className="hh-gm-heading">What's your name?</h2>
        <p className="hh-gm-subtext">
          You'll join as a guest. The host can invite you to speak.
        </p>

        <div className="hh-gm-input-wrap">
          <input
            ref={inputRef}
            className={`hh-gm-input${error ? ' hh-gm-input--error' : ''}`}
            type="text"
            placeholder="Your name"
            value={name}
            maxLength={32}
            autoComplete="given-name"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={handleKeyDown}
          />
          {error
            ? <p className="hh-gm-error">{error}</p>
            : <div className="hh-gm-error-spacer" />
          }
        </div>

        <button
          className={`hh-gm-btn-primary${isValid ? ' hh-gm-btn-primary--ready' : ' hh-gm-btn-primary--inactive'}`}
          onClick={handleJoin}
        >
          Join as Guest
        </button>

        <div className="hh-gm-sep"><span className="hh-gm-sep-label">or</span></div>

        <button className="hh-gm-signin" onClick={onSignIn}>
          Have a Hive account?{' '}
          <span className="hh-gm-signin-cta">Sign in instead</span>
        </button>

      </div>
    </div>
  );
}
