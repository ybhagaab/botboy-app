import { describe, it, expect } from 'vitest';
import { changedTextForBrief, diffDocumentTexts } from './document-diff.js';

/**
 * Revision diff summaries (sharepoint-signals R2): compact, section-
 * attributed, whitespace-churn-blind, capped. The diff feeds Today's change
 * feed and evidence rows — precision of ATTRIBUTION matters more than a
 * perfect minimal edit script.
 */
describe('diffDocumentTexts', () => {
  const OLD = [
    '# Rollout plan',
    'The rollout starts in EU next quarter.',
    'NA follows after the readiness review.',
    '',
    '# Timeline',
    'Kickoff in March.',
  ].join('\n');

  it('attributes added and removed lines to their markdown sections', () => {
    const NEW = [
      '# Rollout plan',
      'The rollout starts in EU next quarter.',
      'NA follows after the readiness review, targeting Q1.',
      '',
      '# Timeline',
      'Kickoff in March.',
      'Beta window opens in May.',
    ].join('\n');
    const diff = diffDocumentTexts(OLD, NEW)!;
    expect(diff).not.toBeNull();
    expect(diff.changedSections).toEqual(['Rollout plan', 'Timeline']);
    expect(diff.summary).toContain('"Rollout plan": 1 added, 1 removed');
    expect(diff.summary).toContain('"Timeline": 1 added');
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    const rollout = diff.notable.find(n => n.kind === 'added' && n.section === 'Rollout plan');
    expect(rollout!.text).toContain('targeting Q1');
  });

  it('returns null for identical content and for whitespace/blank-line churn', () => {
    expect(diffDocumentTexts(OLD, OLD)).toBeNull();
    const churned = OLD.replace('\n\n', '\n\n\n').replace('Kickoff in March.', '  Kickoff in March.  ');
    expect(diffDocumentTexts(OLD, churned)).toBeNull();
  });

  it('a moved line (same content, different position) is not reported', () => {
    const moved = [
      '# Rollout plan',
      'NA follows after the readiness review.',
      'The rollout starts in EU next quarter.',
      '',
      '# Timeline',
      'Kickoff in March.',
    ].join('\n');
    expect(diffDocumentTexts(OLD, moved)).toBeNull();
  });

  it('headingless documents fall back to the document bucket', () => {
    const diff = diffDocumentTexts('alpha\nbeta', 'alpha\ngamma')!;
    expect(diff.changedSections).toEqual(['document']);
    expect(diff.summary).toContain('document: 1 added, 1 removed');
  });

  it('caps notable changes at 6 and flags input truncation', () => {
    const oldText = Array.from({ length: 10 }, (_, i) => `old line ${i}`).join('\n');
    const newText = Array.from({ length: 10 }, (_, i) => `new line ${i}`).join('\n');
    const diff = diffDocumentTexts(oldText, newText)!;
    expect(diff.notable).toHaveLength(6);
    expect(diff.truncated).toBe(false);

    const big = 'x'.repeat(250 * 1024);
    const bigDiff = diffDocumentTexts(big, `new head line\n${big}`)!;
    expect(bigDiff.truncated).toBe(true);
    expect(bigDiff.summary).toContain('compared first 200 KB');
  });
});

/**
 * The changed text a brief reads instead of a long document's new version
 * (document-reads.ts): complete inputs, changed passages with context and
 * their section, removed lines, and a measure of how much changed.
 */
describe('changedTextForBrief', () => {
  const body = (count: number, prefix = 'line') => Array.from({ length: count }, (_, i) => `${prefix} ${i} of the plan`).join('\n');

  it('returns null when no non-blank line changed', () => {
    expect(changedTextForBrief('a\n\nb', 'a\nb\n\n')).toBeNull();
    expect(changedTextForBrief(body(50), body(50))).toBeNull();
  });

  it('shows each changed passage with two lines of context, its section, and its line numbers', () => {
    const oldText = ['# Rollout', 'step one', 'step two', 'step three', 'step four', '# Budget', 'total 10', 'owner Sam', 'end'].join('\n');
    const newText = ['# Rollout', 'step one', 'step two', 'step three', 'step four', '# Budget', 'total 12', 'owner Sam', 'end'].join('\n');
    const change = changedTextForBrief(oldText, newText, { since: '2026-10-01' })!;
    expect(change).toMatchObject({ addedLines: 1, removedLines: 1, changedChars: 'total 12'.length + 'total 10'.length });
    expect(change.text).toContain('CHANGES since the version this brain last read (captured 2026-10-01): 1 line added or changed, 1 removed.');
    expect(change.text).toContain('@@ section "Budget", lines 5–9 of the new version @@\n  step four\n  # Budget\n+ total 12\n  owner Sam\n  end');
    expect(change.text).toContain('REMOVED (1 line):\n- total 10   [section "Budget"]');
  });

  it('reads complete large texts, so a change deep in a 3 MB document is found and nothing else is shown', () => {
    const big = body(100_000, 'row');
    expect(big.length).toBeGreaterThan(2_000_000);
    const changed = big.replace('row 90000 of the plan', 'row 90000 of the REVISED plan');
    const started = Date.now();
    const change = changedTextForBrief(big, changed)!;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(change.text).toContain('+ row 90000 of the REVISED plan');
    expect(change.text).toContain('  row 89999 of the plan');
    expect(change.text).not.toContain('row 50000');
    expect(change.text.length).toBeLessThan(1_000);
  });

  it('stays linear when thousands of lines change in a long file without headings', () => {
    const rows = body(60_000, 'row');
    const edited = rows.split('\n').map((line, index) => (index % 10 === 0 ? `${line} (revised)` : line)).join('\n');
    const started = Date.now();
    const change = changedTextForBrief(rows, edited)!;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(change).toMatchObject({ addedLines: 6_000, removedLines: 6_000 });
    expect(change.text).toContain('@@ lines 59989–59993 of the new version @@\n  row 59988 of the plan\n  row 59989 of the plan\n+ row 59990 of the plan (revised)');
    expect(change.text).not.toContain('section "');
  });

  it('treats a moved line as unchanged and caps the removed list', () => {
    expect(changedTextForBrief('a\nb\nc', 'c\na\nb')).toBeNull();
    const removed = changedTextForBrief(body(3_000, 'gone'), 'kept')!;
    expect(removed.removedLines).toBe(3_000);
    expect(removed.text).toMatch(/REMOVED \(3,000 lines, first [\d,]+ shown\)/);
    expect(removed.text.length).toBeLessThan(30_000);
  });
});
