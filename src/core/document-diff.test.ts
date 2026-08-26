import { describe, it, expect } from 'vitest';
import { diffDocumentTexts } from './document-diff.js';

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
