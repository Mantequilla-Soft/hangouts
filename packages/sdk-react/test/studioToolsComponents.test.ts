import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamHealthPanel, StreamHealthDetails, StreamHealthRailButton } from '../src/components/room/StreamHealthPanel.js';
import { VerticalSettings } from '../src/components/room/VerticalCropBox.js';
import { StudioOverlaysPanel } from '../src/components/room/StudioOverlaysPanel.js';
import type { StreamHealthState } from '../src/hooks/useStreamHealth.js';
import type { VerticalOutputApi } from '../src/hooks/useVerticalOutput.js';
import type { StudioOverlaysApi } from '../src/hooks/useStudioOverlays.js';
import { VerticalOutput } from '../src/lib/verticalOutput.js';
import { DEFAULT_OVERLAY_CONFIG, OFF_LIVE } from '../src/lib/studioOverlays.js';

const goodBadge = { cls: ' hh-studio__conn--good', label: 'Good', tip: 'Strong.' };
const healthState = (over: Partial<StreamHealthState> = {}): StreamHealthState => ({
  health: null, assessment: null, level: 0, stepLabel: 'Full quality', auto: true, setAuto: vi.fn(), canAuto: true, lastChange: null, ...over,
});

describe('StreamHealthPanel', () => {
  it('keeps the Good/Weak/Lost pill as a button that opens the panel', () => {
    const html = renderToStaticMarkup(h(StreamHealthPanel, { badge: goodBadge, showLabel: true, state: healthState() }));
    expect(html).toContain('<button');
    expect(html).toContain('hh-studio__conn--good');
    expect(html).toContain('>Good<');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('hh-health__panel');
  });
  it('warns early (Weak) when our own reading is worse than LiveKit’s, and marks a lowered quality', () => {
    const html = renderToStaticMarkup(h(StreamHealthPanel, {
      badge: goodBadge, showLabel: false,
      state: healthState({ level: 2, assessment: { verdict: 'weak', reasons: ['5% of packets lost'], cpu: false } }),
    }));
    expect(html).toContain('hh-studio__conn--poor');
    expect(html).toContain('>Weak<');
    expect(html).toContain('hh-health__step');
    expect(html).toContain('5% of packets lost');
  });
  it('shows a short notice right after Auto changed the quality', () => {
    const html = renderToStaticMarkup(h(StreamHealthPanel, {
      badge: goodBadge, showLabel: true, state: healthState({ level: 1, lastChange: { dir: 'down', at: Date.now() } }),
    }));
    expect(html).toContain('Quality lowered');
    expect(html).not.toContain('hh-health__step');
  });
  it('with onOpen (the desktop Health tab) the pill reports that tab, not a popover', () => {
    const shut = renderToStaticMarkup(h(StreamHealthPanel, { badge: goodBadge, showLabel: true, state: healthState(), onOpen: vi.fn() }));
    expect(shut).toContain('aria-expanded="false"');
    const open = renderToStaticMarkup(h(StreamHealthPanel, { badge: goodBadge, showLabel: true, state: healthState(), onOpen: vi.fn(), active: true }));
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('hh-health__panel');
  });
  it('the details show the numbers and the Auto quality switch', () => {
    const html = renderToStaticMarkup(h(StreamHealthDetails, { state: healthState() }));
    expect(html).toContain('Measuring');
    expect(html).toContain('Auto quality');
  });
});

