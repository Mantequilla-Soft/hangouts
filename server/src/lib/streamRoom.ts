import { roomService, generateRoomName } from './livekit.js';
import { clearRoomBans } from './guestBans.js';

/**
 * Room creation + teardown shared by the browser studio (POST /rooms,
 * DELETE /rooms/:name) and headless OBS streams (lib/headlessStreams.ts).
 *
 * One code path on purpose: a headless stream is a standalone room in every
 * way the watch page, /streams, the recorder and the stats sampler care about.
 * If the two drifted (a field the studio writes that the OBS path forgets),
 * the OBS stream would silently lose that feature.
 */

export type RoomVisibility = 'public' | 'hive-internal' | 'unlisted';
export const ROOM_VISIBILITIES: readonly RoomVisibility[] = ['public', 'hive-internal', 'unlisted'];
export function isRoomVisibility(v: unknown): v is RoomVisibility {
  return typeof v === 'string' && (ROOM_VISIBILITIES as readonly string[]).includes(v);
}

export type RoomMode = 'conference' | 'standalone';
export const ROOM_MODES: readonly RoomMode[] = ['conference', 'standalone'];
export function isRoomMode(v: unknown): v is RoomMode {
  return typeof v === 'string' && (ROOM_MODES as readonly string[]).includes(v);
}

export const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

export interface BoostConfig {
  enabled: boolean;
  minBoostUsd: number;
  creatorPayoutAccount?: string;
}

export interface RoomMetadata {
  title: string;
  description?: string;
  host: string;
  createdAt: string;
  backgroundImage?: string;
  /** When false, the room rejects guest-listener tokens. Default true.
   *  Derived from `visibility` for new rooms; retained for legacy rooms
   *  that pre-date the visibility model. */
  allowGuests?: boolean;
  /** Hostname (e.g. "3speak.tv") of the site that issued the create request.
   *  Used by clients to pick a share URL that drops the recipient back into
   *  the same product surface. Optional; pre-existing rooms have none. */
  origin?: string;
  /**
   * Visibility / access tier for the room:
   *  - `public` (default): listed in the lobby, guests can listen.
   *  - `hive-internal`: listed in the lobby, but only Hive accounts can
   *    join — guest-listener tokens are rejected.
   *  - `unlisted`: hidden from the public lobby; reachable only via
   *    direct link. Guest listening is still allowed (the link is the
   *    auth).
   *  Optional; pre-existing rooms with no value behave as `public`.
   */
  visibility?: RoomVisibility;
  /** Optional language tag (BCP-47 style) displayed in room lists. */
  language?: string;
  /** Boost/superchat settings. */
  boost?: BoostConfig;
  /** True when the broadcast is portrait (a phone). Drives the recorder's
   *  output dimensions. */
  portrait?: boolean;
  /** Identity of the viewer currently holding the stream's single collab slot
   *  (host-approved co-broadcaster). Set by the permissions route. */
  collabGuest?: string;
  /** ISO timestamp of the FIRST time the host went live, stamped server-side.
   *  Anchors live-chat timecodes to the recording's timeline — see the
   *  PATCH /rooms/:name/live handler for why neither `createdAt` nor the Hive
   *  announcement's own timestamp will do. */
  liveAt?: string;
  /** The host asked for the broadcast to be published as a VOD when it ends.
   *  Lets the watch page show "the recording is processing" the moment they
   *  leave, rather than guessing from encoder state. */
  willPublishVod?: boolean;
  /** Standalone streams: true once the host hits Start (cleared on Pause /
   *  never set in standby). Drives the "actually live" flag in /streams. */
  broadcasting?: boolean;
  /**
   * Feed-post details for a standalone stream (composed in the studio's
   * post editor). Surfaced on the watch page and — later — as a discover
   * card / published Hive post. Title falls back to the room title.
   */
  post?: {
    title?: string;
    thumbnail?: string;
    description?: string;
    tags?: string[];
  };
  /**
   * Room mode:
   *  - `conference` (default): the classic multi-participant hangout.
   *  - `standalone`: a one-man livestream studio — only the host
   *    publishes (a client-composited program feed); everyone else is
   *    a watch-only viewer with chat. Non-host joins never get publish
   *    permission, regardless of later promote attempts.
   *  Optional; pre-existing rooms with no value behave as `conference`.
   */
  mode?: RoomMode;
  /**
   * Headless stream: published from OBS (WHIP) with no browser studio. The
   * ingress joins AS the host identity so every viewer path that looks for
   * `identity === host` just works — which is also why a signed-in host
   * opening their own watch page must be given a different identity (see
   * /join and /listen), or LiveKit would kick the ingress as a duplicate.
   */
  headless?: boolean;
  /** Stream template the headless stream was started from. */
  templateId?: string;
  /** Non-Pro headless streams carry a watermark (the studio draws its own;
   *  for OBS the viewer surfaces have to). */
  watermark?: boolean;
  /** sha256 of the WHIP session token. Lets a restarted server re-adopt a
   *  running OBS session under the same session URL. Only a hash: room
   *  metadata is readable by every viewer, the token is a capability. */
  whipSession?: string;
}

