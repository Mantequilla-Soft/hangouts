import { getUserStatus } from './users.js';

export interface PermissionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Single seam for "is this user allowed to record video?".
 *
 * Today: gated on the `embed-users.premium` flag (same MongoDB collection used
 * for ban/premium status everywhere else). When the Magi/VSC subs contract
 * gate is ready, replace the body of this function with the on-chain check —
 * no other call site changes.
 */
export async function canRecordVideo(username: string): Promise<PermissionResult> {
  const { premium } = await getUserStatus(username);
  if (!premium) {
    return { ok: false, reason: 'Video recording requires a 3Speak Pro subscription' };
  }
  return { ok: true };
}

/**
 * "Is this user allowed to record audio?" — same premium gate as video.
 * Kept as its own function so we can diverge later (e.g. give audio a
 * cheaper tier) without re-wiring callers.
 */
export async function canRecordAudio(username: string): Promise<PermissionResult> {
  const { premium } = await getUserStatus(username);
  if (!premium) {
    return { ok: false, reason: 'Audio recording requires a 3Speak Pro subscription' };
  }
  return { ok: true };
}
