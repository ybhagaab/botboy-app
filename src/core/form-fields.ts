/**
 * Form fields: what a person typed, chose, or ticked on a web page, read the
 * same way by the passive browser monitor and by browser hands.
 *
 * `innerText` never contains a field's current value (`input.value`,
 * `select.selectedOptions`, `checked`, contenteditable text), so both readers
 * run one in-page field reader. Its rules are the single withholding source:
 *
 *  - Structural withholding runs INSIDE the page: password inputs, secret
 *    autocomplete tokens, fields whose name/id/label matches
 *    `SENSITIVE_FIELD_PATTERN`, and masked (`-webkit-text-security`) fields
 *    report only whether they are filled. Their value never crosses CDP.
 *  - Hidden inputs are skipped entirely (CSRF/SAML/state tokens live there).
 *  - Format withholding runs in Node immediately on receipt
 *    (`sanitizeFields` → `sensitive-files.ts › detectSecrets`), and every
 *    render passes `redactSecrets`.
 */
import { createHash } from 'node:crypto';
import { detectSecrets, redactSecrets } from './sensitive-files.js';

/**
 * Field names, ids, labels, and autocomplete values that mark a secret or a
 * sensitive identifier. Fails closed: "Secret Santa" or "PIN code" fields are
 * withheld too, because a withheld benign field costs one label while a leaked
 * secret cannot be taken back. NRIC/FIN/TFN are national identifiers.
 */
export const SENSITIVE_FIELD_PATTERN = /pass(word|wd|code|phrase)?\b|\bpwd\b|\bpin\b|\botp\b|one[\s_-]?time|\bcvv2?\b|\bcvc\b|security[\s_-]?code|card[\s_-]?(number|no)|\bcc[\s_-]?num|\bpan\b|\bssn\b|social[\s_-]?security|\bnric\b|\bfin\b|\btfn\b|secret|api[\s_-]?key|token/i;

export const WITHHELD = '[withheld]';
export const MAX_FIELDS = 150;
const MAX_FIELDS_SECTION_CHARS = 20_000;
const MAX_VALUE_CHARS = 300;
const MAX_LINE_OPTIONS = 12;

