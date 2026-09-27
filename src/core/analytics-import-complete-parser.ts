import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AnalyticsDataCell, AnalyticsLogicalType } from './analytics-data-room-types.js';
import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import type { DocumentParser } from './document-parser.js';

export const ANALYTICS_IMPORT_COMPLETE_PARSER_VERSION = 'botboy-xlsx-complete-v1';
export const ANALYTICS_IMPORT_HEADER_POLICY_VERSION = 'coordinate-preserving-v1';
export const ANALYTICS_IMPORT_DATE_POLICY_VERSION = 'excel-1900-1904-v1';
export const ANALYTICS_IMPORT_FORMULA_POLICY_VERSION = 'cached-value-disclosed-v1';
export const ANALYTICS_IMPORT_ERROR_POLICY_VERSION = 'errors-explicit-v1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_WORKBOOK_XML_BYTES = 4 * 1024 * 1024;
const MAX_STYLES_XML_BYTES = 16 * 1024 * 1024;
const MAX_SHARED_STRINGS_BYTES = 32 * 1024 * 1024;
const MAX_WORKSHEET_XML_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 512;
const MAX_CELLS = 500_000;
const MAX_MATERIALIZED_SLOTS = 2_000_000;
const MAX_MERGES = 100_000;
const MAX_CELL_TEXT = 1_000_000;

export type AnalyticsImportCellKind = AnalyticsLogicalType | 'error' | 'blank' | 'time';

export interface AnalyticsImportCompleteCell {
  reference: string;
  row: number;
  column: number;
  columnName: string;
  kind: AnalyticsImportCellKind;
  value: AnalyticsDataCell;
  raw?: string;
  formula?: string;
  numberFormat?: string;
}

export interface AnalyticsImportCompleteRow {
  rowNumber: number;
  cells: Array<AnalyticsImportCompleteCell | null>;
}

export interface AnalyticsImportColumnProfile {
  column: number;
  columnName: string;
  nonNull: number;
  kinds: Partial<Record<AnalyticsImportCellKind, number>>;
  formulaCells: number;
  samples: AnalyticsDataCell[];
}

export interface AnalyticsImportCompleteProfile {
  parserVersion: typeof ANALYTICS_IMPORT_COMPLETE_PARSER_VERSION;
  headerPolicyVersion: typeof ANALYTICS_IMPORT_HEADER_POLICY_VERSION;
  datePolicyVersion: typeof ANALYTICS_IMPORT_DATE_POLICY_VERSION;
  formulaPolicyVersion: typeof ANALYTICS_IMPORT_FORMULA_POLICY_VERSION;
  errorPolicyVersion: typeof ANALYTICS_IMPORT_ERROR_POLICY_VERSION;
  completeToEof: true;
  sheetName: string;
  dateSystem: '1900' | '1904';
  rowCount: number;
  nonEmptyRowCount: number;
  columnCount: number;
  cellCount: number;
  formulaCellCount: number;
  formulaWithoutCachedValueCount: number;
  errorCellCount: number;
  mergedRangeCount: number;
  firstRow: number | null;
  lastRow: number | null;
  columns: AnalyticsImportColumnProfile[];
  limitations: string[];
  inputSha256: string;
  parseSha256: string;
  profileSha256: string;
  rowsetSha256: string;
  schemaSha256: string;
}

export interface AnalyticsImportCompleteParseResult {
  rows: AnalyticsImportCompleteRow[];
  mergedRanges: string[];
  profile: AnalyticsImportCompleteProfile;
}

export interface ParseAnalyticsImportSheetInput {
  filePath: string;
  sourceSha256: string;
  sourceBytes: number;
  sheetName: string;
  documentParser: DocumentParser;
  signal?: AbortSignal;
}

export class AnalyticsImportCompleteParserError extends Error {
  constructor(message: string, readonly code: 'invalid_input' | 'too_large' | 'integrity_failed' | 'aborted' = 'invalid_input') {
    super(message);
    this.name = 'AnalyticsImportCompleteParserError';
  }
}

