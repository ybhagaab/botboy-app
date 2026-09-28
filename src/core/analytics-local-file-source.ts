import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnalyticsDataCell, AnalyticsFieldContract, AnalyticsLogicalType } from './analytics-data-room-types.js';
import { parseAnalyticsDelimited, parseDelimitedCell } from './analytics-delimited.js';
import {
  parseAnalyticsImportSheet,
  type AnalyticsImportCompleteCell,
} from './analytics-import-complete-parser.js';
import { compactAnalyticsPartitionRanges } from './analytics-data-room-policy.js';
import { dataRoomIssue, type DataRoomFailureIssueV1 } from './data-room-tool-failure.js';
import type { DocumentParser } from './document-parser.js';

/**
 * Generic local-file source for Data Room creation.
 *
 * Any regular file the owner can read becomes one strict, complete table:
 * CSV/TSV through the one UTF-8 delimited reader that Datanet ETL results also
 * use, XLSX through the same complete coordinate-preserving parser as Import
 * Inbox. The dataset contract (schema/types/nullability/coverage) remains the
 * admission authority; this module only reads, snapshots, and types exact cells.
 *
 * The single boundary mirrors the model shell sandbox: BotBoy's private state
 * root is unreadable except for BotBoy's owner-artifact download directories.
 */

export const ANALYTICS_LOCAL_FILE_PARSER_VERSION = 'botboy-local-file-table-v1';
export const MAX_ANALYTICS_LOCAL_FILE_BYTES = 32 * 1024 * 1024;
export const ANALYTICS_LOCAL_FILE_FORMATS = ['csv', 'tsv', 'xlsx'] as const;
export type AnalyticsLocalFileFormat = typeof ANALYTICS_LOCAL_FILE_FORMATS[number];

const ARTIFACT_DIRECTORIES = ['files', 'etl-results', 'chat-attachments', 'slack-attachments', 'sharepoint-cache'];
const LOGICAL_TYPES: AnalyticsLogicalType[] = ['string', 'integer', 'number', 'boolean', 'date', 'timestamp'];
const MAX_ISSUES = 8;
const SAMPLE_CHARS = 40;

export interface AnalyticsLocalFileLocator {
  path: string;
  format?: AnalyticsLocalFileFormat;
  sheet?: string;
  headerRow?: number;
  nullToken?: string;
}

export interface AnalyticsLocalFilePolicy {
  homeDir: string;
  privateRoot: string;
  filesDir: string;
  artifactDirs: string[];
  tempRoot?: string;
}

export function defaultAnalyticsLocalFilePolicy(homeDir = os.homedir()): AnalyticsLocalFilePolicy {
  const privateRoot = path.join(homeDir, '.personal-productivity-tracker');
  return {
    homeDir,
    privateRoot,
    filesDir: path.join(privateRoot, 'files'),
    artifactDirs: ARTIFACT_DIRECTORIES.map(name => path.join(privateRoot, name)),
  };
}

export class AnalyticsLocalFileError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'policy_denied',
    message: string,
    readonly issues: DataRoomFailureIssueV1[],
  ) {
    super(message);
    this.name = 'AnalyticsLocalFileError';
  }
}

function reject(code: 'invalid_input' | 'policy_denied', message: string, issues: DataRoomFailureIssueV1 | DataRoomFailureIssueV1[]): never {
  throw new AnalyticsLocalFileError(code, message, (Array.isArray(issues) ? issues : [issues]).slice(0, MAX_ISSUES));
}

export interface AnalyticsLocalFileResolved {
  resolvedPath: string;
  fileName: string;
  format: AnalyticsLocalFileFormat;
}

