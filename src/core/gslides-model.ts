/**
 * Google Slides as BotBoy reads and edits them (google-workspace.md, "Slides").
 *
 * The read view is one line per slide heading and one per element under it:
 *   "Slide 2 (id g2a)" then "  title [id g2a_t]: Agenda", "  body [id g2a_b]: One⏎Two",
 *   "  table [id t1] 2x3: a | b | c ⏎ d | e | f", "  [image id i9]", "  notes [id n2]: …"
 * (a line break inside a text box shows as ⏎). Edits name slides by number or
 * id and elements by id, all from that read, and go in one atomic batchUpdate
 * that Google refuses if the deck changed since the read (requiredRevisionId).
 */

import { randomBytes } from 'crypto';
import type { Presentation, SlidesPage, SlidesPageElement, SlidesTextElement } from './google-workspace-api.js';

export interface SlideElementView {
  objectId: string;
  kind: string;
  text: string;
  /** Shapes and placeholders take text; tables and images do not (here). */
  textual: boolean;
}

export interface SlideView {
  number: number;
  objectId: string;
  layout?: string;
  elements: SlideElementView[];
  notesId?: string;
  notesText: string;
}

function textOf(elements: SlidesTextElement[] | undefined): string {
  return (elements ?? []).map(element => element.textRun?.content ?? element.autoText?.content ?? '').join('').replace(/\n$/, '');
}

function flatten(elements: SlidesPageElement[] | undefined): SlidesPageElement[] {
  const out: SlidesPageElement[] = [];
  for (const element of elements ?? []) {
    if (element.elementGroup) out.push(...flatten(element.elementGroup.children));
    else out.push(element);
  }
  return out;
}

const PLACEHOLDER_KIND: Readonly<Record<string, string>> = Object.freeze({
  TITLE: 'title', CENTERED_TITLE: 'title', SUBTITLE: 'subtitle', BODY: 'body', HEADER: 'header', FOOTER: 'footer', SLIDE_NUMBER: 'slide number', DATE_AND_TIME: 'date',
});

function elementView(element: SlidesPageElement): SlideElementView {
  if (element.shape) {
    const placeholder = element.shape.placeholder?.type;
    return {
      objectId: element.objectId,
      kind: (placeholder && PLACEHOLDER_KIND[placeholder]) || (element.shape.shapeType === 'TEXT_BOX' ? 'text box' : 'shape'),
      text: textOf(element.shape.text?.textElements),
      textual: true,
    };
  }
  if (element.table) {
    const rows = (element.table.tableRows ?? []).map(row => (row.tableCells ?? []).map(cell => textOf(cell.text?.textElements).replace(/\n/g, ' ')).join(' | '));
    return { objectId: element.objectId, kind: `table ${element.table.rows ?? rows.length}x${element.table.columns ?? 0}`, text: rows.join(' ⏎ '), textual: false };
  }
  if (element.image) return { objectId: element.objectId, kind: 'image', text: '', textual: false };
  if (element.video) return { objectId: element.objectId, kind: 'video', text: '', textual: false };
  if (element.sheetsChart) return { objectId: element.objectId, kind: 'chart', text: '', textual: false };
  if (element.line) return { objectId: element.objectId, kind: 'line', text: '', textual: false };
  return { objectId: element.objectId, kind: 'object', text: '', textual: false };
}

export function slideViews(presentation: Presentation): SlideView[] {
  const layouts = new Map((presentation.layouts ?? []).map(layout => [layout.objectId, layout.layoutProperties?.displayName ?? layout.layoutProperties?.name]));
  return (presentation.slides ?? []).map((slide: SlidesPage, i) => {
    const notesId = slide.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    const notesShape = notesId ? flatten(slide.slideProperties?.notesPage?.pageElements).find(element => element.objectId === notesId) : undefined;
    return {
      number: i + 1,
      objectId: slide.objectId,
      ...(slide.slideProperties?.layoutObjectId && layouts.get(slide.slideProperties.layoutObjectId) ? { layout: layouts.get(slide.slideProperties.layoutObjectId) } : {}),
      elements: flatten(slide.pageElements).map(elementView),
      ...(notesId ? { notesId } : {}),
      notesText: notesShape ? textOf(notesShape.shape?.text?.textElements) : '',
    };
  });
}

