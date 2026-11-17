import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PhoneScreenSourceDialog, DEFAULT_PHONE_SCREEN_LABELS as L, detectComputerOs, mirrorSteps,
} from '../src/components/room/PhoneScreenSourceDialog.js';

const noop = () => { /* test */ };
const render = (labels = {}) => renderToStaticMarkup(h(PhoneScreenSourceDialog, { onShareWindow: noop, onClose: noop, labels }));

describe('PhoneScreenSourceDialog: mirror the phone to this computer, then share the window', () => {
  it('detects the computer from the browser', () => {
    expect(detectComputerOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15')).toBe('mac');
    expect(detectComputerOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')).toBe('windows');
    expect(detectComputerOs('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0')).toBe('linux');
    expect(detectComputerOs('Mozilla/5.0 (Linux; Android 14) Mobile')).toBe('windows');
    expect(detectComputerOs('')).toBe('windows');
  });

  it('has steps for every computer and phone pair', () => {
    for (const c of ['mac', 'windows', 'linux'] as const) {
      for (const p of ['ios', 'android'] as const) {
        const steps = mirrorSteps(c, p);
        expect(steps.length).toBeGreaterThan(0);
        for (const k of steps) expect(L[k]).toBeTruthy();
      }
    }
    // Android can go over Wi-Fi on every computer.
    for (const c of ['mac', 'windows', 'linux'] as const) expect(mirrorSteps(c, 'android')).toContain('androidWifi');
    // An iPhone on Windows needs an AirPlay receiver first.
    expect(mirrorSteps('windows', 'ios')[0]).toBe('winIos1');
    expect(L.winIos1).toMatch(/AirPlay receiver/);
  });

  it('shows both pickers, the steps for the pair, the share button, and no stream address or app', () => {
    const html = render();
    expect(html).toContain(L.computerLabel);
    expect(html).toContain(L.phoneIos);
    expect(html).toContain(L.phoneAndroid);
    expect(html).toContain(L.shareButton);
    expect(html).toContain(L.shareStep);
    expect(html.toLowerCase()).not.toContain('whip');
    expect(html).not.toContain('Larix');
    expect(html).not.toContain('VDO.Ninja');
    expect(html.toLowerCase()).not.toContain('rtmp');
  });

  it('takes translated labels', () => {
    const html = render({ title: 'Handy- oder Tablet-Bildschirm', shareButton: 'Fenster teilen' });
    expect(html).toContain('Handy- oder Tablet-Bildschirm');
    expect(html).toContain('Fenster teilen');
  });
});
