import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { roomService } from '../lib/livekit.js';
import { readRoomMeta, sendRoomData, type LiveRoomMeta } from '../lib/liveRoom.js';
import { addBacklogMessage } from '../lib/chatBacklog.js';
import {
  RaidError, acceptsRaids, cancelRaid, pendingRaid, raidCooldownUntil, setAcceptsRaids, startRaid,
  type Raid, type RaidTarget,
} from '../lib/raids.js';

/**
 * Raids (lib/raids.ts) over HTTP.
 *
 *   GET    /rooms/:name/raid/targets   host: the live streams they can raid
 *   GET    /rooms/:name/raid           anyone: the raid counting down here, if any
 *   POST   /rooms/:name/raid           host: start one ({ target })
 *   DELETE /rooms/:name/raid           host: call it off during the countdown
 *   GET|PUT /raids/settings            a host's "accept incoming raids" switch
 *
 * Data messages: the source room gets `raid` topic { type: 'raid-start' | 'raid-go'
 * | 'raid-cancel' }, the target room a system line on the `chat` topic.
 */

interface LiveStream extends RaidTarget {
  viewers: number;
  thumbnail?: string;
}

const SCAN_TTL_MS = 5000;
let scan: { at: number; list: LiveStream[] } | null = null;
let scanning: Promise<LiveStream[]> | null = null;

