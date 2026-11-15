import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionPublisher, FULL_RETRY_MS, PARTIAL_MS, type CaptionSlotApi, type StudioCaptionStatus } from '../src/lib/captionPublisher.js';
import { CaptionCueCollector, type CaptionMessage, type CaptionSource } from '../src/lib/liveCaptions.js';

const track = (id: string) => ({ id }) as unknown as MediaStreamTrack;

function harness(startResults: Array<Awaited<ReturnType<CaptionSlotApi['start']>> | Error> = []) {
  const calls: string[] = [];
  const api: CaptionSlotApi = {
    start: vi.fn(async (lang: string) => {
      calls.push(`start:${lang}`);
      const r = startResults.length ? startResults.shift()! : { ok: true as const, renewInSec: 30 };
      if (r instanceof Error) throw r;
      return r;
    }),
    stop: vi.fn(async () => { calls.push('stop'); }),
  };
  const sessions: Array<{ track: MediaStreamTrack; lang: string; onText: (t: string, f: boolean) => void; onStatus?: (s: 'connecting' | 'connected' | 'error') => void; stop: ReturnType<typeof vi.fn> }> = [];
  const source: CaptionSource = (t, o) => {
    const s = { track: t, lang: o.lang, onText: o.onText, onStatus: o.onStatus, stop: vi.fn() };
    sessions.push(s);
    return s;
  };
  const sent: Array<{ msg: CaptionMessage; reliable: boolean }> = [];
  const statuses: StudioCaptionStatus[] = [];
  const collector = new CaptionCueCollector();
  const pub = new CaptionPublisher({
    api, source, collector,
    publish: (msg, reliable) => sent.push({ msg, reliable }),
    onStatus: (s) => statuses.push(s),
    now: () => Date.now(),
  });
  return { pub, api, calls, sessions, sent, statuses, collector };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const live = (t: MediaStreamTrack | null = track('mic'), lang = 'en-us') => ({ enabled: true, live: true, track: t, lang });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('CaptionPublisher', () => {
  it('does nothing until on AND live AND the mic is on', async () => {
    const h = harness();
    h.pub.update({ enabled: false, live: true, track: track('mic'), lang: 'en-us' });
    h.pub.update({ enabled: true, live: false, track: track('mic'), lang: 'en-us' });
    h.pub.update({ enabled: true, live: true, track: null, lang: 'en-us' });
    await flush();
    expect(h.api.start).not.toHaveBeenCalled();
    expect(h.sessions).toHaveLength(0);
    expect(h.statuses).toEqual(['waiting', 'mic-off']);
  });

  it('takes a slot, then opens the speech session, and renews every renewInSec', async () => {
    const h = harness();
    h.pub.update(live());
    expect(h.pub.current).toBe('starting');
    await flush();
    expect(h.calls).toEqual(['start:en-us']);
    expect(h.sessions).toHaveLength(1);
    expect(h.pub.current).toBe('on');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toEqual(['start:en-us', 'start:en-us']);
    // A renewal that fails on the network keeps going (the slot outlives a blip).
    (h.api.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.pub.current).toBe('on');
  });

  it('publishes partials throttled and lossy, finals at once and reliable, one id per utterance', async () => {
    const h = harness();
    h.pub.update(live());
    await flush();
    const s = h.sessions[0];
    s.onText('hello', false);
    s.onText('hello i', false);
    s.onText('hello i am', false);
    expect(h.sent).toEqual([{ msg: { t: 'cap', id: 0, text: 'Hello', final: false, lang: 'en-us' }, reliable: false }]);
    await vi.advanceTimersByTimeAsync(PARTIAL_MS);
    expect(h.sent[1].msg.text).toBe('Hello I am');
    s.onText('hello i am live', true);
    expect(h.sent[2]).toEqual({ msg: { t: 'cap', id: 0, text: 'Hello I am live', final: true, lang: 'en-us' }, reliable: true });
    s.onText('next', false);
    // Throttle window still open from the last partial: goes out on the timer.
    await vi.advanceTimersByTimeAsync(PARTIAL_MS);
    expect(h.sent[3].msg).toMatchObject({ id: 1, text: 'Next', final: false });
    s.onText('', false);
    expect(h.sent).toHaveLength(4);
  });

  it('a final cancels a pending partial and an empty final clears a shown line', async () => {
    const h = harness();
    h.pub.update(live());
    await flush();
    const s = h.sessions[0];
    s.onText('one', false);
    s.onText('one two', false); // pending
    s.onText('', true);
    await vi.advanceTimersByTimeAsync(PARTIAL_MS * 2);
    expect(h.sent.map((x) => [x.msg.text, x.msg.final])).toEqual([['One', false], ['', true]]);
    // Nothing shown now: another empty final sends nothing.
    s.onText('', true);
    expect(h.sent).toHaveLength(2);
  });

  it('collects finals for the replay once the recording anchor is set', async () => {
    const h = harness();
    h.collector.setAnchor(Date.now());
    h.pub.update(live());
    await flush();
    vi.setSystemTime(Date.now() + 2000);
    h.sessions[0].onText('good evening', false);
    vi.setSystemTime(Date.now() + 1000);
    h.sessions[0].onText('good evening', true);
    expect(h.collector.take()).toEqual([{ start: 2, end: 3, text: 'Good evening' }]);
  });

  it('going off air stops the session, clears the line and gives the slot back', async () => {
    const h = harness();
    h.pub.update(live());
    await flush();
    h.sessions[0].onText('half a sente', false);
    h.pub.update({ ...live(), live: false });
    expect(h.sessions[0].stop).toHaveBeenCalled();
    expect(h.sent.at(-1)!.msg).toMatchObject({ text: '', final: true });
    expect(h.calls).toEqual(['start:en-us', 'stop']);
    expect(h.pub.current).toBe('waiting');
    // Text from the closed session is ignored.
    h.sessions[0].onText('late', true);
    expect(h.sent.at(-1)!.msg.text).toBe('');
  });

  it('a new mic track restarts only the speech session; a new language takes a new slot', async () => {
    const h = harness();
    const b = track('b');
    h.pub.update(live(track('a')));
    await flush();
    h.pub.update(live(b));
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0].stop).toHaveBeenCalled();
    expect(h.calls).toEqual(['start:en-us']);
    h.pub.update(live(b));
    expect(h.sessions).toHaveLength(2);
    h.pub.update(live(b, 'de'));
    await flush();
    expect(h.calls).toEqual(['start:en-us', 'stop', 'start:de']);
    expect(h.sessions[2].lang).toBe('de');
  });

  it('when every slot is busy it says so and retries a minute later', async () => {
    const h = harness([{ ok: false, reason: 'full' }]);
    h.pub.update(live());
    await flush();
    expect(h.pub.current).toBe('full');
    h.pub.update(live()); // re-render: no hammering
    await flush();
    expect(h.api.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FULL_RETRY_MS);
    await flush();
    expect(h.api.start).toHaveBeenCalledTimes(2);
    expect(h.pub.current).toBe('on');
  });

  it('a renewal refused because the slot is gone and the cap is full stops captioning', async () => {
    const h = harness([{ ok: true, renewInSec: 30 }, { ok: false, reason: 'full' }]);
    h.pub.update(live());
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.pub.current).toBe('full');
    expect(h.sessions[0].stop).toHaveBeenCalled();
  });

  it('a server without captions (or unreachable) blocks until the host toggles', async () => {
    const h = harness([{ ok: false, reason: 'unavailable' }, new Error('down')]);
    h.pub.update(live());
    await flush();
    expect(h.pub.current).toBe('unavailable');
    h.pub.update({ ...live(), track: null });
    h.pub.update(live());
    expect(h.pub.current).toBe('unavailable');
    expect(h.api.start).toHaveBeenCalledTimes(1);
    h.pub.update({ ...live(), enabled: false });
    h.pub.update(live());
    await flush();
    expect(h.pub.current).toBe('unavailable');
    expect(h.api.start).toHaveBeenCalledTimes(2);
  });

  it('a speech service failure releases the slot and shows an error', async () => {
    const h = harness();
    h.pub.update(live());
    await flush();
    h.sessions[0].onStatus?.('connected');
    expect(h.pub.current).toBe('on');
    h.sessions[0].onStatus?.('error');
    expect(h.pub.current).toBe('error');
    expect(h.calls).toEqual(['start:en-us', 'stop']);
  });

  it('a source that throws is an error too', async () => {
    const h = harness();
    const bad = new CaptionPublisher({
      api: h.api,
      source: () => { throw new Error('no audio'); },
      publish: () => {},
      onStatus: () => {},
    });
    bad.update(live());
    await flush();
    expect(bad.current).toBe('error');
    expect(h.api.stop).toHaveBeenCalled();
  });

  it('switched off while the slot request is in flight: the slot is handed straight back', async () => {
    const h = harness();
    h.pub.update(live());
    h.pub.update({ ...live(), enabled: false });
    await flush();
    expect(h.calls).toEqual(['start:en-us', 'stop']);
    expect(h.sessions).toHaveLength(0);
    expect(h.pub.current).toBe('off');
  });

  it('a publish that throws does not break captioning', async () => {
    const h = harness();
    const pub = new CaptionPublisher({
      api: h.api,
      source: (t, o) => { setTimeout(() => o.onText('hi', true), 0); return { stop: () => {} }; },
      publish: () => { throw new Error('not connected'); },
      onStatus: () => {},
    });
    pub.update(live());
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(pub.current).toBe('on');
    pub.dispose();
    expect(pub.current).toBe('off');
  });
});
