import { describe, expect, it } from 'vitest';
import {
  computeHealth, assessHealth, stepController, encodingsForStep, describeViewerQuality,
  INITIAL_CONTROLLER, QUALITY_STEPS, MAX_STEP, DOWN_AFTER, UP_AFTER, HOLD_MS,
  type HealthSample, type LayerSample, type StreamHealth,
} from '../src/lib/streamHealth.js';

const layer = (rid: string, h: number, over: Partial<LayerSample> = {}): LayerSample => ({
  rid, bytesSent: 0, packetsSent: 0, packetsLost: 0, framesSent: 0, framesPerSecond: 30,
  frameWidth: Math.round((h * 16) / 9), frameHeight: h, ...over,
});
const sample = (at: number, layers: LayerSample[], composedFrames = 60, activeRids: string[] = []): HealthSample => ({ at, layers, composedFrames, activeRids });

describe('computeHealth', () => {
  it('derives bitrate, fps, loss, rtt and the viewer layers over the interval', () => {
    const prev = sample(0, [layer('f', 720), layer('h', 360), layer('q', 180)]);
    const cur = sample(2000, [
      layer('f', 720, { bytesSent: 500_000, packetsSent: 500, packetsLost: 10, framesSent: 56, roundTripTime: 0.08, targetBitrate: 2_500_000 }),
      layer('h', 360, { bytesSent: 100_000, packetsSent: 100, framesSent: 60, roundTripTime: 0.1, targetBitrate: 500_000 }),
      layer('q', 180, { bytesSent: 0 }),
    ], 60, ['f', 'h']);
    const h = computeHealth(prev, cur);
    expect(h.bitrateKbps).toBe(2400);
    expect(h.targetKbps).toBe(3000);
    expect(h.composedFps).toBe(30);
    expect(h.sentFps).toBe(28);
    expect(h.droppedPct).toBeCloseTo(6.7, 1);
    expect(h.lossPct).toBeCloseTo(1.6, 1);
    expect(h.rttMs).toBe(90);
    expect(h.sentHeight).toBe(720);
    expect(h.viewerHeights).toEqual([720, 360]);
    expect(h.limit).toBe('none');
  });
  it('reads the encoder limit from where its time went, or the instant reason', () => {
    const prev = sample(0, [layer('', 480, { qualityLimitationDurations: { none: 10, bandwidth: 0, cpu: 0 } })]);
    const cur = sample(2000, [layer('', 480, { bytesSent: 1000, framesSent: 60, qualityLimitationDurations: { none: 10.5, bandwidth: 1.5, cpu: 0 } })]);
    expect(computeHealth(prev, cur).limit).toBe('bandwidth');
    const p2 = sample(0, [layer('', 480)]);
    const c2 = sample(2000, [layer('', 480, { bytesSent: 1000, framesSent: 60, qualityLimitationReason: 'cpu' })]);
    expect(computeHealth(p2, c2).limit).toBe('cpu');
    const c3 = sample(2000, [layer('', 480, { bytesSent: 1000, framesSent: 60, qualityLimitationReason: 'weird' })]);
    expect(computeHealth(p2, c3).limit).toBe('other');
  });
  it('nothing sent yet: zeros, no division by zero', () => {
    const h = computeHealth(sample(0, []), sample(0, [], 0));
    expect(h).toMatchObject({ bitrateKbps: 0, sentFps: 0, droppedPct: 0, lossPct: 0, rttMs: 0, viewerHeights: [] });
  });
});

const good: StreamHealth = {
  bitrateKbps: 2400, targetKbps: 2500, composedFps: 30, sentFps: 30, sentWidth: 1280, sentHeight: 720,
  droppedPct: 0, lossPct: 0, rttMs: 60, limit: 'none', viewerHeights: [720],
};

