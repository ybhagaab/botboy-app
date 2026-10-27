/**
 * Google Docs as BotBoy reads and edits them (google-workspace.md, "Docs").
 *
 * The read view is the document's body as numbered lines, the same
 * granularity as read_product_document: one line per paragraph, headings as
 * "#".."######" (Title "#", Subtitle "##"), list items as "- " / "1. " with two
 * spaces per nesting level, a table as "| cell | cell |" rows, and images and
 * other objects as [brackets]. Bold, italic and links are not shown.
 *
 * Every character of the view knows the document index it came from (or that
 * BotBoy drew it). An edit's `find` is matched in the view; the document range
 * under it must be one unbroken run of text (no image, no table edge), and the
 * replacement is written there, so everything the edit does not touch stays as
 * it was. Google's rules (developers.google.com/workspace/docs/api/concepts/
 * rules-behavior): an inserted newline copies the paragraph style at the
 * insertion point, a deletion across paragraphs may change styles, a body's
 * last newline and the newline before a table cannot be deleted, and matching
 * bullets join the list before them. So the planner sets the style of every
 * paragraph an edit creates or merges, from the line marks of the new text.
 */

import type { DocsDocument, DocsParagraph, DocsStructuralElement } from './google-workspace-api.js';

export interface DocBullet {
  nesting: number;
  ordered: boolean;
  checkbox: boolean;
}

export interface DocParagraphLine {
  kind: 'paragraph';
  /** Document index of the paragraph's first character. */
  start: number;
  /** End index (exclusive); end - 1 is the paragraph's newline. */
  end: number;
  namedStyle: string;
  bullet: DocBullet | null;
  /** The mark drawn before the text ("## ", "  - ", ""). */
  marker: string;
  /** False when the next body element is a table, table of contents, or section break (its newline cannot be deleted). */
  newlineDeletable: boolean;
  /** Offset of the line in the view text. */
  offset: number;
}

export interface DocOtherLine {
  kind: 'table_row' | 'synthetic';
  offset: number;
}

export type DocLine = DocParagraphLine | DocOtherLine;

export interface DocView {
  text: string;
  lines: DocLine[];
  /** Per view character: its document index, or -1 when BotBoy drew it. */
  indexAt: Int32Array;
  /** Per view character: 1 when it stands for an image or other object. */
  objectAt: Uint8Array;
  /** The body's last paragraph (where an append goes). */
  lastParagraph: DocParagraphLine | null;
  revisionId?: string;
}

const HEADING_MARKS: Record<string, string> = {
  TITLE: '# ', SUBTITLE: '## ', HEADING_1: '# ', HEADING_2: '## ', HEADING_3: '### ', HEADING_4: '#### ', HEADING_5: '##### ', HEADING_6: '###### ',
};
const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'UPPER_ALPHA', 'ALPHA', 'UPPER_ROMAN', 'ROMAN']);

function bulletOf(doc: DocsDocument, paragraph: DocsParagraph): DocBullet | null {
  const bullet = paragraph.bullet;
  if (!bullet) return null;
  const nesting = Math.max(0, Math.min(8, Number(bullet.nestingLevel ?? 0) || 0));
  const level = bullet.listId ? doc.lists?.[bullet.listId]?.listProperties?.nestingLevels?.[nesting] : undefined;
  const glyph = String(level?.glyphType ?? '');
  const symbol = String(level?.glyphSymbol ?? '');
  const checkbox = /☐|☑|☒/.test(symbol) || glyph === 'CHECKBOX';
  return { nesting, ordered: !checkbox && ORDERED_GLYPHS.has(glyph), checkbox };
}

/** The mark drawn before a paragraph's text. */
export function markerFor(namedStyle: string, bullet: DocBullet | null): string {
  if (bullet) return `${'  '.repeat(bullet.nesting)}${bullet.checkbox ? '- [ ] ' : bullet.ordered ? '1. ' : '- '}`;
  return HEADING_MARKS[namedStyle] ?? '';
}

