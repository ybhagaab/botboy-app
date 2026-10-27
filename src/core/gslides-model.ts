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
  /** Where it sits on the slide, in points (absent when Google did not say). */
  box?: SlideBox;
}

/** A rectangle on a slide, in points from the top-left corner. */
export interface SlideBox { x: number; y: number; w: number; h: number }

export const EMU_PER_PT = 12_700;
/** Google's usual 16:9 slide, in points. */
export const DEFAULT_PAGE = Object.freeze({ w: 720, h: 405 });

function points(dimension: { magnitude?: number; unit?: string } | undefined): number {
  const value = Number(dimension?.magnitude ?? 0);
  return dimension?.unit === 'PT' ? value : value / EMU_PER_PT;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** An element's box from its size and transform (rotation and shear ignored; a mirrored element still covers its box). */
export function elementBox(element: SlidesPageElement): SlideBox | undefined {
  if (!element.size?.width || !element.size?.height) return undefined;
  const t = element.transform ?? {};
  const unit = t.unit === 'PT' ? 1 : 1 / EMU_PER_PT;
  const scaleX = Number(t.scaleX ?? 1);
  const scaleY = Number(t.scaleY ?? 1);
  const w = points(element.size.width) * Math.abs(scaleX);
  const h = points(element.size.height) * Math.abs(scaleY);
  const tx = Number(t.translateX ?? 0) * unit;
  const ty = Number(t.translateY ?? 0) * unit;
  return { x: round(scaleX < 0 ? tx - w : tx), y: round(scaleY < 0 ? ty - h : ty), w: round(w), h: round(h) };
}

/** The slide size in points (Google's 720×405 when the deck does not say). */
export function pageBox(presentation: Presentation): { w: number; h: number } {
  const w = points(presentation.pageSize?.width);
  const h = points(presentation.pageSize?.height);
  return w > 0 && h > 0 ? { w: round(w), h: round(h) } : { ...DEFAULT_PAGE };
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
  const box = elementBox(element);
  const at = box ? { box } : {};
  if (element.shape) {
    const placeholder = element.shape.placeholder?.type;
    const shapeType = String(element.shape.shapeType ?? '');
    return {
      objectId: element.objectId,
      kind: (placeholder && PLACEHOLDER_KIND[placeholder]) || (shapeType === 'TEXT_BOX' ? 'text box' : shapeType && shapeType !== 'RECTANGLE' ? `shape ${shapeType.toLowerCase()}` : 'shape'),
      text: textOf(element.shape.text?.textElements),
      textual: true,
      ...at,
    };
  }
  if (element.table) {
    const rows = (element.table.tableRows ?? []).map(row => (row.tableCells ?? []).map(cell => textOf(cell.text?.textElements).replace(/\n/g, ' ')).join(' | '));
    return { objectId: element.objectId, kind: `table ${element.table.rows ?? rows.length}x${element.table.columns ?? 0}`, text: rows.join(' ⏎ '), textual: false, ...at };
  }
  if (element.image) return { objectId: element.objectId, kind: 'image', text: '', textual: false, ...at };
  if (element.video) return { objectId: element.objectId, kind: 'video', text: '', textual: false, ...at };
  if (element.sheetsChart) return { objectId: element.objectId, kind: 'chart', text: '', textual: false, ...at };
  if (element.line) return { objectId: element.objectId, kind: 'line', text: '', textual: false, ...at };
  return { objectId: element.objectId, kind: 'object', text: '', textual: false, ...at };
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

/** "@x,y w×h" in points, or nothing when Google did not say. */
function placeOf(box: SlideBox | undefined): string {
  return box ? ` @${box.x},${box.y} ${box.w}×${box.h}` : '';
}

/** The deck as lines. */
export function slidesViewLines(slides: SlideView[]): string[] {
  const lines: string[] = [];
  for (const slide of slides) {
    lines.push(`Slide ${slide.number} (id ${slide.objectId}${slide.layout ? `, layout ${slide.layout}` : ''})`);
    for (const element of slide.elements) {
      const place = placeOf(element.box);
      lines.push(element.text || element.textual ? `  ${element.kind} [id ${element.objectId}]${place}: ${element.text.replace(/\n/g, '⏎')}` : `  [${element.kind} id ${element.objectId}]${place}`);
    }
    if (slide.notesId) lines.push(`  notes [id ${slide.notesId}]: ${slide.notesText.replace(/\n/g, '⏎')}`);
  }
  return lines;
}

// ── Edits ────────────────────────────────────────────────────────────────────

export const SLIDE_ACTIONS = ['replace_text', 'set_text', 'add_slide', 'delete_slide', 'move_slide', 'duplicate_slide', 'set_notes', 'add_image', 'add_shape', 'add_line', 'delete_element'] as const;
export type SlideAction = typeof SLIDE_ACTIONS[number];

/** Friendly shape names; any of Google's own ShapeType names (RECTANGLE, FLOW_CHART_DECISION, …) works too. */
const SHAPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  rectangle: 'RECTANGLE', rect: 'RECTANGLE', box: 'RECTANGLE', square: 'RECTANGLE',
  rounded: 'ROUND_RECTANGLE', rounded_rectangle: 'ROUND_RECTANGLE', round_rectangle: 'ROUND_RECTANGLE', pill: 'ROUND_RECTANGLE',
  ellipse: 'ELLIPSE', oval: 'ELLIPSE', circle: 'ELLIPSE',
  diamond: 'DIAMOND', decision: 'FLOW_CHART_DECISION', triangle: 'TRIANGLE',
  arrow: 'RIGHT_ARROW', right_arrow: 'RIGHT_ARROW', left_arrow: 'LEFT_ARROW', up_arrow: 'UP_ARROW', down_arrow: 'DOWN_ARROW',
  chevron: 'CHEVRON', pentagon: 'PENTAGON', hexagon: 'HEXAGON', octagon: 'OCTAGON', parallelogram: 'PARALLELOGRAM', trapezoid: 'TRAPEZOID',
  star: 'STAR_5', cloud: 'CLOUD', heart: 'HEART', plus: 'PLUS', cube: 'CUBE', cylinder: 'CAN', database: 'FLOW_CHART_MAGNETIC_DISK',
  callout: 'WEDGE_RECTANGLE_CALLOUT', text: 'TEXT_BOX', text_box: 'TEXT_BOX', textbox: 'TEXT_BOX',
  process: 'FLOW_CHART_PROCESS', terminator: 'FLOW_CHART_TERMINATOR', start_end: 'FLOW_CHART_TERMINATOR', document: 'FLOW_CHART_DOCUMENT',
  data: 'FLOW_CHART_INPUT_OUTPUT', input_output: 'FLOW_CHART_INPUT_OUTPUT', connector: 'FLOW_CHART_CONNECTOR',
});

