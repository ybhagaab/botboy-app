/**
 * In-memory Google Docs for tests (google-workspace.md). The document is a
 * flat run of UTF-16 code units, like Google's index space: index 0 is the
 * section break, every paragraph ends with a newline that carries its style
 * and bullet, and a table is start/row/cell/end marks around cell paragraphs.
 *
 * It applies the requests BotBoy sends with Google's rules (rules-behavior):
 * an inserted newline copies the style of the paragraph it lands in, inserted
 * text takes the style of the text before it, bullets created over leading
 * tabs nest by the tab count and join a matching list just before, a body's
 * last newline and the newline before a table cannot be deleted, and a write
 * with a stale requiredRevisionId is refused.
 */

import { GoogleApiError } from './gmail-api.js';
import { parseInlineMarkdown, parseLineMark } from './gdocs-model.js';
import type { DocsClient, DocsDocument, DocsStructuralElement, DocsTextStyle } from './google-workspace-api.js';

type Mark = 'text' | 'newline' | 'object' | 'tableStart' | 'rowStart' | 'cellStart' | 'tableEnd';

interface Unit {
  ch: string;
  mark: Mark;
  style?: DocsTextStyle;
  /** On a newline: the paragraph's properties. */
  para?: { namedStyle: string; bullet: { listId: string; nesting: number } | null; alignment?: string };
  /** On an inserted picture: the address Google fetched it from. */
  uri?: string;
}

interface FakeDoc {
  id: string;
  title: string;
  revision: number;
  units: Unit[];
  lists: Record<string, { preset: string }>;
}

export interface FakeDocs extends DocsClient {
  docs: Map<string, FakeDoc>;
  calls: Array<{ op: 'get' | 'batchUpdate'; documentId: string; requests?: unknown[] }>;
  /** A document from Markdown (headings, lists, | tables |, **bold**), the way Drive's import makes one. */
  fromMarkdown(documentId: string, markdown: string, title?: string): void;
  /** Each paragraph as "STYLE|bullet|text" for assertions (tables as "TABLE r,c: text"). */
  lines(documentId: string): string[];
  /** The next batchUpdate fails with this error, optionally after applying (lost answer). */
  failNext(error: GoogleApiError, options?: { afterEffect?: boolean }): void;
  /** Someone else edits: bumps the revision. */
  touch(documentId: string): void;
  /** insertInlineImage from a matching address fails like Google's fetch failure (HTTP 400, nothing written). */
  refuseImageUri?: (uri: string) => boolean;
  /** The addresses of the pictures inserted into a document, in document order. */
  pictures(documentId: string): string[];
}

const PRESET_ORDERED = 'NUMBERED_DECIMAL_ALPHA_ROMAN';

function newline(namedStyle = 'NORMAL_TEXT', bullet: { listId: string; nesting: number } | null = null): Unit {
  return { ch: '\n', mark: 'newline', para: { namedStyle, bullet } };
}

