import type { HandRaiseEvent } from '@snapie/hangouts-core';
import type { BacklogLine } from './chatBacklog.js';
import { decodeCaption, type CaptionMessage } from './liveCaptions.js';
import type { Stroke } from '../hooks/useFastDraw.js';

/**
 * Who may send what on the LiveKit data channel, and the checks every SDK
 * listener runs before it believes a packet.
 *
 * Anyone in a room with `canPublishData` (every viewer, anonymous guests
 * included, so they can chat) can publish ANY payload on ANY topic. The only
 * thing a sender cannot fake is the sender itself: LiveKit stamps each packet
 * with the identity of the participant that published it, and a packet the
 * server sent (RoomService.sendData) arrives with no participant at all. So:
 *
 *   - server topics (boost, poll, raid, game, and the chat moderation and
 *     system lines) are accepted only when there is NO participant sender;
 *   - host topics (captions, view-state, volume, lowering someone else's
 *     hand) only when the sender's identity is the room host from the room
 *     metadata (`meta.host`, which only the server writes);
 *   - participant topics (chat lines, your own raised hand) from anyone, but
 *     who said it is the LiveKit sender, never a name or identity in the
 *     payload.
 *
 * Every reader here is pure (payload + sender in, a checked value or null
 * out) so the rules are unit tested without a room.
 */

/** The sender LiveKit reports for a packet: a participant, or null/undefined
 *  when the server sent it. Only `identity` and `name` are read. */
export type DataSender = { identity?: string; name?: string } | null | undefined;

/** The trust class of each topic the SDK listens to. */
export type TopicTrust = 'server' | 'host' | 'participant' | 'drawer';

export const DATA_TOPIC_TRUST: Readonly<Record<string, TopicTrust>> = {
  boost: 'server',
  poll: 'server',
  raid: 'server',
  game: 'server',
  // Lines are anyone's; `chat-delete`, `chat-purge` and `system` are server only.
  chat: 'participant',
  // Your own hand is yours; lowering someone else's is the host's.
  'hand-raise': 'participant',
  captions: 'host',
  'view-state': 'host',
  volume: 'host',
  // Only the current Fast Draw drawer (from the server's game state).
  draw: 'drawer',
};

/** True when the server sent the packet (LiveKit gives no participant). */
export function isServerSent(from: DataSender): boolean {
  return from === null || from === undefined;
}

/** True when the packet came from the participant whose identity is `identity`. */
export function isSentBy(from: DataSender, identity: string | null | undefined): boolean {
  return !!from && !!identity && typeof from.identity === 'string' && from.identity === identity;
}

/** The host identity in a room's metadata JSON, or '' when there is none. */
export function hostFromMetadata(metadata: string | undefined | null): string {
  if (!metadata) return '';
  try {
    const host = (JSON.parse(metadata) as { host?: unknown }).host;
    return typeof host === 'string' ? host : '';
  } catch {
    return '';
  }
}

const dec = new TextDecoder();

