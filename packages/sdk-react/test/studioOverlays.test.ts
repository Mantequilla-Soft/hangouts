import { describe, expect, it, vi } from 'vitest';
import {
  OverlayLayerList, FadeTransition, createTextOverlayLayers, cleanOverlayConfig, cleanOverlayTemplates,
  newTemplateId, formatCountdown, lowerThirdProgress, overlayScale, fitText, tickerHeight,
  drawTicker, drawLowerThird, drawCountdown, cleanText, editText,
  DEFAULT_OVERLAY_CONFIG, OFF_LIVE, LOWER_THIRD_ANIM_MS, COUNTDOWN_LINGER_MS, MAX_OVERLAY_TEMPLATES,
  type FrameInfo, type OverlayConfig, type OverlayLive,
} from '../src/lib/studioOverlays.js';
import { fakeCtx } from './fakeCanvas.js';

const info = (over: Partial<FrameInfo> = {}): FrameInfo => ({ state: 'live', shape: 'landscape', now: 10_000, wall: 1_000_000, accent: '', ...over });

describe('config cleaning', () => {
  it('fills defaults and clamps, like the server', () => {
    expect(cleanOverlayConfig(undefined)).toEqual(DEFAULT_OVERLAY_CONFIG);
    const c = cleanOverlayConfig({ lowerThird: { name: ' badadib\n' }, countdown: { minutes: 500 }, brb: { music: 'lofi', volume: 2 }, ticker: { speed: 'x' }, fade: false });
    expect(c.lowerThird.name).toBe('badadib');
    expect(c.countdown.minutes).toBe(180);
    expect(c.brb).toEqual({ message: '', music: 'lofi', volume: 1 });
    expect(c.ticker.speed).toBe('normal');
    expect(c.fade).toBe(false);
  });
  it('cleanText folds, editText keeps the trailing space being typed', () => {
    expect(cleanText('  a \n b ', 10)).toBe('a b');
    expect(editText('hello ', 10)).toBe('hello ');
    expect(editText('a\nb', 10)).toBe('a b');
    expect(editText('abcdef', 3)).toBe('abc');
  });
  it('templates: drops broken and duplicate entries and caps the count', () => {
    expect(cleanOverlayTemplates('nope')).toEqual([]);
    const list = cleanOverlayTemplates([
      { id: 'A!', name: 'One', config: {} }, { id: 'a', name: 'Dup' }, { id: '', name: 'x' }, { id: 'b', name: ' ' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `T${i}` })),
    ]);
    expect(list[0]).toMatchObject({ id: 'a', name: 'One' });
    expect(list.filter((t) => t.id === 'a')).toHaveLength(1);
    expect(list.length).toBeLessThanOrEqual(MAX_OVERLAY_TEMPLATES);
  });
  it('newTemplateId slugs the name and avoids clashes', () => {
    const t = (id: string) => ({ id, name: id, config: DEFAULT_OVERLAY_CONFIG });
    expect(newTemplateId('Morning Show!', [])).toBe('morning-show');
    expect(newTemplateId('Morning show', [t('morning-show')])).toBe('morning-show-2');
    expect(newTemplateId('***', [])).toBe('template');
  });
});

describe('formatCountdown', () => {
  it('formats minutes, hours and never goes negative', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
    expect(formatCountdown(-5000)).toBe('0:00');
    expect(formatCountdown(400)).toBe('0:01');
  });
});

describe('lowerThirdProgress', () => {
  const at = 1000;
  it('slides in, holds, and slides out after Hide', () => {
    const on: OverlayLive = { ...OFF_LIVE, lowerThirdOn: true, lowerThirdAt: at };
    expect(lowerThirdProgress(on, at)).toBe(0);
    expect(lowerThirdProgress(on, at + LOWER_THIRD_ANIM_MS / 2)).toBeCloseTo(0.5);
    expect(lowerThirdProgress(on, at + 60_000)).toBe(1);
    const off: OverlayLive = { ...OFF_LIVE, lowerThirdOn: false, lowerThirdAt: 5000 };
    expect(lowerThirdProgress(off, 5000)).toBe(1);
    expect(lowerThirdProgress(off, 5000 + LOWER_THIRD_ANIM_MS)).toBe(0);
    expect(lowerThirdProgress(OFF_LIVE, 99_999)).toBe(0);
  });
  it('hides itself after the chosen time', () => {
    const timed: OverlayLive = { ...OFF_LIVE, lowerThirdOn: true, lowerThirdAt: at, lowerThirdUntil: at + 8000 };
    expect(lowerThirdProgress(timed, at + 7000)).toBe(1);
    expect(lowerThirdProgress(timed, at + 8000 + LOWER_THIRD_ANIM_MS / 2)).toBeCloseTo(0.5);
    expect(lowerThirdProgress(timed, at + 9000)).toBe(0);
  });
});

