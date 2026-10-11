import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { isProtectedLocalHttpUrl } from './protected-local-resources.js';
import {
  FORM_FIELD_FUNCTIONS,
  FORM_FIELD_HELPERS,
  HTML_FIELD_REDACTION_SNIPPET,
  MAX_FIELDS,
  SENSITIVE_FIELD_PATTERN,
  WITHHELD,
  renderFieldLines,
  sanitizeFields,
  summarizeForm,
  type FormField,
} from './form-fields.js';
import { detectSecrets, redactSecrets } from './sensitive-files.js';

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const MAX_INSPECT_NODES = 200;
const MAX_PAGE_TEXT_CHARS = 20_000;
const MAX_HTML_CHARS = 16_000;
const MODEL_SCREENSHOT_MAX_DIMENSION = 1_600;
const MODEL_SCREENSHOT_FALLBACK_DIMENSION = 1_200;
const MODEL_SCREENSHOT_MAX_BYTES = 1_200_000;

export type BrowserHandsAction =
  | 'list'
  | 'open'
  | 'navigate'
  | 'inspect'
  | 'click'
  | 'type'
  | 'select'
  | 'key'
  | 'scroll'
  | 'wait'
  | 'dialog'
  | 'close'
  | 'read_form'
  | 'fill';

/** One entry of a fill call: a field by label or ref, and the value to set. */
export interface BrowserFillEntry {
  ref?: string;
  label?: string;
  value: string | boolean | string[];
}

export interface BrowserElementTarget {
  ref?: string;
  selector?: string;
}

export interface BrowserHandsInput {
  action: BrowserHandsAction;
  tabId?: string;
  url?: string;
  target?: BrowserElementTarget;
  inspect?: {
    mode?: 'accessibility' | 'dom' | 'both';
    selector?: string;
    maxNodes?: number;
  };
  text?: string;
  values?: string[];
  replace?: boolean;
  key?: string;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  deltaX?: number;
  deltaY?: number;
  clickCount?: number;
  wait?: {
    kind?: 'load' | 'url' | 'selector' | 'text' | 'timeout';
    value?: string;
    state?: 'present' | 'visible' | 'hidden' | 'absent';
    timeoutMs?: number;
  };
  dialog?: {
    decision?: 'accept' | 'dismiss';
    promptText?: string;
  };
  fields?: BrowserFillEntry[];
}

export interface BrowserReceipt {
  ok: boolean;
  action: BrowserHandsAction | 'screenshot';
  tabId?: string;
  url?: string;
  title?: string;
  readyState?: string;
  dialog?: { type: string; message: string; hasBrowserHandler?: boolean; handled?: 'accept' | 'dismiss'; open?: boolean };
  newTabs?: Array<{ tabId: string; url: string; title: string; openerTabId?: string }>;
  error?: { code: string; message: string; nextAction: string };
  [key: string]: unknown;
}

export interface BrowserScreenshotReceipt extends BrowserReceipt {
  action: 'screenshot';
  filePath?: string;
  fileUrl?: string;
  bytes?: number;
  width?: number;
  height?: number;
  fullPage?: boolean;
  clipped?: boolean;
  modelImageIncluded?: boolean;
  modelImageMime?: 'image/jpeg';
  modelImageBytes?: number;
  modelImageWidth?: number;
  modelImageHeight?: number;
}

export interface BrowserHandsService {
  initialize(): Promise<void>;
  execute(input: BrowserHandsInput): Promise<BrowserReceipt>;
  screenshot(input: { tabId?: string; fullPage?: boolean; includeModelImage?: boolean }): Promise<{
    receipt: BrowserScreenshotReceipt;
    dataUrl?: string;
  }>;
  ownsTarget(targetId: string): boolean;
}

export interface BrowserHandsOptions {
  cdpEndpoint?: string;
  stateDir?: string;
  filesDir?: string;
  protectedAppPort?: number;
}

interface OwnedTab {
  tabId: string;
  targetId: string;
  openerTabId?: string;
  createdAt: string;
}

interface ChromeTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  openerId?: string;
}

interface StoredRegistry {
  version: 1;
  tabs: OwnedTab[];
}

interface RefState {
  documentToken: string;
  refs: Map<string, string>;
  /** Field refs r1..r<fieldCount> come from the form reader. */
  fieldCount?: number;
}

class BrowserHandsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
  }
}

class CdpSession {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  readonly events: Array<{ method: string; params: any }> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', data => {
      try {
        const message = JSON.parse(String(data));
        if (message.id && this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error(message.error.message || 'CDP error'));
          else waiter.resolve(message.result);
        } else if (message.method) {
          this.events.push({ method: message.method, params: message.params });
          if (this.events.length > 800) this.events.shift();
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
    ws.on('close', () => this.rejectPending(new Error('CDP socket closed')));
    ws.on('error', error => this.rejectPending(error instanceof Error ? error : new Error(String(error))));
  }

  static connect(wsUrl: string, timeoutMs = 8_000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      });
      ws.once('error', error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 12_000): Promise<any> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('CDP session closed'));
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}

function normalizeHttpUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new BrowserHandsError('URL_REQUIRED', 'url is required', 'Pass the complete http:// or https:// URL.');
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new BrowserHandsError('INVALID_URL', `Invalid URL: ${raw.slice(0, 160)}`, 'Pass a complete http:// or https:// URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserHandsError('UNSUPPORTED_URL', `Only http(s) pages are supported (got ${parsed.protocol})`, 'Use an http:// or https:// page.');
  }
  return parsed.toString();
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new BrowserHandsError('INVALID_SCREENSHOT', 'Chrome returned invalid PNG data', 'Retry browser_screenshot.');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new BrowserHandsError('INVALID_SCREENSHOT', 'Chrome returned invalid JPEG model evidence', 'Retry browser_screenshot.');
  }
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new BrowserHandsError('INVALID_SCREENSHOT', 'Could not read JPEG model-evidence dimensions', 'Retry browser_screenshot.');
}

function deriveModelJpeg(
  sourcePng: string,
  destinationJpeg: string,
  maximumDimension: number,
  quality: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality),
      '-Z', String(maximumDimension),
      sourcePng,
      '--out', destinationJpeg,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 }, error => {
      if (error) reject(error); else resolve();
    });
  });
}

function keyDefinition(input: string): { key: string; code: string; windowsVirtualKeyCode: number } {
  const named: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  };
  if (named[input]) return named[input];
  if (input.length === 1) {
    const upper = input.toUpperCase();
    return {
      key: input,
      code: /[A-Z]/.test(upper) ? `Key${upper}` : input,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  throw new BrowserHandsError('UNSUPPORTED_KEY', `Unsupported key: ${input}`, 'Use Enter, Tab, Escape, Backspace, Delete, an arrow/navigation key, Space, or one character.');
}

function modifierMask(modifiers: BrowserHandsInput['modifiers']): number {
  let mask = 0;
  for (const modifier of modifiers ?? []) {
    if (modifier === 'Alt') mask |= 1;
    if (modifier === 'Control') mask |= 2;
    if (modifier === 'Meta') mask |= 4;
    if (modifier === 'Shift') mask |= 8;
  }
  return mask;
}

function latestDialog(session: CdpSession): BrowserReceipt['dialog'] | undefined {
  let dialog: BrowserReceipt['dialog'] | undefined;
  for (const event of session.events) {
    if (event.method === 'Page.javascriptDialogOpening') {
      dialog = {
        type: String(event.params?.type ?? 'dialog'),
        message: String(event.params?.message ?? ''),
        hasBrowserHandler: Boolean(event.params?.hasBrowserHandler),
      };
    } else if (event.method === 'Page.javascriptDialogClosed') {
      dialog = undefined;
    }
  }
  return dialog;
}

// ── Form fields: inspect / read_form / fill ─────────────────────────────────

const MAX_FILL_ENTRIES = 40;
const MAX_FILL_TEXT = 5_000;
const FILL_OPTION_WAIT_MS = 1_500;

/** Field refs are r1..rF, in page order, before any other element ref. */
export function fieldRefs(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `r${index + 1}`);
}

/** A field as the model sees it: no selectors. */
function publicField(field: FormField, ref: string): Record<string, unknown> {
  const { path: _path, optionPaths: _optionPaths, native: _native, ...rest } = field;
  return { ref, ...rest };
}

/** The `form` block of inspect and read_form receipts. */
export function formBlock(fields: FormField[], truncated = 0): { summary: string; lines: string[]; fields: Array<Record<string, unknown>> } {
  const refs = fieldRefs(fields.length);
  return {
    summary: summarizeForm(fields, refs, truncated),
    lines: renderFieldLines(fields, refs),
    fields: fields.map((field, index) => publicField(field, refs[index])),
  };
}

