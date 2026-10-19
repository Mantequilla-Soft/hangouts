import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { getUserStatus } from '../lib/users.js';
import {
  validateTemplateInput, defaultTemplateFields, MAX_TEMPLATES_PER_USER,
} from '../lib/streamTemplateInput.js';
import {
  listTemplates, countTemplates, getTemplate, insertTemplate, updateTemplate, deleteTemplate,
  getOrCreateStreamSecret, resetStreamSecret, StoreUnavailableError, type TemplateDoc,
} from '../lib/streamTemplates.js';
import { chatOverlayKey, parseChatOverlayKey } from '../lib/streamSecrets.js';
import { findLiveRoomForHost } from '../lib/chatOverlay.js';
import { isTemplateBusy, getHeadlessStatus, getLastHeadlessEnd, streamCapMs } from '../lib/headlessStreams.js';

/**
 * Stream templates (owner-scoped CRUD) + the owner's streaming secret.
 *
 * A template is a saved "go live" setup; OBS streams to
 * `${PUBLIC_WHIP_BASE}/<owner>/<slug>` with the owner's streaming secret as its
 * Bearer Token, and routes/whip.ts starts a headless stream from it.
 *
 * Errors carry a machine-readable `error` code (the UI branches on it):
 * invalid_input 400, not_found 404, name_taken 409, live 409, limit_reached
 * 409, storage_unavailable 503.
 */

const whipBase = () => config.PUBLIC_WHIP_BASE.replace(/\/$/, '');

export function templateView(doc: TemplateDoc) {
  return {
    id: doc._id.toHexString(),
    owner: doc.owner,
    name: doc.name,
    slug: doc.slug,
    whipUrl: `${whipBase()}/${doc.owner}/${doc.slug}`,
    title: doc.title,
    description: doc.description,
    thumbnail: doc.thumbnail,
    tags: doc.tags,
    language: doc.language,
    visibility: doc.visibility,
    boost: doc.boost,
    recording: doc.recording,
    announce: doc.announce,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    lastLiveAt: doc.lastLiveAt ? doc.lastLiveAt.toISOString() : null,
  };
}

function fail(reply: FastifyReply, statusCode: number, error: string, message: string) {
  return reply.code(statusCode).send({ statusCode, error, message });
}

/** Map storage outages to 503 instead of a bare 500. */
async function guard(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return fail(reply, 503, 'storage_unavailable', 'Template storage is unavailable, try again shortly');
    }
    throw err;
  }
}

const idParams = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
} as const;

