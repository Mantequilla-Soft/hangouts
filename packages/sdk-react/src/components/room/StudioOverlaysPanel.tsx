import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StudioOverlaysApi } from '../../hooks/useStudioOverlays.js';
import { BUILTIN_TRACKS } from '../../lib/brbMusic.js';
import { StudioSubtabs, type StudioSubtab } from './StudioSubtabs.js';
import { editText, formatCountdown, type BrbMusic, type CountdownPosition, type TickerPosition, type TickerSpeed } from '../../lib/studioOverlays.js';

/** The countdown chip's places over the picture, in the order of the buttons. */
const COUNTDOWN_PLACES: Array<[CountdownPosition, string]> = [
  ['top-left', 'Top left'], ['top-right', 'Top right'], ['center', 'Middle'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right'],
];

/** Lower-third "show for" choices, in seconds (null = until hidden). */
const SHOW_FOR: Array<{ s: number | null; label: string }> = [
  { s: 8, label: '8 s' }, { s: 15, label: '15 s' }, { s: null, label: 'Until hidden' },
];

/** Sub-tabs: what goes on the picture live (first), the break, templates. */
export type OverlaySubtab = 'show' | 'break' | 'templates';
const OVERLAY_TABS: StudioSubtab<OverlaySubtab>[] = [
  { id: 'show', label: 'On screen' },
  { id: 'break', label: 'Break' },
  { id: 'templates', label: 'Templates' },
];

/**
 * The studio's Overlays panel (H17): lower third, ticker, countdown, the
 * "be right back" slate and its music, scene fades, and named templates.
 * Everything here is drawn into the stream itself, so viewers, the replay
 * and clips see it. Portalled to <body> like the Boost settings, so it opens
 * the same way on a phone (a bottom sheet in the integrator's skin).
 */
export function StudioOverlaysPanel({ api, onClose, streamState, embedded = false, initialTab = 'show' }: {
  api: StudioOverlaysApi;
  onClose: () => void;
  streamState: 'standby' | 'live' | 'paused';
  /** In the studio's right rail (the Overlays tab) instead of a sheet: no
   *  header or close button, not portalled. */
  embedded?: boolean;
  /** The sub-tab it opens on (On screen by default). */
  initialTab?: OverlaySubtab;
}) {
  const { config, update, live, defaults } = api;
  const [showFor, setShowFor] = useState<number | null>(8);
  const [templateName, setTemplateName] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<OverlaySubtab>(initialTab);
  const fileRef = useRef<HTMLInputElement>(null);
  const [, setTick] = useState(0);

  const lowerThirdOn = live.lowerThirdOn && (live.lowerThirdUntil == null || performance.now() < live.lowerThirdUntil);
  const countdownLeft = live.countdownEndsAt == null ? null : live.countdownEndsAt - Date.now();
  // Keep the countdown readout moving while the panel is open.
  useEffect(() => {
    if (live.countdownEndsAt == null) return undefined;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [live.countdownEndsAt]);

  const set = <K extends keyof typeof config>(key: K, patch: Partial<typeof config[K]>) =>
    update((c) => ({ ...c, [key]: { ...(c[key] as object), ...patch } }));

  const saveAs = async () => {
    const name = templateName.trim() || (api.templates.find((t) => t.id === api.activeTemplate)?.name ?? '');
    if (!name) return;
    setBusy(true);
    try { await api.saveTemplate(name); setTemplateName(''); } finally { setBusy(false); }
  };

  const brbSection = (
    <section className="hh-overlays__section">
      <div className="hh-overlays__section-title">Be right back</div>
      <label className="hh-overlays__field">
        <span>Message on the Pause slate</span>
        <input className="hh-overlays__input" type="text" maxLength={80} value={config.brb.message}
          placeholder="WE'LL BE RIGHT BACK"
          onChange={(e) => set('brb', { message: editText(e.target.value, 80) })} />
      </label>
      <label className="hh-overlays__field">
        <span>Music on the slates (Starting soon and Pause)</span>
        <select className="hh-overlays__input" value={config.brb.music}
          onChange={(e) => {
            const v = e.target.value as BrbMusic;
            if (v === 'file' && !api.musicFile) { fileRef.current?.click(); return; }
            set('brb', { music: v });
          }}>
          <option value="off">No music</option>
          {Object.values(BUILTIN_TRACKS).map((t) => <option key={t.id} value={t.id}>{t.label} (built in)</option>)}
          <option value="file">{api.musicFile ? `Your file: ${api.musicFile}` : 'Your own file…'}</option>
        </select>
      </label>
      {config.brb.music !== 'off' && (
        <label className="hh-overlays__field">
          <span>Music volume {Math.round(config.brb.volume * 100)}%</span>
          <input type="range" min={0} max={1} step={0.05} value={config.brb.volume}
            onChange={(e) => set('brb', { volume: Number(e.target.value) })} />
        </label>
      )}
      <div className="hh-overlays__row">
        <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" onClick={() => fileRef.current?.click()}>
          {api.musicFile ? 'Change file' : 'Pick a music file'}
        </button>
        {api.musicFile && (
          <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" onClick={() => void api.setMusicFile(null)}>Remove file</button>
        )}
      </div>
      <p className="hh-overlays__hint">
        {api.musicPlaying ? '♪ Playing to your viewers now. ' : ''}
        The built in tracks are made in your browser, free to use. With your own file, only use music you have the rights to.
      </p>
      {api.musicError && <p className="hh-overlays__error">{api.musicError}</p>}
    </section>
  );

  const panel = (
    <div className={`hh-overlays${embedded ? ' hh-overlays--embedded' : ''}`} role={embedded ? 'region' : 'dialog'} aria-label="Overlays">
      {!embedded && (
        <div className="hh-overlays__header">
          <span>Overlays</span>
          <button type="button" className="hh-overlays__close" onClick={onClose} aria-label="Close">×</button>
        </div>
      )}
      <StudioSubtabs tabs={OVERLAY_TABS} active={tab} onChange={setTab} label="Overlays" />
      <div className="hh-overlays__body">
        {tab === 'show' && (
          <>
            <p className="hh-overlays__intro">Drawn into your stream, so viewers, the replay and clips all see them.</p>

            {/* Lower third */}
            <section className="hh-overlays__section">
              <div className="hh-overlays__section-title">Lower third</div>
              <label className="hh-overlays__field">
                <span>Name</span>
                <input className="hh-overlays__input" type="text" maxLength={60} value={config.lowerThird.name}
                  placeholder={defaults.name ? `@${defaults.name.replace(/^@/, '')}` : 'Your name'}
                  onChange={(e) => set('lowerThird', { name: editText(e.target.value, 60) })} />
              </label>
              <label className="hh-overlays__field">
                <span>Title</span>
                <input className="hh-overlays__input" type="text" maxLength={80} value={config.lowerThird.title}
                  placeholder={defaults.title || 'What you do, or today’s topic'}
                  onChange={(e) => set('lowerThird', { title: editText(e.target.value, 80) })} />
              </label>
              <div className="hh-overlays__row">
                <div className="hh-overlays__seg" role="group" aria-label="Show for">
                  {SHOW_FOR.map((o) => (
                    <button key={o.label} type="button" className={showFor === o.s ? 'is-active' : ''} onClick={() => setShowFor(o.s)}>{o.label}</button>
                  ))}
                </div>
                {lowerThirdOn
                  ? <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" onClick={api.hideLowerThird}>Hide</button>
                  : <button type="button" className="hh-btn hh-btn--primary hh-btn--small" onClick={() => api.showLowerThird(showFor)}>Show</button>}
              </div>
              {streamState !== 'live' && <p className="hh-overlays__hint">Shows once you are live (not over the slates).</p>}
            </section>

            {/* Ticker */}
            <section className="hh-overlays__section">
              <div className="hh-overlays__section-title">Ticker</div>
              <textarea className="hh-overlays__input hh-overlays__textarea" maxLength={300} rows={2} value={config.ticker.text}
                placeholder="A line that scrolls across the picture: links, topics, thanks to supporters"
                onChange={(e) => set('ticker', { text: editText(e.target.value, 300) })} />
              <div className="hh-overlays__row">
                <div className="hh-overlays__seg" role="group" aria-label="Position">
                  {(['bottom', 'top'] as TickerPosition[]).map((p) => (
                    <button key={p} type="button" className={config.ticker.position === p ? 'is-active' : ''}
                      onClick={() => set('ticker', { position: p })}>{p === 'bottom' ? 'Bottom' : 'Top'}</button>
                  ))}
                </div>
              </div>
              <div className="hh-overlays__row">
                <div className="hh-overlays__seg" role="group" aria-label="Speed">
                  {(['slow', 'normal', 'fast'] as TickerSpeed[]).map((s) => (
                    <button key={s} type="button" className={config.ticker.speed === s ? 'is-active' : ''}
                      onClick={() => set('ticker', { speed: s })}>{s === 'slow' ? 'Slow' : s === 'normal' ? 'Normal' : 'Fast'}</button>
                  ))}
                </div>
                <button type="button" className={`hh-btn hh-btn--small ${live.tickerOn ? 'hh-btn--secondary' : 'hh-btn--primary'}`}
                  disabled={!live.tickerOn && !config.ticker.text.trim()} onClick={() => api.setTickerOn(!live.tickerOn)}>
                  {live.tickerOn ? 'Hide' : 'Show'}
                </button>
              </div>
            </section>

            {/* Countdown */}
            <section className="hh-overlays__section">
              <div className="hh-overlays__section-title">Countdown</div>
              <div className="hh-overlays__row">
                <input className="hh-overlays__input" type="text" maxLength={40} value={config.countdown.label}
                  placeholder="Starting in" aria-label="Countdown label"
                  onChange={(e) => set('countdown', { label: editText(e.target.value, 40) })} />
                <label className="hh-overlays__minutes">
                  <input className="hh-overlays__input" type="number" min={1} max={180} value={config.countdown.minutes}
                    onChange={(e) => set('countdown', { minutes: Math.min(180, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
                  <span>min</span>
                </label>
              </div>
              <div className="hh-overlays__row">
                <div className="hh-overlays__seg hh-overlays__seg--wrap" role="group" aria-label="Position while live">
                  {COUNTDOWN_PLACES.map(([p, name]) => (
                    <button key={p} type="button" className={config.countdown.position === p ? 'is-active' : ''}
                      aria-pressed={config.countdown.position === p}
                      onClick={() => set('countdown', { position: p })}>{name}</button>
                  ))}
                </div>
              </div>
              <div className="hh-overlays__row">
                {countdownLeft != null && countdownLeft > -4000
                  ? <span className="hh-overlays__count">{formatCountdown(countdownLeft)}</span>
                  : <span className="hh-overlays__hint">Big on the slates; while live, a small clock where you put it.</span>}
                {live.countdownEndsAt != null && countdownLeft != null && countdownLeft > -4000
                  ? <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" onClick={api.stopCountdown}>Stop</button>
                  : <button type="button" className="hh-btn hh-btn--primary hh-btn--small" onClick={api.startCountdown}>Start</button>}
              </div>
            </section>
          </>
        )}
        {tab === 'break' && brbSection}
        {tab === 'templates' && (
          <>
            {/* Templates */}
            <section className="hh-overlays__section">
              <div className="hh-overlays__section-title">Templates</div>
              {api.templates.length > 0 && (
                <div className="hh-overlays__chips">
                  {api.templates.map((t) => (
                    <span key={t.id} className={`hh-overlays__chip${api.activeTemplate === t.id ? ' is-active' : ''}`}>
                      <button type="button" onClick={() => api.applyTemplate(t.id)} title={`Use ${t.name}`}>{t.name}</button>
                      <button type="button" className="hh-overlays__chip-x" aria-label={`Delete ${t.name}`}
                        onClick={() => { if (window.confirm(`Delete the template "${t.name}"?`)) void api.deleteTemplate(t.id); }}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="hh-overlays__row">
                <input className="hh-overlays__input" type="text" maxLength={40} value={templateName}
                  placeholder={api.activeTemplate ? 'Name (empty: update the selected one)' : 'Template name'}
                  onChange={(e) => setTemplateName(editText(e.target.value, 40))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveAs(); }} />
                <button type="button" className="hh-btn hh-btn--secondary hh-btn--small" disabled={busy || (!templateName.trim() && !api.activeTemplate)}
                  onClick={() => void saveAs()}>Save</button>
              </div>
              {api.templatesError && <p className="hh-overlays__error">{api.templatesError}</p>}
            </section>

            {/* Transitions */}
            <section className="hh-overlays__section">
              <label className="hh-overlays__toggle">
                <input type="checkbox" checked={config.fade} onChange={(e) => update((c) => ({ ...c, fade: e.target.checked }))} />
                <span>Fade between scenes and slates</span>
              </label>
            </section>
          </>
        )}
        {/* Outside the tabs: the music select on the Break tab opens it. */}
        <input ref={fileRef} type="file" accept="audio/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void api.setMusicFile(f); }} />
      </div>
    </div>
  );
  return embedded || typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
