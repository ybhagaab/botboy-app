/**
 * Google Sheets in chat (google-workspace.md, "Sheets"): gdrive_read shows a
 * tab as numbered rows (gsheets-model.ts), and gdrive_edit on a Sheet changes
 * cells, rows, columns, tabs and formats in place.
 *
 *   gdrive_read {fileId, sheet?, range?, startLine?, endLine?}  rows by number
 *   gdrive_edit {fileId, edits: [{action, …}], valueInput?: user_entered|raw}
 *
 * Structure goes first in one atomic batchUpdate, then values; `expect` is
 * checked against the cells before anything changes. Google's own counts
 * (updated cells, the appended range) are the receipt.
 */

import type { ToolResult } from './tool-executor.js';
import { GDRIVE_SHEET_MIME, type DriveFile } from './gdrive-api.js';
import { redactSecrets } from './sensitive-files.js';
import type { SheetProperties, Spreadsheet } from './google-workspace-api.js';
import { a1Of, expectMismatches, indexToCol, parseA1, planSheetEdits, quoteSheet, rowLine } from './gsheets-model.js';
import { GOOGLE_READ_BUDGET_CHARS, googleErrorFailure, googleResult, invalid, untrustedEnvelope } from './google-tool-support.js';
import { accountEmail, failedResult, type GoogleToolEnv, type LocatedFile } from './google-tool-env.js';

/** Rows asked for in one read (the budget may show fewer). */
const ROWS_PER_READ = 500;
/** Columns shown without a range (A to AZ). */
const DEFAULT_COLUMNS = 52;

function tabsOf(sheet: Spreadsheet): SheetProperties[] {
  return (sheet.sheets ?? []).map(entry => entry.properties).filter(Boolean);
}