export const templateRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [requireAuth, checkBan] };

  fastify.get('/templates', auth, async (request, reply) => guard(reply, async () => {
    const docs = await listTemplates(request.username);
    return reply.send({
      templates: docs.map(templateView),
      whipBase: whipBase(),
      // The user's OBS chat overlay key (see GET /overlay/:key).
      chatOverlayKey: chatOverlayKey(request.username),
    });
  }));

  fastify.post('/templates', {
    ...auth,
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
  }, async (request, reply) => guard(reply, async () => {
    const owner = request.username;
    const v = validateTemplateInput(request.body, defaultTemplateFields(owner), owner);
    if (!v.ok) return fail(reply, 400, v.error, v.message);
    if (await countTemplates(owner) >= MAX_TEMPLATES_PER_USER) {
      return fail(reply, 409, 'limit_reached', `You can keep at most ${MAX_TEMPLATES_PER_USER} templates`);
    }
    const doc = await insertTemplate(owner, v.value, v.slug);
    if (doc === 'name_taken') {
      return fail(reply, 409, 'name_taken', 'You already have a template with this name (or one that makes the same stream address)');
    }
    return reply.code(201).send({ template: templateView(doc) });
  }));

  fastify.patch('/templates/:id', {
    ...auth,
    schema: idParams,
    config: { rateLimit: { max: 60, timeWindow: '5 minutes' } },
  }, async (request, reply) => guard(reply, async () => {
    const owner = request.username;
    const { id } = request.params as { id: string };
    const existing = await getTemplate(owner, id);
    if (!existing) return fail(reply, 404, 'not_found', 'Template not found');

    const v = validateTemplateInput(request.body, existing, owner);
    if (!v.ok) return fail(reply, 400, v.error, v.message);
    // A rename changes the stream address OBS is connected to — the running
    // session would no longer match its template's URL. Other edits are fine
    // while live: they apply from the next stream (the session keeps a
    // snapshot of the template it started from).
    if (v.slug !== existing.slug && isTemplateBusy(id)) {
      return fail(reply, 409, 'live', 'Stop the stream before renaming this template (the name is its stream address)');
    }
    const doc = await updateTemplate(owner, id, v.value, v.slug);
    if (doc === 'name_taken') {
      return fail(reply, 409, 'name_taken', 'You already have a template with this name (or one that makes the same stream address)');
    }
    if (!doc) return fail(reply, 404, 'not_found', 'Template not found');
    return reply.send({ template: templateView(doc) });
  }));

  fastify.delete('/templates/:id', { ...auth, schema: idParams }, async (request, reply) => guard(reply, async () => {
    const { id } = request.params as { id: string };
    const existing = await getTemplate(request.username, id);
    if (!existing) return fail(reply, 404, 'not_found', 'Template not found');
    if (isTemplateBusy(id)) return fail(reply, 409, 'live', 'Stop the stream before deleting this template');
    await deleteTemplate(request.username, id);
    return reply.send({ ok: true });
  }));

  fastify.get('/templates/:id/status', { ...auth, schema: idParams }, async (request, reply) => guard(reply, async () => {
    const { id } = request.params as { id: string };
    const existing = await getTemplate(request.username, id);
    if (!existing) return fail(reply, 404, 'not_found', 'Template not found');
    const st = getHeadlessStatus(id);
    // Polled by the UI while OBS connects — must never be cached.
    reply.header('Cache-Control', 'no-store');
    if (st) {
      // capSeconds of the RUNNING session would be more exact, but tier can't
      // change mid-stream in practice; the cap follows the owner's tier.
      const { premium } = await getUserStatus(request.username);
      return reply.send({ ...st, capSeconds: streamCapMs(premium) / 1000 });
    }
    const { premium } = await getUserStatus(request.username);
    return reply.send({
      state: 'idle', room: null, startedAt: null,
      capSeconds: streamCapMs(premium) / 1000,
      ingress: null, announced: null,
      lastEnd: getLastHeadlessEnd(id),
    });
  }));

  // ── streaming secret ──────────────────────────────────────────────────────
  // One per user: OBS's "Bearer Token" for every template. Returned only to
  // the owner, never cached by anything in between.
  // Public: the OBS chat overlay (a Browser Dock or Source, no login) polls
  // this to find the room its user is streaming in. The key is the proof of
  // access.
  fastify.get('/overlay/:key', {
    schema: { params: { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 64 } } } },
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const username = parseChatOverlayKey(key);
    if (!username) return fail(reply, 404, 'not_found', 'Unknown overlay');
    reply.header('Cache-Control', 'no-store');
    const room = await findLiveRoomForHost(username).catch(() => null);
    return reply.send({ live: !!room, room });
  });

  fastify.get('/stream-secret', {
    ...auth,
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
  }, async (request, reply) => guard(reply, async () => {
    const secret = await getOrCreateStreamSecret(request.username);
    reply.header('Cache-Control', 'no-store');
    return reply.send({ secret });
  }));

  fastify.post('/stream-secret/reset', {
    ...auth,
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (request, reply) => guard(reply, async () => {
    // Running streams are unaffected: the secret is only checked on connect.
    const secret = await resetStreamSecret(request.username);
    reply.header('Cache-Control', 'no-store');
    return reply.send({ secret });
  }));
};
