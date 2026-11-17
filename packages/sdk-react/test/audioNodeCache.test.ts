import { describe, expect, it } from 'vitest';
import { nodeIn } from '../src/lib/audioNodeCache.js';

// The studio's per-track limiters outlived a closed AudioContext; reusing one in
// the rebuilt graph threw "Can't connect nodes from different AudioContexts".
describe('nodeIn', () => {
  const ctxA = {} as BaseAudioContext;
  const ctxB = {} as BaseAudioContext;
  const node = (context: BaseAudioContext) => ({ context }) as unknown as AudioNode;

  it('returns the cached node of the same context', () => {
    const n = node(ctxA);
    const cache = new Map([['mic', n]]);
    expect(nodeIn(cache, 'mic', ctxA)).toBe(n);
    expect(cache.has('mic')).toBe(true);
  });

  it('drops a node from another (closed) context, so a fresh one is made', () => {
    const cache = new Map([['mic', node(ctxA)]]);
    expect(nodeIn(cache, 'mic', ctxB)).toBeUndefined();
    expect(cache.has('mic')).toBe(false);
  });

  it('nothing cached: undefined', () => {
    expect(nodeIn(new Map(), 'aux', ctxA)).toBeUndefined();
  });
});
