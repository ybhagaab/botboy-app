import { AnalyticsDataRoomError, isAnalyticsIsoTimestamp } from './analytics-data-room-store.js';
import type { AnalyticsDataCell, AnalyticsFieldContract } from './analytics-data-room-types.js';

/**
 * The one strict delimited-text grammar for Data Room sources. Local-file
 * imports and Datanet ETL results both read through these functions (via
 * `readAnalyticsDelimitedTable`), so the same bytes type identically whichever
 * lane brought them in.
 */

/** Largest complete delimited table one Data Room source admits. */
export const ANALYTICS_DELIMITED_MAX_ROWS = 50_000;
export const ANALYTICS_DELIMITED_MAX_CELLS = 500_000;

function incomplete(message: string): never {
  throw new AnalyticsDataRoomError('incomplete_source', message);
}

function parseDelimitedRows(text: string, delimiter: '\t' | ',', label: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  const pushCell = (): void => {
    row.push(cell);
    cell = '';
    closedQuote = false;
  };
  const pushRow = (): void => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (character === '\r' && text[index + 1] === '\n') {
        cell += '\n';
        index++;
      } else {
        cell += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character === delimiter) {
        pushCell();
        continue;
      }
      if (character === '\n') {
        pushRow();
        continue;
      }
      if (character === '\r' && text[index + 1] === '\n') {
        pushRow();
        index++;
        continue;
      }
      incomplete(`Unexpected character after a quoted ${label} field at offset ${index}.`);
    }

    if (character === '"') {
      if (cell.length !== 0) incomplete(`Unexpected quote in an unquoted ${label} field at offset ${index}.`);
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      pushCell();
      continue;
    }
    if (character === '\n') {
      if (row.length === 0 && cell.length === 0) incomplete(`Blank ${label} record at offset ${index}.`);
      pushRow();
      continue;
    }
    if (character === '\r') {
      if (text[index + 1] !== '\n') incomplete(`Lone carriage return in ${label} input at offset ${index}.`);
      if (row.length === 0 && cell.length === 0) incomplete(`Blank ${label} record at offset ${index}.`);
      pushRow();
      index++;
      continue;
    }
    cell += character;
  }

  if (quoted) incomplete(`${label} input ends inside a quoted field.`);
  if (closedQuote || cell.length > 0 || row.length > 0) pushRow();
  return rows;
}

/**
 * Strict complete UTF-8 delimited-table parser. Records may omit trailing
 * fields (ragged-right exporters such as Datanet write short rows; the
 * omitted cells come back absent), but never carry extra fields, and a short
 * unterminated final record is rejected because it may be a truncated file.
 */
export function parseAnalyticsDelimited(
  bytes: Uint8Array,
  delimiter: '\t' | ',',
  label: string,
): { columns: string[]; rawRows: string[][] } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return incomplete(`${label} is not valid UTF-8.`);
  }
  if (text.includes('\0')) incomplete(`${label} contains a NUL byte.`);
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows = parseDelimitedRows(text, delimiter, label);
  if (rows.length === 0) incomplete(`${label} is empty.`);
  const columns = rows[0];
  if (columns.length === 0 || columns.length > 200 || columns.some(column => !column || column.trim() !== column)) {
    incomplete(`${label} headers must contain 1 to 200 non-empty names without surrounding whitespace.`);
  }
  if (new Set(columns).size !== columns.length) incomplete(`${label} contains duplicate headers.`);
  const rawRows = rows.slice(1);
  if (rawRows.length > ANALYTICS_DELIMITED_MAX_ROWS || rawRows.length * columns.length > ANALYTICS_DELIMITED_MAX_CELLS) {
    incomplete(`${label} exceeds the ${ANALYTICS_DELIMITED_MAX_ROWS}-row or ${ANALYTICS_DELIMITED_MAX_CELLS}-cell complete-source limit.`);
  }
  const terminated = text.endsWith('\n');
  for (const [index, row] of rawRows.entries()) {
    const shortAllowed = row.length < columns.length && (terminated || index < rawRows.length - 1);
    if (row.length !== columns.length && !shortAllowed) {
      incomplete(`${label} row ${index + 1} has ${row.length} cells; expected ${columns.length}.`);
    }
    if (row.some(cell => cell.length > 1_000_000)) incomplete(`${label} row ${index + 1} contains a cell above 1000000 characters.`);
  }
  return { columns, rawRows };
}

/** One strict text-cell grammar for every delimited or text-typed source cell. */
export function parseDelimitedCell(
  raw: string,
  field: AnalyticsFieldContract,
  rowIndex: number,
  nullToken: string,
  label: string,
): AnalyticsDataCell {
  if (raw === nullToken) {
    if (!field.nullable) incomplete(`${label} row ${rowIndex} field ${field.name} may not be null.`);
    return null;
  }
  if (field.logicalType === 'string') return raw;
  if (field.logicalType === 'integer') {
    if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) incomplete(`${label} row ${rowIndex} field ${field.name} is not an integer.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) incomplete(`${label} row ${rowIndex} field ${field.name} exceeds safe integer precision.`);
    return value;
  }
  if (field.logicalType === 'number') {
    if (!raw || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
      incomplete(`${label} row ${rowIndex} field ${field.name} is not a finite number.`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) incomplete(`${label} row ${rowIndex} field ${field.name} is not a finite number.`);
    return value;
  }
  if (field.logicalType === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return incomplete(`${label} row ${rowIndex} field ${field.name} is not a boolean.`);
  }
  if (field.logicalType === 'date') {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)
      || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== raw) {
      incomplete(`${label} row ${rowIndex} field ${field.name} is not an ISO calendar date.`);
    }
    return raw;
  }
  if (!isAnalyticsIsoTimestamp(raw)) {
    incomplete(`${label} row ${rowIndex} field ${field.name} is not an ISO timestamp.`);
  }
  return raw;
}
