import { useState, useCallback, useEffect, useRef } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import { readHandRaisePacket, type DataSender } from '../lib/dataTrust.js';
import { useLiveHost } from './useLiveHost.js';
import type { HandRaiseEvent } from '@snapie/hangouts-core';

const TOPIC = 'hand-raise';

export function useHandRaise() {
  const [raisedHands, setRaisedHands] = useState<Map<string, number>>(new Map());
  const { localParticipant } = useLocalParticipant();

  const isRaised = localParticipant
    ? raisedHands.has(localParticipant.identity)
    : false;

  // Your own hand is the LiveKit sender's; only the host lowers someone else's.
  const { hostIdentity } = useLiveHost();
  const hostRef = useRef(hostIdentity);
  hostRef.current = hostIdentity;

  const onMessage = useCallback((msg: { payload: Uint8Array; from?: DataSender }) => {
    const event = readHandRaisePacket(msg.payload, msg.from, hostRef.current);
    if (!event) return;
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

  /**
   * Lower SOMEONE ELSE's hand — the host clearing a request after accepting or
   * declining it. The event already carries the identity it refers to, so a
   * host-sent "lowered" for a viewer is applied by every client exactly like
   * the viewer sending it themselves; no extra message type is needed.
   */
  const lowerHandFor = useCallback((identity: string) => {
    const event: HandRaiseEvent = {
      type: 'hand_raise',
      raised: false,
      identity,
      timestamp: Date.now(),
    };
    send(new TextEncoder().encode(JSON.stringify(event)), { reliable: true });
    setRaisedHands((prev) => {
      const next = new Map(prev);
      next.delete(identity);
      return next;
    });
  }, [send]);

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
    lowerHandFor,
    isRaised,
  };
}
