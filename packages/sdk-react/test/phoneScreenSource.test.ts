import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoneScreenSourceDialog, DEFAULT_PHONE_SCREEN_LABELS, larixGroveUrl } from '../src/components/room/PhoneScreenSourceDialog.js';

const URL = 'https://live.3speak.tv/w/abc123key';
const noop = () => { /* test */ };

describe('PhoneScreenSourceDialog', () => {
  it('opens on the VDO.Ninja tab: its steps, a QR of the URL, the URL and the token, and that the address stays', () => {
    const html = renderToStaticMarkup(h(PhoneScreenSourceDialog, { whipUrl: URL, connected: false, onClose: noop }));
    expect(html).toContain(DEFAULT_PHONE_SCREEN_LABELS.vdoStep1);
    expect(html).not.toContain(DEFAULT_PHONE_SCREEN_LABELS.step1);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain(`value="${URL}"`);
    expect(html).toContain('value="abc123key"');
    expect(html).toContain(DEFAULT_PHONE_SCREEN_LABELS.sameEveryStream);
    expect(html).not.toContain('larix://');
  });

  it('the Larix tab (remembered): Larix steps, the token on its own, a Grove QR code and the waiting state', () => {
    // Server render, no DOM: a stand-in window with the remembered choice.
    const g = globalThis as { window?: unknown };
    g.window = { localStorage: { getItem: () => 'larix', setItem: () => undefined } };
    let html = '';
    try {
      html = renderToStaticMarkup(h(PhoneScreenSourceDialog, { whipUrl: URL, connected: false, onClose: noop }));
    } finally { delete g.window; }
    expect(html).toContain('Larix Screencaster');
    expect(html).toContain(`value="${URL}"`);
    expect(html).toContain('value="abc123key"');
    expect(html).toContain('<svg');
    expect(html).toContain('href="larix://set/v1?');
    expect(html).toContain(DEFAULT_PHONE_SCREEN_LABELS.waiting);
    expect(html).not.toContain(DEFAULT_PHONE_SCREEN_LABELS.connected);
    // WHIP only: nothing in the text points at RTMP.
    expect(html.toLowerCase()).not.toContain('rtmp');
  });

  it('says when the device is connected', () => {
    const html = renderToStaticMarkup(h(PhoneScreenSourceDialog, { whipUrl: URL, connected: true, onClose: noop }));
    expect(html).toContain(DEFAULT_PHONE_SCREEN_LABELS.connected);
  });

  it('shows no QR code until the address exists, and an error instead of the steps', () => {
    expect(renderToStaticMarkup(h(PhoneScreenSourceDialog, { whipUrl: '', connected: false, onClose: noop }))).not.toContain('<svg');
    const html = renderToStaticMarkup(h(PhoneScreenSourceDialog, { whipUrl: '', connected: false, error: 'Room not found', onClose: noop }));
    expect(html).toContain('Room not found');
    expect(html).not.toContain('Larix');
  });

  it('takes translated labels', () => {
    const html = renderToStaticMarkup(h(PhoneScreenSourceDialog, {
      whipUrl: URL, connected: false, onClose: noop,
      labels: { title: 'Handy- oder Tablet-Bildschirm', copy: 'Kopieren' },
    }));
    expect(html).toContain('Handy- oder Tablet-Bildschirm');
    expect(html).toContain('Kopieren');
    expect(html).toContain(DEFAULT_PHONE_SCREEN_LABELS.vdoStep1);
  });

  it('builds the Grove link: brackets literal, values encoded, overwrite on', () => {
    expect(larixGroveUrl(URL, 'abc123key', '3Speak Live')).toBe(
      'larix://set/v1?conn[][url]=https%3A%2F%2Flive.3speak.tv%2Fw%2Fabc123key'
      + '&conn[][name]=3Speak%20Live&conn[][token]=abc123key&conn[][overwrite]=on&conn[][mode]=va',
    );
  });
});
