import type { FastifyRequest, FastifyReply } from 'fastify';
import { isUserBanned } from '../lib/users.js';

export async function checkBan(request: FastifyRequest, reply: FastifyReply) {
  // requireAuth must run first to set request.username
  if (!request.username) return;

  const banned = await isUserBanned(request.username);
  if (banned) {
    return reply.forbidden('Your account has been suspended from Hive Hangouts');
  }
}
