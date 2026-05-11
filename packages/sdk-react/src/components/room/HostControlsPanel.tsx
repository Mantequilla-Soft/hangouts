import * as React from 'react';
import { createPortal } from 'react-dom';
import type { ParticipantRole } from '@snapie/hangouts-core';
import { useHostControls } from '../../hooks/useHostControls.js';

export interface HostControlsPanelProps {
  identity: string;
  role: ParticipantRole;
  roomName: string;
  onClose: () => void;
  /** Legacy: when set, the panel uses fixed positioning (callers anchored
   *  it manually). Prefer `inline` so the panel anchors to the tile via
   *  CSS and follows the tile around. */
  position?: { top: number; left: number };
  /** Render the panel positioned near the trigger via fixed coordinates
   *  computed from the trigger element's bounding rect. The panel is
   *  rendered through a portal to document.body so it can't be clipped
   *  by ancestor `overflow: hidden` containers (e.g. .hh-tile, the
   *  scrolling stage, or the room itself). */
  inline?: boolean;
  /** Bounding rect of the trigger (the ⋮ button) — used to position the
   *  inline panel. When omitted, the panel falls back to fixed
   *  top/right defaults so it still renders without breaking. */
  anchorRect?: DOMRect | null;
  /** Local-only listener volume for the participant's audio (0..1). The
   *  control only renders when both `volume` and `onVolumeChange` are set. */
  volume?: number;
  onVolumeChange?: (volume: number) => void;
}

export function HostControlsPanel({
  identity,
  role,
  roomName,
  onClose,
  position,
  inline = false,
  anchorRect,
  volume,
  onVolumeChange,
}: HostControlsPanelProps) {
  const { promote, demote, kick, pending } = useHostControls(roomName);
  const isPending = pending.has(identity);

  // Surface failures (e.g. participant already left → 404) instead of
  // silently doing nothing — without feedback the host can't tell if a
  // promote/demote/remove succeeded.
  const handleAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Hangouts] Host action failed:', err);
      alert(`Action failed: ${msg}`);
    } finally {
      onClose();
    }
  };

  // Compute placement when in inline mode — anchor below+left of the
  // trigger button. Clamp to viewport so the panel stays on-screen.
  const PANEL_W = 220;
  const PANEL_H_EST = 220;
  let inlineStyle: React.CSSProperties | undefined;
  if (inline && anchorRect) {
    const top = Math.min(anchorRect.bottom + 6, window.innerHeight - PANEL_H_EST - 8);
    const left = Math.max(8, Math.min(anchorRect.right - PANEL_W, window.innerWidth - PANEL_W - 8));
    inlineStyle = { position: 'fixed', top, left, zIndex: 1000 };
  } else if (position && !inline) {
    inlineStyle = { top: position.top, left: position.left };
  }

  const className = `hh-host-panel${inline ? ' hh-host-panel--floating' : ''}`;

  const panel = (
    <div
      className={className}
      style={inlineStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {role === 'listener' && (
        <button
          className="hh-host-panel__btn"
          disabled={isPending}
          onClick={() => handleAction(() => promote(identity))}
        >
          Invite to speak
        </button>
      )}
      {role === 'speaker' && (
        <button
          className="hh-host-panel__btn"
          disabled={isPending}
          onClick={() => handleAction(() => demote(identity))}
        >
          Move to audience
        </button>
      )}

      {volume !== undefined && onVolumeChange && (
        <label className="hh-host-panel__row">
          <span className="hh-host-panel__row-label">
            Volume <span className="hh-host-panel__row-value">{Math.round(volume * 100)}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            className="hh-host-panel__slider"
            aria-label="Listener volume"
          />
        </label>
      )}

      <button
        className="hh-host-panel__btn hh-host-panel__btn--danger"
        disabled={isPending}
        onClick={() => handleAction(() => kick(identity))}
      >
        Kick
      </button>
    </div>
  );

  // Portal the panel to body when it's an inline-anchored popup so it
  // can't be clipped by an ancestor `overflow: hidden` (the tile,
  // scrolling stage, or the modal itself).
  if (inline && typeof document !== 'undefined') {
    return createPortal(panel, document.body);
  }
  return panel;
}
