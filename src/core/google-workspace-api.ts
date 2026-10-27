/**
 * Google Docs, Sheets, Slides, Forms and Calendar over plain fetch, on the
 * Gmail account's grant (google-workspace.md). The full `drive` scope covers
 * the four editors; Calendar needs the `calendar` scope. Each API must be
 * switched on in the Google Cloud project of the owner's OAuth client: a 403
 * accessNotConfigured names it (google-workspace-errors.ts).
 *
 * Only the fields BotBoy reads are typed; everything else passes through.
 */

import { createGoogleRest, type GoogleRest } from './gdrive-api.js';
import type { FetchLike } from './gmail-api.js';

export const GDOCS_API_BASE = 'https://docs.googleapis.com';
export const GSHEETS_API_BASE = 'https://sheets.googleapis.com';
export const GSLIDES_API_BASE = 'https://slides.googleapis.com';
export const GFORMS_API_BASE = 'https://forms.googleapis.com';
export const GCALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

// ── Docs ─────────────────────────────────────────────────────────────────────

export interface DocsTextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  link?: { url?: string; headingId?: string; bookmarkId?: string };
  weightedFontFamily?: { fontFamily?: string };
}

export interface DocsParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content?: string; textStyle?: DocsTextStyle };
  inlineObjectElement?: { inlineObjectId?: string };
  pageBreak?: Record<string, unknown>;
  columnBreak?: Record<string, unknown>;
  horizontalRule?: Record<string, unknown>;
  footnoteReference?: { footnoteId?: string; footnoteNumber?: string };
  equation?: Record<string, unknown>;
  person?: { personProperties?: { email?: string; name?: string } };
  richLink?: { richLinkProperties?: { title?: string; uri?: string } };
  autoText?: Record<string, unknown>;
  dateElement?: Record<string, unknown>;
}

export interface DocsParagraph {
  elements?: DocsParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
}

export interface DocsTableCell {
  startIndex?: number;
  endIndex?: number;
  content?: DocsStructuralElement[];
}

export interface DocsTable {
  rows?: number;
  columns?: number;
  tableRows?: Array<{ startIndex?: number; endIndex?: number; tableCells?: DocsTableCell[] }>;
}

export interface DocsStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocsParagraph;
  table?: DocsTable;
  sectionBreak?: Record<string, unknown>;
  tableOfContents?: { content?: DocsStructuralElement[] };
}

export interface DocsList {
  listProperties?: { nestingLevels?: Array<{ glyphType?: string; glyphSymbol?: string }> };
}

export interface DocsDocument {
  documentId: string;
  title?: string;
  revisionId?: string;
  body?: { content?: DocsStructuralElement[] };
  lists?: Record<string, DocsList>;
}

export interface DocsClient {
  get(documentId: string): Promise<DocsDocument>;
  batchUpdate(documentId: string, requests: unknown[], requiredRevisionId?: string): Promise<{ replies?: unknown[]; writeControl?: { requiredRevisionId?: string } }>;
}

// ── Sheets ───────────────────────────────────────────────────────────────────

export interface SheetProperties {
  sheetId: number;
  title: string;
  index?: number;
  sheetType?: string;
  gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number; frozenColumnCount?: number };
}

export interface SheetChart {
  chartId: number;
  spec?: { title?: string; basicChart?: { chartType?: string }; pieChart?: { pieHole?: number } };
}

export interface Spreadsheet {
  spreadsheetId: string;
  properties?: { title?: string; locale?: string; timeZone?: string };
  sheets?: Array<{ properties: SheetProperties; charts?: SheetChart[] }>;
  spreadsheetUrl?: string;
}

export type SheetValueRender = 'FORMULA' | 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE';
export type SheetValueInput = 'USER_ENTERED' | 'RAW';

export interface SheetsClient {
  get(spreadsheetId: string): Promise<Spreadsheet>;
  valuesBatchGet(spreadsheetId: string, ranges: string[], render: SheetValueRender): Promise<{ valueRanges: Array<{ range: string; values?: unknown[][] }> }>;
  valuesBatchUpdate(spreadsheetId: string, data: Array<{ range: string; values: unknown[][] }>, input: SheetValueInput): Promise<{ totalUpdatedCells?: number; responses?: Array<{ updatedRange?: string; updatedCells?: number }> }>;
  valuesAppend(spreadsheetId: string, range: string, values: unknown[][], input: SheetValueInput): Promise<{ updates?: { updatedRange?: string; updatedRows?: number; updatedCells?: number } }>;
  valuesBatchClear(spreadsheetId: string, ranges: string[]): Promise<{ clearedRanges?: string[] }>;
  batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<{ replies?: unknown[] }>;
}

// ── Slides ───────────────────────────────────────────────────────────────────

