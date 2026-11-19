import { useEffect, useState } from 'react';

/** Under this many px the gap is browser chrome (an address bar), not a keyboard. */
const MIN_KEYBOARD = 80;

const isTextField = (el: Element | null): boolean => !!el && (
  el.tagName === 'TEXTAREA'
  || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|range|color|file|submit|reset|image|hidden)$/i.test((el as HTMLInputElement).type))
  || (el as HTMLElement).isContentEditable
);

/** How much of the layout viewport's bottom the on-screen keyboard covers. */
export function keyboardInset(win: Window = window): number {
  const vv = win.visualViewport;
  if (!vv || vv.scale > 1.01 || !isTextField(win.document.activeElement)) return 0;
  const gap = Math.round(win.innerHeight - vv.height - vv.offsetTop);
  return gap >= MIN_KEYBOARD ? gap : 0;
}

/**
 * Px of the screen bottom hidden by the on-screen keyboard while a text field
 * has focus, else 0. Android Chrome (and a fullscreen page) lays out at full
 * height and lets the keyboard cover the bottom, so a sheet pinned to the
 * bottom ends up under it: lift it by this much. Where the browser shrinks the
 * layout for the keyboard instead, the gap is already 0.
 */
export function useKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.visualViewport) { setInset(0); return undefined; }
    const vv = window.visualViewport;
    const update = () => setInset(keyboardInset(window));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    // Focus moves before the keyboard animates; blur closes it with no resize on some browsers.
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [enabled]);
  return inset;
}
