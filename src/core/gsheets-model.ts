/**
 * Google Sheets as BotBoy reads and edits them (google-workspace.md, "Sheets").
 *
 * The read view is one line per row, "N: a | b | c" with the row number, under
 * a "cols: A | B | C" line, the same granularity as a numbered read: a cell is
 * addressed by its column letter and row number. A formula shows as
 * "=B2*C2 → 144" (what was typed, then what it shows); "|" in a cell is "\|".
 *
 * Edits are planned against the tabs as read: structure first (add, rename,
 * delete tabs; insert and delete rows and columns; freeze; format) in one
 * atomic batchUpdate, then values (set, clear, append) as the owner would type
 * them (USER_ENTERED: formulas, numbers, dates and percents are understood).
 * `expect` is checked against the cells before anything changes.
 */

import type { SheetProperties } from './google-workspace-api.js';

export const MAX_SHEET_EDIT_CELLS = 10_000;

export function colToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

export function indexToCol(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface A1Range {
  sheet?: string;
  /** 0-based, inclusive starts and exclusive ends; undefined = open. */
  startRow?: number;
  endRow?: number;
  startCol?: number;
  endCol?: number;
}

/** Parses "Sheet!A1:B2", "'My tab'!A:C", "B2", "2:5", "A:A", or a bare tab name. */
export function parseA1(input: string): A1Range | null {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 300) return null;
  let sheet: string | undefined;
  let cells = raw;
  const quoted = raw.match(/^'((?:[^']|'')+)'(?:!(.*))?$/);
  if (quoted) {
    sheet = quoted[1].replace(/''/g, "'");
    cells = quoted[2] ?? '';
  } else if (raw.includes('!')) {
    const at = raw.lastIndexOf('!');
    sheet = raw.slice(0, at);
    cells = raw.slice(at + 1);
  } else if (!/^[A-Za-z]{0,3}\d*(?::[A-Za-z]{0,3}\d*)?$/.test(raw) || /^[A-Za-z]{4,}$/.test(raw)) {
    return { sheet: raw };
  }
  if (!cells) return { sheet };
  const part = (text: string): { col?: number; row?: number } | null => {
    const match = text.match(/^([A-Za-z]{1,3})?(\d{1,7})?$/);
    if (!match || (!match[1] && !match[2])) return null;
    return { ...(match[1] ? { col: colToIndex(match[1]) } : {}), ...(match[2] ? { row: Number(match[2]) - 1 } : {}) };
  };
  const [left, right] = cells.split(':');
  const a = part(left);
  if (!a) return null;
  if (right === undefined) {
    return { ...(sheet ? { sheet } : {}), ...(a.row !== undefined ? { startRow: a.row, endRow: a.row + 1 } : {}), ...(a.col !== undefined ? { startCol: a.col, endCol: a.col + 1 } : {}) };
  }
  const b = part(right);
  if (!b) return null;
  return {
    ...(sheet ? { sheet } : {}),
    ...(a.row !== undefined ? { startRow: a.row } : {}),
    ...(b.row !== undefined ? { endRow: b.row + 1 } : {}),
    ...(a.col !== undefined ? { startCol: a.col } : {}),
    ...(b.col !== undefined ? { endCol: b.col + 1 } : {}),
  };
}