/** A packet's JSON object, or null when it is not one. */
export function decodeData(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(dec.decode(payload)) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A server-sent packet on a server topic, or null (sent by a participant, or not JSON). */
function serverPacket(payload: Uint8Array, from: DataSender): Record<string, unknown> | null {
  if (!isServerSent(from)) return null;
  return decodeData(payload);
}

// ── chat ───────────────────────────────────────────────────────────────────

/** Longest live chat line kept (the server's POST body limit). */
export const CHAT_LIVE_MAX = 2000;

export type ChatPacket =
  | { kind: 'line'; line: BacklogLine }
  | { kind: 'delete'; id: string }
  | { kind: 'purge'; identity: string };

/** Same window the server's backlog clamps to: a minute back, five seconds ahead. */
function clampTime(ts: number, now: number): number {
  return Math.min(now + 5000, Math.max(now - 60_000, ts));
}

/**
 * A `chat` packet. From a participant only `{ type: 'chat', text, timestamp }`
 * counts, and the line's identity and name are the LiveKit sender's (a payload
 * `identity`, `name`, `isHost` or anything else is ignored). From the server:
 * a moderator's delete, a ban's purge, a system line (a raid arriving).
 */
export function readChatPacket(payload: Uint8Array, from: DataSender, now = Date.now()): ChatPacket | null {
  const p = decodeData(payload);
  if (!p) return null;

  if (isServerSent(from)) {
    if (p.type === 'chat-delete' && typeof p.id === 'string' && p.id) return { kind: 'delete', id: p.id };
    if (p.type === 'chat-purge' && typeof p.identity === 'string' && p.identity) return { kind: 'purge', identity: p.identity };
    const sys = p.system as { kind?: unknown; from?: unknown; viewers?: unknown } | undefined;
    if (p.type === 'system' && sys?.kind === 'raid' && typeof p.id === 'string') {
      const raider = String(sys.from ?? '');
      return {
        kind: 'line',
        line: {
          id: p.id,
          identity: String(p.identity ?? raider),
          name: String(p.name ?? raider),
          text: String(p.text ?? ''),
          timestamp: Number(p.timestamp) || now,
          system: { kind: 'raid', from: raider, viewers: Number(sys.viewers) || 0 },
        },
      };
    }
    return null;
  }

  if (p.type !== 'chat') return null;
  const identity = typeof from?.identity === 'string' ? from.identity : '';
  if (!identity || typeof p.text !== 'string') return null;
  const text = p.text.trim().slice(0, CHAT_LIVE_MAX);
  if (!text) return null;
  // The id keeps the sender's own timestamp (the server's backlog copy uses
  // the same one, so the two dedupe), but the shown time is clamped like the
  // server's so a line cannot be dated into the future to stay at the bottom.
  const sent = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? Math.round(p.timestamp) : now;
  return {
    kind: 'line',
    line: {
      id: `${identity}-${sent}`,
      identity,
      name: (typeof from?.name === 'string' && from.name) || identity,
      text,
      timestamp: clampTime(sent, now),
    },
  };
}

// ── server topics ──────────────────────────────────────────────────────────

/** A `boost` card: server only (the boost listener after it saw the Hive transfer). */
export function readBoostPacket<T extends { type: 'boost'; id: string; usdAmount: number }>(
  payload: Uint8Array, from: DataSender,
): T | null {
  const p = serverPacket(payload, from);
  if (!p || p.type !== 'boost' || typeof p.id !== 'string' || !p.id) return null;
  if (typeof p.usdAmount !== 'number' || !Number.isFinite(p.usdAmount)) return null;
  return p as unknown as T;
}

/** A `poll` update: server only. Returns the raw poll for `parsePoll`. */
export function readPollPacket(payload: Uint8Array, from: DataSender): unknown | null {
  const p = serverPacket(payload, from);
  if (!p || p.type !== 'poll' || !p.poll) return null;
  return p.poll;
}

export type RaidPacketType = 'raid-start' | 'raid-go' | 'raid-cancel';

/** A `raid` notice: server only (raid-go sends every viewer to another room).
 *  Returns the raw raid for `parseRaid`. */
export function readRaidPacket(payload: Uint8Array, from: DataSender): { type: RaidPacketType; raid: unknown } | null {
  const p = serverPacket(payload, from);
  if (!p || !p.raid) return null;
  if (p.type !== 'raid-start' && p.type !== 'raid-go' && p.type !== 'raid-cancel') return null;
  return { type: p.type, raid: p.raid };
}

/** A `game` message (`game:started`, `game:state`, ...): server only, moves go over HTTP. */
export function readGamePacket<T = Record<string, unknown>>(payload: Uint8Array, from: DataSender): (T & { type: string }) | null {
  const p = serverPacket(payload, from);
  if (!p || typeof p.type !== 'string' || !p.type.startsWith('game:')) return null;
  return p as T & { type: string };
}

// ── host topics ────────────────────────────────────────────────────────────

/** A live caption line: from the room host's studio only. */
export function readCaptionPacket(payload: Uint8Array, from: DataSender, host: string | null | undefined): CaptionMessage | null {
  if (!isSentBy(from, host)) return null;
  return decodeCaption(payload);
}

export interface ViewStatePacket {
  type: 'view-state';
  focusedIdentity: string | null;
  suppressScreenAutoFocus: boolean;
  timestamp: number;
}

/** The host's focused speaker / grid choice: from the host only. */
export function readViewStatePacket(payload: Uint8Array, from: DataSender, host: string | null | undefined): ViewStatePacket | null {
  if (!isSentBy(from, host)) return null;
  const p = decodeData(payload);
  if (!p || p.type !== 'view-state') return null;
  return {
    type: 'view-state',
    focusedIdentity: typeof p.focusedIdentity === 'string' ? p.focusedIdentity : null,
    suppressScreenAutoFocus: p.suppressScreenAutoFocus === true,
    timestamp: typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : 0,
  };
}

export interface VolumePacket {
  type: 'volume';
  identity: string;
  volume: number;
  timestamp: number;
}

/** A speaker's volume for everyone (and the recording): from the host only, 0..1. */
export function readVolumePacket(payload: Uint8Array, from: DataSender, host: string | null | undefined): VolumePacket | null {
  if (!isSentBy(from, host)) return null;
  const p = decodeData(payload);
  if (!p || p.type !== 'volume' || typeof p.identity !== 'string' || !p.identity) return null;
  if (typeof p.volume !== 'number' || !Number.isFinite(p.volume)) return null;
  return {
    type: 'volume',
    identity: p.identity,
    volume: Math.min(1, Math.max(0, p.volume)),
    timestamp: typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : 0,
  };
}

// ── participant topics ─────────────────────────────────────────────────────

/**
 * A raised or lowered hand. Anyone raises or lowers their OWN hand (the
 * identity is the sender's); only the host may lower someone else's (after
 * accepting or declining a request). Raising a hand for someone else, or a
 * guest lowering the host's queue, is dropped.
 */
export function readHandRaisePacket(payload: Uint8Array, from: DataSender, host: string | null | undefined): HandRaiseEvent | null {
  if (isServerSent(from) || typeof from?.identity !== 'string' || !from.identity) return null;
  const p = decodeData(payload);
  if (!p || p.type !== 'hand_raise' || typeof p.raised !== 'boolean') return null;
  const timestamp = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : 0;
  const about = typeof p.identity === 'string' && p.identity ? p.identity : from.identity;
  if (about !== from.identity) {
    if (p.raised || !isSentBy(from, host)) return null;
    return { type: 'hand_raise', raised: false, identity: about, timestamp };
  }
  return { type: 'hand_raise', raised: p.raised, identity: from.identity, timestamp };
}

/** More points than any real stroke has (the drawer sends one per pointer move). */
const MAX_STROKE_POINTS = 10_000;

export type DrawPacket ={ type: 'draw_stroke'; stroke: Stroke } | { type: 'draw_clear' };

/** A Fast Draw stroke: from the current drawer only (the server names them). */
export function readDrawPacket(payload: Uint8Array, from: DataSender, drawer: string | null | undefined): DrawPacket | null {
  if (!isSentBy(from, drawer)) return null;
  const p = decodeData(payload);
  if (!p) return null;
  if (p.type === 'draw_clear') return { type: 'draw_clear' };
  const s = p.stroke as Partial<Stroke> | undefined;
  if (p.type !== 'draw_stroke' || !s || !Array.isArray(s.points) || s.points.length > MAX_STROKE_POINTS) return null;
  if (typeof s.color !== 'string' || typeof s.width !== 'number' || !Number.isFinite(s.width)) return null;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (!s.points.every((pt) => Array.isArray(pt) && finite(pt[0]) && finite(pt[1]))) return null;
  return {
    type: 'draw_stroke',
    stroke: { id: typeof s.id === 'string' ? s.id : '', points: s.points, color: s.color, width: s.width },
  };
}
