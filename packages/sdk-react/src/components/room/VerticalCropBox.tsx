import { useEffect, useRef } from 'react';
import type { VerticalOutputApi } from '../../hooks/useVerticalOutput.js';
import type { VerticalFollow, VerticalMode } from '../../lib/verticalCrop.js';

/**
 * The 9:16 phone crop over the landscape preview (H19). Drag it sideways to
 * choose what phone viewers see; while it follows the camera or the source it
 * glides on its own. Positioned straight from the compositor's crop centre
 * every animation frame, so the box is exactly what goes out.
 */
export function VerticalCropBox({ api }: { api: VerticalOutputApi }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; startX: number; startCenter: number; width: number } | null>(null);
  const { output } = api;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = boxRef.current;
      if (el) {
        const w = output.widthFrac;
        el.style.width = `${(w * 100).toFixed(3)}%`;
        el.style.left = `${((output.center - w / 2) * 100).toFixed(3)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [output]);

  return (
    <div
      ref={boxRef}
      className={`hh-vcrop${api.prefs.follow !== 'manual' ? ' hh-vcrop--follow' : ''}`}
      title="Phone view: drag sideways to choose what phone viewers see"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const frame = boxRef.current?.parentElement?.getBoundingClientRect();
        if (!frame) return;
        dragRef.current = { id: e.pointerId, startX: e.clientX, startCenter: output.center, width: frame.width };
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* old browsers */ }
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || d.id !== e.pointerId || !d.width) return;
        api.setManual(d.startCenter + (e.clientX - d.startX) / d.width);
      }}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerCancel={() => { dragRef.current = null; }}
    >
      <span className="hh-vcrop__label">Phone view</span>
    </div>
  );
}

const MODES: Array<{ value: VerticalMode; label: string; desc: string }> = [
  { value: 'off', label: 'Off', desc: 'Landscape only. Phone viewers can still crop it themselves.' },
  { value: 'track', label: 'Send a vertical video', desc: 'A second 9:16 video for phones, with your overlays laid out for it. Uses a bit more upload and processing.' },
  { value: 'crop', label: 'Crop on viewers’ phones', desc: 'No second video. Phones show your landscape picture cropped where the box is. Overlays near the edges may be cut off.' },
];

const FOLLOWS: Array<{ value: VerticalFollow; label: string }> = [
  { value: 'manual', label: 'Where I put it' },
  { value: 'camera', label: 'Follow the camera' },
  { value: 'source', label: 'Follow the source' },
];

/** The phone version group for the studio's Settings tab. */
export function VerticalSettings({ api }: { api: VerticalOutputApi }) {
  if (!api.available) return null;
  return (
    <div className="hh-settings__group hh-vsettings">
      <div className="hh-settings__title"><span className="hh-settings__icon" aria-hidden="true">📱</span>Phone version</div>
      <p className="hh-settings__intro">Phone viewers holding their phone upright get a vertical picture. Desktop viewers keep the landscape one.</p>
      {MODES.map((m) => (
        <button key={m.value} type="button"
          className={`hh-optsheet__opt${api.prefs.mode === m.value ? ' hh-optsheet__opt--on' : ''}`}
          onClick={() => api.setMode(m.value)}>
          <span className="hh-optsheet__opt-label">{m.label}{api.prefs.mode === m.value ? ' ✓' : ''}</span>
          <span className="hh-optsheet__opt-desc">{m.desc}</span>
        </button>
      ))}
      {api.prefs.mode !== 'off' && (
        <div className="hh-vsettings__follow" role="group" aria-label="Phone crop">
          {FOLLOWS.map((f) => (
            <button key={f.value} type="button"
              className={`hh-vsettings__chip${api.prefs.follow === f.value ? ' is-active' : ''}`}
              onClick={() => api.setFollow(f.value)}>{f.label}</button>
          ))}
        </div>
      )}
      {api.prefs.mode !== 'off' && <p className="hh-settings__intro">Drag the Phone view box in the preview to place it.</p>}
      {api.error && <p className="hh-vsettings__error">{api.error}</p>}
    </div>
  );
}
