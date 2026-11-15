// Every stylesheet the SDK ships must parse: an unclosed block (easy to leave
// behind when two branches append to hangouts.css) breaks the integrator's
// whole CSS bundle, not only our rules.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'src', 'styles');

function unbalanced(css: string): string | null {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let depth = 0;
  let line = 1;
  const open: number[] = [];
  for (const ch of body) {
    if (ch === '\n') line += 1;
    else if (ch === '{') { depth += 1; open.push(line); }
    else if (ch === '}') {
      depth -= 1;
      open.pop();
      if (depth < 0) return `extra } near line ${line}`;
    }
  }
  return depth === 0 ? null : `unclosed { opened near line ${open[open.length - 1]}`;
}

describe('SDK stylesheets', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    it(`${file} has balanced braces`, () => {
      expect(unbalanced(readFileSync(join(dir, file), 'utf8'))).toBeNull();
    });
  }
});
