import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRoomInfo } from '@livekit/components-react';
import {
  battleOnAir, battlePhase, battleSide, DROP_GRACE_MS, otherSide, readBattle,
  type Battle, type BattlePhase, type BattleSide, type BattleSideKey,
} from '../lib/battle.js';
import { useBattleLink, type BattleLinkGrant, type BattleLinkState } from './useBattleLink.js';

/** A clock that ticks every `everyMs` while `on`, for countdowns. */
export function useNow(on: boolean, everyMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [on, everyMs]);
  return now;
}

export interface RoomBattleState {
  battle: Battle | null;
  phase: BattlePhase | null;
  /** This room's side, and the other one. */
  side: BattleSideKey | null;
  me: BattleSide | null;
  them: BattleSide | null;
  now: number;
}

/**
 * The battle this room is in, live from the room metadata, with its phase
 * re-derived twice a second (the countdown). Use inside a <LiveKitRoom>.
 * `all` also reports declined / expired invites as a result (the studios).
 */
export function useRoomBattle(options: { all?: boolean; host?: string } = {}): RoomBattleState {
  const { metadata, name } = useRoomInfo();
  const battle = useMemo(() => readBattle(metadata), [metadata]);
  const ticking = !!battle && (battle.state !== 'ended' || Date.now() - Date.parse(battle.endedAt ?? '') < 60_000);
  const now = useNow(ticking);
  const phase = battlePhase(battle, now, options.all);
  const side = battle ? battleSide(battle, name, options.host) : null;
  return {
    battle,
    phase,
    side,
    me: battle && side ? battle[side] : null,
    them: battle && side ? battle[otherSide(side)] : null,
    now,
  };
}

export interface StudioBattleApi {
  post: (path: string, body?: unknown) => Promise<unknown>;
  get: (path: string) => Promise<unknown>;
}

export interface BattleCandidate { room: string; host: string; title?: string; thumbnail?: string }

export interface StudioBattle extends RoomBattleState {
  link: BattleLinkState;
  onAir: boolean;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  invite: (opponent: string, durationSec: number) => Promise<boolean>;
  respond: (accept: boolean) => Promise<void>;
  end: () => Promise<void>;
  candidates: () => Promise<BattleCandidate[]>;
  hear: boolean;
  setHear: (v: boolean) => void;
}

/**
 * Everything the studio needs for a battle: the state from the room
 * metadata, the actions, the cross-room link while it is on air, and two
 * safety nets the server cannot run on its own after a restart: settle the
 * battle once its clock and grace have run out, and end it when the other
 * host has been gone for DROP_GRACE_MS (or their stream ended).
 */
export function useStudioBattle(roomName: string, host: string, serverUrl: string | undefined, api: StudioBattleApi): StudioBattle {
  const room = useRoomBattle({ all: true, host });
  const { battle, phase } = room;
  const onAir = battleOnAir(phase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hear, setHear] = useState(true);
  const apiRef = useRef(api);
  apiRef.current = api;
  const base = `/battles/${encodeURIComponent(roomName)}`;

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try { return await fn(); } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return null;
    } finally { setBusy(false); }
  }, []);

  const invite = useCallback(async (opponent: string, durationSec: number) =>
    (await run(() => apiRef.current.post(`${base}/invite`, { opponent, durationSec }))) !== null, [run, base]);
  const respond = useCallback(async (accept: boolean) => { await run(() => apiRef.current.post(`${base}/respond`, { accept })); }, [run, base]);
  const end = useCallback(async () => { await run(() => apiRef.current.post(`${base}/end`, { reason: 'ended' })); }, [run, base]);
  const candidates = useCallback(async () => {
    const res = await apiRef.current.get('/battles/candidates') as { streams?: BattleCandidate[] };
    return Array.isArray(res?.streams) ? res.streams : [];
  }, []);

  const fetchGrant = useCallback(async () => (await apiRef.current.post(`${base}/link`, {})) as BattleLinkGrant, [base]);
  // The link stays up through the result banner's first seconds too, so the
  // split screen doesn't collapse the instant the clock settles.
  const link = useBattleLink(onAir && !!battle, serverUrl, fetchGrant, { hear });

  // Settle once the grace is over (the server's own timer normally beats us
  // to it; this covers a server restart). Retries every few seconds.
  const settleAt = battle?.state === 'live' ? Date.parse(battle.settleAt ?? '') : NaN;
  const battleId = battle?.id;
  useEffect(() => {
    if (!Number.isFinite(settleAt)) return undefined;
    let t: ReturnType<typeof setTimeout>;
    const attempt = () => {
      void apiRef.current.post(`${base}/settle`, {}).catch(() => {
        t = setTimeout(attempt, 5000);
      });
    };
    t = setTimeout(attempt, Math.max(0, settleAt - Date.now()) + 1500);
    return () => clearTimeout(t);
  }, [settleAt, battleId, base]);

  // The other host gone: their room deleted (they ended the stream) ends the
  // battle now; otherwise after DROP_GRACE_MS without them.
  const gone = onAir && phase !== 'starting' && link.connected === false && link.roomGone;
  const away = onAir && phase === 'live' && !link.opponentHere;
  useEffect(() => {
    if (!gone && !away) return undefined;
    const t = setTimeout(() => {
      void apiRef.current.post(`${base}/end`, { reason: 'dropped' }).catch(() => { /* still there, or already over */ });
    }, gone ? 0 : DROP_GRACE_MS);
    return () => clearTimeout(t);
  }, [gone, away, battleId, base]);

  return {
    ...room,
    link,
    onAir,
    busy,
    error,
    clearError: () => setError(null),
    invite,
    respond,
    end,
    candidates,
    hear,
    setHear,
  };
}