function fail(message: string, code: AnalyticsImportCompleteParserError['code'] = 'invalid_input'): never {
  throw new AnalyticsImportCompleteParserError(message, code);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('Complete workbook parsing was interrupted.', 'aborted');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return fail(`Workbook ${label} is not valid UTF-8.`, 'integrity_failed');
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributes(value: string): Map<string, string> {
  const source = value.trim().replace(/\/\s*$/, '').trim();
  if (source.includes('<')) fail('XML attribute values cannot contain a raw element delimiter.', 'integrity_failed');
  const result = new Map<string, string>();
  const pattern = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1];
    if (result.has(key)) fail(`XML attribute ${key} is duplicated.`, 'integrity_failed');
    result.set(key, decodeXml(match[2] ?? match[3] ?? ''));
  }
  const remainder = source.replace(pattern, '').replace(/\s+/g, '');
  if (remainder) fail('XML attributes are malformed.', 'integrity_failed');
  return result;
}

function localName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

/** Strict bounded XML well-formedness gate for the SpreadsheetML subset used below. */
function validateXmlDocument(xml: string, expectedRoot: string): void {
  const withoutDeclaration = xml.replace(/^\uFEFF?\s*<\?xml\b[^?]*(?:\?(?!>)[^?]*)*\?>/, '');
  if (/<!DOCTYPE\b/i.test(xml) || /<!ENTITY\b/i.test(xml) || /<!\[CDATA\[/i.test(xml)
    || xml.includes(']]>')
    || /<\?/.test(withoutDeclaration)
    || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(xml)) {
    fail('Workbook XML contains unsupported declarations or entities.', 'integrity_failed');
  }
  const stack: string[] = [];
  let root = '';
  let rootClosed = false;
  let cursor = 0;
  const token = /<!--[\s\S]*?-->|<\?[^?]*(?:\?(?!>)[^?]*)*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/g;
  for (const match of xml.matchAll(token)) {
    const index = match.index ?? 0;
    const between = xml.slice(cursor, index);
    // Office extension lists (<extLst><ext …>) carry optional features such as
    // x15:workbookPr or x14 conditional formats. No cell data is ever read from
    // them, so their namespaced children are opaque here rather than shadows.
    const inExtension = stack.some(element => localName(element) === 'extLst');
    if (between.trim() && !inExtension) {
      if (!stack.length) fail('Workbook XML contains text outside its root element.', 'integrity_failed');
      const parent = localName(stack.at(-1)!);
      if (!['t', 'v', 'f', 'definedName'].includes(parent)) {
        fail(`Workbook XML contains character data inside structural element ${parent}.`, 'integrity_failed');
      }
    }
    const value = match[0];
    cursor = index + value.length;
    if (value.startsWith('<!--') || value.startsWith('<?') || value.startsWith('<![CDATA[')) continue;
    const closing = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/.exec(value);
    if (closing) {
      if (stack.pop() !== closing[1]) fail('Workbook XML element nesting is malformed.', 'integrity_failed');
      if (!stack.length) rootClosed = true;
      continue;
    }
    const opening = /^<([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*?)(\/?)>$/.exec(value);
    if (!opening) fail('Workbook XML tag is malformed.', 'integrity_failed');
    const name = opening[1];
    if (rootClosed && !stack.length) fail('Workbook XML contains more than one root element.', 'integrity_failed');
    if (!root) root = localName(name);
    const attrText = (opening[2] ?? '').trim();
    if (attrText) attributes(attrText);
    const critical = new Set(['workbook', 'workbookPr', 'worksheet', 'sheetData', 'row', 'c', 'v', 'f', 'is', 't', 'si', 'cellXfs', 'xf', 'numFmt', 'mergeCell']);
    if (!inExtension && name.includes(':') && critical.has(localName(name))) fail(`Prefixed SpreadsheetML element ${name} is not supported by the complete parser.`, 'invalid_input');
    if (expectedRoot === 'worksheet' && !inExtension) {
      const child = localName(name);
      const parent = stack.length ? localName(stack.at(-1)!) : '';
      if ((child === 'sheetData' && parent !== 'worksheet')
        || (child === 'row' && parent !== 'sheetData')
        || (child === 'c' && parent !== 'row')
        || (['v', 'f', 'is'].includes(child) && parent !== 'c')) {
        fail(`Worksheet element ${child} has an unsupported parent ${parent || '(root)'}.`, 'integrity_failed');
      }
    }
    if (opening[3] !== '/') stack.push(name);
    else if (!stack.length) rootClosed = true;
  }
  if (xml.slice(cursor).trim() || stack.length || !rootClosed || root !== expectedRoot) fail(`Workbook ${expectedRoot} XML is incomplete or malformed.`, 'integrity_failed');
}

function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function completeElementBody(xml: string, name: string): string {
  const matches = [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'g'))];
  if (matches.length !== 1) fail(`Workbook XML must contain exactly one ${name} element.`, 'integrity_failed');
  return matches[0][1] ?? '';
}

function validateRichTextStructure(value: string, label: string): void {
  const formatting = new Set([
    'b', 'i', 'strike', 'outline', 'shadow', 'condense', 'extend', 'sz', 'color',
    'rFont', 'family', 'charset', 'scheme', 'vertAlign',
  ]);
  const stack: string[] = [];
  let cursor = 0;
  const token = /<\/?([A-Za-z_][A-Za-z0-9_.:-]*)\b(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/g;
  for (const match of value.matchAll(token)) {
    const index = match.index ?? 0;
    if (value.slice(cursor, index).trim() && stack.at(-1) !== 't') {
      fail(`${label} contains text outside a rich-text t element.`, 'invalid_input');
    }
    cursor = index + match[0].length;
    const child = localName(match[1]);
    const closing = match[0].startsWith('</');
    if (closing) {
      if (stack.pop() !== child) fail(`${label} rich-text nesting is malformed.`, 'integrity_failed');
      continue;
    }
    const parent = stack.at(-1) ?? '';
    const allowed = parent === ''
      ? ['t', 'r', 'rPh', 'phoneticPr'].includes(child)
      : parent === 'r'
        ? ['rPr', 't'].includes(child)
        : parent === 'rPr'
          ? formatting.has(child)
          : parent === 'rPh'
            ? child === 't'
            : false;
    if (!allowed) fail(`${label} contains unsupported rich-text relationship ${parent || '(root)'} → ${child}.`, 'invalid_input');
    if (!match[0].endsWith('/>')) stack.push(child);
  }
  if (value.slice(cursor).trim() && stack.at(-1) !== 't') fail(`${label} contains text outside a rich-text t element.`, 'invalid_input');
  if (stack.length) fail(`${label} rich-text nesting is incomplete.`, 'integrity_failed');
}

function exactCellPayload(body: string, type: string, reference: string): { formula?: string; raw?: string; inline?: string } {
  const formulaNodes = [...body.matchAll(/<f\b[^>]*(?:\/\s*>|>([\s\S]*?)<\/f\s*>)/g)];
  const valueNodes = [...body.matchAll(/<v\b[^>]*(?:\/\s*>|>([\s\S]*?)<\/v\s*>)/g)];
  const inlineNodes = [...body.matchAll(/<is\b[^>]*(?:\/\s*>|>([\s\S]*?)<\/is\s*>)/g)];
  if (formulaNodes.length > 1 || valueNodes.length > 1 || inlineNodes.length > 1) {
    fail(`Cell ${reference} contains duplicate payload children.`, 'integrity_failed');
  }
  let remainder = body;
  for (const pattern of [
    /<f\b[^>]*(?:\/\s*>|>[\s\S]*?<\/f\s*>)/g,
    /<v\b[^>]*(?:\/\s*>|>[\s\S]*?<\/v\s*>)/g,
    /<is\b[^>]*(?:\/\s*>|>[\s\S]*?<\/is\s*>)/g,
  ]) remainder = remainder.replace(pattern, '');
  if (remainder.trim()) fail(`Cell ${reference} contains unsupported or unconsumed XML.`, 'invalid_input');
  if (type === 'inlineStr') {
    if (inlineNodes.length !== 1 || valueNodes.length || formulaNodes.length) {
      fail(`Inline-string cell ${reference} must contain exactly one inline string and no value/formula siblings.`, 'integrity_failed');
    }
  } else if (inlineNodes.length) {
    fail(`Cell ${reference} contains an inline string incompatible with type ${type || 'n'}.`, 'integrity_failed');
  }
  const formulaText = formulaNodes[0]?.[1] ?? '';
  const valueText = valueNodes[0]?.[1] ?? '';
  const inlineText = inlineNodes[0]?.[1] ?? '';
  if (/[<>]/.test(formulaText) || /[<>]/.test(valueText)) {
    fail(`Cell ${reference} formula/value contains nested XML.`, 'integrity_failed');
  }
  if (inlineNodes.length) validateRichTextStructure(inlineText, `Cell ${reference}`);
  return {
    ...(formulaNodes.length ? { formula: decodeXml(formulaText) } : {}),
    ...(valueNodes.length ? { raw: valueText } : {}),
    ...(inlineNodes.length ? { inline: inlineText } : {}),
  };
}

async function readZipMember(
  filePath: string,
  member: string,
  maxBytes: number,
  signal?: AbortSignal,
  optional = false,
): Promise<Buffer | null> {
  throwIfAborted(signal);
  return await new Promise<Buffer | null>((resolve, reject) => {
    const child = spawn('unzip', ['-p', filePath, member], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, value?: Buffer | null): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value ?? null);
    };
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(new AnalyticsImportCompleteParserError('Complete workbook parsing was interrupted.', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill('SIGKILL');
        finish(new AnalyticsImportCompleteParserError(`Workbook member ${member} exceeds the complete-parser limit.`, 'too_large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString('utf8').slice(0, 4_096 - stderr.length);
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      if (code === 0) finish(undefined, Buffer.concat(chunks));
      else if (optional) finish(undefined, null);
      else {
        if (stderr.trim()) console.warn(`[AnalyticsImportParser] unzip member read failed (${member}): ${stderr.trim().slice(0, 500)}`);
        finish(new AnalyticsImportCompleteParserError(`Workbook member ${member} could not be read completely.`, 'integrity_failed'));
      }
    });
  });
}

function textFromRichXml(value: string): string {
  const visible = value.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh\s*>/g, '');
  const pieces = [...visible.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t\s*>/g)].map(match => decodeXml(match[1] ?? ''));
  if (pieces.length) return pieces.join('');
  return decodeXml(visible.replace(/<[^>]+>/g, ''));
}

