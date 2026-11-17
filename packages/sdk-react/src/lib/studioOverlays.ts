/**
 * Text overlays for the browser studio (H17): a name + title lower third, a
 * scrolling ticker, a countdown, fades between scenes, and the settings for
 * the "be right back" slate (its message and music).
 *
 * Everything here is DRAWN INTO THE COMPOSED CANVAS, so viewers, the
 * recording, DVR clips and the vertical phone version all carry it. The studio
 * keeps an `OverlayLayerList`, a z-ordered list of layers its compositor draws
 * on every output after the scene (and before boosts and the watermark). The
 * text overlays below are three such layers; anything else that wants to be
 * burned into the stream (a battle score bar, captions) can add its own layer
 * the same way instead of editing the draw loop.
 *
 * The saved part of the setup (`OverlayConfig`) mirrors the server's
 * lib/studioOverlayInput.ts, which is the authority for stored templates.
 */

export const MAX_OVERLAY_TEMPLATES = 12;
export const BRB_MUSIC = ['off', 'calm', 'lofi', 'bright', 'file'] as const;
export const TICKER_SPEEDS = ['slow', 'normal', 'fast'] as const;
export const TICKER_POSITIONS = ['bottom', 'top'] as const;
export type BrbMusic = typeof BRB_MUSIC[number];
export type TickerSpeed = typeof TICKER_SPEEDS[number];
export type TickerPosition = typeof TICKER_POSITIONS[number];

export interface OverlayConfig {
  lowerThird: { name: string; title: string };
  ticker: { text: string; speed: TickerSpeed; position: TickerPosition };
  countdown: { label: string; minutes: number };
  brb: { message: string; music: BrbMusic; volume: number };
  /** Fade between scenes, and in and out of the slates. */
  fade: boolean;
}

export interface OverlayTemplate { id: string; name: string; config: OverlayConfig }

/** What is on screen right now. Not saved: a reload starts with it all off. */
export interface OverlayLive {
  lowerThirdOn: boolean;
  /** performance.now() when the lower third last came on or went off. */
  lowerThirdAt: number;
  /** performance.now() after which the lower third hides itself, or null. */
  lowerThirdUntil: number | null;
  tickerOn: boolean;
  tickerAt: number;
  /** Date.now() the countdown reaches zero, or null when none runs. */
  countdownEndsAt: number | null;
}

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  lowerThird: { name: '', title: '' },
  ticker: { text: '', speed: 'normal', position: 'bottom' },
  countdown: { label: '', minutes: 5 },
  brb: { message: '', music: 'off', volume: 0.5 },
  fade: true,
};

export const OFF_LIVE: OverlayLive = {
  lowerThirdOn: false, lowerThirdAt: 0, lowerThirdUntil: null, tickerOn: false, tickerAt: 0, countdownEndsAt: null,
};

const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Like cleanText, but keeps the spaces the host is typing (a trailing space
 *  must survive the keystroke that adds it). Used while editing. */
export function editText(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : dflt);

export function cleanOverlayConfig(raw: unknown): OverlayConfig {
  const r = obj(raw);
  const lt = obj(r.lowerThird);
  const tk = obj(r.ticker);
  const cd = obj(r.countdown);
  const brb = obj(r.brb);
  return {
    lowerThird: { name: cleanText(lt.name, 60), title: cleanText(lt.title, 80) },
    ticker: {
      text: cleanText(tk.text, 300),
      speed: pick(tk.speed, TICKER_SPEEDS, 'normal'),
      position: pick(tk.position, TICKER_POSITIONS, 'bottom'),
    },
    countdown: { label: cleanText(cd.label, 40), minutes: Math.round(clamp(cd.minutes, 1, 180, 5)) },
    brb: {
      message: cleanText(brb.message, 80),
      music: pick(brb.music, BRB_MUSIC, 'off'),
      volume: Math.round(clamp(brb.volume, 0, 1, 0.5) * 100) / 100,
    },
    fade: r.fade !== false,
  };
}

export function cleanOverlayTemplates(raw: unknown): OverlayTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: OverlayTemplate[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_OVERLAY_TEMPLATES)) {
    const t = obj(item);
    const id = typeof t.id === 'string' ? t.id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) : '';
    const name = cleanText(t.name, 40);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, config: cleanOverlayConfig(t.config) });
  }
  return out;
}

