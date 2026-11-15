import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHangoutsContext } from '../context/HangoutsContext.js';
import {
  cleanOverlayConfig, cleanOverlayTemplates, createTextOverlayLayers, newTemplateId,
  DEFAULT_OVERLAY_CONFIG, MAX_OVERLAY_TEMPLATES, OFF_LIVE,
  type OverlayConfig, type OverlayLayerList, type OverlayLive, type OverlayTemplate, type StudioState,
} from '../lib/studioOverlays.js';
import { startBuiltinMusic, type BuiltinTrackId, type MusicHandle } from '../lib/brbMusic.js';
import { saveStudioFile, deleteStudioFile, loadStudioFiles } from '../lib/studioSetup.js';

const CONFIG_KEY = 'hh-studio-overlays';
const TEMPLATES_CACHE_KEY = 'hh-studio-overlay-templates';
/** The IndexedDB id of the host's own "be right back" music file. */
export const BRB_MUSIC_FILE_ID = 'overlay-brb-music';
const MAX_MUSIC_BYTES = 40 * 1024 * 1024;

const userKey = (base: string, user: string | null | undefined) => `${base}:${(user || '').toLowerCase()}`;

function readLocal<T>(key: string, parse: (v: unknown) => T, dflt: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? parse(JSON.parse(raw)) : dflt;
  } catch { return dflt; }
}
function writeLocal(key: string, v: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* full or blocked */ }
}

export interface StudioOverlaysApi {
  config: OverlayConfig;
  /** Change the saved setup (also what a template stores). */
  update: (fn: (c: OverlayConfig) => OverlayConfig) => void;
  live: OverlayLive;
  /** Show the lower third, for `seconds` or until hidden (null). */
  showLowerThird: (seconds: number | null) => void;
  hideLowerThird: () => void;
  setTickerOn: (on: boolean) => void;
  startCountdown: () => void;
  stopCountdown: () => void;
  /** The names used when the lower third's fields are empty. */
  defaults: { name: string; title: string };
  templates: OverlayTemplate[];
  /** A template's settings were applied; its id. */
  activeTemplate: string | null;
  saveTemplate: (name: string) => Promise<void>;
  applyTemplate: (id: string) => void;
  deleteTemplate: (id: string) => Promise<void>;
  templatesError: string;
  musicFile: string | null;
  setMusicFile: (file: File | null) => Promise<void>;
  musicError: string;
  /** Music is playing to viewers right now. */
  musicPlaying: boolean;
  /** For the compositor (bound once): the current config. */
  configRef: React.MutableRefObject<OverlayConfig>;
}

/**
 * State and side effects of the studio's text overlays (H17): the setup the
 * host edits (kept in the browser per host), what is on screen right now,
 * the host's named templates (saved on the server so they follow the host to
 * another computer, cached locally), and the "be right back" music.
 *
 * The three text layers are registered into the studio's `layers` list here;
 * the compositor draws them on every output.
 *
 * Music plays on the slates (Starting soon, and Pause = Be right back), mixed
 * straight into the published program audio, past the live gate that mutes the
 * mic and sources while the stream is not live.
 */
