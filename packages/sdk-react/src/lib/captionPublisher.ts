import { tidyCaption, type CaptionCueCollector, type CaptionMessage, type CaptionSource } from './liveCaptions.js';

/**
 * The host side of live captions, without React: holds the caption slot on
 * the hangouts server, runs the integrator's speech-to-text on the mic track
 * while the host is live, and publishes the text for viewers.
 *
 * Load rules it keeps:
 *  - nothing runs unless the host switched captions on (opt-in) AND is live
 *    AND the mic is on: standby talk is never captioned, and a muted mic does
 *    not hold a recognition open on the speech server;
 *  - no speech session without a slot (the server's cap on captioned streams);
 *  - partial text goes out at most every PARTIAL_MS, lossy; finals reliable.
 */

export type StudioCaptionStatus =
  | 'off'          // host has captions switched off
  | 'waiting'      // on, but the stream is not live yet (or paused)
  | 'mic-off'      // live, but the microphone is off or muted
  | 'starting'
  | 'on'
  | 'full'         // every caption slot is in use; retried every minute
  | 'unavailable'  // the server has captions off (or is too old for them)
  | 'error';       // the speech service failed; toggle off and on to retry

export interface CaptionSlotApi {
  start: (lang: string) => Promise<{ ok: true; renewInSec?: number } | { ok: false; reason: 'full' | 'unavailable' }>;
  stop: () => Promise<void>;
}

export interface CaptionWanted {
  enabled: boolean;
  live: boolean;
  /** The host's microphone track, or null while it is off or muted. */
  track: MediaStreamTrack | null;
  lang: string;
}

export const PARTIAL_MS = 400;
export const FULL_RETRY_MS = 60_000;

export class CaptionPublisher {
  private status: StudioCaptionStatus = 'off';
  private want: CaptionWanted = { enabled: false, live: false, track: null, lang: 'en-us' };
  private gen = 0;
  private slot = false;
  private slotLang = '';
  private starting = false;
  /** Refused for good (server off, speech service failed) until the host toggles. */
  private blocked: 'unavailable' | 'error' | null = null;
  private session: { stop: () => void } | null = null;
  private sessionTrack: MediaStreamTrack | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: string | null = null;
  private lastPartialAt = 0;
  private id = 0;
  private shown = false;

  constructor(private readonly deps: {
    api: CaptionSlotApi;
    source: CaptionSource;
    publish: (msg: CaptionMessage, reliable: boolean) => void;
    onStatus: (s: StudioCaptionStatus) => void;
    collector?: CaptionCueCollector;
    now?: () => number;
  }) {}

  private now() { return (this.deps.now ?? Date.now)(); }

  private set(s: StudioCaptionStatus) {
    if (s === this.status) return;
    this.status = s;
    this.deps.onStatus(s);
  }

  get current(): StudioCaptionStatus { return this.status; }

  update(w: CaptionWanted) {
    const prev = this.want;
    this.want = { ...w };
    // Switching off (or to another language) is how the host retries after a failure.
    if (!w.enabled || w.lang !== prev.lang) this.blocked = null;
    if (!w.enabled) { this.teardown(); this.set('off'); return; }
    if (!w.live) { this.teardown(); this.set('waiting'); return; }
    if (!w.track) { this.teardown(); this.set('mic-off'); return; }
    if (this.slot && this.slotLang !== w.lang) this.teardown();
    if (this.slot) {
      // Same slot, new mic (device switch): restart only the speech session.
      if (this.sessionTrack !== w.track) this.openSession();
      return;
    }
    if (this.blocked) { this.set(this.blocked); return; }
    if (this.starting || this.retryTimer) return;
    void this.begin();
  }

  dispose() {
    this.teardown();
    this.set('off');
  }

  private async begin() {
    const g = ++this.gen;
    this.starting = true;
    this.set('starting');
    const lang = this.want.lang;
    let res: Awaited<ReturnType<CaptionSlotApi['start']>>;
    try { res = await this.deps.api.start(lang); } catch { res = { ok: false, reason: 'unavailable' }; }
    this.starting = false;
    if (g !== this.gen) {
      // Switched off while asking: give back what we were just handed.
      if (res.ok) void this.deps.api.stop().catch(() => { /* lapses on its own */ });
      return;
    }
    if (!res.ok) { this.refused(res.reason); return; }
    this.slot = true;
    this.slotLang = lang;
    const every = Math.max(10, res.renewInSec ?? 30) * 1000;
    this.renewTimer = setInterval(() => { void this.renew(g); }, every);
    this.openSession();
  }

  private async renew(g: number) {
    let res: Awaited<ReturnType<CaptionSlotApi['start']>>;
    try { res = await this.deps.api.start(this.slotLang); } catch { return; /* a blip: the slot outlives one missed renewal */ }
    if (g !== this.gen || res.ok) return;
    this.teardown();
    this.refused(res.reason);
  }

  private refused(reason: 'full' | 'unavailable') {
    if (reason === 'full') {
      this.set('full');
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.update(this.want); }, FULL_RETRY_MS);
    } else {
      this.blocked = 'unavailable';
      this.set('unavailable');
    }
  }

  private openSession() {
    this.closeSession();
    const track = this.want.track;
    if (!track) return;
    const g = this.gen;
    this.sessionTrack = track;
    try {
      this.session = this.deps.source(track, {
        lang: this.slotLang,
        onText: (text, final) => { if (g === this.gen) this.onText(text, final); },
        onStatus: (s) => {
          if (g !== this.gen || s !== 'error') return;
          this.teardown();
          this.blocked = 'error';
          this.set('error');
        },
      });
      this.set('on');
    } catch {
      this.teardown();
      this.blocked = 'error';
      this.set('error');
    }
  }

  private closeSession() {
    try { this.session?.stop(); } catch { /* already closed */ }
    this.session = null;
    this.sessionTrack = null;
    this.clearPartial();
    // Take the half-spoken line off the viewers' screens.
    if (this.shown) this.send('', true);
  }

  private onText(raw: string, final: boolean) {
    const text = tidyCaption(raw);
    this.deps.collector?.add(text, final, this.now());
    if (final) {
      this.clearPartial();
      if (text || this.shown) this.send(text, true);
      return;
    }
    if (!text) return;
    this.pending = text;
    const wait = this.lastPartialAt + PARTIAL_MS - this.now();
    if (wait <= 0) this.flushPartial();
    else if (!this.partialTimer) this.partialTimer = setTimeout(() => { this.partialTimer = null; this.flushPartial(); }, wait);
  }

  private flushPartial() {
    if (this.pending === null) return;
    const text = this.pending;
    this.pending = null;
    this.lastPartialAt = this.now();
    this.send(text, false);
  }

  private clearPartial() {
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = null;
    this.pending = null;
  }

  private send(text: string, final: boolean) {
    try {
      this.deps.publish({ t: 'cap', id: this.id, text, final, lang: this.slotLang || this.want.lang }, final);
    } catch { /* not connected: the next line goes out */ }
    if (final) { this.id += 1; this.shown = false; } else this.shown = true;
  }

  private teardown() {
    this.gen += 1;
    this.starting = false;
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.renewTimer = null;
    this.retryTimer = null;
    this.closeSession();
    if (this.slot) {
      this.slot = false;
      void this.deps.api.stop().catch(() => { /* lapses on its own */ });
    }
  }
}
