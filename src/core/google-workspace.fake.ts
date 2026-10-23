/**
 * In-memory Google Sheets, Slides, Forms and Calendar for tests
 * (google-workspace.md), wired to a fake Drive so a file made in one shows in
 * the other: a Doc uploaded as Markdown becomes a fake Docs document, a Sheet
 * from CSV a fake spreadsheet, a blank deck a fake presentation, and a form
 * made by the Forms API a Drive file. Docs live in gdocs.fake.ts.
 */

import { GoogleApiError } from './gmail-api.js';
import { GDRIVE_DOC_MIME, GDRIVE_FORM_MIME, GDRIVE_SHEET_MIME, GDRIVE_SLIDES_MIME } from './gdrive-api.js';
import type { FakeDrive, FakeDriveFile } from './gdrive-api.fake.js';
import { createFakeDocs, type FakeDocs } from './gdocs.fake.js';
import { a1Of, indexToCol, parseA1 } from './gsheets-model.js';
import type {
  CalendarClient,
  CalendarEvent,
  FormItem,
  FormResponse,
  FormsClient,
  GoogleForm,
  GoogleWorkspaceClients,
  Presentation,
  SheetsClient,
  SlidesClient,
} from './google-workspace-api.js';

// ── Sheets ───────────────────────────────────────────────────────────────────