export interface SlidesTextElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: { content?: string };
  paragraphMarker?: Record<string, unknown>;
  autoText?: { content?: string };
}

export interface SlidesDimension { magnitude?: number; unit?: 'EMU' | 'PT' | string }

export interface SlidesPageElement {
  objectId: string;
  /** The element's built-in size; with `transform` it gives where it sits (EMU unless unit says PT). */
  size?: { width?: SlidesDimension; height?: SlidesDimension };
  transform?: { scaleX?: number; scaleY?: number; shearX?: number; shearY?: number; translateX?: number; translateY?: number; unit?: string };
  shape?: { shapeType?: string; placeholder?: { type?: string; index?: number }; text?: { textElements?: SlidesTextElement[] } };
  table?: { rows?: number; columns?: number; tableRows?: Array<{ tableCells?: Array<{ text?: { textElements?: SlidesTextElement[] } }> }> };
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  line?: Record<string, unknown>;
  sheetsChart?: Record<string, unknown>;
  elementGroup?: { children?: SlidesPageElement[] };
}

export interface SlidesPage {
  objectId: string;
  pageElements?: SlidesPageElement[];
  slideProperties?: {
    layoutObjectId?: string;
    notesPage?: { pageElements?: SlidesPageElement[]; notesProperties?: { speakerNotesObjectId?: string } };
  };
  layoutProperties?: { name?: string; displayName?: string };
}

export interface Presentation {
  presentationId: string;
  title?: string;
  revisionId?: string;
  /** The slide size (EMU); 9144000×5143500 is the usual 16:9, 720×405 pt. */
  pageSize?: { width?: SlidesDimension; height?: SlidesDimension };
  slides?: SlidesPage[];
  layouts?: SlidesPage[];
}

export interface SlidesClient {
  get(presentationId: string): Promise<Presentation>;
  create(title: string): Promise<Presentation>;
  batchUpdate(presentationId: string, requests: unknown[], requiredRevisionId?: string): Promise<{ replies?: any[]; writeControl?: { requiredRevisionId?: string } }>;
}

// ── Forms ────────────────────────────────────────────────────────────────────

export interface FormItem {
  itemId?: string;
  title?: string;
  description?: string;
  questionItem?: { question?: FormQuestion; image?: unknown };
  questionGroupItem?: { questions?: FormQuestion[]; grid?: { columns?: { options?: Array<{ value?: string }> } } };
  pageBreakItem?: Record<string, unknown>;
  textItem?: Record<string, unknown>;
  imageItem?: Record<string, unknown>;
  videoItem?: Record<string, unknown>;
}

export interface FormQuestion {
  questionId?: string;
  required?: boolean;
  choiceQuestion?: { type?: 'RADIO' | 'CHECKBOX' | 'DROP_DOWN' | string; options?: Array<{ value?: string; isOther?: boolean }>; shuffle?: boolean };
  textQuestion?: { paragraph?: boolean };
  scaleQuestion?: { low?: number; high?: number; lowLabel?: string; highLabel?: string };
  dateQuestion?: { includeTime?: boolean; includeYear?: boolean };
  timeQuestion?: { duration?: boolean };
  ratingQuestion?: { ratingScaleLevel?: number; iconType?: string };
  fileUploadQuestion?: Record<string, unknown>;
  rowQuestion?: { title?: string };
}

export interface GoogleForm {
  formId: string;
  info?: { title?: string; description?: string; documentTitle?: string };
  settings?: { quizSettings?: { isQuiz?: boolean }; emailCollectionType?: string };
  items?: FormItem[];
  revisionId?: string;
  responderUri?: string;
  linkedSheetId?: string;
  publishSettings?: { publishState?: { isPublished?: boolean; isAcceptingResponses?: boolean } };
}

export interface FormResponse {
  responseId?: string;
  createTime?: string;
  lastSubmittedTime?: string;
  respondentEmail?: string;
  totalScore?: number;
  answers?: Record<string, { questionId?: string; textAnswers?: { answers?: Array<{ value?: string }> }; fileUploadAnswers?: { answers?: Array<{ fileName?: string; fileId?: string }> } }>;
}

export interface FormsClient {
  create(input: { title: string; documentTitle?: string }): Promise<GoogleForm>;
  get(formId: string): Promise<GoogleForm>;
  batchUpdate(formId: string, requests: unknown[], requiredRevisionId?: string): Promise<{ replies?: any[]; writeControl?: { requiredRevisionId?: string } }>;
  setPublishState(formId: string, state: { isPublished: boolean; isAcceptingResponses: boolean }): Promise<GoogleForm['publishSettings']>;
  listResponses(formId: string, options?: { pageToken?: string; pageSize?: number }): Promise<{ responses: FormResponse[]; nextPageToken?: string }>;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

export interface CalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
}

