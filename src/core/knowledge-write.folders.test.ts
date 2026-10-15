/**
 * A change that takes files away leaves no empty shell behind (knowledge-library.md K17 and K13; P2 review R32): Undo of a
 * created set, a whole-set archive and the archive of the last file in a sub-folder remove the folders they emptied, so the
 * same set can be created again without `adopt`. A category the root guide names, the analytics set's generated folders, the
 * root and anything that still holds a file stay. Hermetic, synthetic, a spaced library path.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHOP_GUIDE, guideWith } from './knowledge-fixtures.testutil.js';
import { ROOT_GUIDE_SEED } from './knowledge-templates.js';
import { makeHarness, type Harness } from './knowledge-write.testutil.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { h.close(); fs.rmSync(h.base, { recursive: true, force: true }); });

/** Stage the card for a research set about bees (no adopt) and return its change id. */
async function stageBees(): Promise<string> {
  const reply = await h.createSet(h.turn('create a research set about bees'), {
    name: 'Bees', kind: 'research', description: 'Notes on the bee project', files: [{ name: 'sources.md', content: '# Sources\n\nA field guide.\n' }],
  });
  expect(reply).toMatchObject({ ok: true, status: 'staged' });
  return String(reply.changeId);
}

async function archiveSet(set: string): Promise<string> {
  const context = h.turn(`archive the ${set} set`);
  const rules = await h.rules(context, set, 'GUIDE.md');
  context.guidesDelivered![set].full = true;
  const reply = await h.writer.write({ set, mode: 'archive', ownerRequested: true, rulesSha256: rules }, context, 'knowledge_write');
  expect(reply).toMatchObject({ status: 'staged', reason: 'set_level' });
  return String(reply.changeId);
}

describe('Undo of a created set', () => {
  it('removes the folders the set made, keeps the category, and the same set can be created again without adopt', async () => {
    expect(await h.writer.apply(await stageBees())).toMatchObject({ ok: true });
    expect(h.exists('research/bees/GUIDE.md')).toBe(true);
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.exists('research/bees')).toBe(false);
    // `research` is a category the root guide names: it stays even though this change made it.
    expect(h.exists('research')).toBe(true);
    expect(await h.writer.apply(await stageBees())).toMatchObject({ ok: true });
    expect(h.read('research/bees/sources.md')).toContain('A field guide');
  });

  it('a Finder .DS_Store does not keep the folder, and a file the owner added does', async () => {
    await h.writer.apply(await stageBees());
    fs.writeFileSync(h.abs('research/bees/.DS_Store'), 'finder');
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.exists('research/bees')).toBe(false);

    await h.writer.apply(await stageBees());
    h.put('research/bees/mine.md', '# Mine\n');
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.read('research/bees/mine.md')).toBe('# Mine\n');
    expect(h.exists('research/bees/GUIDE.md')).toBe(false);
  });
});

describe('archive', () => {
  it('a whole-set archive leaves no empty set folder, a category stays, and Undo brings the set back and clears the archive copy', async () => {
    h.put('scratch/GUIDE.md', guideWith({ name: 'scratch' }, '# Scratch\n\nTemp.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n|---|---|---|---|---|\n| `a.md` | scratch/ | On demand | A | Me |\n\n## Change Methodology\n\n- Keep it short\n\n## Guardrails\n\n- Do NOT store secrets\n\n## Conflict Priority Order\n\nA > B\n'));
    h.put('scratch/a.md', '# A\n');
    h.put('scratch/sub/b.md', '# B\n');
    expect(await h.writer.apply(await archiveSet('scratch'))).toMatchObject({ ok: true });
    expect(h.exists('scratch')).toBe(false);
    expect(fs.readdirSync(h.abs('_archive'))).toHaveLength(1);
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.read('scratch/sub/b.md')).toBe('# B\n');
    expect(h.exists('_archive')).toBe(false);
  });

  it('a category the root guide names stays when its only set is archived', async () => {
    await h.writer.apply(await stageBees());
    expect(await h.writer.apply(await archiveSet('research/bees'))).toMatchObject({ ok: true });
    expect(h.exists('research/bees')).toBe(false);
    expect(h.exists('research')).toBe(true);
  });

  it('archiving the only file of a sub-folder removes that sub-folder, keeps the set, and Undo puts the file back', async () => {
    h.put('shop-data/ref/extra.md', '# Extra\n');
    h.queue({});
    const reply = await h.write(h.turn('please archive ref/extra.md in shop-data'), { set: 'shop-data', file: 'ref/extra.md', mode: 'archive' });
    expect(reply).toMatchObject({ status: 'applied' });
    expect(h.exists('shop-data/ref')).toBe(false);
    expect(h.exists('shop-data/GUIDE.md')).toBe(true);
    expect(h.exists('shop-data/_archive')).toBe(true);
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.read('shop-data/ref/extra.md')).toBe('# Extra\n');
    expect(h.exists('shop-data/_archive')).toBe(false);
  });

  it('a folder that still holds another file is left as it is', async () => {
    h.put('shop-data/ref/extra.md', '# Extra\n');
    h.put('shop-data/ref/other.md', '# Other\n');
    h.queue({});
    expect(await h.write(h.turn('please archive ref/extra.md in shop-data'), { set: 'shop-data', file: 'ref/extra.md', mode: 'archive' })).toMatchObject({ status: 'applied' });
    expect(h.exists('shop-data/ref/other.md')).toBe(true);
  });
});

describe('the analytics set\'s own folders', () => {
  it('archiving the last user preset keeps analytics/presets', async () => {
    const analytics = await makeHarness({ files: { 'GUIDE.md': ROOT_GUIDE_SEED, 'analytics/GUIDE.md': SHOP_GUIDE, 'analytics/presets/mine.md': '# Mine\n\nA preset.\n', 'analytics/manifest.json': JSON.stringify({ files: [{ file: 'presets/mine.md', source: 'user-dropped' }] }) } });
    try {
      analytics.queue({});
      const reply = await analytics.write(analytics.turn('please archive presets/mine.md in analytics'), { set: 'analytics', file: 'presets/mine.md', mode: 'archive' });
      expect(reply, JSON.stringify(reply).slice(0, 400)).toMatchObject({ status: 'applied' });
      expect(analytics.exists('analytics/presets/mine.md')).toBe(false);
      expect(analytics.exists('analytics/presets')).toBe(true);
      expect(analytics.exists('analytics')).toBe(true);
    } finally {
      analytics.close();
      fs.rmSync(analytics.base, { recursive: true, force: true });
    }
  });
});
