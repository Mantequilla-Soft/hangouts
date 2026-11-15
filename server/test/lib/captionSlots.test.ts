import { describe, it, expect } from 'vitest';
import { CaptionSlots, CAPTION_LANG_RE } from '../../src/lib/captionSlots.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CaptionSlots', () => {
  it('hands out at most `max` slots and renews a held one even when full', () => {
    const c = clock();
    const slots = new CaptionSlots(2, 90_000, c.now);
    expect(slots.acquire('r1', 'badadib', 'en-us')).toMatchObject({ ok: true, fresh: true });
    expect(slots.acquire('r2', 'fan', 'en-us')).toMatchObject({ ok: true, fresh: true });
    expect(slots.acquire('r3', 'fan2', 'en-us')).toEqual({ ok: false, reason: 'full' });
    // The room's own host renews: not fresh, not refused.
    expect(slots.acquire('r1', 'badadib', 'en-us')).toMatchObject({ ok: true, fresh: false });
    expect(slots.active).toBe(2);
    expect(slots.capacity).toBe(2);
  });

  it('refuses a slot held by another account for the same room', () => {
    const slots = new CaptionSlots(3, 90_000);
    slots.acquire('r1', 'badadib', 'en-us');
    expect(slots.acquire('r1', 'fan', 'en-us')).toEqual({ ok: false, reason: 'taken' });
  });

  it('reports a language change as fresh so the room flag is rewritten', () => {
    const slots = new CaptionSlots(3, 90_000);
    slots.acquire('r1', 'badadib', 'en-us');
    const res = slots.acquire('r1', 'badadib', 'de');
    expect(res).toMatchObject({ ok: true, fresh: true });
    expect(slots.get('r1')?.lang).toBe('de');
  });

  it('lets a slot lapse without renewal and reports it once from sweep()', () => {
    const c = clock();
    const slots = new CaptionSlots(1, 90_000, c.now);
    slots.acquire('r1', 'badadib', 'en-us');
    c.advance(60_000);
    slots.acquire('r1', 'badadib', 'en-us'); // renewed: lives to +150 s
    c.advance(80_000);
    expect(slots.get('r1')).not.toBeNull();
    c.advance(10_000);
    // get() prunes it; sweep() still reports it so the CC flag gets cleared.
    expect(slots.get('r1')).toBeNull();
    expect(slots.active).toBe(0);
    expect(slots.sweep()).toEqual(['r1']);
    expect(slots.sweep()).toEqual([]);
    // The freed slot goes to the next stream.
    expect(slots.acquire('r2', 'fan', 'en-us')).toMatchObject({ ok: true });
  });

  it('a room that takes its slot again is not reported as lapsed', () => {
    const c = clock();
    const slots = new CaptionSlots(1, 1000, c.now);
    slots.acquire('r1', 'badadib', 'en-us');
    c.advance(2000);
    expect(slots.acquire('r1', 'badadib', 'en-us')).toMatchObject({ ok: true, fresh: true });
    expect(slots.sweep()).toEqual([]);
  });

  it('release frees only the holder\'s own slot', () => {
    const slots = new CaptionSlots(1, 90_000);
    slots.acquire('r1', 'badadib', 'en-us');
    expect(slots.release('r1', 'fan')).toBe(false);
    expect(slots.release('r2', 'badadib')).toBe(false);
    expect(slots.release('r1', 'badadib')).toBe(true);
    expect(slots.active).toBe(0);
    expect(slots.sweep()).toEqual([]);
  });

  it('a zero cap hands out nothing', () => {
    const slots = new CaptionSlots(0, 90_000);
    expect(slots.acquire('r1', 'badadib', 'en-us')).toEqual({ ok: false, reason: 'full' });
  });

  it('accepts speech model codes only', () => {
    for (const ok of ['en', 'en-us', 'pt-br', 'fil']) expect(CAPTION_LANG_RE.test(ok)).toBe(true);
    for (const bad of ['', 'EN', 'english', 'en_us', 'e', 'en-']) expect(CAPTION_LANG_RE.test(bad)).toBe(false);
  });
});