export function useStudioOverlays(opts: {
  layers: OverlayLayerList;
  streamState: StudioState;
  /** The studio's audio graph: its context and the published destination. */
  getAudio: () => { ctx: AudioContext; dest: AudioNode } | null;
  defaultName: string;
  defaultTitle: string;
}): StudioOverlaysApi {
  const { layers, streamState, getAudio, defaultName, defaultTitle } = opts;
  const { username, apiBaseUrl, apiClient } = useHangoutsContext();

  const [config, setConfig] = useState<OverlayConfig>(() =>
    readLocal(userKey(CONFIG_KEY, username), (v) => cleanOverlayConfig((v as { config?: unknown })?.config ?? v), DEFAULT_OVERLAY_CONFIG));
  const [activeTemplate, setActiveTemplate] = useState<string | null>(() =>
    readLocal(userKey(CONFIG_KEY, username), (v) => {
      const id = (v as { template?: unknown })?.template;
      return typeof id === 'string' ? id : null;
    }, null));
  const [live, setLive] = useState<OverlayLive>(OFF_LIVE);
  const configRef = useRef(config);
  configRef.current = config;
  const liveRef = useRef(live);
  liveRef.current = live;
  const defaultsRef = useRef({ name: defaultName, title: defaultTitle });
  defaultsRef.current = { name: defaultName, title: defaultTitle };

  // The host is known a moment after mount on a cold load: read their setup then.
  const loadedForRef = useRef(username);
  useEffect(() => {
    if (!username || loadedForRef.current === username) return;
    loadedForRef.current = username;
    setConfig(readLocal(userKey(CONFIG_KEY, username), (v) => cleanOverlayConfig((v as { config?: unknown })?.config ?? v), DEFAULT_OVERLAY_CONFIG));
  }, [username]);

  useEffect(() => {
    if (!username) return;
    writeLocal(userKey(CONFIG_KEY, username), { config, template: activeTemplate });
  }, [username, config, activeTemplate]);

  const update = useCallback((fn: (c: OverlayConfig) => OverlayConfig) => {
    setConfig((c) => fn(c));
  }, []);

  // ---- layers --------------------------------------------------------------
  useEffect(() => {
    const effective = (): OverlayConfig => {
      const c = configRef.current;
      const d = defaultsRef.current;
      return {
        ...c,
        lowerThird: { name: c.lowerThird.name.trim() || d.name, title: c.lowerThird.title.trim() || d.title },
      };
    };
    const removers = createTextOverlayLayers(effective, () => liveRef.current).map((l) => layers.add(l));
    return () => removers.forEach((r) => r());
  }, [layers]);

  const showLowerThird = useCallback((seconds: number | null) => {
    const now = performance.now();
    setLive((l) => ({ ...l, lowerThirdOn: true, lowerThirdAt: now, lowerThirdUntil: seconds ? now + seconds * 1000 : null }));
  }, []);
  const hideLowerThird = useCallback(() => {
    const now = performance.now();
    setLive((l) => {
      // Already slid out on its own: nothing to animate.
      if (l.lowerThirdUntil != null && now >= l.lowerThirdUntil) return { ...l, lowerThirdOn: false, lowerThirdAt: 0, lowerThirdUntil: null };
      return { ...l, lowerThirdOn: false, lowerThirdAt: now, lowerThirdUntil: null };
    });
  }, []);
  // An auto-hidden lower third flips the button back to "Show".
  useEffect(() => {
    if (!live.lowerThirdOn || live.lowerThirdUntil == null) return undefined;
    const ms = live.lowerThirdUntil - performance.now() + 600;
    const t = window.setTimeout(() => setLive((l) => (
      l.lowerThirdOn && l.lowerThirdUntil != null && performance.now() >= l.lowerThirdUntil
        ? { ...l, lowerThirdOn: false, lowerThirdAt: 0, lowerThirdUntil: null } : l)), Math.max(0, ms));
    return () => window.clearTimeout(t);
  }, [live.lowerThirdOn, live.lowerThirdUntil]);

  const setTickerOn = useCallback((on: boolean) => {
    setLive((l) => ({ ...l, tickerOn: on, tickerAt: on ? performance.now() : l.tickerAt }));
  }, []);
  const startCountdown = useCallback(() => {
    setLive((l) => ({ ...l, countdownEndsAt: Date.now() + configRef.current.countdown.minutes * 60_000 }));
  }, []);
  const stopCountdown = useCallback(() => setLive((l) => ({ ...l, countdownEndsAt: null })), []);

  // ---- templates -----------------------------------------------------------
  const [templates, setTemplates] = useState<OverlayTemplate[]>(() =>
    readLocal(userKey(TEMPLATES_CACHE_KEY, username), cleanOverlayTemplates, []));
  const [templatesError, setTemplatesError] = useState('');
  const base = apiBaseUrl.replace(/\/$/, '');
  const authHeaders = useCallback((): Record<string, string> => {
    const token = apiClient.getSessionToken?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [apiClient]);

  useEffect(() => {
    if (!username) return undefined;
    let alive = true;
    setTemplates(readLocal(userKey(TEMPLATES_CACHE_KEY, username), cleanOverlayTemplates, []));
    (async () => {
      try {
        const res = await fetch(`${base}/studio/overlays`, { headers: authHeaders() });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as { templates?: unknown };
        if (!alive) return;
        const list = cleanOverlayTemplates(data.templates);
        setTemplates(list);
        writeLocal(userKey(TEMPLATES_CACHE_KEY, username), list);
      } catch {
        // Offline or an older server: the cached list still works here.
      }
    })();
    return () => { alive = false; };
  }, [username, base, authHeaders]);

  const persist = useCallback(async (list: OverlayTemplate[]) => {
    setTemplates(list);
    writeLocal(userKey(TEMPLATES_CACHE_KEY, username), list);
    setTemplatesError('');
    try {
      const res = await fetch(`${base}/studio/overlays`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ templates: list }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(e.message || `HTTP ${res.status}`);
      }
    } catch (err) {
      setTemplatesError(`Saved in this browser only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [base, authHeaders, username]);

  const saveTemplate = useCallback(async (name: string) => {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) return;
    const existing = templates.find((t) => t.name.toLowerCase() === clean.toLowerCase());
    if (!existing && templates.length >= MAX_OVERLAY_TEMPLATES) {
      setTemplatesError(`You can keep up to ${MAX_OVERLAY_TEMPLATES} templates. Delete one first.`);
      return;
    }
    const id = existing?.id ?? newTemplateId(clean, templates);
    const entry: OverlayTemplate = { id, name: clean, config: cleanOverlayConfig(configRef.current) };
    const list = existing ? templates.map((t) => (t.id === id ? entry : t)) : [...templates, entry];
    setActiveTemplate(id);
    await persist(list);
  }, [templates, persist]);

  const applyTemplate = useCallback((id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setConfig(cleanOverlayConfig(t.config));
    setActiveTemplate(id);
  }, [templates]);

  const deleteTemplate = useCallback(async (id: string) => {
    if (activeTemplate === id) setActiveTemplate(null);
    await persist(templates.filter((t) => t.id !== id));
  }, [templates, persist, activeTemplate]);

  // ---- music ---------------------------------------------------------------
  const [musicFile, setMusicFileName] = useState<string | null>(null);
  const [musicError, setMusicError] = useState('');
  const fileElRef = useRef<HTMLAudioElement | null>(null);
  const fileUrlRef = useRef<string | null>(null);
  const fileNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const fileGainRef = useRef<GainNode | null>(null);
  const builtinRef = useRef<{ id: BuiltinTrackId; handle: MusicHandle } | null>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);

  const loadFile = useCallback((file: File) => {
    if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
    fileElRef.current?.pause();
    try { fileNodeRef.current?.disconnect(); } catch { /* gone */ }
    fileNodeRef.current = null;
    const url = URL.createObjectURL(file);
    fileUrlRef.current = url;
    const el = new Audio();
    el.src = url;
    el.loop = true;
    el.preload = 'auto';
    fileElRef.current = el;
    setMusicFileName(file.name);
  }, []);

  // The host's file comes back from IndexedDB with the rest of the studio.
  useEffect(() => {
    if (!username) return undefined;
    let alive = true;
    void loadStudioFiles(username).then((files) => {
      const f = files.find((x) => x.id === BRB_MUSIC_FILE_ID);
      if (alive && f) loadFile(f.file);
    });
    return () => { alive = false; };
  }, [username, loadFile]);

  const setMusicFile = useCallback(async (file: File | null) => {
    setMusicError('');
    if (!file) {
      fileElRef.current?.pause();
      fileElRef.current = null;
      if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
      fileUrlRef.current = null;
      setMusicFileName(null);
      setConfig((c) => (c.brb.music === 'file' ? { ...c, brb: { ...c.brb, music: 'off' } } : c));
      await deleteStudioFile(username, BRB_MUSIC_FILE_ID);
      return;
    }
    if (!file.type.startsWith('audio/')) { setMusicError(`${file.name} is not an audio file.`); return; }
    if (file.size > MAX_MUSIC_BYTES) { setMusicError('That file is over 40 MB. Pick a shorter track.'); return; }
    loadFile(file);
    setConfig((c) => ({ ...c, brb: { ...c.brb, music: 'file' } }));
    await saveStudioFile(username, 'overlay', BRB_MUSIC_FILE_ID, file);
  }, [username, loadFile]);

  const slate = streamState !== 'live';
  const { music, volume } = config.brb;
  const getAudioRef = useRef(getAudio);
  getAudioRef.current = getAudio;
  useEffect(() => {
    const want = slate && music !== 'off' && (music !== 'file' || !!musicFile);
    const stopBuiltin = () => { builtinRef.current?.handle.stop(); builtinRef.current = null; };
    const stopFile = () => {
      const el = fileElRef.current;
      if (el && !el.paused) el.pause();
    };
    if (!want) { stopBuiltin(); stopFile(); setMusicPlaying(false); return; }
    const audio = getAudioRef.current();
    if (!audio) return;
    if (music === 'file') {
      stopBuiltin();
      const el = fileElRef.current;
      if (!el) return;
      try {
        if (!fileNodeRef.current) {
          fileNodeRef.current = audio.ctx.createMediaElementSource(el);
          fileGainRef.current = fileGainRef.current ?? audio.ctx.createGain();
          fileNodeRef.current.connect(fileGainRef.current);
          fileGainRef.current.connect(audio.dest);
        }
        fileGainRef.current!.gain.value = volume;
        void el.play().catch(() => setMusicError('The browser blocked playback: click anywhere in the studio, then try again.'));
      } catch { setMusicError('This file cannot be played here.'); return; }
    } else {
      stopFile();
      const id = music as BuiltinTrackId;
      if (builtinRef.current?.id !== id) {
        stopBuiltin();
        builtinRef.current = { id, handle: startBuiltinMusic(audio.ctx, audio.dest, id, volume) };
      } else {
        builtinRef.current.handle.setVolume(volume);
      }
    }
    setMusicPlaying(true);
  }, [slate, music, volume, musicFile]);

  useEffect(() => () => {
    builtinRef.current?.handle.stop();
    fileElRef.current?.pause();
    if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
  }, []);

  const defaults = useMemo(() => ({ name: defaultName, title: defaultTitle }), [defaultName, defaultTitle]);

  return {
    config, update, live, showLowerThird, hideLowerThird, setTickerOn, startCountdown, stopCountdown, defaults,
    templates, activeTemplate, saveTemplate, applyTemplate, deleteTemplate, templatesError,
    musicFile, setMusicFile, musicError, musicPlaying, configRef,
  };
}
