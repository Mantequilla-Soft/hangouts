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
  /** What the camera popup calls it (the host's own name when set). */
  name: string;
  /** What the phone calls it (shown under a name of the host's). */
  osName: string;
  /** Only when the label says so (or it is Android's main camera of a side). */
  kind: LensKind | null;
  /** Starred by the host: listed first. */
  fav: boolean;
}

/** The host's own names and favourites, per camera (deviceId), kept in the
 *  browser: the phone's names say little ("Back camera 3"), the host knows
 *  which one is the wide one. */
export type LensPrefs = Record<string, { name?: string; fav?: boolean }>;
export const LENS_PREFS_KEY = 'hh-studio-cam-prefs';

export function loadLensPrefs(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): LensPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(LENS_PREFS_KEY) || 'null');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as LensPrefs : {};
  } catch { return {}; }
}

export function saveLensPrefs(prefs: LensPrefs, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage ?? null): void {
  try { storage?.setItem(LENS_PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

/** Set (or, empty, clear) the host's name for a camera. */
export function renameLens(prefs: LensPrefs, deviceId: string, name: string): LensPrefs {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  const { name: _old, ...rest } = prefs[deviceId] ?? {};
  const entry = clean ? { ...rest, name: clean } : rest;
  const next = { ...prefs };
  if (Object.keys(entry).length) next[deviceId] = entry; else delete next[deviceId];
  return next;
}

/** Star or unstar a camera. */
export function toggleFavLens(prefs: LensPrefs, deviceId: string): LensPrefs {
  const { fav, ...rest } = prefs[deviceId] ?? {};
  const entry = fav ? rest : { ...rest, fav: true };
  const next = { ...prefs };
  if (Object.keys(entry).length) next[deviceId] = entry; else delete next[deviceId];
  return next;
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
export function listLenses(devices: Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[], prefs: LensPrefs = {}): Lens[] {
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
      const osName = pos === 0 ? base : `${base} ${pos + 1}`;
      return withPrefs({ deviceId: d.deviceId, facing: a.facing, osName, kind: pos === 0 ? 'main' : null });
    }
    const rank = lensWidthRank(d.label || '');
    return withPrefs({
      deviceId: d.deviceId,
      facing: facingOf(d.label || ''),
      osName: d.label || `Camera ${i + 1}`,
      kind: rank === 0 ? 'ultrawide' : rank === 2 ? 'tele' : rank === 1 ? 'main' : null,
    });
  });
  // Favourites first, then back, unknown and front cameras, each in the
  // phone's order.
  const order = (l: Lens) => (l.fav ? 0 : 1) * 10 + (l.facing === 'environment' ? 0 : l.facing === 'user' ? 2 : 1);
  return lenses
    .map((l, i) => ({ l, i }))
    .sort((p, q) => order(p.l) - order(q.l) || p.i - q.i)
    .map(({ l }) => l);

  function withPrefs(l: Omit<Lens, 'name' | 'fav'>): Lens {
    const p = prefs[l.deviceId];
    return { ...l, name: p?.name || l.osName, fav: !!p?.fav };
  }
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
