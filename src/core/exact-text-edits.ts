/**
 * Exact find/replace edits, shared by edit_product_document and edit_file
 * (owner report 2026-10-21: BotBoy rewrote whole documents for one-line
 * changes, and opened its own reader in Chrome to see what it had written).
 *
 * Rules, the same as the dashboard page edits and Knowledge edits:
 *   - each `find` must occur exactly once in the text as it stands when that
 *     edit applies; edits apply in order, each to the result of the one before;
 *   - a failed edit applies nothing: the caller gets the index and the reason,
 *     and writes nothing.
 * The caller adds the next action, because what to read again differs.
 */

export interface ExactTextEdit {
  find: string;
  replace: string;
}

/** Where one edit landed in the final text. */
export interface ExactEditChange {
  /** Position of the edit in the request (0-based). */
  index: number;
  /** 1-based line of the final text where the replacement starts. */
  line: number;
  /** Offset of the replacement in the final text. */
  start: number;
  /** Length of the replacement in the final text. */
  length: number;
}

export type ExactEditFailureCode = 'invalid_edits' | 'edit_not_found' | 'edit_not_unique';

export interface ExactEditFailure {
  ok: false;
  code: ExactEditFailureCode;
  /** The edit that failed, when one did. */
  index?: number;
  message: string;
}

export const MAX_EXACT_EDITS = 50;
const MAX_FIND_CHARS = 100_000;
const MAX_REPLACE_CHARS = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A well-formed edits list: 1 to `max` entries of {find (non-empty text), replace (text)}, nothing else. */
export function parseExactEdits(
  value: unknown,
  options: { max?: number; field?: string } = {},
): { ok: true; edits: ExactTextEdit[] } | ExactEditFailure {
  const max = options.max ?? MAX_EXACT_EDITS;
  const field = options.field ?? 'edits';
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    return { ok: false, code: 'invalid_edits', message: `${field} must be a list of 1 to ${max} {find, replace} pairs.` };
  }
  const edits: ExactTextEdit[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isRecord(entry)) {
      return { ok: false, code: 'invalid_edits', index, message: `${field}[${index}] must be {find, replace}.` };
    }
    const extra = Object.keys(entry).filter(key => key !== 'find' && key !== 'replace');
    if (extra.length) {
      return { ok: false, code: 'invalid_edits', index, message: `${field}[${index}] has unsupported fields: ${extra.sort().join(', ')}. Send only find and replace.` };
    }
    if (typeof entry.find !== 'string' || !entry.find || typeof entry.replace !== 'string') {
      return { ok: false, code: 'invalid_edits', index, message: `${field}[${index}] needs a non-empty find and a replace, both text (an empty replace deletes the find text).` };
    }
    if (entry.find.length > MAX_FIND_CHARS || entry.replace.length > MAX_REPLACE_CHARS) {
      return { ok: false, code: 'invalid_edits', index, message: `${field}[${index}] is too long (find at most ${MAX_FIND_CHARS.toLocaleString('en-US')} characters, replace at most ${MAX_REPLACE_CHARS.toLocaleString('en-US')}).` };
    }
    edits.push({ find: entry.find, replace: entry.replace });
  }
  return { ok: true, edits };
}

/** Apply the edits in order. Each find must occur exactly once in the text it applies to. */
export function applyExactEdits(
  text: string,
  edits: readonly ExactTextEdit[],
): { ok: true; text: string; changes: ExactEditChange[] } | ExactEditFailure {
  let next = text;
  // Replacement spans in the current text, kept current as later edits shift them.
  const spans: Array<{ index: number; start: number; length: number }> = [];
  for (let index = 0; index < edits.length; index += 1) {
    const { find, replace } = edits[index];
    if (!find) return { ok: false, code: 'invalid_edits', index, message: `edits[${index}].find is empty.` };
    const at = next.indexOf(find);
    if (at < 0) return { ok: false, code: 'edit_not_found', index, message: `edits[${index}].find does not occur in the current text.` };
    if (next.indexOf(find, at + 1) >= 0) {
      return { ok: false, code: 'edit_not_unique', index, message: `edits[${index}].find occurs more than once.` };
    }
    const end = at + find.length;
    const delta = replace.length - find.length;
    for (const span of spans) {
      const spanEnd = span.start + span.length;
      if (span.start >= end) {
        span.start += delta;
      } else if (spanEnd > at) {
        // This edit rewrote part of an earlier replacement: the span now covers both.
        const newEnd = spanEnd > end ? spanEnd + delta : at + replace.length;
        span.start = Math.min(span.start, at);
        span.length = Math.max(0, newEnd - span.start);
      }
    }
    next = next.slice(0, at) + replace + next.slice(end);
    spans.push({ index, start: at, length: replace.length });
  }
  const changes = spans.map(span => ({ index: span.index, line: lineAt(next, span.start), start: span.start, length: span.length }));
  return { ok: true, text: next, changes };
}

/** 1-based line number of an offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  const limit = Math.min(Math.max(offset, 0), text.length);
  for (let position = text.indexOf('\n'); position >= 0 && position < limit; position = text.indexOf('\n', position + 1)) line += 1;
  return line;
}

/** The whole line(s) a change now sits on, cut to `max` characters. */
export function changedLineText(text: string, change: Pick<ExactEditChange, 'start' | 'length'>, max = 300): string {
  const lineStart = change.start === 0 ? 0 : text.lastIndexOf('\n', change.start - 1) + 1;
  // A replacement that ends with its own newline ends on that line.
  const probeFrom = change.length > 0 ? change.start + change.length - 1 : change.start;
  const probe = text.indexOf('\n', probeFrom);
  const lineEnd = probe < 0 ? text.length : Math.max(probe, lineStart);
  return excerpt(text.slice(lineStart, lineEnd), max);
}

/** A short excerpt for receipts: the first `max` characters, never splitting a surrogate pair. */
export function excerpt(value: string, max = 160): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}