export type FormFieldKind = 'textbox' | 'combobox' | 'listbox' | 'checkbox' | 'radio' | 'switch' | 'radio-group';
const KINDS: ReadonlySet<string> = new Set(['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'radio-group']);

export interface FormField {
  kind: FormFieldKind;
  label: string;
  /** Text value, selected option text, or selected option texts. Absent when withheld. */
  value?: string | string[];
  checked?: boolean;
  /** Option texts (selects, listboxes, radio groups). */
  options?: string[];
  withheld?: true;
  /** Whether the field holds anything (the only fact a withheld field reports). */
  filled?: boolean;
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  invalid?: boolean;
  masked?: boolean;
  /** Input type when not plain text (email, date, number, tel, file, …). */
  type?: string;
  maxLength?: number;
  /** True for a native control backed by `.value` (input/textarea/select). */
  native?: boolean;
  /** Deep selector: CSS, with ` >>> ` for shadow hosts and `frame:<i>` for same-origin iframes. */
  path: string;
  /** Radio group: one deep selector per option, in `options` order. */
  optionPaths?: string[];
}

/**
 * In-page helper functions (ES5, no template literals). Shared by the field
 * reader, the HTML redaction, and browser hands' deep resolver.
 */
const PRELUDE = String.raw`
var BB_PATTERN = new RegExp(${JSON.stringify(SENSITIVE_FIELD_PATTERN.source)}, ${JSON.stringify(SENSITIVE_FIELD_PATTERN.flags)});
function bbEsc(v) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(v);
  return String(v).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
}
function bbText(n) {
  if (!n) return '';
  var t = n.innerText;
  if (typeof t !== 'string' || !t) t = n.textContent || '';
  return String(t).replace(/\s+/g, ' ').trim();
}
function bbClip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function bbRoot(el) { return el.getRootNode ? el.getRootNode() : el.ownerDocument; }
function bbById(root, id) {
  try { return root.getElementById ? root.getElementById(id) : root.querySelector('#' + bbEsc(id)); } catch (e) { return null; }
}
function bbLabelText(label) {
  if (!label) return '';
  var c = label.cloneNode(true);
  var inner = c.querySelectorAll('input,select,textarea,button,[contenteditable]');
  for (var i = 0; i < inner.length; i++) inner[i].remove();
  return bbText(c);
}
function bbOwnLabel(el) {
  var root = bbRoot(el), t = '';
  var by = el.getAttribute('aria-labelledby');
  if (by) {
    t = by.split(/\s+/).map(function (id) { return bbText(bbById(root, id)); }).filter(Boolean).join(' ');
    if (t) return t;
  }
  t = (el.getAttribute('aria-label') || '').trim();
  if (t) return t;
  if (el.id) {
    try { t = bbLabelText(root.querySelector('label[for="' + bbEsc(el.id) + '"]')); } catch (e) { t = ''; }
    if (t) return t;
  }
  var wrap = el.closest ? el.closest('label') : null;
  if (wrap) { t = bbLabelText(wrap); if (t) return t; }
  return '';
}
function bbContextLabel(el, group) {
  var t = (el.getAttribute('title') || '').trim();
  if (t) return t;
  t = (el.getAttribute('placeholder') || '').trim();
  if (t) return t;
  if (group) {
    var fs = el.closest ? el.closest('fieldset') : null;
    if (fs) { t = bbText(fs.querySelector('legend')); if (t) return t; }
  }
  var n = el, depth = 0;
  while (n && depth < 2) {
    var p = n.previousElementSibling;
    while (p && !bbText(p)) p = p.previousElementSibling;
    if (p) { t = bbText(p); if (t && t.length <= 80) return t; break; }
    n = n.parentElement; depth++;
  }
  t = el.getAttribute('name') || '';
  if (t) return t;
  return '(unlabeled ' + el.tagName.toLowerCase() + ')';
}
function bbLabel(el) { return bbClip(bbOwnLabel(el) || bbContextLabel(el, false), 120); }
function bbMasked(el) {
  try {
    var s = getComputedStyle(el);
    var v = (s.getPropertyValue && s.getPropertyValue('-webkit-text-security')) || s.webkitTextSecurity || '';
    return !!v && v !== 'none';
  } catch (e) { return false; }
}
function bbSensitive(el, label) {
  var type = (el.getAttribute('type') || '').toLowerCase();
  if (el.tagName === 'INPUT' && type === 'password') return true;
  var ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  for (var i = 0; i < ac.length; i++) {
    if (ac[i] === 'current-password' || ac[i] === 'new-password' || ac[i] === 'one-time-code' || ac[i].indexOf('cc-') === 0) return true;
  }
  var hay = [el.getAttribute('name'), el.id, label, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('autocomplete')]
    .filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.\-]+/g, ' ');
  if (BB_PATTERN.test(hay)) return true;
  return bbMasked(el);
}
function bbResolve(path) {
  var segs = String(path).split(' >>> ');
  var root = document, dx = 0, dy = 0, el = null;
  for (var i = 0; i < segs.length; i++) {
    var m = /^frame:(\d+)$/.exec(segs[i]);
    if (m) {
      var f = root.querySelectorAll('iframe')[Number(m[1])];
      if (!f) return null;
      var r = f.getBoundingClientRect();
      dx += r.left + (f.clientLeft || 0); dy += r.top + (f.clientTop || 0);
      try { root = f.contentDocument; } catch (e) { root = null; }
      if (!root) return null;
      continue;
    }
    el = root.querySelector(segs[i]);
    if (!el) return null;
    if (i < segs.length - 1) { root = el.shadowRoot; if (!root) return null; }
  }
  return el ? { el: el, dx: dx, dy: dy } : null;
}
`;

/** The field reader: `botboyCollectFields(max)` → `{ fields, elements, truncated }`. */
const COLLECT = String.raw`
function botboyCollectFields(maxFields) {
  var QUERY = 'input,textarea,select,[contenteditable],[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"],[role="checkbox"],[role="switch"],[role="radio"]';
  var fields = [], elements = [], groups = {}, total = 0;
  function visible(el) {
    if (el.closest && (el.closest('[hidden]') || el.closest('[aria-hidden="true"]'))) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function labelEl(el) { return (el.labels && el.labels[0]) || (el.closest ? el.closest('label') : null); }
  function editable(el) { var ce = el.getAttribute('contenteditable'); return ce !== null && ce.toLowerCase() !== 'false'; }
  function css(el) {
    var root = bbRoot(el);
    if (el.id) { try { if (root.querySelectorAll('#' + bbEsc(el.id)).length === 1) return '#' + bbEsc(el.id); } catch (e) {} }
    var parts = [], n = el;
    while (n && n.nodeType === 1) {
      var part = n.tagName.toLowerCase();
      var holder = n.parentElement || n.parentNode;
      var sibs = holder && holder.children ? holder.children : null;
      if (sibs) {
        var same = Array.prototype.filter.call(sibs, function (c) { return c.tagName === n.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
      if (!n.parentElement) break;
      n = n.parentElement;
    }
    return parts.join(' > ');
  }
  function kindOf(el) {
    var tag = el.tagName, role = (el.getAttribute('role') || '').toLowerCase(), type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'INPUT') {
      if (type === 'hidden' || type === 'submit' || type === 'reset' || type === 'button' || type === 'image') return '';
      if (type === 'checkbox') return role === 'switch' ? 'switch' : 'checkbox';
      if (type === 'radio') return 'radio';
      if (role === 'combobox') return 'combobox';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (el.querySelector('input,select,textarea')) return '';
    if (role === 'textbox' || role === 'searchbox') return 'textbox';
    if (role === 'combobox') return 'combobox';
    if (role === 'listbox') {
      var root = bbRoot(el);
      if (el.id && root.querySelector('[aria-controls~="' + bbEsc(el.id) + '"],[aria-owns~="' + bbEsc(el.id) + '"]')) return '';
      return 'listbox';
    }
    if (role === 'checkbox') return 'checkbox';
    if (role === 'switch') return 'switch';
    if (role === 'radio') return 'radio';
    if (editable(el)) {
      var up = el.parentElement && el.parentElement.closest ? el.parentElement.closest('[contenteditable]') : null;
      if (up && editable(up)) return '';
      return 'textbox';
    }
    return '';
  }
  function optText(o) { return bbClip(o.label || o.text || o.value || '', 120); }
  function clipValue(v) { v = String(v == null ? '' : v); return v.length > 300 ? v.slice(0, 299) + '…' : v; }
  function markers(el, out) {
    if (el.required || el.getAttribute('aria-required') === 'true') out.required = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.closest && el.closest('fieldset[disabled]'))) out.disabled = true;
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true') out.readonly = true;
    if (el.getAttribute('aria-invalid') === 'true' || (el.validity && !el.validity.valid && el.value)) out.invalid = true;
  }
  function push(entry, el) {
    total++;
    if (fields.length >= maxFields) return;
    fields.push(entry); elements.push(el);
  }
  function readOne(el, path, frame) {
    var kind = kindOf(el);
    if (!kind) return;
    var tag = el.tagName, type = (el.getAttribute('type') || 'text').toLowerCase();
    var native = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (!visible(el)) {
      var lab = (kind === 'checkbox' || kind === 'radio' || kind === 'switch') && native ? labelEl(el) : null;
      if (!lab || !visible(lab)) return;
    }
    if (kind === 'radio' && native && el.name) {
      var key = String(frame) + '|' + (el.form ? css(el.form) : '') + '|' + el.name;
      var optLabel = bbClip(bbOwnLabel(el) || el.value || bbContextLabel(el, false), 120);
      var g = groups[key];
      if (!g) {
        var holder = el.closest ? el.closest('[role="radiogroup"]') : null;
        var glabel = holder ? bbClip(bbOwnLabel(holder), 120) : '';
        if (!glabel) { var fs = el.closest ? el.closest('fieldset') : null; glabel = fs ? bbClip(bbText(fs.querySelector('legend')), 120) : ''; }
        g = { kind: 'radio-group', label: glabel || el.name, value: '', options: [], optionPaths: [], path: path, native: true, filled: false };
        if (frame >= 0) g.frame = frame;
        groups[key] = g;
        push(g, el);
      }
      if (g.options.length < 50) { g.options.push(optLabel); g.optionPaths.push(path); }
      if (el.checked) { g.value = optLabel; g.filled = true; }
      markers(el, g);
      return;
    }
    var label = bbLabel(el);
    if (kind === 'radio' || kind === 'checkbox' || kind === 'switch') label = bbClip(bbOwnLabel(el) || bbContextLabel(el, true), 120);
    var out = { kind: kind, label: label, path: path, native: native };
    if (frame >= 0) out.frame = frame;
    if (tag === 'INPUT' && type !== 'text' && type !== 'checkbox' && type !== 'radio') out.type = type;
    if (native && el.maxLength > 0) out.maxLength = el.maxLength;
    markers(el, out);
    if (kind === 'checkbox' || kind === 'switch' || kind === 'radio') {
      out.checked = native ? !!el.checked : el.getAttribute('aria-checked') === 'true';
      out.filled = out.checked;
      push(out, el);
      return;
    }
    if (bbSensitive(el, label)) {
      out.withheld = true;
      if (bbMasked(el)) out.masked = true;
      var len = native ? String(el.value || '').length : bbText(el).length;
      out.filled = len > 0;
      push(out, el);
      return;
    }
    if (tag === 'SELECT') {
      var opts = Array.prototype.slice.call(el.options, 0, 50);
      out.options = opts.map(optText);
      var picked = Array.prototype.map.call(el.selectedOptions || [], optText);
      // A placeholder option ("Choose…", value "") selected means nothing is chosen yet.
      var current = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      out.value = kind === 'listbox' ? picked : (current && current.value !== '' ? (picked[0] || '') : '');
    } else if (kind === 'listbox') {
      var ropts = Array.prototype.slice.call(el.querySelectorAll('[role="option"]'), 0, 50);
      out.options = ropts.map(bbText).map(function (t) { return bbClip(t, 120); });
      out.value = ropts.filter(function (o) { return o.getAttribute('aria-selected') === 'true'; }).map(function (o) { return bbClip(bbText(o), 120); });
    } else if (type === 'file' && tag === 'INPUT') {
      out.value = Array.prototype.map.call(el.files || [], function (f) { return f.name; }).join(', ');
    } else if (native) {
      out.value = clipValue(el.value);
    } else if (kind === 'combobox') {
      var active = el.getAttribute('aria-activedescendant');
      out.value = clipValue(el.getAttribute('aria-valuetext') || bbText(el) || (active ? bbText(bbById(bbRoot(el), active)) : ''));
    } else {
      out.value = clipValue(el.innerText || el.textContent || '');
    }
    out.filled = Array.isArray(out.value) ? out.value.length > 0 : String(out.value).trim().length > 0;
    push(out, el);
  }
  function walk(root, prefix, depth, frame) {
    if (!root || depth > 6) return;
    var list = root.querySelectorAll(QUERY);
    for (var i = 0; i < list.length; i++) readOne(list[i], prefix + css(list[i]), frame);
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) walk(all[j].shadowRoot, prefix + css(all[j]) + ' >>> ', depth + 1, frame);
    }
    var frames = root.querySelectorAll('iframe');
    for (var k = 0; k < frames.length; k++) {
      var doc = null;
      try { doc = frames[k].contentDocument; } catch (e) { doc = null; }
      if (doc && doc.documentElement) walk(doc, prefix + 'frame:' + k + ' >>> ', depth + 1, frame >= 0 ? frame : k);
    }
  }
  walk(document, '', 0, -1);
  return { fields: fields, elements: elements, truncated: Math.max(0, total - fields.length) };
}
`;

/** In-page function declarations: helpers + `botboyCollectFields` + `bbResolve`. */
export const FORM_FIELD_FUNCTIONS = PRELUDE + COLLECT;

/** In-page helpers alone (`bbResolve` deep selector, labels, withholding). */
export const FORM_FIELD_HELPERS = PRELUDE;

/** An in-page expression returning `JSON.stringify({ fields, truncated })`. */
export function formFieldsReaderSource(options: { maxFields: number }): string {
  const max = Math.max(1, Math.min(MAX_FIELDS, Math.round(options.maxFields)));
  return `(function () {${FORM_FIELD_FUNCTIONS}
  try {
    var r = botboyCollectFields(${max});
    return JSON.stringify({ fields: r.fields, truncated: r.truncated });
  } catch (e) { return ''; }
})()`;
}

export const FORM_FIELDS_READER = formFieldsReaderSource({ maxFields: MAX_FIELDS });

/**
 * In-page `botboyRedactedHtml(element)`: serializes a clone with every hidden
 * input's `value` removed and every withheld control set to `[withheld]`.
 * `outerHTML` serializes attributes only (never the live `.value`), so these
 * two steps cover what a page's HTML can leak.
 */
export const HTML_FIELD_REDACTION_SNIPPET = PRELUDE + String.raw`
function botboyRedactedHtml(top) {
  if (!top) return '';
  var clone = top.cloneNode(true);
  var sel = 'input,textarea,select,[contenteditable]';
  var a = top.querySelectorAll(sel), b = clone.querySelectorAll(sel);
  for (var i = 0; i < a.length && i < b.length; i++) {
    var o = a[i], c = b[i];
    var type = (o.getAttribute('type') || '').toLowerCase();
    if (o.tagName === 'INPUT' && type === 'hidden') { c.removeAttribute('value'); continue; }
    var sensitive = false;
    try { sensitive = bbSensitive(o, bbLabel(o)); } catch (e) { sensitive = true; }
    if (!sensitive) continue;
    if (o.tagName === 'INPUT') c.setAttribute('value', '[withheld]');
    else if (o.tagName !== 'SELECT') c.textContent = '[withheld]';
  }
  return clone.outerHTML;
}
`;

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function looksSecret(value: string): boolean {
  return value.length >= 8 && detectSecrets(value).length > 0;
}

/**
 * Node-side check of the reader's raw output: drops malformed entries and
 * withholds any value or option that matches a secret format.
 */
export function sanitizeFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  const out: FormField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.kind !== 'string' || !KINDS.has(item.kind) || typeof item.label !== 'string' || typeof item.path !== 'string') continue;
    const field: FormField = { kind: item.kind as FormFieldKind, label: cleanString(item.label, 120) ?? '', path: item.path };
    for (const flag of ['required', 'disabled', 'readonly', 'invalid', 'masked', 'native'] as const) {
      if (item[flag] === true) field[flag] = true;
    }
    if (typeof item.type === 'string') field.type = item.type.slice(0, 20);
    if (typeof item.maxLength === 'number' && item.maxLength > 0) field.maxLength = item.maxLength;
    if (typeof item.checked === 'boolean') field.checked = item.checked;
    if (Array.isArray(item.optionPaths)) field.optionPaths = item.optionPaths.filter((p): p is string => typeof p === 'string');
    if (item.withheld === true) {
      field.withheld = true;
      field.filled = item.filled === true;
      out.push(field);
      continue;
    }
    let secret = false;
    if (Array.isArray(item.options)) {
      field.options = item.options.filter((o): o is string => typeof o === 'string').map(o => cleanString(o, 120)!);
      if (field.options.some(looksSecret)) secret = true;
    }
    if (typeof item.value === 'string') {
      field.value = cleanString(item.value, MAX_VALUE_CHARS);
    } else if (Array.isArray(item.value)) {
      field.value = item.value.filter((v): v is string => typeof v === 'string').map(v => cleanString(v, 120)!);
    }
    const values = Array.isArray(field.value) ? field.value : field.value !== undefined ? [field.value] : [];
    if (values.some(looksSecret)) secret = true;
    if (secret) {
      delete field.value;
      delete field.options;
      delete field.optionPaths;
      field.withheld = true;
      field.filled = true;
      out.push(field);
      continue;
    }
    if (field.kind === 'checkbox' || field.kind === 'switch' || field.kind === 'radio') field.filled = field.checked === true;
    else field.filled = values.some(v => v.trim().length > 0);
    out.push(field);
  }
  return out;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function markerList(field: FormField): string[] {
  const out: string[] = [];
  if (field.required) out.push('required');
  if (field.disabled) out.push('disabled');
  if (field.readonly) out.push('readonly');
  if (field.invalid) out.push('invalid');
  if (field.masked) out.push('masked');
  return out;
}

