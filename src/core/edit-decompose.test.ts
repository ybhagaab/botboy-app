import { describe, it, expect } from 'vitest';
import { decomposeEditedMarkdown } from './edit-decompose.js';

/**
 * Edit-mode save decomposition (doc editor E2): the diff between the
 * extracted original and the owner's draft becomes independent pending-edit
 * payloads. Fixtures mirror real extractor emission (headings, injected
 * list numbers, GFM tables, blank-line blocks).
 */

const ORIGINAL = [
  '# HLD Title',
  '',
  '## 1 Overview',
  '',
  'The system captures work evidence continuously.',
  '',
  '## 2 Rollout',
  '',
  'Rollout begins with a pilot group in EU.',
  '',
  '1. enable capture',
  '2. review projects',
  '',
  '| Phase | Date |',
  '| --- | --- |',
  '| pilot | Q1 |',
  '',
  'Closing remarks paragraph.',
].join('\n');

describe('decomposeEditedMarkdown', () => {
  it('no changes → zero edits', () => {
    const result = decomposeEditedMarkdown(ORIGINAL, ORIGINAL);
    expect(result.edits).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it('single-sentence tweak → replaceText with docx-text forms', () => {
    const draft = ORIGINAL.replace('The system captures work evidence continuously.', 'The system captures work evidence continuously and losslessly.');
    const { edits } = decomposeEditedMarkdown(ORIGINAL, draft);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      operation: 'replaceText',
      findText: 'The system captures work evidence continuously.',
      replaceWith: 'The system captures work evidence continuously and losslessly.',
    });
  });

  it('section rewrite → one range run with per-paragraph anchors (list items separate)', () => {
    const draft = ORIGINAL.replace(
      'Rollout begins with a pilot group in EU.\n\n1. enable capture\n2. review projects',
      'Rollout begins globally on day one.\n\n1. enable capture everywhere',
    );
    const { edits, unsupported } = decomposeEditedMarkdown(ORIGINAL, draft);
    expect(unsupported).toEqual([]);
    expect(edits).toHaveLength(1);
    expect(edits[0].operation).toBe('replaceParagraphRange');
    expect(edits[0].paragraphs).toEqual(['Rollout begins with a pilot group in EU.', 'enable capture', 'review projects']);
    expect(edits[0].replaceWith).toBe('Rollout begins globally on day one.\n\n1. enable capture everywhere');
  });

  it('deletion → range op with empty replacement', () => {
    const draft = ORIGINAL.replace('\n\nClosing remarks paragraph.', '');
    const { edits } = decomposeEditedMarkdown(ORIGINAL, draft);
    expect(edits).toHaveLength(1);
    expect(edits[0].operation).toBe('replaceParagraphRange');
    expect(edits[0].paragraphs).toEqual(['Closing remarks paragraph.']);
    expect(edits[0].replaceWith).toBe('');
  });

  it('insertion between blocks anchors on the preceding block, re-included', () => {
    const draft = ORIGINAL.replace(
      'The system captures work evidence continuously.',
      'The system captures work evidence continuously.\n\nA brand new paragraph inserted after the overview text.',
    );
    const { edits } = decomposeEditedMarkdown(ORIGINAL, draft);
    expect(edits).toHaveLength(1);
    expect(edits[0].operation).toBe('replaceParagraphRange');
    expect(edits[0].paragraphs).toEqual(['The system captures work evidence continuously.']);
    expect(edits[0].replaceWith).toBe('The system captures work evidence continuously.\n\nA brand new paragraph inserted after the overview text.');
  });

  it('short-heading edit auto-extends into a free neighbor', () => {
    const draft = ORIGINAL.replace('## 2 Rollout', '## 2 Launch');
    const { edits } = decomposeEditedMarkdown(ORIGINAL, draft);
    expect(edits).toHaveLength(1);
    expect(edits[0].operation).toBe('replaceParagraphRange');
    // Extended left into the overview paragraph (free, non-table).
    expect(edits[0].paragraphs).toEqual(['The system captures work evidence continuously.', '2 Rollout']);
    expect(edits[0].replaceWith).toBe('The system captures work evidence continuously.\n\n## 2 Launch');
  });

  it('table-touching runs are unsupported, and non-table runs still stage', () => {
    const draft = ORIGINAL
      .replace('| pilot | Q1 |', '| pilot | Q2 |')
      .replace('Closing remarks paragraph.', 'Closing remarks paragraph, expanded and rewritten across the board.');
    const { edits, unsupported } = decomposeEditedMarkdown(ORIGINAL, draft);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].reason).toMatch(/table/i);
    expect(edits).toHaveLength(1);
    expect(edits[0].operation).toBe('replaceText');
    expect(edits[0].findText).toBe('Closing remarks paragraph.');
  });

  it('trailing plain additions append; trailing styled additions re-anchor on the last block', () => {
    const plainDraft = `${ORIGINAL}\n\nA plain closing addendum sentence.`;
    const plain = decomposeEditedMarkdown(ORIGINAL, plainDraft);
    expect(plain.edits).toHaveLength(1);
    expect(plain.edits[0].operation).toBe('appendParagraphs');
    expect(plain.edits[0].paragraphs).toEqual(['A plain closing addendum sentence.']);

    const styledDraft = `${ORIGINAL}\n\n## 3 New Section\n\nWith **styled** content.`;
    const styled = decomposeEditedMarkdown(ORIGINAL, styledDraft);
    expect(styled.edits).toHaveLength(1);
    expect(styled.edits[0].operation).toBe('replaceParagraphRange');
    expect(styled.edits[0].paragraphs).toEqual(['Closing remarks paragraph.']);
    expect(styled.edits[0].replaceWith).toBe('Closing remarks paragraph.\n\n## 3 New Section\n\nWith **styled** content.');
  });

  it('mixed multi-run save produces independent rows', () => {
    const draft = ORIGINAL
      .replace('The system captures work evidence continuously.', 'The system records evidence continuously with zero loss.')
      .replace('\n\nClosing remarks paragraph.', '\n\nClosing remarks paragraph.\n\nAnd a final thank-you note added at the end.');
    const { edits } = decomposeEditedMarkdown(ORIGINAL, draft);
    expect(edits).toHaveLength(2);
    expect(edits.map(e => e.operation).sort()).toEqual(['appendParagraphs', 'replaceText']);
  });

  it('empty original → whole draft appends', () => {
    const { edits } = decomposeEditedMarkdown('', 'First paragraph of a fresh doc.\n\nSecond one.');
    expect(edits).toHaveLength(1);
    expect(edits[0].operation).toBe('appendParagraphs');
    expect(edits[0].paragraphs).toEqual(['First paragraph of a fresh doc.', 'Second one.']);
  });
});
