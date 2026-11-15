import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { useConnectionState, useDataChannel, useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { ConnectionState } from 'livekit-client';
import { HangoutsContext } from '../context/HangoutsContext.js';
import { useStreamContext } from '../components/room/StandaloneWatch.js';
import { mergeChatLines, parseBacklog, type ChatSystemInfo } from '../lib/chatBacklog.js';

export interface ChatMessage {
  id: string;
  identity: string;
  /** Display name — participant.name when set (e.g. a guest's chosen name),
   *  otherwise falls back to identity. */
  name: string;
  text: string;
  timestamp: number;
  /** A line the server wrote, not a person: a raid arriving. ChatPanel draws
   *  it from labels; `text` is the English fallback. */
  system?: ChatSystemInfo;
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
/** Taken down by a moderator, or written by someone they banned, in this room:
 *  kept so a backlog that arrives later cannot bring them back. */
let removedIds = new Set<string>();
let purgedIdentities = new Set<string>();
/** When the backlog was last asked for, per Room object (one fetch per connect,
 *  however many useChat callers mount). */
let backlogAskedAt = new WeakMap<object, number>();

function emit() {
  for (const l of listeners) l();
}

function pushMessage(msg: ChatMessage) {
  // Several hook instances subscribe to the same topic, so the same message
  // arrives more than once. Dedupe on id (identity + timestamp).
  if (messages.some((m) => m.id === msg.id)) return;
  if (removedIds.has(msg.id) || purgedIdentities.has(msg.identity)) return;
  messages = [...messages, msg];
  emit();
}

/** Lines from the server's backlog, merged under what arrived live. */
function mergeBacklog(lines: ChatMessage[]) {
  const next = mergeChatLines(messages, lines, removedIds, purgedIdentities);
  if (next === messages) return;
  messages = next;
  emit();
}

function removeMessage(id: string) {
  removedIds.add(id);
  if (!messages.some((m) => m.id === id)) return;
  messages = messages.filter((m) => m.id !== id);
  emit();
}

function purgeIdentity(identity: string) {
  purgedIdentities.add(identity);
  if (!messages.some((m) => m.identity === identity)) return;
  messages = messages.filter((m) => m.identity !== identity);
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
    removedIds = new Set();
    purgedIdentities = new Set();
    emit();
  }, [room]);

  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The backlog: what was said before this page connected (a reload, a late
  // join, a reconnect after a network drop). Asked for on every connect, once
  // per Room however many callers there are; the merge dedupes on id.
  const ctx = useContext(HangoutsContext);
  const { livekitToken } = useStreamContext();
  const state = useConnectionState(room);
  const apiBaseUrl = ctx?.apiBaseUrl;
  useEffect(() => {
    if (state !== ConnectionState.Connected || !room?.name || !apiBaseUrl) return;
    const last = backlogAskedAt.get(room) ?? 0;
    if (Date.now() - last < 2000) return;
    backlogAskedAt.set(room, Date.now());
    const token = ctx?.apiClient.getSessionToken();
    let alive = true;
    fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(room.name)}/chat`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (alive && currentRoom === room) mergeBacklog(parseBacklog(body)); })
      .catch(() => { /* an older server, or offline: live chat still works */ });
    return () => { alive = false; };
  }, [state, room, apiBaseUrl, ctx]);

  const onMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const text = new TextDecoder().decode(msg.payload);
      const parsed = JSON.parse(text);
      // From the server: a moderator took a line down, or banned a chatter.
      if (parsed.type === 'chat-delete' && typeof parsed.id === 'string') { removeMessage(parsed.id); return; }
      if (parsed.type === 'chat-purge' && typeof parsed.identity === 'string') { purgeIdentity(parsed.identity); return; }
      if (parsed.type === 'system' && parsed.system?.kind === 'raid' && typeof parsed.id === 'string') {
        pushMessage({
          id: parsed.id,
          identity: String(parsed.identity ?? parsed.system.from ?? ''),
          name: String(parsed.name ?? parsed.system.from ?? ''),
          text: String(parsed.text ?? ''),
          timestamp: Number(parsed.timestamp) || Date.now(),
          system: { kind: 'raid', from: String(parsed.system.from ?? ''), viewers: Number(parsed.system.viewers) || 0 },
        });
        return;
      }
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

    // The server's copy for the backlog. Fire and forget: chat never waits on
    // it, and an older server without the route just answers 404.
    const roomName = room?.name;
    const token = ctx?.apiClient.getSessionToken();
    if (apiBaseUrl && roomName && (token || livekitToken)) {
      fetch(`${apiBaseUrl}/rooms/${encodeURIComponent(roomName)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          text: event.text,
          timestamp: event.timestamp,
          identity: event.identity,
          name: event.name,
          ...(token ? {} : { livekitToken }),
        }),
      }).catch(() => { /* best effort */ });
    }
  }, [localParticipant, send, room, ctx, apiBaseUrl, livekitToken]);

  return { messages: current, sendMessage };
}

/** Drop one line from everyone's list right away (the moderator who deleted it). */
export function dropChatMessage(id: string): void {
  removeMessage(id);
}

/** Test helper: reset the shared store. */
export function __resetChatStore(): void {
  messages = [];
  currentRoom = null;
  removedIds = new Set();
  purgedIdentities = new Set();
  backlogAskedAt = new WeakMap();
  emit();
}
