import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_TRACKS, trackEvents, midiToHz, startBuiltinMusic } from '../src/lib/brbMusic.js';

describe('trackEvents', () => {
  it('a bar has a pad chord, two bass notes and the plucks, in order', () => {
    const ev = trackEvents(BUILTIN_TRACKS.calm, 0, 4);
    expect(ev.filter((e) => e.voice === 'pad')).toHaveLength(4);
    expect(ev.filter((e) => e.voice === 'bass').map((e) => e.beat)).toEqual([0, 2.5]);
    expect(ev.filter((e) => e.voice === 'pluck').map((e) => e.beat)).toEqual([1.5, 3]);
    expect(ev.every((e, i) => i === 0 || ev[i - 1].beat <= e.beat)).toBe(true);
  });
  it('arpeggiates 8th notes on the bright track', () => {
    expect(trackEvents(BUILTIN_TRACKS.bright, 0, 4).filter((e) => e.voice === 'pluck')).toHaveLength(8);
  });
  it('returns only notes starting in the window, the same every loop', () => {
    const a = trackEvents(BUILTIN_TRACKS.lofi, 2, 6);
    expect(a.every((e) => e.beat >= 2 && e.beat < 6)).toBe(true);
    const loop = BUILTIN_TRACKS.lofi.chords.length * 4;
    const first = trackEvents(BUILTIN_TRACKS.lofi, 0, loop).map((e) => [e.beat, e.midi]);
    const second = trackEvents(BUILTIN_TRACKS.lofi, loop, loop * 2).map((e) => [e.beat - loop, e.midi]);
    expect(second).toEqual(first);
    expect(trackEvents(BUILTIN_TRACKS.calm, 3, 3)).toEqual([]);
  });
  it('midiToHz', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(57)).toBeCloseTo(220);
  });
});

describe('startBuiltinMusic', () => {
  /** Minimal Web Audio stand-in that counts nodes. */
  function fakeAudio() {
    const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() });
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    const oscs: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    const ctx = {
      currentTime: 0,
      createGain: () => ({ ...node(), gain: param() }),
      createBiquadFilter: () => ({ ...node(), type: '', frequency: param(), Q: param() }),
      createOscillator: () => {
        const o = { ...node(), type: '', frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn(), onended: null };
        oscs.push(o);
        return o;
      },
    };
    return { ctx: ctx as unknown as BaseAudioContext, oscs };
  }
  it('schedules a few seconds ahead, more as time passes, and stops cleanly', () => {
    vi.useFakeTimers();
    const { ctx, oscs } = fakeAudio();
    const out = { connect: vi.fn() } as unknown as AudioNode;
    const h = startBuiltinMusic(ctx, out, 'calm', 0.5);
    const first = oscs.length;
    expect(first).toBeGreaterThan(0);
    (ctx as unknown as { currentTime: number }).currentTime = 8;
    vi.advanceTimersByTime(500);
    expect(oscs.length).toBeGreaterThan(first);
    h.setVolume(0.2);
    h.stop();
    const after = oscs.length;
    (ctx as unknown as { currentTime: number }).currentTime = 20;
    vi.advanceTimersByTime(2000);
    expect(oscs.length).toBe(after);
    h.stop();   // twice is fine
    vi.useRealTimers();
  });
});
