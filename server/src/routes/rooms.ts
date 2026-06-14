import type { FastifyPluginAsync } from 'fastify';
import { roomService, generateRoomName, createLivekitToken } from '../lib/livekit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { getUserStatus } from '../lib/users.js';
import { recordGuestIp, isGuestBanned, clearRoomBans } from '../lib/guestBans.js';

type RoomVisibility = 'public' | 'hive-internal' | 'unlisted';
const ROOM_VISIBILITIES: readonly RoomVisibility[] = ['public', 'hive-internal', 'unlisted'];
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
function isRoomVisibility(v: unknown): v is RoomVisibility {
  return typeof v === 'string' && (ROOM_VISIBILITIES as readonly string[]).includes(v);
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
      };
    }));

    return reply.send(result);
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
    });
  });

  // Create a room (auth required — caller becomes host)
  fastify.post('/rooms', {
    preHandler: [requireAuth, checkBan],
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title:           { type: 'string', minLength: 1, maxLength: 64 },
          description:     { type: 'string', maxLength: 256 },
          backgroundImage: { type: 'string', maxLength: 512 },
          visibility:      { type: 'string', enum: ROOM_VISIBILITIES as unknown as string[] },
          language:        { type: 'string', maxLength: 16 },
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
    const { title, description, backgroundImage, visibility: bodyVisibility, language: rawLanguage, boost: rawBoost } =
      request.body as {
        title: string;
        description?: string;
        backgroundImage?: string;
        visibility?: string;
        language?: string;
        boost?: { enabled?: boolean; minBoostUsd?: number; creatorPayoutAccount?: string };
      };
    const host = request.username;
    const { premium } = await getUserStatus(host);

    // Default to `public` for older clients that don't send the field.
    const visibility: RoomVisibility = isRoomVisibility(bodyVisibility) ? bodyVisibility : 'public';

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

    const token = await createLivekitToken(name, identity, {
      canPublish: isHost,
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

    if (meta.allowGuests === false || meta.visibility === 'hive-internal') {
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

    const identity = silent ? generateObsIdentity() : generateGuestIdentity();
    const token = await createLivekitToken(name, identity, {
      canPublish: false,
      canPublishData: !silent, // obs observers are purely read-only
      premium: false,
      ttl: silent ? '12h' : '2h',
      name: displayName,
    });

    if (!silent) {
      recordGuestIp(name, identity, request.ip);
    }

    return reply.send({
      token,
      roomName: name,
      identity,
      isHost: false,
      isGuest: !silent,
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
