import { describe, expect, it } from 'vitest';
import {
  cropWidthFrac, clampCenter, cropRect, verticalSize, verticalBitrate, followTarget, smoothToward,
  readVerticalMeta, objectPositionFor, prefersVertical, sceneRegions, STUDIO_VERTICAL_TRACK,
} from '../src/lib/verticalCrop.js';
import { VerticalOutput } from '../src/lib/verticalOutput.js';

describe('crop geometry', () => {
  it('a 9:16 slice of 16:9 is 31.6% wide', () => {
    expect(cropWidthFrac(1280, 720)).toBeCloseTo(0.3164, 3);
    expect(cropWidthFrac(720, 1280)).toBe(1);
    expect(cropWidthFrac(0, 0)).toBe(9 / 16);
  });
  it('keeps the crop inside the frame', () => {
    expect(clampCenter(0, 0.3)).toBeCloseTo(0.15);
    expect(clampCenter(1, 0.3)).toBeCloseTo(0.85);
    expect(clampCenter(Number.NaN, 0.3)).toBe(0.5);
    expect(cropRect(1280, 720, 0.5)).toEqual({ sx: 438, sy: 0, sw: 405, sh: 720 });
    expect(cropRect(1280, 720, 0)).toMatchObject({ sx: 0 });
    expect(cropRect(1280, 720, 1)).toMatchObject({ sx: 875 });
  });
  it('vertical output size and bitrate', () => {
    expect(verticalSize(720)).toEqual({ width: 406, height: 720 });
    expect(verticalSize(480)).toEqual({ width: 270, height: 480 });
    expect(verticalBitrate(2_500_000)).toBe(1_050_000);
    expect(verticalBitrate(100_000)).toBe(300_000);
  });
});

describe('following', () => {
  const pip = { x: 0.7, y: 0.6, w: 0.24, h: 0.3 };
  it('follows the camera box or the source half, and holds otherwise', () => {
    expect(followTarget('manual', { camera: pip, source: null })).toBeNull();
    expect(followTarget('camera', { camera: pip, source: null })).toBeCloseTo(0.82);
    expect(followTarget('camera', { camera: { x: 0, y: 0, w: 1, h: 1 }, source: null })).toBeNull();
    expect(followTarget('source', sceneRegions('split', 0.6, null, true, true))).toBeCloseTo(0.3);
    expect(followTarget('camera', sceneRegions('split', 0.6, null, true, true))).toBeCloseTo(0.8);
    expect(followTarget('source', { camera: null, source: null })).toBeNull();
  });
  it('scene regions per scene', () => {
    expect(sceneRegions('cam', 0.5, null, true, false)).toEqual({ camera: { x: 0, y: 0, w: 1, h: 1 }, source: null });
    expect(sceneRegions('fullscreen', 0.5, null, true, true).camera).toBeNull();
    expect(sceneRegions('overlay', 0.5, pip, true, true).camera).toEqual(pip);
    expect(sceneRegions('overlay', 0.5, pip, false, true).camera).toBeNull();
    expect(sceneRegions('splitv', 0.5, null, true, true).camera).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it('glides toward the target', () => {
    const a = smoothToward(0.2, 0.8, 33);
    expect(a).toBeGreaterThan(0.2);
    expect(a).toBeLessThan(0.8);
    expect(smoothToward(0.8, 0.8, 33)).toBe(0.8);
    expect(smoothToward(0.2, 0.8, 100_000)).toBe(0.8);
  });
  it('VerticalOutput steps to the manual spot at once and glides when following', () => {
    const vo = new VerticalOutput();
    vo.manual = 0;
    vo.step(1000, null, 1280, 720);
    expect(vo.center).toBeCloseTo(0.158, 2);
    vo.step(1033, 0.9, 1280, 720);
    expect(vo.center).toBeGreaterThan(0.158);
    expect(vo.center).toBeLessThan(0.842);
    expect(vo.publishing).toBe(false);
    expect(vo.ensureCanvas(720)).toBeNull();   // no DOM in node
  });
});

describe('viewer side', () => {
  it('reads the host crop from the room metadata', () => {
    expect(readVerticalMeta(null)).toBeNull();
    expect(readVerticalMeta({ vertical: { on: false } })).toBeNull();
    expect(readVerticalMeta({ vertical: { on: true, x: 0.9, w: 0.316, follow: 'camera', track: true } }))
      .toEqual({ on: true, x: 0.842, w: 0.316, follow: 'camera', track: true });
    expect(readVerticalMeta({ vertical: { on: true } })).toMatchObject({ x: 0.5, follow: 'manual', track: false });
  });
  it('places a viewer crop on the host centre', () => {
    expect(objectPositionFor(0.5, 0.3)).toBeCloseTo(0.5);
    expect(objectPositionFor(0.15, 0.3)).toBe(0);
    expect(objectPositionFor(0.85, 0.3)).toBe(1);
    expect(objectPositionFor(0.3, 1)).toBe(0.5);
  });
  it('phones held upright prefer vertical', () => {
    expect(prefersVertical(390, 844, true)).toBe(true);
    expect(prefersVertical(844, 390, true)).toBe(false);
    expect(prefersVertical(1080, 1920, false)).toBe(false);
    expect(prefersVertical(500, 800, false)).toBe(true);
  });
  it('the track name matches the server and sdk-core', () => {
    expect(STUDIO_VERTICAL_TRACK).toBe('studio-vertical');
  });
});
