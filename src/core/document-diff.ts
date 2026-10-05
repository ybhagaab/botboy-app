/**
 * Compact document revision diffs (sharepoint-signals R2).
 *
 * Turns two extracted document texts into a human-scale answer to "what
 * actually changed", attributed to sections: markdown headings when the
 * extraction produced them (docx→markdown does), otherwise a document-level
 * bucket. This deliberately does NOT produce a full patch — the evidence
 * store already holds both complete revisions losslessly; this summary is
 * for Today's change feed, evidence rows, and brain activity lines.
 *
 * Approach: trim common prefix/suffix, then multiset-compare the middle
 * lines (order-insensitive within the changed window — a moved line is not
 * a content change worth reporting). Pure, deterministic, dependency-free,
 * and capped so pathological inputs cannot stall a drain tick.
 */

const MAX_INPUT_BYTES = 200 * 1024;
const MAX_NOTABLE = 6;
const NOTABLE_SNIPPET_CHARS = 90;

export interface DocumentDiffResult {
  /** One-line human summary, e.g. `"Rollout plan": 2 added, 1 removed; "Timeline": 1 added`. */
  summary: string;
  /** Section names with changes, document order, deduped. */
  changedSections: string[];
  added: number;
  removed: number;
  /** True when inputs were truncated to the byte cap before diffing. */
  truncated: boolean;
  /** Up to 6 notable line-level changes, attributed to sections. */
  notable: Array<{ section: string; kind: 'added' | 'removed'; text: string }>;
}

interface SectionedLine {
  text: string; // trimmed
  section: string;
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

function sectionedLines(raw: string): { lines: SectionedLine[]; truncated: boolean } {
  let text = raw;
  let truncated = false;
  if (text.length > MAX_INPUT_BYTES) {
    text = text.slice(0, MAX_INPUT_BYTES);
    truncated = true;
  }
  const lines: SectionedLine[] = [];
  let section = 'document';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const heading = trimmed.match(HEADING_RE);
    if (heading) section = heading[1].slice(0, 60);
    if (trimmed === '') continue; // blank-line churn is never a reportable change
    lines.push({ text: trimmed, section });
  }
  return { lines, truncated };
}

/** Multiset of line texts → count. */
function counts(lines: SectionedLine[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line.text, (map.get(line.text) ?? 0) + 1);
  return map;
}

function label(section: string): string {
  return section === 'document' ? 'document' : `"${section}"`;
}

/**
 * Diff two extracted texts. Returns null when there are no reportable line
 * changes (identical content, or only whitespace/blank-line churn).
 */
export function diffDocumentTexts(oldText: string, newText: string): DocumentDiffResult | null {
  const oldSide = sectionedLines(String(oldText ?? ''));
  const newSide = sectionedLines(String(newText ?? ''));

  const oldCounts = counts(oldSide.lines);
  const newCounts = counts(newSide.lines);

  // Added: present in new beyond old's count. Removed: the reverse. Document
  // order preserved by walking the arrays; per-text budgets prevent a line
  // occurring N times from being reported N times when only counts differ.
  const addedBudget = new Map<string, number>();
  for (const [text, n] of newCounts) addedBudget.set(text, n - (oldCounts.get(text) ?? 0));
  const removedBudget = new Map<string, number>();
  for (const [text, n] of oldCounts) removedBudget.set(text, n - (newCounts.get(text) ?? 0));

  const added: SectionedLine[] = [];
  for (const line of newSide.lines) {
    const budget = addedBudget.get(line.text) ?? 0;
    if (budget > 0) { added.push(line); addedBudget.set(line.text, budget - 1); }
  }
  const removed: SectionedLine[] = [];
  for (const line of oldSide.lines) {
    const budget = removedBudget.get(line.text) ?? 0;
    if (budget > 0) { removed.push(line); removedBudget.set(line.text, budget - 1); }
  }

  if (added.length === 0 && removed.length === 0) return null;

  // Per-section tallies, document order (new side first, then removed-only sections).
  const sectionOrder: string[] = [];
  const tally = new Map<string, { added: number; removed: number }>();
  const bump = (section: string, kind: 'added' | 'removed') => {
    if (!tally.has(section)) { tally.set(section, { added: 0, removed: 0 }); sectionOrder.push(section); }
    tally.get(section)![kind]++;
  };
  for (const line of added) bump(line.section, 'added');
  for (const line of removed) bump(line.section, 'removed');

  const parts = sectionOrder.map(section => {
    const t = tally.get(section)!;
    const bits = [t.added > 0 ? `${t.added} added` : '', t.removed > 0 ? `${t.removed} removed` : ''].filter(Boolean);
    return `${label(section)}: ${bits.join(', ')}`;
  });

  const notable: DocumentDiffResult['notable'] = [];
  for (const line of added) {
    if (notable.length >= MAX_NOTABLE) break;
    notable.push({ section: line.section, kind: 'added', text: line.text.slice(0, NOTABLE_SNIPPET_CHARS) });
  }
  for (const line of removed) {
    if (notable.length >= MAX_NOTABLE) break;
    notable.push({ section: line.section, kind: 'removed', text: line.text.slice(0, NOTABLE_SNIPPET_CHARS) });
  }

  const truncated = oldSide.truncated || newSide.truncated;
  return {
    summary: `${parts.join('; ')}${truncated ? ' (large document — compared first 200 KB)' : ''}`,
    changedSections: sectionOrder,
    added: added.length,
    removed: removed.length,
    truncated,
    notable,
  };
}