export interface AnalyticsLocalFileSnapshot extends AnalyticsLocalFileResolved {
  bytes: Buffer;
  size: number;
  sha256: string;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realOrResolved(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function inferFormat(fileName: string, explicit: AnalyticsLocalFileFormat | undefined, label: string): AnalyticsLocalFileFormat {
  if (explicit !== undefined) {
    if (!ANALYTICS_LOCAL_FILE_FORMATS.includes(explicit)) {
      reject('invalid_input', `${label}.format is unsupported.`, dataRoomIssue({
        code: 'invalid_enum', path: `${label}.format`, message: 'format must be csv, tsv, or xlsx.',
        expected: { kind: 'enum', values: [...ANALYTICS_LOCAL_FILE_FORMATS] }, received: explicit, includeReceivedValue: true,
      }));
    }
    return explicit;
  }
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.csv') return 'csv';
  if (extension === '.tsv' || extension === '.tab') return 'tsv';
  if (extension === '.xlsx' || extension === '.xlsm') return 'xlsx';
  if (extension === '.xls') {
    reject('invalid_input', `${label}.path is a legacy binary .xls workbook.`, dataRoomIssue({
      code: 'unsupported_file_format', path: `${label}.path`,
      message: 'Legacy binary .xls workbooks are not readable; ask the owner for .xlsx or CSV, or write an exact CSV copy.',
      expected: { kind: 'enum', values: ['.csv', '.tsv', '.tab', '.xlsx', '.xlsm'] }, received: extension, includeReceivedValue: true,
    }));
  }
  return reject('invalid_input', `${label}.format is required for this file extension.`, dataRoomIssue({
    code: 'format_required', path: `${label}.format`,
    message: `The file extension ${extension || '(none)'} does not identify a table format; set format to csv, tsv, or xlsx.`,
    expected: { kind: 'enum', values: [...ANALYTICS_LOCAL_FILE_FORMATS] }, received: undefined,
  }));
}

/** Resolve one owner/BotBoy file path to an exact regular file under the local-file boundary. */
export function resolveAnalyticsLocalFile(
  locator: Pick<AnalyticsLocalFileLocator, 'path' | 'format'>,
  policy: AnalyticsLocalFilePolicy,
  label: string,
): AnalyticsLocalFileResolved {
  const raw = typeof locator.path === 'string' ? locator.path.trim() : '';
  if (!raw || raw.includes('\0')) {
    reject('invalid_input', `${label}.path is required.`, dataRoomIssue({
      code: 'required', path: `${label}.path`, message: 'path must name one local file: absolute, ~/..., or relative to BotBoy’s files workspace.',
      expected: { kind: 'range', type: 'string', minimum: 1, maximum: 4096 }, received: locator.path,
    }));
  }
  let candidate: string;
  if (raw === '~' || raw.startsWith('~/')) candidate = path.join(policy.homeDir, raw.slice(1));
  else if (path.isAbsolute(raw)) candidate = path.resolve(raw);
  else {
    if (raw.split(/[\\/]/).some(segment => segment === '..')) {
      reject('invalid_input', `${label}.path escapes the files workspace.`, dataRoomIssue({
        code: 'relative_path_escape', path: `${label}.path`,
        message: 'A relative path resolves inside BotBoy’s files workspace and may not contain .. segments; use an absolute or ~/ path for other files.',
        expected: { kind: 'pattern', type: 'string', pattern: '^(?!.*(?:^|/)\\.\\.(?:/|$)).+$' }, received: raw,
      }));
    }
    candidate = path.resolve(policy.filesDir, raw);
  }
  let resolvedPath: string;
  let stat: fs.Stats;
  try {
    resolvedPath = fs.realpathSync(candidate);
    stat = fs.statSync(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return reject('invalid_input', `${label}.path cannot be read.`, dataRoomIssue({
      code: code === 'EACCES' || code === 'EPERM' ? 'file_unreadable' : 'file_not_found', path: `${label}.path`,
      message: code === 'EACCES' || code === 'EPERM'
        ? 'The file exists but this account cannot read it.'
        : 'No readable file exists at this path. Use the exact path returned by the tool that saved it, an absolute path, or a ~/ path.',
      expected: { kind: 'relation', description: 'An existing regular file readable by the owner account.' }, received: raw,
    }));
  }
  if (!stat.isFile()) {
    reject('invalid_input', `${label}.path is not a regular file.`, dataRoomIssue({
      code: 'not_a_file', path: `${label}.path`, message: 'path must name one regular file, not a directory or device.',
      expected: { kind: 'relation', description: 'A regular file.' }, received: raw,
    }));
  }
  const privateRoot = realOrResolved(policy.privateRoot);
  if (inside(resolvedPath, privateRoot)
    && !policy.artifactDirs.map(realOrResolved).some(directory => inside(resolvedPath, directory))) {
    reject('policy_denied', `${label}.path is BotBoy private state.`, dataRoomIssue({
      code: 'private_state_denied', path: `${label}.path`,
      message: 'BotBoy’s own database, secrets, logs, and Data Room internals are not importable. Owner files anywhere else and BotBoy artifact downloads (files, etl-results, chat-attachments, slack-attachments, sharepoint-cache) are.',
      expected: { kind: 'relation', description: 'A file outside BotBoy private state or inside one BotBoy artifact download directory.' }, received: raw,
    }));
  }
  if (stat.size < 1 || stat.size > MAX_ANALYTICS_LOCAL_FILE_BYTES) {
    reject('invalid_input', `${label}.path size is outside the importable range.`, dataRoomIssue({
      code: stat.size < 1 ? 'empty_file' : 'file_too_large', path: `${label}.path`,
      message: stat.size < 1 ? 'The file is empty.' : `The file is ${stat.size} bytes; one local-file source may be at most ${MAX_ANALYTICS_LOCAL_FILE_BYTES} bytes.`,
      expected: { kind: 'range', type: 'integer', minimum: 1, maximum: MAX_ANALYTICS_LOCAL_FILE_BYTES }, received: stat.size, includeReceivedValue: true,
    }));
  }
  const fileName = path.basename(resolvedPath);
  return { resolvedPath, fileName, format: inferFormat(fileName, locator.format, label) };
}

export function readAnalyticsLocalFile(resolved: AnalyticsLocalFileResolved, label: string): AnalyticsLocalFileSnapshot {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolved.resolvedPath);
  } catch {
    return reject('invalid_input', `${label}.path could not be read.`, dataRoomIssue({
      code: 'file_unreadable', path: `${label}.path`, message: 'The file disappeared or became unreadable while it was being read.',
      expected: { kind: 'relation', description: 'A stable readable regular file.' }, received: resolved.fileName,
    }));
  }
  if (bytes.length < 1 || bytes.length > MAX_ANALYTICS_LOCAL_FILE_BYTES) {
    reject('invalid_input', `${label}.path size changed outside the importable range.`, dataRoomIssue({
      code: 'file_too_large', path: `${label}.path`, message: `One local-file source may be 1 to ${MAX_ANALYTICS_LOCAL_FILE_BYTES} bytes.`,
      expected: { kind: 'range', type: 'integer', minimum: 1, maximum: MAX_ANALYTICS_LOCAL_FILE_BYTES }, received: bytes.length, includeReceivedValue: true,
    }));
  }
  return { ...resolved, bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

type LocalTableCell =
  | { kind: 'text'; text: string }
  /** A trailing field a ragged-right exporter omitted: no value at all. */
  | { kind: 'absent' }
  | { kind: 'xlsx'; cell: AnalyticsImportCompleteCell | null };

export interface AnalyticsLocalTableRow {
  /** 1-based file record/row number used in every cell coordinate. */
  rowNumber: number;
  cells: LocalTableCell[];
}

export interface AnalyticsLocalTable {
  format: AnalyticsLocalFileFormat;
  fileName: string;
  sha256: string;
  size: number;
  sheets?: string[];
  sheet?: string;
  headerRow?: number;
  header: string[];
  rows: AnalyticsLocalTableRow[];
  blankRowsSkipped: number;
  rowsAboveHeader: number;
  formulaCells: number;
  /** Delimited records that omitted trailing fields (read as absent/null). */
  shortRows: number;
}

function columnLetters(index: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function coordinate(table: Pick<AnalyticsLocalTable, 'format'>, rowNumber: number, columnIndex: number): string {
  return table.format === 'xlsx' ? `${columnLetters(columnIndex)}${rowNumber}` : `row ${rowNumber} column ${columnIndex + 1}`;
}

function sample(value: unknown): string {
  const text = String(value);
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text;
}

export function validateAnalyticsNullToken(nullToken: string, format: AnalyticsLocalFileFormat, label: string): void {
  const delimiter = format === 'tsv' ? '\t' : ',';
  if (typeof nullToken !== 'string' || nullToken.length > 32 || /["\r\n\0]/.test(nullToken)
    || (format !== 'xlsx' && nullToken.includes(delimiter))) {
    reject('invalid_input', `${label}.nullToken is invalid.`, dataRoomIssue({
      code: 'invalid_null_token', path: `${label}.nullToken`,
      message: 'nullToken is at most 32 characters without quote, CR, LF, NUL, or the file delimiter. Omit it (or use "") when empty cells mean null.',
      expected: { kind: 'range', type: 'string', minimum: 0, maximum: 32 }, received: nullToken,
    }));
  }
}

function parseMergedRange(reference: string): { top: number; bottom: number; left: number; right: number } | null {
  const match = /^([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)$/.exec(reference);
  if (!match) return null;
  const column = (letters: string) => [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
  const [top, bottom] = [Number(match[2]), Number(match[4])].sort((a, b) => a - b);
  const [left, right] = [column(match[1]), column(match[3])].sort((a, b) => a - b);
  return { top, bottom, left, right };
}

/** Exact bytes of one delimited table: a local-file snapshot or a verified Datanet result. */
export interface AnalyticsDelimitedTableSource {
  format: 'csv' | 'tsv';
  fileName: string;
  sha256: string;
  size: number;
  bytes: Uint8Array;
}

/**
 * Read one complete CSV/TSV table. Local-file imports and Datanet ETL results
 * both read here, so the same bytes type identically in either lane: line 1 is
 * the header, and records that omit trailing fields carry absent cells.
 */
export function readAnalyticsDelimitedTable(source: AnalyticsDelimitedTableSource, label: string): AnalyticsLocalTable {
  const kind = source.format.toUpperCase();
  let parsed: { columns: string[]; rawRows: string[][] };
  try {
    parsed = parseAnalyticsDelimited(source.bytes, source.format === 'tsv' ? '\t' : ',', kind);
  } catch (error) {
    return reject('invalid_input', `${label}.path is not one strict complete ${kind} table.`, dataRoomIssue({
      code: 'delimited_parse_failed', path: `${label}.path`,
      message: `${error instanceof Error ? error.message : String(error)} The file must be UTF-8 with one unique non-blank header line; records may omit only trailing fields.`,
      expected: { kind: 'relation', description: `A complete UTF-8 ${kind} table.` }, received: source.fileName,
    }));
  }
  const width = parsed.columns.length;
  return {
    format: source.format,
    fileName: source.fileName,
    sha256: source.sha256,
    size: source.size,
    header: parsed.columns,
    rows: parsed.rawRows.map((row, index) => ({
      rowNumber: index + 2,
      cells: Array.from({ length: width }, (_unused, column): LocalTableCell => (
        column < row.length ? { kind: 'text', text: row[column] } : { kind: 'absent' }
      )),
    })),
    blankRowsSkipped: 0,
    rowsAboveHeader: 0,
    formulaCells: 0,
    shortRows: parsed.rawRows.filter(row => row.length < width).length,
  };
}

/**
 * Read one complete table from exact file bytes. XLSX bytes are parsed from a
 * private 0600 snapshot so the parser sees exactly the hashed bytes.
 */
export async function readAnalyticsLocalTable(
  snapshot: AnalyticsLocalFileSnapshot,
  locator: Omit<AnalyticsLocalFileLocator, 'path' | 'format'>,
  deps: { documentParser?: DocumentParser; signal?: AbortSignal; tempRoot?: string },
  label: string,
): Promise<AnalyticsLocalTable> {
  const nullToken = locator.nullToken ?? '';
  validateAnalyticsNullToken(nullToken, snapshot.format, label);
  if (snapshot.format !== 'xlsx') {
    for (const field of ['sheet', 'headerRow'] as const) {
      if (locator[field] !== undefined) {
        reject('invalid_input', `${label}.${field} is XLSX-only.`, dataRoomIssue({
          code: 'field_forbidden_for_format', path: `${label}.${field}`,
          message: `${field} applies only to xlsx sources; delimited files always use line 1 as the header.`,
          expected: { kind: 'absent' }, received: locator[field],
        }));
      }
    }
    return readAnalyticsDelimitedTable({ ...snapshot, format: snapshot.format }, label);
  }
  const base = { format: snapshot.format, fileName: snapshot.fileName, sha256: snapshot.sha256, size: snapshot.size };

  if (!deps.documentParser?.parseXlsxSheet) {
    reject('invalid_input', 'XLSX reading is unavailable.', dataRoomIssue({
      code: 'xlsx_reader_unavailable', path: `${label}.path`, message: 'The strict workbook reader is unavailable in this runtime; use a CSV copy.',
      expected: { kind: 'relation', description: 'Workbook reader available.' }, received: snapshot.fileName,
    }));
  }
  const headerRow = locator.headerRow ?? 1;
  if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > 50_000) {
    reject('invalid_input', `${label}.headerRow is invalid.`, dataRoomIssue({
      code: 'out_of_range', path: `${label}.headerRow`, message: 'headerRow is the 1-based worksheet row holding column names (default 1).',
      expected: { kind: 'range', type: 'integer', minimum: 1, maximum: 50_000 }, received: locator.headerRow, includeReceivedValue: true,
    }));
  }
  const directory = fs.mkdtempSync(path.join(deps.tempRoot ?? os.tmpdir(), 'botboy-local-file-'));
  try {
    fs.chmodSync(directory, 0o700);
    const filePath = path.join(directory, 'source.xlsx');
    fs.writeFileSync(filePath, snapshot.bytes, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    let sheets: string[];
    try {
      const inventory = await deps.documentParser!.parseXlsxSheet!(filePath, { signal: deps.signal, requireCompleteRelationships: true });
      sheets = inventory.sheets.map(sheet => sheet.name);
    } catch (error) {
      return reject('invalid_input', `${label}.path is not a readable XLSX workbook.`, dataRoomIssue({
        code: 'xlsx_unreadable', path: `${label}.path`,
        message: `${error instanceof Error ? error.message : String(error)} Only complete .xlsx/.xlsm workbooks are readable.`,
        expected: { kind: 'relation', description: 'A complete Office Open XML workbook.' }, received: snapshot.fileName,
      }));
    }
    const sheetName = locator.sheet ?? (sheets.length === 1 ? sheets[0] : undefined);
    if (!sheetName || !sheets.includes(sheetName)) {
      reject('invalid_input', `${label}.sheet must name one worksheet.`, dataRoomIssue({
        code: locator.sheet === undefined ? 'sheet_required' : 'unknown_sheet', path: `${label}.sheet`,
        message: `This workbook has ${sheets.length} worksheet(s): ${sheets.slice(0, 40).map(name => JSON.stringify(name)).join(', ')}. Set sheet to one exact name.`,
        expected: { kind: 'enum', values: sheets.slice(0, 40) }, received: locator.sheet, includeReceivedValue: true,
      }));
    }
    let parsed: Awaited<ReturnType<typeof parseAnalyticsImportSheet>>;
    try {
      parsed = await parseAnalyticsImportSheet({
        filePath,
        sourceSha256: snapshot.sha256,
        sourceBytes: snapshot.size,
        sheetName: sheetName!,
        documentParser: deps.documentParser!,
        signal: deps.signal,
      });
    } catch (error) {
      return reject('invalid_input', `${label}.sheet could not be read completely.`, dataRoomIssue({
        code: 'xlsx_sheet_unreadable', path: `${label}.sheet`,
        message: `${error instanceof Error ? error.message : String(error)}`,
        expected: { kind: 'relation', description: 'One complete worksheet within parser limits.' }, received: sheetName,
      }));
    }
    const headerSource = parsed.rows.find(row => row.rowNumber === headerRow);
    const lastHeaderIndex = headerSource
      ? headerSource.cells.reduce((last, cell, index) => (cell && cell.value !== null ? index : last), -1)
      : -1;
    if (!headerSource || lastHeaderIndex < 0) {
      reject('invalid_input', `${label}.headerRow holds no column names.`, dataRoomIssue({
        code: 'header_row_missing', path: `${label}.headerRow`,
        message: `Worksheet row ${headerRow} is empty. First non-empty rows: ${parsed.rows.filter(row => row.cells.some(cell => cell && cell.value !== null)).slice(0, 5).map(row => row.rowNumber).join(', ') || 'none'}.`,
        expected: { kind: 'relation', description: 'The 1-based row containing one text column name per column.' }, received: headerRow, includeReceivedValue: true,
      }));
    }
    const headerIssues: DataRoomFailureIssueV1[] = [];
    const header: string[] = [];
    for (let index = 0; index <= lastHeaderIndex; index++) {
      const cell = headerSource!.cells[index];
      const text = cell?.kind === 'string' && typeof cell.value === 'string' ? cell.value : null;
      if (text === null || !text || text.trim() !== text) {
        if (headerIssues.length < MAX_ISSUES) headerIssues.push(dataRoomIssue({
          code: 'invalid_header_cell', path: `${label}.headerRow`,
          message: `Header cell ${columnLetters(index)}${headerRow} must be non-empty text without surrounding spaces${cell && cell.value !== null ? ` (found ${cell.kind} ${JSON.stringify(sample(cell.value))})` : ' (found blank)'}.`,
          expected: { kind: 'relation', description: 'Every header cell up to the last named column is non-empty trimmed text.' }, received: cell?.value ?? null,
        }));
        header.push('');
      } else header.push(text);
    }
    if (header.length > 200) headerIssues.push(dataRoomIssue({
      code: 'too_many_columns', path: `${label}.headerRow`, message: `The header names ${header.length} columns; at most 200 are importable.`,
      expected: { kind: 'range', type: 'array', maximum: 200 }, received: header.length, includeReceivedValue: true,
    }));
    const duplicates = header.filter((name, index) => name && header.indexOf(name) !== index);
    if (duplicates.length) headerIssues.push(dataRoomIssue({
      code: 'duplicate_header', path: `${label}.headerRow`, message: `Header names must be unique; duplicated: ${[...new Set(duplicates)].slice(0, 10).join(', ')}.`,
      expected: { kind: 'relation', description: 'Unique column names.' }, received: duplicates,
    }));
    const width = header.length;
    let blankRowsSkipped = 0;
    let rowsAboveHeader = 0;
    let formulaCells = 0;
    const rows: AnalyticsLocalTableRow[] = [];
    const outside: string[] = [];
    for (const row of parsed.rows) {
      const populated = (cell: AnalyticsImportCompleteCell | null) => Boolean(cell && (cell.value !== null || cell.formula !== undefined));
      if (row.rowNumber < headerRow) {
        if (row.cells.some(populated)) rowsAboveHeader += 1;
        continue;
      }
      if (row.rowNumber === headerRow) continue;
      row.cells.forEach((cell, index) => {
        if (index >= width && populated(cell)) outside.push(cell!.reference);
      });
      const cells = Array.from({ length: width }, (_unused, index) => row.cells[index] ?? null);
      if (!cells.some(populated)) {
        blankRowsSkipped += 1;
        continue;
      }
      formulaCells += cells.filter(cell => cell?.formula !== undefined).length;
      rows.push({ rowNumber: row.rowNumber, cells: cells.map(cell => ({ kind: 'xlsx' as const, cell })) });
    }
    if (outside.length) headerIssues.push(dataRoomIssue({
      code: 'cells_outside_header', path: `${label}.headerRow`,
      message: `${outside.length} populated cell(s) lie right of the last named header column ${columnLetters(width - 1)} (first: ${outside.slice(0, 5).join(', ')}). Every populated cell must belong to a named column; choose the correct headerRow or sheet.`,
      expected: { kind: 'relation', description: 'No populated cells outside the header columns.' }, received: outside.length, includeReceivedValue: true,
    }));
    const lastRow = rows.at(-1)?.rowNumber ?? headerRow;
    const merged = parsed.mergedRanges.filter(reference => {
      const range = parseMergedRange(reference);
      return range && range.bottom >= headerRow && range.top <= lastRow && range.left <= width;
    });
    if (merged.length) headerIssues.push(dataRoomIssue({
      code: 'merged_cells_in_table', path: `${label}.sheet`,
      message: `Merged cells inside the table are not one value per cell (${merged.slice(0, 5).join(', ')}). Use an unmerged sheet or an exact CSV copy.`,
      expected: { kind: 'relation', description: 'No merged ranges in the header/data area.' }, received: merged.length, includeReceivedValue: true,
    }));
    if (headerIssues.length) reject('invalid_input', `${label} worksheet is not one importable table.`, headerIssues);
    return {
      ...base,
      sheets,
      sheet: sheetName,
      headerRow,
      header,
      rows,
      blankRowsSkipped,
      rowsAboveHeader,
      formulaCells,
      shortRows: 0,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** A failed conversion names the cell kind and, separately, a short value sample. */
type Conversion = { ok: true; value: AnalyticsDataCell } | { ok: false; kind: string; sample?: string; nullViolation?: boolean };

function convertCell(cell: LocalTableCell, field: AnalyticsFieldContract, nullToken: string): Conversion {
  const asNull = (): Conversion => (field.nullable ? { ok: true, value: null } : { ok: false, kind: 'empty cell', nullViolation: true });
  const text = (value: string): Conversion => {
    if (value === nullToken) return asNull();
    try {
      return { ok: true, value: parseDelimitedCell(value, field, 0, nullToken, 'cell') };
    } catch {
      return { ok: false, kind: 'text', sample: JSON.stringify(sample(value)) };
    }
  };
  if (cell.kind === 'text') return text(cell.text);
  if (cell.kind === 'absent') return asNull();
  const source = cell.cell;
  if (!source || source.kind === 'blank' || (source.value === null && source.formula === undefined)) return asNull();
  if (source.formula !== undefined && source.value === null) return { ok: false, kind: 'formula without a stored result' };
  if (source.kind === 'error') return { ok: false, kind: 'an Excel error', sample: sample(source.value) };
  if (source.kind === 'string') return text(String(source.value));
  const typeMismatch = (): Conversion => ({ ok: false, kind: source.kind, sample: JSON.stringify(sample(source.value)) });
  switch (source.kind) {
    case 'integer':
      if (field.logicalType === 'integer' || field.logicalType === 'number') return { ok: true, value: source.value };
      if (field.logicalType === 'string') return { ok: true, value: String(source.value) };
      return typeMismatch();
    case 'number':
      return field.logicalType === 'number' ? { ok: true, value: source.value } : typeMismatch();
    case 'boolean':
      return field.logicalType === 'boolean' ? { ok: true, value: source.value } : typeMismatch();
    case 'date':
      return field.logicalType === 'date' ? { ok: true, value: source.value } : typeMismatch();
    case 'timestamp':
      return field.logicalType === 'timestamp' ? { ok: true, value: source.value } : typeMismatch();
    default:
      return typeMismatch();
  }
}

/**
 * Map the complete table onto one declared schema by exact column name.
 * Every file column must be declared once (no silent column loss); order may
 * differ and output rows use schema order.
 */
export function typeAnalyticsLocalTable(
  table: AnalyticsLocalTable,
  schema: AnalyticsFieldContract[],
  nullToken: string | undefined,
  paths: { source: string; schema: string; fixedDatasetId?: string },
  options: { withholdValues?: boolean } = {},
): { columns: string[]; rows: AnalyticsDataCell[][] } {
  const names = schema.map(field => field.name);
  const missing = names.filter(name => !table.header.includes(name));
  const extra = table.header.filter(name => !names.includes(name));
  const header = `[${table.header.map(name => JSON.stringify(name)).join(', ')}]`;
  if (missing.length || extra.length) {
    reject('invalid_input', 'Schema columns differ from the file header.', dataRoomIssue({
      code: 'columns_mismatch', path: paths.schema,
      message: paths.fixedDatasetId
        ? `The ${table.sheet ? `sheet ${JSON.stringify(table.sheet)} ` : ''}header is exactly ${header}, but dataset ${paths.fixedDatasetId} has columns [${names.map(name => JSON.stringify(name)).join(', ')}] (order may differ).${missing.length ? ` Missing from file: ${missing.join(', ')}.` : ''}${extra.length ? ` Not in the dataset: ${extra.join(', ')}.` : ''} Pick the dataset whose columns match, or create a new dataset from this file with target.`
        : `The ${table.sheet ? `sheet ${JSON.stringify(table.sheet)} ` : ''}header is exactly ${header}. Declare each file column exactly once by the same name (order may differ).${missing.length ? ` Not in file: ${missing.join(', ')}.` : ''}${extra.length ? ` Not declared: ${extra.join(', ')}.` : ''}`,
      expected: { kind: 'relation', description: 'Schema column-name set equals the file header set.' }, received: names,
    }));
  }
  const token = nullToken ?? '';
  const indexes = names.map(name => table.header.indexOf(name));
  const issues: DataRoomFailureIssueV1[] = [];
  const failed = new Set<number>();
  const rows = table.rows.map(row => schema.map((field, fieldIndex) => {
    if (failed.has(fieldIndex)) return null;
    const converted = convertCell(row.cells[indexes[fieldIndex]], field, token);
    if (converted.ok) return converted.value;
    failed.add(fieldIndex);
    if (issues.length < MAX_ISSUES) {
      const where = coordinate(table, row.rowNumber, indexes[fieldIndex]);
      const fixed = paths.fixedDatasetId;
      // Same model-context rule as the profile: structure always, cell values only when allowed.
      const found = converted.sample === undefined
        ? converted.kind
        : options.withholdValues ? `${converted.kind} (value withheld)` : `${converted.kind} ${converted.sample}`;
      issues.push(dataRoomIssue({
        code: converted.nullViolation ? 'null_in_non_nullable_field' : 'cell_type_mismatch',
        path: fixed
          ? `${paths.source}.${converted.nullViolation ? 'nullToken' : 'path'}`
          : `${paths.schema}[${fieldIndex}].${converted.nullViolation ? 'nullable' : 'logicalType'}`,
        message: fixed
          ? `Dataset ${fixed} declares column ${JSON.stringify(field.name)} as ${converted.nullViolation ? 'non-nullable' : field.logicalType}, but ${where} ${converted.nullViolation ? 'is empty' : `holds ${found}`}. The existing contract cannot change here: correct nullToken if that text marks missing values, or import this file as a new dataset with target.`
          : converted.nullViolation
            ? `Column ${JSON.stringify(field.name)} is declared non-nullable but ${where} is empty. Declare nullable:true, or choose the correct nullToken.`
            : `Column ${JSON.stringify(field.name)} is declared ${field.logicalType} but ${where} holds ${found}. Declare a logicalType every cell satisfies (inspect_local_file reports compatibleTypes), or set ${paths.source}.nullToken if that text marks a missing value.`,
        expected: converted.nullViolation
          ? { kind: 'literal', value: true }
          : { kind: 'enum', values: LOGICAL_TYPES },
        received: converted.nullViolation ? field.nullable : field.logicalType,
        includeReceivedValue: true,
      }));
    }
    return null;
  }));
  if (issues.length) reject('invalid_input', `The file has ${issues.length} column type/nullability mismatch(es) against the declared schema.`, issues);
  return { columns: names, rows };
}

export interface AnalyticsLocalFileColumnProfile {
  position: number;
  name: string;
  nonEmpty: number;
  empty: number;
  compatibleTypes: AnalyticsLogicalType[];
  distinctValues: number;
  samples: AnalyticsDataCell[];
  minimum?: AnalyticsDataCell;
  maximum?: AnalyticsDataCell;
  dayRanges?: Array<{ start: string; end: string }>;
  monthRanges?: Array<{ start: string; end: string }>;
  distinctDays?: number;
  rangesTruncated?: boolean;
}

/** Deterministic zero-effect table profile using the exact create-time cell converter. */
export function profileAnalyticsLocalTable(table: AnalyticsLocalTable, nullToken: string | undefined): {
  columns: AnalyticsLocalFileColumnProfile[];
  rowCount: number;
} {
  const token = nullToken ?? '';
  const columns = table.header.map((name, position): AnalyticsLocalFileColumnProfile => {
    const nullable = (logicalType: AnalyticsLogicalType): AnalyticsFieldContract => ({ name, logicalType, nullable: true });
    const compatible = new Set<AnalyticsLogicalType>(LOGICAL_TYPES);
    const distinct = new Set<string>();
    const samples: AnalyticsDataCell[] = [];
    let nonEmpty = 0;
    let empty = 0;
    for (const row of table.rows) {
      const cell = row.cells[position];
      const asString = convertCell(cell, nullable('string'), token);
      if (asString.ok && asString.value === null) {
        empty += 1;
        continue;
      }
      nonEmpty += 1;
      for (const logicalType of [...compatible]) {
        if (!convertCell(cell, nullable(logicalType), token).ok) compatible.delete(logicalType);
      }
      const display = cell.kind === 'text' ? cell.text : cell.kind === 'xlsx' ? cell.cell?.value ?? null : null;
      const key = JSON.stringify(display);
      if (distinct.size < 10_000) distinct.add(key);
      if (samples.length < 3 && !samples.some(value => JSON.stringify(value) === key)) {
        samples.push(typeof display === 'string' ? sample(display) : display);
      }
    }
    const compatibleTypes = LOGICAL_TYPES.filter(type => compatible.has(type) && nonEmpty > 0);
    const profile: AnalyticsLocalFileColumnProfile = {
      position: position + 1,
      name,
      nonEmpty,
      empty,
      compatibleTypes,
      distinctValues: distinct.size,
      samples,
    };
    const ordered = ['integer', 'number', 'date', 'timestamp'].find(type => compatible.has(type as AnalyticsLogicalType)) as AnalyticsLogicalType | undefined;
    if (ordered && nonEmpty > 0) {
      const values = table.rows
        .map(row => convertCell(row.cells[position], nullable(ordered), token))
        .flatMap(value => (value.ok && value.value !== null ? [value.value] : []));
      const sorted = [...values].sort((left, right) => (left! < right! ? -1 : left! > right! ? 1 : 0));
      profile.minimum = sorted[0];
      profile.maximum = sorted.at(-1);
      if (ordered === 'date' || ordered === 'timestamp') {
        const days = new Set(values.map(value => String(value).slice(0, 10)));
        const dayRanges = compactAnalyticsPartitionRanges(days, 'day');
        const monthRanges = compactAnalyticsPartitionRanges([...days].map(day => `${day.slice(0, 7)}-01`), 'month');
        profile.distinctDays = days.size;
        profile.dayRanges = dayRanges.slice(0, 128);
        profile.monthRanges = monthRanges.slice(0, 128);
        if (dayRanges.length > 128 || monthRanges.length > 128) profile.rangesTruncated = true;
      }
    }
    return profile;
  });
  return { columns, rowCount: table.rows.length };
}
