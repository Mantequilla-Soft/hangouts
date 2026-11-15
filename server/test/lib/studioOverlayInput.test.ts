import { describe, it, expect } from 'vitest';
import {
  cleanOverlayConfig, cleanOverlayTemplates, cleanVerticalCrop, cleanText, MAX_OVERLAY_TEMPLATES,
} from '../../src/lib/studioOverlayInput.js';

describe('cleanText', () => {
  it('trims, folds control characters and caps', () => {
    expect(cleanText('  hi\n\tthere  ', 50)).toBe('hi there');
    expect(cleanText('abcdef', 3)).toBe('abc');
    expect(cleanText(42, 5)).toBe('');
  });
});

describe('cleanOverlayConfig', () => {
  it('fills defaults for an empty body', () => {
    expect(cleanOverlayConfig(null)).toEqual({
      lowerThird: { name: '', title: '' },
      ticker: { text: '', speed: 'normal' },
      countdown: { label: '', minutes: 5 },
      brb: { message: '', music: 'off', volume: 0.5 },
      fade: true,
    });
  });
  it('keeps valid values, clamps numbers and drops unknown choices', () => {
    const c = cleanOverlayConfig({
      lowerThird: { name: 'badadib', title: 'Live from the studio', extra: 1 },
      ticker: { text: 'Boost to support', speed: 'fast' },
      countdown: { label: 'Starting in', minutes: 999 },
      brb: { message: 'Back soon', music: 'lofi', volume: 3 },
      fade: false,
      junk: true,
    });
    expect(c).toEqual({
      lowerThird: { name: 'badadib', title: 'Live from the studio' },
      ticker: { text: 'Boost to support', speed: 'fast' },
      countdown: { label: 'Starting in', minutes: 180 },
      brb: { message: 'Back soon', music: 'lofi', volume: 1 },
      fade: false,
    });
    expect(cleanOverlayConfig({ ticker: { speed: 'warp' }, brb: { music: 'rock', volume: -1 }, countdown: { minutes: 0.2 } }))
      .toMatchObject({ ticker: { speed: 'normal' }, brb: { music: 'off', volume: 0 }, countdown: { minutes: 1 } });
  });
});

describe('cleanOverlayTemplates', () => {
  it('cleans each template', () => {
    const out = cleanOverlayTemplates([{ id: 'Show-1!', name: ' Morning show ', config: { fade: false } }]);
    expect(out).toEqual([{ id: 'show-1', name: 'Morning show', config: expect.objectContaining({ fade: false }) }]);
  });
  it('refuses a non-list, too many, missing ids or names, and duplicate ids', () => {
    expect(cleanOverlayTemplates('x')).toBe('templates must be a list');
    expect(cleanOverlayTemplates(Array.from({ length: MAX_OVERLAY_TEMPLATES + 1 }, (_, i) => ({ id: `t${i}`, name: 'n' }))))
      .toMatch(/at most/);
    expect(cleanOverlayTemplates([{ id: '', name: 'n' }])).toMatch(/id and a name/);
    expect(cleanOverlayTemplates([{ id: 'a', name: '  ' }])).toMatch(/id and a name/);
    expect(cleanOverlayTemplates([{ id: 'a', name: 'x' }, { id: 'A', name: 'y' }])).toMatch(/unique/);
  });
});

describe('cleanVerticalCrop', () => {
  it('defaults to a centred 16:9 crop, off', () => {
    expect(cleanVerticalCrop(undefined)).toEqual({ on: false, x: 0.5, w: 0.316, follow: 'manual', track: false });
  });
  it('keeps the crop inside the frame', () => {
    expect(cleanVerticalCrop({ on: true, x: 0, w: 0.316, follow: 'camera', track: true }))
      .toEqual({ on: true, x: 0.158, w: 0.316, follow: 'camera', track: true });
    expect(cleanVerticalCrop({ x: 2, w: 0.5 }).x).toBe(0.75);
    expect(cleanVerticalCrop({ w: 9, follow: 'nope' })).toMatchObject({ w: 1, x: 0.5, follow: 'manual' });
  });
});
