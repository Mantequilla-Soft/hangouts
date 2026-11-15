import { baseLang } from './liveCaptions.js';

/**
 * Translate captions ON THE VIEWER'S DEVICE with the browser's built-in
 * Translator API (Chrome 138+ on desktop; the model downloads once per
 * language pair). No server, no API costs. Where the browser has no such API
 * the viewer sees the original language and a note saying why.
 *
 * Feature-detected at call time (`globalThis.Translator`), so it is safe in
 * every browser and in server-side rendering.
 */

export type TranslateMode =
  | 'same'           // the captions are already in the viewer's language
  | 'checking'
  | 'ready'          // translating
  | 'needs-gesture'  // the language pack must download: needs one click first
  | 'unavailable';   // this browser cannot translate this pair

interface BrowserTranslator {
  translate: (text: string) => Promise<string>;
  destroy?: () => void;
}
interface TranslatorApi {
  availability: (o: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (o: { sourceLanguage: string; targetLanguage: string }) => Promise<BrowserTranslator>;
}

function api(): TranslatorApi | null {
  const t = (globalThis as unknown as { Translator?: TranslatorApi }).Translator;
  return t && typeof t.availability === 'function' && typeof t.create === 'function' ? t : null;
}

/** Can captions in `source` be shown in `target` here, and is a click needed first? */
export async function translationMode(source: string, target: string): Promise<TranslateMode> {
  const s = baseLang(source);
  const t = baseLang(target);
  if (s === t) return 'same';
  const a = api();
  if (!a) return 'unavailable';
  try {
    const v = await a.availability({ sourceLanguage: s, targetLanguage: t });
    if (v === 'available') return 'ready';
    if (v === 'downloadable' || v === 'downloading') return 'needs-gesture';
    return 'unavailable';
  } catch { return 'unavailable'; }
}

const translators = new Map<string, Promise<BrowserTranslator | null>>();

/**
 * One translator per language pair, shared by every caption on the page. Call
 * it from a click when translationMode said 'needs-gesture' (the browser only
 * downloads a language pack after a user action). Null when it cannot.
 */
export function captionTranslator(source: string, target: string): Promise<BrowserTranslator | null> {
  const key = `${baseLang(source)}>${baseLang(target)}`;
  let p = translators.get(key);
  if (!p) {
    const a = api();
    p = a
      ? a.create({ sourceLanguage: baseLang(source), targetLanguage: baseLang(target) }).catch(() => null)
      : Promise.resolve(null);
    translators.set(key, p);
    // A failed create (no gesture yet, offline) may work on the next try.
    void p.then((tr) => { if (!tr) translators.delete(key); });
  }
  return p;
}

/** Test helper: forget the cached translators. */
export function resetCaptionTranslators() {
  translators.clear();
}

/** A language's name in the viewer's language (`en` in German -> "Englisch"). */
export function languageName(code: string, uiLang: string): string {
  const base = baseLang(code);
  try {
    const dn = new Intl.DisplayNames([uiLang || 'en'], { type: 'language' });
    return dn.of(base) || base;
  } catch { return base; }
}
