import { useCallback, useState } from 'react';
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

export function useBoosts() {
  const [boosts, setBoosts] = useState<BoostEvent[]>([]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as BoostEvent;
      if (parsed.type !== 'boost') return;
      setBoosts((prev) => [...prev, parsed].slice(-100));
    } catch {
      // ignore malformed boost payloads
    }
  }, []);

  useDataChannel(TOPIC, onMessage);

  return { boosts };
}