export async function readSheet(env: GoogleToolEnv, accountId: string, file: DriveFile, fallback: () => Promise<ToolResult>): Promise<ToolResult> {
  const sheets = env.workspaceFor(accountId)?.sheets;
  if (!sheets) return fallback();
  let meta: Spreadsheet;
  try {
    meta = await sheets.get(file.id);
  } catch (error) {
    const failure = googleErrorFailure(error, false, 'Google Sheets read');
    if (failure.code === 'api_not_enabled' || failure.code === 'reconnect_for_scope') {
      const plain = await fallback();
      try {
        const parsed = JSON.parse(plain.content);
        parsed.result = { ...(parsed.result ?? {}), editing: `Cell-level reads and edits are not available yet: ${failure.message} ${failure.nextAction}` };
        return { ...plain, content: JSON.stringify(parsed, null, 1) };
      } catch {
        return plain;
      }
    }
    return failedResult(env, failure);
  }
  const tabs = tabsOf(meta);
  if (!tabs.length) return failedResult(env, invalid('This spreadsheet has no tabs BotBoy can read.'));
  const wantedTab = typeof env.args.sheet === 'string' ? env.args.sheet.trim() : '';
  const rangeArg = typeof env.args.range === 'string' ? env.args.range.trim() : '';
  const parsedRange = rangeArg ? parseA1(rangeArg) : null;
  if (rangeArg && !parsedRange) return failedResult(env, invalid(`range "${rangeArg.slice(0, 80)}" is not an A1 range like "A1:F50" or "Sheet1!B:D".`));
  const tabName = parsedRange?.sheet ?? wantedTab;
  const tab = tabName ? tabs.find(entry => entry.title.toLowerCase() === tabName.toLowerCase()) : tabs.find(entry => entry.sheetType !== 'OBJECT') ?? tabs[0];
  if (!tab) return failedResult(env, invalid(`No tab named "${tabName.slice(0, 80)}".`, [{ path: 'sheet', message: `one of: ${tabs.map(entry => entry.title).join(', ')}` }]));
  const startRowArg = env.args.startLine === undefined ? undefined : Number(env.args.startLine);
  const endRowArg = env.args.endLine === undefined ? undefined : Number(env.args.endLine);
  if ((startRowArg !== undefined && (!Number.isInteger(startRowArg) || startRowArg < 1)) || (endRowArg !== undefined && (!Number.isInteger(endRowArg) || endRowArg < 1))) {
    return failedResult(env, invalid('startLine and endLine are row numbers (1 = the first row).'));
  }
  // A read stays inside the tab's grid: Google refuses a range past its last row or column.
  const totalRows = tab.gridProperties?.rowCount ?? Number.POSITIVE_INFINITY;
  const totalColumns = tab.gridProperties?.columnCount ?? DEFAULT_COLUMNS;
  const firstRow = (parsedRange?.startRow ?? (startRowArg !== undefined ? startRowArg - 1 : 0));
  const firstCol = parsedRange?.startCol ?? 0;
  if (firstRow >= totalRows || firstCol >= totalColumns) {
    return failedResult(env, invalid(`That is past the end of tab "${tab.title}", which has ${totalRows} rows and ${totalColumns} columns (A to ${indexToCol(totalColumns - 1)}).`, undefined, 'Read a range inside the tab, or from row 1.'));
  }
  const lastRowExclusive = Math.min(
    firstRow + ROWS_PER_READ,
    totalRows,
    parsedRange?.endRow ?? (endRowArg !== undefined ? endRowArg : Number.POSITIVE_INFINITY),
  );
  const lastColExclusive = Math.min(totalColumns, parsedRange?.endCol ?? DEFAULT_COLUMNS);
  const range = a1Of(tab.title, { startRow: firstRow, endRow: Number.isFinite(lastRowExclusive) ? lastRowExclusive : firstRow + ROWS_PER_READ, startCol: firstCol, endCol: lastColExclusive });
  let typed: unknown[][] = [];
  let shown: unknown[][] = [];
  try {
    const [formulas, values] = await Promise.all([
      sheets.valuesBatchGet(file.id, [range], 'FORMULA'),
      sheets.valuesBatchGet(file.id, [range], 'FORMATTED_VALUE'),
    ]);
    typed = formulas.valueRanges[0]?.values ?? [];
    shown = values.valueRanges[0]?.values ?? [];
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, false, 'Google Sheets read'));
  }
  const rowCount = Math.max(typed.length, shown.length);
  const out: string[] = [`cols: ${Array.from({ length: Math.max(1, lastColExclusive - firstCol) }, (_, c) => indexToCol(firstCol + c)).join(' | ')}`];
  let size = out[0].length;
  let shownRows = 0;
  for (let r = 0; r < rowCount; r++) {
    const line = `${firstRow + r + 1}: ${redactSecrets(rowLine(typed[r], shown[r]))}`;
    if (size + line.length + 1 > GOOGLE_READ_BUDGET_CHARS && shownRows > 0) break;
    out.push(line.length > GOOGLE_READ_BUDGET_CHARS ? `${line.slice(0, GOOGLE_READ_BUDGET_CHARS - 200)}… [row cut]` : line);
    size += line.length + 1;
    shownRows++;
  }
  const endRow = firstRow + shownRows;
  // Rows past this window may hold data (Google leaves out only the empty rows at its end), up to the tab's last row.
  const explicitEnd = parsedRange?.endRow !== undefined || endRowArg !== undefined;
  const nextStartLine = shownRows < rowCount
    ? endRow + 1
    : !explicitEnd && lastRowExclusive < totalRows ? lastRowExclusive + 1 : null;
  return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id, webViewLink: file.webViewLink }, {
    ok: true,
    fileId: file.id,
    name: redactSecrets(file.name ?? meta.properties?.title ?? ''),
    kind: 'sheet',
    account: accountEmail(env, accountId),
    webViewLink: file.webViewLink,
    tabs: tabs.map(entry => ({ name: entry.title, rows: entry.gridProperties?.rowCount, columns: entry.gridProperties?.columnCount, ...(entry.gridProperties?.frozenRowCount ? { frozenRows: entry.gridProperties.frozenRowCount } : {}) })),
    sheet: tab.title,
    range,
    ...(shownRows ? { rows: `${firstRow + 1}–${endRow}` } : { rows: 'none (empty here)' }),
    nextStartLine,
    ...(totalColumns > lastColExclusive && !parsedRange?.endCol ? { moreColumns: `Columns after ${indexToCol(lastColExclusive - 1)} are not shown; read them with range.` } : {}),
    readNote: 'One line per row: "row: A | B | …" (cols line names the letters). A formula shows as "=FORMULA → value". Empty trailing cells are left out.',
    editHint: `Change cells with gdrive_edit (fileId, edits: [{action: "set", range: "${quoteSheet(tab.title)}!B2", values: [["new"]], expect: [["what B2 holds now"]]}]); expect guards against cells that changed.`,
    lines: out.join('\n'),
  }));
}

