/**
 * The exact line diff behind every card and History entry (knowledge-library.md K13): it must describe the change
 * exactly (applying its removals and additions reproduces both texts), be minimal when it can, fall back safely when it
 * cannot, and render hunks the owner can read. Synthetic text only.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_DIFF_EDITS, addedLines, diffLines, reconstruct, renderUnifiedDiff, splitLines } from './knowledge-diff.js';

const join = (lines: string[]) => (lines.length ? `${lines.join('\n')}\n` : '');

describe('splitLines', () => {
  it('ignores one trailing newline and keeps blank lines', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('reports identical texts as identical with no changes', () => {
    const diff = diffLines('# T\nline\n', '# T\nline\n');
    expect(diff).toMatchObject({ identical: true, added: 0, removed: 0, minimal: true });
    expect(renderUnifiedDiff(diff).text).toBe('');
  });

  it('finds a single replaced line, with old and new numbers', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    expect(diff.lines.map((line) => `${line.kind}:${line.text}`)).toEqual(['context:a', 'remove:b', 'add:B', 'context:c']);
    expect(diff.lines[1]).toMatchObject({ oldLine: 2 });
    expect(diff.lines[2]).toMatchObject({ newLine: 2 });
    expect(diff).toMatchObject({ added: 1, removed: 1 });
  });

  it('handles pure additions, pure removals, an empty old text and an empty new text', () => {
    expect(diffLines('', 'x\ny\n')).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines('x\ny\n', '')).toMatchObject({ added: 0, removed: 2 });
    expect(diffLines('a\nc\n', 'a\nb\nc\n').lines.map((line) => line.kind)).toEqual(['context', 'add', 'context']);
    expect(diffLines('a\nb\nc\n', 'a\nc\n').lines.map((line) => line.kind)).toEqual(['context', 'remove', 'context']);
  });

  it('is minimal for a moved block surrounded by shared lines', () => {
    const diff = diffLines('1\n2\n3\n4\n5\n6\n', '1\n4\n5\n6\n2\n3\n');
    expect(diff.removed + diff.added).toBeLessThanOrEqual(4);
    expect(reconstruct(diff, 'before')).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(reconstruct(diff, 'after')).toEqual(['1', '4', '5', '6', '2', '3']);
  });

  it('describes the change exactly for arbitrary line lists (property)', () => {
    const line = fc.stringMatching(/^[a-d ]{0,6}$/);
    fc.assert(fc.property(fc.array(line, { maxLength: 40 }), fc.array(line, { maxLength: 40 }), (a, b) => {
      const diff = diffLines(join(a), join(b));
      expect(reconstruct(diff, 'before')).toEqual(splitLines(join(a)));
      expect(reconstruct(diff, 'after')).toEqual(splitLines(join(b)));
      expect(diff.identical).toBe(join(a) === join(b));
    }), { numRuns: 300 });
  });

  it('falls back to one removal block and one addition block past the search bound, still exact', () => {
    const a = Array.from({ length: MAX_DIFF_EDITS + 200 }, (_, index) => `old ${index}`);
    const b = Array.from({ length: MAX_DIFF_EDITS + 200 }, (_, index) => `new ${index}`);
    const diff = diffLines(join(a), join(b));
    expect(diff.minimal).toBe(false);
    expect(diff).toMatchObject({ removed: a.length, added: b.length });
    expect(reconstruct(diff, 'before')).toEqual(a);
    expect(reconstruct(diff, 'after')).toEqual(b);
  });

  it('diffs a large file with a small edit quickly and minimally', () => {
    const base = Array.from({ length: 20_000 }, (_, index) => `row ${index}: a synthetic line of reference text`);
    const edited = [...base];
    edited[10_000] = 'row 10000: changed';
    edited.splice(15_000, 0, 'an inserted row');
    const started = Date.now();
    const diff = diffLines(join(base), join(edited));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(diff).toMatchObject({ minimal: true, added: 2, removed: 1 });
  });
});

describe('addedLines', () => {
  it('returns the new text of every added line with its new line number', () => {
    expect(addedLines(diffLines('a\nb\n', 'a\nB\nc\n'))).toEqual([{ line: 2, text: 'B' }, { line: 3, text: 'c' }]);
  });
});

describe('renderUnifiedDiff', () => {
  const base = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

  it('renders hunks with three lines of context and numbered headers', () => {
    const edited = [...base];
    edited[9] = 'LINE 10';
    const text = renderUnifiedDiff(diffLines(join(base), join(edited)), { label: 'shop-data/orders.md' }).text;
    expect(text.split('\n').slice(0, 3)).toEqual(['--- a/shop-data/orders.md', '+++ b/shop-data/orders.md', '@@ -7,7 +7,7 @@']);
    expect(text).toContain('-line 10\n+LINE 10');
    expect(text).toContain(' line 7');
    expect(text).not.toContain(' line 6');
  });

  it('splits distant changes into separate hunks and merges near ones', () => {
    const far = [...base];
    far[2] = 'X3';
    far[25] = 'X26';
    expect(renderUnifiedDiff(diffLines(join(base), join(far))).text.match(/^@@/gm)).toHaveLength(2);
    const near = [...base];
    near[2] = 'X3';
    near[7] = 'X8';
    expect(renderUnifiedDiff(diffLines(join(base), join(near))).text.match(/^@@/gm)).toHaveLength(1);
  });

  it('truncates after maxLines and says so', () => {
    const edited = base.map((line) => `${line}!`);
    const result = renderUnifiedDiff(diffLines(join(base), join(edited)), { maxLines: 20 });
    expect(result.truncated).toBe(true);
    expect(result.shownLines).toBe(20);
    expect(result.totalLines).toBeGreaterThan(20);
    expect(result.text.split('\n')).toHaveLength(20);
  });

  it('writes a new file as one hunk of additions', () => {
    const text = renderUnifiedDiff(diffLines('', 'x\ny\n')).text;
    expect(text).toContain('@@ -0,0 +1,2 @@');
    expect(text).toContain('+x\n+y');
  });
});
