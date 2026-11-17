import { useRoomBoost, useGoalCelebration } from '../../hooks/useRoomBoost.js';
import { useBoosts } from '../../hooks/useBoosts.js';
import { useBoostAlerts, type BoostAlertOptions } from '../../hooks/useBoostAlerts.js';
import { fillLabel, formatHbd, type BoostSupporter } from '../../lib/boostGoals.js';
import { playBoostChime } from '../../lib/boostChime.js';
import { boostLabels, type BoostLabels } from '../../lib/boostLabels.js';

export interface StreamBoostGoalProps {
  /** `overlay`: over the video where the host put it (goal.position: a band
   *  along the bottom or top, or a small card in a corner). `inline`: a block
   *  in a panel or dialog. */
  variant?: 'overlay' | 'inline';
  labels?: Partial<BoostLabels>;
  className?: string;
}

/**
 * The host's boost goal ("50 HBD for a new mic") and how far this stream has
 * got, live from the room metadata. Renders nothing without a goal. When the
 * goal is reached while someone watches, it celebrates once for a few
 * seconds, then stays full with a "reached" state.
 *
 * Use inside <StandaloneWatch> (viewers), the studio or any <LiveKitRoom>.
 */
export function StreamBoostGoal({ variant = 'overlay', labels, className }: StreamBoostGoalProps) {
  const { goal, stats, loaded } = useRoomBoost();
  const celebrating = useGoalCelebration(stats, loaded);
  if (!goal) return null;
  const L = boostLabels(labels);
  const title = goal.title || L.goalDefaultTitle;
  const progress = fillLabel(L.goalProgress, { progress: formatHbd(goal.progressHbd), target: formatHbd(goal.targetHbd) });
  const cls = [
    'hh-boost-goal',
    `hh-boost-goal--${variant}`,
    variant === 'overlay' ? `hh-boost-goal--pos-${goal.position}` : '',
    goal.reached ? 'hh-boost-goal--reached' : '',
    celebrating ? 'hh-boost-goal--celebrate' : '',
    className ?? '',
  ].filter(Boolean).join(' ');
  return (
    <div className={cls} role="group" aria-label={title}>
      <div className="hh-boost-goal__row">
        <span className="hh-boost-goal__title">{title}</span>
        <span className="hh-boost-goal__amount">{progress}</span>
      </div>
      <div
        className="hh-boost-goal__track"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={goal.targetHbd}
        aria-valuenow={Math.min(goal.progressHbd, goal.targetHbd)}
        aria-valuetext={progress}
      >
        <span className="hh-boost-goal__fill" style={{ width: `${(goal.fraction * 100).toFixed(1)}%` }} />
      </div>
      {celebrating && (
        <div className="hh-boost-goal__celebrate" aria-live="polite">{L.goalReached}</div>
      )}
    </div>
  );
}

export interface BoostTopSupportersProps {
  labels?: Partial<BoostLabels>;
  className?: string;
  /** Override the list (e.g. from GET /rooms/:name/boost/summary); defaults
   *  to the live room metadata. */
  supporters?: BoostSupporter[];
}

/** This stream's top 5 supporters by total boosted. Nothing before the first boost. */
export function BoostTopSupporters({ labels, className, supporters }: BoostTopSupportersProps) {
  const { top } = useRoomBoost();
  const list = supporters ?? top;
  if (list.length === 0) return null;
  const L = boostLabels(labels);
  return (
    <div className={`hh-boost-top${className ? ` ${className}` : ''}`}>
      <div className="hh-boost-top__title">{L.topSupporters}</div>
      <ol className="hh-boost-top__list">
        {list.map((s, i) => (
          <li key={s.account} className="hh-boost-top__item">
            <span className="hh-boost-top__rank">{i + 1}</span>
            <span className="hh-boost-top__name">@{s.displayName || s.account}</span>
            <span className="hh-boost-top__amount">{fillLabel(L.supporterAmount, { amount: formatHbd(s.hbd) })}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface BoostAlertsProps extends BoostAlertOptions {}

/**
 * Invisible: plays the host's boost alerts (chime, optional read-aloud, and a
 * run of notes when the goal is reached) per the room's alert settings. For a
 * surface without the studio, e.g. an OBS Browser Source or dock that joins
 * the room as an observer. Mount inside that surface's <LiveKitRoom>. The
 * studio plays its own alerts; don't mount this next to it.
 */
export function BoostAlerts(options: BoostAlertsProps) {
  const { boosts } = useBoosts();
  const { alerts, stats, loaded } = useRoomBoost();
  useBoostAlerts(boosts, alerts, options);
  useGoalCelebration(stats, loaded, () => {
    if (alerts.sound && !options.muted) playBoostChime('goal');
  });
  return null;
}
