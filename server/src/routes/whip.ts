import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { isUserBanned, getUserStatus } from '../lib/users.js';
import { nextFreeStreamAt, dailyLimitBody } from '../lib/streamQuota.js';
import { HIVE_ACCOUNT_RE, SLUG_RE } from '../lib/streamTemplateInput.js';
import { checkStreamSecret, findTemplateBySlug, StoreUnavailableError } from '../lib/streamTemplates.js';
import {
  startHeadlessStream, forwardWhipPatch, endWhipSession, getSessionByToken,
  isTemplateBusy, capCooldownRemaining, noteHeadlessRefusal,
} from '../lib/headlessStreams.js';

/**
 * WHIP endpoint for headless OBS streams.
 *
 *   OBS → Settings → Stream → Service: WHIP
 *     Server:       ${PUBLIC_WHIP_BASE}/<owner>/<template-slug>
 *     Bearer Token: the owner's streaming secret (GET /stream-secret)
 *
 * POST creates the stream from the template and answers the SDP offer via the
 * LiveKit ingress (lib/headlessStreams.ts). The Location we return is OUR
 * session URL (/whip/s/<token>) — never the ingress's own, which embeds the
 * LiveKit stream key. PATCH (trickle ICE / ICE restart) and DELETE (Stop) on
 * that URL are proxied / turned into a full teardown.
 *
 * Errors are plain text (WHIP clients like OBS show the body verbatim).
 */

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const EXPOSE = 'Location, ETag, Link, Accept-Patch';

function plain(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).type('text/plain; charset=utf-8').send(message);
}

export const whipRoutes: FastifyPluginAsync = async (fastify) => {
  // Scoped to this plugin: WHIP bodies are SDP / trickle fragments, as text.
  fastify.addContentTypeParser(
    ['application/sdp', 'application/trickle-ice-sdpfrag'],
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => done(null, body),
  );

  fastify.post('/whip/:owner/:slug', {
    // Per-IP: every attempt costs a Mongo lookup and, when it passes, a room +
    // an ingress. OBS's auto-reconnect retries are well under this.
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    bodyLimit: 64 * 1024,
  }, async (request, reply) => {
    reply.header('Access-Control-Expose-Headers', EXPOSE);
    const ct = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/sdp') return plain(reply, 415, 'Content-Type must be application/sdp');

    const { owner: rawOwner, slug } = request.params as { owner: string; slug: string };
    const owner = rawOwner.toLowerCase();
    const auth = request.headers.authorization ?? '';
    const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!secret) {
      reply.header('WWW-Authenticate', 'Bearer');
      return plain(reply, 401, 'Missing Bearer Token: paste your streaming secret into OBS');
    }
    // A malformed address can't name a template; answer like an unknown one.
    if (!HIVE_ACCOUNT_RE.test(owner) || !SLUG_RE.test(slug)) {
      return plain(reply, 404, 'No such stream template');
    }

    try {
      // Secret BEFORE template lookup: an unauthenticated caller learns
      // nothing about which template names exist.
      if (!(await checkStreamSecret(owner, secret))) {
        reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
        return plain(reply, 401, 'Wrong streaming secret for this account');
      }
      if (await isUserBanned(owner)) return plain(reply, 403, 'This account is suspended');

      const template = await findTemplateBySlug(owner, slug);
      if (!template) return plain(reply, 404, 'No such stream template');

      const cooldown = capCooldownRemaining(owner);
      if (cooldown > 0) {
        reply.header('Retry-After', String(Math.ceil(cooldown / 1000)));
        return plain(reply, 429, 'Your last stream reached its time limit. You can go live again shortly.');
      }
      if (isTemplateBusy(template._id.toHexString())) {
        return plain(reply, 409, 'This template is already live. Stop the other stream first.');
      }
      // Free hosts: one stream a day (lib/streamQuota.ts). OBS only shows a
      // generic connection error, so the reason also goes on the template card.
      if (!(await getUserStatus(owner)).premium) {
        const next = await nextFreeStreamAt(owner);
        if (next) {
          noteHeadlessRefusal(template._id.toHexString(), 'daily_limit');
          reply.header('Retry-After', String(Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000))));
          return plain(reply, 429, dailyLimitBody(next).message);
        }
      }

      const result = await startHeadlessStream(template, request.body as string);
      if (!result.ok) return plain(reply, result.status, result.message);

      for (const [k, v] of Object.entries(result.headers)) {
        if (k !== 'content-type') reply.header(k, v);
      }
      // Absolute, so every WHIP client resolves it the same way.
      reply.header('Location', `${config.PUBLIC_WHIP_BASE.replace(/\/$/, '')}/s/${result.sessionToken}`);
      return reply.code(result.status).type('application/sdp').send(result.answer);
    } catch (err) {
      if (err instanceof StoreUnavailableError) return plain(reply, 503, 'Temporarily unavailable, try again shortly');
      throw err;
    }
  });

  // Session routes: the token in the path is a capability, so keep these out
  // of the request log (logLevel warn skips the per-request info lines).
  fastify.patch('/whip/s/:token', {
    logLevel: 'warn',
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    bodyLimit: 64 * 1024,
  }, async (request, reply) => {
    reply.header('Access-Control-Expose-Headers', EXPOSE);
    const { token } = request.params as { token: string };
    if (!SESSION_TOKEN_RE.test(token) || !getSessionByToken(token)) return plain(reply, 404, 'No such session');
    const ct = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/trickle-ice-sdpfrag' && ct !== 'application/sdp') {
      return plain(reply, 415, 'Content-Type must be application/trickle-ice-sdpfrag');
    }
    const ifMatch = typeof request.headers['if-match'] === 'string' ? request.headers['if-match'] : undefined;
    let res;
    try {
      res = await forwardWhipPatch(token, (request.body as string) ?? '', ct, ifMatch);
    } catch {
      return plain(reply, 502, 'The ingest server did not answer');
    }
    if (!res) return plain(reply, 404, 'No such session');
    for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
    return reply.code(res.status).send(res.body);
  });

  fastify.delete('/whip/s/:token', {
    logLevel: 'warn',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    if (!SESSION_TOKEN_RE.test(token)) return plain(reply, 404, 'No such session');
    const ended = await endWhipSession(token);
    if (!ended) return plain(reply, 404, 'No such session');
    return reply.code(200).send();
  });
};