const LINE_CATEGORY: Readonly<Record<string, string>> = Object.freeze({ straight: 'STRAIGHT', bent: 'BENT', elbow: 'BENT', curved: 'CURVED' });
const DASH_STYLE: Readonly<Record<string, string>> = Object.freeze({ solid: 'SOLID', dash: 'DASH', dashed: 'DASH', dot: 'DOT', dotted: 'DOT', dash_dot: 'DASH_DOT' });

/** "#1a73e8" as Google's rgbColor (0 to 1). */
export function rgbColorOf(value: unknown): { red: number; green: number; blue: number } | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].split('').map(ch => ch + ch).join('') : match[1];
  return { red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 };
}

/** A picture for add_image, readied by the tools layer: the address Google fetches and its natural size in pixels when known. */
export interface SlidePicture { url: string; width?: number; height?: number }

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
  summary: Array<{ edit: number; action: SlideAction; slide?: string; element?: string; found?: number; newSlideId?: string; newElementId?: string; ref?: string; box?: SlideBox }>;
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
export function planSlideEdits(
  presentation: Presentation,
  edits: readonly Record<string, unknown>[],
  random?: () => string,
  options: { pictures?: ReadonlyMap<number, SlidePicture> } = {},
): SlidePlan | SlidePlanFailure {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 50) return { ok: false, message: 'edits must be a list of 1 to 50 edits.' };
  const slides = slideViews(presentation);
  const page = pageBox(presentation);
  // The live order of slide ids as the plan goes, so positions in later edits mean what Google will see then.
  const order = slides.map(slide => slide.objectId);
  const byId = new Map(slides.map(slide => [slide.objectId, slide]));
  const deleted = new Set<string>();
  const requests: unknown[] = [];
  const summary: SlidePlan['summary'] = [];
  /** Elements by id (from the read) and by the ref an add_shape gave them in this call: where they sit and on which slide. */
  const placed = new Map<string, { id: string; slide: string; box?: SlideBox }>();
  for (const slide of slides) for (const element of slide.elements) placed.set(element.objectId, { id: element.objectId, slide: slide.objectId, ...(element.box ? { box: element.box } : {}) });
  const removedElements = new Set<string>();
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
    if (action === 'delete_element') {
      const elementId = typeof edit.element === 'string' ? edit.element.trim() : '';
      const target = placed.get(elementId);
      if (!elementId || !target || target.id !== elementId) return fail('element is required: an element id from the read (a slide is removed with delete_slide).');
      if (deleted.has(target.slide)) return fail('its slide is deleted earlier in this call.');
      if (removedElements.has(elementId)) return fail('that element is deleted earlier in this call.');
      requests.push({ deleteObject: { objectId: elementId } });
      removedElements.add(elementId);
      summary.push({ edit: index, action, slide: target.slide, element: elementId });
      continue;
    }
    if (action === 'add_image' || action === 'add_shape' || action === 'add_line') {
      const onSlide = slideOf(true);
      if (!('id' in onSlide)) return onSlide as SlidePlanFailure;
      const slideId = onSlide.id;
      const number = (field: string): number | undefined | null => {
        if (edit[field] === undefined || edit[field] === null || edit[field] === '') return undefined;
        const value = Number(edit[field]);
        return Number.isFinite(value) ? value : null;
      };
      const ref = typeof edit.ref === 'string' && edit.ref.trim() ? edit.ref.trim().slice(0, 40) : '';
      if (ref && placed.has(ref)) return fail(`ref "${ref}" is already an element or another ref in this call; give each new shape its own ref.`);

      if (action === 'add_line') {
        const endpoint = (field: 'start' | 'end'): { point: { x: number; y: number }; box?: SlideBox; element?: string } | SlidePlanFailure => {
          const value = edit[field];
          if (Array.isArray(value) && value.length === 2 && value.every(n => Number.isFinite(Number(n)))) return { point: { x: Number(value[0]), y: Number(value[1]) } };
          if (typeof value === 'string' && value.trim()) {
            const target = placed.get(value.trim());
            if (!target) return fail(`${field} "${value.slice(0, 60)}" is not an element id from the read or a ref given earlier in this call.`);
            if (target.slide !== slideId) return fail(`${field} is on another slide; a line joins elements on its own slide.`);
            if (!target.box) return fail(`${field}: BotBoy does not know where that element sits; give a point [x, y] instead.`);
            const box = target.box;
            return { point: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, box, element: target.id };
          }
          return fail(`${field} is a point [x, y] in points, or an element id or ref.`);
        };
        const start = endpoint('start');
        if ('ok' in start) return start;
        const end = endpoint('end');
        if ('ok' in end) return end;
        // Between boxes: from the facing sides' midpoints, so the line meets each shape's edge.
        let from = start.point;
        let to = end.point;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        const side = (box: SlideBox | undefined, point: { x: number; y: number }, toward: number): { x: number; y: number } => {
          if (!box) return point;
          return horizontal ? { x: toward >= 0 ? box.x + box.w : box.x, y: box.y + box.h / 2 } : { x: box.x + box.w / 2, y: toward >= 0 ? box.y + box.h : box.y };
        };
        from = side(start.box, from, horizontal ? dx : dy);
        to = side(end.box, to, horizontal ? -dx : -dy);
        if (from.x === to.x && from.y === to.y) return fail('start and end are the same point.');
        const category = LINE_CATEGORY[String(edit.line ?? 'straight').toLowerCase()];
        if (!category) return fail('line is straight, bent or curved.');
        const arrowName = String(edit.arrow ?? (start.element || end.element ? 'end' : 'none')).toLowerCase();
        if (!['none', 'end', 'start', 'both'].includes(arrowName)) return fail('arrow is none, end, start or both.');
        const color = edit.outline === undefined ? { red: 0.26, green: 0.26, blue: 0.26 } : rgbColorOf(edit.outline);
        if (!color) return fail('outline is the line colour, like "#444444".');
        const weight = number('weight');
        if (weight === null || (weight !== undefined && (weight <= 0 || weight > 20))) return fail('weight is the line width in points, more than 0 and at most 20.');
        const dash = DASH_STYLE[String(edit.dash ?? 'solid').toLowerCase()];
        if (!dash) return fail('dash is solid, dash, dot or dash_dot.');
        const lineId = newObjectId('l', random);
        const w = Math.abs(to.x - from.x);
        const h = Math.abs(to.y - from.y);
        // The line runs from the top-left of its box to the bottom-right; a negative scale mirrors it to run the other way.
        requests.push({
          createLine: {
            objectId: lineId,
            category,
            elementProperties: {
              pageObjectId: slideId,
              size: { width: { magnitude: Math.max(1, Math.round(w * EMU_PER_PT)), unit: 'EMU' }, height: { magnitude: Math.max(1, Math.round(h * EMU_PER_PT)), unit: 'EMU' } },
              transform: { scaleX: to.x >= from.x ? 1 : -1, scaleY: to.y >= from.y ? 1 : -1, translateX: Math.round(from.x * EMU_PER_PT), translateY: Math.round(from.y * EMU_PER_PT), unit: 'EMU' },
            },
          },
        });
        requests.push({
          updateLineProperties: {
            objectId: lineId,
            lineProperties: {
              lineFill: { solidFill: { color: { rgbColor: color } } },
              weight: { magnitude: weight ?? 1.5, unit: 'PT' },
              dashStyle: dash,
              startArrow: arrowName === 'start' || arrowName === 'both' ? 'FILL_ARROW' : 'NONE',
              endArrow: arrowName === 'end' || arrowName === 'both' ? 'FILL_ARROW' : 'NONE',
            },
            fields: 'lineFill.solidFill.color,weight,dashStyle,startArrow,endArrow',
          },
        });
        const lineBox = { x: round(Math.min(from.x, to.x)), y: round(Math.min(from.y, to.y)), w: round(w), h: round(h) };
        placed.set(lineId, { id: lineId, slide: slideId, box: lineBox });
        if (ref) placed.set(ref, { id: lineId, slide: slideId, box: lineBox });
        summary.push({ edit: index, action, slide: slideId, newElementId: lineId, ...(ref ? { ref } : {}), box: lineBox });
        continue;
      }

      // add_image and add_shape: a box on the slide, in points.
      const x = number('x');
      const y = number('y');
      const width = number('width');
      const height = number('height');
      if (x === null || y === null || width === null || height === null) return fail('x, y, width and height are numbers of points.');
      if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) return fail('width and height are more than 0 points.');
      let w: number;
      let h: number;
      let picture: SlidePicture | undefined;
      if (action === 'add_image') {
        picture = options.pictures?.get(index);
        if (!picture) return fail('image is required: {path}, {assetId}, {url}, {mermaid} or {svg}.');
        // Its natural size (pixels at 0.75 pt), kept inside 90% of the slide, unless asked otherwise.
        const natW = picture.width ? picture.width * 0.75 : page.w * 0.6;
        const natH = picture.height ? picture.height * 0.75 : page.h * 0.6;
        const fit = Math.min(1, (page.w * 0.9) / natW, (page.h * 0.9) / natH);
        w = width ?? (height !== undefined && picture.width && picture.height ? height * (picture.width / picture.height) : natW * fit);
        h = height ?? (width !== undefined && picture.width && picture.height ? width * (picture.height / picture.width) : natH * fit);
      } else {
        w = width ?? 200;
        h = height ?? 100;
      }
      const left = x ?? (page.w - w) / 2;
      const top = y ?? (page.h - h) / 2;
      if (left >= page.w || top >= page.h || left + w <= 0 || top + h <= 0) return fail(`the box is off the slide (the slide is ${page.w}×${page.h} points; x and y are from its top-left corner).`);
      const box = { x: round(left), y: round(top), w: round(w), h: round(h) };
      const elementProperties = {
        pageObjectId: slideId,
        size: { width: { magnitude: box.w, unit: 'PT' }, height: { magnitude: box.h, unit: 'PT' } },
        transform: { scaleX: 1, scaleY: 1, translateX: box.x, translateY: box.y, unit: 'PT' },
      };
      if (action === 'add_image') {
        const imageId = newObjectId('i', random);
        requests.push({ createImage: { objectId: imageId, url: picture!.url, elementProperties } });
        placed.set(imageId, { id: imageId, slide: slideId, box });
        if (ref) placed.set(ref, { id: imageId, slide: slideId, box });
        summary.push({ edit: index, action, slide: slideId, newElementId: imageId, ...(ref ? { ref } : {}), box });
        continue;
      }
      const shapeName = String(edit.shape ?? 'rectangle').trim();
      const shapeType = SHAPE_NAMES[shapeName.toLowerCase().replace(/[\s-]+/g, '_')] ?? (/^[A-Z][A-Z0-9_]{2,40}$/.test(shapeName) ? shapeName : null);
      if (!shapeType) return fail(`shape "${shapeName.slice(0, 40)}" is not one BotBoy knows; use rectangle, rounded, ellipse, diamond, triangle, arrow, process, decision, terminator, document, data, cylinder, cloud, star, text, or a Google shape name like FLOW_CHART_PREPARATION.`);
      const fill = edit.fill === undefined ? null : rgbColorOf(edit.fill);
      if (edit.fill !== undefined && !fill) return fail('fill is a colour like "#e8f0fe".');
      const noOutline = String(edit.outline ?? '').toLowerCase() === 'none';
      const outline = edit.outline === undefined || noOutline ? null : rgbColorOf(edit.outline);
      if (edit.outline !== undefined && !noOutline && !outline) return fail('outline is a colour like "#1a73e8", or "none".');
      const weight = number('weight');
      if (weight === null || (weight !== undefined && (weight <= 0 || weight > 20))) return fail('weight is the outline width in points, more than 0 and at most 20.');
      const textColor = edit.textColor === undefined ? null : rgbColorOf(edit.textColor);
      if (edit.textColor !== undefined && !textColor) return fail('textColor is a colour like "#202124".');
      const fontSize = number('fontSize');
      if (fontSize === null || (fontSize !== undefined && (fontSize < 4 || fontSize > 400))) return fail('fontSize is 4 to 400 points.');
      const align = edit.align === undefined ? (shapeType === 'TEXT_BOX' ? 'START' : 'CENTER') : ({ left: 'START', center: 'CENTER', centre: 'CENTER', right: 'END', justify: 'JUSTIFIED' } as Record<string, string>)[String(edit.align).toLowerCase()];
      if (!align) return fail('align is left, center, right or justify.');
      const shapeId = newObjectId('sh', random);
      requests.push({ createShape: { objectId: shapeId, shapeType, elementProperties } });
      const shapeProperties: Record<string, unknown> = {};
      const fields: string[] = [];
      if (fill) { shapeProperties.shapeBackgroundFill = { solidFill: { color: { rgbColor: fill } } }; fields.push('shapeBackgroundFill.solidFill.color'); }
      if (noOutline) { shapeProperties.outline = { propertyState: 'NOT_RENDERED' }; fields.push('outline.propertyState'); }
      else if (outline || weight !== undefined) {
        shapeProperties.outline = { ...(outline ? { outlineFill: { solidFill: { color: { rgbColor: outline } } } } : {}), ...(weight !== undefined ? { weight: { magnitude: weight, unit: 'PT' } } : {}) };
        if (outline) fields.push('outline.outlineFill.solidFill.color');
        if (weight !== undefined) fields.push('outline.weight');
      }
      if (shapeType !== 'TEXT_BOX') { shapeProperties.contentAlignment = 'MIDDLE'; fields.push('contentAlignment'); }
      if (fields.length) requests.push({ updateShapeProperties: { objectId: shapeId, shapeProperties, fields: fields.join(',') } });
      const text = typeof edit.text === 'string' ? plainText(edit.text) : '';
      if (text) {
        requests.push({ insertText: { objectId: shapeId, insertionIndex: 0, text } });
        const style: Record<string, unknown> = {};
        const styleFields: string[] = [];
        if (fontSize !== undefined) { style.fontSize = { magnitude: fontSize, unit: 'PT' }; styleFields.push('fontSize'); }
        if (edit.bold !== undefined) { style.bold = edit.bold === true; styleFields.push('bold'); }
        if (textColor) { style.foregroundColor = { opaqueColor: { rgbColor: textColor } }; styleFields.push('foregroundColor'); }
        if (styleFields.length) requests.push({ updateTextStyle: { objectId: shapeId, textRange: { type: 'ALL' }, style, fields: styleFields.join(',') } });
        requests.push({ updateParagraphStyle: { objectId: shapeId, textRange: { type: 'ALL' }, style: { alignment: align }, fields: 'alignment' } });
      }
      placed.set(shapeId, { id: shapeId, slide: slideId, box });
      if (ref) placed.set(ref, { id: shapeId, slide: slideId, box });
      summary.push({ edit: index, action, slide: slideId, newElementId: shapeId, ...(ref ? { ref } : {}), box });
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