export interface CalendarEventTime { date?: string; dateTime?: string; timeZone?: string }

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
}

export interface CalendarEvent {
  id?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; self?: boolean };
  recurrence?: string[];
  recurringEventId?: string;
  hangoutLink?: string;
  conferenceData?: Record<string, unknown> & { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  reminders?: { useDefault?: boolean; overrides?: Array<{ method: string; minutes: number }> };
  transparency?: string;
  visibility?: string;
  colorId?: string;
  updated?: string;
}

export type CalendarSendUpdates = 'all' | 'externalOnly' | 'none';

export interface CalendarClient {
  listCalendars(): Promise<CalendarListEntry[]>;
  listEvents(calendarId: string, query: { timeMin?: string; timeMax?: string; q?: string; maxResults?: number; pageToken?: string }): Promise<{ items: CalendarEvent[]; nextPageToken?: string; timeZone?: string }>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent>;
  insertEvent(calendarId: string, event: CalendarEvent, options: { sendUpdates: CalendarSendUpdates; conference?: boolean }): Promise<CalendarEvent>;
  patchEvent(calendarId: string, eventId: string, patch: Partial<CalendarEvent>, options: { sendUpdates: CalendarSendUpdates; conference?: boolean }): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string, options: { sendUpdates: CalendarSendUpdates }): Promise<void>;
}

export interface GoogleWorkspaceClients {
  docs: DocsClient;
  sheets: SheetsClient;
  slides: SlidesClient;
  forms: FormsClient;
  calendar: CalendarClient;
}