interface FakeTab { sheetId: number; title: string; rows: number; cols: number; frozenRows: number; frozenCols: number; cells: Map<string, { typed: unknown; shown: string }>; formats: unknown[] }
export interface FakeSheets extends SheetsClient {
  books: Map<string, { title: string; tabs: FakeTab[] }>;
  create(id: string, title: string, rows?: unknown[][]): void;
  cell(id: string, tab: string, a1: string): { typed: unknown; shown: string } | undefined;
  calls: Array<{ op: string; args: unknown[] }>;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function createFakeSheets(): FakeSheets {
  const books = new Map<string, { title: string; tabs: FakeTab[] }>();
  const calls: FakeSheets['calls'] = [];
  let nextSheetId = 100;
  const book = (id: string) => {
    const found = books.get(id);
    if (!found) throw new GoogleApiError('Google Sheets read failed (HTTP 404 NOT_FOUND)', 404, 'NOT_FOUND');
    return found;
  };
  const tabOf = (id: string, range: string) => {
    const parsed = parseA1(range);
    const entry = book(id);
    const tab = parsed?.sheet ? entry.tabs.find(t => t.title === parsed.sheet) : entry.tabs[0];
    if (!tab || !parsed) throw new GoogleApiError(`Google Sheets failed (HTTP 400 INVALID_ARGUMENT: Unable to parse range: ${range})`, 400, 'INVALID_ARGUMENT');
    return { tab, parsed };
  };
  const shownOf = (value: unknown): string => (typeof value === 'string' && value.startsWith('=') ? `#${value.slice(1)}` : value === null || value === undefined ? '' : String(value));
  const typedOf = (value: unknown, input: string): unknown => {
    if (input === 'USER_ENTERED' && typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    return value;
  };
  const write = (tab: FakeTab, r0: number, c0: number, values: unknown[][], input: string, fit: 'grow' | 'rows' | 'none' = 'grow') => {
    // Like Google: a values write must fit the grid; append adds rows (not columns); an import sizes the grid.
    const needRows = r0 + values.length;
    const needCols = c0 + Math.max(...values.map(row => row.length));
    if ((fit === 'none' && needRows > tab.rows) || (fit !== 'grow' && needCols > tab.cols)) {
      throw new GoogleApiError(`Google Sheets edit failed (HTTP 400 INVALID_ARGUMENT: Range ('${tab.title}'!${indexToCol(c0)}${r0 + 1}) exceeds grid limits. Max rows: ${tab.rows}, max columns: ${tab.cols})`, 400, 'INVALID_ARGUMENT');
    }
    let n = 0;
    values.forEach((row, r) => row.forEach((value, c) => {
      const key = `${r0 + r},${c0 + c}`;
      if (value === null || value === '') tab.cells.delete(key);
      else tab.cells.set(key, { typed: typedOf(value, input), shown: shownOf(typedOf(value, input)) });
      n++;
    }));
    tab.rows = Math.max(tab.rows, r0 + values.length);
    tab.cols = Math.max(tab.cols, c0 + Math.max(...values.map(row => row.length)));
    return n;
  };
  const read = (tab: FakeTab, parsed: ReturnType<typeof parseA1>, render: string) => {
    const r0 = parsed?.startRow ?? 0;
    const c0 = parsed?.startCol ?? 0;
    const r1 = Math.min(parsed?.endRow ?? tab.rows, tab.rows);
    const c1 = Math.min(parsed?.endCol ?? tab.cols, tab.cols);
    const rows: unknown[][] = [];
    for (let r = r0; r < r1; r++) {
      const row: unknown[] = [];
      for (let c = c0; c < c1; c++) {
        const cell = tab.cells.get(`${r},${c}`);
        row.push(cell ? (render === 'FORMULA' ? cell.typed : cell.shown) : '');
      }
      while (row.length && row[row.length - 1] === '') row.pop();
      rows.push(row);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    return rows;
  };
  const fake: FakeSheets = {
    books,
    calls,
    create(id, title, rows = []) {
      const tab: FakeTab = { sheetId: 0, title: 'Sheet1', rows: Math.max(rows.length, 1000), cols: 26, frozenRows: 0, frozenCols: 0, cells: new Map(), formats: [] };
      books.set(id, { title, tabs: [tab] });
      if (rows.length) write(tab, 0, 0, rows, 'USER_ENTERED');
    },
    cell(id, tab, a1) {
      const parsed = parseA1(a1)!;
      return book(id).tabs.find(t => t.title === tab)?.cells.get(`${parsed.startRow},${parsed.startCol}`);
    },
    async get(id) {
      calls.push({ op: 'get', args: [id] });
      const entry = book(id);
      return { spreadsheetId: id, properties: { title: entry.title }, sheets: entry.tabs.map((tab, index) => ({ properties: { sheetId: tab.sheetId, title: tab.title, index, gridProperties: { rowCount: tab.rows, columnCount: tab.cols, frozenRowCount: tab.frozenRows, frozenColumnCount: tab.frozenCols } } })) };
    },
    async valuesBatchGet(id, ranges, render) {
      calls.push({ op: 'valuesBatchGet', args: [id, ranges, render] });
      return { valueRanges: ranges.map(range => { const { tab, parsed } = tabOf(id, range); return { range, values: read(tab, parsed, render) }; }) };
    },
    async valuesBatchUpdate(id, data, input) {
      calls.push({ op: 'valuesBatchUpdate', args: [id, data, input] });
      let total = 0;
      const responses = data.map((entry) => {
        const { tab, parsed } = tabOf(id, entry.range);
        const n = write(tab, parsed.startRow ?? 0, parsed.startCol ?? 0, entry.values, input, 'none');
        total += n;
        return { updatedRange: entry.range, updatedCells: n };
      });
      return { totalUpdatedCells: total, responses };
    },
    async valuesAppend(id, range, values, input) {
      calls.push({ op: 'valuesAppend', args: [id, range, values, input] });
      const { tab } = tabOf(id, range);
      let last = -1;
      for (const key of tab.cells.keys()) last = Math.max(last, Number(key.split(',')[0]));
      const n = write(tab, last + 1, 0, values, input, 'rows');
      return { updates: { updatedRange: a1Of(tab.title, { startRow: last + 1, startCol: 0, endRow: last + 1 + values.length, endCol: Math.max(...values.map(row => row.length)) }), updatedRows: values.length, updatedCells: n } };
    },
    async valuesBatchClear(id, ranges) {
      calls.push({ op: 'valuesBatchClear', args: [id, ranges] });
      for (const range of ranges) {
        const { tab, parsed } = tabOf(id, range);
        for (const key of [...tab.cells.keys()]) {
          const [r, c] = key.split(',').map(Number);
          if (r >= (parsed.startRow ?? 0) && r < (parsed.endRow ?? Infinity) && c >= (parsed.startCol ?? 0) && c < (parsed.endCol ?? Infinity)) tab.cells.delete(key);
        }
      }
      return { clearedRanges: ranges };
    },
    async batchUpdate(id, requests) {
      calls.push({ op: 'batchUpdate', args: [id, requests] });
      const entry = book(id);
      const copy = entry.tabs.map(tab => ({ ...tab, cells: new Map(tab.cells), formats: [...tab.formats] }));
      const byId = (sheetId: number) => {
        const tab = copy.find(t => t.sheetId === sheetId);
        if (!tab) throw new GoogleApiError(`Google Sheets edit failed (HTTP 400 INVALID_ARGUMENT: No grid with id: ${sheetId})`, 400, 'INVALID_ARGUMENT');
        return tab;
      };
      for (const request of requests as any[]) {
        if (request.addSheet) {
          const title = request.addSheet.properties.title;
          if (copy.some(t => t.title === title)) throw new GoogleApiError(`Google Sheets edit failed (HTTP 400 INVALID_ARGUMENT: A sheet with the name "${title}" already exists.)`, 400, 'INVALID_ARGUMENT');
          copy.push({ sheetId: nextSheetId++, title, rows: request.addSheet.properties.gridProperties?.rowCount ?? 1000, cols: request.addSheet.properties.gridProperties?.columnCount ?? 26, frozenRows: 0, frozenCols: 0, cells: new Map(), formats: [] });
        } else if (request.updateSheetProperties) {
          const props = request.updateSheetProperties.properties;
          const tab = byId(props.sheetId);
          if (props.title) tab.title = props.title;
          if (props.gridProperties?.frozenRowCount !== undefined) tab.frozenRows = props.gridProperties.frozenRowCount;
          if (props.gridProperties?.frozenColumnCount !== undefined) tab.frozenCols = props.gridProperties.frozenColumnCount;
        } else if (request.deleteSheet) {
          copy.splice(copy.indexOf(byId(request.deleteSheet.sheetId)), 1);
        } else if (request.insertDimension || request.deleteDimension) {
          const range = (request.insertDimension ?? request.deleteDimension).range;
          const tab = byId(range.sheetId);
          const count = range.endIndex - range.startIndex;
          const rows = range.dimension === 'ROWS';
          const shifted = new Map<string, { typed: unknown; shown: string }>();
          for (const [key, value] of tab.cells) {
            let [r, c] = key.split(',').map(Number);
            const at = rows ? r : c;
            if (request.deleteDimension && at >= range.startIndex && at < range.endIndex) continue;
            if (at >= range.startIndex) {
              if (rows) r += request.insertDimension ? count : -count;
              else c += request.insertDimension ? count : -count;
            }
            shifted.set(`${r},${c}`, value);
          }
          tab.cells = shifted;
        } else if (request.appendDimension) {
          const tab = byId(request.appendDimension.sheetId);
          if (request.appendDimension.dimension === 'ROWS') tab.rows += request.appendDimension.length;
          else tab.cols += request.appendDimension.length;
        } else if (request.repeatCell) {
          byId(request.repeatCell.range.sheetId).formats.push(request.repeatCell);
        } else {
          throw new GoogleApiError(`Google Sheets edit failed (HTTP 400 INVALID_ARGUMENT: unsupported ${Object.keys(request)[0]})`, 400, 'INVALID_ARGUMENT');
        }
      }
      entry.tabs = copy;
      return { replies: requests.map(() => ({})) };
    },
  };
  return fake;
}

// ── Slides ───────────────────────────────────────────────────────────────────

interface FakeElement { objectId: string; placeholder?: string; text: string; kind?: 'shape' | 'image' }
interface FakeSlide { objectId: string; layout: string; elements: FakeElement[]; notesId: string; notesText: string }
export interface FakeSlides extends SlidesClient {
  decks: Map<string, { title: string; revision: number; slides: FakeSlide[] }>;
  addBlank(id: string, title: string): void;
  calls: Array<{ op: string; args: unknown[] }>;
  touch(id: string): void;
}

const LAYOUT_HOLDERS: Record<string, string[]> = {
  TITLE: ['CENTERED_TITLE', 'SUBTITLE'], TITLE_AND_BODY: ['TITLE', 'BODY'], TITLE_ONLY: ['TITLE'], SECTION_HEADER: ['TITLE'], BLANK: [], CAPTION_ONLY: ['BODY'],
  TITLE_AND_TWO_COLUMNS: ['TITLE', 'BODY', 'BODY'], ONE_COLUMN_TEXT: ['TITLE', 'BODY'], MAIN_POINT: ['TITLE'], BIG_NUMBER: ['TITLE', 'BODY'], SECTION_TITLE_AND_DESCRIPTION: ['TITLE', 'SUBTITLE', 'BODY'],
};

export function createFakeSlides(): FakeSlides {
  const decks = new Map<string, { title: string; revision: number; slides: FakeSlide[] }>();
  const calls: FakeSlides['calls'] = [];
  let seq = 0;
  const deck = (id: string) => {
    const found = decks.get(id);
    if (!found) throw new GoogleApiError('Google Slides read failed (HTTP 404 NOT_FOUND)', 404, 'NOT_FOUND');
    return found;
  };
  const slideFor = (layout: string, objectId: string, mappings: Array<{ layoutPlaceholder: { type: string }; objectId: string }> = []): FakeSlide => {
    const holders = LAYOUT_HOLDERS[layout];
    if (!holders) throw new GoogleApiError(`Google Slides edit failed (HTTP 400 INVALID_ARGUMENT: unknown layout ${layout})`, 400, 'INVALID_ARGUMENT');
    for (const mapping of mappings) {
      if (!holders.includes(mapping.layoutPlaceholder.type)) throw new GoogleApiError(`Google Slides edit failed (HTTP 400 INVALID_ARGUMENT: The layout placeholder ${mapping.layoutPlaceholder.type} does not exist.)`, 400, 'INVALID_ARGUMENT');
    }
    return {
      objectId,
      layout,
      elements: holders.map((type, i) => ({ objectId: mappings.find(m => m.layoutPlaceholder.type === type)?.objectId ?? `${objectId}_e${i}`, placeholder: type, text: '' })),
      notesId: `${objectId}_notes`,
      notesText: '',
    };
  };
  const serialize = (id: string): Presentation => {
    const entry = deck(id);
    const textElements = (text: string) => (text ? [{ textRun: { content: `${text}\n` } }] : []);
    return {
      presentationId: id,
      title: entry.title,
      revisionId: `srev-${entry.revision}`,
      slides: entry.slides.map(slide => ({
        objectId: slide.objectId,
        pageElements: slide.elements.map(element => (element.kind === 'image'
          ? { objectId: element.objectId, image: {} }
          : { objectId: element.objectId, shape: { shapeType: 'TEXT_BOX', ...(element.placeholder ? { placeholder: { type: element.placeholder } } : {}), text: { textElements: textElements(element.text) } } })),
        slideProperties: {
          layoutObjectId: `layout_${slide.layout}`,
          notesPage: { notesProperties: { speakerNotesObjectId: slide.notesId }, pageElements: [{ objectId: slide.notesId, shape: { shapeType: 'TEXT_BOX', text: { textElements: textElements(slide.notesText) } } }] },
        },
      })),
      layouts: Object.keys(LAYOUT_HOLDERS).map(name => ({ objectId: `layout_${name}`, layoutProperties: { name, displayName: name.toLowerCase().replace(/_/g, ' ') } })),
    };
  };
  const fake: FakeSlides = {
    decks,
    calls,
    touch(id) { deck(id).revision++; },
    addBlank(id, title) {
      decks.set(id, { title, revision: 1, slides: [slideFor('TITLE', `p${++seq}`)] });
    },
    async get(id) {
      calls.push({ op: 'get', args: [id] });
      return serialize(id);
    },
    async create(title) {
      const id = `deck${++seq}xxxxxx`;
      fake.addBlank(id, title);
      return serialize(id);
    },
    async batchUpdate(id, requests, requiredRevisionId) {
      calls.push({ op: 'batchUpdate', args: [id, requests, requiredRevisionId] });
      const entry = deck(id);
      if (requiredRevisionId && requiredRevisionId !== `srev-${entry.revision}`) throw new GoogleApiError('Google Slides edit failed (HTTP 400 FAILED_PRECONDITION: revision)', 400, 'FAILED_PRECONDITION');
      const slides: FakeSlide[] = JSON.parse(JSON.stringify(entry.slides));
      const element = (objectId: string) => {
        for (const slide of slides) {
          if (slide.notesId === objectId) return { get text() { return slide.notesText; }, set text(v: string) { slide.notesText = v; } };
          const found = slide.elements.find(e => e.objectId === objectId);
          if (found) return found;
        }
        throw new GoogleApiError(`Google Slides edit failed (HTTP 400 INVALID_ARGUMENT: object ${objectId} not found)`, 400, 'INVALID_ARGUMENT');
      };
      const replies: any[] = [];
      for (const request of requests as any[]) {
        if (request.replaceAllText) {
          const { containsText, replaceText, pageObjectIds } = request.replaceAllText;
          let count = 0;
          for (const slide of slides) {
            if (pageObjectIds && !pageObjectIds.includes(slide.objectId)) continue;
            for (const el of slide.elements) {
              const parts = el.text.split(containsText.text);
              count += parts.length - 1;
              el.text = parts.join(replaceText);
            }
          }
          replies.push({ replaceAllText: { occurrencesChanged: count } });
        } else if (request.deleteText) {
          element(request.deleteText.objectId).text = '';
          replies.push({});
        } else if (request.insertText) {
          const el = element(request.insertText.objectId);
          el.text = el.text.slice(0, request.insertText.insertionIndex) + request.insertText.text + el.text.slice(request.insertText.insertionIndex);
          replies.push({});
        } else if (request.createSlide) {
          const { objectId, insertionIndex, slideLayoutReference, placeholderIdMappings } = request.createSlide;
          slides.splice(insertionIndex ?? slides.length, 0, slideFor(slideLayoutReference.predefinedLayout, objectId, placeholderIdMappings));
          replies.push({ createSlide: { objectId } });
        } else if (request.deleteObject) {
          const at = slides.findIndex(slide => slide.objectId === request.deleteObject.objectId);
          if (at < 0) throw new GoogleApiError('Google Slides edit failed (HTTP 400 INVALID_ARGUMENT: not found)', 400, 'INVALID_ARGUMENT');
          slides.splice(at, 1);
          replies.push({});
        } else if (request.updateSlidesPosition) {
          const [moving] = request.updateSlidesPosition.slideObjectIds;
          const from = slides.findIndex(slide => slide.objectId === moving);
          const [slide] = slides.splice(from, 1);
          const insertion = request.updateSlidesPosition.insertionIndex;
          slides.splice(insertion > from ? insertion - 1 : insertion, 0, slide);
          replies.push({});
        } else if (request.duplicateObject) {
          const from = slides.findIndex(slide => slide.objectId === request.duplicateObject.objectId);
          const copyId = request.duplicateObject.objectIds?.[request.duplicateObject.objectId] ?? `${request.duplicateObject.objectId}_copy`;
          const copy: FakeSlide = { ...JSON.parse(JSON.stringify(slides[from])), objectId: copyId };
          copy.elements = copy.elements.map((el, i) => ({ ...el, objectId: `${copyId}_e${i}` }));
          copy.notesId = `${copyId}_notes`;
          slides.splice(from + 1, 0, copy);
          replies.push({ duplicateObject: { objectId: copyId } });
        } else {
          throw new GoogleApiError(`Google Slides edit failed (HTTP 400 INVALID_ARGUMENT: unsupported ${Object.keys(request)[0]})`, 400, 'INVALID_ARGUMENT');
        }
      }
      entry.slides = slides;
      entry.revision++;
      return { replies, writeControl: { requiredRevisionId: `srev-${entry.revision}` } };
    },
  };
  return fake;
}

// ── Forms ────────────────────────────────────────────────────────────────────

export interface FakeForms extends FormsClient {
  forms: Map<string, GoogleForm & { revision: number }>;
  responses: Map<string, FormResponse[]>;
  calls: Array<{ op: string; args: unknown[] }>;
}

export function createFakeForms(drive?: FakeDrive): FakeForms {
  const forms = new Map<string, GoogleForm & { revision: number }>();
  const responses = new Map<string, FormResponse[]>();
  const calls: FakeForms['calls'] = [];
  let seq = 0;
  const form = (id: string) => {
    const found = forms.get(id);
    if (!found) throw new GoogleApiError('Google Forms read failed (HTTP 404 NOT_FOUND)', 404, 'NOT_FOUND');
    return found;
  };
  const view = (entry: GoogleForm & { revision: number }): GoogleForm => {
    const { revision, ...rest } = entry;
    return { ...JSON.parse(JSON.stringify(rest)), revisionId: `frev-${revision}` };
  };
  return {
    forms,
    responses,
    calls,
    async create(input) {
      calls.push({ op: 'create', args: [input] });
      const formId = `form${++seq}xxxxxxxx`;
      forms.set(formId, { formId, info: { title: input.title, documentTitle: input.documentTitle ?? input.title }, items: [], revision: 1, responderUri: `https://docs.example/forms/d/e/${formId}/viewform`, publishSettings: { publishState: { isPublished: false, isAcceptingResponses: false } } });
      drive?.put({ id: formId, name: input.documentTitle ?? input.title, mimeType: GDRIVE_FORM_MIME });
      return view(forms.get(formId)!);
    },
    async get(id) {
      calls.push({ op: 'get', args: [id] });
      return view(form(id));
    },
    async batchUpdate(id, requests, requiredRevisionId) {
      calls.push({ op: 'batchUpdate', args: [id, requests, requiredRevisionId] });
      const entry = form(id);
      if (requiredRevisionId && requiredRevisionId !== `frev-${entry.revision}`) throw new GoogleApiError('Google Forms edit failed (HTTP 400 FAILED_PRECONDITION: revision)', 400, 'FAILED_PRECONDITION');
      const items: FormItem[] = JSON.parse(JSON.stringify(entry.items ?? []));
      const info = { ...entry.info };
      for (const request of requests as any[]) {
        if (request.updateFormInfo) Object.assign(info, request.updateFormInfo.info);
        else if (request.createItem) {
          const item = { ...request.createItem.item, itemId: `it${++seq}` };
          if (item.questionItem?.question) item.questionItem.question.questionId = `q${seq}`;
          items.splice(request.createItem.location.index, 0, item);
        } else if (request.updateItem) {
          const at = request.updateItem.location.index;
          if (!items[at] || items[at].itemId !== request.updateItem.item.itemId) throw new GoogleApiError('Google Forms edit failed (HTTP 400 INVALID_ARGUMENT: item mismatch)', 400, 'INVALID_ARGUMENT');
          items[at] = { ...request.updateItem.item };
        } else if (request.deleteItem) items.splice(request.deleteItem.location.index, 1);
        else if (request.moveItem) {
          const [item] = items.splice(request.moveItem.originalLocation.index, 1);
          items.splice(request.moveItem.newLocation.index, 0, item);
        } else throw new GoogleApiError(`Google Forms edit failed (HTTP 400 INVALID_ARGUMENT: unsupported ${Object.keys(request)[0]})`, 400, 'INVALID_ARGUMENT');
      }
      entry.items = items;
      entry.info = info;
      entry.revision++;
      return { replies: [], writeControl: { requiredRevisionId: `frev-${entry.revision}` } };
    },
    async setPublishState(id, state) {
      calls.push({ op: 'setPublishState', args: [id, state] });
      const entry = form(id);
      entry.publishSettings = { publishState: { ...state } };
      return entry.publishSettings;
    },
    async listResponses(id) {
      calls.push({ op: 'listResponses', args: [id] });
      form(id);
      return { responses: responses.get(id) ?? [] };
    },
  };
}

// ── Calendar ─────────────────────────────────────────────────────────────────

export interface FakeCalendar extends CalendarClient {
  events: Map<string, CalendarEvent>;
  calls: Array<{ op: string; args: unknown[] }>;
}

export function createFakeCalendar(ownerEmail = 'me@example.com'): FakeCalendar {
  const events = new Map<string, CalendarEvent>();
  const calls: FakeCalendar['calls'] = [];
  const startOf = (event: CalendarEvent) => Date.parse(event.start?.dateTime ?? `${event.start?.date}T00:00:00Z`);
  return {
    events,
    calls,
    async listCalendars() {
      calls.push({ op: 'listCalendars', args: [] });
      return [{ id: ownerEmail, summary: ownerEmail, primary: true, accessRole: 'owner', timeZone: 'UTC' }, { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer', timeZone: 'UTC' }];
    },
    async listEvents(calendarId, query) {
      calls.push({ op: 'listEvents', args: [calendarId, query] });
      const items = [...events.values()]
        .filter(event => (!query.timeMin || startOf(event) >= Date.parse(query.timeMin)) && (!query.timeMax || startOf(event) < Date.parse(query.timeMax)))
        .filter(event => !query.q || `${event.summary} ${event.description ?? ''}`.toLowerCase().includes(query.q.toLowerCase()))
        .sort((a, b) => startOf(a) - startOf(b))
        .slice(0, query.maxResults ?? 25);
      return { items: JSON.parse(JSON.stringify(items)), timeZone: 'UTC' };
    },
    async getEvent(_calendarId, eventId) {
      calls.push({ op: 'getEvent', args: [eventId] });
      const event = events.get(eventId);
      if (!event) throw new GoogleApiError('Google Calendar event failed (HTTP 404 notFound)', 404, 'notFound');
      return JSON.parse(JSON.stringify(event));
    },
    async insertEvent(calendarId, event, options) {
      calls.push({ op: 'insertEvent', args: [calendarId, event, options] });
      if (event.id && events.has(event.id)) throw new GoogleApiError('Google Calendar create failed (HTTP 409 duplicate: The requested identifier already exists.)', 409, 'duplicate');
      const stored: CalendarEvent = {
        ...JSON.parse(JSON.stringify(event)),
        status: 'confirmed',
        htmlLink: `https://calendar.example/event?eid=${event.id}`,
        organizer: { email: ownerEmail, self: true },
        ...(options.conference ? { hangoutLink: `https://meet.example/${event.id}` } : {}),
        ...(event.attendees ? { attendees: event.attendees.map(attendee => ({ ...attendee, responseStatus: 'needsAction' })) } : {}),
      };
      delete (stored as { conferenceData?: unknown }).conferenceData;
      events.set(event.id!, stored);
      return JSON.parse(JSON.stringify(stored));
    },
    async patchEvent(calendarId, eventId, patch, options) {
      calls.push({ op: 'patchEvent', args: [calendarId, eventId, patch, options] });
      const event = events.get(eventId);
      if (!event) throw new GoogleApiError('Google Calendar update failed (HTTP 404 notFound)', 404, 'notFound');
      const next = { ...event, ...JSON.parse(JSON.stringify(patch)) };
      if (options.conference) next.hangoutLink = `https://meet.example/${eventId}`;
      delete next.conferenceData;
      events.set(eventId, next);
      return JSON.parse(JSON.stringify(next));
    },
    async deleteEvent(calendarId, eventId, options) {
      calls.push({ op: 'deleteEvent', args: [calendarId, eventId, options] });
      if (!events.delete(eventId)) throw new GoogleApiError('Google Calendar delete failed (HTTP 410 deleted)', 410, 'deleted');
    },
  };
}

// ── All of it, wired to one fake Drive ───────────────────────────────────────

export interface FakeWorkspace extends GoogleWorkspaceClients {
  docs: FakeDocs;
  sheets: FakeSheets;
  slides: FakeSlides;
  forms: FakeForms;
  calendar: FakeCalendar;
}

export function createFakeWorkspace(drive: FakeDrive): FakeWorkspace {
  const docs = createFakeDocs();
  const sheets = createFakeSheets();
  const slides = createFakeSlides();
  const forms = createFakeForms(drive);
  const calendar = createFakeCalendar(drive.ownerEmail);
  drive.onConvert = (file: FakeDriveFile, media: Buffer) => {
    if (file.mimeType === GDRIVE_DOC_MIME) docs.fromMarkdown(file.id, media.toString('utf8'), file.name);
    if (file.mimeType === GDRIVE_SHEET_MIME) sheets.create(file.id, file.name, parseCsv(media.toString('utf8')));
  };
  drive.onCreateBlank = (file: FakeDriveFile) => {
    if (file.mimeType === GDRIVE_DOC_MIME) docs.fromMarkdown(file.id, '', file.name);
    if (file.mimeType === GDRIVE_SHEET_MIME) sheets.create(file.id, file.name);
    if (file.mimeType === GDRIVE_SLIDES_MIME) slides.addBlank(file.id, file.name);
  };
  return { docs, sheets, slides, forms, calendar };
}

export { indexToCol };
