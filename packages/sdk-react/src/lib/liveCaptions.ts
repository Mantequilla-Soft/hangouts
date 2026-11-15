/**
 * Live captions (H11): the wire format and the small pure pieces both sides use.
 *
 * The HOST's browser turns its own microphone into text (the integrator's
 * speech-to-text `CaptionSource`) and publishes each line on the LiveKit data
 * channel under CAPTIONS_TOPIC. Viewers render the lines as an overlay (never
 * burned into the video) and may translate them on their own device. Nothing
 * here touches the server beyond the caption slot (see useStudioCaptions).
 *
 * One utterance = one `id`. While it is being spoken the host sends `partial`
 * updates of the whole utterance (throttled, lossy); when the speaker pauses it
 * sends the `final` text once (reliable) and the next utterance gets a new id.
 */

export const CAPTIONS_TOPIC = 'captions';
/** Longest caption text we send or accept (one utterance, tail kept). */
export const MAX_CAPTION_CHARS = 400;

export interface CaptionMessage {
  t: 'cap';
  /** Utterance number: partials and the final of one utterance share it. */
  id: number;
  text: string;
  final: boolean;
  /** The speech model's language code, e.g. `en-us`. */
  lang: string;
}

/** Turn on the host side: the integrator's speech-to-text for one mic track. */
export type CaptionSource = (
  track: MediaStreamTrack,
  opts: {
    lang: string;
    /** Called with the whole current utterance; `final` once the speaker paused. */
    onText: (text: string, final: boolean) => void;
    /** 'error' = gave up (the studio releases its slot and says so). */
    onStatus?: (status: 'connecting' | 'connected' | 'error', message?: string) => void;
  },
) => { stop: () => void };

export interface CaptionLanguage {
  /** Speech model code, as the speech server names it (`en-us`). */
  code: string;
  /** What the host sees in the picker. */
  label: string;
}

/** One subtitle line for the replay, in seconds from the start of the recording. */
export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeCaption(msg: CaptionMessage): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

/** A caption message from the data channel, or null when it is not one. */
export function decodeCaption(payload: Uint8Array): CaptionMessage | null {
  let raw: unknown;
  try { raw = JSON.parse(dec.decode(payload)); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.t !== 'cap' || typeof m.text !== 'string' || typeof m.id !== 'number' || !Number.isFinite(m.id)) return null;
  const lang = typeof m.lang === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(m.lang) ? m.lang.toLowerCase() : 'en';
  return { t: 'cap', id: m.id, text: tailOf(m.text), final: m.final === true, lang };
}

function tailOf(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_CAPTION_CHARS) return clean;
  const cut = clean.slice(clean.length - MAX_CAPTION_CHARS);
  const sp = cut.indexOf(' ');
  return (sp >= 0 && sp < 40 ? cut.slice(sp + 1) : cut).trim();
}

/**
 * The speech server's text is lower case without punctuation. Make it read like
 * a caption: first letter up, a lone "i" as "I", and the tail kept when long.
 */
export function tidyCaption(text: string): string {
  let t = tailOf(text);
  if (!t) return '';
  t = t.replace(/(^|\s)i(?=\s|$|')/g, '$1I');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The primary language subtag: `en-us` -> `en` (what translators and subtitles use). */
export function baseLang(code: string): string {
  return String(code || 'en').toLowerCase().split('-')[0] || 'en';
}

// ── viewer: the lines on screen ─────────────────────────────────────────────

export interface CaptionLine {
  id: number;
  text: string;
  final: boolean;
  /** When it last changed (ms). */
  at: number;
}

/** How long a finished line stays up after its last update. */
export const CAPTION_LINE_MS = 7000;
/** Lines on screen at once (the current one and the one before). */
export const CAPTION_MAX_LINES = 2;

/** Fold one message into the lines on screen. Old ids out of order are ignored. */
export function applyCaption(lines: CaptionLine[], msg: CaptionMessage, now: number): CaptionLine[] {
  const idx = lines.findIndex((l) => l.id === msg.id);
  if (idx >= 0) {
    const cur = lines[idx];
    // A late partial after the final would undo the final text.
    if (cur.final && !msg.final) return lines;
    if (!msg.text) return lines.filter((l) => l.id !== msg.id);
    const next = lines.slice();
    next[idx] = { id: msg.id, text: msg.text, final: msg.final, at: now };
    return next;
  }
  if (!msg.text) return lines;
  const newest = lines.length ? lines[lines.length - 1].id : -Infinity;
  if (msg.id < newest) return lines;
  return [...lines, { id: msg.id, text: msg.text, final: msg.final, at: now }].slice(-CAPTION_MAX_LINES);
}

/** Drop lines nobody has updated for a while (the speaker went quiet). */
export function pruneCaptions(lines: CaptionLine[], now: number, ttl = CAPTION_LINE_MS): CaptionLine[] {
  const kept = lines.filter((l) => now - l.at < (l.final ? ttl : ttl * 2));
  return kept.length === lines.length ? lines : kept;
}

// ── host: subtitles for the replay ──────────────────────────────────────────

/** Most lines kept for one stream's replay subtitles (the 3Speak subtitle limit). */
export const MAX_REPLAY_CUES = 6000;
const WORDS_PER_CUE = 14;

/**
 * Collects finished lines with their times, for subtitles on the replay. Times
 * are from `anchor` (when the recording started); until there is one, nothing
 * is kept, because there is no recording to put them on. A long utterance is
 * split into cues of at most WORDS_PER_CUE words, timed by word share.
 */
export class CaptionCueCollector {
  private anchor: number | null = null;
  private startedAt: number | null = null;
  private list: CaptionCue[] = [];

  setAnchor(ms: number | null) {
    this.anchor = ms;
  }

  /** Feed every text update (partials mark when the utterance began). */
  add(text: string, final: boolean, now: number) {
    if (this.startedAt === null && text) this.startedAt = now;
    if (!final) return;
    const began = this.startedAt ?? now;
    this.startedAt = null;
    if (this.anchor === null || !text.trim()) return;
    const start = Math.max(0, (began - this.anchor) / 1000);
    const end = Math.max(start + 0.5, (now - this.anchor) / 1000);
    if (end <= 0) return;
    const words = text.trim().split(/\s+/);
    const span = end - start;
    for (let i = 0; i < words.length && this.list.length < MAX_REPLAY_CUES; i += WORDS_PER_CUE) {
      const part = words.slice(i, i + WORDS_PER_CUE);
      const s = start + (span * i) / words.length;
      const e = start + (span * Math.min(words.length, i + WORDS_PER_CUE)) / words.length;
      this.list.push({ start: round3(s), end: round3(e), text: part.join(' ') });
    }
  }

  get size(): number {
    return this.list.length;
  }

  /** The cues so far, and start over. */
  take(): CaptionCue[] {
    const out = this.list;
    this.list = [];
    this.startedAt = null;
    return out;
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
