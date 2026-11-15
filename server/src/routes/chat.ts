import type { FastifyPluginAsync } from 'fastify';
import { headlessViewerIdentity } from '../lib/headlessStreams.js';
import { isUserBanned } from '../lib/users.js';
import { isGuestBanned } from '../lib/guestBans.js';
import {
  addBacklogMessage, clampTimestamp, getBacklog, removeBacklogMessage, CHAT_TEXT_MAX,
} from '../lib/chatBacklog.js';
import { isHostOrMod, livekitIdentity, readRoomMeta, sendRoomData, sessionUser } from '../lib/liveRoom.js';
import { noteChat } from '../lib/streamHighlights.js';

/** Rooms seen to exist recently, so a busy chat is not one LiveKit lookup per line. */
const KNOWN_TTL_MS = 15_000;
const knownRooms = new Map<string, number>();

async function roomExists(name: string): Promise<boolean> {
  const at = knownRooms.get(name);
  if (at && Date.now() - at < KNOWN_TTL_MS) return true;
  const meta = await readRoomMeta(name);
  if (!meta) { knownRooms.delete(name); return false; }
  if (knownRooms.size > 2000) knownRooms.clear();
  knownRooms.set(name, Date.now());
  return true;
}

/** Test helper. */
export function resetKnownRooms(): void {
  knownRooms.clear();
}

/**
 * The chat backlog (lib/chatBacklog.ts) over HTTP.
 *
 *   GET    /rooms/:name/chat         the newest lines, for a viewer who just joined
 *   POST   /rooms/:name/chat         the sender's copy of a line it just sent
 *   DELETE /rooms/:name/chat/:id     a host or moderator takes a line down
 */
export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/rooms/:name/chat', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } },
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 1000 } } },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { limit } = request.query as { limit?: number };
    reply.header('Cache-Control', 'no-store');

    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    // Hive-only rooms refuse guests at the door; their chat is no different.
    if (meta.visibility === 'hive-internal' && !(await sessionUser(request))) {
      return reply.forbidden('This room is Hive-only');
    }

    const lines = await getBacklog(name, limit);
    // A Hive account suspended since it wrote: its lines go, like at the door.
    // isUserBanned is cached per account, so this is a handful of lookups at most.
    const accounts = [...new Set(lines.filter((m) => !m.system && !m.identity.startsWith('guest-'))
      .map((m) => m.identity.replace(/~watch$/, '')))];
    const banned = new Set<string>();
    await Promise.all(accounts.map(async (a) => { if (await isUserBanned(a).catch(() => false)) banned.add(a); }));
    const messages = banned.size
      ? lines.filter((m) => !banned.has(m.identity.replace(/~watch$/, '')))
      : lines;
    return reply.send({ messages });
  });

  fastify.post('/rooms/:name/chat', {
    // Generous for a fast chat, tight enough that a script cannot flood the log.
    config: { rateLimit: { max: 30, timeWindow: '20 seconds' } },
    schema: {
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } },
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 2000 },
          timestamp: { type: 'number' },
          identity: { type: 'string', maxLength: 80 },
          name: { type: 'string', maxLength: 128 },
          /** A guest proves who they are with their room token instead of a session. */
          livekitToken: { type: 'string', maxLength: 4096 },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as { text: string; timestamp?: number; identity?: string; name?: string; livekitToken?: string };

    const text = body.text.trim().slice(0, CHAT_TEXT_MAX);
    if (!text) return reply.badRequest('Empty message');

    const account = await sessionUser(request);
    let identity: string | null = null;
    if (account) {
      // The host's second device chats as `<host>~watch`: both are this account.
      const wanted = body.identity ?? account;
      if (wanted !== account && wanted !== headlessViewerIdentity(account)) {
        return reply.forbidden('That is not your chat identity');
      }
      if (await isUserBanned(account)) return reply.forbidden('Your account has been suspended');
      identity = wanted;
    } else {
      identity = await livekitIdentity(body.livekitToken, name);
      if (!identity) return reply.unauthorized('Sign in or join the room first');
      if (isGuestBanned(name, request.ip)) return reply.forbidden('You have been removed from this room');
    }

    if (!(await roomExists(name))) return reply.notFound('Room not found');

    const timestamp = clampTimestamp(body.timestamp);
    const added = addBacklogMessage(name, {
      // The same id the clients give the line (useChat), so the backlog and
      // the live copy of one message dedupe into one.
      id: `${identity}-${typeof body.timestamp === 'number' ? Math.round(body.timestamp) : timestamp}`,
      identity,
      name: (body.name?.trim() || account || identity),
      text,
      timestamp,
    });
    // Highlight moments (H13): a new line counts for its verified sender (the
    // host's second device is the same person). Map lookup + Set add, no I/O.
    if (added) noteChat(name, `u:${identity.replace(/~watch$/, '')}`);
    return reply.code(added ? 201 : 200).send({ ok: true });
  });

  fastify.delete('/rooms/:name/chat/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      params: {
        type: 'object',
        required: ['name', 'id'],
        properties: { name: { type: 'string', maxLength: 128 }, id: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    const { name, id } = request.params as { name: string; id: string };
    const user = await sessionUser(request);
    if (!user) return reply.unauthorized('Sign in first');
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (!isHostOrMod(meta, user)) return reply.forbidden('Only the host or a moderator can delete messages');

    await removeBacklogMessage(name, id);
    // Everyone in the room drops it from their list too.
    await sendRoomData(name, 'chat', { type: 'chat-delete', id });
    return reply.code(204).send();
  });
};
