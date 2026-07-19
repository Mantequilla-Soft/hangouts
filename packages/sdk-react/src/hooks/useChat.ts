import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useDataChannel, useLocalParticipant, useRoomContext } from '@livekit/components-react';

export interface ChatMessage {
  id: string;
  identity: string;
  /** Display name — participant.name when set (e.g. a guest's chosen name),
   *  otherwise falls back to identity. */
  name: string;
  text: string;
  timestamp: number;
}

const TOPIC = 'chat';

/**
 * Chat state is SHARED across every useChat() caller in a room.
 *
 * It used to live in the hook's own useState, so each caller kept a private
 * list. That broke in two ways that both looked like "chat is broken":
 *   - a panel mounted later (a sheet the host opens, an overlay toggled on)
 *     started empty and never saw anything sent before it appeared;
 *   - a composer rendered separately from the panel echoed its own message
 *     into a list nobody was displaying.
 *
 * A module-level store keyed on the room fixes both — one list per room, every
 * caller reading and writing the same thing.
 */
let messages: ChatMessage[] = [];
/** The Room the log belongs to — the OBJECT, not its name. See the effect. */
let currentRoom: unknown = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function pushMessage(msg: ChatMessage) {
  // Several hook instances subscribe to the same topic, so the same message
  // arrives more than once. Dedupe on id (identity + timestamp).
  if (messages.some((m) => m.id === msg.id)) return;
  messages = [...messages, msg];
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const getSnapshot = () => messages;

export function useChat() {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();

  // Clear the log when the room changes — messages must not leak between rooms.
  //
  // Keyed on the Room INSTANCE, not `room.name`. The name is empty until the
  // socket connects and filling it in does not re-render, so a hook instance
  // created before connect keeps observing `''` forever. Keying on the name
  // meant the first component to mount AFTER connect (the chat sheet the host
  // opens) rendered with the real name, read that as "the room changed", and
  // wiped a log that already had messages in it — losing exactly the first
  // message, once per session. The Room object is stable from first render and
  // a genuinely different room is a different object.
  useEffect(() => {
    if (!room || currentRoom === room) return;
    currentRoom = room;
    messages = [];
    emit();
  }, [room]);

  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const parsed = JSON.parse(text);
      if (parsed.type !== 'chat') return;

      pushMessage({
        id: `${parsed.identity}-${parsed.timestamp}`,
        identity: parsed.identity,
        name: parsed.name || parsed.identity,
        text: parsed.text,
        timestamp: parsed.timestamp,
      });
    } catch { /* ignore malformed */ }
  }, []);

  const { send } = useDataChannel(TOPIC, onMessage);

  const sendMessage = useCallback((text: string) => {
    if (!localParticipant || !text.trim()) return;

    const event = {
      type: 'chat',
      identity: localParticipant.identity,
      name: localParticipant.name || localParticipant.identity,
      text: text.trim(),
      timestamp: Date.now(),
    };

    const payload = new TextEncoder().encode(JSON.stringify(event));
    send(payload, { reliable: true });

    // Echo locally — LiveKit doesn't loop your own data messages back.
    pushMessage({
      id: `${event.identity}-${event.timestamp}`,
      identity: event.identity,
      name: event.name,
      text: event.text,
      timestamp: event.timestamp,
    });
  }, [localParticipant, send]);

  return { messages: current, sendMessage };
}
