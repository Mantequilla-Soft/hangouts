import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoomInfo } from '@livekit/components-react';
import {
  alertSettings,
  boostPresets,
  goalJustReached,
  goalProgress,
  parseRoomMeta,
  readBoostConfig,
  readBoostGoal,
  readBoostStats,
  tiersEnabled,
  topSupporters,
  type BoostRoomConfig,
  type BoostStats,
  type BoostSupporter,
  type GoalProgress,
  type ResolvedAlertSettings,
} from '../lib/boostGoals.js';

export interface RoomBoostState {
  /** False until the room metadata has arrived (the first render can come
   *  before LiveKit's first sync). */
  loaded: boolean;
  config: BoostRoomConfig | undefined;
  stats: BoostStats;
  goal: GoalProgress | null;
  top: BoostSupporter[];
  tiersOn: boolean;
  presets: number[];
  alerts: ResolvedAlertSettings;
}

/**
 * A room's boost settings and this stream's tally, live from the room metadata
 * (LiveKit pushes every change to every participant). Must be used inside a
 * <LiveKitRoom>.
 */
export function useRoomBoost(): RoomBoostState {
  const { metadata } = useRoomInfo();
  return useMemo(() => {
    const meta = parseRoomMeta(metadata);
    const config = readBoostConfig(meta);
    const stats = readBoostStats(meta);
    return {
      loaded: !!metadata,
      config,
      stats,
      goal: goalProgress(readBoostGoal(config), stats),
      top: topSupporters(stats),
      tiersOn: tiersEnabled(config),
      presets: boostPresets(config),
      alerts: alertSettings(config),
    };
  }, [metadata]);
}

/** How long the "goal reached" celebration shows. */
export const GOAL_CELEBRATION_MS = 6_000;

/**
 * True for a few seconds after this client sees the goal being reached (once
 * per crossing; see goalJustReached). `onReached` fires at the same moment.
 */
export function useGoalCelebration(stats: BoostStats, loaded: boolean, onReached?: () => void): boolean {
  const [celebrating, setCelebrating] = useState(false);
  const seen = useRef<{ first: boolean; stamp: string | undefined }>({ first: true, stamp: undefined });
  const onReachedRef = useRef(onReached);
  onReachedRef.current = onReached;

  useEffect(() => {
    // Nothing to compare against until the metadata is in: the first real
    // metadata is the baseline, not news.
    if (!loaded) return undefined;
    const stamp = stats.goalReachedAt;
    const prev = seen.current;
    const fire = goalJustReached(prev.stamp, stamp, prev.first, Date.now());
    seen.current = { first: false, stamp };
    if (!fire) return undefined;
    setCelebrating(true);
    onReachedRef.current?.();
    const timer = setTimeout(() => setCelebrating(false), GOAL_CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [stats.goalReachedAt, loaded]);

  return celebrating;
}
