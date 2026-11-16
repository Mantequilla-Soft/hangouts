// Every stylesheet the SDK ships must parse: an unclosed block (easy to leave
// behind when two branches append to hangouts.css) breaks the integrator's
// whole CSS bundle, not only our rules.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'lightningcss';

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

// Balanced braces are not enough: a merge that drops a block's `}` and a rule's
// selector keeps the count even but leaves bare declarations inside @media.
// The integrator's production build minifies with lightningcss (Vite's default)
// and stops on that, so parse every file the same way.
function parseError(css: string, filename: string): string | null {
  try {
    transform({ filename, code: Buffer.from(css), minify: true, errorRecovery: false });
    return null;
  } catch (e) {
    const err = e as { message?: string; loc?: { line: number; column: number } };
    return `${err.message}${err.loc ? ` at line ${err.loc.line}` : ''}`;
  }
}

describe('SDK stylesheets', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(dir, file), 'utf8');
    it(`${file} has balanced braces`, () => {
      expect(unbalanced(css)).toBeNull();
    });
    it(`${file} parses and minifies like a production build`, () => {
      expect(parseError(css, file)).toBeNull();
    });
  }

  it('catches a block whose closing brace a merge dropped', () => {
    const broken = '@media (max-width: 640px) {\n  .a { top: 0; }\n  z-index: 5;\n}\n.b { color: red; }';
    expect(unbalanced(broken)).toBeNull();
    expect(parseError(broken, 'broken.css')).not.toBeNull();
  });
});
