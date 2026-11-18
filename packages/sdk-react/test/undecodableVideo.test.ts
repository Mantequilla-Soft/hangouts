import { describe, expect, it } from 'vitest';
import { INITIAL_DECODE_WATCH, UNDECODABLE_MS, isH264, stepDecodeWatch, type DecodeSample, type DecodeWatch } from '../src/lib/undecodableVideo';

const run = (samples: DecodeSample[], step = 1000) => {
  let w: DecodeWatch = INITIAL_DECODE_WATCH;
  const fires: number[] = [];
  samples.forEach((s, i) => {
    const next = stepDecodeWatch(w, s, step);
    if (next.fire) fires.push(i);
    w = next;
  });
  return { w, fires };
};
const black: DecodeSample = { h264: true, eligible: true, framesDecoded: 0 };
const seconds = (n: number, s: DecodeSample) => Array.from({ length: n }, () => s);

describe('undecodable H.264 video (OBS passthrough)', () => {
  it('gives up once, after UNDECODABLE_MS of visible time without a frame', () => {
    const n = UNDECODABLE_MS / 1000;
    const { fires, w } = run(seconds(n + 5, black));
    expect(fires).toEqual([n - 1]);
    expect(w.fired).toBe(true);
  });

  it('never judges a VP8 track: every browser decodes that', () => {
    expect(run(seconds(60, { ...black, h264: false })).fires).toEqual([]);
  });

  it('a decoded frame settles it for good, even if frames stop later', () => {
    const { fires, w } = run([...seconds(5, black), { ...black, framesDecoded: 3 }, ...seconds(30, black)]);
    expect(fires).toEqual([]);
    expect(w.ok).toBe(true);
  });

  it('does not count time the page is hidden, the host muted or the SFU paused the stream', () => {
    const hidden = { ...black, eligible: false };
    const { fires } = run([...seconds(8, black), ...seconds(30, hidden), ...seconds(3, black)]);
    expect(fires).toEqual([]);
    expect(run([...seconds(8, black), ...seconds(30, hidden), ...seconds(4, black)]).fires).toHaveLength(1);
  });

  it('reads H.264 from the publication mime type', () => {
    expect(isH264({ mimeType: 'video/H264' })).toBe(true);
    expect(isH264({ mimeType: 'video/VP8' })).toBe(false);
    expect(isH264(undefined)).toBe(false);
  });
});
