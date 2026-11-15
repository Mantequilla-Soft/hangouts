import { FadeTransition } from './studioOverlays.js';
import { clampCenter, cropRect, cropWidthFrac, smoothToward, verticalSize, type VerticalFollow, type VerticalMode } from './verticalCrop.js';

/**
 * The studio's second, vertical output (H19): a small 9:16 canvas the
 * compositor fills every frame with a crop of the composed landscape scene,
 * then lays the overlays, boosts and watermark over at phone layout. Its
 * captureStream is what gets published as `studio-vertical`.
 *
 * Also owns the crop centre, so the preview's crop box, the metadata the
 * viewers read and the pixels all agree, including while it follows a source.
 */
export class VerticalOutput {
  mode: VerticalMode = 'off';
  follow: VerticalFollow = 'manual';
  /** Centre of the crop, fraction of the landscape width (what is drawn). */
  center = 0.5;
  /** Where the host put it (the box drag); the follow target overrides it. */
  manual = 0.5;
  /** Width of the crop, fraction of the landscape width. */
  widthFrac = cropWidthFrac(1280, 720);
  readonly fade = new FadeTransition(400);
  private canvas: HTMLCanvasElement | null = null;
  private stream: MediaStream | null = null;
  private lastStep = 0;

  /** The canvas, created and sized for a program `height` on first use. */
  ensureCanvas(programHeight: number): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    const { width, height } = verticalSize(programHeight);
    if (!this.canvas) this.canvas = document.createElement('canvas');
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return this.canvas;
  }

  /** The capture stream's video track (one per canvas, made on demand). */
  track(programHeight: number): MediaStreamTrack | null {
    const c = this.ensureCanvas(programHeight);
    if (!c) return null;
    if (!this.stream || this.stream.getVideoTracks()[0]?.readyState !== 'live') {
      this.stream = typeof c.captureStream === 'function' ? c.captureStream(30) : null;
    }
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  /** Stop the capture (the phone version was switched off). */
  release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get publishing(): boolean {
    return !!this.stream && this.stream.getVideoTracks()[0]?.readyState === 'live';
  }

  /** Move the crop toward `target` (a following crop), or to the manual spot. */
  step(now: number, target: number | null, frameW: number, frameH: number): void {
    this.widthFrac = cropWidthFrac(frameW, frameH);
    const goal = clampCenter(target ?? this.manual, this.widthFrac);
    const dt = this.lastStep ? now - this.lastStep : 1000;
    this.lastStep = now;
    this.center = target == null ? goal : smoothToward(this.center, goal, dt);
  }

  /**
   * Draw one vertical frame. `live` crops the scene from `display`; otherwise
   * `extras` draws the slate. `extras` then lays overlays and boosts over it,
   * the fade runs, and `finish` stamps the watermark on top.
   */
  render(
    display: HTMLCanvasElement, live: boolean, now: number, fadeKey: string, fadeOn: boolean,
    extras: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    finish: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  ): void {
    const c = this.canvas;
    if (!c || !this.publishing) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    this.fade.track(fadeKey, c, now, fadeOn);
    if (live) {
      const r = cropRect(display.width, display.height, this.center);
      ctx.drawImage(display, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
    }
    extras(ctx, c.width, c.height);
    this.fade.paint(ctx, c.width, c.height, now);
    finish(ctx, c.width, c.height);
  }
}
