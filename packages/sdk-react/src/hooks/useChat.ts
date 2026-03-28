import { useState, useCallback } from 'react';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';

export interface ChatMessage {
  id: string;
  identity: string;
  text: string;
  timestamp: number;
}

const TOPIC = 'chat';

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { localParticipant } = useLocalParticipant();

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const parsed = JSON.parse(text);
      if (parsed.type !== 'chat') return;

      const chatMsg: ChatMessage = {
        id: `${parsed.identity}-${parsed.timestamp}`,
        identity: parsed.identity,
        text: parsed.text,
        timestamp: parsed.timestamp,
      };

      setMessages((prev) => [...prev, chatMsg]);
    } catch { /* ignore malformed */ }
  }, []);

  const { send } = useDataChannel(TOPIC, onMessage);

  const sendMessage = useCallback((text: string) => {
    if (!localParticipant || !text.trim()) return;

    const event = {
      type: 'chat',
      identity: localParticipant.identity,
      text: text.trim(),
      timestamp: Date.now(),
    };

    const payload = new TextEncoder().encode(JSON.stringify(event));
    send(payload, { reliable: true });

    // Add to local messages immediately
    setMessages((prev) => [...prev, {
      id: `${event.identity}-${event.timestamp}`,
      identity: event.identity,
      text: event.text,
      timestamp: event.timestamp,
    }]);
  }, [localParticipant, send]);

  return { messages, sendMessage };
}