// ── Changed text for a project brief (document-reads.ts) ────────────────────

const CHANGE_CONTEXT_LINES = 2;
const MAX_REMOVED_REPORT_CHARS = 20_000;

export interface DocumentChangeText {
  /** The changes, ready to show a model: added/changed passages with context, then removed lines. */
  text: string;
  /** Characters of added plus removed lines: how much of the document changed. */
  changedChars: number;
  addedLines: number;
  removedLines: number;
}

/**
 * What changed between two versions of a document, as text a brief can read
 * instead of the whole new version. Unlike `diffDocumentTexts` it reads the
 * complete texts (no 200 KB cap) and returns the changed passages
 * themselves: each run of added or changed lines with two unchanged lines
 * around it, labelled with its section heading and line numbers, then the
 * removed lines. Line identity is a multiset over the changed window (moved
 * lines are not changes), so the cost is linear in the document size.
 * Returns null when no non-blank line changed.
 */
export function changedTextForBrief(oldText: string, newText: string, opts: { since?: string } = {}): DocumentChangeText | null {
  const oldLines = String(oldText ?? '').split('\n');
  const newLines = String(newText ?? '').split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const oldCounts = new Map<string, number>();
  for (let index = prefix; index < oldEnd; index++) {
    const key = oldLines[index].trim();
    if (key) oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1);
  }
  const newCounts = new Map<string, number>();
  for (let index = prefix; index < newEnd; index++) {
    const key = newLines[index].trim();
    if (key) newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
  }

  const addedBudget = new Map<string, number>();
  for (const [key, count] of newCounts) addedBudget.set(key, count - (oldCounts.get(key) ?? 0));
  const added: number[] = [];
  for (let index = prefix; index < newEnd; index++) {
    const key = newLines[index].trim();
    const budget = key ? addedBudget.get(key) ?? 0 : 0;
    if (budget > 0) { added.push(index); addedBudget.set(key, budget - 1); }
  }
  const removedBudget = new Map<string, number>();
  for (const [key, count] of oldCounts) removedBudget.set(key, count - (newCounts.get(key) ?? 0));
  const removed: Array<{ index: number; text: string }> = [];
  for (let index = prefix; index < oldEnd; index++) {
    const key = oldLines[index].trim();
    const budget = key ? removedBudget.get(key) ?? 0 : 0;
    if (budget > 0) { removed.push({ index, text: key }); removedBudget.set(key, budget - 1); }
  }
  if (added.length === 0 && removed.length === 0) return null;

  // Section of each line: the nearest heading at or above it. One pass per
  // version, so thousands of changes in a long headingless file stay linear.
  const sectionsOf = (lines: string[]): string[] => {
    const sections = new Array<string>(lines.length);
    let section = '';
    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index].trim().match(HEADING_RE);
      if (heading) section = heading[1].slice(0, 80);
      sections[index] = section;
    }
    return sections;
  };
  const newSections = added.length > 0 ? sectionsOf(newLines) : [];

  const hunks: Array<{ start: number; end: number; firstChange: number }> = [];
  for (const index of added) {
    const start = Math.max(0, index - CHANGE_CONTEXT_LINES);
    const end = Math.min(newLines.length - 1, index + CHANGE_CONTEXT_LINES);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else hunks.push({ start, end, firstChange: index });
  }
  const addedSet = new Set(added);
  const blocks: string[] = [];
  for (const hunk of hunks) {
    // The section the change is in, not the section its context starts in.
    const section = newSections[hunk.firstChange];
    const lines: string[] = [];
    for (let index = hunk.start; index <= hunk.end; index++) {
      lines.push(`${addedSet.has(index) ? '+' : ' '} ${newLines[index]}`);
    }
    blocks.push(`@@ ${section ? `section "${section}", ` : ''}lines ${hunk.start + 1}–${hunk.end + 1} of the new version @@\n${lines.join('\n')}`);
  }

  let removedReport = '';
  if (removed.length > 0) {
    const oldSections = sectionsOf(oldLines);
    const lines: string[] = [];
    let chars = 0;
    let shown = 0;
    for (const line of removed) {
      if (chars + line.text.length > MAX_REMOVED_REPORT_CHARS) break;
      const section = oldSections[line.index];
      lines.push(`- ${line.text}${section ? `   [section "${section}"]` : ''}`);
      chars += line.text.length;
      shown++;
    }
    removedReport = `REMOVED (${removed.length.toLocaleString('en-US')} line${removed.length === 1 ? '' : 's'}${shown < removed.length ? `, first ${shown.toLocaleString('en-US')} shown` : ''}):\n${lines.join('\n')}`;
  }

  const addedChars = added.reduce((sum, index) => sum + newLines[index].trim().length, 0);
  const removedChars = removed.reduce((sum, line) => sum + line.text.length, 0);
  const header = `CHANGES since the version this brain last read${opts.since ? ` (captured ${opts.since})` : ''}: `
    + `${added.length.toLocaleString('en-US')} line${added.length === 1 ? '' : 's'} added or changed, `
    + `${removed.length.toLocaleString('en-US')} removed. Lines marked + are new; unmarked lines are unchanged context.`;
  return {
    text: [header, ...blocks, removedReport].filter(Boolean).join('\n\n'),
    changedChars: addedChars + removedChars,
    addedLines: added.length,
    removedLines: removed.length,
  };
}