/** A short id for a new template, unique among `existing`. */
export function newTemplateId(name: string, existing: readonly OverlayTemplate[]): string {
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template').slice(0, 18);
  const ids = new Set(existing.map((t) => t.id));
  if (!ids.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/** "4:05", "1:02:09"; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---- layers -----------------------------------------------------------------

export type OutputShape = 'landscape' | 'vertical' | 'portrait';
export type StudioState = 'standby' | 'live' | 'paused';

/** What a layer knows about the frame it draws into. */
export interface FrameInfo {
  state: StudioState;
  /** landscape program, the 9:16 phone version, or the phone studio's own
   *  portrait program. */
  shape: OutputShape;
  /** performance.now() and Date.now() of this frame. */
  now: number;
  wall: number;
  /** Theme accent (resolved to a plain colour), '' for the default. */
  accent: string;
}

export interface OverlayLayer {
  id: string;
  /** Higher draws later (on top). Text overlays use 10-30. */
  z: number;
  /** Draw into ctx (w x h). Return false when nothing was drawn. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, info: FrameInfo): boolean | void;
}

/**
 * The z-ordered list of layers the compositor draws over the scene on every
 * output. Add returns a remover. A layer that throws is skipped for that frame
 * rather than taking the broadcast down.
 */
export class OverlayLayerList {
  private layers: OverlayLayer[] = [];

  add(layer: OverlayLayer): () => void {
    this.layers = [...this.layers.filter((l) => l.id !== layer.id), layer].sort((a, b) => a.z - b.z);
    return () => this.remove(layer.id);
  }

  remove(id: string): void {
    this.layers = this.layers.filter((l) => l.id !== id);
  }

  get size(): number { return this.layers.length; }

  /** True when at least one layer drew something. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, info: FrameInfo): boolean {
    let drew = false;
    for (const l of this.layers) {
      try {
        ctx.save();
        if (l.draw(ctx, w, h, info) !== false) drew = true;
      } catch { /* a broken layer must not stop the stream */ } finally {
        ctx.restore();
      }
    }
    return drew;
  }
}

// ---- drawing ----------------------------------------------------------------

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const PANEL = 'rgba(13, 13, 18, 0.86)';
const DEFAULT_ACCENT = '#e31337';

/** One unit of scale: 1 on a 720p landscape frame and on a 720p-tall 9:16
 *  frame, so text keeps the same size relative to what a viewer sees. */
export function overlayScale(w: number, h: number): number {
  return Math.max(0.3, Math.min(h / 720, w / 405));
}

/** `text`, cut with an ellipsis to fit maxW. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Height of the ticker band (so the lower third can sit above it). */
export function tickerHeight(w: number, h: number): number {
  return Math.round(40 * overlayScale(w, h));
}

const TICKER_PX_PER_S: Record<TickerSpeed, number> = { slow: 60, normal: 110, fast: 170 };

/** The scrolling ticker band along the bottom or the top. `elapsedMs` since it
 *  came on. The accent edge faces the picture. */
