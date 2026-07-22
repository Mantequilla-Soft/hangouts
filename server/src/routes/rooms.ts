import type { FastifyPluginAsync } from 'fastify';
import {
  IngressClient, IngressInput, IngressVideoOptions, IngressVideoEncodingOptions,
  VideoCodec, TrackSource,
} from 'livekit-server-sdk';
import { config } from '../config.js';
import { roomService, generateRoomName, createLivekitToken } from '../lib/livekit.js';
import { mutateRoomMetadata } from '../lib/roomMeta.js';
import { verifySessionToken } from '../lib/session.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { getUserStatus } from '../lib/users.js';
import { recordGuestIp, isGuestBanned, clearRoomBans } from '../lib/guestBans.js';

type RoomVisibility = 'public' | 'hive-internal' | 'unlisted';
const ROOM_VISIBILITIES: readonly RoomVisibility[] = ['public', 'hive-internal', 'unlisted'];

// OBS/WHIP ingest. Same credentials as roomService — the ingress service reads
// the identical key pair from its own config and talks to LiveKit over loopback.
const ingressClient = new IngressClient(
  config.LIVEKIT_HOST,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
function isRoomVisibility(v: unknown): v is RoomVisibility {
  return typeof v === 'string' && (ROOM_VISIBILITIES as readonly string[]).includes(v);
}

type RoomMode = 'conference' | 'standalone';
const ROOM_MODES: readonly RoomMode[] = ['conference', 'standalone'];
function isRoomMode(v: unknown): v is RoomMode {
  return typeof v === 'string' && (ROOM_MODES as readonly string[]).includes(v);
}

interface BoostConfig {
  enabled: boolean;
  minBoostUsd: number;
  creatorPayoutAccount?: string;
}

interface RoomMetadata {
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
}

/** Identity prefix used for unauthenticated guest listeners. */
const GUEST_PREFIX = 'guest-';
/** Identity prefix used for silent OBS overlay observers. */
const OBS_PREFIX = 'obs-';
const MAX_GUESTS_PER_ROOM = Number(process.env.MAX_GUESTS_PER_ROOM ?? 100);

function generateGuestIdentity(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${GUEST_PREFIX}${id}`;
}

function generateObsIdentity(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${OBS_PREFIX}${id}`;
}


export const roomRoutes: FastifyPluginAsync = async (fastify) => {
  // List active rooms (public — no auth required). Filters out rooms
  // marked `unlisted`; those are reachable only by direct link.
  fastify.get('/rooms', async (_request, reply) => {
    const rooms = await roomService.listRooms();

    const visible = rooms
      .map((r) => {
        let meta: Partial<RoomMetadata> = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }
        return { r, meta };
      })
      .filter(({ meta }) => meta.visibility !== 'unlisted');

    // Subtract obs- observer connections from participant counts so the
    // lobby doesn't count OBS Browser Sources as real listeners.
    const result = await Promise.all(visible.map(async ({ r, meta }) => {
      let numParticipants = r.numParticipants;
      if (numParticipants > 0) {
        try {
          const parts = await roomService.listParticipants(r.name);
          numParticipants = parts.filter((p) => !p.identity.startsWith(OBS_PREFIX)).length;
        } catch { /* use raw count if listParticipants fails */ }
      }
      return {
        name: r.name,
        title: meta.title || r.name,
        host: meta.host || 'unknown',
        description: meta.description,
        backgroundImage: meta.backgroundImage,
        numParticipants,
        maxParticipants: r.maxParticipants,
        createdAt: meta.createdAt || new Date(Number(r.creationTime) * 1000).toISOString(),
        origin: meta.origin,
        visibility: meta.visibility,
        language: meta.language,
        boost: meta.boost,
        mode: meta.mode,
        post: meta.post,
        liveAt: meta.liveAt,
        willPublishVod: meta.willPublishVod,
        collabGuest: meta.collabGuest,
        broadcasting: meta.broadcasting,
        portrait: meta.portrait,
      };
    }));

    return reply.send(result);
  });

  // Active OpenPods for the discover feeds (public — no auth). Both standalone
  // STREAMS and conference ROOMS, each tagged with `mode` so the client can
  // link a stream to its watch page and a room to the OpenPods room UI.
  //
  // UNLISTED rooms are excluded here: they're link-only, so surfacing them in a
  // discovery feed would defeat the point. Hive-only rooms ARE returned (the
  // client hides them from signed-out viewers) so a signed-in viewer sees them.
  fastify.get('/streams', async (_request, reply) => {
    const rooms = await roomService.listRooms();
    const active = rooms
      .map((r) => {
        let meta: Partial<RoomMetadata> = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }
        return { r, meta };
      })
      .filter(({ meta }) => (
        (meta.mode === 'standalone' || meta.mode === 'conference')
        && meta.visibility !== 'unlisted'
      ));

    const result = await Promise.all(active.map(async ({ r, meta }) => {
      let live = false;
      let viewers = 0;
      try {
        const parts = await roomService.listParticipants(r.name);
        if (meta.mode === 'standalone') {
          // A stream is live when the host hit Start (broadcasting) AND is still
          // connected — the flag alone can be stale from a crashed streamer.
          live = !!meta.broadcasting && parts.some((p) => p.identity === meta.host);
          // Watchers = everyone but the broadcaster and the OBS ingress, which
          // joins as its own participant and would inflate the count by one.
          viewers = parts.filter((p) => (
            p.identity !== meta.host && !p.identity.startsWith('obs-')
          )).length;
        } else {
          // A room is live simply when someone is in it.
          viewers = parts.filter((p) => !p.identity.startsWith('obs-')).length;
          live = viewers > 0;
        }
      } catch { /* treat as not-live if we can't tell */ }
      return {
        name: r.name,
        title: meta.post?.title || meta.title || r.name,
        host: meta.host || 'unknown',
        description: meta.post?.description || meta.description,
        thumbnail: meta.post?.thumbnail || meta.backgroundImage,
        tags: meta.post?.tags || [],
        visibility: meta.visibility,
        mode: meta.mode,
        createdAt: meta.createdAt || new Date(Number(r.creationTime) * 1000).toISOString(),
        live,
        // Live viewer count for the discovery cards.
        viewers,
      };
    }));

    // Live ones first, newest first.
    result.sort((a, b) => (Number(b.live) - Number(a.live)) || (a.createdAt < b.createdAt ? 1 : -1));
    // Never cache — live status changes minute to minute.
    reply.header('Cache-Control', 'no-store');
    return reply.send(result);
  });

  // Public health + counts. Aggregate numbers ONLY — no room names, titles or
  // participant identities — so it's safe to leave unauthenticated for uptime
  // monitoring. Cached briefly so a polling monitor can't hammer LiveKit.
  let healthCache: { at: number; body: unknown } | null = null;
  const HEALTH_TTL_MS = 5000;

  fastify.get('/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) {
      return reply.send(healthCache.body);
    }

    try {
      const rooms = await roomService.listRooms();

      const counts = await Promise.all(rooms.map(async (r) => {
        let meta: Partial<RoomMetadata> = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }

        let viewers = 0;
        let hostPresent = false;
        try {
          const parts = await roomService.listParticipants(r.name);
          hostPresent = parts.some((p) => p.identity === meta.host);
          // A "viewer" is anyone who isn't the host and isn't an OBS overlay
          // connection — same rule the studio and /streams use.
          viewers = parts.filter(
            (p) => p.identity !== meta.host && !p.identity.startsWith('obs-'),
          ).length;
        } catch { /* room disappeared mid-scan — count it as empty */ }

        return {
          standalone: meta.mode === 'standalone',
          live: !!meta.broadcasting && hostPresent,
          viewers,
        };
      }));

      const body = {
        ok: true,
        uptime: Math.round(process.uptime()),
        sessions: {
          total: counts.length,
          conference: counts.filter((c) => !c.standalone).length,
          standalone: counts.filter((c) => c.standalone).length,
          live: counts.filter((c) => c.standalone && c.live).length,
        },
        viewers: counts.reduce((sum, c) => sum + c.viewers, 0),
      };
      healthCache = { at: Date.now(), body };
      return reply.send(body);
    } catch (err) {
      return reply.code(503).send({ ok: false, error: 'LiveKit unavailable' });
    }
  });

  // Get a single room by name (public — no auth required)
  fastify.get('/rooms/:name', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) {
      return reply.notFound('Room not found');
    }

    const r = rooms[0];
    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }

    return reply.send({
      name: r.name,
      title: meta.title || r.name,
      host: meta.host || 'unknown',
      description: meta.description,
      backgroundImage: meta.backgroundImage,
      numParticipants: r.numParticipants,
      maxParticipants: r.maxParticipants,
      createdAt: meta.createdAt || new Date(Number(r.creationTime) * 1000).toISOString(),
      origin: meta.origin,
      visibility: meta.visibility,
      language: meta.language,
      boost: meta.boost,
      mode: meta.mode,
      post: meta.post,
      liveAt: meta.liveAt,
      willPublishVod: meta.willPublishVod,
      collabGuest: meta.collabGuest,
      portrait: meta.portrait,
      // So a studio that was discarded and reloaded can tell it is mid-stream
      // and pick up where it left off instead of sitting in standby.
      broadcasting: meta.broadcasting,
    });
  });

  // Create a room (auth required — caller becomes host)
  fastify.post('/rooms', {
    preHandler: [requireAuth, checkBan],
    // Cap room-creation so one account can't spam LiveKit rooms (each holds
    // resources + pollutes /rooms and /streams). Keyed per authed IP.
    config: { rateLimit: { max: 12, timeWindow: '5 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title:           { type: 'string', minLength: 1, maxLength: 64 },
          // 5000 to match PATCH /rooms/:name/post and the client editor — the
          // create dialog takes a full markdown description, and 256 rejected it.
          description:     { type: 'string', maxLength: 5000 },
          backgroundImage: { type: 'string', maxLength: 512 },
          visibility:      { type: 'string', enum: ROOM_VISIBILITIES as unknown as string[] },
          language:        { type: 'string', maxLength: 16 },
          mode:            { type: 'string', enum: ROOM_MODES as unknown as string[] },
          tags:            { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
          boost: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              minBoostUsd: { type: 'number', minimum: 0 },
              creatorPayoutAccount: { type: 'string', minLength: 3, maxLength: 16 },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { title, description, backgroundImage, visibility: bodyVisibility, language: rawLanguage, boost: rawBoost, mode: bodyMode, tags: rawTags } =
      request.body as {
        title: string;
        description?: string;
        backgroundImage?: string;
        visibility?: string;
        language?: string;
        boost?: { enabled?: boolean; minBoostUsd?: number; creatorPayoutAccount?: string };
        mode?: string;
        tags?: string[];
      };
    const host = request.username;
    const { premium } = await getUserStatus(host);

    // Default to `public` for older clients that don't send the field.
    const visibility: RoomVisibility = isRoomVisibility(bodyVisibility) ? bodyVisibility : 'public';
    // Default to `conference` for older clients that don't send the field.
    const mode: RoomMode = isRoomMode(bodyMode) ? bodyMode : 'conference';

    // Capture which surface created the room. Browsers always send Origin
    // on cross-origin POSTs; same-origin tools can fall back to Referer.
    // We store hostname only — never paths or query — to avoid leaking
    // stray query params or session ids in room metadata.
    const originHeader = request.headers.origin || request.headers.referer;
    let origin: string | undefined;
    if (typeof originHeader === 'string' && originHeader) {
      try { origin = new URL(originHeader).hostname; } catch { /* ignore malformed */ }
    }

    const language = typeof rawLanguage === 'string' && LANGUAGE_RE.test(rawLanguage.trim())
      ? rawLanguage.trim()
      : undefined;
    // Always write a boost field so the host can update it later via
    // PATCH /rooms/:name/boost without needing to recreate the room.
    // Old clients that don't send boost are given sensible defaults.
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

    const roomName = generateRoomName(host, title);
    const metadata: RoomMetadata = {
      title,
      description,
      host,
      createdAt: new Date().toISOString(),
      backgroundImage,
      origin,
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
        tags: Array.isArray(rawTags) ? rawTags.slice(0, 10) : undefined,
      },
    };

    const room = await roomService.createRoom({
      name: roomName,
      maxParticipants: 500,
      emptyTimeout: 300,
      metadata: JSON.stringify(metadata),
    });

    // Issue a host token — premium gets video, non-premium gets audio only
    const token = await createLivekitToken(roomName, host, {
      canPublish: true,
      canPublishData: true,
      premium,
    });

    return reply.code(201).send({
      room: {
        name: room.name,
        title: metadata.title,
        host: metadata.host,
        description: metadata.description,
        backgroundImage: metadata.backgroundImage,
        createdAt: metadata.createdAt,
        origin: metadata.origin,
        visibility: metadata.visibility,
        language: metadata.language,
        boost: metadata.boost,
        mode: metadata.mode,
        post: metadata.post,
      },
      token,
      isPremium: premium,
    });
  });

  // Join a room as a listener (auth required — identity from session)
  fastify.post('/rooms/:name/join', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const identity = request.username;
    const { premium } = await getUserStatus(identity);

    // Verify the room exists
    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) {
      return reply.notFound('Room not found');
    }

    // Check if this user is the host — if so, give publish permissions
    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
    const isHost = meta.host === identity;
    // The approved collab guest keeps publish rights across a RECONNECT. The
    // host's promote sets permissions on the LIVE participant only, so a guest
    // whose phone dropped (airplane mode → page discarded → rejoin) would come
    // back with a fresh canPublish=false token and get bumped off camera, having
    // to ask again. `collabGuest` in room metadata persists the approval, so we
    // re-grant it here and CollabRequest puts them straight back on air.
    const isApprovedGuest = !!meta.collabGuest && meta.collabGuest === identity;

    const token = await createLivekitToken(name, identity, {
      canPublish: isHost || isApprovedGuest,
      canPublishData: true, // all participants can send data (hand raise, etc.)
      premium,
    });

    return reply.send({ token, roomName: name, identity, isHost, isPremium: premium });
  });

  // Guest token (NO auth). Anyone with the room URL can drop in to listen
  // and raise their hand to request speaking. Guests can be promoted to
  // speaker by the host, and banned (IP-scoped, per-room) if disruptive.
  fastify.post('/rooms/:name/listen', {
    config: {
      rateLimit: { max: 10, timeWindow: '5 minutes' },
    },
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: ['object', 'null'],
        properties: {
          displayName: { type: 'string', minLength: 2, maxLength: 32 },
          /** When true, issues an obs- identity: read-only, no data channel,
           *  invisible in participant lists. Used by the OBS browser source overlay. */
          silent: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { displayName: rawDisplayName, silent = false } =
      (request.body ?? {}) as { displayName?: string; silent?: boolean };
    const displayName = rawDisplayName?.trim() || undefined;

    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) return reply.notFound('Room not found');

    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    // `hive-internal` is the explicit "Hive accounts only" tier the operator
    // chose deliberately — honor it for EVERY mode. (`unlisted` still permits
    // link-based guest access; that's the whole point of unlisted.) The softer
    // allowGuests=false default is still bypassed for standalone so private
    // test streams stay watchable end-to-end.
    if (meta.visibility === 'hive-internal') {
      return reply.forbidden('This room is Hive-only — please sign in with your Hive account to join');
    }
    if (meta.mode !== 'standalone' && meta.allowGuests === false) {
      return reply.forbidden('This room is Hive-only — please sign in with your Hive account to join');
    }

    // OBS observers skip ban check and guest cap — they're invisible tooling,
    // not real participants, and are never addressable by the host's moderation UI.
    if (!silent) {
      if (isGuestBanned(name, request.ip)) {
        return reply.forbidden('You have been removed from this room');
      }

      try {
        const participants = await roomService.listParticipants(name);
        const guestCount = participants.filter((p) => p.identity.startsWith(GUEST_PREFIX)).length;
        if (guestCount >= MAX_GUESTS_PER_ROOM) {
          return reply.code(409).send({
            message: `Guest listener limit reached (${MAX_GUESTS_PER_ROOM}). Try again later.`,
          });
        }
      } catch (err) {
        request.log?.warn?.({ err }, 'guest listen: listParticipants failed, allowing through');
      }
    }

    // A signed-in viewer listens AS THEMSELVES.
    //
    // Viewers of a standalone stream aren't room participants, so the client
    // falls back from join() to listen() — and this endpoint used to hand out
    // a guest identity unconditionally. The result: a logged-in Hive user
    // appeared in chat as "Guest-xxxx" no matter what. Auth is OPTIONAL here
    // (anonymous listening must keep working), so the token is verified
    // leniently rather than via requireAuth.
    let authedUser: string | null = null;
    const authHeader = request.headers.authorization;
    if (!silent && authHeader?.startsWith('Bearer ')) {
      try {
        const session = await verifySessionToken(authHeader.slice(7));
        authedUser = session.sub;
      } catch { /* expired or bogus — carry on as a guest */ }
    }

    const identity = silent
      ? generateObsIdentity()
      : (authedUser ?? generateGuestIdentity());
    const token = await createLivekitToken(name, identity, {
      canPublish: false,
      canPublishData: !silent, // obs observers are purely read-only
      premium: false,
      ttl: silent ? '12h' : '6h',
      name: displayName ?? authedUser ?? undefined,
    });

    // Guest caps and IP bans apply to actual guests, not signed-in users.
    if (!silent && !authedUser) {
      recordGuestIp(name, identity, request.ip);
    }

    return reply.send({
      token,
      roomName: name,
      identity,
      isHost: false,
      isGuest: !silent && !authedUser,
      isPremium: false,
    });
  });

  // Set the room's display/recording layout AND/OR the host's transient
  // view state (focused speaker, screen-share suppression). Stored in
  // room metadata so the egress template can read it via useRoomInfo —
  // that's the same path layoutMode already uses, and it's known to
  // propagate reliably across all clients including the headless
  // egress browser. Host only.
  fastify.patch('/rooms/:name/layout', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          layout: { type: 'string', enum: ['speaker', 'grid', 'single'] },
          focusedIdentity: { type: ['string', 'null'] },
          suppressScreenAutoFocus: { type: 'boolean' },
          chatOpen: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = (request.body ?? {}) as {
      layout?: 'speaker' | 'grid' | 'single';
      focusedIdentity?: string | null;
      suppressScreenAutoFocus?: boolean;
      chatOpen?: boolean;
    };

    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) return reply.notFound('Room not found');

    let meta: Partial<RoomMetadata> & {
      recordLayout?: string;
      focusedIdentity?: string | null;
      suppressScreenAutoFocus?: boolean;
      chatOpen?: boolean;
    } = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    if (meta.host !== request.username) {
      return reply.forbidden('Only the host can change the room layout');
    }

    const next = { ...meta };
    if (body.layout !== undefined) next.recordLayout = body.layout;
    if (body.focusedIdentity !== undefined) next.focusedIdentity = body.focusedIdentity;
    if (body.suppressScreenAutoFocus !== undefined) next.suppressScreenAutoFocus = body.suppressScreenAutoFocus;
    if (body.chatOpen !== undefined) next.chatOpen = body.chatOpen;

    await roomService.updateRoomMetadata(name, JSON.stringify(next));

    return reply.send({
      layout: next.recordLayout,
      focusedIdentity: next.focusedIdentity ?? null,
      suppressScreenAutoFocus: !!next.suppressScreenAutoFocus,
      chatOpen: next.chatOpen ?? true,
    });
  });

  // Update boost/superchat config for an existing room (host only).
  fastify.patch('/rooms/:name/boost', {
    preHandler: [requireAuth],
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          minBoostUsd: { type: 'number', minimum: 0 },
          creatorPayoutAccount: { type: 'string', maxLength: 16 },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as {
      enabled?: boolean;
      minBoostUsd?: number;
      creatorPayoutAccount?: string;
    };

    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) return reply.notFound('Room not found');

    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    if (meta.host !== request.username) {
      return reply.forbidden('Only the host can update boost settings');
    }

    const existing = (meta.boost && typeof meta.boost === 'object' && !Array.isArray(meta.boost))
      ? meta.boost as Record<string, unknown>
      : {};

    const next = {
      ...meta,
      boost: {
        ...existing,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.minBoostUsd !== undefined ? { minBoostUsd: body.minBoostUsd } : {}),
        ...(body.creatorPayoutAccount !== undefined ? { creatorPayoutAccount: body.creatorPayoutAccount || undefined } : {}),
      },
    };

    await roomService.updateRoomMetadata(name, JSON.stringify(next));
    return reply.send({ boost: next.boost });
  });

  // Update the feed-post details (title/thumbnail/description/tags) for a
  // standalone stream — composed in the studio's post editor. Host only.
  // Merges into metadata.post so partial updates are fine.
  fastify.patch('/rooms/:name/post', {
    preHandler: [requireAuth],
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 160 },
          thumbnail: { type: 'string', maxLength: 512 },
          description: { type: 'string', maxLength: 5000 },
          tags: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as { title?: string; thumbnail?: string; description?: string; tags?: string[] };

    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) return reply.notFound('Room not found');

    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    if (meta.host !== request.username) {
      return reply.forbidden('Only the host can update the stream post');
    }

    const existing = (meta.post && typeof meta.post === 'object' && !Array.isArray(meta.post))
      ? meta.post as Record<string, unknown>
      : {};

    const post = {
      ...existing,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.thumbnail !== undefined ? { thumbnail: body.thumbnail } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.tags !== undefined ? { tags: body.tags.slice(0, 10) } : {}),
    };

    // Same lock as /live and /broadcast: the studio autosaves the post at the
    // exact moment the host goes live.
    await mutateRoomMetadata(name, (current) => ({ ...current, post }));
    return reply.send({ post });
  });

  // Toggle the "broadcasting" flag for a standalone stream (host only).
  // The studio sets true on Start/Resume and false on Pause — this is what
  // makes a stream appear in / disappear from the live feeds.
  // --- OBS ingest (WHIP) --------------------------------------------------
  // Creates a WHIP ingress so the host can publish from OBS 30+ straight into
  // their room as a participant. WHIP (not RTMP) on purpose: with transcoding
  // bypassed the encoded tracks are forwarded as-is, so the cost is close to a
  // normal publisher instead of a decode/re-encode per stream.
  //
  // The ingress participant identity is prefixed `obs-` so every existing
  // viewer-count filter already treats it as tooling rather than an audience
  // member.
  fastify.post('/rooms/:name/ingress', {
    preHandler: [requireAuth],
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { transcode: { type: 'boolean' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    // Passthrough forwards OBS's encoded H.264 untouched, which is cheap —
    // but plenty of Firefox builds (any Linux one without the OpenH264
    // plugin) offer only VP8/VP9/AV1, and the SFU then can't bind the track
    // at all: "codec is not supported by remote". No packets are sent, so the
    // host sees a permanently black source. Those hosts ask for transcoding,
    // which must re-encode to VP8 — transcoding to H.264 would hit exactly
    // the same wall.
    // Defaults ON: an H.264 passthrough ingress is invisible to any browser
    // without H.264 receive support, and that can't be detected reliably
    // client-side. Callers must opt IN to passthrough.
    const transcode = (request.body as { transcode?: boolean } | undefined)?.transcode !== false;

    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) return reply.notFound('Room not found');
    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
    if (meta.host !== request.username) return reply.forbidden('Only the host can set up OBS ingest');

    const identity = `obs-ingress-${name}`;

    try {
      // Reuse an existing ingress for this room so repeated clicks don't pile
      // up stale endpoints (and the host keeps the same key).
      // The mode is baked into the name so a reused ingress in the wrong mode
      // is detected and rebuilt — neither transcoding nor the output codec
      // can be changed on a live one.
      const desiredName = transcode ? `obs-${name}-vp8` : `obs-${name}`;

      let existing = (await ingressClient.listIngress({ roomName: name }))
        .find((i) => i.participantIdentity === identity);

      if (existing && existing.name !== desiredName) {
        try { await ingressClient.deleteIngress(existing.ingressId); } catch { /* already gone */ }
        existing = undefined;
      }

      const info = existing ?? await ingressClient.createIngress(
        IngressInput.WHIP_INPUT,
        {
          name: desiredName,
          roomName: name,
          participantIdentity: identity,
          participantName: 'OBS',
          // Passthrough is what keeps WHIP cheap — used whenever the host's
          // browser can receive H.264 as-is.
          enableTranscoding: transcode,
          // Every built-in preset is H.264, so VP8 needs explicit options.
          // One layer, not simulcast: the studio composites this into its own
          // canvas and re-encodes, so extra ingress layers would be waste.
          ...(transcode ? {
            video: new IngressVideoOptions({
              source: TrackSource.CAMERA,
              encodingOptions: {
                case: 'options',
                value: new IngressVideoEncodingOptions({
                  videoCodec: VideoCodec.VP8,
                  frameRate: 30,
                  // No explicit layers: let the ingress derive them from the
                  // input. Pinning a single hand-rolled 720p layer made the
                  // pipeline fail to start ("source encoder not ready") and
                  // publish nothing at all.
                }),
              },
            }),
          } : {}),
        },
      );

      return reply.send({
        ingressId: info.ingressId,
        // OBS: paste this whole URL into the WHIP output. The stream key is
        // the last path segment, so no bearer token is needed.
        whipUrl: `${config.INGRESS_WHIP_URL}/${info.streamKey}`,
        streamKey: info.streamKey,
        participantIdentity: identity,
      });
    } catch (err) {
      request.log.error({ err }, 'ingress create failed');
      return reply.code(503).send({ message: 'Could not set up OBS ingest' });
    }
  });

  fastify.delete('/rooms/:name/ingress', {
    preHandler: [requireAuth],
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) return reply.notFound('Room not found');
    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }
    if (meta.host !== request.username) return reply.forbidden('Only the host can remove OBS ingest');

    try {
      const list = await ingressClient.listIngress({ roomName: name });
      await Promise.all(
        list
          .filter((i) => i.participantIdentity === `obs-ingress-${name}`)
          .map((i) => ingressClient.deleteIngress(i.ingressId)),
      );
      return reply.send({ ok: true });
    } catch (err) {
      request.log.error({ err }, 'ingress delete failed');
      return reply.code(503).send({ message: 'Could not remove OBS ingest' });
    }
  });

  // Stamp the moment the host actually goes live, and record whether they
  // asked for the broadcast to be published as a VOD.
  //
  // Both answer questions the watch page can't answer for itself. The stamp
  // anchors live-chat timecodes to the recording's timeline — `createdAt` is
  // when the room was OPENED, which can be long before the host hits Start, and
  // the Hive announcement's own timestamp drifts by however long the broadcast
  // took to land. The VOD flag lets the watch page say "the recording is
  // processing" the instant the host leaves, instead of waiting for the encoder
  // to create a row (or promising a video that was never going to exist).
  //
  // Stamped by the SERVER, not the client: viewers subtract this from their own
  // clock, so a streamer with a skewed clock would shift every timecode.
  fastify.patch('/rooms/:name/live', {
    preHandler: [requireAuth],
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { willPublishVod: { type: 'boolean' }, portrait: { type: 'boolean' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { willPublishVod, portrait } = (request.body ?? {}) as {
      willPublishVod?: boolean; portrait?: boolean;
    };

    // Serialised: Start fires this alongside /post and /broadcast, and three
    // concurrent read-modify-writes on one metadata blob lose each other's
    // fields. This one losing meant no liveAt to anchor chat timecodes to.
    let liveAt = '';
    let forbidden = false;
    let notFound = false;
    try {
      await mutateRoomMetadata(name, (meta) => {
        if (meta.host !== request.username) { forbidden = true; return null; }
        // First go-live wins — a pause/resume must not restart the clock, or
        // every timecode after the break is measured from the wrong origin.
        liveAt = (typeof meta.liveAt === 'string' && meta.liveAt) || new Date().toISOString();
        return {
          ...meta, liveAt, willPublishVod: !!willPublishVod,
          // Which way up the broadcast is. The recorder sizes its output from
          // this — a phone recorded at 1280x720 gets black pillars baked in.
          ...(portrait === undefined ? {} : { portrait }),
        };
      });
    } catch { notFound = true; }
    if (notFound) return reply.notFound('Room not found');
    if (forbidden) return reply.forbidden('Only the host can start the stream');
    return reply.send({ liveAt, willPublishVod: !!willPublishVod, portrait: !!portrait });
  });

  fastify.patch('/rooms/:name/broadcast', {
    preHandler: [requireAuth],
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      body: { type: 'object', required: ['broadcasting'], properties: { broadcasting: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { broadcasting } = request.body as { broadcasting: boolean };

    let forbidden = false;
    let notFound = false;
    try {
      await mutateRoomMetadata(name, (meta) => {
        if (meta.host !== request.username) { forbidden = true; return null; }
        return { ...meta, broadcasting };
      });
    } catch { notFound = true; }
    if (notFound) return reply.notFound('Room not found');
    if (forbidden) return reply.forbidden('Only the host can change broadcast state');
    return reply.send({ broadcasting });
  });

  // Transfer host role to another participant (host only). Updates the
  // room metadata so subsequent host-only checks (verifyHost in
  // participants.ts, etc.) accept the new host. Also promotes the new
  // host to canPublish=true so they're not stuck as a listener.
  fastify.post('/rooms/:name/host', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['newHost'],
        properties: { newHost: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { newHost } = request.body as { newHost: string };

    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) return reply.notFound('Room not found');

    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    if (meta.host !== request.username) {
      return reply.forbidden('Only the host can transfer the room');
    }

    // A standalone stream is its creator's one-man broadcast — handing it
    // over would grant publish rights to a viewer. Not a thing.
    if (meta.mode === 'standalone') {
      return reply.forbidden('Standalone stream rooms cannot be handed over');
    }

    // Make sure the new host is actually in the room.
    const participants = await roomService.listParticipants(name);
    const target = participants.find((p) => p.identity === newHost);
    if (!target) return reply.notFound('That participant is not in the room');

    await roomService.updateRoomMetadata(name, JSON.stringify({ ...meta, host: newHost }));
    await roomService.updateParticipant(name, newHost, undefined, {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return reply.send({ host: newHost });
  });

  // Delete/close a room (auth required — host only)
  fastify.delete('/rooms/:name', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };

    // Verify caller is the host
    const rooms = await roomService.listRooms([name]);
    if (rooms.length === 0) {
      return reply.notFound('Room not found');
    }

    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    if (meta.host !== request.username) {
      return reply.forbidden('Only the host can close the room');
    }

    await roomService.deleteRoom(name);
    clearRoomBans(name);
    return reply.code(204).send();
  });
};
