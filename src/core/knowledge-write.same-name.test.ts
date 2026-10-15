/**
 * Two files that share a base name in two folders keep their own guide row and their own TOC summary through every mode of
 * the composite write (knowledge-library.md K15 and K17; P2 review R31). The writer passes the set's file names to the guide
 * splices, so a bare name that fits two files stands for neither. Hermetic, synthetic, a spaced library path.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GARDEN_GUIDE, guideWith } from './knowledge-fixtures.testutil.js';
import { parseGuide } from './knowledge-guide.js';
import { ROOT_GUIDE_SEED } from './knowledge-templates.js';
import { makeHarness, type Harness } from './knowledge-write.testutil.js';

const GARDEN = `# Garden notes

Notes for a small garden.

## File Ecosystem

| File | Path | Loading Mechanism | Purpose | Audience |
| --- | --- | --- | --- | --- |
| \`overview.md\` | | On demand | The garden at a glance | Me |

## Change Methodology

- Keep each note short

## Guardrails

- Do NOT add secrets

## Conflict Priority Order

overview > notes

## File TOC Summaries

### overview.md
- the garden in one page
`;

let h: Harness;
beforeEach(async () => {
  h = await makeHarness({ files: { 'GUIDE.md': ROOT_GUIDE_SEED, 'garden/GUIDE.md': GARDEN, 'garden/overview.md': '# Overview\n\nThe garden.\n' } });
});
afterEach(() => { h.close(); fs.rmSync(h.base, { recursive: true, force: true }); });

const rows = (setId = 'garden') => parseGuide(h.read(`${setId}/GUIDE.md`)).rows.map((row) => [row.file, row.purpose]);
const toc = (setId = 'garden') => parseGuide(h.read(`${setId}/GUIDE.md`)).toc.map((entry) => [entry.file, entry.bullets]);

/** Create a file the way the owner asks for it, with the summary the check returns for the guide. */
async function create(file: string, purpose: string, bullets: string[]) {
  h.queue({ summaryUpdate: { purpose, bullets } });
  return h.write(h.turn(`please create ${file} in garden`), { set: 'garden', file, mode: 'create', content: `# ${purpose}\n\nA note.\n` });
}

const OVERVIEW = ['overview.md', 'The garden at a glance'];
const BEDS = ['beds/notes.md', 'Notes on the beds'];
const TOOLS = ['tools/notes.md', 'Notes on the tools'];

