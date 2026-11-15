import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomContext } from '@livekit/components-react';
import { Room } from 'livekit-client';
import { captionTranslator, languageName, resetCaptionTranslators, translationMode } from '../src/lib/captionTranslate.js';
import { LiveCaptionsToggle } from '../src/components/room/LiveCaptionsToggle.js';
import { StreamCaptions } from '../src/components/room/StreamCaptions.js';
import type { StudioCaptions } from '../src/hooks/useStudioCaptions.js';

const g = globalThis as unknown as { Translator?: unknown };

describe('on-device translation', () => {
  beforeEach(() => resetCaptionTranslators());
  afterEach(() => { delete g.Translator; });

  it('the same language needs nothing; no Translator API means unavailable', async () => {
    expect(await translationMode('en-us', 'en')).toBe('same');
    expect(await translationMode('en-us', 'de')).toBe('unavailable');
    expect(await captionTranslator('en-us', 'de')).toBeNull();
  });

  it('maps the browser\'s availability answers', async () => {
    const answers = ['available', 'downloadable', 'downloading', 'unavailable'];
    const availability = vi.fn(async () => answers.shift());
    g.Translator = { availability, create: vi.fn() };
    expect(await translationMode('en-us', 'de-DE')).toBe('ready');
    expect(availability).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'de' });
    expect(await translationMode('en', 'de')).toBe('needs-gesture');
    expect(await translationMode('en', 'de')).toBe('needs-gesture');
    expect(await translationMode('en', 'de')).toBe('unavailable');
    g.Translator = { availability: async () => { throw new Error('policy'); }, create: vi.fn() };
    expect(await translationMode('en', 'de')).toBe('unavailable');
  });

  it('shares one translator per pair and retries a failed create', async () => {
    const tr = { translate: async (t: string) => `DE:${t}` };
    const create = vi.fn().mockRejectedValueOnce(new Error('no gesture')).mockResolvedValue(tr);
    g.Translator = { availability: async () => 'available', create };
    expect(await captionTranslator('en-us', 'de')).toBeNull();
    await Promise.resolve();
    const a = await captionTranslator('en-us', 'de');
    const b = await captionTranslator('en', 'de');
    expect(a).toBe(tr);
    expect(b).toBe(tr);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await a!.translate('hello')).toBe('DE:hello');
  });

  it('names languages in the viewer\'s language', () => {
    expect(languageName('en-us', 'de')).toBe('Englisch');
    expect(languageName('de', 'en')).toBe('German');
    expect(languageName('xx', '!!bad')).toBe('xx');
  });
});

function captions(over: Partial<StudioCaptions> = {}): StudioCaptions {
  return {
    supported: true, enabled: false, setEnabled: () => {}, lang: 'en-us', setLang: () => {},
    languages: [{ code: 'en-us', label: 'English' }], status: 'off',
    markRecordingStart: () => {}, takeCues: () => null, ...over,
  };
}

describe('LiveCaptionsToggle', () => {
  it('renders nothing when the integrator or the server does not offer captions', () => {
    expect(renderToStaticMarkup(h(LiveCaptionsToggle, { captions: captions({ supported: false }) }))).toBe('');
  });

  it('is off by default with no status line and no picker for one language', () => {
    const html = renderToStaticMarkup(h(LiveCaptionsToggle, { captions: captions() }));
    expect(html).toContain('Live captions');
    expect(html).toContain('Show live captions to viewers');
    expect(html).not.toContain('checked');
    expect(html).not.toContain('<select');
    expect(html).toContain('Captions understand English only.');
    expect(html).not.toContain('hh-captions-setting__status');
  });

  it('shows the status in the host\'s words, translated labels, and a picker for several languages', () => {
    const html = renderToStaticMarkup(h(LiveCaptionsToggle, {
      captions: captions({
        enabled: true, status: 'full', lang: 'de',
        languages: [{ code: 'en-us', label: 'English' }, { code: 'de', label: 'Deutsch' }],
        labels: { title: 'Live-Untertitel', statusFull: 'Alle Plätze belegt' },
      }),
    }));
    expect(html).toContain('checked');
    expect(html).toContain('Live-Untertitel');
    expect(html).toContain('hh-captions-setting__status--full');
    expect(html).toContain('Alle Plätze belegt');
    expect(html).toContain('<option value="de" selected="">Deutsch</option>');
    const on = renderToStaticMarkup(h(LiveCaptionsToggle, { captions: captions({ enabled: true, status: 'on' }) }));
    expect(on).toContain('hh-captions-setting__dot');
    expect(on).toContain('Captions are on.');
  });
});

function inRoom(el: ReactElement, meta: Record<string, unknown> | null): string {
  const room = new Room();
  Object.defineProperty(room, 'metadata', { get: () => (meta ? JSON.stringify(meta) : undefined) });
  return renderToStaticMarkup(h(RoomContext.Provider, { value: room }, el));
}

describe('StreamCaptions', () => {
  it('renders nothing while the viewer has CC off, the host has none, or nothing was said yet', () => {
    expect(inRoom(h(StreamCaptions, { show: false }), { host: 'badadib', captions: { lang: 'en-us' } })).toBe('');
    expect(inRoom(h(StreamCaptions, { show: true }), { host: 'badadib' })).toBe('');
    expect(inRoom(h(StreamCaptions, { show: true }), { host: 'badadib', captions: { lang: 'en-us' } })).toBe('');
  });
});