describe('OverlayLayerList', () => {
  it('draws by z, replaces by id, removes, and survives a broken layer', () => {
    const list = new OverlayLayerList();
    const order: string[] = [];
    list.add({ id: 'b', z: 20, draw: () => { order.push('b'); } });
    const removeA = list.add({ id: 'a', z: 10, draw: () => { order.push('a'); return false; } });
    list.add({ id: 'boom', z: 15, draw: () => { throw new Error('x'); } });
    const ctx = fakeCtx();
    expect(list.draw(ctx, 1280, 720, info())).toBe(true);
    expect(order).toEqual(['a', 'b']);
    // save/restore around every layer, even the one that threw
    expect(ctx.calls.filter((c) => c.op === 'save')).toHaveLength(3);
    expect(ctx.calls.filter((c) => c.op === 'restore')).toHaveLength(3);
    list.add({ id: 'b', z: 5, draw: () => { order.push('b2'); return false; } });
    removeA();
    list.remove('boom');
    order.length = 0;
    expect(list.draw(ctx, 1280, 720, info())).toBe(false);
    expect(order).toEqual(['b2']);
    expect(list.size).toBe(1);
  });
});

describe('drawing', () => {
  it('scales to the frame (landscape, 9:16, a smaller tier)', () => {
    expect(overlayScale(1280, 720)).toBe(1);
    expect(overlayScale(406, 720)).toBeCloseTo(1, 1);
    expect(overlayScale(854, 480)).toBeCloseTo(0.667, 2);
    expect(tickerHeight(1280, 720)).toBe(40);
  });
  it('fitText ellipses long text', () => {
    const ctx = fakeCtx();
    ctx.font = '10px x';
    expect(fitText(ctx, 'short', 100)).toBe('short');
    const cut = fitText(ctx, 'a very long line of text indeed', 50);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan(12);
  });
  it('lower third: name and title, nothing when empty or hidden', () => {
    const ctx = fakeCtx();
    drawLowerThird(ctx, 1280, 720, '@badadib', 'Live from the studio', 1);
    expect(ctx.texts).toEqual(['@badadib', 'Live from the studio']);
    const none = fakeCtx();
    drawLowerThird(none, 1280, 720, '', '', 1);
    drawLowerThird(none, 1280, 720, 'x', '', 0);
    expect(none.calls).toHaveLength(0);
  });
  it('ticker repeats the text across the band once it has entered', () => {
    const ctx = fakeCtx();
    drawTicker(ctx, 1280, 720, 'Hi', 'normal', 60_000);
    expect(ctx.texts.length).toBeGreaterThan(5);
    expect(ctx.texts[0]).toContain('Hi');
    const early = fakeCtx();
    drawTicker(early, 1280, 720, 'Hi', 'fast', 0);
    // enters from the right edge: first copy starts at x = width
    const first = early.calls.find((c) => c.op === 'fillText');
    expect(first).toBeUndefined();
    const none = fakeCtx();
    drawTicker(none, 1280, 720, '', 'slow', 1000);
    expect(none.calls).toHaveLength(0);
  });
  it('countdown: big on a slate, a chip while live', () => {
    const slate = fakeCtx();
    drawCountdown(slate, 1280, 720, 'Starting in', 90_000, true);
    expect(slate.texts).toEqual(['Starting in', '1:30']);
    const chip = fakeCtx();
    drawCountdown(chip, 1280, 720, '', 5000, false, '#123456');
    expect(chip.texts).toEqual(['0:05']);
    expect(chip.fillStyle).toBe('#123456');   // last 10 s in the accent
  });
});

