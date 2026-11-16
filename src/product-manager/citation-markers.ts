/**
 * A document's evidence markers leave it when it leaves BotBoy (docs/maps/product-manager.md › Export).
 *
 * In the reader an inline `[c1]` becomes an evidence chip (dashboard.js › annotateDocumentCitations); in a Word, HTML, PDF or
 * Markdown export, and in a SharePoint or Google Drive publication, it is only noise (owner request 2026-11-16). Removed are
 * exactly the markers the reader draws as chips: `[id]` where `id` is one of the document's own citations, outside code
 * (fenced blocks and inline code spans, which the reader leaves alone too), and never a link (`[c1](url)`) or a link
 * definition (`[c1]: url`). A `[c9]` with no citation stays, as it does in the reader. The stored document never changes.
 */

/** Punctuation that closes a statement or a span: a marker before it goes with the space before the marker. */
const CLOSING = /^[.,;:!?)\]}*_~'"’”»…]/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where a line's inline code spans are ([start, end) offsets); an unclosed backtick run is literal text. */
function codeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let index = 0;
  while (index < line.length) {
    const tick = line.indexOf('`', index);
    if (tick === -1) break;
    const ticks = /^`+/.exec(line.slice(tick))![0];
    const close = line.indexOf(ticks, tick + ticks.length);
    if (close === -1) {
      index = tick + ticks.length;
      continue;
    }
    spans.push([tick, close + ticks.length]);
    index = close + ticks.length;
  }
  return spans;
}

/** One line outside a fenced block: every run of markers removed, keeping the words on either side apart. */
function stripLine(line: string, run: RegExp): string {
  const spans = line.includes('`') ? codeSpans(line) : [];
  return line.replace(run, (match: string, offset: number) => {
    if (spans.some(([from, to]) => offset >= from && offset < to)) return match; // inside inline code
    const before = offset === 0 ? '' : line[offset - 1];
    const after = line.slice(offset + match.length);
    // A link definition `[c1]: url` at the start of a line is not a marker.
    if (offset === 0 && after.startsWith(':') && !/\s$/.test(match)) return match;
    if (/^\r?$/.test(after) || CLOSING.test(after)) return '';
    if (!before || /\s/.test(before)) return '';
    return ' ';
  });
}

/** The document as it leaves BotBoy: its citation markers removed (see above). */
export function withoutCitationMarkers(content: string, citationIds: readonly string[]): string {
  const ids = [...new Set(citationIds.map(id => String(id ?? '').trim()).filter(Boolean))];
  if (!ids.length || !content) return content;
  // A run of markers (`[c1][c2]`, `[c1] [c2]`) with the space before it; a link `[c1](…)` is not a marker.
  const marker = `\\[(?:${ids.map(escapeRegExp).join('|')})\\](?!\\()`;
  const run = new RegExp(`(?:(?<=\\S)[ \\t]+)?${marker}(?:[ \\t]*${marker})*[ \\t]*`, 'g');
  const lines = content.split('\n');
  let fence: string | null = null;
  return lines.map((line) => {
    const opener = FENCE.exec(line);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && !line.slice(opener[0].length).trim()) fence = null;
      return line;
    }
    if (opener) {
      fence = opener[1];
      return line;
    }
    return stripLine(line, run);
  }).join('\n');
}

/** What an export or a publication of this document carries: its content without its citation markers. */
export function exportableContent(document: { content: string; citations?: ReadonlyArray<{ id: string }> | null }): string {
  return withoutCitationMarkers(document.content, (document.citations ?? []).map(citation => citation.id));
}
