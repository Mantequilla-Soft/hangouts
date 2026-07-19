import { useCallback, useRef, type ReactNode } from 'react';

export interface MobileSheetProps {
  title: string;
  onClose: () => void;
  /** Current height in px, owned by the caller so it survives close/reopen. */
  height: number;
  onHeightChange: (h: number) => void;
  /** Translucent body so the camera preview stays readable behind it —
   *  used for chat, where the host wants to watch both at once. */
  transparent?: boolean;
  children: ReactNode;
}

const MIN_H = 140;
/** Leave the header and a sliver of preview visible at full extension. */
const MAX_FRACTION = 0.85;

/**
 * A bottom sheet the host can drag taller or shorter by its grab bar.
 *
 * Mobile studio panels (chat, post, mic picker) are sheets rather than rails:
 * on a phone there is no room for a 430px side panel, and the house
 * convention is that anything popup-shaped arrives from the bottom.
 */
export function MobileSheet({
  title, onClose, height, onHeightChange, transparent, children,
}: MobileSheetProps) {
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [height]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // Dragging UP (smaller clientY) makes the sheet taller.
    const next = d.startH - (e.clientY - d.startY);
    const max = Math.round(window.innerHeight * MAX_FRACTION);
    onHeightChange(Math.max(MIN_H, Math.min(max, next)));
  }, [onHeightChange]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  }, []);

  return (
    <div
      className={`hh-sheet${transparent ? ' hh-sheet--transparent' : ''}`}
      style={{ height }}
      role="dialog"
      aria-label={title}
    >
      <div
        className="hh-sheet__grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to resize"
      >
        <span className="hh-sheet__grip-bar" aria-hidden="true" />
      </div>
      <div className="hh-sheet__head">
        <span className="hh-sheet__title">{title}</span>
        <button className="hh-sheet__close" onClick={onClose} aria-label={`Close ${title}`}>✕</button>
      </div>
      <div className="hh-sheet__body">{children}</div>
    </div>
  );
}