describe('StreamHealthRailButton (phone studio)', () => {
  const rail = (over: Record<string, unknown> = {}) => renderToStaticMarkup(h(StreamHealthRailButton, {
    badge: goodBadge, known: true, state: healthState(), active: false, onClick: vi.fn(), ...over,
  }));
  it('is a rail button with the bars as its glyph and no Good/Weak word', () => {
    const html = rail();
    expect(html).toContain('hh-studio__rbtn');
    expect(html).toContain('>Quality<');
    expect(html).not.toContain('>Good<');
    expect(html.match(/fill:#27c093/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Connection: Good. Stream health and quality"');
  });
  it('lights two amber bars and pulses when our own reading is weak, with a dot for a lowered quality', () => {
    const html = rail({ state: healthState({ level: 1, assessment: { verdict: 'weak', reasons: ['5% of packets lost'], cpu: false } }) });
    expect(html.match(/fill:#f1c40f/g)).toHaveLength(2);
    expect(html).toContain('hh-studio__rbtn-conn--poor');
    expect(html).toContain('hh-studio__rbtn-dot');
    expect(html).toContain('5% of packets lost');
  });
  it('stays grey until there is a reading, and shows when its sheet is open', () => {
    const html = rail({ known: false, active: true });
    expect(html).not.toMatch(/fill:#/);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('hh-studio__rbtn--on');
  });
});

const verticalApi = (over: Partial<VerticalOutputApi> = {}): VerticalOutputApi => ({
  prefs: { mode: 'off', x: 0.5, follow: 'manual' }, available: true,
  setMode: vi.fn(), setFollow: vi.fn(), setManual: vi.fn(), output: new VerticalOutput(), publishing: false, error: '', ...over,
});

describe('VerticalSettings', () => {
  it('is hidden where it does not apply (the phone studio)', () => {
    expect(renderToStaticMarkup(h(VerticalSettings, { api: verticalApi({ available: false }) }))).toBe('');
  });
  it('offers the three modes, and the follow choices once on', () => {
    const off = renderToStaticMarkup(h(VerticalSettings, { api: verticalApi() }));
    expect(off).toContain('Phone version');
    expect(off).toContain('Send a vertical video');
    expect(off).toContain('Crop on viewers');
    expect(off).not.toContain('Follow the camera');
    const on = renderToStaticMarkup(h(VerticalSettings, { api: verticalApi({ prefs: { mode: 'track', x: 0.5, follow: 'camera' }, error: 'nope' }) }));
    expect(on).toContain('Follow the camera');
    expect(on).toMatch(/hh-vsettings__chip is-active">Follow the camera/);
    expect(on).toContain('nope');
  });
});

describe('StudioOverlaysPanel', () => {
  const api = (over: Partial<StudioOverlaysApi> = {}): StudioOverlaysApi => ({
    config: DEFAULT_OVERLAY_CONFIG, update: vi.fn(), live: OFF_LIVE,
    showLowerThird: vi.fn(), hideLowerThird: vi.fn(), setTickerOn: vi.fn(), startCountdown: vi.fn(), stopCountdown: vi.fn(),
    defaults: { name: '@badadib', title: 'Morning stream' },
    templates: [], activeTemplate: null, saveTemplate: vi.fn(), applyTemplate: vi.fn(), deleteTemplate: vi.fn(), templatesError: '',
    musicFile: null, setMusicFile: vi.fn(), musicError: '', musicPlaying: false,
    configRef: { current: DEFAULT_OVERLAY_CONFIG }, ...over,
  });
  it('renders every section with the host defaults as placeholders', () => {
    const tab = (initialTab: 'show' | 'break' | 'templates') =>
      renderToStaticMarkup(h(StudioOverlaysPanel, { api: api(), onClose: vi.fn(), streamState: 'standby', initialTab }));
    const html = renderToStaticMarkup(h(StudioOverlaysPanel, { api: api(), onClose: vi.fn(), streamState: 'standby' }));
    // On screen first: lower third, ticker, countdown.
    for (const s of ['Lower third', 'Ticker', 'Countdown']) expect(html).toContain(s);
    expect(html).not.toContain('Be right back');
    expect(html).toContain('placeholder="@badadib"');
    expect(html).toContain('placeholder="Morning stream"');
    expect(html).toContain('Shows once you are live');
    expect(tab('break')).toContain('Be right back');
    expect(tab('break')).toContain('Calm pads (built in)');
    expect(tab('templates')).toContain('Fade between scenes');
    expect(tab('templates')).toContain('Template name');
  });
  it('lists templates and reflects what is on screen', () => {
    const props = {
      api: api({
        templates: [{ id: 'show', name: 'Show', config: DEFAULT_OVERLAY_CONFIG }], activeTemplate: 'show',
        live: { ...OFF_LIVE, lowerThirdOn: true, lowerThirdAt: 1, tickerOn: true }, musicPlaying: true, musicFile: 'theme.mp3',
        config: { ...DEFAULT_OVERLAY_CONFIG, brb: { message: '', music: 'file', volume: 0.4 } },
      }),
      onClose: vi.fn(), streamState: 'live' as const,
    };
    expect(renderToStaticMarkup(h(StudioOverlaysPanel, { ...props, initialTab: 'templates' }))).toContain('hh-overlays__chip is-active');
    expect(renderToStaticMarkup(h(StudioOverlaysPanel, props))).toContain('>Hide<');
    const brb = renderToStaticMarkup(h(StudioOverlaysPanel, { ...props, initialTab: 'break' }));
    expect(brb).toContain('Your file: theme.mp3');
    expect(brb).toContain('Playing to your viewers now');
    expect(brb).toContain('Music volume 40%');
  });
});
