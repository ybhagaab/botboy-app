/**
 * Markdown ↔ docx-text anchoring (doc editor E1, DOC_EDITOR_UX_PLAN.md).
 *
 * The document parser emits markdown where EVERY non-table line maps 1:1 to
 * one docx paragraph: headings get `#`s, list items get `- ` / `N. ` markers
 * (real numbers injected from numbering.xml), plain paragraphs are the
 * squashed w:t text verbatim, and NO inline markers are ever emitted
 * (document-parser.ts › docxParagraphToMarkdown). Range edits anchor on the
 * docx-side text, so markdown decorations must be stripped before matching.
 *
 * Known edge (recorded, acceptable v1): a body paragraph whose literal text
 * starts with "- " or "1. " is indistinguishable from a list item in the
 * markdown — stripping produces an anchor that misses the real docx text and
 * the edit lands `conflicted` (the guard, recoverable), never corrupts.
 */

export interface MarkdownBlock {
  /** Raw block text (lines joined with \n, no trailing blank lines). */
  text: string;
  lines: string[];
  kind: 'table' | 'list' | 'plain';
}

const LIST_LINE_RE = /^\s{0,3}(?:[-*•]|\d+[.)])\s+/;
const TABLE_LINE_RE = /^\s*\|.+\|\s*$/;

/**
 * Split markdown into blank-line-separated blocks, respecting ``` fences
 * (the parser never emits fences, but stage-2 drafts and LLM replacements
 * may contain them — a fenced block with internal blank lines must stay one
 * block).
 */
export function markdownBlocksOf(markdown: string): MarkdownBlock[] {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    while (current.length && current[current.length - 1].trim() === '') current.pop();
    if (current.length === 0) return;
    const nonEmpty = current.filter(l => l.trim() !== '');
    const kind: MarkdownBlock['kind'] = nonEmpty.every(l => TABLE_LINE_RE.test(l)) && nonEmpty.length > 0
      ? 'table'
      : nonEmpty.every(l => LIST_LINE_RE.test(l)) && nonEmpty.length > 0
        ? 'list'
        : 'plain';
    blocks.push({ text: current.join('\n'), lines: [...current], kind });
    current = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Invert the parser's markdown decorations back to the docx paragraph text
 * (squashed, like document-parser › docxParagraphText). Used for anchors and
 * read-back probes.
 */
export function markdownLineToDocxText(line: string): string {
  let text = String(line ?? '');
  text = text.replace(/^\s{0,3}#{1,6}\s+/, '');          // heading markers
  text = text.replace(LIST_LINE_RE, '');                  // list markers (incl. injected numbers)
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');          // bold (parser + MCP dialects)
  text = text.replace(/__([^_]+)__/g, '$1');              // bold, underscore form
  text = text.replace(/\*([^*]+)\*/g, '$1');              // italic
  text = text.replace(/(^|[^\w\\])_([^_]+)_(?=\W|$)/g, '$1$2'); // italic, underscore form (MCP converter)
  text = text.replace(/`([^`]+)`/g, '$1');                // inline code
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // links → label
  // MCP-converter markdown escapes punctuation that is literal docx text
  // ("1\. freeze" for a literal numbered line). Unescape LAST so escaped
  // markers were never treated as formatting above.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One anchor entry per docx paragraph for a block. Tables are not anchorable
 * (range splices inside w:tbl would corrupt the package) — callers must
 * exclude them.
 */
export function blockToAnchorParagraphs(block: MarkdownBlock): string[] | null {
  if (block.kind === 'table') return null;
  const anchors = block.lines.map(markdownLineToDocxText).filter(t => t.length > 0);
  return anchors.length ? anchors : null;
}
