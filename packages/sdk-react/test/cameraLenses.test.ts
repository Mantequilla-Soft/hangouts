import { describe, expect, it } from 'vitest';
import { formatZoom, lensMatchesFacing, listLenses, SOFT_ZOOM, stepZoom, zoomStops } from '../src/lib/cameraLenses.js';

const cam = (deviceId: string, label: string) => ({ deviceId, kind: 'videoinput' as const, label });

describe('listLenses', () => {
  it('names Android lenses: the lowest number of a side is its main camera, the rest are numbered', () => {
    const lenses = listLenses([
      cam('f', 'camera2 1, facing front'),
      cam('b0', 'camera2 0, facing back'),
      cam('b3', 'camera2 3, facing back'),
      cam('b2', 'camera2 2, facing back'),
      { deviceId: 'mic', kind: 'audioinput', label: 'Microphone' },
    ]);
    expect(lenses.map((l) => [l.deviceId, l.name, l.kind, l.facing])).toEqual([
      ['b0', 'Back camera', 'main', 'environment'],
      ['b3', 'Back camera 3', null, 'environment'],
      ['b2', 'Back camera 2', null, 'environment'],
      ['f', 'Front camera', 'main', 'user'],
    ]);
  });
  it('keeps iOS names and reads the lens from them', () => {
    const lenses = listLenses([
      cam('fr', 'Front Camera'), cam('uw', 'Back Ultra Wide Camera'), cam('t', 'Back Telephoto Camera'), cam('w', 'Back Camera'),
    ]);
    expect(lenses.map((l) => [l.name, l.kind])).toEqual([
      ['Back Ultra Wide Camera', 'ultrawide'], ['Back Telephoto Camera', 'tele'], ['Back Camera', null], ['Front Camera', null],
    ]);
  });
  it('lists unnamed cameras (no permission yet) by number', () => {
    expect(listLenses([cam('a', ''), cam('b', '')]).map((l) => l.name)).toEqual(['Camera 1', 'Camera 2']);
  });
  it('matches a side by label, keeping unlabelled cameras', () => {
    expect(lensMatchesFacing('camera2 2, facing back', 'environment')).toBe(true);
    expect(lensMatchesFacing('camera2 1, facing front', 'environment')).toBe(false);
    expect(lensMatchesFacing('', 'user')).toBe(true);
  });
});

describe('zoom steps', () => {
  it('a lens that reaches its ultra-wide itself zooms out below 1×', () => {
    const r = { min: 0.6, max: 8, hardware: true };
    expect(zoomStops(r)).toEqual([0.6, 1, 2, 3, 5, 8]);
    expect(stepZoom(r, 1, -1)).toBe(0.6);
    expect(stepZoom(r, 0.6, -1)).toBe(0.6);
    expect(stepZoom(r, 1, 1)).toBe(2);
    expect(stepZoom(r, 8, 1)).toBe(8);
  });
  it('a plain lens goes from 1× to its maximum', () => {
    expect(zoomStops({ min: 1, max: 4, hardware: true })).toEqual([1, 2, 3, 4]);
    expect(zoomStops({ min: 1, max: 1.5, hardware: true })).toEqual([1, 1.5]);
  });
  it('without hardware zoom it crops 1–4× in half steps', () => {
    expect(stepZoom(SOFT_ZOOM, 1, 1)).toBe(1.5);
    expect(stepZoom(SOFT_ZOOM, 1, -1)).toBe(1);
  });
  it('labels the factor the way a camera app does', () => {
    expect([0.6, 1, 2, 2.5, 1.04].map(formatZoom)).toEqual(['0.6×', '1×', '2×', '2.5×', '1×']);
  });
});
