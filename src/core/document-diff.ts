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
