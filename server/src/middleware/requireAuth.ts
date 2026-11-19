import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySessionToken, verifyDockToken } from '../lib/session.js';
import { dockKeyVersion } from '../lib/streamTemplates.js';

declare module 'fastify' {
  interface FastifyRequest {
    username: string;
    /** Signed in through the OBS dock's link, not a real login (see lib/session.ts). */
    dockSession?: boolean;
  }
  interface FastifyContextConfig {
    /** The OBS dock's session may call this route (the host's live controls). */
    dock?: boolean;
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
    return;
  } catch { /* maybe the dock's session, below */ }

  if (request.routeOptions?.config?.dock) {
    try {
      const dock = await verifyDockToken(token);
      // Only while the key it came from is current.
      if (await dockKeyVersion(dock.sub) === dock.dkv) {
        request.username = dock.sub;
        request.dockSession = true;
        return;
      }
    } catch { /* not a dock session either */ }
  }
  return reply.unauthorized('Invalid or expired session token');
}
