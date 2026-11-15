import { afterEach, describe, expect, it, vi } from 'vitest';
import { boostLabels, DEFAULT_BOOST_LABELS } from '../src/lib/boostLabels.js';
import { chimeNotes, playBoostChime, speakBoost } from '../src/lib/boostChime.js';

describe('boostLabels', () => {
  it('defaults, and the integrator\'s text over them; empty entries keep English', () => {
    expect(boostLabels()).toBe(DEFAULT_BOOST_LABELS);
    const L = boostLabels({ send: 'Boost senden', cancel: '', topSupporters: undefined });
    expect(L.send).toBe('Boost senden');
    expect(L.cancel).toBe('Cancel');
    expect(L.topSupporters).toBe('Top supporters');
  });

  it('no em dashes in the default text', () => {
    for (const v of Object.values(DEFAULT_BOOST_LABELS)) expect(v).not.toMatch(/\u2014/);
  });
});

describe('chimeNotes', () => {
  it('bigger tiers ring longer, the top tier adds a note, the goal is a rising run', () => {
    const t0 = chimeNotes('boost', 0);
    const t3 = chimeNotes('boost', 3);
    expect(t0).toHaveLength(2);
    expect(t3).toHaveLength(3);
    expect(t3[0].dur).toBeGreaterThan(t0[0].dur);
    const goal = chimeNotes('goal');
    expect(goal.map((n) => n.freq)).toEqual([...goal.map((n) => n.freq)].sort((a, b) => a - b));
    expect(chimeNotes('boost', 99)).toEqual(t3);
  });
});

describe('playBoostChime / speakBoost', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('do nothing (and never throw) without a browser', () => {
    expect(() => playBoostChime('boost', 1)).not.toThrow();
    expect(() => speakBoost('hello')).not.toThrow();
  });

  it('schedules one oscillator per note on a WebAudio context', () => {
    const started: number[] = [];
    const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
    class FakeCtx {
      state = 'running';
      currentTime = 0;
      destination = {};
      createGain() { return { gain: param(), connect: vi.fn() }; }
      createOscillator() {
        return { type: '', frequency: param(), connect: vi.fn(), start: (t: number) => started.push(t), stop: vi.fn() };
      }
      resume() { return Promise.resolve(); }
    }
    vi.stubGlobal('window', { AudioContext: FakeCtx });
    playBoostChime('goal');
    expect(started).toHaveLength(chimeNotes('goal').length);
  });

  it('speakBoost queues an utterance with the language', () => {
    const speak = vi.fn();
    class Utt { lang = ''; rate = 0; volume = 0; constructor(public text: string) {} }
    vi.stubGlobal('window', { speechSynthesis: { speak }, SpeechSynthesisUtterance: Utt });
    speakBoost('fan boosted 5 HBD', 'de-DE');
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toMatchObject({ text: 'fan boosted 5 HBD', lang: 'de-DE' });
    speakBoost('');
    expect(speak).toHaveBeenCalledTimes(1);
  });
});