/**
 * One accessibility node for inspect. Text-entry values are dropped (the form
 * block carries them with BotBoy's withholding rules); other values that look
 * like a secret are withheld.
 */
export function axInspectEntry(node: any): Record<string, unknown> {
  const role = String(node?.role?.value ?? '');
  const name = String(node?.name?.value ?? '');
  const properties: any[] = Array.isArray(node?.properties) ? node.properties : [];
  let value: unknown = node?.value?.value ?? '';
  if (typeof value === 'string' && value) {
    const textEntry = /^(textbox|searchbox|combobox|spinbutton|textField)$/i.test(role);
    const isProtected = properties.some(property => property?.name === 'protected' && property?.value?.value !== false);
    if (isProtected || /^[•●*]+$/.test(value) || SENSITIVE_FIELD_PATTERN.test(name) || detectSecrets(value).length) value = WITHHELD;
    else if (textEntry) value = '';
  }
  return {
    role,
    name: redactSecrets(name),
    value,
    description: node?.description?.value ?? '',
    disabled: properties.find(property => property?.name === 'disabled')?.value?.value,
    focused: properties.find(property => property?.name === 'focused')?.value?.value,
  };
}

/** The in-page inspect script: form fields first (with deep paths), then other interactive elements. */
export function buildInspectExpression(selector: string | undefined, maxNodes: number): string {
  const scope = JSON.stringify(selector ?? '');
  return `(function () {${FORM_FIELD_FUNCTIONS}${HTML_FIELD_REDACTION_SNIPPET}
      var scopeSelector = ${scope};
      var root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
      if (!root) return JSON.stringify({ error: 'scope selector did not match', selector: scopeSelector });
      function cssPath(el) {
        if (el.id) return '#' + bbEsc(el.id);
        var parts = [];
        while (el && el.nodeType === 1 && el !== document.documentElement) {
          var part = el.tagName.toLowerCase();
          var parent = el.parentElement;
          if (parent) {
            var same = Array.from(parent.children).filter(function (child) { return child.tagName === el.tagName; });
            if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
          }
          parts.unshift(part);
          el = parent;
          if (parts.length >= 8) break;
        }
        return parts.join(' > ');
      }
      function visible(el) {
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }
      var collected = botboyCollectFields(${MAX_FIELDS});
      var fields = [];
      for (var f = 0; f < collected.fields.length; f++) {
        var owner = collected.elements[f];
        if (!scopeSelector || (owner && root.contains(owner))) fields.push(collected.fields[f]);
      }
      var FIELD_QUERY = 'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=searchbox],[role=combobox],[role=listbox],[role=checkbox],[role=switch],[role=radio]';
      function isButton(el) {
        var type = (el.getAttribute('type') || '').toLowerCase();
        return el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && (type === 'button' || type === 'submit' || type === 'reset' || type === 'image'));
      }
      var query = 'a,button,input,textarea,select,option,summary,[role],[tabindex],[contenteditable="true"],iframe';
      var candidates = Array.from(root.querySelectorAll(query)).filter(function (el) { return !el.matches(FIELD_QUERY); }).filter(visible).slice(0, ${maxNodes});
      var elements = candidates.map(function (el) {
        var rect = el.getBoundingClientRect();
        var text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
        var value = isButton(el) && typeof el.value === 'string' ? el.value.slice(0, 500) : '';
        var name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || text || value || el.getAttribute('placeholder') || '';
        return {
          selector: cssPath(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          name: name.slice(0, 500),
          text: text,
          value: value || undefined,
          href: el.href || '',
          checked: typeof el.checked === 'boolean' ? el.checked : undefined,
          selected: typeof el.selected === 'boolean' ? el.selected : undefined,
          disabled: !!el.disabled,
          expanded: el.getAttribute('aria-expanded'),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      });
      return JSON.stringify({
        documentToken: String(performance.timeOrigin) + '|' + location.href,
        selector: scopeSelector || null,
        pageText: (root.innerText || root.textContent || '').trim().slice(0, ${MAX_PAGE_TEXT_CHARS}),
        htmlExcerpt: botboyRedactedHtml(root).slice(0, ${MAX_HTML_CHARS}),
        fields: fields,
        fieldsTruncated: collected.truncated,
        elements: elements,
        totalInteractive: root.querySelectorAll(query).length
      });
    })()`;
}

/** The in-page read_form script. */
export const READ_FORM_EXPRESSION = `(function () {${FORM_FIELD_FUNCTIONS}
  var r = botboyCollectFields(${MAX_FIELDS});
  return JSON.stringify({ documentToken: String(performance.timeOrigin) + '|' + location.href, fields: r.fields, truncated: r.truncated });
})()`;

/** Validates a fill call's `fields`; errors name the expected shape. */
export function validateFillFields(raw: unknown): BrowserFillEntry[] {
  const fail = (message: string) => new BrowserHandsError('FILL_INPUT_INVALID', message, 'Pass fields as [{label or ref, value}] with one entry per field (value: text, true/false for a checkbox, or a list for a multi-select).');
  if (!Array.isArray(raw) || raw.length === 0) throw fail('fill requires a non-empty fields array');
  if (raw.length > MAX_FILL_ENTRIES) throw fail(`fill takes at most ${MAX_FILL_ENTRIES} fields per call`);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw fail(`fields[${index}] must be an object`);
    const { ref, label, value } = entry as Record<string, unknown>;
    const hasRef = typeof ref === 'string' && ref.trim() !== '';
    const hasLabel = typeof label === 'string' && label.trim() !== '';
    if (hasRef === hasLabel) throw fail(`fields[${index}] needs exactly one of ref or label`);
    if ((hasRef && (ref as string).length > 200) || (hasLabel && (label as string).length > 200)) throw fail(`fields[${index}] ref/label is longer than 200 characters`);
    const okValue = typeof value === 'boolean'
      || (typeof value === 'string' && value.length <= MAX_FILL_TEXT)
      || (Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(item => typeof item === 'string' && item.length <= 500));
    if (!okValue) throw fail(`fields[${index}].value must be text (up to ${MAX_FILL_TEXT} characters), true/false, or a list of up to 20 option texts`);
    return { ...(hasRef ? { ref: (ref as string).trim() } : { label: (label as string).trim() }), value: value as BrowserFillEntry['value'] };
  });
}

/** Unique match over texts: exact, then case-insensitive exact, then case-insensitive contains. */
export function matchText(texts: string[], wanted: string): { index?: number; matches: number[] } {
  const exact = wanted.trim();
  const lower = exact.toLowerCase();
  const levels: Array<(text: string) => boolean> = [
    text => text.trim() === exact,
    text => text.trim().toLowerCase() === lower,
    text => lower !== '' && text.toLowerCase().includes(lower),
  ];
  for (const test of levels) {
    const matches = texts.map((text, index) => (test(text) ? index : -1)).filter(index => index >= 0);
    if (matches.length === 1) return { index: matches[0], matches };
    if (matches.length > 1) return { matches };
  }
  return { matches: [] };
}

export interface FillResolution {
  entry: BrowserFillEntry;
  index?: number;
  note?: string;
}

/** Resolves every fill entry to one current field, or a note naming the candidates. */
export function resolveFillEntries(entries: BrowserFillEntry[], fields: FormField[], refs: string[]): FillResolution[] {
  const name = (index: number) => `${refs[index]} "${fields[index].label}"`;
  return entries.map(entry => {
    if (entry.ref) {
      const index = refs.indexOf(entry.ref);
      return index >= 0 ? { entry, index } : { entry, note: `no field ${entry.ref} on this page; call read_form for current refs` };
    }
    const match = matchText(fields.map(field => field.label), entry.label ?? '');
    if (match.index !== undefined) return { entry, index: match.index };
    if (match.matches.length > 1) {
      return { entry, note: `ambiguous: ${match.matches.slice(0, 20).map(name).join(', ')}; pass ref` };
    }
    const listed = fields.slice(0, 20).map((_, index) => name(index)).join(', ');
    return { entry, note: `no field labelled "${entry.label}"; fields: ${listed || '(none)'}` };
  });
}

/** true/false from a checkbox fill value, or undefined when it is not one. */
export function parseChecked(value: BrowserFillEntry['value']): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  if (['true', 'checked', 'yes', 'on', 'check', 'tick', '1'].includes(lower)) return true;
  if (['false', 'unchecked', 'no', 'off', 'uncheck', 'untick', '0', ''].includes(lower)) return false;
  return undefined;
}

function displayValue(value: BrowserFillEntry['value'] | undefined): string {
  if (typeof value === 'boolean') return value ? 'checked' : 'unchecked';
  if (Array.isArray(value)) return value.join(', ');
  return String(value ?? '');
}

