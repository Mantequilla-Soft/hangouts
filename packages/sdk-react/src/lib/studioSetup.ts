/**
 * The streaming studio's last setup, remembered in the browser per host, so
 * coming back to the studio finds it the way it was left: the scene, which
 * source was on air, the split, the mixer, quality, the panel layout, and the
 * media and sound files that had been added.
 *
 * Settings go to localStorage (small, read synchronously at mount). The FILES
 * go to IndexedDB: an added image, clip or sound only exists as a blob: URL for
 * the life of the page, so the file itself has to be kept for it to come back.
 * Screen shares are not kept: the browser asks for those again every time.
 *
 * Everything here is best effort. Storage can be full, blocked or wiped; a
 * failure only means the studio opens with the defaults, never an error.
 */
import type { StudioSceneId } from '../components/room/StandaloneStudio.js';

const SETUP_KEY = 'hh-studio-setup';
const DB_NAME = 'hh-studio';
const STORE = 'files';

export interface SavedSound { id: string; label: string; gain: number; muted: boolean; loop: boolean; }

export interface StudioSetup {
  scene?: StudioSceneId;
  /** Only ever a media source (`media:<id>`): a share cannot be restored. */
  source?: string | null;
  splitRatio?: number;
  /** Camera / mic were on: switched back on when the studio opens again. */
  camOn?: boolean;
  micOn?: boolean;
  micGain?: number;
  mediaGain?: number;
  mediaMuted?: boolean;
  auxGain?: number;
  auxMuted?: boolean;
  streamQuality?: string;
  degradePref?: string;
  leftW?: number;
  chatW?: number;
  faderH?: number;
  leftCollapsed?: boolean;
  chatCollapsed?: boolean;
  mixerCollapsed?: boolean;
  /** Media in the order the host added them (files in IndexedDB). */
  media?: Array<{ id: string; name: string }>;
  sounds?: SavedSound[];
}

const keyFor = (user: string) => `${SETUP_KEY}:${user.toLowerCase()}`;

export function readStudioSetup(user: string | null | undefined): StudioSetup {
  if (!user) return {};
  try {
    const raw = window.localStorage.getItem(keyFor(user));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v as StudioSetup : {};
  } catch {
    return {};
  }
}

export function writeStudioSetup(user: string | null | undefined, setup: StudioSetup): void {
  if (!user) return;
  try { window.localStorage.setItem(keyFor(user), JSON.stringify(setup)); } catch { /* full or blocked */ }
}

// ---- files (IndexedDB) ------------------------------------------------------

export interface StoredFile { key: string; user: string; id: string; kind: 'media' | 'sound'; name: string; type: string; blob: Blob; }

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const fileKey = (user: string, id: string) => `${user.toLowerCase()}:${id}`;

export async function saveStudioFile(user: string | null | undefined, kind: StoredFile['kind'], id: string, file: File): Promise<void> {
  if (!user) return;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        key: fileKey(user, id), user: user.toLowerCase(), id, kind, name: file.name, type: file.type, blob: file,
      } satisfies StoredFile);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();   // quota exceeded lands here
    } catch {
      resolve();
    }
  });
}

export async function deleteStudioFile(user: string | null | undefined, id: string): Promise<void> {
  if (!user) return;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(fileKey(user, id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** The host's stored files, as Files again (name and type kept). */
export async function loadStudioFiles(user: string | null | undefined): Promise<Array<{ id: string; kind: StoredFile['kind']; file: File }>> {
  if (!user) return [];
  const db = await openDb();
  if (!db) return [];
  const prefix = `${user.toLowerCase()}:`;
  return new Promise((resolve) => {
    try {
      const out: Array<{ id: string; kind: StoredFile['kind']; file: File }> = [];
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        const v = cur.value as StoredFile;
        try {
          out.push({ id: v.id, kind: v.kind, file: new File([v.blob], v.name, { type: v.type }) });
        } catch { /* a record we cannot rebuild is skipped */ }
        cur.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve([]);
    }
  });
}