/** The deck as lines. */
export function slidesViewLines(slides: SlideView[]): string[] {
  const lines: string[] = [];
  for (const slide of slides) {
    lines.push(`Slide ${slide.number} (id ${slide.objectId}${slide.layout ? `, layout ${slide.layout}` : ''})`);
    for (const element of slide.elements) {
      lines.push(element.text || element.textual ? `  ${element.kind} [id ${element.objectId}]: ${element.text.replace(/\n/g, '⏎')}` : `  [${element.kind} id ${element.objectId}]`);
    }
    if (slide.notesId) lines.push(`  notes [id ${slide.notesId}]: ${slide.notesText.replace(/\n/g, '⏎')}`);
  }
  return lines;
}

// ── Edits ────────────────────────────────────────────────────────────────────

export const SLIDE_ACTIONS = ['replace_text', 'set_text', 'add_slide', 'delete_slide', 'move_slide', 'duplicate_slide', 'set_notes'] as const;
export type SlideAction = typeof SLIDE_ACTIONS[number];

/** Which placeholders a predefined layout has for a title and a body. */
const LAYOUT_PLACEHOLDERS: Readonly<Record<string, { title?: string; body?: string }>> = Object.freeze({
  TITLE: { title: 'CENTERED_TITLE', body: 'SUBTITLE' },
  TITLE_AND_BODY: { title: 'TITLE', body: 'BODY' },
  TITLE_AND_TWO_COLUMNS: { title: 'TITLE', body: 'BODY' },
  TITLE_ONLY: { title: 'TITLE' },
  SECTION_HEADER: { title: 'TITLE' },
  SECTION_TITLE_AND_DESCRIPTION: { title: 'TITLE', body: 'BODY' },
  ONE_COLUMN_TEXT: { title: 'TITLE', body: 'BODY' },
  MAIN_POINT: { title: 'TITLE' },
  BIG_NUMBER: { title: 'TITLE', body: 'BODY' },
  CAPTION_ONLY: { body: 'BODY' },
  BLANK: {},
});
export const SLIDE_LAYOUTS = Object.keys(LAYOUT_PLACEHOLDERS);

export interface SlidePlan {
  ok: true;
  requests: unknown[];
  summary: Array<{ edit: number; action: SlideAction; slide?: string; element?: string; found?: number; newSlideId?: string }>;
}

export interface SlidePlanFailure {
  ok: false;
  index?: number;
  message: string;
}

export function newObjectId(prefix: string, random: () => string = () => randomBytes(6).toString('hex')): string {
  return `botboy_${prefix}_${random()}`.slice(0, 50);
}

function plainText(value: unknown): string {
  return String(value ?? '').replace(/⏎/g, '\n').replace(/\r\n?/g, '\n');
}