function fieldDisplay(field: FormField): string {
  if (field.withheld) return WITHHELD;
  if (field.kind === 'checkbox' || field.kind === 'switch' || field.kind === 'radio') return field.checked ? 'checked' : 'unchecked';
  return Array.isArray(field.value) ? field.value.join(', ') : (field.value ?? '');
}

/**
 * In-page check that a withheld field holds exactly `length` characters. Only
 * the number travels to the page; the value never travels back.
 */
export function withheldLengthExpression(fieldPath: string, length: number): string {
  return `(function () {${FORM_FIELD_HELPERS}
  var h = bbResolve(${JSON.stringify(fieldPath)});
  if (!h) return JSON.stringify({ gone: true });
  var el = h.el;
  var n = (typeof el.value === 'string') ? el.value.length : String(el.innerText || el.textContent || '').length;
  return JSON.stringify({ ok: n === ${Math.max(0, Math.floor(length))}, shorter: n < ${Math.max(0, Math.floor(length))} });
})()`;
}

export interface FillResult {
  ref: string;
  label: string;
  requested: string;
  actual: string;
  ok: boolean;
  note?: string;
}

/** One field's fill receipt, read back from the page after the fill. */
export function fillResult(
  ref: string,
  field: FormField,
  after: FormField | undefined,
  entry: BrowserFillEntry,
  act: { chosen?: string | string[]; note?: string },
  withheldCheck?: { ok?: boolean; shorter?: boolean; gone?: boolean } | null,
): FillResult {
  const secret = field.withheld || after?.withheld;
  const requested = secret ? WITHHELD : redactSecrets(displayValue(entry.value));
  const base = { ref, label: field.label, requested };
  const actual = after ? redactSecrets(fieldDisplay(after)) : '(not read)';
  if (act.note) return { ...base, actual, ok: false, note: act.note };
  if (!after) return { ...base, actual, ok: false, note: 'field not found after fill; call read_form' };
  if (secret) {
    const ok = withheldCheck?.ok === true;
    return { ...base, actual: WITHHELD, ok, ...(ok ? {} : { note: withheldCheck?.shorter ? 'page shortened the value' : 'could not confirm the value; type it again' }) };
  }
  if (after.kind === 'checkbox' || after.kind === 'switch' || after.kind === 'radio') {
    const desired = parseChecked(entry.value);
    const ok = desired !== undefined && after.checked === desired;
    return { ...base, requested: displayValue(desired ?? entry.value), actual, ok, ...(ok ? {} : { note: 'the box did not change; click it with action=click' }) };
  }
  if (act.chosen !== undefined) {
    const chosen = Array.isArray(act.chosen) ? act.chosen : [act.chosen];
    const now = Array.isArray(after.value) ? after.value : [after.value ?? ''];
    const ok = chosen.length === now.length && chosen.every(item => now.includes(item));
    return { ...base, actual, ok, ...(ok ? {} : { note: 'the page did not keep the selection' }) };
  }
  const want = displayValue(entry.value).trim();
  let have = String(Array.isArray(after.value) ? after.value.join(', ') : (after.value ?? '')).trim();
  // Values past the reader's 300-character clip compare on the shown prefix.
  if (have.endsWith('…') && want.length > have.length - 1) {
    const prefix = have.slice(0, -1);
    if (want.startsWith(prefix)) have = want;
  }
  if (have === want) return { ...base, actual, ok: true };
  const strip = (text: string) => text.replace(/[\s-]+/g, '');
  if (strip(have) === strip(want)) return { ...base, actual, ok: true, note: 'page formatted the value' };
  if ((field.maxLength && want.length > field.maxLength) || (have.length < want.length && want.startsWith(have))) {
    return { ...base, actual, ok: false, note: 'page shortened the value' };
  }
  return { ...base, actual, ok: false, note: 'page shows a different value; inspect the field and retry' };
}

/** `5 of 6 fields set; 1 failed: r9 "Dialect" option not found`. */
export function fillSummary(results: FillResult[]): string {
  const failed = results.filter(result => !result.ok);
  const head = `${results.length - failed.length} of ${results.length} field${results.length === 1 ? '' : 's'} set`;
  if (!failed.length) return head;
  return `${head}; ${failed.length} failed: ${failed.map(result => `${result.ref || '-'} "${result.label}" ${result.note ?? ''}`.trim()).join('; ')}`;
}

function errorReceipt(action: BrowserHandsAction | 'screenshot', error: unknown, tabId?: string): BrowserReceipt {
  const normalized = error instanceof BrowserHandsError
    ? error
    : new BrowserHandsError('BROWSER_ACTION_FAILED', String((error as any)?.message ?? error), 'Inspect the tab state, then retry with a current ref or narrower selector.');
  return {
    ok: false,
    action,
    ...(tabId ? { tabId } : {}),
    error: { code: normalized.code, message: normalized.message, nextAction: normalized.nextAction },
  };
}