function sharedStrings(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si\s*>/g)) {
    validateRichTextStructure(match[1] ?? '', 'Shared string');
    const value = textFromRichXml(match[1] ?? '');
    if (value.length > MAX_CELL_TEXT) fail('A shared string exceeds the complete-parser cell limit.', 'too_large');
    values.push(value);
  }
  return values;
}

function normalizedNumberFormat(value: string): string {
  return value.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*]/g, '').toLowerCase();
}

function styleKinds(xml: string): Array<{ format?: string; date: boolean; time: boolean }> {
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?\s*>/g)) {
    const attrs = attributes(match[1] ?? '');
    const id = Number(attrs.get('numFmtId'));
    const code = attrs.get('formatCode');
    if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs\s*>/.exec(xml)?.[1] ?? '';
  const builtInDate = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  return [...xfs.matchAll(/<xf\b([^>]*)\/?\s*>/g)].map(match => {
    const id = Number(attributes(match[1] ?? '').get('numFmtId') ?? 0);
    const format = custom.get(id);
    const normalized = normalizedNumberFormat(format ?? '');
    const hasDate = builtInDate.has(id) || /[yd]/.test(normalized);
    const hasTime = builtInDate.has(id) ? [18, 19, 20, 21, 22, 45, 46, 47].includes(id) : /[hs]/.test(normalized);
    return { ...(format ? { format } : {}), date: hasDate, time: hasTime };
  });
}

