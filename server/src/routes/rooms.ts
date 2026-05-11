import type { FastifyPluginAsync } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { roomService } from '../lib/livekit.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { getUserStatus } from '../lib/users.js';

type RoomVisibility = 'public' | 'hive-internal' | 'unlisted';
const ROOM_VISIBILITIES: readonly RoomVisibility[] = ['public', 'hive-internal', 'unlisted'];
function isRoomVisibility(v: unknown): v is RoomVisibility {
  return typeof v === 'string' && (ROOM_VISIBILITIES as readonly string[]).includes(v);
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
}

/** Identity prefix used for unauthenticated guest listeners. */
const GUEST_PREFIX = 'guest-';
const MAX_GUESTS_PER_ROOM = Number(process.env.MAX_GUESTS_PER_ROOM ?? 100);

function generateGuestIdentity(): string {
  // 12 chars from a URL-safe alphabet — enough entropy that a single room
  // would have to host ~10M concurrent guests before collisions become
  // likely. Server has guest cap below that anyway.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${GUEST_PREFIX}${id}`;
}

function generateRoomName(username: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const id = Math.random().toString(36).slice(2, 8);
  return `${username}-${slug}-${id}`;
}

async function createLivekitToken(
  room: string,
  identity: string,
  options: { canPublish: boolean; canPublishData: boolean; premium?: boolean; ttl?: string },
): Promise<string> {
  const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity,
    ttl: options.ttl ?? '6h',
  });

  const grant: Record<string, unknown> = {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublishData: options.canPublishData,
  };

  // canPublish controls whether the participant can publish any track at all.
  // Camera/screenshare gating for non-premium users is handled on the frontend —
  // canPublishSources source restrictions were unreliable across SDK versions.
  grant.canPublish = options.canPublish;

  at.addGrant(grant);
  return at.toJwt();
}

export const roomRoutes: FastifyPluginAsync = async (fastify) => {
  // List active rooms (public — no auth required). Filters out rooms
  // marked `unlisted`; those are reachable only by direct link.
  fastify.get('/rooms', async (_request, reply) => {
    const rooms = await roomService.listRooms();

    const result = rooms
      .map((r) => {
        let meta: Partial<RoomMetadata> = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }
        return { r, meta };
      })
      .filter(({ meta }) => meta.visibility !== 'unlisted')
      .map(({ r, meta }) => ({
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
        },
      },
    },
  }, async (request, reply) => {
    const { title, description, backgroundImage, visibility: bodyVisibility } =
      request.body as { title: string; description?: string; backgroundImage?: string; visibility?: string };
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

  // Listen-only guest token (NO auth). Anyone with the room URL can drop
  // in to hear the conversation; they cannot publish audio, can't send
  // chat data, and can't be promoted. Designed for "share a link, drop
  // in" UX — see docs at /home/dockeruser/listenermode.md.
  fastify.post('/rooms/:name/listen', {
    config: {
      // Tighter rate limit than the global default; per-IP, generous
      // enough to absorb a refresh / network glitch but tight enough to
      // make scripted abuse pointless.
      rateLimit: { max: 10, timeWindow: '5 minutes' },
    },
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
    if (rooms.length === 0) return reply.notFound('Room not found');

    let meta: Partial<RoomMetadata> = {};
    try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

    // Two ways to forbid guests: explicit `allowGuests:false` on legacy
    // rooms, or the newer `visibility:'hive-internal'` tier. Either one
    // requires Hive sign-in to enter.
    if (meta.allowGuests === false || meta.visibility === 'hive-internal') {
      return reply.forbidden('This room is Hive-only — please sign in with your Hive account to join');
    }

    // Per-room guest cap. Counted by identity prefix, since LiveKit
    // doesn't track our notion of "authenticated vs guest" on its side.
    try {
      const participants = await roomService.listParticipants(name);
      const guestCount = participants.filter((p) => p.identity.startsWith(GUEST_PREFIX)).length;
      if (guestCount >= MAX_GUESTS_PER_ROOM) {
        return reply.code(409).send({
          message: `Guest listener limit reached (${MAX_GUESTS_PER_ROOM}). Try again later.`,
        });
      }
    } catch (err) {
      // listParticipants can transiently fail right after a room is
      // created (LiveKit room not yet warm). Don't block the listener
      // over that — the LiveKit connect will reject if the room really
      // is missing.
      request.log?.warn?.({ err }, 'guest listen: listParticipants failed, allowing through');
    }

    const identity = generateGuestIdentity();
    const token = await createLivekitToken(name, identity, {
      canPublish: false,
      canPublishData: false,
      premium: false,
      ttl: '2h',
    });

    return reply.send({
      token,
      roomName: name,
      identity,
      isHost: false,
      isGuest: true,
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
    return reply.code(204).send();
  });
};
