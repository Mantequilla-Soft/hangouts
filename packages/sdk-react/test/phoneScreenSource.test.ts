import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PhoneScreenSourceDialog, DEFAULT_PHONE_SCREEN_LABELS as L, PHONE_SCREEN_LABEL_KEYS,
  detectComputerOs, pictureSteps, soundSteps,
} from '../src/components/room/PhoneScreenSourceDialog.js';

const noop = () => { /* test */ };
const render = (labels = {}) => renderToStaticMarkup(h(PhoneScreenSourceDialog, { onShareWindow: noop, onClose: noop, labels }));
const COMPUTERS = ['mac', 'windows', 'linux'] as const;
const PHONES = ['ios', 'android'] as const;

describe('PhoneScreenSourceDialog: mirror the phone to this computer, share the window, bring the sound', () => {
  it('detects the computer from the browser', () => {
    expect(detectComputerOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15')).toBe('mac');
    expect(detectComputerOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')).toBe('windows');
    expect(detectComputerOs('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0')).toBe('linux');
    expect(detectComputerOs('Mozilla/5.0 (Linux; Android 14) Mobile')).toBe('windows');
    expect(detectComputerOs('')).toBe('windows');
  });

  it('every pair has picture and sound steps, all with text', () => {
    for (const c of COMPUTERS) for (const p of PHONES) {
      for (const s of [...pictureSteps(c, p), ...soundSteps(c, p)]) {
        expect(L[s.title]).toBeTruthy();
        expect(L[s.text]).toBeTruthy();
      }
      expect(pictureSteps(c, p).length).toBeGreaterThan(0);
      expect(soundSteps(c, p).length).toBeGreaterThan(0);
      // An alternative never comes first.
      expect(pictureSteps(c, p)[0].alt).toBeFalsy();
    }
    expect(Object.keys(L).sort()).toEqual([...PHONE_SCREEN_LABEL_KEYS].sort());
  });

  it('Android: wireless debugging (pair, then connect) without a cable, scrcpy from its releases on Linux', () => {
    const codes = pictureSteps('linux', 'android').map((s) => s.code).filter(Boolean);
    expect(codes).toEqual(['adb pair 192.168.1.23:37115 123456', 'adb connect 192.168.1.23:41234', 'scrcpy']);
    expect(pictureSteps('linux', 'android')[0].link?.href).toContain('github.com/Genymobile/scrcpy/releases');
    expect(pictureSteps('windows', 'android').some((s) => s.title === 'castT')).toBe(true);
  });

  it('sound: Windows a second share with system audio; Linux a virtual "Phone" output for the mirroring app', () => {
    expect(soundSteps('windows', 'ios').map((s) => s.title)).toEqual(['soundWinT']);
    expect(soundSteps('linux', 'android').map((s) => s.code)).toContain('PULSE_SINK=phone scrcpy');
    expect(soundSteps('linux', 'ios').map((s) => s.code)).toContain('PULSE_SINK=phone uxplay');
    expect(soundSteps('linux', 'ios')[0].code).toMatch(/module-null-sink sink_name=phone/);
  });

  it('renders the pickers, three sections, step numbers, code boxes, and no app or stream address', () => {
    const html = render();
    expect(html).toContain(L.pictureHeading);
    expect(html).toContain(L.shareButton);
    expect(html.match(/hh-phone-guide__section/g)).toHaveLength(3);
    expect(html).toContain('hh-phone-guide__num');
    expect(html.toLowerCase()).not.toContain('whip');
    expect(html).not.toContain('Larix');
    expect(html).not.toContain('VDO.Ninja');
  });

  it('takes translated labels', () => {
    const html = render({ title: 'Handy- oder Tablet-Bildschirm', shareButton: 'Fenster teilen' });
    expect(html).toContain('Handy- oder Tablet-Bildschirm');
    expect(html).toContain('Fenster teilen');
  });
});