export function createBrowserHandsService(options: BrowserHandsOptions = {}): BrowserHandsService {
  const cdpEndpoint = options.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT;
  const stateDir = options.stateDir ?? path.join(os.homedir(), '.personal-productivity-tracker', 'browser-hands');
  const filesDir = options.filesDir ?? path.join(os.homedir(), '.personal-productivity-tracker', 'files', 'browser-hands');
  const registryFile = path.join(stateDir, 'tabs.json');
  const cdpPort = (() => {
    try {
      const parsed = new URL(cdpEndpoint);
      return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    } catch {
      return 9222;
    }
  })();
  const protectedUrlOptions = { appPort: options.protectedAppPort, cdpPort };
  const tabs = new Map<string, OwnedTab>();
  const targetToTab = new Map<string, string>();
  const refs = new Map<string, RefState>();
  const queues = new Map<string, Promise<void>>();
  let initializePromise: Promise<void> | null = null;

  async function assertAllowedPageUrl(value: unknown, allowInternalBlank = false): Promise<string> {
    const raw = String(value ?? '').trim();
    if (allowInternalBlank && (!raw || raw === 'about:blank')) return raw || 'about:blank';
    const normalized = normalizeHttpUrl(raw);
    if (await isProtectedLocalHttpUrl(normalized, protectedUrlOptions)) {
      throw new BrowserHandsError(
        'PROTECTED_APP_ORIGIN',
        'Browser hands cannot operate BotBoy owner surfaces or the debug-Chrome control endpoint.',
        'Ask the owner to open the Data Room review and perform any approval themselves. Use self-eyes only for read-only BotBoy UI inspection.',
      );
    }
    return normalized;
  }

  async function cdpHttp(pathname: string, method: 'GET' | 'PUT' = 'GET'): Promise<any> {
    const response = await fetch(`${cdpEndpoint}${pathname}`, { method });
    const text = await response.text();
    if (!response.ok) throw new Error(`CDP ${pathname}: HTTP ${response.status} ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async function listChromeTargets(): Promise<ChromeTarget[]> {
    const raw = await cdpHttp('/json/list');
    return Array.isArray(raw) ? raw.filter(target => target?.type === 'page' && target?.id) : [];
  }

  function rebuildTargetIndex(): void {
    targetToTab.clear();
    for (const entry of tabs.values()) targetToTab.set(entry.targetId, entry.tabId);
  }

  function saveRegistry(): void {
    fs.mkdirSync(stateDir, { recursive: true });
    const payload: StoredRegistry = { version: 1, tabs: [...tabs.values()] };
    const temporary = `${registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, registryFile);
  }

  function forgetTab(tabId: string): void {
    const entry = tabs.get(tabId);
    if (entry) targetToTab.delete(entry.targetId);
    tabs.delete(tabId);
    refs.delete(tabId);
    saveRegistry();
  }

  async function reconcile(): Promise<Map<string, ChromeTarget>> {
    const targets = await listChromeTargets();
    const byId = new Map(targets.map(target => [target.id, target]));
    let changed = false;
    for (const [tabId, entry] of tabs) {
      const target = byId.get(entry.targetId);
      if (!target) {
        tabs.delete(tabId);
        refs.delete(tabId);
        changed = true;
        continue;
      }
      try {
        await assertAllowedPageUrl(target.url, true);
      } catch {
        await cdpHttp(`/json/close/${encodeURIComponent(entry.targetId)}`).catch(() => undefined);
        tabs.delete(tabId);
        refs.delete(tabId);
        byId.delete(entry.targetId);
        changed = true;
      }
    }
    if (changed) {
      rebuildTargetIndex();
      saveRegistry();
    }
    return byId;
  }

  async function initialize(): Promise<void> {
    if (!initializePromise) {
      initializePromise = (async () => {
        await cdpHttp('/json/version').catch(() => {
          throw new BrowserHandsError('DEBUG_CHROME_UNREACHABLE', 'Debug Chrome on CDP port 9222 is unreachable', 'Start BotBoy through start.sh, then retry.');
        });
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(filesDir, { recursive: true });
        try {
          const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as StoredRegistry;
          if (parsed?.version === 1 && Array.isArray(parsed.tabs)) {
            for (const entry of parsed.tabs) {
              if (entry?.tabId && entry?.targetId) tabs.set(entry.tabId, entry);
            }
          }
        } catch {
          // First run or malformed stale registry: start empty and reconcile.
        }
        rebuildTargetIndex();
        await reconcile();
        saveRegistry();
      })();
    }
    try {
      await initializePromise;
    } catch (error) {
      initializePromise = null;
      throw error;
    }
  }

  async function createBlankTarget(): Promise<ChromeTarget> {
    let created: any;
    try {
      created = await cdpHttp('/json/new?about:blank', 'PUT');
    } catch {
      created = await cdpHttp('/json/new?about:blank', 'GET');
    }
    if (!created?.id || !created?.webSocketDebuggerUrl) {
      throw new BrowserHandsError('TARGET_CREATE_FAILED', 'Chrome created a tab without a debuggable target', 'Retry after checking CDP /json/version.');
    }
    return created as ChromeTarget;
  }

  async function resolveOwnedTarget(tabId: string): Promise<{ entry: OwnedTab; target: ChromeTarget }> {
    const entry = tabs.get(tabId);
    if (!entry) {
      throw new BrowserHandsError('TAB_NOT_FOUND', `Unknown browser tabId: ${tabId}`, 'Call browser_hands action=list and use one of the returned tabIds, or open a new tab.');
    }
    const targets = await reconcile();
    const current = targets.get(entry.targetId);
    if (!current?.webSocketDebuggerUrl) {
      if (!current) forgetTab(tabId);
      throw new BrowserHandsError('TAB_CLOSED', `Browser tab ${tabId} is no longer available`, 'Call action=list, then open or use an available tab.');
    }
    return { entry, target: current };
  }

  async function withSession<T>(tabId: string, operation: (session: CdpSession, entry: OwnedTab, target: ChromeTarget) => Promise<T>): Promise<T> {
    const { entry, target } = await resolveOwnedTarget(tabId);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl!);
    try {
      await session.send('Page.enable').catch(() => undefined);
      await session.send('Runtime.enable').catch(() => undefined);
      const currentState = await pageState(session, target);
      await assertAllowedPageUrl(currentState.url, true);
      return await operation(session, entry, target);
    } finally {
      session.close();
    }
  }

  function enqueue<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(tabId) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const marker = running.then(() => undefined, () => undefined);
    queues.set(tabId, marker);
    return running.finally(() => {
      if (queues.get(tabId) === marker) queues.delete(tabId);
    });
  }

  async function evaluate<T>(session: CdpSession, expression: string, timeoutMs = 12_000): Promise<T> {
    const result = await session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail?.exception?.description ?? detail?.text ?? 'page evaluation failed');
    }
    const value = result?.result?.value;
    if (typeof value === 'string') {
      try { return JSON.parse(value) as T; } catch { return value as T; }
    }
    return value as T;
  }

  async function pageState(session: CdpSession, target?: ChromeTarget): Promise<{
    url: string;
    title: string;
    readyState: string;
    documentToken: string;
    scrollX: number;
    scrollY: number;
    viewport: { width: number; height: number };
  }> {
    try {
      return await evaluate(session, `(function () {
        return JSON.stringify({
          url: location.href,
          title: document.title || '',
          readyState: document.readyState,
          documentToken: String(performance.timeOrigin) + '|' + location.href,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          viewport: { width: window.innerWidth, height: window.innerHeight }
        });
      })()`);
    } catch {
      return {
        url: target?.url ?? '',
        title: target?.title ?? '',
        readyState: 'unknown',
        documentToken: `unknown|${target?.url ?? ''}`,
        scrollX: 0,
        scrollY: 0,
        viewport: { width: 0, height: 0 },
      };
    }
  }

  async function adoptPopups(session: CdpSession): Promise<Array<{ tabId: string; url: string; title: string; openerTabId?: string }>> {
    const result = await session.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const infos = Array.isArray(result?.targetInfos) ? result.targetInfos as TargetInfo[] : [];
    const adopted: Array<{ tabId: string; url: string; title: string; openerTabId?: string }> = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of infos) {
        if (info.type !== 'page' || !info.targetId || targetToTab.has(info.targetId) || !info.openerId) continue;
        const openerTabId = targetToTab.get(info.openerId);
        if (!openerTabId) continue;
        try {
          await assertAllowedPageUrl(info.url ?? '', true);
        } catch {
          await cdpHttp(`/json/close/${encodeURIComponent(info.targetId)}`).catch(() => undefined);
          continue;
        }
        const tabId = `tab_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const entry: OwnedTab = { tabId, targetId: info.targetId, openerTabId, createdAt: new Date().toISOString() };
        tabs.set(tabId, entry);
        targetToTab.set(info.targetId, tabId);
        adopted.push({ tabId, url: info.url ?? '', title: info.title ?? '', openerTabId });
        changed = true;
      }
    }
    if (adopted.length) saveRegistry();
    return adopted;
  }

  async function settleAndReceipt(
    action: BrowserHandsAction,
    tabId: string,
    session: CdpSession,
    target: ChromeTarget,
    extra: Record<string, unknown> = {},
  ): Promise<BrowserReceipt> {
    await sleep(250);
    const newTabs = await adoptPopups(session);
    const dialog = latestDialog(session);
    // Runtime evaluation blocks while a JavaScript dialog is open. Return the
    // dialog immediately so the next action can accept/dismiss it instead of
    // waiting for an avoidable Runtime timeout.
    const state = dialog
      ? {
          url: target.url ?? '',
          title: target.title ?? '',
          readyState: 'dialog',
          documentToken: `dialog|${target.url ?? ''}`,
          scrollX: 0,
          scrollY: 0,
          viewport: { width: 0, height: 0 },
        }
      : await pageState(session, target);
    await assertAllowedPageUrl(state.url);
    return {
      ok: true,
      action,
      tabId,
      url: state.url,
      title: state.title,
      readyState: state.readyState,
      ...(dialog ? { dialog } : {}),
      ...(newTabs.length ? { newTabs } : {}),
      ...extra,
    };
  }

  async function navigate(session: CdpSession, url: string): Promise<void> {
    const startIndex = session.events.length;
    const result = await session.send('Page.navigate', { url }, 15_000);
    if (result?.errorText) {
      throw new BrowserHandsError('NAVIGATION_FAILED', result.errorText, 'Check the URL or network, then retry navigate.');
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < NAVIGATION_TIMEOUT_MS) {
      const events = session.events.slice(startIndex);
      if (events.some(event => event.method === 'Page.loadEventFired' || event.method === 'Page.domContentEventFired')) {
        await sleep(500);
        return;
      }
      try {
        const state = await evaluate<{ readyState: string; url: string }>(session, `JSON.stringify({ readyState: document.readyState, url: location.href })`, 3_000);
        if (Date.now() - startedAt > 750 && state?.readyState === 'complete' && state.url !== 'about:blank') {
          await sleep(500);
          return;
        }
      } catch {
        // Target is between documents; retry.
      }
      await sleep(200);
    }
    throw new BrowserHandsError('NAVIGATION_TIMEOUT', `Page did not finish loading within ${NAVIGATION_TIMEOUT_MS / 1000}s`, 'Inspect the tab; if useful content is present continue, otherwise retry or wait for a selector.');
  }

  async function inspectTab(tabId: string, input: BrowserHandsInput): Promise<BrowserReceipt> {
    return enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
      const mode = input.inspect?.mode ?? 'both';
      const maxNodes = Math.round(clamp(input.inspect?.maxNodes, 1, MAX_INSPECT_NODES, 80));
      const dom = mode === 'accessibility'
        ? undefined
        : await evaluate<any>(session, buildInspectExpression(input.inspect?.selector, maxNodes), 20_000);
      if (dom?.error) {
        throw new BrowserHandsError('SELECTOR_NOT_FOUND', dom.error, 'Use a valid CSS selector or omit inspect.selector to inspect the whole page.');
      }
      let accessibility: any[] | undefined;
      if (mode !== 'dom') {
        await session.send('Accessibility.enable').catch(() => undefined);
        const tree = await session.send('Accessibility.getFullAXTree', { depth: 8 }, 15_000).catch(() => ({ nodes: [] }));
        accessibility = (Array.isArray(tree?.nodes) ? tree.nodes : [])
          .filter((node: any) => !node.ignored)
          .slice(0, maxNodes)
          .map(axInspectEntry);
      }
      const fields = sanitizeFields(dom?.fields);
      const refMap = new Map<string, string>();
      fieldRefs(fields.length).forEach((ref, index) => refMap.set(ref, fields[index].path));
      const elements = Array.isArray(dom?.elements)
        ? dom.elements.map((element: any, index: number) => {
            const ref = `r${fields.length + index + 1}`;
            refMap.set(ref, String(element.selector));
            const { selector: _selector, ...rest } = element;
            return { ref, ...rest };
          })
        : [];
      const state = await pageState(session, target);
      refs.set(tabId, { documentToken: dom?.documentToken ?? state.documentToken, refs: refMap, fieldCount: fields.length });
      const newTabs = await adoptPopups(session);
      return {
        ok: true,
        action: 'inspect',
        tabId,
        url: state.url,
        title: state.title,
        readyState: state.readyState,
        snapshotId: dom?.documentToken ?? state.documentToken,
        ...(mode !== 'accessibility' ? {
          form: formBlock(fields, Number(dom?.fieldsTruncated) || 0),
          pageText: dom?.pageText ?? '',
          htmlExcerpt: redactSecrets(String(dom?.htmlExcerpt ?? '')),
          elements,
          totalInteractive: dom?.totalInteractive ?? 0,
        } : {}),
        ...(mode !== 'dom' ? { accessibility } : {}),
        ...(latestDialog(session) ? { dialog: latestDialog(session) } : {}),
        ...(newTabs.length ? { newTabs } : {}),
      };
    }));
  }

  async function readForm(session: CdpSession): Promise<{ documentToken: string; fields: FormField[]; truncated: number }> {
    let raw: any;
    try {
      raw = await evaluate<any>(session, READ_FORM_EXPRESSION, 20_000);
    } catch (error: any) {
      throw new BrowserHandsError('INSPECT_FAILED', `Could not read the form: ${String(error?.message ?? error).slice(0, 200)}`, 'Inspect again after the page loads.');
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) {
      throw new BrowserHandsError('INSPECT_FAILED', 'The page returned no form reading', 'Inspect again after the page loads.');
    }
    return { documentToken: String(raw.documentToken ?? ''), fields: sanitizeFields(raw.fields), truncated: Number(raw.truncated) || 0 };
  }

  /** Field refs replace r1..rF; other element refs survive only while they cannot collide. */
  function registerFieldRefs(tabId: string, read: { documentToken: string; fields: FormField[] }): void {
    const previous = refs.get(tabId);
    const map = new Map<string, string>();
    if (previous && previous.documentToken === read.documentToken && previous.fieldCount === read.fields.length) {
      for (const [ref, selector] of previous.refs) map.set(ref, selector);
    }
    fieldRefs(read.fields.length).forEach((ref, index) => map.set(ref, read.fields[index].path));
    refs.set(tabId, { documentToken: read.documentToken, refs: map, fieldCount: read.fields.length });
  }

  async function readFormTab(tabId: string): Promise<BrowserReceipt> {
    return enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
      const read = await readForm(session);
      registerFieldRefs(tabId, read);
      const state = await pageState(session, target);
      return {
        ok: true,
        action: 'read_form',
        tabId,
        url: state.url,
        title: state.title,
        snapshotId: read.documentToken,
        form: formBlock(read.fields, read.truncated),
        ...(latestDialog(session) ? { dialog: latestDialog(session) } : {}),
      };
    }));
  }

  /** Select-all + delete, then insert the text as real input (keeps framework value trackers right). */
  async function typeText(session: CdpSession, point: { x: number; y: number }, text: string, replace = true): Promise<void> {
    await clickAt(session, point);
    if (replace) {
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    if (text) await session.send('Input.insertText', { text });
  }

  /** Finds a visible [role=option] by text (optionally inside one listbox) and returns its point. */
  async function findOption(session: CdpSession, wanted: string, scopePath?: string): Promise<{ x?: number; y?: number; text?: string; ambiguous?: boolean; options?: string[] }> {
    return evaluate<any>(session, `(function () {${FORM_FIELD_HELPERS}
      var scope = ${JSON.stringify(scopePath ?? '')};
      var host = scope ? bbResolve(scope) : null;
      var base = host ? host.el : document;
      var all = Array.prototype.slice.call(base.querySelectorAll('[role="option"]')).filter(function (o) {
        var r = o.getBoundingClientRect(); var s = getComputedStyle(o);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      var texts = all.map(bbText);
      var w = ${JSON.stringify(wanted)}.trim(), l = w.toLowerCase();
      var levels = [function (t) { return t === w; }, function (t) { return t.toLowerCase() === l; }, function (t) { return l && t.toLowerCase().indexOf(l) >= 0; }];
      for (var k = 0; k < levels.length; k++) {
        var hit = [];
        for (var i = 0; i < texts.length; i++) if (levels[k](texts[i])) hit.push(i);
        if (hit.length === 1 || (hit.length > 1 && k < 2)) {
          var o = all[hit[0]];
          o.scrollIntoView({ block: 'nearest' });
          var r = o.getBoundingClientRect();
          return { x: (host ? host.dx : 0) + r.left + r.width / 2, y: (host ? host.dy : 0) + r.top + r.height / 2, text: bbClip(texts[hit[0]], 120) };
        }
        if (hit.length > 1) return { ambiguous: true, options: texts.slice(0, 15) };
      }
      return { options: texts.slice(0, 15) };
    })()`);
  }

  async function pickOption(session: CdpSession, wanted: string, scopePath?: string): Promise<{ chosen?: string; note?: string }> {
    const deadline = Date.now() + FILL_OPTION_WAIT_MS;
    let found = await findOption(session, wanted, scopePath);
    while (found.x === undefined && !found.ambiguous && Date.now() < deadline) {
      await sleep(150);
      found = await findOption(session, wanted, scopePath);
    }
    if (found.ambiguous) return { note: `several options match "${wanted}": ${(found.options ?? []).join(', ')}` };
    if (found.x === undefined || found.y === undefined) {
      const listed = (found.options ?? []).join(', ');
      return { note: `option not listed${listed ? `; visible options: ${listed}` : ''}` };
    }
    await clickAt(session, { x: found.x, y: found.y });
    return { chosen: found.text };
  }

  /** Enters one value into one field. Returns the option text chosen, or a note when it could not. */
  async function fillField(session: CdpSession, field: FormField, entry: BrowserFillEntry): Promise<{ chosen?: string | string[]; note?: string }> {
    if (field.disabled) return { note: 'field is disabled' };
    if (field.readonly) return { note: 'field is read-only' };
    if (field.type === 'file') return { note: 'file upload is not supported by fill' };
    const value = entry.value;
    if (field.kind === 'checkbox' || field.kind === 'switch' || field.kind === 'radio') {
      const desired = parseChecked(value);
      if (desired === undefined) return { note: 'pass true or false for a checkbox' };
      if (field.kind === 'radio' && !desired && field.checked) return { note: 'a radio button cannot be cleared; choose another option' };
      if (field.checked !== desired) await clickAt(session, await elementPoint(session, field.path, true));
      return {};
    }
    if (field.kind === 'radio-group') {
      if (typeof value !== 'string') return { note: 'pass the option text for a radio group' };
      const match = matchText(field.options ?? [], value);
      if (match.index === undefined) {
        return { note: match.matches.length > 1 ? `several options match "${value}"` : `option not found; options: ${(field.options ?? []).join(', ')}` };
      }
      const optionPath = field.optionPaths?.[match.index];
      if (!optionPath) return { note: 'option is not clickable; use action=click' };
      await clickAt(session, await elementPoint(session, optionPath, true));
      return { chosen: field.options![match.index] };
    }
    const nativeSelect = field.native && (field.kind === 'listbox' || (field.kind === 'combobox' && field.options !== undefined));
    if (nativeSelect) {
      const wanted = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
      if (!wanted) return { note: 'pass the option text for a select' };
      const outcome = await evaluate<any>(session, `(function () {${FORM_FIELD_HELPERS}
        var hit = bbResolve(${JSON.stringify(field.path)});
        var el = hit && hit.el;
        if (!el || el.tagName !== 'SELECT') return { error: 'target is not a select element' };
        var opts = Array.prototype.slice.call(el.options);
        var texts = opts.map(function (o) { return bbClip(o.label || o.text || o.value || '', 120); });
        function pick(w) {
          w = String(w).trim(); var l = w.toLowerCase();
          var tests = [function (i) { return texts[i] === w; }, function (i) { return texts[i].toLowerCase() === l; }, function (i) { return opts[i].value === w; }, function (i) { return l && texts[i].toLowerCase().indexOf(l) >= 0; }];
          for (var k = 0; k < tests.length; k++) {
            var hits = [];
            for (var i = 0; i < opts.length; i++) if (tests[k](i)) hits.push(i);
            if (hits.length === 1 || (hits.length > 1 && k < 3)) return hits[0];
            if (hits.length > 1) return -2;
          }
          return -1;
        }
        var wanted = ${JSON.stringify(wanted)};
        var chosen = [];
        for (var j = 0; j < wanted.length; j++) {
          var idx = pick(wanted[j]);
          if (idx < 0) return { error: (idx === -2 ? 'several options match "' : 'option not found: "') + wanted[j] + '"', options: texts.slice(0, 15) };
          chosen.push(idx);
        }
        if (!el.multiple && chosen.length > 1) return { error: 'this select takes one value' };
        if (el.multiple) { for (var m = 0; m < opts.length; m++) opts[m].selected = chosen.indexOf(m) >= 0; }
        else el.selectedIndex = chosen[0];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { chosen: chosen.map(function (i) { return texts[i]; }) };
      })()`);
      if (outcome?.error) return { note: `${outcome.error}${outcome.options?.length ? `; options: ${outcome.options.join(', ')}` : ''}` };
      const chosen = Array.isArray(outcome?.chosen) ? outcome.chosen.map(String) : [];
      return { chosen: field.kind === 'listbox' ? chosen : chosen[0] };
    }
    if (field.kind === 'listbox') {
      const wanted = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
      if (!wanted) return { note: 'pass the option texts for a list' };
      const chosen: string[] = [];
      for (const item of wanted) {
        const picked = await pickOption(session, item, field.path);
        if (picked.note) return { note: picked.note };
        chosen.push(picked.chosen ?? item);
      }
      return { chosen };
    }
    if (typeof value !== 'string') return { note: 'pass text for this field' };
    if (field.kind === 'combobox' && !field.native) {
      // A custom dropdown: open it, type when it offers a search box, then click the option.
      await clickAt(session, await elementPoint(session, field.path));
      await sleep(250);
      const typing = await evaluate<boolean>(session, `(function () { var a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true); })()`, 3_000).catch(() => false);
      if (typing) await session.send('Input.insertText', { text: value });
      return pickOption(session, value);
    }
    await typeText(session, await elementPoint(session, field.path), value);
    await evaluate(session, `(function () {${FORM_FIELD_HELPERS}
      var hit = bbResolve(${JSON.stringify(field.path)});
      if (!hit) return false;
      var el = hit.el;
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (typeof el.blur === 'function') el.blur();
      return true;
    })()`, 5_000).catch(() => false);
    if (field.kind === 'combobox') {
      // An autocomplete input may show matching options; pick an exact one when listed.
      await sleep(300);
      const listed = await findOption(session, value).catch(() => ({} as { x?: number; y?: number; text?: string }));
      if (listed.x !== undefined && listed.y !== undefined && listed.text?.toLowerCase() === value.trim().toLowerCase()) {
        await clickAt(session, { x: listed.x, y: listed.y });
      }
    }
    return {};
  }

  async function fillTab(tabId: string, input: BrowserHandsInput): Promise<BrowserReceipt> {
    const entries = validateFillFields(input.fields);
    return enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
      const before = await readForm(session);
      if (entries.some(entry => entry.ref)) {
        const previous = refs.get(tabId);
        if (!previous || previous.documentToken !== before.documentToken) {
          throw new BrowserHandsError('STALE_REF', 'These refs belong to an earlier page reading', 'Call read_form and use its refs, or pass labels instead.');
        }
      }
      registerFieldRefs(tabId, before);
      const refsBefore = fieldRefs(before.fields.length);
      const resolutions = resolveFillEntries(entries, before.fields, refsBefore);
      if (resolutions.every(resolution => resolution.index === undefined)) {
        throw new BrowserHandsError(
          'FILL_NOTHING_RESOLVED',
          `No requested field was found: ${resolutions.slice(0, 3).map(resolution => resolution.note).join(' | ')}`,
          'Call read_form and pass refs.',
        );
      }
      const acts = new Map<number, { chosen?: string | string[]; note?: string }>();
      let stopNote: string | undefined;
      const order = resolutions
        .map((resolution, position) => ({ resolution, position }))
        .filter(item => item.resolution.index !== undefined)
        .sort((a, b) => a.resolution.index! - b.resolution.index!);
      for (const { resolution, position } of order) {
        if (stopNote) { acts.set(position, { note: stopNote }); continue; }
        const field = before.fields[resolution.index!];
        try {
          acts.set(position, await fillField(session, field, resolution.entry));
        } catch (error: any) {
          acts.set(position, { note: error instanceof BrowserHandsError ? `${error.message}; ${error.nextAction}` : String(error?.message ?? error).slice(0, 200) });
        }
        if (latestDialog(session)) stopNote = 'not attempted: dialog open';
        else if ((await pageState(session, target)).documentToken !== before.documentToken) {
          stopNote = 'not attempted: page changed';
          refs.delete(tabId);
        }
      }
      const receipt = await settleAndReceipt('fill', tabId, session, target);
      let after: FormField[] = [];
      let afterTruncated = 0;
      const readable = !receipt.dialog && stopNote !== 'not attempted: page changed';
      if (readable) {
        const reread = await readForm(session).catch(() => null);
        if (reread) {
          after = reread.fields;
          afterTruncated = reread.truncated;
          registerFieldRefs(tabId, reread);
        }
      }
      const afterByPath = new Map(after.map(field => [field.path, field]));
      const results: FillResult[] = [];
      for (const [position, resolution] of resolutions.entries()) {
        if (resolution.index === undefined) {
          results.push({ ref: resolution.entry.ref ?? '', label: resolution.entry.label ?? '', requested: '(not set)', actual: '(not set)', ok: false, note: resolution.note });
          continue;
        }
        const field = before.fields[resolution.index];
        const act = acts.get(position) ?? {};
        const now = readable ? afterByPath.get(field.path) : undefined;
        let check: { ok?: boolean; shorter?: boolean; gone?: boolean } | null = null;
        if ((field.withheld || now?.withheld) && !act.note && now && typeof resolution.entry.value === 'string') {
          check = await evaluate<any>(session, withheldLengthExpression(field.path, resolution.entry.value.length), 5_000).catch(() => null);
          if (check && field.maxLength && resolution.entry.value.length > field.maxLength) check = { ok: false, shorter: true };
        }
        const result = fillResult(refsBefore[resolution.index], field, now, resolution.entry, readable ? act : { ...act, note: act.note ?? 'not read back: dialog open' }, check);
        results.push(result);
      }
      return {
        ...receipt,
        results,
        summary: fillSummary(results),
        allSet: results.every(result => result.ok),
        ...(after.length ? { form: { summary: summarizeForm(after, fieldRefs(after.length), afterTruncated), lines: renderFieldLines(after, fieldRefs(after.length)) } } : {}),
      };
    }));
  }

  async function resolveSelector(session: CdpSession, tabId: string, targetInput: BrowserElementTarget | undefined): Promise<string> {
    const explicit = String(targetInput?.selector ?? '').trim();
    if (explicit) return explicit;
    const ref = String(targetInput?.ref ?? '').trim();
    if (!ref) {
      throw new BrowserHandsError('TARGET_REQUIRED', 'This action requires target.ref or target.selector', 'Inspect the page, then pass a returned ref or a CSS selector.');
    }
    const refState = refs.get(tabId);
    const selector = refState?.refs.get(ref);
    if (!refState || !selector) {
      throw new BrowserHandsError('STALE_REF', `Unknown or expired element ref: ${ref}`, 'Inspect the page again and use a current ref.');
    }
    const state = await pageState(session);
    if (state.documentToken !== refState.documentToken) {
      refs.delete(tabId);
      throw new BrowserHandsError('STALE_REF', `Element ref ${ref} belongs to a previous document`, 'Inspect the current page and use a new ref.');
    }
    return selector;
  }

  /**
   * Viewport point of an element by CSS selector or deep path (` >>> ` shadow
   * hosts, `frame:<i>` same-origin iframes). `labelFallback` clicks the label
   * of a visually hidden checkbox/radio instead.
   */
  async function elementPoint(session: CdpSession, selector: string, labelFallback = false): Promise<{ x: number; y: number; tag: string }> {
    const escaped = JSON.stringify(selector);
    const point = await evaluate<any>(session, `(function () {${FORM_FIELD_HELPERS}
      var hit = bbResolve(${escaped});
      if (!hit) return { error: 'selector did not match' };
      var el = hit.el, t = el;
      var first = el.getBoundingClientRect();
      if (${labelFallback} && (first.width <= 0 || first.height <= 0)) {
        var lab = (el.labels && el.labels[0]) || (el.closest ? el.closest('label') : null);
        if (lab) t = lab;
      }
      t.scrollIntoView({ block: 'center', inline: 'center' });
      hit = bbResolve(${escaped}) || hit;
      var rect = t.getBoundingClientRect();
      var style = getComputedStyle(t);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return { error: 'element is not visible' };
      if (t === el && typeof el.focus === 'function') el.focus();
      return { x: hit.dx + rect.left + rect.width / 2, y: hit.dy + rect.top + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()`);
    if (point?.error) {
      throw new BrowserHandsError('ELEMENT_NOT_ACTIONABLE', `${point.error}: ${selector}`, 'Inspect the page and choose a visible element or narrower selector.');
    }
    return point;
  }

  async function clickAt(
    session: CdpSession,
    point: { x: number; y: number },
    clickCount = 1,
    dialogDecision: 'accept' | 'dismiss' = 'dismiss',
    promptText?: string,
  ): Promise<BrowserReceipt['dialog'] | undefined> {
    // Real Chrome suppresses some user-gesture behavior (notably dialogs and
    // popups) from a background target. Bring the owned tab to the front before
    // dispatching the same pointer sequence a person would generate.
    await session.send('Page.bringToFront').catch(() => undefined);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount });
    const eventStart = session.events.length;
    let releaseSettled = false;
    const release = session.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount },
      15_000,
    ).then(() => { releaseSettled = true; });

    // A JavaScript dialog blocks the mouseReleased response. Detect and handle
    // it on the SAME CDP connection; closing this short-lived connection with
    // the dialog pending would make Chrome dismiss it before a later tool call.
    const deadline = Date.now() + 1_000;
    while (!releaseSettled && Date.now() < deadline) {
      const opening = session.events
        .slice(eventStart)
        .find(event => event.method === 'Page.javascriptDialogOpening');
      if (opening) {
        await session.send('Page.handleJavaScriptDialog', {
          accept: dialogDecision === 'accept',
          ...(promptText !== undefined ? { promptText } : {}),
        });
        await release;
        return {
          type: String(opening.params?.type ?? 'dialog'),
          message: String(opening.params?.message ?? ''),
          hasBrowserHandler: Boolean(opening.params?.hasBrowserHandler),
          handled: dialogDecision,
          open: false,
        };
      }
      await sleep(20);
    }
    await release;
    return undefined;
  }

  async function actionOnTab(tabId: string, input: BrowserHandsInput): Promise<BrowserReceipt> {
    return enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
      if (input.action === 'navigate') {
        const url = await assertAllowedPageUrl(input.url);
        refs.delete(tabId);
        await navigate(session, url);
        return settleAndReceipt('navigate', tabId, session, target);
      }

      if (input.action === 'click') {
        const selector = await resolveSelector(session, tabId, input.target);
        const point = await elementPoint(session, selector);
        const handledDialog = await clickAt(
          session,
          point,
          Math.round(clamp(input.clickCount, 1, 3, 1)),
          input.dialog?.decision ?? 'dismiss',
          input.dialog?.promptText,
        );
        return settleAndReceipt('click', tabId, session, target, {
          target: input.target,
          ...(handledDialog ? { dialog: handledDialog } : {}),
        });
      }

      if (input.action === 'type') {
        const selector = await resolveSelector(session, tabId, input.target);
        const point = await elementPoint(session, selector);
        await clickAt(session, point);
        if (input.replace !== false) {
          await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        }
        await session.send('Input.insertText', { text: String(input.text ?? '') });
        return settleAndReceipt('type', tabId, session, target, { target: input.target, characters: String(input.text ?? '').length });
      }

      if (input.action === 'select') {
        const selector = await resolveSelector(session, tabId, input.target);
        const values = Array.isArray(input.values) ? input.values.map(String) : [];
        if (!values.length) {
          throw new BrowserHandsError('VALUES_REQUIRED', 'select requires at least one value', 'Pass values exactly as present in the option value attributes.');
        }
        const outcome = await evaluate<any>(session, `(function () {${FORM_FIELD_HELPERS}
          var hit = bbResolve(${JSON.stringify(selector)});
          var el = hit && hit.el;
          if (!el || el.tagName !== 'SELECT') return { error: 'target is not a select element' };
          var wanted = new Set(${JSON.stringify(values)});
          Array.from(el.options).forEach(function (option) { option.selected = wanted.has(option.value); });
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: Array.from(el.selectedOptions).map(function (option) { return option.value; }) };
        })()`);
        if (outcome?.error) {
          throw new BrowserHandsError('SELECT_FAILED', outcome.error, 'Inspect and target a native <select>, then pass its option values.');
        }
        return settleAndReceipt('select', tabId, session, target, outcome);
      }

      if (input.action === 'key') {
        const key = keyDefinition(String(input.key ?? ''));
        const modifiers = modifierMask(input.modifiers);
        await session.send('Page.bringToFront').catch(() => undefined);
        await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, modifiers });
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, modifiers });
        return settleAndReceipt('key', tabId, session, target, { key: key.key, modifiers: input.modifiers ?? [] });
      }

      if (input.action === 'scroll') {
        let x: number;
        let y: number;
        if (input.target?.ref || input.target?.selector) {
          const selector = await resolveSelector(session, tabId, input.target);
          const point = await elementPoint(session, selector);
          x = point.x;
          y = point.y;
        } else {
          const state = await pageState(session, target);
          x = state.viewport.width / 2;
          y = state.viewport.height / 2;
        }
        const deltaX = clamp(input.deltaX, -10_000, 10_000, 0);
        const deltaY = clamp(input.deltaY, -10_000, 10_000, 700);
        await session.send('Page.bringToFront').catch(() => undefined);
        await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
        return settleAndReceipt('scroll', tabId, session, target, { deltaX, deltaY });
      }

      if (input.action === 'wait') {
        const kind = input.wait?.kind ?? 'load';
        const timeoutMs = Math.round(clamp(input.wait?.timeoutMs, 0, DEFAULT_ACTION_TIMEOUT_MS, 10_000));
        if (kind === 'timeout') {
          await sleep(timeoutMs);
          return settleAndReceipt('wait', tabId, session, target, { wait: { kind, timeoutMs } });
        }
        const startedAt = Date.now();
        const value = String(input.wait?.value ?? '');
        const desiredState = input.wait?.state ?? 'visible';
        let lastObserved: unknown = null;
        while (Date.now() - startedAt <= timeoutMs) {
          if (kind === 'load') {
            lastObserved = await evaluate(session, 'document.readyState', 3_000).catch(() => 'loading');
            if (lastObserved === 'complete') break;
          } else if (kind === 'url') {
            lastObserved = await evaluate(session, 'location.href', 3_000).catch(() => '');
            if (String(lastObserved).includes(value)) break;
          } else if (kind === 'text') {
            lastObserved = await evaluate(session, `(document.body?.innerText || '').includes(${JSON.stringify(value)})`, 3_000).catch(() => false);
            if (lastObserved === true) break;
          } else if (kind === 'selector') {
            if (!value) throw new BrowserHandsError('WAIT_VALUE_REQUIRED', 'wait kind=selector requires wait.value', 'Pass a CSS selector in wait.value.');
            lastObserved = await evaluate<any>(session, `(function () {
              var el = document.querySelector(${JSON.stringify(value)});
              if (!el) return { present: false, visible: false };
              var rect = el.getBoundingClientRect();
              var style = getComputedStyle(el);
              return { present: true, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' };
            })()`, 3_000).catch(() => ({ present: false, visible: false }));
            const observed = lastObserved as any;
            if (
              (desiredState === 'present' && observed.present) ||
              (desiredState === 'visible' && observed.visible) ||
              (desiredState === 'hidden' && observed.present && !observed.visible) ||
              (desiredState === 'absent' && !observed.present)
            ) break;
          }
          await sleep(250);
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new BrowserHandsError('WAIT_TIMEOUT', `Timed out waiting for ${kind}${value ? `: ${value}` : ''}`, 'Inspect the current page state, then adjust the wait condition or continue with what loaded.');
        }
        return settleAndReceipt('wait', tabId, session, target, { wait: { kind, value, state: desiredState, observed: lastObserved } });
      }

      if (input.action === 'dialog') {
        const decision = input.dialog?.decision;
        if (decision !== 'accept' && decision !== 'dismiss') {
          throw new BrowserHandsError('DIALOG_DECISION_REQUIRED', 'dialog.decision must be accept or dismiss', 'Pass dialog: { decision: "accept" } or { decision: "dismiss" }.');
        }
        try {
          await session.send('Page.handleJavaScriptDialog', {
            accept: decision === 'accept',
            ...(input.dialog?.promptText !== undefined ? { promptText: input.dialog.promptText } : {}),
          });
        } catch (error: any) {
          throw new BrowserHandsError('NO_DIALOG', error?.message ?? 'No JavaScript dialog is open', 'Inspect the page or continue with another action.');
        }
        return settleAndReceipt('dialog', tabId, session, target, { decision });
      }

      throw new BrowserHandsError('UNSUPPORTED_ACTION', `Unsupported action: ${input.action}`, 'Use list, open, navigate, inspect, read_form, fill, click, type, select, key, scroll, wait, dialog, or close.');
    }));
  }

  async function execute(input: BrowserHandsInput): Promise<BrowserReceipt> {
    const action = String(input?.action ?? '') as BrowserHandsAction;
    try {
      await initialize();
      if (!['list', 'open', 'navigate', 'inspect', 'read_form', 'fill', 'click', 'type', 'select', 'key', 'scroll', 'wait', 'dialog', 'close'].includes(action)) {
        throw new BrowserHandsError('ACTION_REQUIRED', 'A supported browser action is required', 'Use list, open, navigate, inspect, read_form, fill, click, type, select, key, scroll, wait, dialog, or close.');
      }

      if (action === 'list') {
        const targets = await reconcile();
        const owned = [...tabs.values()].map(entry => {
          const target = targets.get(entry.targetId);
          return {
            tabId: entry.tabId,
            url: target?.url ?? '',
            title: target?.title ?? '',
            ...(entry.openerTabId ? { openerTabId: entry.openerTabId } : {}),
            createdAt: entry.createdAt,
          };
        });
        return { ok: true, action, tabs: owned, count: owned.length };
      }

      if (action === 'open') {
        const url = await assertAllowedPageUrl(input.url);
        const target = await createBlankTarget();
        const tabId = `tab_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        tabs.set(tabId, { tabId, targetId: target.id, createdAt: new Date().toISOString() });
        targetToTab.set(target.id, tabId);
        saveRegistry();
        try {
          return await enqueue(tabId, () => withSession(tabId, async (session, _entry, current) => {
            await navigate(session, url);
            return settleAndReceipt('open', tabId, session, current);
          }));
        } catch (error) {
          return errorReceipt('open', error, tabId);
        }
      }

      const tabId = String(input.tabId ?? '').trim();
      if (!tabId) throw new BrowserHandsError('TAB_ID_REQUIRED', `${action} requires tabId`, 'Call action=list or open, then pass the returned tabId.');

      if (action === 'close') {
        try {
          const entry = tabs.get(tabId);
          if (!entry) throw new BrowserHandsError('TAB_NOT_FOUND', `Unknown browser tabId: ${tabId}`, 'Call action=list to see available tabs.');
          await enqueue(tabId, async () => {
            await cdpHttp(`/json/close/${encodeURIComponent(entry.targetId)}`).catch(async () => {
              const targets = await listChromeTargets();
              if (targets.some(target => target.id === entry.targetId)) throw new Error('Chrome did not close the target');
            });
          });
          forgetTab(tabId);
          return { ok: true, action, tabId, closed: true };
        } catch (error) {
          return errorReceipt(action, error, tabId);
        }
      }

      if (action === 'inspect') return await inspectTab(tabId, input);
      if (action === 'read_form') return await readFormTab(tabId);
      if (action === 'fill') return await fillTab(tabId, input);
      return await actionOnTab(tabId, input);
    } catch (error) {
      return errorReceipt(action || 'list', error, input?.tabId);
    }
  }

  async function screenshot(input: { tabId?: string; fullPage?: boolean; includeModelImage?: boolean }): Promise<{ receipt: BrowserScreenshotReceipt; dataUrl?: string }> {
    const tabId = String(input.tabId ?? '').trim();
    try {
      await initialize();
      if (!tabId) throw new BrowserHandsError('TAB_ID_REQUIRED', 'browser_screenshot requires tabId', 'Call browser_hands action=list or open, then pass the returned tabId.');
      return await enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
        let clip: Record<string, number> | undefined;
        let layoutMetrics: any;
        let clipped = false;
        if (input.fullPage) {
          layoutMetrics = await session.send('Page.getLayoutMetrics');
          const size = layoutMetrics?.cssContentSize ?? layoutMetrics?.contentSize;
          if (size?.width && size?.height) {
            const width = Math.min(16_384, Math.max(1, Number(size.width)));
            const height = Math.min(16_384, Math.max(1, Number(size.height)));
            clipped = width < Number(size.width) || height < Number(size.height);
            clip = { x: 0, y: 0, width, height, scale: 1 };
          }
        }
        const shot = await session.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: Boolean(input.fullPage),
          ...(clip ? { clip } : {}),
        }, 30_000);
        const data = String(shot?.data ?? '');
        if (!data) throw new BrowserHandsError('SCREENSHOT_EMPTY', 'Chrome returned no screenshot data', 'Wait for the page to render, then retry browser_screenshot.');
        const buffer = Buffer.from(data, 'base64');
        const dimensions = pngDimensions(buffer);
        fs.mkdirSync(filesDir, { recursive: true });
        const filename = `browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${tabId}.png`;
        const filePath = path.join(filesDir, filename);
        fs.writeFileSync(filePath, buffer, { mode: 0o600 });
        const state = await pageState(session, target);
        const newTabs = await adoptPopups(session);

        // Registry-backed inspection reads the exact PNG later through a
        // compact visual-reader call. Do not spend time/quality deriving a
        // JPEG sidecar that the production tool path will intentionally omit.
        if (input.includeModelImage === false) {
          return {
            receipt: {
              ok: true,
              action: 'screenshot',
              tabId,
              url: state.url,
              title: state.title,
              readyState: state.readyState,
              filePath,
              fileUrl: `/api/files/browser-hands/${encodeURIComponent(filename)}`,
              bytes: buffer.length,
              width: dimensions.width,
              height: dimensions.height,
              fullPage: Boolean(input.fullPage),
              clipped,
              modelImageIncluded: false,
              ...(latestDialog(session) ? { dialog: latestDialog(session) } : {}),
              ...(newTabs.length ? { newTabs } : {}),
            },
          };
        }

        const modelPath = path.join(filesDir, `.${filename}.${randomUUID()}.model.jpg`);
        const deriveModel = async (maximumDimension: number, quality: number) => {
          try {
            await deriveModelJpeg(filePath, modelPath, maximumDimension, quality);
            const modelBuffer = fs.readFileSync(modelPath);
            return {
              modelData: modelBuffer.toString('base64'),
              modelBuffer,
              modelDimensions: jpegDimensions(modelBuffer),
            };
          } finally {
            fs.rmSync(modelPath, { force: true });
          }
        };
        let model = await deriveModel(MODEL_SCREENSHOT_MAX_DIMENSION, 70);
        if (model.modelBuffer.length > MODEL_SCREENSHOT_MAX_BYTES) {
          model = await deriveModel(MODEL_SCREENSHOT_FALLBACK_DIMENSION, 55);
        }
        if (model.modelBuffer.length > MODEL_SCREENSHOT_MAX_BYTES) {
          throw new BrowserHandsError(
            'MODEL_SCREENSHOT_TOO_LARGE',
            `Model screenshot remains ${model.modelBuffer.length} bytes after optimization`,
            'Capture a smaller viewport or inspect/scroll to a more focused region before retrying.',
          );
        }

        const receipt: BrowserScreenshotReceipt = {
          ok: true,
          action: 'screenshot',
          tabId,
          url: state.url,
          title: state.title,
          readyState: state.readyState,
          filePath,
          fileUrl: `/api/files/browser-hands/${encodeURIComponent(filename)}`,
          bytes: buffer.length,
          width: dimensions.width,
          height: dimensions.height,
          fullPage: Boolean(input.fullPage),
          clipped,
          modelImageIncluded: true,
          modelImageMime: 'image/jpeg',
          modelImageBytes: model.modelBuffer.length,
          modelImageWidth: model.modelDimensions.width,
          modelImageHeight: model.modelDimensions.height,
          ...(latestDialog(session) ? { dialog: latestDialog(session) } : {}),
          ...(newTabs.length ? { newTabs } : {}),
        };
        return { receipt, dataUrl: `data:image/jpeg;base64,${model.modelData}` };
      }));
    } catch (error) {
      return { receipt: errorReceipt('screenshot', error, tabId || undefined) as BrowserScreenshotReceipt };
    }
  }

  return {
    initialize,
    execute,
    screenshot,
    ownsTarget(targetId: string): boolean {
      return targetToTab.has(targetId);
    },
  };
}
