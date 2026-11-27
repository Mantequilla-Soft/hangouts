/**
 * The channel points log's format on Hive, with no server dependencies (the
 * replay script runs without the server's config): custom_json
 * `3speak_points`, `{"v":1,"at":<unix s>,"m":[[user, delta, kind, dt, ref?]]}`.
 */

export type PointsKind = 'watch' | 'stream' | 'chat' | 'raid' | 'battle' | 'boost' | 'spend' | 'refund' | 'prediction' | 'expire'
  | 'login' | 'rank' | 'remix'
  // The ways to earn of lib/pointsAwards.ts (2026-11-26).
  | 'streak' | 'week5' | 'anniv' | 'first5' | 'vodtime' | 'finish' | 'listen' | 'premiere' | 'playlist' | 'first'
  | 'reach' | 'storystreak' | 'challenge' | 'collab' | 'premheld' | 'clip' | 'tag' | 'pollvote' | 'reply' | 'community'
  | 'tip' | 'remixed' | 'raided' | 'followers' | 'peak10' | 'referral' | 'invited' | 'pwa' | 'party' | 'quest';

/** One letter per kind on the chain (custom_json is capped at 8 KB), two for
 *  the award kinds added later. The token's mintBatch rows carry the same
 *  codes as their kind label (at most 8 characters; never `g` or `a`, which
 *  the contract keeps for the once-per-account welcome grant and airdrop). */
export const KIND_CODE: Record<PointsKind, string> = {
  watch: 'w', stream: 's', chat: 'c', raid: 'r', battle: 't', boost: 'b', spend: 'x', refund: 'f', prediction: 'p',
  expire: 'e', login: 'l', rank: 'k', remix: 'm',
  streak: 'sk', week5: 'w5', anniv: 'an', first5: 'f5', vodtime: 'vt', finish: 'fi', listen: 'li', premiere: 'pr',
  playlist: 'pl', first: 'fs', reach: 'rc', storystreak: 'ss', challenge: 'ch', collab: 'co', premheld: 'ph', clip: 'cl',
  tag: 'tg', pollvote: 'pv', reply: 'rp', community: 'cm', tip: 'tp', remixed: 'rx', raided: 'rd', followers: 'fo',
  peak10: 'pk', referral: 'rf', invited: 'iv', pwa: 'pw', party: 'pa', quest: 'qs',
};

/** Kinds whose ref would tell the public chain what someone watched, voted on
 *  or tipped: the ref stays in the wallet history (Mongo) and is left out of
 *  the custom_json, like watching and chat carry no stream at all. */
export const PRIVATE_REF_KINDS: ReadonlySet<PointsKind> = new Set<PointsKind>([
  'finish', 'premiere', 'playlist', 'tag', 'pollvote', 'clip', 'tip',
]);
const CODE_KIND = Object.fromEntries(Object.entries(KIND_CODE).map(([k, c]) => [c, k])) as Record<string, PointsKind>;

/**
 * Two logs, so a replay never counts a movement twice:
 *   `3speak_points`  everything from before the 3SP token: replayed, it gives
 *                    exactly the balances the airdrop minted
 *   `3sp_points`     everything after the airdrop, when the token on Magi holds
 *                    the balances (the same format, the record of what each
 *                    mint and burn was for)
 * Which row goes where: logIdFor in lib/pointsLedger.ts.
 */
export const POINTS_LOG_ID = '3speak_points';
export const POINTS_TOKEN_LOG_ID = '3sp_points';

/** What a ledger row needs to go on the chain. */
export interface LogRow { id: string; user: string; delta: number; kind: PointsKind; ref?: string; at: number }

/** Room for the custom_json envelope under Hive's 8,192-byte json limit. */
const MAX_JSON_BYTES = 7600;

// ── chain format ──────────────────────────────────────────────────────────

/**
 * Rows to custom_json payloads, each under the size limit:
 * `{"v":1,"at":<unix s>,"m":[[user, delta, kind, dt, ref?], ...]}` where `dt`
 * is the row's seconds after `at`.
 */
export function encodePointsLog(rows: LogRow[]): Array<{ json: string; ids: string[] }> {
  const out: Array<{ json: string; ids: string[] }> = [];
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  let i = 0;
  while (i < sorted.length) {
    const at = Math.floor(sorted[i].at / 1000);
    const m: unknown[][] = [];
    const ids: string[] = [];
    let json = '';
    while (i < sorted.length) {
      const r = sorted[i];
      const entry: unknown[] = [r.user, r.delta, KIND_CODE[r.kind], Math.max(0, Math.floor(r.at / 1000) - at)];
      if (r.ref && !PRIVATE_REF_KINDS.has(r.kind)) entry.push(r.ref);
      const next = JSON.stringify({ v: 1, at, m: [...m, entry] });
      if (Buffer.byteLength(next) > MAX_JSON_BYTES && m.length > 0) break;
      m.push(entry);
      ids.push(r.id);
      json = next;
      i += 1;
    }
    out.push({ json, ids });
  }
  return out;
}

export interface LoggedMovement { user: string; delta: number; kind: PointsKind; at: number; ref?: string }

/** A custom_json payload back to movements; null when it is not ours. */
export function decodePointsLog(json: string): LoggedMovement[] | null {
  let o: unknown;
  try { o = JSON.parse(json); } catch { return null; }
  const p = o as { v?: unknown; at?: unknown; m?: unknown };
  if (!p || p.v !== 1 || typeof p.at !== 'number' || !Array.isArray(p.m)) return null;
  const out: LoggedMovement[] = [];
  for (const e of p.m) {
    if (!Array.isArray(e)) continue;
    const [user, delta, code, dt, ref] = e as [unknown, unknown, unknown, unknown, unknown];
    const kind = typeof code === 'string' ? CODE_KIND[code] : undefined;
    if (typeof user !== 'string' || typeof delta !== 'number' || !kind) continue;
    out.push({
      user, delta, kind,
      at: (p.at + (typeof dt === 'number' ? dt : 0)) * 1000,
      ...(typeof ref === 'string' ? { ref } : {}),
    });
  }
  return out;
}

/**
 * Rebuild every balance from the logged movements, in order, with the same
 * rules as the live store: a balance starts at `start` and never goes below
 * 0, and an `expire` movement puts it back at `start` (the log says so; there
 * is no hidden time rule).
 */
export function replayPointsLog(movements: LoggedMovement[], start: number): Map<string, { balance: number; last: number }> {
  const out = new Map<string, { balance: number; last: number }>();
  for (const mv of [...movements].sort((a, b) => a.at - b.at)) {
    const cur = out.get(mv.user)?.balance ?? start;
    out.set(mv.user, { balance: mv.kind === 'expire' ? start : Math.max(0, cur + mv.delta), last: mv.at });
  }
  return out;
}

