import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySessionToken } from '../lib/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    username: string;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.unauthorized('Missing or invalid Authorization header');
  }

  const token = header.slice(7);
  try {
    const session = await verifySessionToken(token);
    request.username = session.sub;
  } catch {
    return reply.unauthorized('Invalid or expired session token');
  }
}
