/**
 * Minimal markdown helpers shared by the room UI.
 *
 * `renderMarkdown` mirrors the create-dialog / studio preview: HTML is escaped
 * FIRST, then a small subset of markdown is turned back into tags — so a
 * description can never inject markup.
 *
 * The escape covers QUOTES too (" and '), not just <>&. The generated link tag
 * puts the URL straight into href="…", and the link regex's URL class allows
 * any non-space/non-) char — so an unescaped quote would let a crafted URL like
 * `[x](https://a"onmouseover=…)` break out of the attribute and inject an event
 * handler. Escaping quotes closes that (real URLs percent-encode them anyway).
 */
export function renderMarkdown(md: string): string {
  let h = String(md ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  h = h
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  h = h.split(/\n{2,}/).map((block) =>
    /^<(h\d|ul|li)/.test(block.trim()) ? block : `<p>${block.replace(/\n/g, '<br/>')}</p>`,
  ).join('');
  return h;
}

/**
 * Flatten markdown to plain text for one-line previews: keeps the words, drops
 * the syntax (headings, emphasis, code ticks, quotes, list bullets, images)
 * and reduces links to their label.
 */
export function stripMarkdown(md: string): string {
  return String(md ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images → nothing
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // links → their text
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')            // code ticks
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')               // headings
    .replace(/^\s{0,3}>\s?/gm, '')                    // block quotes
    .replace(/^\s*[-*+]\s+/gm, '')                    // bullets
    .replace(/^\s*\d+\.\s+/gm, '')                    // ordered list markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2')               // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')                  // italic
    .replace(/~~(.*?)~~/g, '$1')                      // strikethrough
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')             // horizontal rules
    .replace(/\s+/g, ' ')                             // collapse whitespace/newlines
    .trim();
}

/** Cut to `max` characters on a word boundary where possible, adding an ellipsis. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const t = String(text ?? '');
  if (t.length <= max) return { text: t, truncated: false };
  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}
