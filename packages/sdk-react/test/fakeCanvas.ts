/** A recording stand-in for CanvasRenderingContext2D (node has no canvas). */
export interface FakeCtx {
  calls: Array<{ op: string; args: unknown[] }>;
  texts: string[];
  font: string;
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
  textAlign: string;
  textBaseline: string;
  lineWidth: number;
  filter: string;
  canvas: { width: number; height: number };
}

export function fakeCtx(width = 1280, height = 720): FakeCtx & CanvasRenderingContext2D {
  const calls: FakeCtx['calls'] = [];
  const texts: string[] = [];
  const state = {
    calls, texts, font: '10px sans', fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1,
    textAlign: 'left', textBaseline: 'alphabetic', lineWidth: 1, filter: 'none', canvas: { width, height },
  };
  const rec = (op: string) => (...args: unknown[]) => { calls.push({ op, args }); };
  const ctx = new Proxy(state as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') {
        return (t: string) => {
          const px = Number(/(\d+)px/.exec(String(target.font))?.[1] ?? 10);
          return { width: t.length * px * 0.5 };
        };
      }
      if (prop === 'fillText') return (t: string, ...rest: unknown[]) => { texts.push(t); calls.push({ op: 'fillText', args: [t, ...rest] }); };
      return rec(prop);
    },
    set(target, prop: string, v) { target[prop] = v; return true; },
  });
  return ctx as unknown as FakeCtx & CanvasRenderingContext2D;
}
