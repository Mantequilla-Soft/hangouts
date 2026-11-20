/**
 * Phone cameras for the studio: which lenses the browser offers, what to call
 * them, and the zoom steps a lens supports.
 *
 * Phones expose each LENS as its own videoinput (main, ultra-wide, tele), and
 * `facingMode` only ever reaches the default one. The Web API exposes no field
 * of view or focal length, so a lens is known by its label: iOS Safari names
 * them ("Back Ultra Wide Camera"), Android Chrome numbers them ("camera2 2,
 * facing back"), where the lowest number of a side is that side's main camera
 * and the rest are the extra lenses in an order the phone maker picks. Some
 * phones instead hand the browser one camera that switches lenses itself: its
 * zoom then goes below 1× (0.5× or 0.6× is the ultra-wide).
 */

export type Facing = 'user' | 'environment';
export type LensKind = 'ultrawide' | 'main' | 'tele';

export interface Lens {
  deviceId: string;
  facing: Facing | null;
  /** What the camera popup calls it. */
  name: string;
  /** Only when the label says so (or it is Android's main camera of a side). */
  kind: LensKind | null;
}

/**
 * How wide is this lens? Lower rank = wider field of view. Best effort from the
 * label: `null` when the label says nothing, and callers must not pin a lens on
 * a guess.
 */
export function lensWidthRank(label: string): number | null {
  const l = label.toLowerCase();
  if (/ultra[\s-]?wide|super[\s-]?wide|0\.5\s?x/.test(l)) return 0;
  if (/tele(photo)?|[2-9]\s?x\b/.test(l)) return 2;
  if (/wide/.test(l)) return 1;
  return null;
}

/** Does this label belong to the given side, as far as we can tell? */
export function lensMatchesFacing(label: string, facing: Facing): boolean {
  const l = label.toLowerCase();
  const isBack = /back|rear|environment/.test(l);
  const isFront = /front|face|user|selfie/.test(l);
  if (!isBack && !isFront) return true; // unlabelled: don't exclude it
  return facing === 'environment' ? isBack : isFront;
}

function facingOf(label: string): Facing | null {
  const l = label.toLowerCase();
  if (/back|rear|environment/.test(l)) return 'environment';
  if (/front|user|selfie|facetime/.test(l)) return 'user';
  return null;
}

const ANDROID = /camera2?\s*(\d+)\s*,\s*facing\s+(back|front)/i;

/**
 * The cameras to offer, back ones first, each with a name a person can pick
 * from. Android's numbered lenses become "Back camera" (the main one) and
 * "Back camera 2", "3" … in the phone's order; named labels are kept.
 */
export function listLenses(devices: Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[]): Lens[] {
  const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
  const android = cams
    .map((d) => ({ d, m: ANDROID.exec(d.label) }))
    .filter((x): x is { d: typeof cams[number]; m: RegExpExecArray } => !!x.m)
    .map(({ d, m }) => ({ d, n: Number(m[1]), facing: (m[2].toLowerCase() === 'back' ? 'environment' : 'user') as Facing }));
  const lenses: Lens[] = cams.map((d, i) => {
    const a = android.find((x) => x.d === d);
    if (a) {
      const side = android.filter((x) => x.facing === a.facing).sort((p, q) => p.n - q.n);
      const pos = side.indexOf(a);
      const base = a.facing === 'environment' ? 'Back camera' : 'Front camera';
      return { deviceId: d.deviceId, facing: a.facing, name: pos === 0 ? base : `${base} ${pos + 1}`, kind: pos === 0 ? 'main' : null };
    }
    const rank = lensWidthRank(d.label || '');
    return {
      deviceId: d.deviceId,
      facing: facingOf(d.label || ''),
      name: d.label || `Camera ${i + 1}`,
      kind: rank === 0 ? 'ultrawide' : rank === 2 ? 'tele' : rank === 1 ? 'main' : null,
    };
  });
  const order = (l: Lens) => (l.facing === 'environment' ? 0 : l.facing === 'user' ? 2 : 1);
  return lenses
    .map((l, i) => ({ l, i }))
    .sort((p, q) => order(p.l) - order(q.l) || p.i - q.i)
    .map(({ l }) => l);
}

/** Zoom with the lens's own zoom (hardware), else a crop of the frame (1–4×). */
export interface ZoomRange { min: number; max: number; hardware: boolean }
export const SOFT_ZOOM: ZoomRange = { min: 1, max: 4, hardware: false };

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The steps the zoom buttons go through: the widest the lens allows (below 1×
 * when the phone switches to its ultra-wide itself), 1×, then 2×, 3×, 5×, 10×
 * as far as the lens goes, and its maximum.
 */
export function zoomStops(range: ZoomRange): number[] {
  if (!range.hardware) return [1, 1.5, 2, 2.5, 3, 3.5, 4];
  const min = round1(range.min), max = round1(range.max);
  const stops = new Set<number>();
  stops.add(min);
  for (const s of [1, 2, 3, 5, 10]) if (s > min && s < max) stops.add(s);
  stops.add(max);
  return [...stops].sort((a, b) => a - b);
}

/** The next step in or out from `z`, or `z` itself at the end. */
export function stepZoom(range: ZoomRange, z: number, dir: 1 | -1): number {
  const stops = zoomStops(range);
  if (dir > 0) return stops.find((s) => s > z + 0.05) ?? z;
  return [...stops].reverse().find((s) => s < z - 0.05) ?? z;
}

/** "0.6×", "1×", "2.5×". */
export function formatZoom(z: number): string {
  const r = round1(z);
  return `${Number.isInteger(r) ? r : r.toFixed(1)}×`;
}