function columnName(column: number): string {
  let value = column;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function analyticsImportColumnNumber(name: string): number {
  if (!/^[A-Z]{1,3}$/.test(name)) fail(`Column reference ${name} is invalid.`, 'integrity_failed');
  let result = 0;
  for (const character of name) result = result * 26 + character.charCodeAt(0) - 64;
  if (result < 1 || result > MAX_COLUMNS) fail(`Column ${name} exceeds the complete-parser limit.`, 'too_large');
  return result;
}

function coordinate(reference: string): { row: number; column: number; columnName: string } {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(reference);
  if (!match) fail(`Cell reference ${reference} is invalid.`, 'integrity_failed');
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row > MAX_ROWS) fail(`Row ${match[2]} exceeds the complete-parser limit.`, 'too_large');
  return { row, column: analyticsImportColumnNumber(match[1]), columnName: match[1] };
}

function excelSerial(value: number, dateSystem: '1900' | '1904', includeTime: boolean): { kind: 'date' | 'timestamp' | 'time'; value: string } {
  if (!Number.isFinite(value) || value < 0) fail('Excel date serial is invalid.', 'integrity_failed');
  if (dateSystem === '1900' && Math.floor(value) === 60) fail('Excel serial 60 is the fictitious 1900-02-29 and cannot be imported deterministically.', 'invalid_input');
  const wholeDays = Math.floor(value);
  const fraction = value - wholeDays;
  if (wholeDays === 0 && includeTime) {
    const milliseconds = Math.round(fraction * 86_400_000);
    const iso = new Date(milliseconds).toISOString().slice(11, 23);
    return { kind: 'time', value: iso };
  }
  const epoch = dateSystem === '1904' ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const adjustedDays = dateSystem === '1900' && wholeDays > 60 ? wholeDays - 1 : wholeDays;
  const instant = new Date(epoch + adjustedDays * 86_400_000 + Math.round(fraction * 86_400_000));
  if (Number.isNaN(instant.getTime())) fail('Excel date serial is outside the supported range.', 'integrity_failed');
  if (!includeTime || fraction === 0) return { kind: 'date', value: instant.toISOString().slice(0, 10) };
  return { kind: 'timestamp', value: instant.toISOString() };
}