function placeholderFor(element: NonNullable<DocsParagraph['elements']>[number]): string | null {
  if (element.inlineObjectElement) return '[image]';
  if (element.pageBreak) return '[page break]';
  if (element.columnBreak) return '[column break]';
  if (element.horizontalRule) return '[horizontal line]';
  if (element.footnoteReference) return `[footnote ${element.footnoteReference.footnoteNumber ?? ''}]`.replace(' ]', ']');
  if (element.equation) return '[equation]';
  if (element.person) return `[person: ${element.person.personProperties?.name ?? element.person.personProperties?.email ?? ''}]`;
  if (element.richLink) return `[link: ${element.richLink.richLinkProperties?.title ?? element.richLink.richLinkProperties?.uri ?? ''}]`;
  if (element.autoText) return '[auto text]';
  if (element.dateElement) return '[date]';
  return null;
}

/** The document's body as view lines with an index for every character. */
export function buildDocView(doc: DocsDocument): DocView {
  const chars: string[] = [];
  const indexAt: number[] = [];
  const objectAt: number[] = [];
  const lines: DocLine[] = [];
  let lastParagraph: DocParagraphLine | null = null;

  const push = (text: string, index: number, object = false) => {
    for (let i = 0; i < text.length; i++) {
      chars.push(text[i]);
      indexAt.push(i === 0 ? index : (index >= 0 && !object ? index + i : -1));
      objectAt.push(object && i === 0 ? 1 : 0);
    }
  };
  const drawn = (text: string) => push(text, -1);
  const startLine = (line: DocLine) => {
    const previous = lines[lines.length - 1];
    if (previous) {
      // The line break after a paragraph is its newline; after anything else BotBoy drew it.
      if (previous.kind === 'paragraph') push('\n', previous.end - 1);
      else drawn('\n');
    }
    line.offset = chars.length;
    lines.push(line);
  };

  /** One paragraph's characters (its newline excluded). */
  const pushParagraphText = (paragraph: DocsParagraph) => {
    for (const element of paragraph.elements ?? []) {
      const start = Number(element.startIndex ?? 0);
      if (element.textRun) {
        let content = String(element.textRun.content ?? '');
        if (content.endsWith('\n')) content = content.slice(0, -1);
        // A soft line break (Shift+Enter) is drawn as ⏎ and keeps its index.
        push(content.replace(/\u000b/g, '⏎'), start);
        continue;
      }
      const placeholder = placeholderFor(element);
      if (placeholder) push(placeholder, start, true);
    }
  };

  const body = doc.body?.content ?? [];
  for (let i = 0; i < body.length; i++) {
    const element = body[i];
    if (element.paragraph) {
      const paragraph = element.paragraph;
      const namedStyle = String(paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT');
      const bullet = bulletOf(doc, paragraph);
      const next: DocsStructuralElement | undefined = body[i + 1];
      const line: DocParagraphLine = {
        kind: 'paragraph',
        start: Number(element.startIndex ?? 0),
        end: Number(element.endIndex ?? 0),
        namedStyle,
        bullet,
        marker: markerFor(namedStyle, bullet),
        newlineDeletable: Boolean(next?.paragraph),
        offset: 0,
      };
      startLine(line);
      drawn(line.marker);
      pushParagraphText(paragraph);
      lastParagraph = line;
    } else if (element.table) {
      const rows = element.table.tableRows ?? [];
      rows.forEach((row, rowIndex) => {
        startLine({ kind: 'table_row', offset: 0 });
        drawn('| ');
        (row.tableCells ?? []).forEach((cell, cellIndex) => {
          if (cellIndex > 0) drawn(' | ');
          let first = true;
          for (const content of cell.content ?? []) {
            if (content.paragraph) {
              if (!first) drawn(' <br> ');
              pushParagraphText(content.paragraph);
              first = false;
            } else if (content.table) {
              drawn('[nested table]');
            }
          }
        });
        drawn(' |');
        if (rowIndex === 0) {
          startLine({ kind: 'synthetic', offset: 0 });
          drawn(`|${' --- |'.repeat(Math.max(1, row.tableCells?.length ?? 1))}`);
        }
      });
    } else if (element.tableOfContents) {
      startLine({ kind: 'synthetic', offset: 0 });
      drawn('[table of contents]');
    }
  }
  return {
    text: chars.join(''),
    lines,
    indexAt: Int32Array.from(indexAt),
    objectAt: Uint8Array.from(objectAt),
    lastParagraph,
    ...(doc.revisionId ? { revisionId: doc.revisionId } : {}),
  };
}

/** The view's lines as text (no numbers). */
export function docViewLines(view: DocView): string[] {
  return view.text.split('\n');
}

// ── Markdown in new text ─────────────────────────────────────────────────────

export interface ParsedLine {
  /** null = a normal paragraph. */
  heading: number | null;
  bullet: DocBullet | null;
  content: string;
}

/** A line's leading mark: "## ", "  - ", "1. ", "- [ ] ", or none. */
export function parseLineMark(line: string): ParsedLine {
  const heading = line.match(/^(#{1,6}) (.*)$/s);
  if (heading) return { heading: heading[1].length, bullet: null, content: heading[2] };
  const list = line.match(/^((?: {2}|\t)*)(?:([-*+]) \[[ xX]\] |([-*+]) |(\d{1,3})[.)] )(.*)$/s);
  if (list) {
    const indent = list[1].replace(/\t/g, '  ').length / 2;
    const checkbox = Boolean(list[2]);
    const ordered = Boolean(list[4]);
    return { heading: null, bullet: { nesting: Math.min(8, indent), ordered, checkbox }, content: list[5] };
  }
  return { heading: null, bullet: null, content: line };
}

export interface InlineSpan {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  link?: string;
}

/**
 * Inline Markdown in new text: **bold**, *italic* / _italic_, ~~strike~~,
 * `code`, [text](https://…). Conservative: a mark must hug its text, and an
 * underscore inside a word is just an underscore.
 */
export function parseInlineMarkdown(text: string): { plain: string; spans: InlineSpan[] } {
  const spans: InlineSpan[] = [];
  let plain = '';
  let i = 0;
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__|~~(?=\S)([^~\n]*?\S)~~|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    plain += text.slice(i, at);
    const start = plain.length;
    if (match[1] !== undefined) { plain += match[1]; spans.push({ start, end: plain.length, link: match[2] }); }
    else if (match[3] !== undefined) { plain += match[3]; spans.push({ start, end: plain.length, code: true }); }
    else if (match[4] !== undefined) { plain += match[4]; spans.push({ start, end: plain.length, bold: true }); }
    else if (match[5] !== undefined) { plain += match[5]; spans.push({ start, end: plain.length, bold: true }); }
    else if (match[6] !== undefined) { plain += match[6]; spans.push({ start, end: plain.length, strikethrough: true }); }
    else if (match[7] !== undefined) { plain += match[7]; spans.push({ start, end: plain.length, italic: true }); }
    else if (match[8] !== undefined) { plain += match[8]; spans.push({ start, end: plain.length, italic: true }); }
    i = at + match[0].length;
  }
  plain += text.slice(i);
  return { plain, spans: spans.filter(span => span.end > span.start) };
}

const NAMED_FOR_HEADING = ['NORMAL_TEXT', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];
const PRESET = { ordered: 'NUMBERED_DECIMAL_ALPHA_ROMAN', unordered: 'BULLET_DISC_CIRCLE_SQUARE', checkbox: 'BULLET_CHECKBOX' } as const;
function presetOf(bullet: DocBullet): string {
  return bullet.checkbox ? PRESET.checkbox : bullet.ordered ? PRESET.ordered : PRESET.unordered;
}
/** Inserted text cannot carry these (Google strips them); a soft break drawn as ⏎ goes back as one. */
function cleanInserted(text: string): string {
  return text.replace(/⏎/g, '\u000b').replace(/[\u0000-\u0008\u000c-\u001f\ue000-\uf8ff]/g, '');
}

interface TargetStyle {
  namedStyle: string;
  bullet: DocBullet | null;
}

function sameStyle(a: TargetStyle, b: TargetStyle): boolean {
  const bulletKey = (bullet: DocBullet | null) => (bullet ? `${bullet.ordered ? 'o' : bullet.checkbox ? 'c' : 'u'}${bullet.nesting}` : '');
  const normal = (style: string) => (style === 'TITLE' ? 'HEADING_1' : style === 'SUBTITLE' ? 'HEADING_2' : style);
  return normal(a.namedStyle) === normal(b.namedStyle) && bulletKey(a.bullet) === bulletKey(b.bullet);
}

function styleFromParsed(parsed: ParsedLine): TargetStyle {
  return { namedStyle: parsed.heading ? NAMED_FOR_HEADING[parsed.heading] : 'NORMAL_TEXT', bullet: parsed.bullet };
}

// ── Planning edits ───────────────────────────────────────────────────────────

export interface DocEditInput {
  find: string;
  replace: string;
}

export type DocEditFailureCode = 'invalid_edits' | 'edit_not_found' | 'edit_not_unique' | 'edit_not_editable' | 'edits_overlap';

export interface DocEditFailure {
  ok: false;
  code: DocEditFailureCode;
  index?: number;
  message: string;
}

export interface DocEditPlan {
  ok: true;
  requests: unknown[];
  /** Per edit: the line it starts on in the view as read, and the new text's plain form (to verify after the write). */
  changes: Array<{ index: number; line: number; inserted: string }>;
  /** The same requests by the document range each edit touches, so other edits can be ordered among them. */
  blocks?: DocRequestBlock[];
}

/** Requests that act at one place, and the range of the document as read that they change. */
export interface DocRequestBlock {
  /** Where the requests act (a document index of the read). Blocks apply from the highest down. */
  at: number;
  /** The range the requests change: [from, to). An insert has from === to. */
  from: number;
  to: number;
  /** Edit order, for blocks at the same place (a later edit goes in first, so the earlier ends up first). */
  order: number;
  requests: unknown[];
}

/** Blocks from the end of the document back, so every block's indexes are still right when it applies. */
export function orderDocBlocks(blocks: readonly DocRequestBlock[]): unknown[] {
  return [...blocks].sort((a, b) => (b.at - a.at) || (b.order - a.order)).flatMap(block => block.requests);
}

interface PlannedEdit {
  index: number;
  docStart: number;
  docEnd: number;
  viewStart: number;
  viewEnd: number;
  requests: unknown[];
  line: number;
  inserted: string;
}

function lineIndexAt(view: DocView, offset: number): number {
  let low = 0;
  let high = view.lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (view.lines[middle].offset <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function lineEndOffset(view: DocView, lineIndex: number): number {
  const next = view.lines[lineIndex + 1];
  return next ? next.offset - 1 : view.text.length;
}

/** Text requests for inline spans at `base`. */
function inlineStyleRequests(spans: InlineSpan[], base: number): unknown[] {
  const out: unknown[] = [];
  for (const span of spans) {
    const range = { startIndex: base + span.start, endIndex: base + span.end };
    const textStyle: Record<string, unknown> = {};
    const fields: string[] = [];
    if (span.bold) { textStyle.bold = true; fields.push('bold'); }
    if (span.italic) { textStyle.italic = true; fields.push('italic'); }
    if (span.strikethrough) { textStyle.strikethrough = true; fields.push('strikethrough'); }
    if (span.code) { textStyle.weightedFontFamily = { fontFamily: 'Roboto Mono' }; fields.push('weightedFontFamily'); }
    if (span.link) { textStyle.link = { url: span.link }; fields.push('link'); }
    if (fields.length) out.push({ updateTextStyle: { range, textStyle, fields: fields.join(',') } });
  }
  return out;
}

interface NewParagraph {
  /** Text inserted for it (leading tabs for list nesting included). */
  text: string;
  spans: InlineSpan[];
  tabs: number;
  target: TargetStyle | null;
  /** Set its style even when it already looks right (its paragraph was split or merged). */
  force: boolean;
}

/**
 * The requests for one replacement at [docStart, docEnd): delete, insert,
 * then paragraph styles, bullet removals, inline styles, and bullets last
 * (creating bullets removes the leading tabs and moves later indexes).
 */
function replacementRequests(docStart: number, docEnd: number, paragraphs: NewParagraph[], mayInheritBullet: boolean): unknown[] {
  const requests: unknown[] = [];
  if (docEnd > docStart) requests.push({ deleteContentRange: { range: { startIndex: docStart, endIndex: docEnd } } });
  const inserted = paragraphs.map(paragraph => paragraph.text).join('\n');
  if (inserted) requests.push({ insertText: { location: { index: docStart }, text: inserted } });
  // Where each new paragraph starts once the text is in.
  const starts: number[] = [];
  let at = docStart;
  for (const paragraph of paragraphs) {
    starts.push(at);
    at += paragraph.text.length + 1;
  }
  const rangeOf = (i: number) => ({ startIndex: starts[i], endIndex: starts[i] + Math.max(1, paragraphs[i].text.length) });
  paragraphs.forEach((paragraph, i) => {
    if (!paragraph.target || !paragraph.force) return;
    requests.push({ updateParagraphStyle: { range: rangeOf(i), paragraphStyle: { namedStyleType: paragraph.target.namedStyle }, fields: 'namedStyleType' } });
  });
  paragraphs.forEach((paragraph, i) => {
    if (!paragraph.target || !paragraph.force || paragraph.target.bullet || !mayInheritBullet) return;
    requests.push({ deleteParagraphBullets: { range: rangeOf(i) } });
  });
  paragraphs.forEach((paragraph, i) => {
    requests.push(...inlineStyleRequests(paragraph.spans, starts[i] + paragraph.tabs));
  });
  // Consecutive list paragraphs of one kind become one list; the last group goes first.
  const groups: Array<{ from: number; to: number; preset: string }> = [];
  paragraphs.forEach((paragraph, i) => {
    const bullet = paragraph.force ? paragraph.target?.bullet : null;
    if (!bullet) return;
    const preset = presetOf(bullet);
    const last = groups[groups.length - 1];
    if (last && last.to === i - 1 && last.preset === preset) last.to = i;
    else groups.push({ from: i, to: i, preset });
  });
  for (const group of groups.reverse()) {
    requests.push({ createParagraphBullets: { range: { startIndex: starts[group.from], endIndex: starts[group.to] + Math.max(1, paragraphs[group.to].text.length) }, bulletPreset: group.preset } });
  }
  return requests;
}

function newParagraph(content: string, target: TargetStyle | null, force: boolean, markdown: boolean): NewParagraph {
  const tabs = target?.bullet && force ? target.bullet.nesting : 0;
  const parsed = markdown ? parseInlineMarkdown(content) : { plain: content, spans: [] };
  return { text: `${'\t'.repeat(tabs)}${cleanInserted(parsed.plain)}`, spans: parsed.spans, tabs, target, force };
}

/**
 * Plan exact find/replace edits against the document as read. Each find must
 * occur once in the view; edits may not overlap; all of them go in one
 * batchUpdate (all or nothing).
 */
export function planDocEdits(doc: DocsDocument, edits: readonly DocEditInput[], options: { markdown?: boolean } = {}): DocEditPlan | DocEditFailure {
  const view = buildDocView(doc);
  const markdown = options.markdown !== false;
  const planned: PlannedEdit[] = [];
  for (let index = 0; index < edits.length; index++) {
    const { find, replace } = edits[index];
    if (!find) return { ok: false, code: 'invalid_edits', index, message: `edits[${index}].find is empty.` };
    const a = view.text.indexOf(find);
    if (a < 0) {
      return { ok: false, code: 'edit_not_found', index, message: `edits[${index}].find does not occur in the document as read (copy it from gdrive_read's lines, without the "N: " prefix; bold, italic and links are not shown there).` };
    }
    if (view.text.indexOf(find, a + 1) >= 0) return { ok: false, code: 'edit_not_unique', index, message: `edits[${index}].find occurs more than once; make it longer so it occurs once.` };
    const b = a + find.length;
    const mapped: number[] = [];
    for (let k = a; k < b; k++) {
      if (view.objectAt[k]) return { ok: false, code: 'edit_not_editable', index, message: `edits[${index}].find covers an image or other object (shown in [brackets]), which BotBoy cannot recreate. Edit the text before or after it.` };
      if (view.indexAt[k] >= 0) mapped.push(view.indexAt[k]);
    }
    if (!mapped.length) return { ok: false, code: 'edit_not_editable', index, message: `edits[${index}].find matches only BotBoy's line marks (like "## " or "- " or "| "), not the document's text.` };
    for (let k = 1; k < mapped.length; k++) {
      if (mapped[k] !== mapped[k - 1] + 1) {
        return { ok: false, code: 'edit_not_editable', index, message: `edits[${index}].find spans table cells or parts that are not one run of text. Edit one table cell, or the text on each side, in separate edits.` };
      }
    }
    const docStart = mapped[0];
    const docEnd = mapped[mapped.length - 1] + 1;
    const firstLineIndex = lineIndexAt(view, a);
    const lastLineIndex = lineIndexAt(view, Math.max(a, b - 1));
    const first = view.lines[firstLineIndex];
    // The newline before a table (or a section break) cannot be deleted.
    for (let li = firstLineIndex; li <= lastLineIndex; li++) {
      const line = view.lines[li];
      if (line.kind === 'paragraph' && !line.newlineDeletable && docStart <= line.end - 1 && line.end - 1 < docEnd) {
        return { ok: false, code: 'edit_not_editable', index, message: `edits[${index}].find ends the paragraph just before a table; Google does not allow removing that line break. Leave the last line break out of find.` };
      }
    }
    const replaceLines = replace.split('\n');
    const inTable = first.kind !== 'paragraph';
    const paragraphs: NewParagraph[] = [];
    let mayInheritBullet = false;
    if (inTable) {
      // Inside a table: text only, no line marks.
      replaceLines.forEach(line => paragraphs.push(newParagraph(line, null, false, markdown)));
    } else {
      const line1 = first as DocParagraphLine;
      const original: TargetStyle = { namedStyle: line1.namedStyle, bullet: line1.bullet };
      const lastLine = view.lines[lastLineIndex];
      const lastStyle: TargetStyle | null = lastLine.kind === 'paragraph' ? { namedStyle: lastLine.namedStyle, bullet: lastLine.bullet } : null;
      const merged = lastLineIndex !== firstLineIndex || find.includes('\n');
      mayInheritBullet = Boolean(line1.bullet || (lastLine.kind === 'paragraph' && lastLine.bullet));
      // Literal text (markdown: false) never reads line marks: the paragraph keeps its style.
      const ownsFirstStyle = markdown && a - line1.offset <= line1.marker.length;
      // The first new line: its mark is read from what stays before the match plus the new text.
      let firstTarget: TargetStyle;
      let firstContent: string;
      if (ownsFirstStyle) {
        const parsed = parseLineMark(view.text.slice(line1.offset, a) + replaceLines[0]);
        firstTarget = styleFromParsed(parsed);
        firstContent = parsed.content;
      } else {
        firstTarget = original;
        firstContent = replaceLines[0];
      }
      // A first paragraph keeps its style unless the new mark differs, or a merge may have changed it.
      const firstForce = !sameStyle(firstTarget, original) || (merged && (!lastStyle || !sameStyle(original, lastStyle)));
      paragraphs.push(newParagraph(firstContent, firstTarget, firstForce, markdown));
      // A new line copies the first paragraph's style (Google's insert rule), so it is set only when its mark differs or a merge
      // made the copied style uncertain. A list line that matches is left in the list it copied, which keeps the numbering.
      for (let i = 1; i < replaceLines.length; i++) {
        // In literal mode a new line keeps the style Google copies from the first paragraph.
        const parsed = markdown ? parseLineMark(replaceLines[i]) : null;
        const target = parsed ? styleFromParsed(parsed) : original;
        paragraphs.push(newParagraph(parsed ? parsed.content : replaceLines[i], target, merged || !sameStyle(target, original), markdown));
      }
    }
    planned.push({
      index,
      docStart,
      docEnd,
      viewStart: a,
      viewEnd: b,
      requests: replacementRequests(docStart, docEnd, paragraphs, mayInheritBullet),
      line: firstLineIndex + 1,
      inserted: paragraphs.map(paragraph => paragraph.text.replace(/^\t+/, '')).join('\n'),
    });
  }
  const byView = [...planned].sort((x, y) => x.viewStart - y.viewStart);
  for (let i = 1; i < byView.length; i++) {
    if (byView[i].viewStart < byView[i - 1].viewEnd || byView[i].docStart < byView[i - 1].docEnd) {
      return { ok: false, code: 'edits_overlap', index: byView[i].index, message: `edits[${byView[i].index}] overlaps edits[${byView[i - 1].index}]; each edit must change a different part. Combine them into one edit.` };
    }
  }
  // From the end of the document back, so each edit's indexes are still right when it applies.
  const requests = [...planned].sort((x, y) => y.docStart - x.docStart).flatMap(edit => edit.requests);
  return {
    ok: true,
    requests,
    changes: planned.map(edit => ({ index: edit.index, line: edit.line, inserted: edit.inserted })),
    blocks: planned.map(edit => ({ at: edit.docStart, from: edit.docStart, to: edit.docEnd, order: edit.index, requests: edit.requests })),
  };
}

// ── Pictures ─────────────────────────────────────────────────────────────────

export interface DocPictureInsert {
  /** The edit's index in the call. */
  index: number;
  /** Exact text of the paragraph the picture goes after (copied from the read). */
  after?: string;
  /** Or: after the document's last paragraph. */
  atEnd?: boolean;
  uri: string;
  widthPt?: number;
}

export interface DocPicturePlan {
  ok: true;
  blocks: DocRequestBlock[];
  /** Per picture: the view line it goes after. */
  lines: Array<{ index: number; line: number }>;
}

/**
 * A picture goes in a new paragraph of its own after the named one: a newline is
 * inserted before that paragraph's newline, which makes an empty paragraph after
 * it; that paragraph is made normal text, centred, without a bullet (Google copies
 * the style of the paragraph it split), and the picture goes in it.
 */
export function planDocPictureInserts(doc: DocsDocument, inserts: readonly DocPictureInsert[]): DocPicturePlan | DocEditFailure {
  const view = buildDocView(doc);
  const blocks: DocRequestBlock[] = [];
  const lines: DocPicturePlan['lines'] = [];
  for (const insert of inserts) {
    const index = insert.index;
    let line: DocParagraphLine | null = null;
    let lineNumber = 0;
    if (insert.atEnd) {
      line = view.lastParagraph;
      if (!line) return { ok: false, code: 'edit_not_editable', index, message: `edits[${index}]: the document has no paragraph to put a picture after.` };
      lineNumber = view.lines.indexOf(line) + 1;
    } else {
      const after = String(insert.after ?? '');
      if (!after) return { ok: false, code: 'invalid_edits', index, message: `edits[${index}].after is empty: copy the paragraph's text from gdrive_read.` };
      const a = view.text.indexOf(after);
      if (a < 0) return { ok: false, code: 'edit_not_found', index, message: `edits[${index}].after does not occur in the document as read (copy it from gdrive_read's lines, without the "N: " prefix).` };
      if (view.text.indexOf(after, a + 1) >= 0) return { ok: false, code: 'edit_not_unique', index, message: `edits[${index}].after occurs more than once; make it longer so it occurs once.` };
      const lineIndex = lineIndexAt(view, a + after.length - 1);
      const found = view.lines[lineIndex];
      if (found.kind !== 'paragraph') return { ok: false, code: 'edit_not_editable', index, message: `edits[${index}].after is in a table; a picture goes after a paragraph, so name the paragraph before or after the table.` };
      line = found;
      lineNumber = lineIndex + 1;
    }
    const empty = line.end - line.start <= 1;
    // An empty last paragraph takes the picture itself; otherwise a new paragraph starts after the line.
    const at = empty && insert.atEnd ? line.start : line.end;
    const requests: unknown[] = [];
    if (!(empty && insert.atEnd)) requests.push({ insertText: { location: { index: line.end - 1 }, text: '\n' } });
    requests.push({ updateParagraphStyle: { range: { startIndex: at, endIndex: at + 1 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT', alignment: 'CENTER' }, fields: 'namedStyleType,alignment' } });
    if (line.bullet) requests.push({ deleteParagraphBullets: { range: { startIndex: at, endIndex: at + 1 } } });
    requests.push({
      insertInlineImage: {
        location: { index: at },
        uri: insert.uri,
        ...(insert.widthPt ? { objectSize: { width: { magnitude: insert.widthPt, unit: 'PT' } } } : {}),
      },
    });
    const place = empty && insert.atEnd ? line.start : line.end - 1;
    blocks.push({ at: place, from: place, to: place, order: index, requests });
    lines.push({ index, line: lineNumber });
  }
  return { ok: true, blocks, lines };
}

/** Text edits whose range takes in the place a picture goes (the end of its paragraph). */
export function pictureOverlapsEdit(picture: DocRequestBlock, edits: readonly DocRequestBlock[]): DocRequestBlock | null {
  return edits.find(edit => edit.from <= picture.at && picture.at < edit.to) ?? null;
}

/** How many pictures (inline images) a document holds, tables included. */
export function inlinePictureCount(doc: DocsDocument): number {
  let count = 0;
  const walk = (content: DocsStructuralElement[] | undefined) => {
    for (const element of content ?? []) {
      for (const part of element.paragraph?.elements ?? []) if (part.inlineObjectElement) count++;
      for (const row of element.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content);
    }
  };
  walk(doc.body?.content);
  return count;
}

/** Requests that add Markdown lines after the document's last paragraph. */
export function planDocAppend(doc: DocsDocument, markdownText: string, options: { markdown?: boolean } = {}): DocEditPlan | DocEditFailure {
  const view = buildDocView(doc);
  const last = view.lastParagraph;
  if (!last) return { ok: false, code: 'edit_not_editable', message: 'The document has no paragraph to add after.' };
  const markdown = options.markdown !== false;
  const lines = markdownText.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (!lines.length || (lines.length === 1 && !lines[0])) return { ok: false, code: 'invalid_edits', message: 'append is empty.' };
  const lastIsEmpty = last.end - last.start <= 1;
  // Literal text (markdown: false) is appended as normal paragraphs, its marks kept as text.
  const paragraphs = lines.map(line => (markdown
    ? newParagraph(parseLineMark(line).content, styleFromParsed(parseLineMark(line)), true, true)
    : newParagraph(line, { namedStyle: 'NORMAL_TEXT', bullet: null }, true, false)));
  // An empty last paragraph takes the first new line; otherwise the new lines start after the last one's text.
  const at = lastIsEmpty ? last.start : last.end - 1;
  const requests = lastIsEmpty
    ? replacementRequests(at, at, paragraphs, Boolean(last.bullet))
    : replacementRequests(at, at, [{ text: '', spans: [], tabs: 0, target: null, force: false }, ...paragraphs], Boolean(last.bullet));
  // The leading empty paragraph above stands for the end of the last line: its text is ''.
  return {
    ok: true,
    requests,
    changes: [{ index: 0, line: view.lines.length + (lastIsEmpty ? 0 : 1), inserted: paragraphs.map(paragraph => paragraph.text.replace(/^\t+/, '')).join('\n') }],
    blocks: [{ at, from: at, to: at, order: -1, requests }],
  };
}
