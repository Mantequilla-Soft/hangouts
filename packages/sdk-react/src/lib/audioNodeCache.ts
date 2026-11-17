/**
 * A node cached for `key`, only if it belongs to `ctx`. The studio rebuilds its
 * audio graph in a new AudioContext after a teardown (closing and reopening the
 * studio, React's dev double mount); a node kept from the old context can't be
 * connected to the new one ("Can't connect nodes from different AudioContexts"),
 * so a stale entry is dropped and the caller makes a fresh one.
 */
export function nodeIn<N extends AudioNode>(cache: Map<string, N>, key: string, ctx: BaseAudioContext): N | undefined {
  const node = cache.get(key);
  if (node && node.context !== ctx) {
    cache.delete(key);
    return undefined;
  }
  return node;
}
