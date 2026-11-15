import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for the docs in ../docs (headings, paragraphs,
 * lists, tables, fenced code, inline code, bold, links). The site renders the
 * same files the repo ships, so the two can never say different things.
 */

/** GitHub-style heading slug: lower case, spaces to dashes, punctuation dropped. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[`*]/g, '').replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');
}

/** Split a document at its `## ` headings: [{ title, body }]. Text before the first one is dropped. */
export function sections(md: string): { title: string; slug: string; body: string }[] {
  const out: { title: string; slug: string; body: string }[] = [];
  let inCode = false;
  let current: { title: string; slug: string; lines: string[] } | null = null;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    if (!inCode && line.startsWith('## ')) {
      if (current) out.push({ title: current.title, slug: current.slug, body: current.lines.join('\n') });
      const title = line.slice(3).trim();
      current = { title, slug: slug(title), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ title: current.title, slug: current.slug, body: current.lines.join('\n') });
  return out;
}

export interface LinkResolver {
  /** A click handler for a link inside the site, or the URL to open instead. */
  (href: string): (() => void) | string;
}

function inline(text: string, onLink: LinkResolver, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  // code, bold, link, in that priority
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = key;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={i++}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={i++}>{inline(m[2].slice(2, -2), onLink, i * 100)}</strong>);
    else if (m[3]) {
      const href = m[5];
      const go = onLink(href);
      out.push(typeof go === 'function'
        ? <a key={i++} href={`#${href.split('#')[1] ?? ''}`} onClick={(e) => { e.preventDefault(); go(); }}>{inline(m[4], onLink, i * 100)}</a>
        : <a key={i++} href={go} target="_blank" rel="noopener">{inline(m[4], onLink, i * 100)}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Table cells, honouring `\|` inside a cell. */
function cells(row: string): string[] {
  const parts = row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  return parts.map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function Markdown({ source, onLink = (href) => href }: { source: string; onLink?: LinkResolver }) {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="docs__code"><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,4}) (.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2], onLink);
      const id = slug(h[2]);
      blocks.push(level <= 1
        ? <h1 key={k++} id={id} className="docs__h1">{content}</h1>
        : level === 2
          ? <h2 key={k++} id={id} className="docs__h2">{content}</h2>
          : <h3 key={k++} id={id} className="docs__h3">{content}</h3>);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const [head, , ...body] = rows;
      blocks.push(
        <div key={k++} className="docs__table-wrap">
          <table className="docs__table">
            <thead><tr>{cells(head).map((c, j) => <th key={j}>{inline(c, onLink)}</th>)}</tr></thead>
            <tbody>{body.map((r, j) => <tr key={j}>{cells(r).map((c, n) => <td key={n}>{inline(c, onLink)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^(\s*)([-*]|\d+\.) /.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```')) {
        if (/^\s*([-*]|\d+\.) /.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const lis = items.map((t, j) => <li key={j}>{inline(t, onLink)}</li>);
      blocks.push(ordered ? <ol key={k++} className="docs__list">{lis}</ol> : <ul key={k++} className="docs__list">{lis}</ul>);
      continue;
    }
    if (line.trim() === '' || line.trim() === '---' || line.startsWith('<!--')) { i++; continue; }
    if (line.startsWith('    ')) {
      const code: string[] = [];
      while (i < lines.length && lines[i].startsWith('    ')) code.push(lines[i++].slice(4));
      blocks.push(<pre key={k++} className="docs__code"><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4} |\||```|\s*([-*]|\d+\.) )/.test(lines[i])) {
      para.push(lines[i++].replace(/^>\s?/, '').trim());
    }
    blocks.push(<p key={k++} className="docs__p">{inline(para.join(' '), onLink)}</p>);
  }
  return <>{blocks}</>;
}
