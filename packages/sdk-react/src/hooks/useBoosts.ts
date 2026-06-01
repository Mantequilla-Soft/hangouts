import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, createElement } from 'react';
import { useDataChannel } from '@livekit/components-react';

export interface BoostEvent {
  type: 'boost';
  id: string;
  room: string;
  sender: string;
  displayName?: string;
  message: string;
  amount: string;
  asset: 'HIVE' | 'HBD';
  usdAmount: number;
  feeAmount: string;
  payoutAmount: string;
  recipient: string;
  txId: string;
  blockNum: number;
  timestamp: number;
  /** Server-stamped: amount was below the host's minBoostUsd floor.
   *  Overlay is suppressed; history panel shows a badge. */
  belowMinimum?: boolean;
}

const TOPIC = 'boost';
const SUB_PENNY = 0.01;

// sessionStorage key — versioned so old cached data is ignored on schema changes
const sessionKey = (roomName: string) => `hh-boosts-v1-${roomName}`;

function loadSession(roomName: string): BoostEvent[] {
  try {
    const raw = sessionStorage.getItem(sessionKey(roomName));
    return raw ? (JSON.parse(raw) as BoostEvent[]) : [];
  } catch {
    return [];
  }
}

function saveSession(roomName: string, boosts: BoostEvent[]): void {
  try {
    sessionStorage.setItem(sessionKey(roomName), JSON.stringify(boosts));
  } catch {
    // sessionStorage unavailable (SSR, private mode quota) — fail silently
  }
}

const BoostStoreContext = createContext<BoostEvent[]>([]);

interface ProviderProps {
  children: ReactNode;
  roomName?: string;
  minBoostUsd?: number;
}

/**
 * Mount once inside <LiveKitRoom>. Subscribes to boost data channel events,
 * persists the list to sessionStorage so history survives reconnects, and
 * shares the accumulated list via context.
 */
export function BoostStoreProvider({ children, roomName, minBoostUsd = 0 }: ProviderProps) {
  const [boosts, setBoosts] = useState<BoostEvent[]>(() =>
    roomName ? loadSession(roomName) : [],
  );

  // Keep the floor ref fresh without re-subscribing to the data channel
  const minUsdRef = useRef(minBoostUsd);
  useEffect(() => { minUsdRef.current = minBoostUsd; }, [minBoostUsd]);

  // Persist to sessionStorage whenever the list changes
  useEffect(() => {
    if (roomName) saveSession(roomName, boosts);
  }, [boosts, roomName]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as BoostEvent;
      if (parsed.type !== 'boost') return;

      // Hard discard: sub-penny boosts are spam
      if (parsed.usdAmount < SUB_PENNY) return;

      // belowMinimum is now stamped by the server; keep client check as
      // defense-in-depth for any deployment running an older server.
      const minUsd = minUsdRef.current;
      const enriched: BoostEvent =
        !parsed.belowMinimum && minUsd > 0 && parsed.usdAmount < minUsd
          ? { ...parsed, belowMinimum: true }
          : parsed;

      setBoosts((prev) => {
        // Deduplicate by id in case the event is delivered more than once
        if (prev.some((b) => b.id === enriched.id)) return prev;
        return [...prev, enriched].slice(-100);
      });
    } catch {
      // ignore malformed payloads
    }
  }, []);

  useDataChannel(TOPIC, onMessage);

  return createElement(BoostStoreContext.Provider, { value: boosts }, children);
}

/** Read the shared boost list from anywhere inside the room tree. */
export function useBoostStore(): BoostEvent[] {
  return useContext(BoostStoreContext);
}

/**
 * Standalone hook for custom room UIs (e.g. OBS overlay).
 * Creates its own local subscription. Applies sub-penny hard-discard.
 */
export function useBoosts() {
  const [boosts, setBoosts] = useState<BoostEvent[]>([]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as BoostEvent;
      if (parsed.type !== 'boost') return;
      if (parsed.usdAmount < SUB_PENNY) return;
      setBoosts((prev) => {
        if (prev.some((b) => b.id === parsed.id)) return prev;
        return [...prev, parsed].slice(-100);
      });
    } catch {
      // ignore malformed payloads
    }
  }, []);

  useDataChannel(TOPIC, onMessage);

  return { boosts };
}
