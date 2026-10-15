/**
 * Server-side splices of a guide's table rows and TOC summaries (knowledge-library.md K15). Each edit touches only the
 * section it names: every other byte of the guide (the owner's hand edits, line endings, a BOM) survives, and the rules
 * digest never changes. Synthetic lookalikes of the owner's guides only.
 */
import { describe, expect, it } from 'vitest';
import { GARDEN_FILES, GARDEN_GUIDE, SHOP_GUIDE, STREAM_GUIDE } from './knowledge-fixtures.testutil.js';
import { parseGuide, rulesDigest } from './knowledge-guide.js';
import {
  addCategoryRow, removeFileRow, removeTocSection, renameFileRow, renameTocSection, setTocSection, upsertFileRow,
} from './knowledge-guide-edit.js';
import { ROOT_GUIDE_SEED } from './knowledge-templates.js';

const digest = (text: string) => rulesDigest(parseGuide(text));
/** The lines of `a` that are not in `b`, in order (to prove everything else is untouched). */
const onlyIn = (a: string, b: string) => { const other = new Set(b.split('\n')); return a.split('\n').filter((line) => !other.has(line)); };

describe('upsertFileRow', () => {
  it('adds a row to the File Ecosystem table in its own column order, with backticks like its neighbours, and nothing else changes', () => {
    const next = upsertFileRow(SHOP_GUIDE, { file: 'returns.md', path: 'shop-data/', mechanism: 'On demand', purpose: 'Return reasons and refund rules', audience: 'Analytics agent' });
    expect(onlyIn(next, SHOP_GUIDE)).toEqual(['| `returns.md` | shop-data/ | On demand | Return reasons and refund rules | Analytics agent |']);
    expect(onlyIn(SHOP_GUIDE, next)).toEqual([]);
    expect(digest(next)).toBe(digest(SHOP_GUIDE));
    const parsed = parseGuide(next);
    expect(parsed.rows.map((row) => row.file)).toContain('returns.md');
    // The new row sits after the last data row of the table, before the blockquote note.
    const lines = next.split('\n');
    const at = lines.findIndex((line) => line.includes('`returns.md`'));
    expect(lines[at - 1]).toContain('.kiro/steering/shop-data-docs.md');
  });

  it('replaces the cells of a row that is already there instead of adding a second one', () => {
    const next = upsertFileRow(SHOP_GUIDE, { file: 'orders.md', path: 'shop-data/', mechanism: 'On demand', purpose: 'SQL schemas and query patterns', audience: 'Everyone' });
    expect(next.match(/`orders\.md`/g)?.length).toBe(1 + (SHOP_GUIDE.match(/`orders\.md`/g)?.length ?? 0) - 1);
    expect(parseGuide(next).rows.find((row) => row.file === 'orders.md')).toMatchObject({ purpose: 'SQL schemas and query patterns', audience: 'Everyone' });
    expect(digest(next)).toBe(digest(SHOP_GUIDE));
  });

  it('escapes a pipe and a line break in a cell', () => {
    const next = upsertFileRow(SHOP_GUIDE, { file: 'x.md', purpose: 'a | b\nsecond line', audience: 'Me' });
    const row = next.split('\n').find((line) => line.includes('`x.md`')) as string;
    expect(row).toContain('a \\| b second line');
    expect(parseGuide(next).rows.find((entry) => entry.file === 'x.md')?.purpose).toBe('a | b second line');
  });

  it('keeps CRLF line endings and a BOM exactly', () => {
    const crlf = `\uFEFF${SHOP_GUIDE.replace(/\n/g, '\r\n')}`;
    const next = upsertFileRow(crlf, { file: 'returns.md', purpose: 'Returns' });
    expect(next.startsWith('\uFEFF')).toBe(true);
    expect(next.includes('\r\n')).toBe(true);
    expect(next.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(parseGuide(next).rows.map((row) => row.file)).toContain('returns.md');
    expect(digest(next)).toBe(digest(crlf));
  });

  it('creates a File Ecosystem section when the guide has no table, before the methodology', () => {
    const bare = '# Notes\n\nA bare guide.\n\n## Change Methodology\n\n- Keep it short\n\n## Guardrails\n\n- Do NOT add secrets\n';
    const next = upsertFileRow(bare, { file: 'one.md', purpose: 'The first note', audience: 'Me' });
    const parsed = parseGuide(next);
    expect(parsed.rows).toMatchObject([{ file: 'one.md', purpose: 'The first note', audience: 'Me' }]);
    expect(next.indexOf('## File Ecosystem')).toBeLessThan(next.indexOf('## Change Methodology'));
    expect(digest(next)).toBe(digest(bare));
  });

  it('works on the larger guide with a Path column of sub-folders', () => {
    const next = upsertFileRow(STREAM_GUIDE, { file: 'sessions.md', path: 'reference/', purpose: 'Session definitions', audience: 'Analytics agent' });
    expect(parseGuide(next).rows.map((row) => row.file)).toContain('sessions.md');
    expect(digest(next)).toBe(digest(STREAM_GUIDE));
  });
});

describe('removeFileRow and renameFileRow', () => {
  it('removes only the row of that file', () => {
    const next = removeFileRow(SHOP_GUIDE, 'orders_analysis.md');
    expect(onlyIn(SHOP_GUIDE, next)).toHaveLength(1);
    expect(onlyIn(SHOP_GUIDE, next)[0]).toContain('orders_analysis.md');
    expect(onlyIn(next, SHOP_GUIDE)).toEqual([]);
    expect(digest(next)).toBe(digest(SHOP_GUIDE));
    expect(removeFileRow(SHOP_GUIDE, 'never-there.md')).toBe(SHOP_GUIDE);
  });

  it('points a row at the new name and path', () => {
    const next = renameFileRow(SHOP_GUIDE, 'orders.md', 'orders-core.md', 'shop-data/core/');
    const row = parseGuide(next).rows.find((entry) => entry.file === 'orders-core.md');
    expect(row).toMatchObject({ path: 'shop-data/core/', purpose: expect.stringContaining('SQL schemas') });
    expect(parseGuide(next).rows.find((entry) => entry.file === 'orders.md')).toBeUndefined();
    expect(digest(next)).toBe(digest(SHOP_GUIDE));
  });
});

describe('the TOC summaries', () => {
  it('replaces the bullets of one file and leaves the others byte for byte', () => {
    const next = setTocSection(SHOP_GUIDE, 'SHOP_PRODUCT_GUIDE.md', ['Checkout flow and returns', 'Loyalty with three systems']);
    const parsed = parseGuide(next);
    expect(parsed.toc.find((entry) => entry.file === 'SHOP_PRODUCT_GUIDE.md')?.bullets).toEqual(['Checkout flow and returns', 'Loyalty with three systems']);
    expect(parsed.toc.find((entry) => entry.file === 'orders.md')).toEqual(parseGuide(SHOP_GUIDE).toc.find((entry) => entry.file === 'orders.md'));
    expect(onlyIn(next, SHOP_GUIDE)).toEqual(['- Checkout flow and returns', '- Loyalty with three systems']);
    expect(digest(next)).toBe(digest(SHOP_GUIDE));
  });

  it('adds a sub-section for a new file at the end of the section, and caps bullets at six of 160 characters', () => {
    const many = Array.from({ length: 9 }, (_, index) => `${'long bullet '.repeat(20)}${index}`);
    const next = setTocSection(SHOP_GUIDE, 'returns.md', many);
    const entry = parseGuide(next).toc.find((item) => item.file === 'returns.md');
    expect(entry?.bullets).toHaveLength(6);
    expect(entry?.bullets.every((bullet) => bullet.length <= 160)).toBe(true);
    expect(digest(next)).toBe(digest(SHOP_GUIDE));
  });

  it('creates the File TOC Summaries section when there is none', () => {
    const bare = '# Notes\n\nA guide.\n\n## Guardrails\n\n- Do NOT add secrets\n';
    const next = setTocSection(bare, 'one.md', ['First point']);
    expect(parseGuide(next).toc).toEqual([{ file: 'one.md', bullets: ['First point'] }]);
    expect(digest(next)).toBe(digest(bare));
  });

  it('removes and renames one sub-section', () => {
    const removed = removeTocSection(SHOP_GUIDE, 'orders_analysis.md');
    expect(parseGuide(removed).toc.map((entry) => entry.file)).toEqual(['orders.md', 'ORDERS_TABLE_REFERENCE.md', 'SHOP_PRODUCT_GUIDE.md']);
    expect(removeTocSection(SHOP_GUIDE, 'nothing.md')).toBe(SHOP_GUIDE);
    const renamed = renameTocSection(SHOP_GUIDE, 'orders.md', 'orders-core.md');
    expect(parseGuide(renamed).toc.map((entry) => entry.file)).toContain('orders-core.md');
    expect(parseGuide(renamed).toc.find((entry) => entry.file === 'orders-core.md')?.bullets).toEqual(parseGuide(SHOP_GUIDE).toc.find((entry) => entry.file === 'orders.md')?.bullets);
    expect(digest(removed)).toBe(digest(SHOP_GUIDE));
    expect(digest(renamed)).toBe(digest(SHOP_GUIDE));
  });
});

describe('addCategoryRow', () => {
  it('adds a folder to the root guide\'s Categories table once', () => {
    const next = addCategoryRow(ROOT_GUIDE_SEED, { folder: 'recipes', holds: 'Cooking notes and menus', kind: 'research' });
    const categories = parseGuide(next).categories;
    expect(categories.map((category) => category.folder)).toContain('recipes');
    expect(categories.find((category) => category.folder === 'recipes')).toMatchObject({ holds: 'Cooking notes and menus', kind: 'research' });
    expect(addCategoryRow(next, { folder: 'Recipes/', holds: 'again' })).toBe(next);
    expect(addCategoryRow('# No categories here\n', { folder: 'x', holds: 'y' })).toBe('# No categories here\n');
    expect(digest(next)).toBe(digest(ROOT_GUIDE_SEED));
  });
});

describe('a hand edit elsewhere survives a splice', () => {
  it('keeps odd spacing, extra notes and a hand-written section exactly', () => {
    const edited = SHOP_GUIDE.replace('## Guardrails', '## Guardrails\n\n<!-- hand note: keep this -->').replace('Context File > Table Reference', 'Context File  >  Table Reference');
    const next = upsertFileRow(setTocSection(edited, 'orders.md', ['Only one bullet']), { file: 'returns.md', purpose: 'Returns' });
    expect(next).toContain('<!-- hand note: keep this -->');
    expect(next).toContain('Context File  >  Table Reference');
    expect(digest(next)).toBe(digest(edited));
  });
});

// ── Two files that share a base name in two folders (P2 review R31) ────────

const rowOf = (text: string, file: string) => parseGuide(text).rows.find((row) => row.file === file);
const summaryOf = (text: string, file: string) => parseGuide(text).toc.find((entry) => entry.file === file)?.bullets;

describe('two files with one base name keep their own row and their own summary', () => {
  it('creating a third adds a row and a section and changes neither existing one', () => {
    const names = ['overview.md', 'beds/notes.md', 'tools/notes.md'];
    const withRow = upsertFileRow(GARDEN_GUIDE, { file: 'sheds/notes.md', path: 'sheds/', purpose: 'Notes on the sheds', audience: 'Me' }, names);
    const next = setTocSection(withRow, 'sheds/notes.md', ['roof repairs'], names);
    expect(parseGuide(next).rows.map((row) => row.file)).toEqual(['overview.md', 'beds/notes.md', 'tools/notes.md', 'sheds/notes.md']);
    expect(rowOf(next, 'beds/notes.md')?.purpose).toBe('Notes on the beds');
    expect(rowOf(next, 'tools/notes.md')?.purpose).toBe('Notes on the tools');
    expect(parseGuide(next).toc.map((entry) => entry.file)).toEqual(['overview.md', 'beds/notes.md', 'tools/notes.md', 'sheds/notes.md']);
    expect(summaryOf(next, 'beds/notes.md')).toEqual(['bed layout', 'planting dates']);
    expect(summaryOf(next, 'tools/notes.md')).toEqual(['spades and forks']);
    expect(onlyIn(GARDEN_GUIDE, next)).toEqual([]);
    expect(digest(next)).toBe(digest(GARDEN_GUIDE));
  });

  it('creating the second one replaces nothing of the first (the order the writer works in)', () => {
    const start = '# Garden\n\nA guide.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n| --- | --- | --- | --- | --- |\n| `overview.md` | | On demand | The garden | Me |\n\n## File TOC Summaries\n\n### overview.md\n- the garden\n';
    const first = setTocSection(upsertFileRow(start, { file: 'beds/notes.md', path: 'beds/', purpose: 'Beds' }, ['overview.md', 'beds/notes.md']), 'beds/notes.md', ['bed layout'], ['overview.md', 'beds/notes.md']);
    const both = ['overview.md', 'beds/notes.md', 'tools/notes.md'];
    const second = setTocSection(upsertFileRow(first, { file: 'tools/notes.md', path: 'tools/', purpose: 'Tools' }, both), 'tools/notes.md', ['spades and forks'], both);
    expect(parseGuide(second).rows.map((row) => [row.file, row.purpose])).toEqual([['overview.md', 'The garden'], ['beds/notes.md', 'Beds'], ['tools/notes.md', 'Tools']]);
    expect(parseGuide(second).toc).toEqual([{ file: 'overview.md', bullets: ['the garden'] }, { file: 'beds/notes.md', bullets: ['bed layout'] }, { file: 'tools/notes.md', bullets: ['spades and forks'] }]);
  });

  it('a refresh of one summary rewrites that heading only', () => {
    const next = setTocSection(GARDEN_GUIDE, 'tools/notes.md', ['spades, forks and a hose'], GARDEN_FILES);
    expect(onlyIn(next, GARDEN_GUIDE)).toEqual(['- spades, forks and a hose']);
    expect(summaryOf(next, 'beds/notes.md')).toEqual(['bed layout', 'planting dates']);
    const bedsOnly = setTocSection(GARDEN_GUIDE, 'beds/notes.md', ['beds only'], GARDEN_FILES);
    expect(summaryOf(bedsOnly, 'beds/notes.md')).toEqual(['beds only']);
    expect(summaryOf(bedsOnly, 'tools/notes.md')).toEqual(['spades and forks']);
  });

  it('archiving one removes its own row and heading and leaves the other', () => {
    const next = removeTocSection(removeFileRow(GARDEN_GUIDE, 'tools/notes.md', GARDEN_FILES), 'tools/notes.md', GARDEN_FILES);
    expect(parseGuide(next).rows.map((row) => row.file)).toEqual(['overview.md', 'beds/notes.md']);
    expect(parseGuide(next).toc.map((entry) => entry.file)).toEqual(['overview.md', 'beds/notes.md']);
    const beds = removeTocSection(removeFileRow(GARDEN_GUIDE, 'beds/notes.md', GARDEN_FILES), 'beds/notes.md', GARDEN_FILES);
    expect(parseGuide(beds).rows.map((row) => row.file)).toEqual(['overview.md', 'tools/notes.md']);
    expect(summaryOf(beds, 'tools/notes.md')).toEqual(['spades and forks']);
    expect(digest(next)).toBe(digest(GARDEN_GUIDE));
  });

  it('renaming one points its own row and heading at the new name and leaves the other', () => {
    const moved = renameTocSection(renameFileRow(GARDEN_GUIDE, 'tools/notes.md', 'tools/kit.md', 'tools/', GARDEN_FILES), 'tools/notes.md', 'tools/kit.md', GARDEN_FILES);
    expect(parseGuide(moved).rows.map((row) => row.file)).toEqual(['overview.md', 'beds/notes.md', 'tools/kit.md']);
    expect(rowOf(moved, 'tools/kit.md')?.purpose).toBe('Notes on the tools');
    expect(parseGuide(moved).toc.map((entry) => entry.file)).toEqual(['overview.md', 'beds/notes.md', 'tools/kit.md']);
    expect(summaryOf(moved, 'tools/kit.md')).toEqual(['spades and forks']);
    expect(summaryOf(moved, 'beds/notes.md')).toEqual(['bed layout', 'planting dates']);
  });

  it('a stale bare row that fits two files is left alone, and the new file still gets its own row', () => {
    const hand = GARDEN_GUIDE.replace('| `beds/notes.md` | beds/ | On demand | Notes on the beds | Me |', '| `notes.md` | | On demand | An older bare row | Me |');
    const next = upsertFileRow(hand, { file: 'sheds/notes.md', path: 'sheds/', purpose: 'Sheds' }, [...GARDEN_FILES, 'sheds/notes.md']);
    expect(parseGuide(next).rows.map((row) => row.file)).toEqual(['overview.md', 'notes.md', 'tools/notes.md', 'sheds/notes.md']);
    expect(rowOf(next, 'notes.md')?.purpose).toBe('An older bare row');
  });

  it('a hand-written guide that lists both files by a bare name and a Path tells them apart', () => {
    const hand = GARDEN_GUIDE
      .replace('| `beds/notes.md` | beds/ |', '| `notes.md` | beds/ |')
      .replace('| `tools/notes.md` | tools/ |', '| `notes.md` | tools/ |');
    expect(parseGuide(hand).rows.map((row) => row.purpose)).toEqual(['The garden at a glance', 'Notes on the beds', 'Notes on the tools']);
    const purposes = (text: string) => parseGuide(text).rows.map((row) => row.purpose);
    expect(purposes(removeFileRow(hand, 'tools/notes.md', GARDEN_FILES))).toEqual(['The garden at a glance', 'Notes on the beds']);
    expect(purposes(removeFileRow(hand, 'beds/notes.md', GARDEN_FILES))).toEqual(['The garden at a glance', 'Notes on the tools']);
    const replaced = upsertFileRow(hand, { file: 'tools/notes.md', path: 'tools/', purpose: 'Tool notes, second edition' }, GARDEN_FILES);
    expect(purposes(replaced)).toEqual(['The garden at a glance', 'Notes on the beds', 'Tool notes, second edition']);
    const renamed = renameFileRow(hand, 'tools/notes.md', 'tools/kit.md', 'tools/', GARDEN_FILES);
    expect(parseGuide(renamed).rows.map((row) => row.file)).toEqual(['overview.md', 'notes.md', 'tools/kit.md']);
    expect(purposes(renamed)).toEqual(['The garden at a glance', 'Notes on the beds', 'Notes on the tools']);
  });

  it('on the larger lookalike a sub-folder file is found under its bare row and heading: replaced in place, never added twice', () => {
    const names = ['streamly.md', 'streamly_analysis.md', 'STREAMLY_TABLE_REFERENCE.md', 'STREAMLY_PRODUCT_GUIDE.md', 'reference/STREAMLY_ADS_REFERENCE.md', 'reference/events_combined.md'];
    const refreshed = setTocSection(STREAM_GUIDE, 'reference/events_combined.md', ['one combined dictionary'], names);
    expect(parseGuide(refreshed).toc.filter((entry) => /events_combined/.test(entry.file))).toEqual([{ file: 'events_combined.md', bullets: ['one combined dictionary'] }]);
    const replaced = upsertFileRow(STREAM_GUIDE, { file: 'reference/events_combined.md', path: 'streamly-analytics/reference/', purpose: 'The event dictionary' }, names);
    expect(parseGuide(replaced).rows.filter((row) => /events_combined/.test(row.file))).toHaveLength(1);
    expect(parseGuide(replaced).rows.length).toBe(parseGuide(STREAM_GUIDE).rows.length);
    const removed = removeTocSection(removeFileRow(STREAM_GUIDE, 'reference/events_combined.md', names), 'reference/events_combined.md', names);
    expect(parseGuide(removed).rows.map((row) => row.file)).not.toContain('events_combined.md');
    expect(parseGuide(removed).toc.map((entry) => entry.file)).not.toContain('events_combined.md');
    expect(parseGuide(removed).rows).toHaveLength(parseGuide(STREAM_GUIDE).rows.length - 1);
    expect(digest(removed)).toBe(digest(STREAM_GUIDE));
  });

  it('a guide with unique bare names and a Path column still resolves, folder-first Paths included', () => {
    const names = ['orders.md', 'reference/events.md'];
    const guide = '# Shop\n\nA guide.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n| --- | --- | --- | --- | --- |\n| `orders.md` | shop-data/ | On demand | Orders | Me |\n| `events.md` | shop-data/reference/ | On demand | Events | Me |\n\n## File TOC Summaries\n\n### orders.md\n- orders\n\n### events\n- events\n';
    expect(parseGuide(removeFileRow(guide, 'reference/events.md', names)).rows.map((row) => row.file)).toEqual(['orders.md']);
    expect(upsertFileRow(guide, { file: 'orders.md', path: 'shop-data/', purpose: 'Orders and returns' }, names).match(/`orders\.md`/g)).toHaveLength(1);
    // A heading without an extension is the stem of exactly one file.
    expect(summaryOf(setTocSection(guide, 'reference/events.md', ['all events'], names), 'events')).toEqual(['all events']);
  });
});