/** A tab name as Sheets wants it in a range: quoted when needed. */
export function quoteSheet(name: string): string {
  return /^[A-Za-z0-9_]+$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** "Tab!A1:C3" from a parsed range on a resolved tab. */
export function a1Of(sheet: string, range: A1Range): string {
  const start = `${range.startCol !== undefined ? indexToCol(range.startCol) : ''}${range.startRow !== undefined ? range.startRow + 1 : ''}`;
  const end = `${range.endCol !== undefined ? indexToCol(range.endCol - 1) : ''}${range.endRow !== undefined ? range.endRow : ''}`;
  if (!start && !end) return quoteSheet(sheet);
  const single = range.endRow !== undefined && range.startRow !== undefined && range.endRow - range.startRow === 1
    && range.endCol !== undefined && range.startCol !== undefined && range.endCol - range.startCol === 1;
  return `${quoteSheet(sheet)}!${start || 'A1'}${single ? '' : `:${end || start}`}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '⏎');
}

/** One row's cells, formulas with what they show; trailing empty cells dropped. */
export function rowLine(formulas: readonly unknown[] = [], shown: readonly unknown[] = []): string {
  const width = Math.max(formulas.length, shown.length);
  const cells: string[] = [];
  for (let c = 0; c < width; c++) {
    const formula = formulas[c];
    const display = shown[c];
    if (typeof formula === 'string' && formula.startsWith('=')) cells.push(`${cellText(formula)} → ${cellText(display)}`);
    else cells.push(cellText(display ?? formula));
  }
  while (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells.join(' | ');
}

// ── Edits ────────────────────────────────────────────────────────────────────

export const SHEET_ACTIONS = ['set', 'append', 'clear', 'add_sheet', 'rename_sheet', 'delete_sheet', 'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'freeze', 'format'] as const;
export type SheetAction = typeof SHEET_ACTIONS[number];

export interface SheetEditPlan {
  ok: true;
  structural: unknown[];
  sets: Array<{ range: string; values: unknown[][] }>;
  clears: string[];
  appends: Array<{ range: string; values: unknown[][] }>;
  expects: Array<{ index: number; range: string; values: unknown[][] }>;
  /** Per edit, what it will do (for the receipt). */
  summary: Array<{ edit: number; action: SheetAction; range?: string; sheet?: string; cells?: number }>;
}

export interface SheetPlanFailure {
  ok: false;
  index?: number;
  message: string;
}

function isCell(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isGrid(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.length > 0 && value.every(row => Array.isArray(row) && row.every(isCell));
}

function hexColor(value: unknown): { red: number; green: number; blue: number } | null {
  const match = String(value ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

function numberFormatOf(pattern: string): { type: string; pattern: string } {
  const type = /%/.test(pattern) ? 'PERCENT'
    : /[$€£¥₹]/.test(pattern) ? 'CURRENCY'
      : /[yd]/i.test(pattern) && /[hHs]/.test(pattern) ? 'DATE_TIME'
        : /[yd]/i.test(pattern) || /mmm/i.test(pattern) ? 'DATE'
          : /[hHs]/.test(pattern) ? 'TIME'
            : /^@$/.test(pattern) ? 'TEXT'
              : /E/i.test(pattern) ? 'SCIENTIFIC'
                : 'NUMBER';
  return { type, pattern };
}

/**
 * Plan edits against the tabs as read. Tab names resolve case-insensitively;
 * a range without a tab uses `sheet`, else the first tab.
 */
export function planSheetEdits(tabs: readonly SheetProperties[], edits: readonly Record<string, unknown>[]): SheetEditPlan | SheetPlanFailure {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 50) return { ok: false, message: 'edits must be a list of 1 to 50 edits.' };
  // The tabs as they will be after each structural edit (adds and renames resolve later edits).
  const current = tabs.map(tab => ({
    sheetId: tab.sheetId as number | null,
    title: tab.title,
    pendingId: null as number | null,
    // The grid as it will be after the structural edits so far (a write past it grows it first).
    rows: tab.gridProperties?.rowCount ?? 1000,
    cols: tab.gridProperties?.columnCount ?? 26,
  }));
  const deleted = new Set<string>();
  let nextTemp = -1;
  /** Rows or columns appended before the values are written, so a write past the grid's edge lands instead of failing. */
  const growTo = (tab: (typeof current)[number], rows: number, cols: number) => {
    if (tab.sheetId === null) return;
    if (rows > tab.rows) {
      plan.structural.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: rows - tab.rows } });
      tab.rows = rows;
    }
    if (cols > tab.cols) {
      plan.structural.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: cols - tab.cols } });
      tab.cols = cols;
    }
  };
  const findTab = (name: string) => current.find(tab => tab.title.toLowerCase() === name.trim().toLowerCase());
  const plan: SheetEditPlan = { ok: true, structural: [], sets: [], clears: [], appends: [], expects: [], summary: [] };
  let cells = 0;
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return { ok: false, index, message: `edits[${index}] must be an object with an action.` };
    const action = String(edit.action ?? '') as SheetAction;
    if (!SHEET_ACTIONS.includes(action)) return { ok: false, index, message: `edits[${index}].action must be one of: ${SHEET_ACTIONS.join(', ')}.` };
    const fail = (message: string): SheetPlanFailure => ({ ok: false, index, message: `edits[${index}] (${action}): ${message}` });
    const tabNamed = (field: string, required: boolean) => {
      const name = typeof edit[field] === 'string' ? String(edit[field]).trim() : '';
      if (!name) {
        if (required) return { error: fail(`${field} is required (a tab name from the read).`) };
        return { tab: current[0] };
      }
      const tab = findTab(name);
      if (!tab) return { error: fail(`no tab named "${name.slice(0, 80)}"; tabs: ${current.map(entry => entry.title).join(', ')}.`) };
      return { tab };
    };
    /** A range on a tab: "Tab!A1:B2", or "A1:B2" on edit.sheet (else the first tab). */
    const rangeOf = (required: boolean) => {
      const raw = typeof edit.range === 'string' ? edit.range.trim() : '';
      if (!raw) {
        if (required) return { error: fail('range is required, like "B2" or "Sheet1!A1:C3".') };
        const picked = tabNamed('sheet', false);
        if ('error' in picked) return picked;
        return { tab: picked.tab!, range: {} as A1Range };
      }
      const parsed = parseA1(raw);
      if (!parsed) return { error: fail(`range "${raw.slice(0, 80)}" is not an A1 range like "B2", "A1:C3" or "Sheet1!A:A".`) };
      const tabName = parsed.sheet ?? (typeof edit.sheet === 'string' && edit.sheet.trim() ? String(edit.sheet) : '');
      const tab = tabName ? findTab(tabName) : current[0];
      if (!tab) return { error: fail(`no tab named "${tabName.slice(0, 80)}"; tabs: ${current.map(entry => entry.title).join(', ')}.`) };
      return { tab, range: parsed };
    };
    const gridRange = (tab: { sheetId: number | null }, range: A1Range) => ({
      sheetId: tab.sheetId,
      ...(range.startRow !== undefined ? { startRowIndex: range.startRow } : {}),
      ...(range.endRow !== undefined ? { endRowIndex: range.endRow } : {}),
      ...(range.startCol !== undefined ? { startColumnIndex: range.startCol } : {}),
      ...(range.endCol !== undefined ? { endColumnIndex: range.endCol } : {}),
    });
    const notDeleted = (tab: { title: string }) => (deleted.has(tab.title.toLowerCase()) ? fail(`tab "${tab.title}" is deleted earlier in this call.`) : null);

    if (action === 'set' || action === 'append') {
      if (!isGrid(edit.values)) return fail('values must be rows of cells: [["a", 1], ["b", 2]] (text, numbers, true/false, or null for empty).');
      const values = edit.values as unknown[][];
      cells += values.reduce((sum, row) => sum + row.length, 0);
      if (cells > MAX_SHEET_EDIT_CELLS) return fail(`more than ${MAX_SHEET_EDIT_CELLS.toLocaleString('en-US')} cells in one call; split it.`);
      if (action === 'append') {
        const picked = typeof edit.range === 'string' && edit.range.trim() ? rangeOf(true) : tabNamed('sheet', false);
        if ('error' in picked) return picked.error!;
        const tab = picked.tab!;
        const blocked = notDeleted(tab);
        if (blocked) return blocked;
        const range = 'range' in picked && picked.range && Object.keys(picked.range).some(key => key !== 'sheet') ? a1Of(tab.title, picked.range) : quoteSheet(tab.title);
        // Append adds the rows it needs; a row wider than the grid needs its columns first.
        const startCol = 'range' in picked && picked.range ? (picked.range as A1Range).startCol ?? 0 : 0;
        growTo(tab, 0, startCol + Math.max(...values.map(row => row.length)));
        plan.appends.push({ range, values });
        plan.summary.push({ edit: index, action, sheet: tab.title, range, cells: values.reduce((sum, row) => sum + row.length, 0) });
        continue;
      }
      const picked = rangeOf(true);
      if ('error' in picked) return picked.error!;
      const { tab, range } = picked as { tab: (typeof current)[number]; range: A1Range };
      const blocked = notDeleted(tab);
      if (blocked) return blocked;
      if (range.startRow === undefined || range.startCol === undefined) return fail('range must start at a cell, like "B2" or "B2:D4".');
      const rows = values.length;
      const cols = Math.max(...values.map(row => row.length));
      if (range.endRow !== undefined && range.endCol !== undefined) {
        const boxRows = range.endRow - range.startRow;
        const boxCols = range.endCol - range.startCol;
        if (!(boxRows === 1 && boxCols === 1) && (rows > boxRows || cols > boxCols)) return fail(`values are ${rows}×${cols} but the range is ${boxRows}×${boxCols}; give just the first cell (like "B2") or a range that fits.`);
      }
      growTo(tab, range.startRow + rows, range.startCol + cols);
      const target = a1Of(tab.title, { startRow: range.startRow, startCol: range.startCol, endRow: range.startRow + rows, endCol: range.startCol + cols });
      plan.sets.push({ range: target, values });
      if (edit.expect !== undefined) {
        if (!Array.isArray(edit.expect) || !(edit.expect as unknown[]).every(row => Array.isArray(row))) return fail('expect must be rows of cells, like values: what the cells hold now.');
        const expect = edit.expect as unknown[][];
        plan.expects.push({ index, range: a1Of(tab.title, { startRow: range.startRow, startCol: range.startCol, endRow: range.startRow + expect.length, endCol: range.startCol + Math.max(1, ...expect.map(row => row.length)) }), values: expect });
      }
      plan.summary.push({ edit: index, action, sheet: tab.title, range: target, cells: values.reduce((sum, row) => sum + row.length, 0) });
      continue;
    }
    if (action === 'clear') {
      const picked = rangeOf(true);
      if ('error' in picked) return picked.error!;
      const { tab, range } = picked as { tab: { title: string }; range: A1Range };
      const blocked = notDeleted(tab);
      if (blocked) return blocked;
      const target = a1Of(tab.title, range);
      plan.clears.push(target);
      plan.summary.push({ edit: index, action, sheet: tab.title, range: target });
      continue;
    }
    if (action === 'add_sheet') {
      const name = typeof edit.name === 'string' ? edit.name.trim() : '';
      if (!name || name.length > 100 || /[[\]*?/\\:]/.test(name)) return fail('name is the new tab name (1 to 100 characters, none of [ ] * ? / \\ :).');
      if (findTab(name)) return fail(`a tab named "${name}" already exists.`);
      const rows = edit.rows === undefined ? undefined : Number(edit.rows);
      const columns = edit.columns === undefined ? undefined : Number(edit.columns);
      if ((rows !== undefined && (!Number.isInteger(rows) || rows < 1 || rows > 100_000)) || (columns !== undefined && (!Number.isInteger(columns) || columns < 1 || columns > 1000))) return fail('rows (1 to 100,000) and columns (1 to 1,000) are whole numbers.');
      const pendingId = nextTemp--;
      current.push({ sheetId: null, title: name, pendingId, rows: rows ?? 1000, cols: columns ?? 26 });
      plan.structural.push({ addSheet: { properties: { title: name, ...(rows || columns ? { gridProperties: { ...(rows ? { rowCount: rows } : {}), ...(columns ? { columnCount: columns } : {}) } } : {}) } } });
      plan.summary.push({ edit: index, action, sheet: name });
      continue;
    }
    const picked = tabNamed('sheet', action === 'rename_sheet' || action === 'delete_sheet');
    if ('error' in picked) return picked.error!;
    const tab = picked.tab!;
    const blocked = notDeleted(tab);
    if (blocked) return blocked;
    if (tab.sheetId === null && action !== 'rename_sheet') return fail(`tab "${tab.title}" is added in this call; change its rows, columns or format in a second call once it exists.`);
    if (action === 'rename_sheet') {
      const name = typeof edit.name === 'string' ? edit.name.trim() : '';
      if (!name || name.length > 100 || /[[\]*?/\\:]/.test(name)) return fail('name is the new tab name (1 to 100 characters, none of [ ] * ? / \\ :).');
      if (findTab(name) && findTab(name) !== tab) return fail(`a tab named "${name}" already exists.`);
      if (tab.sheetId === null) return fail('rename a tab added in this call by giving it the right name when you add it.');
      plan.structural.push({ updateSheetProperties: { properties: { sheetId: tab.sheetId, title: name }, fields: 'title' } });
      plan.summary.push({ edit: index, action, sheet: `${tab.title} → ${name}` });
      tab.title = name;
      continue;
    }
    if (action === 'delete_sheet') {
      if (current.filter(entry => !deleted.has(entry.title.toLowerCase())).length <= 1) return fail('a spreadsheet keeps at least one tab.');
      plan.structural.push({ deleteSheet: { sheetId: tab.sheetId } });
      deleted.add(tab.title.toLowerCase());
      plan.summary.push({ edit: index, action, sheet: tab.title });
      continue;
    }
    if (action === 'insert_rows' || action === 'delete_rows' || action === 'insert_columns' || action === 'delete_columns') {
      const rowsAction = action.endsWith('_rows');
      const count = edit.count === undefined ? 1 : Number(edit.count);
      if (!Number.isInteger(count) || count < 1 || count > 10_000) return fail('count is a whole number from 1 to 10,000.');
      let at: number;
      if (rowsAction) {
        at = Number(edit.at);
        if (!Number.isInteger(at) || at < 1) return fail('at is the row number (1 = the first row).');
        at -= 1;
      } else {
        const letters = String(edit.at ?? '').trim();
        if (!/^[A-Za-z]{1,3}$/.test(letters)) return fail('at is the column letter, like "C".');
        at = colToIndex(letters);
      }
      const range = { sheetId: tab.sheetId, dimension: rowsAction ? 'ROWS' : 'COLUMNS', startIndex: at, endIndex: at + count };
      const size = rowsAction ? tab.rows : tab.cols;
      if (action.startsWith('delete') && at + count > size) return fail(`the tab has ${size} ${rowsAction ? 'rows' : 'columns'}, so that deletes past its end.`);
      if (action.startsWith('delete') && count >= size) return fail(`a tab keeps at least one ${rowsAction ? 'row' : 'column'}.`);
      if (action.startsWith('insert') && at > size) return fail(`the tab has ${size} ${rowsAction ? 'rows' : 'columns'}; insert at or before the end.`);
      const delta = action.startsWith('insert') ? count : -count;
      if (rowsAction) tab.rows += delta;
      else tab.cols += delta;
      plan.structural.push(action.startsWith('insert') ? { insertDimension: { range, inheritFromBefore: at > 0 } } : { deleteDimension: { range } });
      plan.summary.push({ edit: index, action, sheet: tab.title, range: rowsAction ? `rows ${at + 1}–${at + count}` : `columns ${indexToCol(at)}–${indexToCol(at + count - 1)}` });
      continue;
    }
    if (action === 'freeze') {
      const rows = edit.rows === undefined ? undefined : Number(edit.rows);
      const columns = edit.columns === undefined ? undefined : Number(edit.columns);
      if (rows === undefined && columns === undefined) return fail('give rows and/or columns to freeze (0 unfreezes).');
      if ((rows !== undefined && (!Number.isInteger(rows) || rows < 0 || rows > 100)) || (columns !== undefined && (!Number.isInteger(columns) || columns < 0 || columns > 26))) return fail('rows (0 to 100) and columns (0 to 26) are whole numbers.');
      const fields = [rows !== undefined ? 'gridProperties.frozenRowCount' : '', columns !== undefined ? 'gridProperties.frozenColumnCount' : ''].filter(Boolean).join(',');
      plan.structural.push({ updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { ...(rows !== undefined ? { frozenRowCount: rows } : {}), ...(columns !== undefined ? { frozenColumnCount: columns } : {}) } }, fields } });
      plan.summary.push({ edit: index, action, sheet: tab.title });
      continue;
    }
    // format
    const formatRange = rangeOf(true);
    if ('error' in formatRange) return formatRange.error!;
    const { tab: formatTab, range } = formatRange as { tab: { title: string; sheetId: number | null }; range: A1Range };
    if (formatTab.sheetId === null) return fail(`tab "${formatTab.title}" is added in this call; format it in a second call.`);
    const format: Record<string, unknown> = {};
    const textFormat: Record<string, unknown> = {};
    const fields: string[] = [];
    if (edit.bold !== undefined) { textFormat.bold = edit.bold === true; fields.push('userEnteredFormat.textFormat.bold'); }
    if (edit.italic !== undefined) { textFormat.italic = edit.italic === true; fields.push('userEnteredFormat.textFormat.italic'); }
    if (edit.fontSize !== undefined) {
      const size = Number(edit.fontSize);
      if (!Number.isInteger(size) || size < 6 || size > 72) return fail('fontSize is a whole number from 6 to 72.');
      textFormat.fontSize = size; fields.push('userEnteredFormat.textFormat.fontSize');
    }
    if (edit.textColor !== undefined) {
      const color = hexColor(edit.textColor);
      if (!color) return fail('textColor is a hex colour like "#1a73e8".');
      textFormat.foregroundColor = color; fields.push('userEnteredFormat.textFormat.foregroundColor');
    }
    if (Object.keys(textFormat).length) format.textFormat = textFormat;
    if (edit.background !== undefined) {
      const color = hexColor(edit.background);
      if (!color) return fail('background is a hex colour like "#fff2cc".');
      format.backgroundColor = color; fields.push('userEnteredFormat.backgroundColor');
    }
    if (edit.numberFormat !== undefined) {
      const pattern = String(edit.numberFormat ?? '').trim();
      if (!pattern || pattern.length > 100) return fail('numberFormat is a pattern like "0.00%", "#,##0", "yyyy-mm-dd" or "$#,##0.00".');
      format.numberFormat = numberFormatOf(pattern); fields.push('userEnteredFormat.numberFormat');
    }
    if (edit.align !== undefined) {
      const align = String(edit.align).toUpperCase();
      if (!['LEFT', 'CENTER', 'RIGHT'].includes(align)) return fail('align is left, center or right.');
      format.horizontalAlignment = align; fields.push('userEnteredFormat.horizontalAlignment');
    }
    if (edit.wrap !== undefined) {
      format.wrapStrategy = edit.wrap === true ? 'WRAP' : 'OVERFLOW_CELL'; fields.push('userEnteredFormat.wrapStrategy');
    }
    if (!fields.length) return fail('give at least one of bold, italic, fontSize, textColor, background, numberFormat, align, wrap.');
    plan.structural.push({ repeatCell: { range: gridRange(formatTab, range), cell: { userEnteredFormat: format }, fields: fields.join(',') } });
    plan.summary.push({ edit: index, action, sheet: formatTab.title, range: a1Of(formatTab.title, range) });
  }
  return plan;
}

/** Cells that differ between what `expect` says and what the sheet holds (typed or shown). */
export function expectMismatches(expect: unknown[][], typed: unknown[][] = [], shown: unknown[][] = [], startRow: number, startCol: number): Array<{ cell: string; expected: string; actual: string }> {
  const out: Array<{ cell: string; expected: string; actual: string }> = [];
  const norm = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim());
  for (let r = 0; r < expect.length; r++) {
    for (let c = 0; c < expect[r].length; c++) {
      const want = norm(expect[r][c]);
      const asTyped = norm(typed[r]?.[c]);
      const asShown = norm(shown[r]?.[c]);
      if (want !== asTyped && want !== asShown) out.push({ cell: `${indexToCol(startCol + c)}${startRow + r + 1}`, expected: want, actual: asShown || asTyped });
    }
  }
  return out;
}
