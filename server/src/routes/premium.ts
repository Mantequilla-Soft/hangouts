import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { checkBan } from '../middleware/checkBan.js';
import { getPremiumStatus, listPremiumUsers, startPremiumTesting } from '../lib/users.js';

/**
 * Premium (3Speak Pro) status + the free trial.
 *
 * The SDK reads premium from here rather than from 3Speak's checker, so an
 * integrator only ever points at one API. The underlying store is the same
 * `embed-users` collection the rest of the server already gates on
 * (`isUserPremium` in dvr.ts / streaming.ts), so nothing here invents a second
 * source of truth — it just exposes what was already being enforced.
 */
export async function premiumRoutes(fastify: FastifyInstance) {
  const usernameParams = {
    params: {
      type: 'object',
      required: ['username'],
      properties: { username: { type: 'string', minLength: 1, maxLength: 64 } },
    },
  };

  // Public read. Deliberately unauthenticated: the padlock UI has to render
  // before a user signs in, and premium status is already public (it shows as
  // a badge next to the avatar).
  fastify.get('/premium/:username', { schema: usernameParams }, async (request, reply) => {
    const { username } = request.params as { username: string };
    const status = await getPremiumStatus(username);
    // 60s, matching the in-process cache in users.ts — a longer edge cache
    // would just delay the post-trial refresh the client does on success.
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send({
      ...status,
      // Client capability discovery: lets the SDK hide the trial button when
      // the deployment has trials switched off, instead of offering a button
      // that can only ever 403.
      testing_available: config.PRO_TESTING_ENABLED,
      testing_hours: config.PRO_TESTING_HOURS,
    });
  });

  // Currently-premium accounts — powers the subscriber ticker on the plans page.
  fastify.get('/premium', async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const parsed = Number.parseInt(limit ?? '', 10);
    const capped = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 1000, 5000);
    const subscribers = await listPremiumUsers(capped);
    reply.header('Cache-Control', 'public, max-age=60');
    return reply.send({ count: subscribers.length, subscribers });
  });

  // Claim the one-per-lifetime free trial.
  //
  // Rate-limited on top of the atomic one-shot guard in startPremiumTesting:
  // the guard makes a second claim harmless, but there's no reason to let a
  // caller hammer an authenticated Mongo write.
  fastify.post('/premium/start-testing', {
    preHandler: [requireAuth, checkBan],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!config.PRO_TESTING_ENABLED) {
      return reply.code(403).send({ ok: false, message: 'The Pro trial is not available right now.' });
    }

    const result = await startPremiumTesting(request.username, config.PRO_TESTING_HOURS);

    if (result.ok) {
      return reply.send({
        ok: true,
        expiresAt: result.expiresAt,
        hours: config.PRO_TESTING_HOURS,
      });
    }
    if (result.reason === 'already_used') {
      return reply.code(409).send({ ok: false, message: 'You have already used your one-time Pro trial.' });
    }
    if (result.reason === 'already_premium') {
      return reply.code(409).send({ ok: false, message: 'Your account already has Pro — no trial needed.' });
    }
    return reply.code(503).send({ ok: false, message: 'The Pro trial is temporarily unavailable.' });
  });
}