export function drawTicker(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  text: string, speed: TickerSpeed, elapsedMs: number, accent = '', position: TickerPosition = 'bottom',
): void {
  if (!text) return;
  const k = overlayScale(w, h);
  const bandH = tickerHeight(w, h);
  const y = position === 'top' ? 0 : h - bandH;
  const edgeH = Math.max(2, Math.round(3 * k));
  const appear = easeOut(Math.min(1, elapsedMs / 350));
  ctx.globalAlpha = appear;
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, y, w, bandH);
  ctx.fillStyle = accent || DEFAULT_ACCENT;
  ctx.fillRect(0, position === 'top' ? bandH - edgeH : y, w, edgeH);
  ctx.font = `600 ${Math.round(19 * k)}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  const item = `${text}     •     `;
  const itemW = Math.max(1, ctx.measureText(item).width);
  const pxPerMs = (TICKER_PX_PER_S[speed] * k) / 1000;
  // Enters from the right edge, then loops seamlessly.
  const travelled = elapsedMs * pxPerMs;
  const start = travelled < w ? w - travelled : -((travelled - w) % itemW);
  ctx.beginPath();
  ctx.rect(0, y, w, bandH);
  ctx.clip();
  for (let x = start; x < w; x += itemW) ctx.fillText(item, x, y + bandH / 2 + k);
}

/**
 * The lower third: the name big, the title under it, on a dark panel with an
 * accent edge, bottom left. `progress` 0..1 is the slide-in (1 = fully in);
 * `bottomInset` keeps it above the ticker.
 */
export function drawLowerThird(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  name: string, title: string, progress: number, accent = '', bottomInset = 0,
): void {
  if ((!name && !title) || progress <= 0) return;
  const k = overlayScale(w, h);
  const margin = Math.round(28 * k);
  const padX = Math.round(18 * k);
  const padY = Math.round(12 * k);
  const edge = Math.max(3, Math.round(6 * k));
  const namePx = Math.round(30 * k);
  const titlePx = Math.round(20 * k);
  const maxText = w - margin * 2 - padX * 2 - edge;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 ${namePx}px ${FONT}`;
  const nameLine = name ? fitText(ctx, name, maxText) : '';
  const nameW = nameLine ? ctx.measureText(nameLine).width : 0;
  ctx.font = `500 ${titlePx}px ${FONT}`;
  const titleLine = title ? fitText(ctx, title, maxText) : '';
  const titleW = titleLine ? ctx.measureText(titleLine).width : 0;
  const boxW = edge + padX * 2 + Math.max(nameW, titleW);
  const gap = nameLine && titleLine ? Math.round(6 * k) : 0;
  const boxH = padY * 2 + (nameLine ? namePx : 0) + gap + (titleLine ? titlePx : 0);
  const t = easeOut(Math.min(1, Math.max(0, progress)));
  const x = margin - (1 - t) * 40 * k;
  const y = h - bottomInset - margin - boxH;
  ctx.globalAlpha = t;
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = accent || DEFAULT_ACCENT;
  ctx.fillRect(x, y, edge, boxH);
  let ty = y + padY;
  if (nameLine) {
    ctx.font = `800 ${namePx}px ${FONT}`;
    ctx.fillStyle = '#fff';
    ty += namePx;
    ctx.fillText(nameLine, x + edge + padX, ty - namePx * 0.12);
  }
  if (titleLine) {
    ctx.font = `500 ${titlePx}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ty += gap + titlePx;
    ctx.fillText(titleLine, x + edge + padX, ty - titlePx * 0.12);
  }
}

/**
 * The countdown. On a slate (Starting soon / Be right back) it is big, under
 * the headline; over the live picture it is a compact chip, top right.
 */
export function drawCountdown(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  label: string, remainingMs: number, onSlate: boolean, accent = '', topInset = 0,
): void {
  const k = overlayScale(w, h);
  const time = formatCountdown(remainingMs);
  ctx.textBaseline = 'middle';
  if (onSlate) {
    ctx.textAlign = 'center';
    const cy = h / 2 + 120 * k;
    if (label) {
      ctx.font = `600 ${Math.round(22 * k)}px ${FONT}`;
      ctx.fillStyle = '#a3a3b5';
      ctx.fillText(fitText(ctx, label, w * 0.86), w / 2, cy - 34 * k);
    }
    ctx.font = `800 ${Math.round(54 * k)}px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(time, w / 2, cy + 12 * k);
    return;
  }
  const padX = Math.round(14 * k);
  const chipH = Math.round(40 * k);
  const margin = Math.round(20 * k);
  ctx.font = `800 ${Math.round(22 * k)}px ${FONT}`;
  const timeW = ctx.measureText(time).width;
  ctx.font = `600 ${Math.round(16 * k)}px ${FONT}`;
  const labelLine = label ? fitText(ctx, label, w * 0.4) : '';
  const labelW = labelLine ? ctx.measureText(labelLine).width + 10 * k : 0;
  const chipW = padX * 2 + labelW + timeW;
  const x = w - margin - chipW;
  const y = topInset + margin;
  ctx.fillStyle = PANEL;
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, chipW, chipH, chipH / 2); ctx.fill(); }
  else ctx.fillRect(x, y, chipW, chipH);
  ctx.textAlign = 'left';
  if (labelLine) {
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillText(labelLine, x + padX, y + chipH / 2);
  }
  ctx.font = `800 ${Math.round(22 * k)}px ${FONT}`;
  ctx.fillStyle = remainingMs <= 10_000 ? (accent || DEFAULT_ACCENT) : '#fff';
  ctx.fillText(time, x + padX + labelW, y + chipH / 2 + k);
}

/** How long the countdown stays at 0:00 before it clears itself. */
export const COUNTDOWN_LINGER_MS = 4000;
/** Lower-third slide in/out time. */
export const LOWER_THIRD_ANIM_MS = 450;

/**
 * The three text overlays as layers. They read the config and the live state
 * through getters, so the compositor (bound once) always sees current values.
 */