export async function sheetsEdit(env: GoogleToolEnv, located: LocatedFile): Promise<ToolResult> {
  const valueInput = String(env.args.valueInput ?? 'user_entered').toLowerCase();
  if (!['user_entered', 'raw'].includes(valueInput)) return failedResult(env, invalid('valueInput is user_entered (like typing: formulas, numbers, dates) or raw (text exactly as given).'));
  if (!Array.isArray(env.args.edits)) return failedResult(env, invalid('A Sheet takes edits: a list of {action, …} edits (set, append, clear, add_sheet, …).'));
  const { accountId, file } = located;
  if (file.mimeType !== GDRIVE_SHEET_MIME) return failedResult(env, invalid('This file is not a Google Sheet.'));
  const sheets = env.workspaceFor(accountId)?.sheets;
  if (!sheets) return failedResult(env, { code: 'unavailable', message: 'Google Sheets editing is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  let meta: Spreadsheet;
  try {
    meta = await sheets.get(file.id);
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, false, 'Google Sheets read'));
  }
  const plan = planSheetEdits(tabsOf(meta), env.args.edits as Record<string, unknown>[]);
  if (!plan.ok) return failedResult(env, invalid(plan.message, undefined, 'Fix that edit (read the sheet with gdrive_read if a tab or cell is unclear) and call once more; nothing changed.'));
  // expect: the cells must still hold what the model read.
  if (plan.expects.length) {
    try {
      const ranges = plan.expects.map(entry => entry.range);
      const [typed, shown] = await Promise.all([sheets.valuesBatchGet(file.id, ranges, 'FORMULA'), sheets.valuesBatchGet(file.id, ranges, 'FORMATTED_VALUE')]);
      for (let i = 0; i < plan.expects.length; i++) {
        const entry = plan.expects[i];
        const parsed = parseA1(entry.range)!;
        const mismatches = expectMismatches(entry.values, typed.valueRanges[i]?.values, shown.valueRanges[i]?.values, parsed.startRow ?? 0, parsed.startCol ?? 0);
        if (mismatches.length) {
          return failedResult(env, {
            code: 'changed_since_read',
            message: `edits[${entry.index}]: ${mismatches.length} cell${mismatches.length === 1 ? '' : 's'} no longer hold what expect says, so nothing changed.`,
            effect: 'none',
            nextAction: 'Read the sheet again with gdrive_read, decide with the owner if needed, and call again with the current values.',
            detail: { mismatches: mismatches.slice(0, 10) },
          });
        }
      }
    } catch (error) {
      return failedResult(env, googleErrorFailure(error, false, 'Google Sheets read'));
    }
  }
  const input = valueInput === 'raw' ? 'RAW' : 'USER_ENTERED';
  const done: string[] = [];
  const results: Record<string, unknown> = {};
  try {
    if (plan.structural.length) {
      await sheets.batchUpdate(file.id, plan.structural);
      done.push('structure');
    }
    if (plan.sets.length) {
      const answer = await sheets.valuesBatchUpdate(file.id, plan.sets, input);
      results.updatedCells = answer.totalUpdatedCells ?? (answer.responses ?? []).reduce((sum, entry) => sum + (entry.updatedCells ?? 0), 0);
      done.push('values');
    }
    if (plan.clears.length) {
      const answer = await sheets.valuesBatchClear(file.id, plan.clears);
      results.cleared = answer.clearedRanges ?? plan.clears;
      done.push('clears');
    }
    const appended: unknown[] = [];
    for (const entry of plan.appends) {
      const answer = await sheets.valuesAppend(file.id, entry.range, entry.values, input);
      appended.push({ range: answer.updates?.updatedRange, rows: answer.updates?.updatedRows });
      done.push('append');
    }
    if (appended.length) results.appended = appended;
  } catch (error) {
    const failure = googleErrorFailure(error, true, 'Google Sheets edit');
    return failedResult(env, {
      ...failure,
      ...(done.length ? {
        effect: 'unknown',
        message: `${failure.message} Part of the edit was already applied (${done.join(', ')}).`,
        nextAction: 'Do not send the whole edit again: read the sheet with gdrive_read, then send only what is still missing.',
      } : {}),
    });
  }
  return googleResult(env.call, {
    ok: true,
    tool: 'gdrive_edit',
    status: 'applied',
    account: accountEmail(env, accountId),
    fileId: file.id,
    name: redactSecrets(file.name ?? ''),
    webViewLink: file.webViewLink,
    changes: plan.summary,
    ...results,
    valueInput: valueInput,
    note: plan.structural.length && (plan.sets.length || plan.clears.length || plan.appends.length) ? 'Structure changes applied first, then values.' : undefined,
  });
}
