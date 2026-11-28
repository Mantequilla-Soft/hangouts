import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent, type RemoteParticipant } from 'livekit-client';
import { HangoutsContext } from '../context/HangoutsContext.js';
import { readBountyPacket, readPollSuggestionPacket, readRewardsPacket, type DataSender } from '../lib/dataTrust.js';
import {
  shopApi, upsertById,
  type Bounty, type ChannelReward, type PollSuggestion, type Redemption,
} from '../lib/pointsShop.js';

/**
 * The host's side of the points shop: suggested polls, the channel rewards
 * and their queue, bounties. Each list is read once over HTTP and then kept
 * current from its server topic. Outside a LiveKit room (an OBS dock page that
 * does not join) there is no data channel, so the list is read again every
 * 20 seconds instead.
 */

const POLL_WITHOUT_ROOM_MS = 20_000;

/**
 * Server packets on `topic` when this component is inside a LiveKit room;
 * false outside one. Uses the room's event directly (not useDataChannel), so
 * the panels also mount where there is no room.
 */
export function useServerTopic(topic: string, onPacket: (payload: Uint8Array, from: DataSender) => void): boolean {
  const room = useMaybeRoomContext();
  const cb = useRef(onPacket);
  cb.current = onPacket;
  useEffect(() => {
    if (!room) return undefined;
    const handler = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, t?: string) => {
      if (t === topic) cb.current(payload, participant);
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room, topic]);
  return !!room;
}

interface LiveListOptions<T> {
  /** Null: nothing to read (no room name, no host). */
  load: (() => Promise<T[]>) | null;
  /** Changes when `load` reads something else. */
  key: string;
  topic: string;
  /** The list after one packet, or null to ignore it. */
  reduce: (list: T[], payload: Uint8Array, from: DataSender) => T[] | null;
}

function useLiveList<T>({ load, key, topic, reduce }: LiveListOptions<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(!!load);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) { setLoading(false); return; }
    try {
      setItems(await fn());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setItems([]); setLoading(!!loadRef.current); void refresh(); }, [key, refresh]);

  const inRoom = useServerTopic(topic, (payload, from) => {
    setItems((list) => reduce(list, payload, from) ?? list);
  });

  useEffect(() => {
    if (inRoom || !loadRef.current) return undefined;
    const t = setInterval(() => { void refresh(); }, POLL_WITHOUT_ROOM_MS);
    return () => clearInterval(t);
  }, [inRoom, key, refresh]);

  return { items, setItems, loading, error, setError, refresh };
}

/** One host action at a time per row: which id is busy, and the server's message. */
function useAction() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <R,>(id: string, fn: () => Promise<R>): Promise<R | null> => {
    setBusyId(id);
    setError(null);
    try { return await fn(); } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      return null;
    } finally { setBusyId(null); }
  }, []);
  return { busyId, error, run };
}

function useShopCtx() {
  const ctx = useContext(HangoutsContext);
  return {
    base: ctx?.apiBaseUrl ?? '',
    token: () => ctx?.apiClient.getSessionToken() ?? null,
    username: ctx?.username ?? null,
  };
}

/** Polls viewers suggested (and paid for), waiting for the host or a mod. */
export function usePollSuggestions(roomName: string) {
  const { base, token } = useShopCtx();
  const list = useLiveList<PollSuggestion>({
    load: base && roomName ? () => shopApi.suggestions(base, roomName) : null,
    key: `${base}|${roomName}`,
    topic: 'poll',
    reduce: (l, payload, from) => {
      const p = readPollSuggestionPacket(payload, from);
      if (!p) return null;
      return p.type === 'poll-suggestion' ? upsertById(l, p.suggestion) : l.filter((s) => s.id !== p.id);
    },
  });
  const action = useAction();
  const drop = (id: string) => list.setItems((l) => l.filter((s) => s.id !== id));
  const accept = useCallback(async (id: string, durationSec?: number) => {
    const r = await action.run(id, () => shopApi.acceptSuggestion(base, roomName, id, token(), durationSec));
    if (r) drop(id);
    return !!r;
  }, [base, roomName]); // eslint-disable-line react-hooks/exhaustive-deps
  const reject = useCallback(async (id: string) => {
    const r = await action.run(id, () => shopApi.rejectSuggestion(base, roomName, id, token()));
    if (r) drop(id);
    return !!r;
  }, [base, roomName]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    suggestions: list.items, loading: list.loading, error: action.error ?? list.error,
    busyId: action.busyId, accept, reject, refresh: list.refresh,
  };
}

