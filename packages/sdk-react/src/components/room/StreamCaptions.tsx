import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveCaptions } from '../../hooks/useLiveCaptions.js';
import { captionTranslator, languageName, translationMode, type TranslateMode } from '../../lib/captionTranslate.js';
import { baseLang } from '../../lib/liveCaptions.js';

/** The viewer's captions overlay text. `{lang}` is filled in by the SDK. */
export interface StreamCaptionLabels {
  translatedFrom: string;
  showOriginal: string;
  translateTo: string;
  noTranslator: string;
}

export const DEFAULT_STREAM_CAPTION_LABELS: StreamCaptionLabels = {
  translatedFrom: 'Translated from {lang} on your device',
  showOriginal: 'Show original',
  translateTo: 'Translate to {lang}',
  noTranslator: 'In {lang}: this browser cannot translate captions',
};

export interface StreamCaptionsProps {
  /** The viewer's CC choice. Nothing renders while false. */
  show: boolean;
  /** The viewer's language (the site language): captions in another language
   *  are translated on the device where the browser can. */
  targetLang?: string;
  labels?: Partial<StreamCaptionLabels>;
  className?: string;
}

const fill = (s: string, lang: string) => s.replace('{lang}', lang);

/**
 * Live captions over the stream picture (never burned into the video). Only
 * the host's lines are shown. Must be inside <StandaloneWatch>; pair it with
 * useLiveCaptions().available to show a CC button only when there is something.
 */
export function StreamCaptions({ show, targetLang = 'en', labels, className }: StreamCaptionsProps) {
  const { available, lang, lines } = useLiveCaptions();
  const L = { ...DEFAULT_STREAM_CAPTION_LABELS, ...labels };
  const active = show && available;

  const [mode, setMode] = useState<TranslateMode>('checking');
  const [original, setOriginal] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setMode('checking');
    void translationMode(lang, targetLang).then((m) => { if (alive) setMode(m); });
    return () => { alive = false; };
  }, [active, lang, targetLang]);

  // Translated text per line id, for the text it was made from.
  const [done, setDone] = useState<Record<number, { src: string; out: string }>>({});
  const asked = useRef<Record<number, string>>({});
  const translating = active && mode === 'ready' && !original;
  useEffect(() => {
    if (!translating) return undefined;
    let alive = true;
    const onScreen = new Set(lines.map((l) => l.id));
    for (const k of Object.keys(asked.current)) if (!onScreen.has(Number(k))) delete asked.current[Number(k)];
    void captionTranslator(lang, targetLang).then((tr) => {
      if (!alive) return;
      if (!tr) { setMode('unavailable'); return; }
      for (const l of lines) {
        if (asked.current[l.id] === l.text) continue;
        asked.current[l.id] = l.text;
        const src = l.text;
        tr.translate(src)
          .then((out) => {
            // Only the newest text of a line still on screen counts.
            if (asked.current[l.id] !== src) return;
            setDone((d) => {
              const next: Record<number, { src: string; out: string }> = {};
              // Keep only the lines still on screen.
              for (const k of Object.keys(d)) if (asked.current[Number(k)] !== undefined) next[Number(k)] = d[Number(k)];
              next[l.id] = { src, out };
              return next;
            });
          })
          .catch(() => { if (asked.current[l.id] === src) delete asked.current[l.id]; });
      }
    });
    return () => { alive = false; };
  }, [translating, lines, lang, targetLang]);

  if (!active || !lines.length) return null;

  const from = languageName(lang, targetLang);
  const to = languageName(targetLang, targetLang);
  const textOf = (l: { id: number; text: string }) => (translating && done[l.id]?.out) || l.text;

  const enable = () => {
    // A click: the browser may download the language pack now.
    void captionTranslator(lang, targetLang).then((tr) => {
      setOriginal(false);
      setMode(tr ? 'ready' : 'unavailable');
    });
  };

  let note: ReactNode = null;
  if (mode === 'ready' && !original) {
    note = (
      <>
        <span>{fill(L.translatedFrom, from)}</span>
        <button type="button" className="hh-captions__switch" onClick={(e) => { e.stopPropagation(); setOriginal(true); }}>{L.showOriginal}</button>
      </>
    );
  } else if (mode === 'needs-gesture' || (mode === 'ready' && original)) {
    note = (
      <button type="button" className="hh-captions__switch" onClick={(e) => { e.stopPropagation(); enable(); }}>{fill(L.translateTo, to)}</button>
    );
  } else if (mode === 'unavailable' && baseLang(lang) !== baseLang(targetLang)) {
    note = <span>{fill(L.noTranslator, from)}</span>;
  }

  return (
    <div className={`hh-captions${className ? ` ${className}` : ''}`} aria-live="polite">
      {note && <div className="hh-captions__note">{note}</div>}
      <div className="hh-captions__lines" lang={translating && Object.keys(done).length ? baseLang(targetLang) : baseLang(lang)}>
        {lines.map((l) => (
          <p key={l.id} className={`hh-captions__line${l.final ? '' : ' hh-captions__line--live'}`}>
            <span>{textOf(l)}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