function parseCell(
  attrText: string,
  body: string,
  strings: string[],
  styles: Array<{ format?: string; date: boolean; time: boolean }>,
  dateSystem: '1900' | '1904',
): AnalyticsImportCompleteCell {
  const attrs = attributes(attrText);
  const reference = attrs.get('r') ?? '';
  const where = coordinate(reference);
  const type = attrs.get('t') ?? 'n';
  const styleIndexText = attrs.get('s');
  const styleIndex = styleIndexText === undefined ? null : Number(styleIndexText);
  if (styleIndex !== null && (!Number.isSafeInteger(styleIndex) || styleIndex < 0 || styleIndex >= styles.length)) {
    fail(`Cell ${reference} has an invalid style index.`, 'integrity_failed');
  }
  const style = styleIndex === null ? undefined : styles[styleIndex];
  const payload = exactCellPayload(body, type, reference);
  const formula = payload.formula;
  const raw = payload.raw;
  const base = {
    reference,
    ...where,
    ...(formula !== undefined ? { formula } : {}),
    ...(style?.format ? { numberFormat: style.format } : {}),
  };
  if (type === 'inlineStr') {
    const value = textFromRichXml(payload.inline ?? '');
    return { ...base, kind: value ? 'string' : 'blank', value: value || null, ...(value ? { raw: value } : {}) };
  }
  if (raw === undefined || raw === '') return { ...base, kind: 'blank', value: null };
  const decoded = decodeXml(raw);
  if (decoded.length > MAX_CELL_TEXT) fail(`Cell ${reference} exceeds the complete-parser text limit.`, 'too_large');
  if (type === 's') {
    const index = Number(decoded);
    if (!Number.isSafeInteger(index) || index < 0 || index >= strings.length) fail(`Cell ${reference} references a missing shared string.`, 'integrity_failed');
    return { ...base, kind: 'string', value: strings[index], raw: decoded };
  }
  if (type === 'str') return { ...base, kind: 'string', value: decoded, raw: decoded };
  if (type === 'b') {
    if (decoded !== '0' && decoded !== '1') fail(`Cell ${reference} has an invalid boolean value.`, 'integrity_failed');
    return { ...base, kind: 'boolean', value: decoded === '1', raw: decoded };
  }
  if (type === 'e') return { ...base, kind: 'error', value: decoded, raw: decoded };
  if (type === 'd') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(decoded)) {
      const parsed = new Date(`${decoded}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== decoded) fail(`Cell ${reference} has an invalid ISO date.`, 'integrity_failed');
      return { ...base, kind: 'date', value: decoded, raw: decoded };
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(decoded)) {
      fail(`Cell ${reference} has a timezone-free or invalid ISO timestamp.`, 'invalid_input');
    }
    const parsed = new Date(decoded);
    if (Number.isNaN(parsed.getTime())) fail(`Cell ${reference} has an invalid ISO timestamp.`, 'integrity_failed');
    return { ...base, kind: 'timestamp', value: parsed.toISOString(), raw: decoded };
  }
  if (type !== 'n' && type !== '') fail(`Cell ${reference} uses unsupported XLSX type ${type}.`, 'invalid_input');
  const number = Number(decoded);
  if (!Number.isFinite(number)) fail(`Cell ${reference} is not a finite number.`, 'integrity_failed');
  if (style?.date || style?.time) {
    const converted = excelSerial(number, dateSystem, Boolean(style.time));
    return { ...base, kind: converted.kind, value: converted.value, raw: decoded };
  }
  return { ...base, kind: Number.isSafeInteger(number) ? 'integer' : 'number', value: number, raw: decoded };
}

function profileColumns(rows: AnalyticsImportCompleteRow[], width: number): AnalyticsImportColumnProfile[] {
  return Array.from({ length: width }, (_unused, index) => {
    const kinds: Partial<Record<AnalyticsImportCellKind, number>> = {};
    const samples: AnalyticsDataCell[] = [];
    let nonNull = 0;
    let formulaCells = 0;
    for (const row of rows) {
      const cell = row.cells[index];
      if (!cell || cell.value === null) continue;
      nonNull += 1;
      kinds[cell.kind] = (kinds[cell.kind] ?? 0) + 1;
      if (cell.formula !== undefined) formulaCells += 1;
      if (samples.length < 5 && !samples.some(value => stableAnalyticsJson(value) === stableAnalyticsJson(cell.value))) samples.push(cell.value);
    }
    return { column: index + 1, columnName: columnName(index + 1), nonNull, kinds, formulaCells, samples };
  });
}

export async function parseAnalyticsImportSheet(input: ParseAnalyticsImportSheetInput): Promise<AnalyticsImportCompleteParseResult> {
  throwIfAborted(input.signal);
  if (!SHA256_RE.test(input.sourceSha256) || !Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 1) {
    fail('Complete parser source receipt is malformed.', 'integrity_failed');
  }
  const stat = fs.lstatSync(input.filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.sourceBytes || (stat.mode & 0o077) !== 0) {
    fail('Complete parser source is not the expected private regular file.', 'integrity_failed');
  }
  const sourceBytes = fs.readFileSync(input.filePath);
  if (sourceBytes.length !== input.sourceBytes || sha256Bytes(sourceBytes) !== input.sourceSha256) {
    fail('Complete parser source bytes differ from the candidate receipt.', 'integrity_failed');
  }
  if (!input.documentParser.parseXlsxSheet) fail('Strict workbook relationship parsing is unavailable.', 'integrity_failed');
  const inventory = await input.documentParser.parseXlsxSheet(input.filePath, {
    signal: input.signal,
    requireCompleteRelationships: true,
  });
  const sheet = inventory.sheets.find(value => value.name === input.sheetName);
  if (!sheet) fail('Selected worksheet no longer matches the strict workbook inventory.', 'integrity_failed');

  const [workbookBytes, stylesBytes, stringsBytes, worksheetBytes] = await Promise.all([
    readZipMember(input.filePath, 'xl/workbook.xml', MAX_WORKBOOK_XML_BYTES, input.signal),
    readZipMember(input.filePath, 'xl/styles.xml', MAX_STYLES_XML_BYTES, input.signal, true),
    readZipMember(input.filePath, 'xl/sharedStrings.xml', MAX_SHARED_STRINGS_BYTES, input.signal, true),
    readZipMember(input.filePath, sheet.member, MAX_WORKSHEET_XML_BYTES, input.signal),
  ]);
  throwIfAborted(input.signal);
  const workbookXml = decodeUtf8(workbookBytes!, 'workbook XML');
  const worksheetXml = decodeUtf8(worksheetBytes!, 'worksheet XML');
  const stylesXml = stylesBytes ? decodeUtf8(stylesBytes, 'styles XML') : '';
  const stringsXml = stringsBytes ? decodeUtf8(stringsBytes, 'shared strings XML') : '';
  validateXmlDocument(workbookXml, 'workbook');
  validateXmlDocument(worksheetXml, 'worksheet');
  if (stylesXml) validateXmlDocument(stylesXml, 'styleSheet');
  if (stringsXml) validateXmlDocument(stringsXml, 'sst');
  const workbookContent = stripXmlComments(workbookXml);
  const worksheetContent = stripXmlComments(worksheetXml);
  const stylesContent = stripXmlComments(stylesXml);
  const stringsContent = stripXmlComments(stringsXml);
  const sheetDataXml = completeElementBody(worksheetContent, 'sheetData');
  const workbookProperties = /<workbookPr\b([^>]*)\/?\s*>/.exec(workbookContent);
  const date1904 = workbookProperties ? attributes(workbookProperties[1] ?? '').get('date1904') : undefined;
  if (date1904 !== undefined && !['0', '1', 'false', 'true'].includes(date1904.toLowerCase())) {
    fail('Workbook date1904 flag is invalid.', 'integrity_failed');
  }
  const dateSystem: '1900' | '1904' = date1904 === '1' || date1904?.toLowerCase() === 'true' ? '1904' : '1900';
  const strings = stringsContent ? sharedStrings(stringsContent) : [];
  const styles = styleKinds(stylesContent);
  const mergedRanges = [...worksheetContent.matchAll(/<mergeCell\b([^>]*)\/?\s*>/g)].map(match => {
    const reference = attributes(match[1] ?? '').get('ref') ?? '';
    if (!/^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$/.test(reference)) fail('Worksheet contains an invalid merged range.', 'integrity_failed');
    return reference;
  });
  if (mergedRanges.length > MAX_MERGES) fail('Worksheet exceeds the complete-parser merged-range limit.', 'too_large');

  const rows: AnalyticsImportCompleteRow[] = [];
  let previousRow = 0;
  let cellCount = 0;
  let maxColumn = 0;
  let formulaCellCount = 0;
  let formulaWithoutCachedValueCount = 0;
  let errorCellCount = 0;
  const seenRows = new Set<number>();
  const rowPattern = /<row\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/row\s*>)/g;
  let rowCursor = 0;
  let allocatedSlots = 0;
  for (const rowMatch of sheetDataXml.matchAll(rowPattern)) {
    const rowIndex = rowMatch.index ?? 0;
    if (sheetDataXml.slice(rowCursor, rowIndex).trim()) fail('Worksheet sheetData contains unsupported or unconsumed XML.', 'invalid_input');
    rowCursor = rowIndex + rowMatch[0].length;
    throwIfAborted(input.signal);
    const rowAttrs = attributes(rowMatch[1] ?? '');
    const rowNumber = Number(rowAttrs.get('r'));
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS) fail('Worksheet row coordinates are missing or invalid.', 'integrity_failed');
    if (rowNumber <= previousRow || seenRows.has(rowNumber)) fail('Worksheet row coordinates are duplicated or out of order.', 'integrity_failed');
    previousRow = rowNumber;
    seenRows.add(rowNumber);
    const body = rowMatch[2] ?? '';
    const cellsByColumn = new Map<number, AnalyticsImportCompleteCell>();
    let previousColumn = 0;
    let cellCursor = 0;
    const cellPattern = /<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c\s*>)/g;
    for (const cellMatch of body.matchAll(cellPattern)) {
      const cellIndex = cellMatch.index ?? 0;
      if (body.slice(cellCursor, cellIndex).trim()) fail(`Row ${rowNumber} contains unsupported or unconsumed XML.`, 'invalid_input');
      cellCursor = cellIndex + cellMatch[0].length;
      const cell = parseCell(cellMatch[1] ?? '', cellMatch[2] ?? '', strings, styles, dateSystem);
      if (cell.row !== rowNumber || cell.column <= previousColumn || cellsByColumn.has(cell.column)) {
        fail(`Cell ${cell.reference} is duplicated, out of order, or outside row ${rowNumber}.`, 'integrity_failed');
      }
      previousColumn = cell.column;
      cellsByColumn.set(cell.column, cell);
      maxColumn = Math.max(maxColumn, cell.column);
      cellCount += 1;
      if (cellCount > MAX_CELLS) fail('Worksheet exceeds the complete-parser cell limit.', 'too_large');
      if (cell.formula !== undefined) {
        formulaCellCount += 1;
        if (cell.value === null) formulaWithoutCachedValueCount += 1;
      }
      if (cell.kind === 'error') errorCellCount += 1;
    }
    if (body.slice(cellCursor).trim()) fail(`Row ${rowNumber} contains unsupported or unconsumed XML.`, 'invalid_input');
    allocatedSlots += previousColumn;
    if (allocatedSlots > MAX_MATERIALIZED_SLOTS) fail('Worksheet sparse coordinates exceed the complete-parser memory budget.', 'too_large');
    rows.push({ rowNumber, cells: Array.from({ length: previousColumn }, (_unused, index) => cellsByColumn.get(index + 1) ?? null) });
  }
  if (sheetDataXml.slice(rowCursor).trim()) fail('Worksheet sheetData contains unsupported or unconsumed XML.', 'invalid_input');
  if (rows.length > MAX_ROWS) fail('Worksheet exceeds the complete-parser row limit.', 'too_large');
  const nonEmptyRows = rows.filter(row => row.cells.some(cell => Boolean(cell && (cell.value !== null || cell.formula !== undefined))));
  const columns = profileColumns(rows, maxColumn);
  const rowsetPayload = rows.map(row => ({
    rowNumber: row.rowNumber,
    cells: row.cells.map(cell => cell ? {
      reference: cell.reference,
      kind: cell.kind,
      value: cell.value,
      ...(cell.formula !== undefined ? { formula: cell.formula } : {}),
      ...(cell.numberFormat ? { numberFormat: cell.numberFormat } : {}),
    } : null),
  }));
  const rowsetSha256 = analyticsSha256(rowsetPayload);
  const schemaSha256 = analyticsSha256(columns.map(column => ({
    column: column.column,
    columnName: column.columnName,
    kinds: column.kinds,
  })));
  const profileBase: Omit<AnalyticsImportCompleteProfile, 'parseSha256' | 'profileSha256'> = {
    parserVersion: ANALYTICS_IMPORT_COMPLETE_PARSER_VERSION,
    headerPolicyVersion: ANALYTICS_IMPORT_HEADER_POLICY_VERSION,
    datePolicyVersion: ANALYTICS_IMPORT_DATE_POLICY_VERSION,
    formulaPolicyVersion: ANALYTICS_IMPORT_FORMULA_POLICY_VERSION,
    errorPolicyVersion: ANALYTICS_IMPORT_ERROR_POLICY_VERSION,
    completeToEof: true as const,
    sheetName: input.sheetName,
    dateSystem,
    rowCount: rows.length,
    nonEmptyRowCount: nonEmptyRows.length,
    columnCount: maxColumn,
    cellCount,
    formulaCellCount,
    formulaWithoutCachedValueCount,
    errorCellCount,
    mergedRangeCount: mergedRanges.length,
    firstRow: rows[0]?.rowNumber ?? null,
    lastRow: rows.at(-1)?.rowNumber ?? null,
    columns,
    limitations: [
      'Formula cells use stored workbook results and are not recalculated.',
      'Merged ranges are receipted but are not expanded into repeated values.',
      'Excel values carry no business timezone; semantic inference must provide one.',
    ],
    inputSha256: input.sourceSha256,
    rowsetSha256,
    schemaSha256,
  };
  const profileSha256 = analyticsSha256(profileBase);
  const parseSha256 = analyticsSha256({
    parserVersion: ANALYTICS_IMPORT_COMPLETE_PARSER_VERSION,
    inputSha256: input.sourceSha256,
    sheetName: input.sheetName,
    dateSystem,
    rowsetSha256,
    schemaSha256,
    profileSha256,
  });
  return {
    rows,
    mergedRanges,
    profile: { ...profileBase, parseSha256, profileSha256 },
  };
}
