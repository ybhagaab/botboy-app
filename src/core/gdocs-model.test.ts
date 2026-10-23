import { describe, expect, it } from 'vitest';
import { buildDocView, parseInlineMarkdown, parseLineMark, planDocAppend, planDocEdits } from './gdocs-model.js';
import { createFakeDocs } from './gdocs.fake.js';

const SAMPLE = [
  '# Quarterly plan',
  'Revenue grew **12%** in Q3.',
  '## Goals',
  '- Ship the Drive tools',
  '  - Docs first',
  '- Then Sheets',
  '1. Plan',
  '1. Build',
  'A paragraph with an [image] in it.',
  '| Name | Owner |',
  '| --- | --- |',
  '| Drive | Yan |',
  'Last line.',
].join('\n');

async function setup(markdown = SAMPLE) {
  const docs = createFakeDocs();
  docs.fromMarkdown('d1', markdown, 'Plan');
  return docs;
}

async function edit(docs: ReturnType<typeof createFakeDocs>, edits: Array<{ find: string; replace: string }>) {
  const doc = await docs.get('d1');
  const plan = planDocEdits(doc, edits);
  if (!plan.ok) throw new Error(`${plan.code}: ${plan.message}`);
  await docs.batchUpdate('d1', plan.requests, doc.revisionId);
  return docs.lines('d1');
}

describe('the read view', () => {
  it('draws headings, nested and numbered lists, images, and table rows as Markdown-like lines', async () => {
    const docs = await setup();
    const view = buildDocView(await docs.get('d1'));
    expect(view.text.split('\n')).toEqual([
      '# Quarterly plan',
      'Revenue grew 12% in Q3.',
      '## Goals',
      '- Ship the Drive tools',
      '  - Docs first',
      '- Then Sheets',
      '1. Plan',
      '1. Build',
      'A paragraph with an [image] in it.',
      '| Name | Owner |',
      '| --- | --- |',
      '| Drive | Yan |',
      'Last line.',
    ]);
    expect(view.revisionId).toBe('rev-1');
  });

  it('maps every text character to its document index and BotBoy’s marks to none', async () => {
    const docs = await setup('## Goals\nText');
    const view = buildDocView(await docs.get('d1'));
    expect([...view.indexAt.slice(0, 3)]).toEqual([-1, -1, -1]);
    expect(view.indexAt[3]).toBe(1);
    // The line break is the heading's own newline.
    expect(view.indexAt[8]).toBe(6);
  });
});

