/**
 * Validation for the studio's text overlay templates (H17): lower third,
 * ticker, countdown, the "be right back" slate and scene fades. The studio
 * keeps its own copy of these rules (sdk-react lib/studioOverlays.ts); this
 * one is the authority for what gets stored.
 *
 * Everything is cleaned rather than rejected field by field: text is trimmed
 * and capped, unknown keys are dropped, numbers are clamped, so an older or
 * newer studio can always save. Only a body that is not a list of templates at
 * all, or too many of them, is refused.
 */

export const MAX_OVERLAY_TEMPLATES = 12;
export const BRB_MUSIC = ['off', 'calm', 'lofi', 'bright', 'file'] as const;
export const TICKER_SPEEDS = ['slow', 'normal', 'fast'] as const;

export type BrbMusic = typeof BRB_MUSIC[number];
export type TickerSpeed = typeof TICKER_SPEEDS[number];

export interface OverlayConfig {
  lowerThird: { name: string; title: string };
  ticker: { text: string; speed: TickerSpeed };
  countdown: { label: string; minutes: number };
  brb: { message: string; music: BrbMusic; volume: number };
  fade: boolean;
}

export interface OverlayTemplate {
  id: string;
  name: string;
  config: OverlayConfig;
}

const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Trim, drop control characters (a newline would break the one-line canvas
 *  text), collapse runs of spaces and cap the length. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : dflt;
}

export function cleanOverlayConfig(raw: unknown): OverlayConfig {
  const r = obj(raw);
  const lt = obj(r.lowerThird);
  const tk = obj(r.ticker);
  const cd = obj(r.countdown);
  const brb = obj(r.brb);
  return {
    lowerThird: { name: cleanText(lt.name, 60), title: cleanText(lt.title, 80) },
    ticker: { text: cleanText(tk.text, 300), speed: pick(tk.speed, TICKER_SPEEDS, 'normal') },
    countdown: {
      label: cleanText(cd.label, 40),
      minutes: Math.round(clamp(cd.minutes, 1, 180, 5)),
    },
    brb: {
      message: cleanText(brb.message, 80),
      music: pick(brb.music, BRB_MUSIC, 'off'),
      volume: Math.round(clamp(brb.volume, 0, 1, 0.5) * 100) / 100,
    },
    fade: r.fade !== false,
  };
}

/** Validate a whole template list. A string is the reason it was refused. */
export function cleanOverlayTemplates(raw: unknown): OverlayTemplate[] | string {
  if (!Array.isArray(raw)) return 'templates must be a list';
  if (raw.length > MAX_OVERLAY_TEMPLATES) return `at most ${MAX_OVERLAY_TEMPLATES} templates`;
  const out: OverlayTemplate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const t = obj(item);
    const id = typeof t.id === 'string' ? t.id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) : '';
    const name = cleanText(t.name, 40);
    if (!id || !name) return 'every template needs an id and a name';
    if (seen.has(id)) return 'template ids must be unique';
    seen.add(id);
    out.push({ id, name, config: cleanOverlayConfig(t.config) });
  }
  return out;
}

/** The phone crop the studio reports (H19), kept in the room metadata. */
export interface VerticalCrop {
  on: boolean;
  /** Centre of the 9:16 crop, as a fraction of the landscape frame's width. */
  x: number;
  /** Width of the crop, as a fraction of the frame's width (0.316 for 16:9). */
  w: number;
  /** What the crop follows: the host's own drag, the camera or the source. */
  follow: 'manual' | 'camera' | 'source';
  /** The studio publishes the vertical track itself (false: viewers crop). */
  track: boolean;
}

export function cleanVerticalCrop(raw: unknown): VerticalCrop {
  const r = obj(raw);
  const w = Math.round(clamp(r.w, 0.05, 1, 0.316) * 1000) / 1000;
  // The centre can't put the crop over the edge.
  const x = Math.round(clamp(r.x, w / 2, 1 - w / 2, 0.5) * 1000) / 1000;
  return {
    on: r.on === true,
    x,
    w,
    follow: pick(r.follow, ['manual', 'camera', 'source'] as const, 'manual'),
    track: r.track === true,
  };
}