export function createFakeDocs(): FakeDocs {
  const docs = new Map<string, FakeDoc>();
  const calls: FakeDocs['calls'] = [];
  let pending: { error: GoogleApiError; afterEffect: boolean } | null = null;
  let listSeq = 0;
  /** The fake itself, for settings tests change after creating it (refuseImageUri). */
  let api: FakeDocs | null = null;

  function doc(id: string): FakeDoc {
    const found = docs.get(id);
    if (!found) throw new GoogleApiError('Google Docs read failed (HTTP 404 NOT_FOUND: Requested entity was not found.)', 404, 'NOT_FOUND');
    return found;
  }

  function textUnits(text: string, style: DocsTextStyle = {}): Unit[] {
    return [...text].flatMap(cp => cp.split('')).map(ch => ({ ch, mark: 'text' as const, style: { ...style } }));
  }

  function fromMarkdown(id: string, markdown: string, title = 'Untitled'): void {
    const units: Unit[] = [];
    const lists: FakeDoc['lists'] = {};
    let currentList: { id: string; preset: string } | null = null;
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { currentList = null; continue; }
      if (/^\s*\|/.test(line)) {
        const rows: string[][] = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
          if (!cells.every(cell => /^:?-{3,}:?$/.test(cell))) rows.push(cells);
          i++;
        }
        i--;
        units.push({ ch: '\u0000', mark: 'tableStart' });
        for (const row of rows) {
          units.push({ ch: '\u0000', mark: 'rowStart' });
          for (const cell of row) {
            units.push({ ch: '\u0000', mark: 'cellStart' });
            const parsed = parseInlineMarkdown(cell);
            units.push(...textUnits(parsed.plain), newline());
          }
        }
        units.push({ ch: '\u0000', mark: 'tableEnd' });
        currentList = null;
        continue;
      }
      const mark = parseLineMark(line);
      let bullet: { listId: string; nesting: number } | null = null;
      if (mark.bullet) {
        const preset = mark.bullet.ordered ? PRESET_ORDERED : 'BULLET_DISC_CIRCLE_SQUARE';
        if (!currentList || currentList.preset !== preset) {
          currentList = { id: `list${++listSeq}`, preset };
          lists[currentList.id] = { preset };
        }
        bullet = { listId: currentList.id, nesting: mark.bullet.nesting };
      } else {
        currentList = null;
      }
      const named = mark.heading ? `HEADING_${mark.heading}` : 'NORMAL_TEXT';
      const parsed = parseInlineMarkdown(mark.content);
      const runs = textUnits(parsed.plain);
      for (const span of parsed.spans) {
        for (let k = span.start; k < span.end; k++) {
          if (span.bold) runs[k].style!.bold = true;
          if (span.italic) runs[k].style!.italic = true;
          if (span.link) runs[k].style!.link = { url: span.link };
        }
      }
      // [image] in the Markdown stands for an inline image.
      const withImages: Unit[] = [];
      const plain = runs.map(unit => unit.ch).join('');
      let at = 0;
      for (const match of plain.matchAll(/\[image\]/g)) {
        withImages.push(...runs.slice(at, match.index));
        withImages.push({ ch: '\u0000', mark: 'object' });
        at = (match.index ?? 0) + match[0].length;
      }
      withImages.push(...runs.slice(at));
      units.push(...withImages, newline(named, bullet));
    }
    // A body always ends with a paragraph (also after a table).
    if (!units.length || units[units.length - 1].mark !== 'newline') units.push(newline());
    docs.set(id, { id, title, revision: 1, units, lists });
  }

  /** Paragraph spans [from, to] (positions in units; `to` is the newline). */
  function paragraphsOf(units: Unit[]): Array<{ from: number; to: number }> {
    const out: Array<{ from: number; to: number }> = [];
    let from = 0;
    for (let k = 0; k < units.length; k++) {
      const unit = units[k];
      if (unit.mark === 'tableStart' || unit.mark === 'rowStart' || unit.mark === 'cellStart' || unit.mark === 'tableEnd') { from = k + 1; continue; }
      if (unit.mark === 'newline') { out.push({ from, to: k }); from = k + 1; }
    }
    return out;
  }

  const posOf = (index: number) => index - 1;

  function serialize(fake: FakeDoc): DocsDocument {
    const content: DocsStructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
    const units = fake.units;
    const paragraphAt = (from: number, to: number): DocsStructuralElement => {
      const elements: any[] = [];
      let run: { start: number; text: string; style: string } | null = null;
      const flush = (endK: number) => {
        if (run) elements.push({ startIndex: run.start + 1, endIndex: endK + 1, textRun: { content: run.text, textStyle: JSON.parse(run.style) } });
        run = null;
      };
      for (let k = from; k <= to; k++) {
        const unit = units[k];
        if (unit.mark === 'object') {
          flush(k);
          elements.push({ startIndex: k + 1, endIndex: k + 2, inlineObjectElement: { inlineObjectId: `obj${k}` } });
          continue;
        }
        if (unit.mark === 'newline') {
          if (!run) run = { start: k, text: '', style: '{}' };
          run.text += '\n';
          flush(k + 1);
          continue;
        }
        const style = JSON.stringify(unit.style ?? {});
        if (run && run.style !== style) flush(k);
        if (!run) run = { start: k, text: '', style };
        run.text += unit.ch;
      }
      const para = units[to].para!;
      return {
        startIndex: from + 1,
        endIndex: to + 2,
        paragraph: {
          elements,
          paragraphStyle: { namedStyleType: para.namedStyle },
          ...(para.bullet ? { bullet: { listId: para.bullet.listId, nestingLevel: para.bullet.nesting } } : {}),
        },
      };
    };
    let k = 0;
    while (k < units.length) {
      const unit = units[k];
      if (unit.mark === 'tableStart') {
        const tableStart = k;
        const tableRows: any[] = [];
        k++;
        while (units[k].mark !== 'tableEnd') {
          if (units[k].mark === 'rowStart') {
            const row = { startIndex: k + 1, tableCells: [] as any[] };
            tableRows.push(row);
            k++;
            continue;
          }
          if (units[k].mark === 'cellStart') {
            const cell = { startIndex: k + 1, content: [] as DocsStructuralElement[] };
            tableRows[tableRows.length - 1].tableCells.push(cell);
            k++;
            while (k < units.length && units[k].mark !== 'cellStart' && units[k].mark !== 'rowStart' && units[k].mark !== 'tableEnd') {
              let to = k;
              while (units[to].mark !== 'newline') to++;
              cell.content.push(paragraphAt(k, to));
              k = to + 1;
            }
            continue;
          }
          k++;
        }
        content.push({ startIndex: tableStart + 1, endIndex: k + 2, table: { rows: tableRows.length, columns: tableRows[0]?.tableCells.length ?? 0, tableRows } });
        k++;
        continue;
      }
      let to = k;
      while (units[to].mark !== 'newline') to++;
      content.push(paragraphAt(k, to));
      k = to + 1;
    }
    const lists: DocsDocument['lists'] = {};
    for (const [id, list] of Object.entries(fake.lists)) {
      lists[id] = { listProperties: { nestingLevels: Array.from({ length: 9 }, () => (list.preset === PRESET_ORDERED ? { glyphType: 'DECIMAL' } : list.preset === 'BULLET_CHECKBOX' ? { glyphSymbol: '☐' } : { glyphSymbol: '●' })) } };
    }
    return { documentId: fake.id, title: fake.title, revisionId: `rev-${fake.revision}`, body: { content }, lists };
  }

  function apply(fake: FakeDoc, request: any): void {
    const units = fake.units;
    if (request.deleteContentRange) {
      const { startIndex, endIndex } = request.deleteContentRange.range;
      const from = posOf(startIndex);
      const to = posOf(endIndex);
      if (!(from >= 0 && to > from && to <= units.length)) throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: bad range)', 400, 'INVALID_ARGUMENT');
      if (to >= units.length) throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: The range cannot include the newline character at the end of the segment.)', 400, 'INVALID_ARGUMENT');
      for (let k = from; k < to; k++) {
        if (units[k].mark !== 'text' && units[k].mark !== 'newline' && units[k].mark !== 'object') throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: Invalid deletion range. Cannot delete the requested range.)', 400, 'INVALID_ARGUMENT');
        if (units[k].mark === 'newline' && units[k + 1]?.mark === 'tableStart') throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: Cannot delete the newline before a table.)', 400, 'INVALID_ARGUMENT');
        if (units[k].mark === 'newline' && (units[k + 1]?.mark === 'cellStart' || units[k + 1]?.mark === 'rowStart' || units[k + 1]?.mark === 'tableEnd')) throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: Cannot delete the last newline of a table cell.)', 400, 'INVALID_ARGUMENT');
      }
      units.splice(from, to - from);
      return;
    }
    if (request.insertText) {
      const index = request.insertText.location.index;
      const at = posOf(index);
      if (!(at >= 0 && at < units.length) || ['tableStart', 'rowStart', 'cellStart', 'tableEnd'].includes(units[at].mark)) {
        throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: insertion index must be inside a paragraph)', 400, 'INVALID_ARGUMENT');
      }
      let end = at;
      while (units[end].mark !== 'newline') end++;
      const para = units[end].para!;
      const before = at > 0 && units[at - 1].mark === 'text' ? units[at - 1].style : units[at].mark === 'text' ? units[at].style : {};
      const text = String(request.insertText.text);
      const inserted: Unit[] = [...text].flatMap(cp => cp.split('')).map(ch => (ch === '\n'
        ? { ch, mark: 'newline' as const, para: { namedStyle: para.namedStyle, bullet: para.bullet ? { ...para.bullet } : null } }
        : { ch, mark: 'text' as const, style: { ...(before ?? {}) } }));
      units.splice(at, 0, ...inserted);
      return;
    }
    if (request.insertInlineImage) {
      const uri = String(request.insertInlineImage.uri ?? '');
      if (!/^https:\/\//.test(uri) || api?.refuseImageUri?.(uri)) {
        throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: Invalid requests[0].insertInlineImage: There was a problem retrieving the image. The provided image should be publicly accessible, within size limit, and in supported formats.)', 400, 'INVALID_ARGUMENT');
      }
      const at = posOf(request.insertInlineImage.location.index);
      if (!(at >= 0 && at < units.length) || ['tableStart', 'rowStart', 'cellStart', 'tableEnd'].includes(units[at].mark)) {
        throw new GoogleApiError('Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: insertion index must be inside a paragraph)', 400, 'INVALID_ARGUMENT');
      }
      units.splice(at, 0, { ch: '\u0000', mark: 'object', uri });
      return;
    }
    const overlapped = (range: { startIndex: number; endIndex: number }) => paragraphsOf(units)
      .filter(paragraph => paragraph.from + 1 < range.endIndex && paragraph.to + 2 > range.startIndex);
    if (request.updateParagraphStyle) {
      for (const paragraph of overlapped(request.updateParagraphStyle.range)) {
        const style = request.updateParagraphStyle.paragraphStyle;
        if (style.namedStyleType) units[paragraph.to].para!.namedStyle = style.namedStyleType;
        if (style.alignment) units[paragraph.to].para!.alignment = style.alignment;
      }
      return;
    }
    if (request.deleteParagraphBullets) {
      for (const paragraph of overlapped(request.deleteParagraphBullets.range)) units[paragraph.to].para!.bullet = null;
      return;
    }
    if (request.updateTextStyle) {
      const { startIndex, endIndex } = request.updateTextStyle.range;
      for (let k = posOf(startIndex); k < posOf(endIndex); k++) {
        if (units[k]?.mark === 'text') units[k].style = { ...(units[k].style ?? {}), ...request.updateTextStyle.textStyle };
      }
      return;
    }
    if (request.createParagraphBullets) {
      const preset = request.createParagraphBullets.bulletPreset;
      // From the last paragraph back, so removing tabs does not move the ones still to do.
      const targets = overlapped(request.createParagraphBullets.range).reverse();
      let listId: string | null = null;
      const firstTarget = targets[targets.length - 1];
      if (firstTarget) {
        const all = paragraphsOf(units);
        const before = all[all.findIndex(paragraph => paragraph.from === firstTarget.from) - 1];
        const beforeBullet = before ? units[before.to].para?.bullet : null;
        if (beforeBullet && fake.lists[beforeBullet.listId]?.preset === preset && before.to + 1 === firstTarget.from) listId = beforeBullet.listId;
      }
      if (!listId) { listId = `list${++listSeq}`; fake.lists[listId] = { preset }; }
      for (const paragraph of targets) {
        let tabs = 0;
        while (units[paragraph.from + tabs]?.ch === '\t' && units[paragraph.from + tabs].mark === 'text') tabs++;
        units.splice(paragraph.from, tabs);
        const newlineAt = paragraph.to - tabs;
        units[newlineAt].para!.bullet = { listId, nesting: tabs };
      }
      return;
    }
    throw new GoogleApiError(`Google Docs edit failed (HTTP 400 INVALID_ARGUMENT: unsupported request ${Object.keys(request)[0]})`, 400, 'INVALID_ARGUMENT');
  }

  const fake: FakeDocs = {
    docs,
    calls,
    fromMarkdown,
    failNext(error, options = {}) { pending = { error, afterEffect: Boolean(options.afterEffect) }; },
    touch(documentId) { doc(documentId).revision++; },
    pictures(documentId) { return doc(documentId).units.filter(unit => unit.mark === 'object' && unit.uri).map(unit => unit.uri!); },
    lines(documentId) {
      const fakeDoc = doc(documentId);
      const out: string[] = [];
      const units = fakeDoc.units;
      let inTable = false;
      let row = -1;
      let cell = -1;
      let text = '';
      for (const unit of units) {
        if (unit.mark === 'tableStart') { inTable = true; row = -1; continue; }
        if (unit.mark === 'tableEnd') { inTable = false; continue; }
        if (unit.mark === 'rowStart') { row++; cell = -1; continue; }
        if (unit.mark === 'cellStart') { cell++; continue; }
        if (unit.mark === 'newline') {
          if (inTable) out.push(`TABLE ${row},${cell}: ${text}`);
          else {
            const para = unit.para!;
            const bullet = para.bullet ? `${fakeDoc.lists[para.bullet.listId]?.preset === PRESET_ORDERED ? 'ol' : 'ul'}${para.bullet.nesting}:${para.bullet.listId}` : '';
            out.push(`${para.namedStyle}|${bullet}|${text}`);
          }
          text = '';
          continue;
        }
        text += unit.mark === 'object' ? '[image]' : unit.ch;
      }
      return out;
    },
    async get(documentId) {
      calls.push({ op: 'get', documentId });
      return serialize(doc(documentId));
    },
    async batchUpdate(documentId, requests, requiredRevisionId) {
      calls.push({ op: 'batchUpdate', documentId, requests });
      const fakeDoc = doc(documentId);
      if (pending && !pending.afterEffect) { const error = pending.error; pending = null; throw error; }
      if (requiredRevisionId && requiredRevisionId !== `rev-${fakeDoc.revision}`) {
        throw new GoogleApiError('Google Docs edit failed (HTTP 400 FAILED_PRECONDITION: The document was modified since the required revision.)', 400, 'FAILED_PRECONDITION');
      }
      const copy: FakeDoc = { ...fakeDoc, units: fakeDoc.units.map(unit => ({ ...unit, style: unit.style ? { ...unit.style } : undefined, para: unit.para ? { ...unit.para, bullet: unit.para.bullet ? { ...unit.para.bullet } : null } : undefined })), lists: { ...fakeDoc.lists } };
      for (const request of requests) apply(copy, request);
      copy.revision = fakeDoc.revision + 1;
      docs.set(documentId, copy);
      if (pending && pending.afterEffect) { const error = pending.error; pending = null; throw error; }
      return { replies: requests.map(() => ({})), writeControl: { requiredRevisionId: `rev-${copy.revision}` } };
    },
  };
  api = fake;
  return fake;
}