export function createGoogleWorkspaceClients(deps: {
  fetchImpl?: FetchLike;
  accessToken: () => Promise<string>;
  invalidateAccessToken?: () => void;
  bases?: Partial<Record<'docs' | 'sheets' | 'slides' | 'forms' | 'calendar', string>>;
}): GoogleWorkspaceClients {
  const rest: GoogleRest = createGoogleRest(deps);
  const docsBase = (deps.bases?.docs ?? GDOCS_API_BASE).replace(/\/+$/, '');
  const sheetsBase = (deps.bases?.sheets ?? GSHEETS_API_BASE).replace(/\/+$/, '');
  const slidesBase = (deps.bases?.slides ?? GSLIDES_API_BASE).replace(/\/+$/, '');
  const formsBase = (deps.bases?.forms ?? GFORMS_API_BASE).replace(/\/+$/, '');
  const calendarBase = (deps.bases?.calendar ?? GCALENDAR_API_BASE).replace(/\/+$/, '');
  const id = encodeURIComponent;
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const patch = (body: unknown): RequestInit => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get: RequestInit = { method: 'GET' };

  const docs: DocsClient = {
    get: documentId => rest.json(`${docsBase}/v1/documents/${id(documentId)}`, get, 'Google Docs read'),
    batchUpdate: (documentId, requests, requiredRevisionId) => rest.json(`${docsBase}/v1/documents/${id(documentId)}:batchUpdate`, post({
      requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
    }), 'Google Docs edit'),
  };

  const sheets: SheetsClient = {
    get: spreadsheetId => rest.json(`${sheetsBase}/v4/spreadsheets/${id(spreadsheetId)}?fields=${id('spreadsheetId,properties(title,locale,timeZone),spreadsheetUrl,sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)),charts(chartId,spec(title,basicChart(chartType),pieChart(pieHole))))')}`, get, 'Google Sheets read'),
    async valuesBatchGet(spreadsheetId, ranges, render) {
      const params = new URLSearchParams({ valueRenderOption: render, dateTimeRenderOption: 'FORMATTED_STRING', majorDimension: 'ROWS' });
      for (const range of ranges) params.append('ranges', range);
      const body = await rest.json(`${sheetsBase}/v4/spreadsheets/${id(spreadsheetId)}/values:batchGet?${params}`, get, 'Google Sheets read');
      return { valueRanges: Array.isArray(body.valueRanges) ? body.valueRanges : [] };
    },
    valuesBatchUpdate: (spreadsheetId, data, input) => rest.json(`${sheetsBase}/v4/spreadsheets/${id(spreadsheetId)}/values:batchUpdate`, post({
      valueInputOption: input, data: data.map(entry => ({ range: entry.range, majorDimension: 'ROWS', values: entry.values })),
    }), 'Google Sheets edit'),
    valuesAppend: (spreadsheetId, range, values, input) => rest.json(
      `${sheetsBase}/v4/spreadsheets/${id(spreadsheetId)}/values/${id(range)}:append?${new URLSearchParams({ valueInputOption: input, insertDataOption: 'INSERT_ROWS' })}`,
      post({ range, majorDimension: 'ROWS', values }),
      'Google Sheets append',
    ),
    valuesBatchClear: (spreadsheetId, ranges) => rest.json(`${sheetsBase}/v4/spreadsheets/${id(spreadsheetId)}/values:batchClear`, post({ ranges }), 'Google Sheets clear'),
    batchUpdate: (spreadsheetId, requests) => rest.json(`${sheetsBase}/v4/spreadsheets/${id(spreadsheetId)}:batchUpdate`, post({ requests }), 'Google Sheets edit'),
  };

  const slides: SlidesClient = {
    get: presentationId => rest.json(`${slidesBase}/v1/presentations/${id(presentationId)}`, get, 'Google Slides read'),
    create: title => rest.json(`${slidesBase}/v1/presentations`, post({ title }), 'Google Slides create'),
    batchUpdate: (presentationId, requests, requiredRevisionId) => rest.json(`${slidesBase}/v1/presentations/${id(presentationId)}:batchUpdate`, post({
      requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
    }), 'Google Slides edit'),
  };

  const forms: FormsClient = {
    create: input => rest.json(`${formsBase}/v1/forms`, post({ info: { title: input.title, ...(input.documentTitle ? { documentTitle: input.documentTitle } : {}) } }), 'Google Forms create'),
    get: formId => rest.json(`${formsBase}/v1/forms/${id(formId)}`, get, 'Google Forms read'),
    batchUpdate: (formId, requests, requiredRevisionId) => rest.json(`${formsBase}/v1/forms/${id(formId)}:batchUpdate`, post({
      requests, includeFormInResponse: false, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
    }), 'Google Forms edit'),
    async setPublishState(formId, state) {
      const body = await rest.json(`${formsBase}/v1/forms/${id(formId)}:setPublishSettings`, post({
        publishSettings: { publishState: { isPublished: state.isPublished, isAcceptingResponses: state.isAcceptingResponses } },
        updateMask: 'publishState',
      }), 'Google Forms publish');
      return body.publishSettings;
    },
    async listResponses(formId, options = {}) {
      const params = new URLSearchParams({ pageSize: String(Math.min(Math.max(options.pageSize ?? 100, 1), 5000)) });
      if (options.pageToken) params.set('pageToken', options.pageToken);
      const body = await rest.json(`${formsBase}/v1/forms/${id(formId)}/responses?${params}`, get, 'Google Forms responses');
      return { responses: Array.isArray(body.responses) ? body.responses : [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) };
    },
  };

  const calendar: CalendarClient = {
    async listCalendars() {
      const out: CalendarListEntry[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ maxResults: '250' });
        if (pageToken) params.set('pageToken', pageToken);
        const body = await rest.json(`${calendarBase}/users/me/calendarList?${params}`, get, 'Google Calendar list');
        if (Array.isArray(body.items)) out.push(...body.items);
        pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
        if (!pageToken) break;
      }
      return out;
    },
    async listEvents(calendarId, query) {
      const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(Math.max(query.maxResults ?? 25, 1), 250)) });
      if (query.timeMin) params.set('timeMin', query.timeMin);
      if (query.timeMax) params.set('timeMax', query.timeMax);
      if (query.q) params.set('q', query.q);
      if (query.pageToken) params.set('pageToken', query.pageToken);
      const body = await rest.json(`${calendarBase}/calendars/${id(calendarId)}/events?${params}`, get, 'Google Calendar events');
      return { items: Array.isArray(body.items) ? body.items : [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}), ...(body.timeZone ? { timeZone: body.timeZone } : {}) };
    },
    getEvent: (calendarId, eventId) => rest.json(`${calendarBase}/calendars/${id(calendarId)}/events/${id(eventId)}`, get, 'Google Calendar event'),
    insertEvent: (calendarId, event, options) => rest.json(
      `${calendarBase}/calendars/${id(calendarId)}/events?${new URLSearchParams({ sendUpdates: options.sendUpdates, ...(options.conference ? { conferenceDataVersion: '1' } : {}) })}`,
      post(event),
      'Google Calendar create',
    ),
    patchEvent: (calendarId, eventId, body, options) => rest.json(
      `${calendarBase}/calendars/${id(calendarId)}/events/${id(eventId)}?${new URLSearchParams({ sendUpdates: options.sendUpdates, ...(options.conference ? { conferenceDataVersion: '1' } : {}) })}`,
      patch(body),
      'Google Calendar update',
    ),
    async deleteEvent(calendarId, eventId, options) {
      const response = await rest.call(`${calendarBase}/calendars/${id(calendarId)}/events/${id(eventId)}?${new URLSearchParams({ sendUpdates: options.sendUpdates })}`, { method: 'DELETE' }, 'Google Calendar delete');
      await response.text().catch(() => '');
    },
  };

  return { docs, sheets, slides, forms, calendar };
}
