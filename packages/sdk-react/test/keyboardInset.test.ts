import { describe, expect, it } from 'vitest';
import { keyboardInset } from '../src/hooks/useKeyboardInset.js';
import { PHONE_STUDIO_QUERY } from '../src/hooks/useIsMobile.js';

// A window stand-in: layout height, visual viewport, and what has focus.
function win({ inner = 800, height = 800, offsetTop = 0, scale = 1, focus = 'TEXTAREA', type = '' } = {}) {
  const active = { tagName: focus, type, isContentEditable: false };
  return {
    innerHeight: inner,
    visualViewport: { height, offsetTop, scale },
    document: { activeElement: active },
  } as unknown as Window;
}

describe('keyboardInset (mobile sheets ride on the keyboard)', () => {
  it('is the part of the screen bottom the keyboard covers while typing', () => {
    expect(keyboardInset(win({ height: 480 }))).toBe(320);
    expect(keyboardInset(win({ focus: 'INPUT', type: 'text', height: 480 }))).toBe(320);
  });

  it('counts a panned visual viewport (the browser scrolled the field up)', () => {
    expect(keyboardInset(win({ height: 480, offsetTop: 120 }))).toBe(200);
  });

  it('is 0 with no text field focused, an address bar gap, or a pinch zoom', () => {
    expect(keyboardInset(win({ height: 480, focus: 'BUTTON' }))).toBe(0);
    expect(keyboardInset(win({ height: 480, focus: 'INPUT', type: 'checkbox' }))).toBe(0);
    expect(keyboardInset(win({ height: 744 }))).toBe(0);
    expect(keyboardInset(win({ height: 400, scale: 2 }))).toBe(0);
  });

  it('is 0 where the browser shrinks the layout for the keyboard', () => {
    expect(keyboardInset(win({ inner: 480, height: 480 }))).toBe(0);
  });
});

describe('PHONE_STUDIO_QUERY', () => {
  it('keeps a phone turned sideways in the phone studio', () => {
    expect(PHONE_STUDIO_QUERY).toContain('(max-width: 820px)');
    expect(PHONE_STUDIO_QUERY).toMatch(/\(orientation: landscape\) and \(max-height: 500px\) and \(pointer: coarse\)/);
  });
});
