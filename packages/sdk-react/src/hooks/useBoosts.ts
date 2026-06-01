import { createContext, useCallback, useContext, useState, type ReactNode, createElement } from 'react';
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
}

const TOPIC = 'boost';

// Shared context so all consumers (BoostOverlay, BoostHistoryPanel, OBS feed)
// read from the same accumulated list regardless of when they mount.
const BoostStoreContext = createContext<BoostEvent[]>([]);

interface ProviderProps {
  children: ReactNode;
}

/**
 * Mount once inside <LiveKitRoom>. All useBoostStore() calls anywhere in
 * the tree will read the same list.
 */
export function BoostStoreProvider({ children }: ProviderProps) {
  const [boosts, setBoosts] = useState<BoostEvent[]>([]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as BoostEvent;
      if (parsed.type !== 'boost') return;
      setBoosts((prev) => [...prev, parsed].slice(-100));
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
 * Standalone hook for contexts without a BoostStoreProvider (e.g. the OBS
 * overlay which manages its own LiveKitRoom). Creates a local subscription.
 */
export function useBoosts() {
  const [boosts, setBoosts] = useState<BoostEvent[]>([]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as BoostEvent;
      if (parsed.type !== 'boost') return;
      setBoosts((prev) => [...prev, parsed].slice(-100));
    } catch {
      // ignore malformed payloads
    }
  }, []);

  useDataChannel(TOPIC, onMessage);

  return { boosts };
}
