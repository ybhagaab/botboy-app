/**
 * Exact line diff for the Knowledge library's write path (knowledge-library.md K13): what the owner sees before a change is
 * applied, what a History entry shows, and which lines count as "added or changed" when the guide check must quote literal
 * evidence. Pure: no disk, no clock. No dependency (the repository has no diff library, and `document-diff.ts` is a
 * multiset summary, not a patch).
 *
 * The algorithm is Myers' O(ND) greedy search on lines after the common prefix and suffix are removed, with a bound on D:
 * past it (two files that share almost nothing) the middle is shown as one removal block and one addition block, which is
 * still an exact description of the change, only not a minimal one (`minimal: false`).
 */

export type DiffKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old text (context and remove). */
  oldLine?: number;
  /** 1-based line number in the new text (context and add). */
  newLine?: number;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  identical: boolean;
  /** False when the search bound was reached and a block replacement stands in for the minimal diff. */
  minimal: boolean;
}

/** The search bound: D edits beyond this fall back to a block replacement. */
export const MAX_DIFF_EDITS = 1_500;

/** Lines of a text, LF-split; a trailing newline does not make a final empty line. */
export function splitLines(text: string): string[] {
  const value = String(text ?? '');
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function myers(a: string[], b: string[]): Array<{ kind: DiffKind; text: string }> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_DIFF_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  // Walk back through the trace to the edit script.
  const script: Array<{ kind: DiffKind; text: string }> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = previous[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { script.push({ kind: 'context', text: a[x - 1] }); x -= 1; y -= 1; }
    if (x === prevX) { script.push({ kind: 'add', text: b[y - 1] }); y -= 1; } else { script.push({ kind: 'remove', text: a[x - 1] }); x -= 1; }
  }
  while (x > 0 && y > 0) { script.push({ kind: 'context', text: a[x - 1] }); x -= 1; y -= 1; }
  return script.reverse();
}

/** The exact line diff of two texts. Line endings are compared as written (callers normalize first). */
export function diffLines(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  let script: Array<{ kind: DiffKind; text: string }>;
  let minimal = true;
  if (middleA.length === 0 || middleB.length === 0) {
    script = [...middleA.map((text) => ({ kind: 'remove' as const, text })), ...middleB.map((text) => ({ kind: 'add' as const, text }))];
  } else {
    const found = myers(middleA, middleB);
    if (found) script = found;
    else {
      minimal = false;
      script = [...middleA.map((text) => ({ kind: 'remove' as const, text })), ...middleB.map((text) => ({ kind: 'add' as const, text }))];
    }
  }
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  const push = (kind: DiffKind, text: string) => {
    if (kind === 'context') lines.push({ kind, text, oldLine: oldLine++, newLine: newLine++ });
    else if (kind === 'remove') lines.push({ kind, text, oldLine: oldLine++ });
    else lines.push({ kind, text, newLine: newLine++ });
  };
  for (let index = 0; index < start; index += 1) push('context', a[index]);
  for (const step of script) push(step.kind, step.text);
  for (let index = endA; index < a.length; index += 1) push('context', a[index]);
  const added = lines.filter((line) => line.kind === 'add').length;
  const removed = lines.filter((line) => line.kind === 'remove').length;
  return { lines, added, removed, identical: added === 0 && removed === 0, minimal };
}

/** The added lines, in order: the "added or changed" text a check's evidence must come from. */
export function addedLines(diff: LineDiff): Array<{ line: number; text: string }> {
  return diff.lines.filter((line) => line.kind === 'add').map((line) => ({ line: line.newLine as number, text: line.text }));
}

export interface UnifiedOptions {
  /** Unchanged lines kept around each change (default 3). */
  context?: number;
  /** Most lines of output (default 400). */
  maxLines?: number;
  /** Shown in the header (`--- a/<label>`). */
  label?: string;
}

export interface UnifiedDiff {
  text: string;
  /** Lines of the full rendering. */
  totalLines: number;
  shownLines: number;
  truncated: boolean;
}

/** A unified-style rendering with hunk headers, for the card and the History view. */
export function renderUnifiedDiff(diff: LineDiff, options: UnifiedOptions = {}): UnifiedDiff {
  const context = Math.max(0, options.context ?? 3);
  const maxLines = Math.max(10, options.maxLines ?? 400);
  const label = options.label ?? 'file';
  if (diff.identical) return { text: '', totalLines: 0, shownLines: 0, truncated: false };
  const keep = new Array<boolean>(diff.lines.length).fill(false);
  diff.lines.forEach((line, index) => {
    if (line.kind === 'context') return;
    for (let at = Math.max(0, index - context); at <= Math.min(diff.lines.length - 1, index + context); at += 1) keep[at] = true;
  });
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let index = 0;
  while (index < diff.lines.length) {
    if (!keep[index]) { index += 1; continue; }
    let end = index;
    while (end + 1 < diff.lines.length && keep[end + 1]) end += 1;
    const hunk = diff.lines.slice(index, end + 1);
    const firstOld = hunk.find((line) => line.oldLine !== undefined)?.oldLine ?? 0;
    const firstNew = hunk.find((line) => line.newLine !== undefined)?.newLine ?? 0;
    const oldCount = hunk.filter((line) => line.kind !== 'add').length;
    const newCount = hunk.filter((line) => line.kind !== 'remove').length;
    out.push(`@@ -${oldCount === 0 ? Math.max(0, firstOld - 1) : firstOld},${oldCount} +${newCount === 0 ? Math.max(0, firstNew - 1) : firstNew},${newCount} @@`);
    for (const line of hunk) out.push(`${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`);
    index = end + 1;
  }
  const truncated = out.length > maxLines;
  const shown = truncated ? out.slice(0, maxLines) : out;
  return { text: shown.join('\n'), totalLines: out.length, shownLines: shown.length, truncated };
}

/** Apply a diff's removal and addition view to confirm it describes the change (used by tests and by the History view). */
export function reconstruct(diff: LineDiff, side: 'before' | 'after'): string[] {
  return diff.lines.filter((line) => (side === 'before' ? line.kind !== 'add' : line.kind !== 'remove')).map((line) => line.text);
}