describe('two files named notes.md in two folders of one set', () => {
  it('creating beds/notes.md and then tools/notes.md leaves both rows and both summaries in the guide', async () => {
    expect(await create('beds/notes.md', 'Notes on the beds', ['bed layout', 'planting dates'])).toMatchObject({ ok: true, status: 'applied' });
    expect(await create('tools/notes.md', 'Notes on the tools', ['spades and forks'])).toMatchObject({ ok: true, status: 'applied' });
    expect(rows()).toEqual([OVERVIEW, BEDS, TOOLS]);
    expect(toc()).toEqual([['overview.md', ['the garden in one page']], ['beds/notes.md', ['bed layout', 'planting dates']], ['tools/notes.md', ['spades and forks']]]);
    // The table row of each file names its own folder, and the guide text holds one heading per file.
    const text = h.read('garden/GUIDE.md');
    expect(text.match(/^### .*notes\.md$/gm)).toEqual(['### beds/notes.md', '### tools/notes.md']);
    expect(text.match(/^\| `.*notes\.md`/gm)).toHaveLength(2);
  });

  it('editing one refreshes its own summary and never the other\'s', async () => {
    await create('beds/notes.md', 'Notes on the beds', ['bed layout']);
    await create('tools/notes.md', 'Notes on the tools', ['spades and forks']);
    h.queue({ summaryUpdate: { bullets: ['spades, forks and a hose'] } });
    const reply = await h.write(h.turn('please add a hose to tools/notes.md in garden'), { set: 'garden', file: 'tools/notes.md', mode: 'append', content: '\nA hose.\n' });
    expect(reply).toMatchObject({ ok: true, status: 'applied' });
    expect(toc()).toEqual([['overview.md', ['the garden in one page']], ['beds/notes.md', ['bed layout']], ['tools/notes.md', ['spades, forks and a hose']]]);
    expect(rows()).toEqual([OVERVIEW, BEDS, TOOLS]);
    // The role the guide check judges the edit against is the tools file's own row.
    const prompt = h.llmCalls[h.llmCalls.length - 1].messages.map((message) => String(message.content)).join('\n');
    expect(prompt).toContain('role in the file table: Notes on the tools');
    expect(prompt).not.toContain('role in the file table: Notes on the beds');
  });

  it('the rules the drafter is handed for one of them carry that file\'s row, not the first file with that name', async () => {
    await create('beds/notes.md', 'Notes on the beds', ['bed layout']);
    await create('tools/notes.md', 'Notes on the tools', ['spades and forks']);
    const payload = await h.writer.rulesPayloadFor('garden', 'tools/notes.md');
    expect('fence' in payload).toBe(true);
    const fence = (payload as { fence: string }).fence;
    expect(fence).toContain('Notes on the tools');
    expect(fence).not.toContain('Notes on the beds');
    expect(fence).toContain('tools/notes.md');
  });

  it('the rules that come back for a call without a receipt are the file\'s own, and a third file with that base name is a new name that gets the whole table', async () => {
    await create('beds/notes.md', 'Notes on the beds', ['bed layout']);
    await create('tools/notes.md', 'Notes on the tools', ['spades and forks']);
    const missing = await h.writer.write({ set: 'garden', file: 'tools/notes.md', mode: 'append', content: '\nA hose.\n', ownerRequested: true }, h.turn('please add a hose to tools/notes.md in garden'), 'knowledge_write');
    expect(missing).toMatchObject({ ok: false, code: 'guide_not_read' });
    expect(String(missing.rules)).toContain('Notes on the tools');
    expect(String(missing.rules)).not.toContain('Notes on the beds');
    const fresh = await h.writer.rulesPayloadFor('garden', 'sheds/notes.md');
    const fence = (fresh as { fence: string }).fence;
    expect(fence).toContain('Notes on the beds');
    expect(fence).toContain('Notes on the tools');
  });

  it('editing a file that has no summary yet does not make one, even though another file with its base name has one', async () => {
    h.put('garden/GUIDE.md', GARDEN_GUIDE.replace('\n### tools/notes.md\n- spades and forks\n', '\n'));
    h.put('garden/beds/notes.md', '# Beds\n\nA note.\n');
    h.put('garden/tools/notes.md', '# Tools\n\nA note.\n');
    h.queue({ summaryUpdate: { bullets: ['spades, forks and a hose'] } });
    const reply = await h.write(h.turn('please add a hose to tools/notes.md in garden'), { set: 'garden', file: 'tools/notes.md', mode: 'append', content: '\nA hose.\n' });
    expect(reply).toMatchObject({ ok: true, status: 'applied' });
    expect(toc().map(([file]) => file)).toEqual(['overview.md', 'beds/notes.md']);
    expect(toc()[1]).toEqual(['beds/notes.md', ['bed layout', 'planting dates']]);
  });

  it('moving one renames its own row and heading and leaves the other', async () => {
    await create('beds/notes.md', 'Notes on the beds', ['bed layout']);
    await create('tools/notes.md', 'Notes on the tools', ['spades and forks']);
    h.queue({});
    const reply = await h.write(h.turn('please rename tools/notes.md to tools/kit.md in garden'), { set: 'garden', file: 'tools/notes.md', mode: 'move', toFile: 'tools/kit.md' });
    expect(reply).toMatchObject({ ok: true, status: 'applied' });
    expect(h.exists('tools/kit.md')).toBe(false);
    expect(h.exists('garden/tools/kit.md')).toBe(true);
    expect(rows()).toEqual([OVERVIEW, BEDS, ['tools/kit.md', 'Notes on the tools']]);
    expect(toc()).toEqual([['overview.md', ['the garden in one page']], ['beds/notes.md', ['bed layout']], ['tools/kit.md', ['spades and forks']]]);
  });

  it('archiving one drops its own row and heading and leaves the other', async () => {
    await create('beds/notes.md', 'Notes on the beds', ['bed layout']);
    await create('tools/notes.md', 'Notes on the tools', ['spades and forks']);
    h.queue({});
    // The SECOND file in the table: a lookup by base name would remove the first row instead.
    const reply = await h.write(h.turn('please archive tools/notes.md in garden'), { set: 'garden', file: 'tools/notes.md', mode: 'archive' });
    expect(reply).toMatchObject({ ok: true, status: 'applied' });
    expect(rows()).toEqual([OVERVIEW, BEDS]);
    expect(toc()).toEqual([['overview.md', ['the garden in one page']], ['beds/notes.md', ['bed layout']]]);
    // Undo puts the guide back as it was.
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(rows()).toEqual([OVERVIEW, BEDS, TOOLS]);
    expect(toc().map(([file]) => file)).toEqual(['overview.md', 'beds/notes.md', 'tools/notes.md']);
  });

  it('a move to another set whose guide already has a notes.md row leaves that row alone', async () => {
    await create('beds/notes.md', 'Notes on the beds', ['bed layout']);
    await create('tools/notes.md', 'Notes on the tools', ['spades and forks']);
    h.put('journal/GUIDE.md', guideWith({ name: 'journal' }, '# Journal\n\nDay notes.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n|---|---|---|---|---|\n| `daily/notes.md` | daily/ | On demand | Daily notes | Me |\n\n## Change Methodology\n\n- Keep it short\n\n## Guardrails\n\n- Do NOT store secrets\n\n## Conflict Priority Order\n\nA > B\n\n## File TOC Summaries\n\n### daily/notes.md\n- the days\n'));
    h.put('journal/daily/notes.md', '# Daily\n\nToday.\n');
    const context = h.turn('move tools/notes.md from garden to journal');
    const gardenRules = await h.rules(context, 'garden', 'tools/notes.md');
    context.guidesDelivered!.garden.full = true;
    const args = { set: 'garden', file: 'tools/notes.md', mode: 'move', toFile: 'notes.md', toSet: 'journal', ownerRequested: true, rulesSha256: gardenRules };
    expect(await h.writer.write(args, context, 'knowledge_write')).toMatchObject({ code: 'guide_not_read', reason: 'not_delivered' });
    h.queue({});
    const second = await h.writer.write(args, context, 'knowledge_write');
    expect(second, JSON.stringify(second).slice(0, 500)).toMatchObject({ status: 'applied' });
    expect(rows('journal')).toEqual([['daily/notes.md', 'Daily notes'], ['notes.md', 'Notes on the tools']]);
    expect(toc('journal')).toEqual([['daily/notes.md', ['the days']], ['notes.md', ['spades and forks']]]);
    expect(rows('garden')).toEqual([OVERVIEW, BEDS]);
    expect(toc('garden')).toEqual([['overview.md', ['the garden in one page']], ['beds/notes.md', ['bed layout']]]);
  });
});

describe('a guide is addressed as GUIDE.md of its own set (P2 review R33)', () => {
  const CHILD = '# Child\n\nA nested set.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n|---|---|---|---|---|\n| `a.md` | child/ | On demand | A | Me |\n\n## Change Methodology\n\n- Keep it short\n\n## Guardrails\n\n- Do NOT store secrets\n\n## Conflict Priority Order\n\nA > B\n';

  it('child/GUIDE.md under the parent set is refused and changes neither guide; GUIDE.md alone still reaches the set\'s own guide', async () => {
    h.put('garden/child/GUIDE.md', guideWith({ name: 'child' }, CHILD));
    h.put('garden/child/a.md', '# A\n');
    const parentBefore = h.read('garden/GUIDE.md');
    const childBefore = h.read('garden/child/GUIDE.md');
    for (const args of [
      { set: 'garden', file: 'child/GUIDE.md', mode: 'append', content: '\n- Do NOT ignore this\n' },
      { set: 'garden', file: 'child/GUIDE.md', mode: 'create', content: '# x\n' },
      { set: 'garden', file: 'overview.md', mode: 'move', toFile: 'child/GUIDE.md' },
    ]) {
      // The receipt comes first: the model gets the rules, then repeats the call with their digest.
      const context = h.turn('please change the garden guide');
      let reply = await h.writer.write({ ...args, ownerRequested: true }, context, 'knowledge_write');
      for (let round = 0; round < 4 && reply.code === 'guide_not_read'; round += 1) {
        reply = await h.writer.write({ ...args, ownerRequested: true, rulesSha256: reply.rulesSha256 }, context, 'knowledge_write');
      }
      expect(reply, JSON.stringify(args)).toMatchObject({ ok: false, code: 'invalid_path', effect: 'none', nextAction: expect.stringContaining('nested set by its own id') });
    }
    expect(h.read('garden/GUIDE.md')).toBe(parentBefore);
    expect(h.read('garden/child/GUIDE.md')).toBe(childBefore);
    expect(h.changes.list({ statuses: ['staged', 'held', 'revising'] })).toHaveLength(0);
    // The set's own guide is still reachable by its plain name (an edit of a guide is a card or a direct apply, never refused here).
    h.queue({});
    const own = await h.write(h.turn('please add a rule to the garden guide'), { set: 'garden', file: 'GUIDE.md', mode: 'append', content: '\n- Do NOT water at noon\n' });
    expect(own.code).not.toBe('invalid_path');
    expect(['applied', 'staged']).toContain(own.status);
  });
});
