import { describe, expect, it } from 'vitest';
import {
  CaptionCueCollector,
  MAX_CAPTION_CHARS,
  MAX_REPLAY_CUES,
  applyCaption,
  baseLang,
  decodeCaption,
  encodeCaption,
  pruneCaptions,
  tidyCaption,
  type CaptionLine,
  type CaptionMessage,
} from '../src/lib/liveCaptions.js';

const msg = (id: number, text: string, final = false, lang = 'en-us'): CaptionMessage => ({ t: 'cap', id, text, final, lang });
const bytes = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

describe('caption wire format', () => {
  it('round-trips a message', () => {
    expect(decodeCaption(encodeCaption(msg(3, 'hello there', true)))).toEqual(msg(3, 'hello there', true));
  });

  it('rejects what is not a caption', () => {
    expect(decodeCaption(bytes('not json'))).toBeNull();
    expect(decodeCaption(bytes('null'))).toBeNull();
    expect(decodeCaption(bytes({ t: 'chat', id: 1, text: 'x' }))).toBeNull();
    expect(decodeCaption(bytes({ t: 'cap', id: 'x', text: 'x' }))).toBeNull();
    expect(decodeCaption(bytes({ t: 'cap', id: 1, text: 5 }))).toBeNull();
  });

  it('cleans text, keeps the tail of a long line and falls back to en for a bad language', () => {
    const d = decodeCaption(bytes({ t: 'cap', id: 1, text: '<b>hi</b>\u0007  there', lang: 'english language' }))!;
    expect(d.text).toBe('b hi /b there');
    expect(d.lang).toBe('en');
    expect(d.final).toBe(false);
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const t = decodeCaption(bytes({ t: 'cap', id: 1, text: long }))!.text;
    expect(t.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    expect(t.endsWith('word199')).toBe(true);
    expect(t.startsWith('word')).toBe(true);
    // One unbroken run is cut hard.
    expect(decodeCaption(bytes({ t: 'cap', id: 1, text: 'x'.repeat(500) }))!.text).toHaveLength(MAX_CAPTION_CHARS);
  });
});

describe('tidyCaption', () => {
  it('capitalises the start and a lone i', () => {
    expect(tidyCaption('i think i am live and i\'m here')).toBe('I think I am live and I\'m here');
    expect(tidyCaption('  hello   world ')).toBe('Hello world');
    expect(tidyCaption('')).toBe('');
    expect(tidyCaption('in it is fine')).toBe('In it is fine');
  });

  it('baseLang takes the primary subtag', () => {
    expect(baseLang('en-us')).toBe('en');
    expect(baseLang('DE')).toBe('de');
    expect(baseLang('')).toBe('en');
  });
});

describe('lines on screen', () => {
  it('updates one utterance in place, then adds the next, keeping two', () => {
    let l: CaptionLine[] = [];
    l = applyCaption(l, msg(0, 'hello'), 1);
    l = applyCaption(l, msg(0, 'hello there'), 2);
    expect(l).toEqual([{ id: 0, text: 'hello there', final: false, at: 2 }]);
    l = applyCaption(l, msg(0, 'hello there friends', true), 3);
    l = applyCaption(l, msg(1, 'second'), 4);
    l = applyCaption(l, msg(2, 'third'), 5);
    expect(l.map((x) => x.id)).toEqual([1, 2]);
  });

  it('ignores a late partial after the final, an older id, and empty new lines', () => {
    let l = applyCaption([], msg(5, 'done', true), 1);
    expect(applyCaption(l, msg(5, 'do'), 2)).toBe(l);
    expect(applyCaption(l, msg(4, 'old'), 2)).toBe(l);
    expect(applyCaption(l, msg(6, ''), 2)).toBe(l);
    // An empty final clears its line (the host stopped mid-sentence).
    l = applyCaption(l, msg(6, 'half'), 3);
    expect(applyCaption(l, msg(6, '', true), 4).map((x) => x.id)).toEqual([5]);
  });

  it('prunes quiet lines; a partial lasts twice as long', () => {
    const l: CaptionLine[] = [{ id: 0, text: 'a', final: true, at: 0 }, { id: 1, text: 'b', final: false, at: 0 }];
    expect(pruneCaptions(l, 5000)).toBe(l);
    expect(pruneCaptions(l, 8000).map((x) => x.id)).toEqual([1]);
    expect(pruneCaptions(l, 15000)).toEqual([]);
  });
});

describe('CaptionCueCollector', () => {
  it('keeps nothing before the recording started', () => {
    const c = new CaptionCueCollector();
    c.add('hello', false, 1000);
    c.add('hello', true, 2000);
    expect(c.size).toBe(0);
  });

  it('times a line from its first partial to its final, from the anchor', () => {
    const c = new CaptionCueCollector();
    c.setAnchor(10_000);
    c.add('Hello', false, 12_000);
    c.add('Hello there', false, 12_500);
    c.add('Hello there', true, 13_000);
    c.add('', false, 13_100); // nothing said yet: does not start a line
    c.add('Bye', true, 20_000);
    expect(c.take()).toEqual([
      { start: 2, end: 3, text: 'Hello there' },
      { start: 10, end: 10.5, text: 'Bye' },
    ]);
    expect(c.size).toBe(0);
  });

  it('clamps speech that began before the recording and drops empty finals', () => {
    const c = new CaptionCueCollector();
    c.setAnchor(10_000);
    c.add('early', false, 9_000);
    c.add('early bird', true, 11_000);
    c.add('   ', true, 12_000);
    expect(c.take()).toEqual([{ start: 0, end: 1, text: 'early bird' }]);
  });

  it('splits a long utterance into timed cues of at most 14 words', () => {
    const c = new CaptionCueCollector();
    c.setAnchor(0);
    const words = Array.from({ length: 28 }, (_, i) => `w${i}`).join(' ');
    c.add(words, false, 0);
    c.add(words, true, 28_000);
    const cues = c.take();
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 0, end: 14 });
    expect(cues[1]).toMatchObject({ start: 14, end: 28 });
    expect(cues[1].text.split(' ')).toHaveLength(14);
  });

  it('stops at the replay limit', () => {
    const c = new CaptionCueCollector();
    c.setAnchor(0);
    for (let i = 0; i < MAX_REPLAY_CUES + 5; i += 1) c.add('a', true, i * 1000);
    expect(c.size).toBe(MAX_REPLAY_CUES);
  });
});
