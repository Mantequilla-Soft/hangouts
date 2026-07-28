import { type ReactNode } from 'react';

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

/**
 * A bottom sheet for the mobile studio panels (chat, post, mic picker, …).
 *
 * No grab-bar (drag-to-resize removed by request) but it keeps a close ✕; the
 * rail button that opens a sheet also toggles it shut. The caller owns the
 * height (a fixed per-sheet value).
 */
export function MobileSheet({ title, onClose, height, transparent, children }: MobileSheetProps) {
  return (
    <div
      className={`hh-sheet${transparent ? ' hh-sheet--transparent' : ''}`}
      style={{ height }}
      role="dialog"
      aria-label={title}
    >
      <div className="hh-sheet__head">
        <span className="hh-sheet__title">{title}</span>
        <button className="hh-sheet__close" onClick={onClose} aria-label={`Close ${title}`}>✕</button>
      </div>
      <div className="hh-sheet__body">{children}</div>
    </div>
  );
}