describe('createTextOverlayLayers', () => {
  const cfg: OverlayConfig = {
    ...DEFAULT_OVERLAY_CONFIG,
    lowerThird: { name: '@badadib', title: 'Host' },
    ticker: { text: 'Boost the stream', speed: 'normal' },
    countdown: { label: 'Back in', minutes: 5 },
  };
  const layers = (live: OverlayLive, c = cfg) => {
    const list = new OverlayLayerList();
    createTextOverlayLayers(() => c, () => live).forEach((l) => list.add(l));
    return list;
  };
  it('draws nothing when everything is off', () => {
    const ctx = fakeCtx();
    expect(layers(OFF_LIVE).draw(ctx, 1280, 720, info())).toBe(false);
    expect(ctx.texts).toEqual([]);
  });
  it('lower third only while live; ticker and countdown on slates too', () => {
    const live: OverlayLive = { ...OFF_LIVE, lowerThirdOn: true, lowerThirdAt: 1, tickerOn: true, tickerAt: 0, countdownEndsAt: 1_000_000 + 60_000 };
    const onAir = fakeCtx();
    layers(live).draw(onAir, 1280, 720, info());
    expect(onAir.texts).toContain('@badadib');
    expect(onAir.texts).toContain('1:00');
    expect(onAir.texts.some((t) => t.includes('Boost the stream'))).toBe(true);
    const slate = fakeCtx();
    layers(live).draw(slate, 1280, 720, info({ state: 'paused' }));
    expect(slate.texts).not.toContain('@badadib');
    expect(slate.texts).toContain('Back in');
  });
  it('the countdown clears itself a few seconds after zero', () => {
    const live: OverlayLive = { ...OFF_LIVE, countdownEndsAt: 1_000_000 - COUNTDOWN_LINGER_MS - 1 };
    const ctx = fakeCtx();
    expect(layers(live).draw(ctx, 1280, 720, info())).toBe(false);
  });
  it('a ticker without text stays off', () => {
    const ctx = fakeCtx();
    expect(layers({ ...OFF_LIVE, tickerOn: true }, { ...cfg, ticker: { text: '', speed: 'slow' } }).draw(ctx, 1280, 720, info())).toBe(false);
  });
});

describe('FadeTransition', () => {
  const canvas = (w = 100, h = 50) => {
    const ctx = fakeCtx(w, h);
    return { width: w, height: h, getContext: () => ctx, ctx } as unknown as HTMLCanvasElement & { ctx: ReturnType<typeof fakeCtx> };
  };
  it('keeps the old frame on a key change and fades it out', () => {
    const snap = canvas();
    const fade = new FadeTransition(400, () => snap);
    const src = canvas();
    fade.track('cam', src, 0, true);            // first frame: nothing to fade from
    expect(fade.active).toBe(false);
    fade.track('cam', src, 10, true);
    expect(fade.active).toBe(false);
    fade.track('split', src, 20, true);
    expect(fade.active).toBe(true);
    expect(snap.ctx.calls.some((c) => c.op === 'drawImage' && c.args[0] === src)).toBe(true);
    const out = fakeCtx();
    expect(fade.paint(out, 100, 50, 220)).toBe(true);
    expect(out.calls.some((c) => c.op === 'drawImage')).toBe(true);
    expect(fade.paint(out, 100, 50, 500)).toBe(false);
    expect(fade.active).toBe(false);
  });
  it('does nothing when fades are off or no canvas can be made', () => {
    const fade = new FadeTransition(400, () => null);
    const src = canvas();
    fade.track('a', src, 0, true);
    fade.track('b', src, 1, false);
    expect(fade.active).toBe(false);
    fade.track('c', src, 2, true);
    expect(fade.active).toBe(false);
    const make = vi.fn(() => canvas());
    const f2 = new FadeTransition(400, make);
    f2.track('a', src, 0, true);
    f2.track('b', src, 1, true);
    f2.track('c', src, 2, true);
    expect(make).toHaveBeenCalledTimes(1);   // the snapshot canvas is reused
  });
});