describe('planDocEdits', () => {
  it('replaces words inside a paragraph and keeps its style and the text around them', async () => {
    const docs = await setup();
    const lines = await edit(docs, [{ find: 'Revenue grew 12%', replace: 'Revenue grew 15%' }]);
    expect(lines[1]).toBe('NORMAL_TEXT||Revenue grew 15% in Q3.');
    expect(lines[0]).toBe('HEADING_1||Quarterly plan');
  });

  it('changes a heading level when the line mark is part of the edit', async () => {
    const docs = await setup();
    const lines = await edit(docs, [{ find: '## Goals', replace: '### Objectives' }]);
    expect(lines[2]).toBe('HEADING_3||Objectives');
  });

  it('keeps a heading when only its text is found', async () => {
    const docs = await setup();
    const lines = await edit(docs, [{ find: 'Goals', replace: 'Targets' }]);
    expect(lines[2]).toBe('HEADING_2||Targets');
  });

  it('adds paragraphs and a list after a heading, each styled from its mark', async () => {
    const docs = await setup('## Goals\nOld text');
    const lines = await edit(docs, [{ find: '## Goals', replace: '## Goals\nWhy this matters.\n- First\n- Second' }]);
    expect(lines.slice(0, 4).map(line => line.replace(/:list\d+/, ''))).toEqual([
      'HEADING_2||Goals',
      'NORMAL_TEXT||Why this matters.',
      'NORMAL_TEXT|ul0|First',
      'NORMAL_TEXT|ul0|Second',
    ]);
    // Both new list items are one list.
    expect(lines[2].split('|')[1]).toBe(lines[3].split('|')[1]);
    expect(lines[4]).toBe('NORMAL_TEXT||Old text');
  });

  it('adds a list item into the same list, so the numbering carries on', async () => {
    const docs = await setup();
    const before = docs.lines('d1');
    const lines = await edit(docs, [{ find: '1. Build', replace: '1. Build\n1. Ship' }]);
    const listOf = (line: string) => line.split('|')[1];
    expect(lines[7]).toBe(before[7]);
    expect(lines[8].endsWith('|Ship')).toBe(true);
    expect(listOf(lines[8])).toBe(listOf(before[7]));
  });

  it('nests a new list item by its indent', async () => {
    const docs = await setup('- Parent\nEnd');
    const lines = await edit(docs, [{ find: '- Parent', replace: '- Parent\n  - Child' }]);
    expect(lines[1]).toMatch(/^NORMAL_TEXT\|ul1:list\d+\|Child$/);
  });

  it('deletes a whole line with its line break', async () => {
    const docs = await setup();
    const lines = await edit(docs, [{ find: 'Revenue grew 12% in Q3.\n', replace: '' }]);
    expect(lines[1]).toBe('HEADING_2||Goals');
  });

  it('turns a list item into a normal paragraph when the mark is removed', async () => {
    const docs = await setup();
    const lines = await edit(docs, [{ find: '- Then Sheets', replace: 'Then Sheets' }]);
    expect(lines[5]).toBe('NORMAL_TEXT||Then Sheets');
  });

  it('joins two paragraphs and keeps the first one’s style', async () => {
    const docs = await setup('## Title here\nBody text');
    const lines = await edit(docs, [{ find: 'here\nBody', replace: 'and body' }]);
    expect(lines[0]).toBe('HEADING_2||Title and body text');
  });

  it('edits text inside one table cell', async () => {
    const docs = await setup();
    const lines = await edit(docs, [{ find: 'Yan', replace: 'Priya' }]);
    expect(lines).toContain('TABLE 1,1: Priya');
  });

  it('applies several edits in one write at the right places', async () => {
    const docs = await setup();
    const lines = await edit(docs, [
      { find: 'Last line.', replace: 'Final line.' },
      { find: 'Quarterly plan', replace: 'Q4 plan' },
      { find: 'Then Sheets', replace: 'Then Slides' },
    ]);
    expect(lines[0]).toBe('HEADING_1||Q4 plan');
    expect(lines[5]).toMatch(/\|Then Slides$/);
    expect(lines[lines.length - 1]).toBe('NORMAL_TEXT||Final line.');
  });

  it('writes inline Markdown as bold, italic and links', async () => {
    const docs = await setup('Plain');
    const doc = await docs.get('d1');
    const plan = planDocEdits(doc, [{ find: 'Plain', replace: 'Now **bold** and *soft* and [docs](https://example.com)' }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await docs.batchUpdate('d1', plan.requests, doc.revisionId);
    const runs = (await docs.get('d1')).body!.content![1].paragraph!.elements!.map(element => [element.textRun?.content, element.textRun?.textStyle]);
    expect(runs).toEqual([
      ['Now ', {}],
      ['bold', { bold: true }],
      [' and ', {}],
      ['soft', { italic: true }],
      [' and ', {}],
      // The paragraph's newline rides in the last run, as in Google's answers.
      ['docs\n', { link: { url: 'https://example.com' } }],
    ]);
  });

  it('keeps text literal when markdown is off', async () => {
    const docs = await setup('Plain');
    const doc = await docs.get('d1');
    const plan = planDocEdits(doc, [{ find: 'Plain', replace: '5 * 3 = **15**' }], { markdown: false });
    if (!plan.ok) throw new Error(plan.message);
    await docs.batchUpdate('d1', plan.requests, doc.revisionId);
    expect(docs.lines('d1')[0]).toBe('NORMAL_TEXT||5 * 3 = **15**');
  });

  it('reads no line marks either when markdown is off, in edits and in appends', async () => {
    const docs = await setup('## Title\nPlain line');
    const doc = await docs.get('d1');
    const plan = planDocEdits(doc, [{ find: 'Plain line', replace: '# not a heading\n- not a list' }], { markdown: false });
    if (!plan.ok) throw new Error(plan.message);
    await docs.batchUpdate('d1', plan.requests, doc.revisionId);
    expect(docs.lines('d1')).toEqual(['HEADING_2||Title', 'NORMAL_TEXT||# not a heading', 'NORMAL_TEXT||- not a list']);
    const again = await docs.get('d1');
    const appended = planDocAppend(again, '## also literal', { markdown: false });
    if (!appended.ok) throw new Error(appended.message);
    await docs.batchUpdate('d1', appended.requests, again.revisionId);
    expect(docs.lines('d1').at(-1)).toBe('NORMAL_TEXT||## also literal');
  });

  it('refuses what it cannot do exactly, and changes nothing', async () => {
    const docs = await setup();
    const doc = await docs.get('d1');
    const cases: Array<[Array<{ find: string; replace: string }>, string]> = [
      [[{ find: 'Nowhere', replace: 'x' }], 'edit_not_found'],
      [[{ find: 'e', replace: 'x' }], 'edit_not_unique'],
      [[{ find: 'an [image] in', replace: 'no image in' }], 'edit_not_editable'],
      [[{ find: '| Drive | Yan |', replace: 'x' }], 'edit_not_editable'],
      [[{ find: '## ', replace: '# ' }], 'edit_not_editable'],
      [[{ find: 'Quarterly plan', replace: 'A' }, { find: 'plan\nRevenue', replace: 'B' }], 'edits_overlap'],
      [[{ find: 'in it.\n', replace: '' }], 'edit_not_editable'],
    ];
    for (const [edits, code] of cases) {
      const plan = planDocEdits(doc, edits);
      expect(plan.ok, JSON.stringify(edits)).toBe(false);
      if (!plan.ok) expect(plan.code, JSON.stringify(edits)).toBe(code);
    }
  });

  it('a write against a document someone changed since the read is refused by Google', async () => {
    const docs = await setup();
    const doc = await docs.get('d1');
    const plan = planDocEdits(doc, [{ find: 'Last line.', replace: 'Changed.' }]);
    if (!plan.ok) throw new Error(plan.message);
    docs.touch('d1');
    await expect(docs.batchUpdate('d1', plan.requests, doc.revisionId)).rejects.toThrow(/FAILED_PRECONDITION/);
    expect(docs.lines('d1').at(-1)).toBe('NORMAL_TEXT||Last line.');
  });
});

describe('planDocAppend', () => {
  it('adds Markdown lines after the last paragraph', async () => {
    const docs = await setup('# Notes\nFirst');
    const doc = await docs.get('d1');
    const plan = planDocAppend(doc, '## Next steps\n- Call Ana\n- Send the deck');
    if (!plan.ok) throw new Error(plan.message);
    await docs.batchUpdate('d1', plan.requests, doc.revisionId);
    expect(docs.lines('d1').map(line => line.replace(/:list\d+/, ''))).toEqual([
      'HEADING_1||Notes',
      'NORMAL_TEXT||First',
      'HEADING_2||Next steps',
      'NORMAL_TEXT|ul0|Call Ana',
      'NORMAL_TEXT|ul0|Send the deck',
    ]);
  });

  it('fills an empty last paragraph instead of leaving a blank line', async () => {
    const docs = await setup('| A |\n| --- |\n| B |');
    const doc = await docs.get('d1');
    const plan = planDocAppend(doc, 'After the table');
    if (!plan.ok) throw new Error(plan.message);
    await docs.batchUpdate('d1', plan.requests, doc.revisionId);
    expect(docs.lines('d1').at(-1)).toBe('NORMAL_TEXT||After the table');
  });
});

describe('Markdown parsing', () => {
  it('reads line marks', () => {
    expect(parseLineMark('### Title')).toEqual({ heading: 3, bullet: null, content: 'Title' });
    expect(parseLineMark('  - Child')).toEqual({ heading: null, bullet: { nesting: 1, ordered: false, checkbox: false }, content: 'Child' });
    expect(parseLineMark('12. Step')).toEqual({ heading: null, bullet: { nesting: 0, ordered: true, checkbox: false }, content: 'Step' });
    expect(parseLineMark('- [ ] Task')).toEqual({ heading: null, bullet: { nesting: 0, ordered: false, checkbox: true }, content: 'Task' });
    expect(parseLineMark('#hashtag')).toEqual({ heading: null, bullet: null, content: '#hashtag' });
  });

  it('reads inline marks conservatively', () => {
    expect(parseInlineMarkdown('a **b** c').plain).toBe('a b c');
    expect(parseInlineMarkdown('snake_case_name stays').plain).toBe('snake_case_name stays');
    expect(parseInlineMarkdown('5 * 3 * 2').plain).toBe('5 * 3 * 2');
    expect(parseInlineMarkdown('`x = 1`').spans).toEqual([{ start: 0, end: 5, code: true }]);
  });
});