export interface CreateStreamRoomInput {
  host: string;
  title: string;
  description?: string;
  backgroundImage?: string;
  visibility?: string;
  language?: string;
  mode?: string;
  tags?: string[];
  boost?: { enabled?: boolean; minBoostUsd?: number; creatorPayoutAccount?: string };
  origin?: string;
  /** Extra metadata fields (headless streams) merged over the defaults. */
  extra?: Partial<RoomMetadata>;
}

/** Build the metadata for a new room from create inputs (pure). */
export function buildRoomMetadata(input: CreateStreamRoomInput): RoomMetadata {
  const { host, title, description, backgroundImage } = input;
  // Default to `public` for older clients that don't send the field.
  const visibility: RoomVisibility = isRoomVisibility(input.visibility) ? input.visibility : 'public';
  // Default to `conference` for older clients that don't send the field.
  const mode: RoomMode = isRoomMode(input.mode) ? input.mode : 'conference';

  const language = typeof input.language === 'string' && LANGUAGE_RE.test(input.language.trim())
    ? input.language.trim()
    : undefined;
  // Always write a boost field so the host can update it later via
  // PATCH /rooms/:name/boost without needing to recreate the room.
  // Old clients that don't send boost are given sensible defaults.
  const rawBoost = input.boost;
  const boost: BoostConfig = rawBoost
    ? {
        enabled: rawBoost.enabled !== false,
        minBoostUsd: Number.isFinite(rawBoost.minBoostUsd) ? Math.max(0, Number(rawBoost.minBoostUsd ?? 0)) : 0,
        creatorPayoutAccount: rawBoost.creatorPayoutAccount?.trim().toLowerCase() || host,
      }
    : {
        enabled: true,
        minBoostUsd: 0,
        creatorPayoutAccount: host,
      };

  return {
    title,
    description,
    host,
    createdAt: new Date().toISOString(),
    backgroundImage,
    origin: input.origin,
    visibility,
    // Mirror visibility into allowGuests so older lookup paths that
    // still consult that field stay correct.
    allowGuests: visibility !== 'hive-internal',
    language,
    boost,
    mode,
    // Seed the feed-post from the create inputs so the studio composer,
    // watch page, and /streams all have title/description/thumbnail/tags
    // without a separate save step.
    post: {
      title,
      description,
      thumbnail: backgroundImage,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 10) : undefined,
    },
    ...input.extra,
  };
}

/** Create a LiveKit room for a host. Same limits for every caller. */
export async function createStreamRoom(input: CreateStreamRoomInput): Promise<{ name: string; metadata: RoomMetadata }> {
  const metadata = buildRoomMetadata(input);
  const roomName = generateRoomName(input.host, input.title);
  const room = await roomService.createRoom({
    name: roomName,
    maxParticipants: 500,
    emptyTimeout: 300,
    metadata: JSON.stringify(metadata),
  });
  return { name: room.name, metadata };
}

/** Close a room: LiveKit disconnects everyone; drop its in-memory ban state. */
export async function closeStreamRoom(name: string): Promise<void> {
  await roomService.deleteRoom(name);
  clearRoomBans(name);
}