describe('assessHealth', () => {
  it('good when clean', () => {
    expect(assessHealth(good, 'excellent')).toEqual({ verdict: 'good', reasons: [], cpu: false });
  });
  it('weak on early signs, bad when they pile up', () => {
    expect(assessHealth({ ...good, lossPct: 4 }).verdict).toBe('weak');
    expect(assessHealth({ ...good, rttMs: 400 }).verdict).toBe('weak');
    expect(assessHealth({ ...good, limit: 'bandwidth' }).verdict).toBe('weak');
    expect(assessHealth(good, 'poor').verdict).toBe('weak');
    expect(assessHealth({ ...good, lossPct: 9, rttMs: 800 }).verdict).toBe('bad');
    expect(assessHealth(good, 'lost').verdict).toBe('bad');
    expect(assessHealth({ ...good, bitrateKbps: 800 }).reasons[0]).toMatch(/below the planned/);
  });
  it('tells a busy device apart from a weak network', () => {
    const a = assessHealth({ ...good, limit: 'cpu', droppedPct: 30, composedFps: 18 });
    expect(a.cpu).toBe(true);
    expect(a.verdict).toBe('bad');
    expect(a.reasons.join(' ')).toMatch(/device/);
  });
});

describe('stepController', () => {
  it('steps down after two weak samples, holds, then down again', () => {
    let s = stepController(INITIAL_CONTROLLER, 'weak', 10_000);
    expect(s.level).toBe(0);
    s = stepController(s, 'weak', 12_000);
    expect(s.level).toBe(1);
    s = stepController(s, 'weak', 14_000);
    s = stepController(s, 'weak', 16_000);
    expect(s.level).toBe(1);   // held
    s = stepController(s, 'weak', 12_000 + HOLD_MS + 1);
    expect(s.level).toBe(2);
  });
  it('a bad sample steps at once, two bad ones in a row step twice', () => {
    let s = stepController(INITIAL_CONTROLLER, 'bad', 10_000);
    expect(s.level).toBe(1);
    s = stepController({ ...s, changedAt: 0 }, 'bad', 20_000);
    s = stepController({ ...s, changedAt: 0 }, 'bad', 22_000);
    expect(s.level).toBe(3);
  });
  it('comes back up one step after a long good run, never past full or the bottom', () => {
    let s = { ...INITIAL_CONTROLLER, level: 2, changedAt: 0 };
    for (let i = 0; i < UP_AFTER - 1; i++) s = stepController(s, 'good', 100_000 + i * 2000);
    expect(s.level).toBe(2);
    s = stepController(s, 'good', 200_000);
    expect(s.level).toBe(1);
    let top = { ...INITIAL_CONTROLLER };
    for (let i = 0; i < 30; i++) top = stepController(top, 'good', i * 10_000);
    expect(top.level).toBe(0);
    let bottom = { ...INITIAL_CONTROLLER, level: MAX_STEP };
    for (let i = 0; i < DOWN_AFTER + 2; i++) bottom = stepController(bottom, 'bad', 100_000 + i * 10_000);
    expect(bottom.level).toBe(MAX_STEP);
  });
});

describe('encodingsForStep', () => {
  const base = [
    { rid: 'q', maxBitrate: 150_000, maxFramerate: 30, scaleResolutionDownBy: 4 },
    { rid: 'h', maxBitrate: 500_000, maxFramerate: 30, scaleResolutionDownBy: 2 },
    { rid: 'f', maxBitrate: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
  ];
  it('full quality gives back the published encodings, keeping active', () => {
    const cur = base.map((e) => ({ ...e, active: e.rid !== 'q', maxBitrate: 1 }));
    const out = encodingsForStep(cur, base, 0);
    expect(out.map((e) => e.maxBitrate)).toEqual([150_000, 500_000, 2_500_000]);
    expect(out.map((e) => e.active)).toEqual([false, true, true]);
  });
  it('scales each layer by the step, with floors', () => {
    const out = encodingsForStep(base.map((e) => ({ ...e })), base, 3);
    const step = QUALITY_STEPS[3];
    expect(out[2].maxBitrate).toBe(Math.round(2_500_000 * step.bitrate));
    expect(out[2].scaleResolutionDownBy).toBe(1.5);
    expect(out[0].scaleResolutionDownBy).toBe(6);
    expect(out[0].maxBitrate).toBe(80_000);
    expect(out.every((e) => e.maxFramerate === 24)).toBe(true);
    expect(encodingsForStep([{ maxBitrate: 1 }], [{ maxBitrate: 1_000_000 }], 99)[0].maxFramerate).toBe(15);
  });
});

describe('describeViewerQuality', () => {
  it('reads plainly', () => {
    expect(describeViewerQuality([])).toBe('No video being sent');
    expect(describeViewerQuality([720])).toBe('Up to 720p');
    expect(describeViewerQuality([720, 360, 180])).toBe('720p, 360p and 180p');
  });
});
