/**
 * Landscape and vertical at the same time (H19).
 *
 * The desktop studio composes a 16:9 program. With the phone version on, it
 * ALSO crops a 9:16 slice out of that composition every frame (the crop box
 * the host drags over the preview, or one that follows the camera or the
 * source), draws the overlays, boosts and watermark into it at phone layout,
 * and publishes it as a second video track, `studio-vertical`. No server
 * transcoding: it is one more small canvas and one more encoder on the host.
 *
 * Viewers on a phone held upright subscribe to the vertical track; everyone
 * else takes the landscape one. When there is no vertical track (an OBS
 * stream, an older studio) the viewer crops the landscape track itself, and
 * the crop the host last set (room metadata `vertical`) tells it where.
 */

/** Track names, as in sdk-core and the server's lib/programTrack.ts. */
export const STUDIO_PROGRAM_TRACK = 'studio-program';
export const STUDIO_VERTICAL_TRACK = 'studio-vertical';

export type VerticalFollow = 'manual' | 'camera' | 'source';

/** What the studio stores in the room metadata (cleaned by the server). */
export interface VerticalMeta {
  on: boolean;
  /** Centre of the crop, fraction of the landscape width. */
  x: number;
  /** Crop width, fraction of the landscape width. */
  w: number;
  follow: VerticalFollow;
  /** The studio sends the vertical track (false: viewers crop themselves). */
  track: boolean;
}

/**
 * The host's phone version setting (saved per host, in the browser):
 * - off: landscape only (phones letterbox, or crop wherever the viewer drags);
 * - track: the studio sends its own 9:16 video, overlays laid out for it;
 * - crop: no second video (lighter on the host's computer and upload), phone
 *   viewers crop the landscape picture where the host's box sits.
 */
export type VerticalMode = 'off' | 'track' | 'crop';

export interface VerticalPrefs {
  mode: VerticalMode;
  x: number;
  follow: VerticalFollow;
}

export const DEFAULT_VERTICAL_PREFS: VerticalPrefs = { mode: 'off', x: 0.5, follow: 'manual' };

/** Width of a 9:16 crop of a w x h frame, as a fraction of w. */
export function cropWidthFrac(w: number, h: number): number {
  if (!w || !h) return 9 / 16;
  return Math.min(1, (h * 9) / 16 / w);
}

/** Keep the centre so the crop stays inside the frame. */
export function clampCenter(x: number, wFrac: number): number {
  const half = wFrac / 2;
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1 - half, Math.max(half, x));
}

/** The crop in source pixels. */
export function cropRect(w: number, h: number, center: number): { sx: number; sy: number; sw: number; sh: number } {
  const wf = cropWidthFrac(w, h);
  const sw = Math.round(w * wf);
  const sx = Math.round(clampCenter(center, wf) * w - sw / 2);
  return { sx: Math.max(0, Math.min(w - sw, sx)), sy: 0, sw, sh: h };
}

/** Pixel size of the vertical output for a program `height` (even numbers,
 *  which encoders want). */
export function verticalSize(programHeight: number): { width: number; height: number } {
  const height = Math.max(2, Math.round(programHeight / 2) * 2);
  const width = Math.max(2, Math.round((height * 9) / 16 / 2) * 2);
  return { width, height };
}

/** Encoder budget for the vertical: it has ~32% of the landscape pixels. */
export function verticalBitrate(programMaxBitrate: number): number {
  return Math.max(300_000, Math.round(programMaxBitrate * 0.42));
}

/** A region of the landscape frame, in 0..1 fractions. */
export interface FracRect { x: number; y: number; w: number; h: number }

/**
 * Where a following crop should centre, given what the current scene shows.
 * `camera` / `source` are the regions the camera and the selected source
 * occupy (null when the scene has none). Returns null to keep the current
 * centre: the camera fills the frame anyway, or there is nothing to follow.
 */
export function followTarget(follow: VerticalFollow, regions: { camera: FracRect | null; source: FracRect | null }): number | null {
  if (follow === 'manual') return null;
  const r = follow === 'camera' ? regions.camera : regions.source;
  if (!r || r.w >= 0.98) return null;
  return r.x + r.w / 2;
}