export function createTextOverlayLayers(
  getConfig: () => OverlayConfig,
  getLive: () => OverlayLive,
): OverlayLayer[] {
  const ticker: OverlayLayer = {
    id: 'text-ticker',
    z: 10,
    draw(ctx, w, h, info) {
      const c = getConfig();
      const live = getLive();
      if (!live.tickerOn || !c.ticker.text) return false;
      drawTicker(ctx, w, h, c.ticker.text, c.ticker.speed, info.now - live.tickerAt, info.accent, c.ticker.position);
      return true;
    },
  };
  const lowerThird: OverlayLayer = {
    id: 'text-lower-third',
    z: 20,
    draw(ctx, w, h, info) {
      // A lower third names someone ON CAMERA: not over a slate.
      if (info.state !== 'live') return false;
      const c = getConfig();
      const live = getLive();
      const progress = lowerThirdProgress(live, info.now);
      if (progress <= 0) return false;
      const inset = live.tickerOn && c.ticker.text && c.ticker.position === 'bottom' ? tickerHeight(w, h) : 0;
      drawLowerThird(ctx, w, h, c.lowerThird.name, c.lowerThird.title, progress, info.accent, inset);
      return true;
    },
  };
  const countdown: OverlayLayer = {
    id: 'text-countdown',
    z: 30,
    draw(ctx, w, h, info) {
      const live = getLive();
      if (live.countdownEndsAt == null) return false;
      const remaining = live.countdownEndsAt - info.wall;
      if (remaining < -COUNTDOWN_LINGER_MS) return false;
      const c = getConfig();
      // Over the picture the chip sits top right: under a ticker that runs along the top.
      const inset = live.tickerOn && c.ticker.text && c.ticker.position === 'top' ? tickerHeight(w, h) : 0;
      drawCountdown(ctx, w, h, c.countdown.label, remaining, info.state !== 'live', info.accent, inset);
      return true;
    },
  };
  return [ticker, lowerThird, countdown];
}

/** 0..1 how far the lower third is in, from its on/off time and auto-hide. */
export function lowerThirdProgress(live: OverlayLive, now: number): number {
  const until = live.lowerThirdUntil;
  const on = live.lowerThirdOn && (until == null || now < until);
  if (on) return Math.min(1, (now - live.lowerThirdAt) / LOWER_THIRD_ANIM_MS);
  // Sliding out: from whichever came last, the Hide or the auto-hide.
  const offAt = live.lowerThirdOn && until != null ? until : live.lowerThirdAt;
  if (!live.lowerThirdOn && live.lowerThirdAt === 0) return 0;
  const out = 1 - (now - offAt) / LOWER_THIRD_ANIM_MS;
  return Math.max(0, Math.min(1, out));
}

// ---- fades -------------------------------------------------------------------

type CanvasFactory = (w: number, h: number) => HTMLCanvasElement | null;
const defaultFactory: CanvasFactory = (w, h) => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/**
 * A crossfade for one output canvas. Call `track(key, canvas, now, enabled)`
 * at the START of a frame, before drawing it: when the key (the scene, or the
 * live/slate state) changed, the frame still on the canvas is kept. After
 * drawing the new frame, `paint` lays the kept one over it, fading out. Costs
 * one copy per change and one extra blit per frame while it fades.
 */
export class FadeTransition {
  private key: string | null = null;
  private snap: HTMLCanvasElement | null = null;
  private start = -1;

  constructor(readonly durationMs = 400, private readonly makeCanvas: CanvasFactory = defaultFactory) {}

  get active(): boolean { return this.start >= 0; }

  track(key: string, source: HTMLCanvasElement, now: number, enabled: boolean): void {
    const changed = this.key !== null && this.key !== key;
    this.key = key;
    if (!changed || !enabled || !source.width || !source.height) return;
    if (!this.snap || this.snap.width !== source.width || this.snap.height !== source.height) {
      this.snap = this.makeCanvas(source.width, source.height);
    }
    const sctx = this.snap?.getContext('2d');
    if (!sctx) return;
    sctx.clearRect(0, 0, source.width, source.height);
    sctx.drawImage(source, 0, 0);
    this.start = now;
  }

  /** True while fading (a frame was painted). */
  paint(ctx: CanvasRenderingContext2D, w: number, h: number, now: number): boolean {
    if (this.start < 0 || !this.snap) return false;
    const t = (now - this.start) / this.durationMs;
    if (t >= 1 || t < 0) { this.start = -1; return false; }
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.drawImage(this.snap, 0, 0, w, h);
    ctx.restore();
    return true;
  }
}
