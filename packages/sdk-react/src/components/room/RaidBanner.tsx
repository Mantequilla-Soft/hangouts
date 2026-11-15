import { useEffect, useRef, useState } from 'react';
import { useRaid, type RaidTargetInfo, type ViewerRaid } from '../../hooks/useRaid.js';
import { fillLabel, liveLabels, type LiveLabels } from '../../lib/liveLabels.js';

export type { RaidTargetInfo };

export interface RaidBannerViewProps {
  raid: ViewerRaid;
  secondsLeft: number;
  labels?: Partial<LiveLabels>;
  onGo: () => void;
  onStay: () => void;
}

/** The countdown card itself (no state), so it can be rendered on its own. */
export function RaidBannerView({ raid, secondsLeft, labels, onGo, onStay }: RaidBannerViewProps) {
  const L = liveLabels(labels);
  return (
    <div className="hh-raid" role="alertdialog" aria-live="assertive" aria-label={fillLabel(L.raidTitle, { host: raid.from })}>
      <div className="hh-raid__count num" aria-hidden="true">{Math.max(0, secondsLeft)}</div>
      <div className="hh-raid__text">
        <strong className="hh-raid__title">{fillLabel(L.raidTitle, { host: raid.from })}</strong>
        <span className="hh-raid__body">{fillLabel(L.raidBody, { title: raid.target.title, seconds: Math.max(0, secondsLeft), host: raid.target.host })}</span>
      </div>
      <div className="hh-raid__actions">
        <button type="button" className="hh-btn hh-btn--small hh-raid__stay" onClick={onStay}>{L.raidStay}</button>
        <button type="button" className="hh-btn hh-btn--primary hh-btn--small hh-raid__go" onClick={onGo}>{L.raidGoNow}</button>
      </div>
    </div>
  );
}

export interface RaidBannerProps {
  roomName: string;
  /** Move the viewer to the target stream. Called once per raid. */
  onRaid: (target: RaidTargetInfo) => void;
  labels?: Partial<LiveLabels>;
}

/**
 * Shown to viewers while the host's raid counts down: who, where to, how long,
 * Go now and Stay here. At zero (or when the server says go) it calls onRaid.
 * Must live inside the room (StandaloneWatch renders it when given `onRaid`).
 */
export function RaidBanner({ roomName, onRaid, labels }: RaidBannerProps) {
  const { raid, clear } = useRaid(roomName);
  const [now, setNow] = useState(() => Date.now());
  const [stayed, setStayed] = useState<string | null>(null);
  const firedRef = useRef<string | null>(null);
  const onRaidRef = useRef(onRaid);
  onRaidRef.current = onRaid;

  useEffect(() => {
    if (!raid) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [raid]);

  const active = raid && stayed !== raid.id ? raid : null;
  const secondsLeft = active ? Math.ceil((active.endsAtLocal - now) / 1000) : 0;
  const due = !!active && (active.go || secondsLeft <= 0);

  useEffect(() => {
    if (!active || !due || firedRef.current === active.id) return;
    firedRef.current = active.id;
    onRaidRef.current(active.target);
    clear();
  }, [active, due, clear]);

  if (!active || due) return null;
  return (
    <RaidBannerView
      raid={active}
      secondsLeft={secondsLeft}
      labels={labels}
      onGo={() => {
        firedRef.current = active.id;
        onRaidRef.current(active.target);
        clear();
      }}
      onStay={() => setStayed(active.id)}
    />
  );
}
