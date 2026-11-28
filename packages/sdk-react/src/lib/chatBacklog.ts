/**
 * Pure helpers for the chat backlog: the server keeps the last few hundred
 * lines of a live room (GET /rooms/:name/chat) so a reload or a late joiner
 * sees the conversation. These merge that list with what arrived live.
 */

/**
 * A line the server wrote. `from` is the raiding host, or the viewer who paid
 * for a points shop line (lib/pointsShop.ts): a highlighted message, a channel
 * reward redeemed, a bounty put up, or (bountydone) the host who completed it.
 */
export type ChatSystemInfo =
  | { kind: 'raid'; from: string; viewers: number }
  /** The viewer's own message, standing out; pinned on top until `until` (ms). */
  | { kind: 'highlight'; from: string; until?: number }
  | { kind: 'reward'; from: string; title: string }
  | { kind: 'bounty' | 'bountydone'; from: string; title: string; points: number };

export type ChatSystemKind = ChatSystemInfo['kind'];

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A system line's `system` block, checked for shape, or null. */
export function parseSystemInfo(raw: unknown): ChatSystemInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const from = typeof s.from === 'string' ? s.from : '';
  if (!from) return null;
  const title = typeof s.title === 'string' ? s.title : '';
  switch (s.kind) {
    case 'raid': return { kind: 'raid', from, viewers: finite(s.viewers) ?? 0 };
    case 'highlight': {
      const until = finite(s.until);
      return until !== undefined ? { kind: 'highlight', from, until } : { kind: 'highlight', from };
    }
    case 'reward': return { kind: 'reward', from, title };
    case 'bounty':
    case 'bountydone': return { kind: s.kind, from, title, points: Math.max(0, finite(s.points) ?? 0) };
    default: return null;
  }
}

export interface BacklogLine {
  id: string;
  identity: string;
  name: string;
  text: string;
  timestamp: number;
  system?: ChatSystemInfo;
}

/**
 * Held lines plus incoming ones: deduped on id, in time order, without
 * anything a moderator deleted or anyone they banned. Returns `held` itself
 * when nothing changed, so a store can skip a re-render.
 */
export function mergeChatLines<T extends BacklogLine>(
  held: T[],
  incoming: T[],
  removedIds: ReadonlySet<string> = new Set(),
  purged: ReadonlySet<string> = new Set(),
): T[] {
  const have = new Set(held.map((m) => m.id));
  const fresh = incoming.filter((m) => m && typeof m.id === 'string' && !have.has(m.id)
    && !removedIds.has(m.id) && !purged.has(m.identity));
  if (fresh.length === 0) return held;
  return [...held, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
}

/** Lines from the server, checked for shape (it is network data). */
export function parseBacklog(body: unknown): BacklogLine[] {
  const list = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(list)) return [];
  return list.filter((m): m is BacklogLine => !!m && typeof m === 'object'
    && typeof (m as BacklogLine).id === 'string'
    && typeof (m as BacklogLine).identity === 'string'
    && typeof (m as BacklogLine).text === 'string'
    && typeof (m as BacklogLine).timestamp === 'number')
    .map((m) => {
      // A system block is the server's, but still network data: shape-checked.
      const { system: raw, ...rest } = m;
      const system = raw === undefined ? null : parseSystemInfo(raw);
      return { ...rest, name: typeof m.name === 'string' && m.name ? m.name : m.identity, ...(system ? { system } : {}) };
    });
}
