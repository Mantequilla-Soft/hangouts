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
  /**
   * Client-side enrichment flag. True when the boost was ≥ $0.01 but
   * below the host's configured minBoostUsd floor. These are recorded in
   * history but suppressed from the live overlay.
   */
  belowMinimum?: boolean;
}

const TOPIC = 'boost';
const SUB_PENNY = 0.01;

const BoostStoreContext = createContext<BoostEvent[]>([]);

interface ProviderProps {
  children: ReactNode;
  /**
   * Host's configured minimum USD floor (from room metadata).
   * Boosts below this threshold (but ≥ $0.01) are stored with
   * belowMinimum: true and suppressed from the overlay.
   */
  minBoostUsd?: number;
}

/**
 * Mount once inside <LiveKitRoom>. All useBoostStore() calls anywhere in
 * the tree read the same accumulated list.
 */
export function BoostStoreProvider({ children, minBoostUsd = 0 }: ProviderProps) {
  const [boosts, setBoosts] = useState<BoostEvent[]>([]);

  // Ref so the stable onMessage callback always sees the latest floor
  // without needing to re-subscribe to the data channel on every render.
  const minUsdRef = useRef(minBoostUsd);
  useEffect(() => { minUsdRef.current = minBoostUsd; }, [minBoostUsd]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as BoostEvent;
      if (parsed.type !== 'boost') return;

      // Hard discard: sub-penny boosts are spam, store nothing.
      if (parsed.usdAmount < SUB_PENNY) return;

      // Below-minimum: legitimate payment but below the host's floor.
      // Record in history but flag for suppression in the overlay.
      const minUsd = minUsdRef.current;
      const enriched: BoostEvent =
        minUsd > 0 && parsed.usdAmount < minUsd
          ? { ...parsed, belowMinimum: true }
          : parsed;

      setBoosts((prev) => [...prev, enriched].slice(-100));
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
 * Standalone hook for contexts without a BoostStoreProvider (e.g. a custom
 * room UI or the OBS overlay). Creates its own local subscription.
 * Applies the same sub-penny hard-discard as BoostStoreProvider.
 */
export function useBoosts() {
  const [boosts, setBoosts] = useState<BoostEvent[]>([]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as BoostEvent;
      if (parsed.type !== 'boost') return;
      if (parsed.usdAmount < SUB_PENNY) return;
      setBoosts((prev) => [...prev, parsed].slice(-100));
    } catch {
      // ignore malformed payloads
    }
  }, []);

  useDataChannel(TOPIC, onMessage);

  return { boosts };
}
