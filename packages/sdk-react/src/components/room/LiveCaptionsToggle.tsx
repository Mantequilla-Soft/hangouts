import type { StudioCaptions } from '../../hooks/useStudioCaptions.js';
import type { StudioCaptionStatus } from '../../lib/captionPublisher.js';

/** The studio's captions setting text. Integrators pass translations. */
export interface StudioCaptionLabels {
  title: string;
  toggle: string;
  hint: string;
  language: string;
  /** With one language: `{lang}` is its name. */
  onlyLanguage: string;
  statusOff: string;
  statusWaiting: string;
  statusMicOff: string;
  statusStarting: string;
  statusOn: string;
  statusFull: string;
  statusUnavailable: string;
  statusError: string;
}

export const DEFAULT_STUDIO_CAPTION_LABELS: StudioCaptionLabels = {
  title: 'Live captions',
  toggle: 'Show live captions to viewers',
  hint: 'While you are live, your microphone is turned into text. Viewers can switch captions on, and many browsers translate them into the viewer\'s language.',
  language: 'Language you speak',
  onlyLanguage: 'Captions understand {lang} only.',
  statusOff: 'Off',
  statusWaiting: 'Starts when you go live.',
  statusMicOff: 'Turn your microphone on for captions.',
  statusStarting: 'Starting captions…',
  statusOn: 'Captions are on.',
  statusFull: 'All caption slots are in use right now. Trying again in a minute.',
  statusUnavailable: 'Live captions are not available right now.',
  statusError: 'Captions stopped: the speech service could not be reached. Switch them off and on to try again.',
};

const STATUS_KEY: Record<StudioCaptionStatus, keyof StudioCaptionLabels> = {
  off: 'statusOff',
  waiting: 'statusWaiting',
  'mic-off': 'statusMicOff',
  starting: 'statusStarting',
  on: 'statusOn',
  full: 'statusFull',
  unavailable: 'statusUnavailable',
  error: 'statusError',
};

/** The studio settings block for live captions. Renders nothing when not offered. */
export function LiveCaptionsToggle({ captions }: { captions: StudioCaptions }) {
  if (!captions.supported) return null;
  const L = { ...DEFAULT_STUDIO_CAPTION_LABELS, ...captions.labels };
  const { status } = captions;
  return (
    <div className="hh-settings__group hh-captions-setting">
      <div className="hh-settings__title">
        <span className="hh-settings__icon" aria-hidden="true">💬</span>{L.title}
      </div>
      <label className="hh-post__vod">
        <input
          type="checkbox"
          checked={captions.enabled}
          onChange={(e) => captions.setEnabled(e.target.checked)}
        />
        <span>
          {L.toggle}
          <em className="hh-post__vod-hint">{L.hint}</em>
        </span>
      </label>
      {captions.languages.length === 1 && (
        <p className="hh-captions-setting__only">{L.onlyLanguage.replace('{lang}', captions.languages[0].label)}</p>
      )}
      {captions.languages.length > 1 && (
        <label className="hh-captions-setting__lang">
          <span>{L.language}</span>
          <select value={captions.lang} onChange={(e) => captions.setLang(e.target.value)}>
            {captions.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
      )}
      {captions.enabled && (
        <p className={`hh-captions-setting__status hh-captions-setting__status--${status}`} role="status">
          {status === 'on' && <span className="hh-captions-setting__dot" aria-hidden="true" />}
          {L[STATUS_KEY[status]]}
        </p>
      )}
    </div>
  );
}