/** What viewers redeemed from the host's channel rewards, oldest first. */
export function useRewardQueue(roomName: string) {
  const { base, token } = useShopCtx();
  const list = useLiveList<Redemption>({
    load: base && roomName ? () => shopApi.rewardQueue(base, roomName, token()) : null,
    key: `${base}|${roomName}`,
    topic: 'rewards',
    reduce: (l, payload, from) => {
      const p = readRewardsPacket(payload, from);
      if (!p) return null;
      return p.type === 'reward-redeemed' ? upsertById(l, p.redemption) : l.filter((r) => r.id !== p.id);
    },
  });
  const action = useAction();
  const act = useCallback(async (id: string, what: 'done' | 'refund') => {
    const r = await action.run(id, () => shopApi.rewardAction(base, roomName, id, what, token()));
    if (r) list.setItems((l) => l.filter((x) => x.id !== id));
    return !!r;
  }, [base, roomName]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    queue: list.items, loading: list.loading, error: action.error ?? list.error, busyId: action.busyId,
    done: (id: string) => act(id, 'done'), refund: (id: string) => act(id, 'refund'), refresh: list.refresh,
  };
}

/** A channel's rewards (GET /channels/:owner/rewards), and saving the host's own (PUT /channels/rewards). */
export function useChannelRewards(owner: string | null | undefined) {
  const { base, token } = useShopCtx();
  const o = owner?.toLowerCase() ?? '';
  const [rewards, setRewards] = useState<ChannelReward[]>([]);
  const [loading, setLoading] = useState(!!o);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!base || !o) { setLoading(false); return undefined; }
    let gone = false;
    setLoading(true);
    shopApi.rewards(base, o)
      .then((r) => { if (!gone) { setRewards(r); setError(null); } })
      .catch((err: unknown) => { if (!gone) setError(err instanceof Error ? err.message : 'Network error'); })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [base, o]);
  const save = useCallback(async (next: ChannelReward[]) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await shopApi.saveRewards(base, next, token());
      setRewards(saved);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      return null;
    } finally { setSaving(false); }
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rewards, loading, error, saving, save };
}

/** The stream's open bounties; the host closes them (done pays, decline gives back). */
export function useBounties(roomName: string) {
  const { base, token } = useShopCtx();
  const list = useLiveList<Bounty>({
    load: base && roomName ? () => shopApi.bounties(base, roomName) : null,
    key: `${base}|${roomName}`,
    topic: 'bounty',
    reduce: (l, payload, from) => {
      const p = readBountyPacket(payload, from);
      if (!p) return null;
      return p.bounty.status === 'open' ? upsertById(l, p.bounty) : l.filter((b) => b.id !== p.bounty.id);
    },
  });
  const action = useAction();
  const act = useCallback(async (id: string, what: 'done' | 'decline') => {
    const r = await action.run(id, async () => { await shopApi.bountyAction(base, roomName, id, what, token()); return true; });
    if (r) list.setItems((l) => l.filter((x) => x.id !== id));
    return !!r;
  }, [base, roomName]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    bounties: list.items, loading: list.loading, error: action.error ?? list.error, busyId: action.busyId,
    done: (id: string) => act(id, 'done'), decline: (id: string) => act(id, 'decline'), refresh: list.refresh,
  };
}
