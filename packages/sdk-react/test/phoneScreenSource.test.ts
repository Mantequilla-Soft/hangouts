import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhoneScreenSourceDialog, DEFAULT_PHONE_SCREEN_LABELS } from '../src/components/room/PhoneScreenSourceDialog.js';

const URL = 'https://live.3speak.tv/w/abc123key';
const noop = () => { /* test */ };

describe('PhoneScreenSourceDialog', () => {
  it('shows the Larix steps, the WHIP address, a QR code of it and the waiting state', () => {
    const html = renderToStaticMarkup(h(PhoneScreenSourceDialog, { whipUrl: URL, connected: false, onClose: noop }));
    expect(html).toContain('Larix Screencaster');
    expect(html).toContain(`value="${URL}"`);
    expect(html).toContain('<svg');
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
    expect(html).toContain(DEFAULT_PHONE_SCREEN_LABELS.step1);
  });
});
