import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

const secret = new TextEncoder().encode(config.SESSION_SECRET);
const ISSUER = 'hive-hangouts';
const SESSION_TTL = '24h';

export interface SessionPayload {
  sub: string; // Hive username
}

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
  return { sub: payload.sub };
}
