import { useState, useCallback, useEffect } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import type { HandRaiseEvent } from '@snapie/hangouts-core';

const TOPIC = 'hand-raise';

export function useHandRaise() {
  const [raisedHands, setRaisedHands] = useState<Map<string, number>>(new Map());
  const { localParticipant } = useLocalParticipant();

  const isRaised = localParticipant
    ? raisedHands.has(localParticipant.identity)
    : false;

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const event: HandRaiseEvent = JSON.parse(text);
      if (event.type !== 'hand_raise') return;

      setRaisedHands((prev) => {
        const next = new Map(prev);
        const existing = next.get(event.identity);
        // Only accept newer events
        if (existing && existing > event.timestamp) return prev;

        if (event.raised) {
          next.set(event.identity, event.timestamp);
        } else {
          next.delete(event.identity);
        }
        return next;
      });
    } catch { /* ignore malformed messages */ }
  }, []);

  const { send } = useDataChannel(TOPIC, onMessage);

  const raiseHand = useCallback(() => {
    if (!localParticipant) return;
    const event: HandRaiseEvent = {
      type: 'hand_raise',
      raised: true,
      identity: localParticipant.identity,
      timestamp: Date.now(),
    };
    const payload = new TextEncoder().encode(JSON.stringify(event));
    send(payload, { reliable: true });
    setRaisedHands((prev) => new Map(prev).set(localParticipant.identity, event.timestamp));
  }, [localParticipant, send]);

  const lowerHand = useCallback(() => {
    if (!localParticipant) return;
    const event: HandRaiseEvent = {
      type: 'hand_raise',
      raised: false,
      identity: localParticipant.identity,
      timestamp: Date.now(),
    };
    const payload = new TextEncoder().encode(JSON.stringify(event));
    send(payload, { reliable: true });
    setRaisedHands((prev) => {
      const next = new Map(prev);
      next.delete(localParticipant.identity);
      return next;
    });
  }, [localParticipant, send]);

  // Clear hand when participant gets promoted (canPublish changes to true)
  useEffect(() => {
    if (localParticipant?.permissions?.canPublish && isRaised) {
      lowerHand();
    }
  }, [localParticipant?.permissions?.canPublish]);

  return {
    raisedHands,
    raiseHand,
    lowerHand,
    isRaised,
  };
}
