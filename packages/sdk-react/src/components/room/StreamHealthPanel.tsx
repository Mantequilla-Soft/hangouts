import { useEffect, useRef, useState } from 'react';
import { describeViewerQuality, type EncoderLimit } from '../../lib/streamHealth.js';
import type { StreamHealthState } from '../../hooks/useStreamHealth.js';

export interface ConnBadge { cls: string; label: string; tip: string }

const LIMIT_TEXT: Record<EncoderLimit, string> = {
  none: 'None',
  bandwidth: 'Your upload',
  cpu: 'Your device (too busy)',
  other: 'Other',
};

/** Seconds a "quality lowered/raised" notice stays on the pill. */
const NOTICE_MS = 12_000;

/**
 * The connection pill, now a button that opens the stream health panel (H20):
 * upload bitrate, frame rate (drawn vs sent), the picture size sent, packet
 * loss, round trip, what limits the encoder, what viewers can get, and the
 * Auto quality switch. The pill keeps its Good / Weak / Lost look, and shows a
 * short note when Auto has just lowered or raised the quality.
 */
export function StreamHealthPanel({ badge, showLabel, state }: {
  badge: ConnBadge;
  /** Show the Good/Weak/Lost word (always on desktop; on a phone only when bad). */
  showLabel: boolean;
  state: StreamHealthState;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const { health: h, assessment: a, level, stepLabel, auto, setAuto, canAuto, lastChange } = state;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Let the notice expire on its own.
  useEffect(() => {
    if (!lastChange) return undefined;
    const left = NOTICE_MS - (Date.now() - lastChange.at);
    if (left <= 0) return undefined;
    const t = window.setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => window.clearTimeout(t);
  }, [lastChange]);
  const notice = lastChange && Date.now() - lastChange.at < NOTICE_MS
    ? (lastChange.dir === 'down' ? 'Quality lowered' : 'Quality back up')
    : null;

  // An early warning even while LiveKit still says "Good": our own reading of
  // the stats is more sensitive.
  const warn = a && a.verdict !== 'good' && badge.cls.includes('--good');
  const cls = warn ? ' hh-studio__conn--poor' : badge.cls;
  const label = warn ? 'Weak' : badge.label;

  return (
    <span className="hh-health" ref={rootRef}>
      <button
        type="button"
        className={`hh-studio__conn${cls} hh-health__pill`}
        title={`${warn ? a!.reasons[0] : badge.tip} Click for stream health.`}
        aria-label={`Connection: ${label}. Stream health`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hh-studio__conn-bars" aria-hidden="true"><i /><i /><i /></span>
        {(showLabel || warn) && <span className="hh-studio__conn-label">{label}</span>}
        {notice && <span className="hh-health__notice">{notice}</span>}
        {!notice && level > 0 && <span className="hh-health__step" aria-label="Quality lowered">▼</span>}
      </button>
      {open && (
        <div className="hh-health__panel" role="dialog" aria-label="Stream health">
          <div className="hh-health__head">
            <span>Stream health</span>
            <button type="button" className="hh-health__close" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          <p className={`hh-health__verdict hh-health__verdict--${a?.verdict ?? 'unknown'}`}>
            {!a ? 'Measuring… numbers appear a few seconds after the stream is published.'
              : a.verdict === 'good' ? 'Healthy. Viewers should get a smooth picture.'
                : a.reasons.slice(0, 2).join('. ')}
          </p>
          {h && (
            <dl className="hh-health__grid">
              <dt>Upload</dt>
              <dd>{h.bitrateKbps} kbps{h.targetKbps > 0 ? ` of ${h.targetKbps}` : ''}</dd>
              <dt>Frame rate</dt>
              <dd>{h.sentFps} fps sent, {h.composedFps} drawn</dd>
              <dt>Dropped frames</dt>
              <dd className={h.droppedPct >= 10 ? 'is-bad' : ''}>{h.droppedPct}%</dd>
              <dt>Picture sent</dt>
              <dd>{h.sentWidth && h.sentHeight ? `${h.sentWidth}×${h.sentHeight}` : 'Nothing yet'}</dd>
              <dt>Packet loss</dt>
              <dd className={h.lossPct >= 3 ? 'is-bad' : ''}>{h.lossPct}%</dd>
              <dt>Round trip</dt>
              <dd className={h.rttMs >= 350 ? 'is-bad' : ''}>{h.rttMs ? `${h.rttMs} ms` : 'n/a'}</dd>
              <dt>Encoder limit</dt>
              <dd className={h.limit !== 'none' ? 'is-bad' : ''}>{LIMIT_TEXT[h.limit]}</dd>
              <dt>Viewers get</dt>
              <dd>{describeViewerQuality(h.viewerHeights)}</dd>
            </dl>
          )}
          <label className="hh-health__auto">
            <input type="checkbox" checked={auto} disabled={!canAuto} onChange={(e) => setAuto(e.target.checked)} />
            <span>
              Auto quality
              <em>
                {!canAuto
                  ? 'This browser cannot change the quality live. Pick a lower quality in Settings if the stream struggles.'
                  : auto
                    ? `Steps the picture down while your upload is weak and back up when it recovers. Now: ${stepLabel}.`
                    : 'Off: the stream keeps the quality you picked, even on a weak upload.'}
              </em>
            </span>
          </label>
        </div>
      )}
    </span>
  );
}