function optionList(options: string[] | undefined): string {
  if (!options?.length) return '';
  const shown = options.slice(0, MAX_LINE_OPTIONS).join(', ');
  return options.length > MAX_LINE_OPTIONS ? `${shown}, +${options.length - MAX_LINE_OPTIONS} more` : shown;
}

/** One field's value for the monitor's Fields section. */
function sectionValue(field: FormField): string {
  if (field.withheld) return `${WITHHELD}${field.filled ? '' : ' (empty)'}`;
  if (field.kind === 'checkbox' || field.kind === 'switch' || field.kind === 'radio') return field.checked ? '☑' : '☐';
  const value = Array.isArray(field.value) ? field.value.join(', ') : (field.value ?? '');
  const shown = value.trim() ? value : '(empty)';
  return field.kind === 'radio-group' && field.options?.length ? `${shown} (options: ${optionList(field.options)})` : shown;
}

/**
 * The monitor's readable Fields section, or '' when the page has no fields.
 * `Label: value [required]`, `Label: [withheld]`, `Label: ☑`.
 */
export function renderFieldsSection(fields: FormField[], truncated = 0): string {
  if (!fields.length) return '';
  const lines: string[] = [];
  let chars = 0;
  let shown = 0;
  for (const field of fields.slice(0, MAX_FIELDS)) {
    const marks = markerList(field);
    const line = `${field.label}: ${sectionValue(field)}${marks.length ? ` [${marks.join(', ')}]` : ''}`;
    if (chars + line.length > MAX_FIELDS_SECTION_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
    shown++;
  }
  const more = fields.length - shown + truncated;
  if (more > 0) lines.push(`(+${more} more fields)`);
  return redactSecrets(`--- Fields (${fields.length + truncated}) ---\n${lines.join('\n')}`);
}

/** Compact per-field lines for browser hands: `r12 textbox "Religion" value="Christianity" required`. */
export function renderFieldLines(fields: FormField[], refs: string[]): string[] {
  return fields.map((field, index) => {
    const ref = refs[index] ?? `f${index + 1}`;
    const parts = [ref, field.kind, quote(field.label)];
    if (field.withheld) {
      parts.push(WITHHELD, field.filled ? 'filled' : 'empty');
    } else if (field.kind === 'checkbox' || field.kind === 'switch' || field.kind === 'radio') {
      parts.push(field.checked ? 'checked' : 'unchecked');
    } else if (field.kind === 'listbox') {
      const values = Array.isArray(field.value) ? field.value : [];
      parts.push(values.length ? `selected=[${values.join(', ')}]` : 'empty');
    } else {
      const value = Array.isArray(field.value) ? field.value.join(', ') : (field.value ?? '');
      const key = field.kind === 'textbox' ? 'value' : 'selected';
      parts.push(value.trim() ? `${key}=${quote(value)}` : 'empty');
    }
    if (field.type) parts.push(`type=${field.type}`);
    parts.push(...markerList(field));
    if ((field.kind === 'radio-group' || field.kind === 'combobox' || field.kind === 'listbox') && field.options?.length && field.options.length <= MAX_LINE_OPTIONS) {
      parts.push(`options=[${optionList(field.options)}]`);
    }
    return redactSecrets(parts.join(' '));
  });
}

/** `Form: 14 fields, 9 filled, 5 empty (required empty: r3 "Postal code", r7 "Religion")`. */
export function summarizeForm(fields: FormField[], refs: string[], truncated = 0): string {
  const filled = fields.filter(f => f.filled).length;
  const requiredEmpty = fields
    .map((field, index) => ({ field, ref: refs[index] ?? `f${index + 1}` }))
    .filter(({ field }) => field.required && !field.filled && !field.disabled)
    .map(({ field, ref }) => `${ref} ${quote(field.label)}`);
  const total = fields.length + truncated;
  let line = `Form: ${total} field${total === 1 ? '' : 's'}, ${filled} filled, ${fields.length - filled} empty`;
  if (requiredEmpty.length) line += ` (required empty: ${requiredEmpty.join(', ')})`;
  if (truncated) line += ` (+${truncated} more fields not listed)`;
  if (!fields.length) line = 'Form: no fields on this page';
  return redactSecrets(line);
}

/**
 * Change-detection key for a field list. Withheld fields contribute only
 * whether they are filled, so a password edit is not even visible as a change
 * unless the field goes from empty to filled.
 */
export function fieldsFingerprint(fields: FormField[]): string {
  const lines = fields.map(field => (field.withheld
    ? `${field.label}|withheld|${field.filled ? 1 : 0}`
    : `${field.kind}|${field.label}|${JSON.stringify(field.value ?? null)}|${field.checked ?? ''}`));
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

/** Parses the reader's JSON answer; anything malformed reads as unread (`null`). */
export function parseFieldsAnswer(raw: unknown): { fields: FormField[]; truncated: number } | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.fields)) return null;
    return { fields: sanitizeFields(parsed.fields), truncated: Number(parsed.truncated) > 0 ? Number(parsed.truncated) : 0 };
  } catch {
    return null;
  }
}
