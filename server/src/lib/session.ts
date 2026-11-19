import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

const secret = new TextEncoder().encode(config.SESSION_SECRET);
const ISSUER = 'hive-hangouts';
const SESSION_TTL = '24h';

export interface SessionPayload {
  sub: string; // Hive username
}

/**
 * The OBS dock's session: minted from the owner's dock key, good ONLY on the
 * routes that say so (route config `dock: true`: polls, raids, boost
 * settings) and only while the key it came from is current (`dkv`, the key's
 * rotation time: resetting the key ends every dock session at once).
 */
export interface DockSessionPayload {
  sub: string;
  dkv: number;
}
const DOCK_SCOPE = 'dock';
const DOCK_TTL = '12h';

export async function createSessionToken(username: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(username)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
  if (!payload.sub) throw new Error('Invalid session token: missing subject');
  // A dock session is not a login: everything that reads a session through
  // here treats it as none.
  if (payload.scope !== undefined) throw new Error('Not a full session');
  return { sub: payload.sub };
}

export async function createDockToken(username: string, keyVersion: number): Promise<string> {
  return new SignJWT({ scope: DOCK_SCOPE, dkv: keyVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(username)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(DOCK_TTL)
    .sign(secret);
}

export async function verifyDockToken(token: string): Promise<DockSessionPayload> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
  if (!payload.sub || payload.scope !== DOCK_SCOPE || typeof payload.dkv !== 'number') throw new Error('Not a dock session');
  return { sub: payload.sub, dkv: payload.dkv };
}
