import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { useHangoutsContext } from '../context/HangoutsContext.js';
import { CaptionPublisher, type CaptionSlotApi, type StudioCaptionStatus } from '../lib/captionPublisher.js';
import {
  CAPTIONS_TOPIC,
  CaptionCueCollector,
  baseLang,
  encodeCaption,
  type CaptionCue,
  type CaptionLanguage,
  type CaptionSource,
} from '../lib/liveCaptions.js';
import type { StudioCaptionLabels } from '../components/room/LiveCaptionsToggle.js';

/** What an integrator hands the studio to offer live captions. */
export interface StudioCaptionsOptions {
  /** Speech-to-text for the host's mic (e.g. a WebSocket to a self-hosted server). */
  source: CaptionSource;
  /** The languages the speech server can recognise. Empty hides the option. */
  languages: CaptionLanguage[];
  /** Translated text for the studio's captions setting. */
  labels?: Partial<StudioCaptionLabels>;
}

export interface StudioCaptions {
  /** Show the setting: the integrator offers captions and this server has the slots route. */
  supported: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  lang: string;
  setLang: (code: string) => void;
  languages: CaptionLanguage[];
  status: StudioCaptionStatus;
  labels?: Partial<StudioCaptionLabels>;
  /** The recording started now: replay subtitle times count from here. */
  markRecordingStart: () => void;
  /** The replay's subtitles so far (null when there are none), and start over. */
  takeCues: () => { lang: string; cues: CaptionCue[] } | null;
}

const ON_KEY = 'hh-captions-on';
const LANG_KEY = 'hh-captions-lang';
function readPref(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, v: string) {
  try { window.localStorage.setItem(key, v); } catch { /* storage off */ }
}

/**
 * The studio's live captions: OFF by default, the host turns them on. Runs only
 * while live with the mic on (see lib/captionPublisher for the load rules).
 */
export function useStudioCaptions({ roomName, options, live, track }: {
  roomName: string;
  options?: StudioCaptionsOptions;
  live: boolean;
  track: MediaStreamTrack | null;
}): StudioCaptions {
  const { apiClient, apiBaseUrl } = useHangoutsContext();
  const { localParticipant } = useLocalParticipant();
  const lpRef = useRef(localParticipant);
  lpRef.current = localParticipant;
  const sourceRef = useRef(options?.source);
  sourceRef.current = options?.source;

  const languages = useMemo(() => options?.languages ?? [], [options?.languages]);
  const [enabled, setEnabledState] = useState(() => readPref(ON_KEY) === '1');
  const [langPick, setLangPick] = useState(() => readPref(LANG_KEY) || '');
  const lang = languages.some((l) => l.code === langPick) ? langPick : (languages[0]?.code ?? 'en-us');
  const [status, setStatus] = useState<StudioCaptionStatus>('off');
  // Does this hangouts server hand out caption slots? An older one has no route.
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const base = apiBaseUrl.replace(/\/$/, '');
  const offered = !!options && languages.length > 0;

  useEffect(() => {
    if (!offered) return undefined;
    let alive = true;
    fetch(`${base}/captions/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { enabled?: boolean } | null) => { if (alive) setServerOk(!!j?.enabled); })
      .catch(() => { if (alive) setServerOk(false); });
    return () => { alive = false; };
  }, [offered, base]);

  const collectorRef = useRef(new CaptionCueCollector());
  const pubRef = useRef<CaptionPublisher | null>(null);
  if (!pubRef.current) {
    const authed = async (path: string, body: unknown) => {
      const token = apiClient.getSessionToken?.();
      return fetch(`${base}/rooms/${encodeURIComponent(roomName)}/captions/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
      });
    };
    const api: CaptionSlotApi = {
      start: async (l) => {
        const r = await authed('start', { lang: l });
        if (r.ok) {
          const j = await r.json().catch(() => ({})) as { renewInSec?: number };
          return { ok: true, renewInSec: j.renewInSec };
        }
        return { ok: false, reason: r.status === 429 ? 'full' : 'unavailable' };
      },
      stop: async () => { await authed('stop', {}); },
    };
    pubRef.current = new CaptionPublisher({
      api,
      source: (t, o) => {
        const src = sourceRef.current;
        if (!src) throw new Error('no caption source');
        return src(t, o);
      },
      publish: (msg, reliable) => {
        void lpRef.current?.publishData(encodeCaption(msg), { reliable, topic: CAPTIONS_TOPIC })
          ?.catch(() => { /* a dropped line is fine */ });
      },
      onStatus: setStatus,
      collector: collectorRef.current,
    });
  }

  const supported = offered && serverOk === true;
  useEffect(() => {
    pubRef.current?.update({ enabled: enabled && supported, live, track, lang });
  }, [enabled, supported, live, track, lang]);
  useEffect(() => () => pubRef.current?.dispose(), []);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    writePref(ON_KEY, on ? '1' : '0');
  }, []);
  const setLang = useCallback((code: string) => {
    setLangPick(code);
    writePref(LANG_KEY, code);
  }, []);
  const markRecordingStart = useCallback(() => {
    // A new recording: lines from an earlier one belong to that file, not this.
    collectorRef.current.take();
    collectorRef.current.setAnchor(Date.now());
  }, []);
  const takeCues = useCallback(() => {
    const cues = collectorRef.current.take();
    collectorRef.current.setAnchor(null);
    return cues.length ? { lang: baseLang(lang), cues } : null;
  }, [lang]);

  return {
    supported, enabled, setEnabled, lang, setLang, languages, status,
    labels: options?.labels, markRecordingStart, takeCues,
  };
}
