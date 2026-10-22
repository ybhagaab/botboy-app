import { describe, expect, it } from 'vitest';
import { applyExactEdits, changedLineText, excerpt, lineAt, parseExactEdits } from './exact-text-edits.js';

/**
 * The exact-edit rules shared by edit_product_document and edit_file (owner
 * report 2026-10-21): each find occurs exactly once in the text it applies to,
 * edits apply in order, and a failed edit applies nothing.
 */
const EMAIL = [
  '# Launch',
  '',
  '| Team | Contributors | Contribution |',
  '|---|---|---|',
  '| Data engineering | Zeng Wang | Pipeline |',
  '| Paid marketing | Aditya | Campaigns |',
  '',
  'Thanks to everyone.',
].join('\n');

describe('applyExactEdits', () => {
  it('applies edits in order, each to the result of the one before, and reports where each landed in the final text', () => {
    const applied = applyExactEdits(EMAIL, [
      { find: '| Paid marketing |', replace: '| Marketing |' },
      { find: '# Launch', replace: '# Launch\n\nMX Player S2S is live.' },
      { find: 'Marketing | Aditya', replace: 'Marketing | Aditya, Meghna' },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.text).toBe(EMAIL
      .replace('| Paid marketing |', '| Marketing |')
      .replace('# Launch', '# Launch\n\nMX Player S2S is live.')
      .replace('Marketing | Aditya', 'Marketing | Aditya, Meghna'));
    // The first edit's row moved down two lines when the second edit added them; the third rewrote part of it.
    expect(applied.changes.map(change => [change.index, change.line])).toEqual([[0, 8], [1, 1], [2, 8]]);
    expect(changedLineText(applied.text, applied.changes[0])).toBe('| Marketing | Aditya, Meghna | Campaigns |');
    expect(changedLineText(applied.text, applied.changes[1])).toBe('# Launch\n\nMX Player S2S is live.');
  });

  it('refuses a find that is missing or not unique, naming the edit, and changes nothing', () => {
    expect(applyExactEdits(EMAIL, [{ find: '# Launch', replace: '# Go' }, { find: 'Not there', replace: 'x' }]))
      .toEqual({ ok: false, code: 'edit_not_found', index: 1, message: 'edits[1].find does not occur in the current text.' });
    expect(applyExactEdits(EMAIL, [{ find: ' | ', replace: ' / ' }]))
      .toEqual({ ok: false, code: 'edit_not_unique', index: 0, message: 'edits[0].find occurs more than once.' });
    // A find made unique only by an earlier edit counts against the text as it stands then.
    expect(applyExactEdits('a b a', [{ find: 'a b', replace: 'c b' }, { find: 'a', replace: 'z' }])).toMatchObject({ ok: true, text: 'c b z' });
    expect(applyExactEdits('a b', [{ find: 'a', replace: 'aa' }, { find: 'a', replace: 'x' }])).toMatchObject({ ok: false, code: 'edit_not_unique', index: 1 });
  });

  it('deletes with an empty replace and keeps line numbers right for a deleted line', () => {
    const applied = applyExactEdits('one\ntwo\nthree', [{ find: 'two\n', replace: '' }]);
    expect(applied).toMatchObject({ ok: true, text: 'one\nthree', changes: [{ index: 0, line: 2, length: 0 }] });
    if (applied.ok) expect(changedLineText(applied.text, applied.changes[0])).toBe('three');
  });

  it('shifts earlier spans by later edits above them and merges an overlapped span', () => {
    const applied = applyExactEdits('A\nB\nC', [
      { find: 'C', replace: 'C1\nC2' },
      { find: 'A', replace: 'A0\nA1\nA2' },
      { find: 'C2', replace: 'C3 and more' },
    ]);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.text).toBe('A0\nA1\nA2\nB\nC1\nC3 and more');
    // The third edit rewrote the end of the first one's text: the first span now covers both.
    const first = applied.changes[0];
    expect(applied.text.slice(first.start, first.start + first.length)).toBe('C1\nC3 and more');
    expect(first.line).toBe(5);
    expect(applied.changes[2].line).toBe(6);
  });

  it('shows the line a replacement ends on when the replacement ends with its own line break', () => {
    const applied = applyExactEdits('one\ntwo\nthree', [{ find: 'two\n', replace: 'TWO\n' }]);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(changedLineText(applied.text, applied.changes[0])).toBe('TWO');
  });
});

describe('parseExactEdits', () => {
  it('accepts 1 to 50 {find, replace} pairs and nothing else', () => {
    expect(parseExactEdits([{ find: 'a', replace: '' }])).toEqual({ ok: true, edits: [{ find: 'a', replace: '' }] });
    for (const [value, message] of [
      [undefined, /1 to 50/],
      [[], /1 to 50/],
      [Array.from({ length: 51 }, () => ({ find: 'a', replace: 'b' })), /1 to 50/],
      [['a'], /edits\[0\] must be \{find, replace\}/],
      [[{ find: '', replace: 'x' }], /non-empty find/],
      [[{ find: 'a' }], /non-empty find and a replace/],
      [[{ find: 'a', replace: 'b', all: true }], /unsupported fields: all/],
      [[{ find: 'a', replace: 'b' }, { find: 'x'.repeat(100_001), replace: '' }], /edits\[1\] is too long/],
    ] as const) {
      const parsed = parseExactEdits(value);
      expect(parsed.ok, JSON.stringify(value)?.slice(0, 80)).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(message);
    }
  });
});

describe('helpers', () => {
  it('counts lines and cuts excerpts without splitting a two-unit character', () => {
    expect(lineAt('a\nb\nc', 0)).toBe(1);
    expect(lineAt('a\nb\nc', 2)).toBe(2);
    expect(lineAt('a\nb\nc', 4)).toBe(3);
    expect(excerpt('short')).toBe('short');
    expect(excerpt(`${'a'.repeat(159)}😀b`, 160)).toBe(`${'a'.repeat(159)}…`);
  });
});