/** Every public live stream: broadcasting, host connected. Shared for a few seconds. */
async function liveStreams(): Promise<LiveStream[]> {
  if (scan && Date.now() - scan.at < SCAN_TTL_MS) return scan.list;
  scanning ??= (async () => {
    try {
      const rooms = await roomService.listRooms();
      const candidates = rooms
        .map((r) => {
          let meta: LiveRoomMeta = {};
          try { meta = JSON.parse(r.metadata || '{}'); } catch { /* ignore */ }
          return { name: r.name, meta };
        })
        // Link-only and Hive-only streams are not raid targets: half the
        // raiders could not get in, and an unlisted stream must stay private.
        .filter(({ meta }) => meta.mode === 'standalone' && meta.broadcasting && meta.host
          && (meta.visibility ?? 'public') === 'public');
      const list = await Promise.all(candidates.map(async ({ name, meta }) => {
        try {
          const parts = await roomService.listParticipants(name);
          if (!parts.some((p) => p.identity === meta.host)) return null;
          const viewers = parts.filter((p) => p.identity !== meta.host && p.identity !== meta.collabGuest
            && !p.identity.startsWith('obs-')).length;
          const post = (meta as { post?: { title?: string; thumbnail?: string } }).post;
          return {
            roomName: name,
            host: meta.host!,
            title: post?.title || meta.title || name,
            viewers,
            ...(post?.thumbnail ? { thumbnail: post.thumbnail } : {}),
          } as LiveStream;
        } catch { return null; }
      }));
      const out = list.filter((s): s is LiveStream => !!s).sort((a, b) => b.viewers - a.viewers);
      scan = { at: Date.now(), list: out };
      return out;
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

/** Test helper. */
export function resetRaidScan(): void {
  scan = null;
  scanning = null;
}

async function viewerCount(room: string, meta: LiveRoomMeta): Promise<number> {
  try {
    const parts = await roomService.listParticipants(room);
    return parts.filter((p) => p.identity !== meta.host && p.identity !== meta.collabGuest
      && !p.identity.startsWith('obs-') && !p.identity.endsWith('~watch')).length;
  } catch {
    return 0;
  }
}

/** `endsInMs` too, so a viewer whose clock is off still counts down right. */
function publicRaid(r: Raid) {
  return { id: r.id, from: r.from, target: r.target, viewers: r.viewers, endsAt: r.endsAt, endsInMs: Math.max(0, r.endsAt - Date.now()) };
}

const nameParam = { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } } as const;

export const raidRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/rooms/:name/raid/targets', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' }, dock: true },
    schema: { params: nameParam },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (meta.host !== request.username) return reply.forbidden('Only the host can raid');
    const all = (await liveStreams()).filter((s) => s.roomName !== name && s.host !== meta.host);
    const open = await Promise.all(all.map(async (s) => ((await acceptsRaids(s.host)) ? s : null)));
    reply.header('Cache-Control', 'no-store');
    return reply.send({
      targets: open.filter(Boolean),
      cooldownUntil: raidCooldownUntil(request.username) || null,
    });
  });

  fastify.get('/rooms/:name/raid', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { params: nameParam },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    reply.header('Cache-Control', 'no-store');
    const r = pendingRaid(name);
    return reply.send({ raid: r ? publicRaid(r) : null });
  });

  fastify.post('/rooms/:name/raid', {
    preHandler: [requireAuth, checkBan],
    // A backstop per address; the per-host cooldown in lib/raids.ts is the real limit.
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' }, dock: true },
    schema: {
      params: nameParam,
      body: { type: 'object', required: ['target'], properties: { target: { type: 'string', maxLength: 128 } } },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { target } = request.body as { target: string };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (meta.host !== request.username) return reply.forbidden('Only the host can raid');
    if (meta.mode !== 'standalone') return reply.badRequest('Raids are for streams');
    if (target === name) return reply.badRequest('Pick another stream');

    // Re-read the target now rather than trust the list the host saw.
    const streams = await liveStreams();
    const t = streams.find((s) => s.roomName === target);
    if (!t) return reply.code(404).send({ message: 'That stream is not live any more.' });
    if (t.host === meta.host) return reply.badRequest('Pick another stream');
    if (!(await acceptsRaids(t.host))) return reply.code(403).send({ message: 'That streamer does not take raids.' });

    const viewers = await viewerCount(name, meta);
    try {
      const raid = startRaid(
        { from: meta.host, fromRoom: name, target: { roomName: t.roomName, host: t.host, title: t.title }, viewers },
        async (r) => {
          const line = {
            id: `raid-${r.id}`,
            identity: r.from,
            name: r.from,
            text: `${r.from} is raiding with ${r.viewers} viewers`,
            timestamp: Date.now(),
            system: { kind: 'raid' as const, from: r.from, viewers: r.viewers },
          };
          // In the target's backlog too, so viewers who arrive with the raid see it.
          addBacklogMessage(r.target.roomName, line);
          await sendRoomData(r.target.roomName, 'chat', { type: 'system', ...line });
          await sendRoomData(r.fromRoom, 'raid', { type: 'raid-go', raid: publicRaid(r) });
        },
      );
      await sendRoomData(name, 'raid', { type: 'raid-start', raid: publicRaid(raid) });
      return reply.code(201).send({ raid: publicRaid(raid) });
    } catch (err) {
      if (err instanceof RaidError) return reply.code(err.status).send({ message: err.message });
      throw err;
    }
  });

  fastify.delete('/rooms/:name/raid', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' }, dock: true },
    schema: { params: nameParam },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (meta.host !== request.username) return reply.forbidden('Only the host can call off a raid');
    const r = cancelRaid(name);
    if (!r) return reply.code(404).send({ message: 'No raid is counting down.' });
    await sendRoomData(name, 'raid', { type: 'raid-cancel', raid: publicRaid(r) });
    return reply.code(204).send();
  });

  fastify.get('/raids/settings', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' }, dock: true },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send({ acceptRaids: await acceptsRaids(request.username) });
  });

  fastify.put('/raids/settings', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' }, dock: true },
    schema: { body: { type: 'object', required: ['acceptRaids'], properties: { acceptRaids: { type: 'boolean' } } } },
  }, async (request, reply) => {
    const { acceptRaids } = request.body as { acceptRaids: boolean };
    await setAcceptsRaids(request.username, acceptRaids);
    return reply.send({ acceptRaids });
  });
};
