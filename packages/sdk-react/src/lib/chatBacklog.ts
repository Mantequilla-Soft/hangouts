/**
 * Pure helpers for the chat backlog: the server keeps the last few hundred
 * lines of a live room (GET /rooms/:name/chat) so a reload or a late joiner
 * sees the conversation. These merge that list with what arrived live.
 */

export interface ChatSystemInfo {
  kind: 'raid';
  /** The raiding host. */
  from: string;
  viewers: number;
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
    .map((m) => ({ ...m, name: typeof m.name === 'string' && m.name ? m.name : m.identity }));
}