/** Ease the crop toward its target (dtMs since the last frame) so a
 *  following crop glides instead of jumping. */
export function smoothToward(current: number, target: number, dtMs: number): number {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / 180);
  const next = current + (target - current) * k;
  return Math.abs(next - target) < 0.0005 ? target : next;
}

/** Read the host's crop from parsed room metadata. */
export function readVerticalMeta(meta: Record<string, unknown> | null | undefined): VerticalMeta | null {
  const v = meta?.vertical as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object' || v.on !== true) return null;
  const w = typeof v.w === 'number' && v.w > 0 && v.w <= 1 ? v.w : 9 / 16 / (16 / 9);
  const x = clampCenter(typeof v.x === 'number' ? v.x : 0.5, w);
  const follow = v.follow === 'camera' || v.follow === 'source' ? v.follow : 'manual';
  return { on: true, x, w, follow, track: v.track === true };
}

/**
 * The CSS `object-position` x (0..1) that centres a viewer's cover-cropped
 * landscape video on the host's crop centre. `visibleFrac` is how much of the
 * frame's width the viewer's box shows (box width / covered video width).
 */
export function objectPositionFor(hostCenter: number, visibleFrac: number): number {
  if (visibleFrac >= 1) return 0.5;
  const p = (hostCenter - visibleFrac / 2) / (1 - visibleFrac);
  return Math.min(1, Math.max(0, p));
}

/** Should this viewer get the vertical version? A phone-sized screen held
 *  upright. Pure, from the numbers a browser reports. */
export function prefersVertical(viewportW: number, viewportH: number, coarsePointer: boolean): boolean {
  return viewportH > viewportW && Math.min(viewportW, viewportH) <= 820 && (coarsePointer || viewportW <= 600);
}

/** Saved host preference, per host. */
const PREFS_KEY = 'hh-studio-vertical';
export function readVerticalPrefs(user: string | null | undefined): VerticalPrefs {
  try {
    const raw = window.localStorage.getItem(`${PREFS_KEY}:${(user || '').toLowerCase()}`);
    const v = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    if (!v) return DEFAULT_VERTICAL_PREFS;
    return {
      mode: v.mode === 'track' || v.mode === 'crop' ? v.mode : 'off',
      x: typeof v.x === 'number' && Number.isFinite(v.x) ? Math.min(1, Math.max(0, v.x)) : 0.5,
      follow: v.follow === 'camera' || v.follow === 'source' ? v.follow : 'manual',
    };
  } catch {
    return DEFAULT_VERTICAL_PREFS;
  }
}
export function writeVerticalPrefs(user: string | null | undefined, prefs: VerticalPrefs): void {
  try { window.localStorage.setItem(`${PREFS_KEY}:${(user || '').toLowerCase()}`, JSON.stringify(prefs)); } catch { /* full or blocked */ }
}

/**
 * Where the camera and the selected source sit in a landscape scene, as
 * fractions of the frame (for a crop that follows one of them). `pip` is the
 * camera's box in the overlay scene.
 */
export function sceneRegions(
  scene: string, splitRatio: number, pip: FracRect | null, hasCamera: boolean, hasSource: boolean,
): { camera: FracRect | null; source: FracRect | null } {
  const full: FracRect = { x: 0, y: 0, w: 1, h: 1 };
  switch (scene) {
    case 'cam': return { camera: hasCamera ? full : null, source: null };
    case 'fullscreen': return { camera: null, source: hasSource ? full : null };
    case 'overlay': return { camera: hasCamera ? pip : null, source: hasSource ? full : null };
    case 'split': return {
      source: hasSource ? { x: 0, y: 0, w: splitRatio, h: 1 } : null,
      camera: hasCamera ? { x: splitRatio, y: 0, w: 1 - splitRatio, h: 1 } : null,
    };
    default: return { camera: hasCamera ? full : null, source: hasSource ? full : null };
  }
}
