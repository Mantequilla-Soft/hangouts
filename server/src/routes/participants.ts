import type { FastifyPluginAsync } from 'fastify';
import { roomService } from '../lib/livekit.js';
import { mutateRoomMetadata } from '../lib/roomMeta.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { banGuestByIdentity } from '../lib/guestBans.js';

type RoomMeta = { host?: string; mode?: string; collabGuest?: string; mods?: string[] };

/** Parse room metadata and verify the caller is the host. */
async function verifyHost(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };

  let meta: RoomMeta = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

  if (meta.host !== username) return { error: 'forbidden' as const };
  return { error: null, meta, raw: rooms[0] };
}

/**
 * Verify the caller may MODERATE — the host, or a Hive user the host promoted
 * to moderator (persisted in `meta.mods`). Used for behavioural moderation
 * (kick / ban). Structural powers (changing publish permissions, minting other
 * mods, ending the room) stay host-only via verifyHost.
 */
async function verifyHostOrMod(roomName: string, username: string) {
  const rooms = await roomService.listRooms([roomName]);
  if (rooms.length === 0) return { error: 'not_found' as const };

  let meta: RoomMeta = {};
  try { meta = JSON.parse(rooms[0].metadata || '{}'); } catch { /* ignore */ }

  const isHost = meta.host === username;
  const isMod = Array.isArray(meta.mods) && meta.mods.includes(username);
  if (!isHost && !isMod) return { error: 'forbidden' as const };
  return { error: null, meta, isHost, isMod };
}

/**
 * Record (or clear) which viewer currently holds the stream's single collab
 * slot. Lives in room metadata so the cap survives a host reload and the studio
 * can tell who is on air without tracking it client-side.
 */
async function setCollabGuest(roomName: string, identity: string | null) {
  // Under the same per-room lock as the go-live/broadcast writes: promoting a
  // guest happens mid-stream, while the broadcast heartbeat is writing every
  // 15s, and an unsynchronised read-modify-write here would drop either the
  // collab slot or the heartbeat's flag.
  await mutateRoomMetadata(roomName, (meta) => {
    const next = { ...meta };
    if (identity) next.collabGuest = identity;
    else delete next.collabGuest;
    return next;
  });
}

export const participantRoutes: FastifyPluginAsync = async (fastify) => {
  // Promote/demote a participant (host only)
  fastify.patch('/rooms/:name/participants/:identity/permissions', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name', 'identity'],
        properties: {
          name:     { type: 'string' },
          identity: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['canPublish'],
        properties: {
          canPublish: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, identity } = request.params as { name: string; identity: string };
    const { canPublish } = request.body as { canPublish: boolean };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can change permissions');

    // A standalone stream is normally one broadcaster — the host's composited
    // program feed. A host-approved collab is the ONE exception, and it is
    // capped at a single guest: the top/bottom split has room for exactly one,
    // and the host's phone is already compositing and encoding, so a second
    // decode is what tips a mobile SoC into dropping frames.
    if (check.meta?.mode === 'standalone') {
      if (canPublish) {
        const current = check.meta.collabGuest;
        if (current && current !== identity) {
          // Only refuse if that guest is STILL HERE. A stale name — they closed
          // the tab, lost signal, were kicked — must not wedge the slot shut,
          // since nothing clears it when a participant simply disappears.
          let stillPresent = false;
          try {
            const parts = await roomService.listParticipants(name);
            stillPresent = parts.some((p) => p.identity === current);
          } catch { /* can't tell — let the new guest in rather than deadlock */ }
          if (stillPresent) {
            return reply.conflict('This stream already has a guest. Remove them first.');
          }
        }
        await setCollabGuest(name, identity);
      } else if (check.meta.collabGuest === identity) {
        await setCollabGuest(name, null);
      }
    }

    const updated = await roomService.updateParticipant(name, identity, undefined, {
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    });

    return reply.send({
      identity: updated.identity,
      canPublish: updated.permission?.canPublish ?? false,
    });
  });

  // Kick a participant (host only)
  fastify.delete('/rooms/:name/participants/:identity', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name', 'identity'],
        properties: {
          name:     { type: 'string' },
          identity: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, identity } = request.params as { name: string; identity: string };

    const check = await verifyHostOrMod(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host or a moderator can remove participants');

    await roomService.removeParticipant(name, identity);
    return reply.code(204).send();
  });

  // Ban a guest from this room (host only). Records their IP so they
  // can't rejoin, then kicks them immediately. Guest-only — Hive users
  // are banned through the platform's user management system.
  fastify.post('/rooms/:name/participants/:identity/ban', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name', 'identity'],
        properties: {
          name:     { type: 'string' },
          identity: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, identity } = request.params as { name: string; identity: string };

    if (!identity.startsWith('guest-')) {
      return reply.badRequest('Ban is only for guest participants; use the platform system to ban Hive accounts');
    }

    const check = await verifyHostOrMod(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host or a moderator can ban participants');

    banGuestByIdentity(name, identity);
    try {
      await roomService.removeParticipant(name, identity);
    } catch {
      // Guest may have already left — ban is still recorded.
    }

    return reply.code(204).send();
  });

  // Grant/revoke moderator (HOST ONLY). Moderators are Hive usernames stored in
  // room metadata so the server can authorize their kick/ban and every client
  // learns who's a mod from the same broadcast. Anonymous guests can't be mods
  // — they have no Hive identity to authenticate a moderation action with.
  fastify.patch('/rooms/:name/mods/:username', {
    preHandler: [requireAuth, checkBan],
    schema: {
      params: {
        type: 'object',
        required: ['name', 'username'],
        properties: {
          name:     { type: 'string' },
          username: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['isMod'],
        properties: { isMod: { type: 'boolean' } },
      },
    },
  }, async (request, reply) => {
    const { name, username: target } = request.params as { name: string; username: string };
    const { isMod } = request.body as { isMod: boolean };

    const check = await verifyHost(name, request.username);
    if (check.error === 'not_found') return reply.notFound('Room not found');
    if (check.error === 'forbidden') return reply.forbidden('Only the host can change moderators');

    // A mod must be a real Hive account (they authenticate their own actions);
    // the host is implicitly a moderator and never needs to be in the list.
    const clean = target.trim().toLowerCase();
    if (!clean || clean.startsWith('guest-')) {
      return reply.badRequest('Only signed-in Hive users can be moderators');
    }
    if (clean === check.meta?.host) {
      return reply.badRequest('The host is already a moderator');
    }

    const next = await mutateRoomMetadata(name, (meta) => {
      const current = Array.isArray(meta.mods) ? (meta.mods as string[]) : [];
      const set = new Set(current.map((m) => String(m).toLowerCase()));
      if (isMod) set.add(clean); else set.delete(clean);
      return { ...meta, mods: [...set] };
    });

    return reply.send({ mods: (next.mods as string[]) ?? [] });
  });
};