/** Plan edits against the deck as read; slide numbers refer to that read. */
export function planSlideEdits(presentation: Presentation, edits: readonly Record<string, unknown>[], random?: () => string): SlidePlan | SlidePlanFailure {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 50) return { ok: false, message: 'edits must be a list of 1 to 50 edits.' };
  const slides = slideViews(presentation);
  // The live order of slide ids as the plan goes, so positions in later edits mean what Google will see then.
  const order = slides.map(slide => slide.objectId);
  const byId = new Map(slides.map(slide => [slide.objectId, slide]));
  const deleted = new Set<string>();
  const requests: unknown[] = [];
  const summary: SlidePlan['summary'] = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return { ok: false, index, message: `edits[${index}] must be an object with an action.` };
    const action = String(edit.action ?? '') as SlideAction;
    if (!SLIDE_ACTIONS.includes(action)) return { ok: false, index, message: `edits[${index}].action must be one of: ${SLIDE_ACTIONS.join(', ')}.` };
    const fail = (message: string): SlidePlanFailure => ({ ok: false, index, message: `edits[${index}] (${action}): ${message}` });
    /** A slide by its number in the read (1 = first) or its id. */
    const slideOf = (required: boolean): { id: string } | { none: true } | SlidePlanFailure => {
      const raw = edit.slide;
      if (raw === undefined || raw === null || raw === '') return required ? fail('slide is required (its number or id from the read).') : { none: true };
      let id: string | undefined;
      if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > slides.length) return fail(`slide ${raw} does not exist; the deck had ${slides.length} slides when read.`);
        id = slides[n - 1].objectId;
      } else {
        id = String(raw).trim();
        if (!byId.has(id) && !order.includes(id)) return fail(`no slide with id "${id.slice(0, 60)}".`);
      }
      if (deleted.has(id)) return fail('that slide is deleted earlier in this call.');
      return { id };
    };
    if (action === 'replace_text') {
      const find = typeof edit.find === 'string' ? edit.find : '';
      const replace = typeof edit.replace === 'string' ? edit.replace : null;
      if (!find || replace === null) return fail('find (exact text from the read) and replace are required.');
      const scope = slideOf(false);
      if ('ok' in scope) return scope;
      const ids = 'id' in scope ? [scope.id] : [...order];
      const findText = plainText(find);
      let found = 0;
      for (const id of ids) {
        for (const element of byId.get(id)?.elements ?? []) {
          let at = element.text.indexOf(findText);
          while (at >= 0) { found++; at = element.text.indexOf(findText, at + findText.length); }
        }
      }
      if (!found) return fail(`"${find.slice(0, 80)}" does not occur ${'id' in scope ? 'on that slide' : 'in the deck'} as read (copy it from gdrive_read; ⏎ is a line break).`);
      requests.push({ replaceAllText: { containsText: { text: findText, matchCase: true }, replaceText: plainText(replace), ...('id' in scope ? { pageObjectIds: [scope.id] } : {}) } });
      summary.push({ edit: index, action, ...('id' in scope ? { slide: scope.id } : {}), found });
      continue;
    }
    if (action === 'set_text') {
      const elementId = typeof edit.element === 'string' ? edit.element.trim() : '';
      if (!elementId) return fail('element is required (an element id from the read).');
      const owner = slides.find(slide => slide.elements.some(element => element.objectId === elementId));
      const element = owner?.elements.find(entry => entry.objectId === elementId);
      if (!element || !owner) return fail(`no element with id "${elementId.slice(0, 60)}" on the slides as read.`);
      if (deleted.has(owner.objectId)) return fail('its slide is deleted earlier in this call.');
      if (!element.textual) return fail(`element ${elementId} is a ${element.kind}, which has no text box to set; use replace_text for text inside a table.`);
      if (typeof edit.text !== 'string') return fail('text is required (the element’s whole new text; ⏎ or a newline starts a new line).');
      if (element.text) requests.push({ deleteText: { objectId: elementId, textRange: { type: 'ALL' } } });
      const text = plainText(edit.text);
      if (text) requests.push({ insertText: { objectId: elementId, insertionIndex: 0, text } });
      summary.push({ edit: index, action, slide: owner.objectId, element: elementId });
      continue;
    }
    if (action === 'set_notes') {
      const picked = slideOf(true);
      if (!('id' in picked)) return picked as SlidePlanFailure;
      const slide = byId.get(picked.id);
      if (!slide?.notesId) return fail('that slide has no speaker notes box BotBoy can see (a slide added in this call gets one; set its notes in a second call).');
      if (typeof edit.text !== 'string') return fail('text is required (the whole new speaker notes).');
      if (slide.notesText) requests.push({ deleteText: { objectId: slide.notesId, textRange: { type: 'ALL' } } });
      const text = plainText(edit.text);
      if (text) requests.push({ insertText: { objectId: slide.notesId, insertionIndex: 0, text } });
      summary.push({ edit: index, action, slide: picked.id, element: slide.notesId });
      continue;
    }
    if (action === 'add_slide') {
      const layout = String(edit.layout ?? 'TITLE_AND_BODY').toUpperCase();
      const holders = LAYOUT_PLACEHOLDERS[layout];
      if (!holders) return fail(`layout is one of: ${SLIDE_LAYOUTS.join(', ')}.`);
      const title = typeof edit.title === 'string' ? plainText(edit.title) : '';
      const body = typeof edit.body === 'string' ? plainText(edit.body) : '';
      if (title && !holders.title) return fail(`layout ${layout} has no title box; use TITLE_AND_BODY or TITLE_ONLY.`);
      if (body && !holders.body) return fail(`layout ${layout} has no body box; use TITLE_AND_BODY.`);
      const at = edit.at === undefined ? order.length + 1 : Number(edit.at);
      if (!Number.isInteger(at) || at < 1 || at > order.length + 1) return fail(`at is the new slide’s position, 1 to ${order.length + 1}.`);
      const slideId = newObjectId('s', random);
      const titleId = title ? newObjectId('t', random) : null;
      const bodyId = body ? newObjectId('b', random) : null;
      requests.push({
        createSlide: {
          objectId: slideId,
          insertionIndex: at - 1,
          slideLayoutReference: { predefinedLayout: layout },
          ...(titleId || bodyId ? {
            placeholderIdMappings: [
              ...(titleId ? [{ layoutPlaceholder: { type: holders.title, index: 0 }, objectId: titleId }] : []),
              ...(bodyId ? [{ layoutPlaceholder: { type: holders.body, index: 0 }, objectId: bodyId }] : []),
            ],
          } : {}),
        },
      });
      if (titleId) requests.push({ insertText: { objectId: titleId, insertionIndex: 0, text: title } });
      if (bodyId) requests.push({ insertText: { objectId: bodyId, insertionIndex: 0, text: body } });
      order.splice(at - 1, 0, slideId);
      summary.push({ edit: index, action, newSlideId: slideId });
      continue;
    }
    const picked = slideOf(true);
    if (!('id' in picked)) return picked as SlidePlanFailure;
    if (action === 'delete_slide') {
      if (order.length <= 1) return fail('a deck keeps at least one slide.');
      requests.push({ deleteObject: { objectId: picked.id } });
      deleted.add(picked.id);
      order.splice(order.indexOf(picked.id), 1);
      summary.push({ edit: index, action, slide: picked.id });
      continue;
    }
    if (action === 'duplicate_slide') {
      const copyId = newObjectId('s', random);
      requests.push({ duplicateObject: { objectId: picked.id, objectIds: { [picked.id]: copyId } } });
      order.splice(order.indexOf(picked.id) + 1, 0, copyId);
      summary.push({ edit: index, action, slide: picked.id, newSlideId: copyId });
      continue;
    }
    // move_slide
    const to = Number(edit.to);
    if (!Number.isInteger(to) || to < 1 || to > order.length) return fail(`to is the slide’s new position, 1 to ${order.length}.`);
    const from = order.indexOf(picked.id) + 1;
    // Google counts the insertion index in the order before the move.
    requests.push({ updateSlidesPosition: { slideObjectIds: [picked.id], insertionIndex: to > from ? to : to - 1 } });
    order.splice(from - 1, 1);
    order.splice(to - 1, 0, picked.id);
    summary.push({ edit: index, action, slide: picked.id });
  }
  return { ok: true, requests, summary };
}

/** Slides from a Markdown outline: "# Title" starts a slide; its other lines are the body (a lone first "#" line is a title slide). */
export function outlineToSlides(markdown: string): Array<{ layout: string; title: string; body: string }> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = raw.match(/^#{1,2}\s+(.*)$/);
    if (heading) { sections.push({ title: heading[1].trim(), lines: [] }); continue; }
    if (!sections.length) { if (raw.trim()) sections.push({ title: '', lines: [raw] }); continue; }
    sections[sections.length - 1].lines.push(raw);
  }
  return sections.map((section, i) => {
    const body = section.lines.join('\n').replace(/^\n+|\n+$/g, '').split('\n').map(line => line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '')).join('\n').trim();
    if (i === 0 && !body && section.title) return { layout: 'TITLE', title: section.title, body: '' };
    if (!section.title) return { layout: 'CAPTION_ONLY', title: '', body };
    return { layout: body ? 'TITLE_AND_BODY' : 'TITLE_ONLY', title: section.title, body };
  });
}
