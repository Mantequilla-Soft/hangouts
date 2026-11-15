import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import {
  PollError, activePoll, cancelPoll, createPoll, endPoll, listRoomPolls, onPollChange, pointsBalance,
  resolvePrediction, stake, toView, vote, type Poll, type PollKind,
} from '../lib/polls.js';
import { readRoomMeta, sendRoomData, sessionUser, streamOffset } from '../lib/liveRoom.js';

/**
 * Polls and predictions (lib/polls.ts) over HTTP, plus the live results
 * broadcast: every change goes to the room on the `poll` data topic, at most
 * about once a second per room while votes pour in (status changes go at once).
 */

const BROADCAST_MS = 1000;
const lastSent = new Map<string, number>();
const queued = new Map<string, ReturnType<typeof setTimeout>>();

function broadcast(p: Poll, now = false): void {
  const send = () => {
    queued.delete(p.room);
    lastSent.set(p.room, Date.now());
    void sendRoomData(p.room, 'poll', { type: 'poll', poll: toView(p) });
  };
  const wait = BROADCAST_MS - (Date.now() - (lastSent.get(p.room) ?? 0));
  if (now || wait <= 0) {
    const t = queued.get(p.room);
    if (t) clearTimeout(t);
    send();
    return;
  }
  if (queued.has(p.room)) return;
  const t = setTimeout(send, wait);
  t.unref?.();
  queued.set(p.room, t);
}

let lastStatus = new WeakMap<Poll, string>();
onPollChange((p) => {
  const changed = lastStatus.get(p) !== p.status;
  lastStatus.set(p, p.status);
  broadcast(p, changed);
});

/** Test helper. */
export function resetPollBroadcasts(): void {
  for (const t of queued.values()) clearTimeout(t);
  queued.clear();
  lastSent.clear();
  lastStatus = new WeakMap();
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof PollError) return reply.code(err.status).send({ message: err.message });
  throw err;
}

const nameParam = { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } } as const;
const idParams = {
  type: 'object',
  required: ['name', 'id'],
  properties: { name: { type: 'string', maxLength: 128 }, id: { type: 'string', maxLength: 200 } },
} as const;

/** The viewer's own part in a poll, so a reload still shows "you voted X". */
function mine(p: Poll | null, user: string | null) {
  if (!p || !user) return {};
  if (p.kind === 'poll') return p.votes.has(user) ? { myVote: p.votes.get(user) } : {};
  const s = p.stakes.get(user);
  return s ? { myStake: s } : {};
}

export const pollRoutes: FastifyPluginAsync = async (fastify) => {
  // The running poll (or null), with the caller's vote and points when signed in.
  fastify.get('/rooms/:name/polls/active', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { params: nameParam },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    reply.header('Cache-Control', 'no-store');
    const p = activePoll(name);
    const user = await sessionUser(request);
    let balance: number | undefined;
    if (user && p?.kind === 'prediction') {
      try { balance = (await pointsBalance(p.host, user)) - (p.stakes.get(user)?.amount ?? 0); } catch { /* unknown */ }
    }
    return reply.send({ poll: p ? toView(p) : null, ...mine(p, user), ...(balance !== undefined ? { balance } : {}) });
  });

  // Every finished poll of a stream, for its VOD (works after the room is gone).
  fastify.get('/rooms/:name/polls', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: nameParam },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send({ polls: await listRoomPolls(name) });
  });

  // A viewer's points on this host's channel.
  fastify.get('/points/:channel', {
    preHandler: [requireAuth],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['channel'], properties: { channel: { type: 'string', maxLength: 32 } } } },
  }, async (request, reply) => {
    const { channel } = request.params as { channel: string };
    return reply.send({ channel, balance: await pointsBalance(channel.toLowerCase(), request.username) });
  });

  // Host: start a poll or a prediction.
  fastify.post('/rooms/:name/polls', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
    schema: {
      params: nameParam,
      body: {
        type: 'object',
        required: ['question', 'options', 'durationSec'],
        properties: {
          kind: { type: 'string', enum: ['poll', 'prediction'] },
          question: { type: 'string', maxLength: 500 },
          options: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 200 } },
          durationSec: { type: 'integer', minimum: 1, maximum: 7200 },
        },
      },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as { kind?: PollKind; question: string; options: string[]; durationSec: number };
    const meta = await readRoomMeta(name);
    if (!meta) return reply.notFound('Room not found');
    if (meta.host !== request.username) return reply.forbidden('Only the host can start a poll');
    try {
      const p = createPoll(name, request.username, { kind: body.kind ?? 'poll', question: body.question, options: body.options, durationSec: body.durationSec }, streamOffset(meta));
      return reply.code(201).send({ poll: toView(p) });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/rooms/:name/polls/:id/vote', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      params: idParams,
      body: { type: 'object', required: ['option'], properties: { option: { type: 'integer', minimum: 0, maximum: 3 } } },
    },
  }, async (request, reply) => {
    const { name, id } = request.params as { name: string; id: string };
    const { option } = request.body as { option: number };
    try {
      const p = vote(name, id, request.username, option);
      return reply.send({ poll: toView(p), myVote: option });
    } catch (err) { return fail(reply, err); }
  });

  fastify.post('/rooms/:name/polls/:id/stake', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      params: idParams,
      body: {
        type: 'object',
        required: ['option', 'amount'],
        properties: { option: { type: 'integer', minimum: 0, maximum: 1 }, amount: { type: 'integer', minimum: 1, maximum: 100000000 } },
      },
    },
  }, async (request, reply) => {
    const { name, id } = request.params as { name: string; id: string };
    const { option, amount } = request.body as { option: number; amount: number };
    try {
      const { poll, balance } = await stake(name, id, request.username, option, amount);
      return reply.send({ poll: toView(poll), myStake: poll.stakes.get(request.username), balance });
    } catch (err) { return fail(reply, err); }
  });

  // Host actions on the running poll: end (early), resolve (prediction), cancel.
  for (const action of ['end', 'resolve', 'cancel'] as const) {
    fastify.post(`/rooms/:name/polls/:id/${action}`, {
      preHandler: [requireAuth, checkBan],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: idParams,
        body: action === 'resolve'
          ? { type: 'object', required: ['winner'], properties: { winner: { type: 'integer', minimum: 0, maximum: 1 } } }
          : { type: ['object', 'null'] },
      },
    }, async (request, reply) => {
      const { name, id } = request.params as { name: string; id: string };
      const meta = await readRoomMeta(name);
      // A room already gone still lets its host settle the prediction they ran.
      const host = meta?.host ?? activePoll(name)?.host;
      if (host !== request.username) return reply.forbidden('Only the host can do that');
      try {
        const p = action === 'end' ? await endPoll(name, id)
          : action === 'resolve' ? await resolvePrediction(name, id, (request.body as { winner: number }).winner)
          : await cancelPoll(name, id);
        return reply.send({ poll: toView(p) });
      } catch (err) { return fail(reply, err); }
    });
  }
};
