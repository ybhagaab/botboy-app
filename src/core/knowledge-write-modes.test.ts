/**
 * Every mode of the composite write, the gates that stop a write before any model call (path, type, size, generated file,
 * read-only set, unguided set, links, secrets), imports, moves, archives, whole-set changes and creating a set
 * (knowledge-library.md K17). Hermetic, synthetic, a spaced library path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakePrivateKeyBlock, guideWith } from './knowledge-fixtures.testutil.js';
import { parseGuide } from './knowledge-guide.js';
import { makeHarness, type Harness } from './knowledge-write.testutil.js';
import { writeFileMaxChars } from './limits.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { h.close(); fs.rmSync(h.base, { recursive: true, force: true }); });

const MSG = 'please update shop-data';
const turn = () => h.turn(MSG);
const no = (reply: { ok: boolean; effect: string }) => { expect(reply.ok).toBe(false); expect(reply.effect).toBe('none'); };

describe('create, append, edit, replace', () => {
  it('R8: a change that alters nothing is refused before any check call, card or History entry', async () => {
    const same = h.read('shop-data/orders.md');
    const edit = await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.' }] });
    expect(edit).toMatchObject({ ok: false, code: 'no_change', effect: 'none', message: expect.stringContaining('exactly as it is') });
    const sha = (await import('node:crypto')).createHash('sha256').update(same).digest('hex');
    const replace = await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'replace', content: same, baseSha256: sha });
    expect(replace).toMatchObject({ ok: false, code: 'no_change', effect: 'none' });
    expect(h.llmCalls).toHaveLength(0);
    expect(h.changes.list({ statuses: ['staged', 'held', 'revising', 'applied'] })).toHaveLength(0);
    expect(h.history.list().some((entry) => entry.kind === 'write')).toBe(false);
    expect(h.read('shop-data/orders.md')).toBe(same);
  });

  it('create adds the file, a table row and a TOC section (the purpose and bullets come from the check)', async () => {
    h.queue({ summaryUpdate: { purpose: 'Returns and refund rules', bullets: ['Return reasons', 'Refund windows'] } });
    const reply = await h.write(turn(), { set: 'shop-data', file: 'returns.md', mode: 'create', content: '# Returns\n\nWindows are set per market.\n' });
    expect(reply).toMatchObject({ status: 'applied', files: ['shop-data/returns.md', 'shop-data/GUIDE.md'] });
    const guide = parseGuide(h.read('shop-data/GUIDE.md'));
    expect(guide.rows.find((row) => row.file === 'returns.md')).toMatchObject({ purpose: 'Returns and refund rules', mechanism: 'On demand' });
    expect(guide.toc.find((entry) => entry.file === 'returns.md')?.bullets).toEqual(['Return reasons', 'Refund windows']);
    expect(h.history.list()[0].files).toHaveLength(2);
  });

  it('create falls back to the file\'s first heading when the check gave no summary, and refuses an existing name', async () => {
    h.queue({});
    expect(await h.write(turn(), { set: 'shop-data', file: 'loyalty.md', mode: 'create', content: '# Loyalty tiers\n\nThree tiers.\n' })).toMatchObject({ status: 'applied' });
    expect(parseGuide(h.read('shop-data/GUIDE.md')).rows.find((row) => row.file === 'loyalty.md')?.purpose).toBe('Loyalty tiers');
    const again = await h.write(turn(), { set: 'shop-data', file: 'loyalty.md', mode: 'create', content: '# x\n' });
    expect(again).toMatchObject({ code: 'exists', effect: 'none' });
    expect(await h.write(turn(), { set: 'shop-data', file: 'LOYALTY.md', mode: 'create', content: '# x\n' })).toMatchObject({ code: 'exists' });
  });

  it('append adds to the end (a missing file becomes a create), and edit with a missing or repeated find says what to do', async () => {
    h.queue({});
    expect(await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'append', content: '- A new line at the end.' })).toMatchObject({ status: 'applied' });
    expect(h.read('shop-data/orders.md')).toMatch(/channel\.\n- A new line at the end\.$/);
    h.queue({});
    expect(await h.write(turn(), { set: 'shop-data', file: 'fresh.md', mode: 'append', content: '# Fresh\n\nFirst part.\n' })).toMatchObject({ status: 'applied' });
    expect(parseGuide(h.read('shop-data/GUIDE.md')).rows.map((row) => row.file)).toContain('fresh.md');
    const missing = await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: 'text that is not there', replace: 'x' }] });
    expect(missing).toMatchObject({ code: 'edit_not_found', effect: 'none', nextAction: expect.stringContaining('knowledge_load') });
    const twice = await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: 'e', replace: 'E' }] });
    expect(twice).toMatchObject({ code: 'edit_not_unique' });
    expect(await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [] })).toMatchObject({ code: 'invalid_arguments' });
    expect(await h.write(turn(), { set: 'shop-data', file: 'nothing.md', mode: 'edit', edits: [{ find: 'a', replace: 'b' }] })).toMatchObject({ code: 'file_not_found' });
  });

  it('edits keep the file\'s CRLF line endings and BOM', async () => {
    h.put('shop-data/crlf.md', '\uFEFF# Crlf\r\n\r\nline one\r\nline two\r\n');
    h.queue({});
    const reply = await h.write(turn(), { set: 'shop-data', file: 'crlf.md', mode: 'edit', edits: [{ find: 'line one', replace: 'line 1\nline 1b' }] });
    expect(reply).toMatchObject({ status: 'applied' });
    expect(fs.readFileSync(h.abs('shop-data/crlf.md'), 'utf8')).toBe('\uFEFF# Crlf\r\n\r\nline 1\r\nline 1b\r\nline two\r\n');
  });

  it('replace needs the base hash of the last load, and refuses a stale one', async () => {
    const base = (await import('node:crypto')).createHash('sha256').update(h.read('shop-data/orders_analysis.md')).digest('hex');
    const stale = await h.write(turn(), { set: 'shop-data', file: 'orders_analysis.md', mode: 'replace', content: '# New\n', baseSha256: 'a'.repeat(64) });
    expect(stale).toMatchObject({ code: 'stale_base', effect: 'none', nextAction: expect.stringContaining('knowledge_load') });
    expect(await h.write(turn(), { set: 'shop-data', file: 'orders_analysis.md', mode: 'replace', content: '# New\n' })).toMatchObject({ code: 'stale_base' });
    h.queue({});
    expect(await h.write(turn(), { set: 'shop-data', file: 'orders_analysis.md', mode: 'replace', content: '# New analysis\n\nWhole new text.\n', baseSha256: base })).toMatchObject({ status: 'applied' });
    expect(h.read('shop-data/orders_analysis.md')).toBe('# New analysis\n\nWhole new text.\n');
  });

  it('content over the per-call limit is refused with append as the way out', async () => {
    const reply = await h.write(turn(), { set: 'shop-data', file: 'big.md', mode: 'create', content: `# Big\n${'x'.repeat(writeFileMaxChars() + 10)}` });
    expect(reply).toMatchObject({ code: 'result_too_large', nextAction: expect.stringContaining('append') });
    expect(h.exists('shop-data/big.md')).toBe(false);
  });
});

describe('the gates, before any model call', () => {
  it.each([
    ['a parent path', '../outside.md'], ['a deeper parent path', 'a/../../outside.md'], ['an absolute path', '/etc/passwd'], ['a home path', '~/notes.md'],
    ['a backslash', 'a\\b.md'], ['a hidden file', '.secret.md'], ['a hidden folder', '.git/config.md'], ['an empty part', 'a//b.md'], ['four sub-folders', 'a/b/c/d/e.md'],
    ['a long part', `${'x'.repeat(81)}.md`], ['a NUL byte', 'a\u0000b.md'],
  ])('%s is invalid_path', async (_label, file) => {
    const reply = await h.write(turn(), { set: 'shop-data', file, mode: 'create', content: '# x\n' });
    no(reply);
    expect(reply.code).toBe('invalid_path');
    expect(h.llmCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(h.base, 'Docs', 'outside.md'))).toBe(false);
  });

  it.each([['yaml', 'data.yaml'], ['sql', 'query.sql'], ['csv', 'data.csv'], ['no extension', 'README'], ['json without a declaration', 'data.json']])('a %s file is unsupported_type', async (_label, file) => {
    no(await h.write(turn(), { set: 'shop-data', file, mode: 'create', content: 'x' }));
    const reply = await h.write(turn(), { set: 'shop-data', file, mode: 'create', content: 'x' });
    expect(reply.code).toBe('unsupported_type');
  });

  it('json is writable only where the guide declares it, and must parse', async () => {
    h.put('shop-data/GUIDE.md', guideWith({ name: 'shop-data', writeTypes: 'json' }, fs.readFileSync(h.abs('shop-data/GUIDE.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '')));
    expect(await h.write(turn(), { set: 'shop-data', file: 'config.json', mode: 'create', content: '{ not json' })).toMatchObject({ code: 'invalid_json' });
    h.queue({});
    expect(await h.write(turn(), { set: 'shop-data', file: 'config.json', mode: 'create', content: '{"a": 1}' })).toMatchObject({ status: 'applied' });
  });

  it('an unknown set, a set named with traversal, and a root-level file are refused', async () => {
    const context = turn();
    expect(await h.writer.write({ set: 'nope', file: 'a.md', mode: 'create', content: 'x', ownerRequested: true, rulesSha256: 'a'.repeat(16) }, context, 'knowledge_write')).toMatchObject({ code: 'set_not_found', effect: 'none' });
    expect(await h.writer.write({ set: '../..', file: 'a.md', mode: 'create', content: 'x', ownerRequested: true, rulesSha256: 'a'.repeat(16) }, context, 'knowledge_write')).toMatchObject({ code: 'set_not_found' });
    expect(await h.writer.write({ set: 'x'.repeat(121), file: 'a.md', mode: 'create', content: 'x', ownerRequested: true, rulesSha256: 'a'.repeat(16) }, context, 'knowledge_write')).toMatchObject({ code: 'invalid_arguments' });
    const rules = await h.rules(context, '/', 'GUIDE.md');
    expect(await h.writer.write({ set: '/', file: 'notes.md', mode: 'create', content: 'x', ownerRequested: true, rulesSha256: rules }, context, 'knowledge_write')).toMatchObject({ code: 'invalid_path', message: expect.stringContaining('only its GUIDE.md') });
  });

  it('a mode that is not one of the seven, and a missing file, are invalid_arguments', async () => {
    expect(await h.write(turn(), { set: 'shop-data', file: 'a.md', mode: 'delete' })).toMatchObject({ code: 'invalid_arguments' });
    expect(await h.write(turn(), { set: 'shop-data', mode: 'create', content: 'x' })).toMatchObject({ code: 'invalid_arguments' });
  });

  it('a read-only set (writable: no) and an unguided set refuse writes, with the way out, before any receipt or model call', async () => {
    h.put('shop-data/GUIDE.md', fs.readFileSync(h.abs('shop-data/GUIDE.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '').replace(/^/, '---\nname: shop-data\nwritable: no\n---\n'));
    const args = { set: 'shop-data', file: 'orders.md', mode: 'append', content: 'x', ownerRequested: true, rulesSha256: 'a'.repeat(16) };
    expect(await h.writer.write(args, turn(), 'knowledge_write')).toMatchObject({ code: 'read_only_set', effect: 'none', nextAction: expect.stringContaining('writable: yes') });
    expect(await h.writer.write({ ...args, why: 'w', trigger: 'other' }, turn(), 'knowledge_propose')).toMatchObject({ code: 'read_only_set' });
    h.put('notes/idea.md', '# An idea\n');
    expect(await h.writer.write({ ...args, set: 'notes', file: 'idea.md' }, turn(), 'knowledge_write')).toMatchObject({ code: 'guide_required', nextAction: expect.stringContaining('knowledge_create_set') });
    expect(h.llmCalls).toHaveLength(0);
  });

  it('a link is never written: a final component that is a link, or a folder that is a link out of the set', async () => {
    const outside = path.join(h.base, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'target.md'), '# Outside\n');
    fs.symlinkSync(path.join(outside, 'target.md'), h.abs('shop-data/linked.md'));
    fs.symlinkSync(outside, h.abs('shop-data/escape'));
    h.library.invalidate();
    expect(await h.write(turn(), { set: 'shop-data', file: 'linked.md', mode: 'append', content: 'x' })).toMatchObject({ code: 'invalid_path' });
    expect(await h.write(turn(), { set: 'shop-data', file: 'escape/new.md', mode: 'create', content: 'x' })).toMatchObject({ code: 'invalid_path' });
    expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'target.md'), 'utf8')).toBe('# Outside\n');
  });

  it('a secret format in the candidate is a fixable must_fix made by code, never sent to the model, and never written', async () => {
    const reply = await h.write(turn(), { set: 'shop-data', file: 'creds.md', mode: 'create', content: `# Notes\n\n${fakePrivateKeyBlock()}\n` });
    expect(reply).toMatchObject({ status: 'needs_changes', items: [{ tier: 'must_fix', rule: expect.stringContaining('secret formats'), fix: expect.stringContaining('Remove the credential') }] });
    expect(JSON.stringify(reply)).not.toContain('MIIEow');
    expect(h.llmCalls).toHaveLength(0);
    expect(h.exists('shop-data/creds.md')).toBe(false);
  });

  it('files that are generated (lessons, manifest, etl-derived presets) are refused with the right route', async () => {
    const analytics = await makeHarness({ files: { 'GUIDE.md': fs.readFileSync(h.abs('GUIDE.md'), 'utf8'), 'analytics/GUIDE.md': fs.readFileSync(h.abs('shop-data/GUIDE.md'), 'utf8'), 'analytics/presets/shopwave.md': '# Shopwave preset\n', 'analytics/lessons/general.md': '# Lessons\n', 'analytics/notes-on-events.md': '# My notes\n', 'analytics/manifest.json': JSON.stringify({ files: [{ file: 'presets/shopwave.md', business: 'shopwave', source: 'etl-derived' }] }) } });
    try {
      const context = analytics.turn(MSG);
      const rules = await analytics.rules(context, 'analytics', 'notes-on-events.md');
      context.guidesDelivered!.analytics.full = true;
      for (const file of ['lessons/general.md', 'manifest.json', 'presets/shopwave.md']) {
        const reply = await analytics.writer.write({ set: 'analytics', file, mode: 'append', content: 'x', ownerRequested: true, rulesSha256: rules }, context, 'knowledge_write');
        expect(reply, file).toMatchObject({ code: 'generated_file', effect: 'none', nextAction: expect.stringContaining('propose_lesson') });
      }
      analytics.queue({});
      expect(await analytics.writer.write({ set: 'analytics', file: 'notes-on-events.md', mode: 'append', content: '- more', ownerRequested: true, rulesSha256: rules }, analytics.turn('append to analytics notes-on-events.md'), 'knowledge_write')).toMatchObject({ code: 'guide_not_read' });
    } finally {
      analytics.close();
      fs.rmSync(analytics.base, { recursive: true, force: true });
    }
  });

  it('a result over 4 MB is refused before the check (discovery would silently drop such a file)', async () => {
    h.put('shop-data/huge.md', `# Huge\n${'x'.repeat(4 * 1024 * 1024 - 100)}`);
    const reply = await h.write(turn(), { set: 'shop-data', file: 'huge.md', mode: 'append', content: 'y'.repeat(500) });
    expect(reply).toMatchObject({ code: 'result_too_large', effect: 'none', nextAction: expect.stringContaining('4 MB') });
    expect(h.llmCalls).toHaveLength(0);
    expect(fs.statSync(h.abs('shop-data/huge.md')).size).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('import (the server copies the bytes; the model never carries them)', () => {
  let source: string;
  beforeEach(() => {
    source = path.join(h.home, '.personal-productivity-tracker', 'files');
    fs.mkdirSync(source, { recursive: true });
  });

  it('imports a file from the files workspace by relative name, adds its row, and is a card unless the owner named the source', async () => {
    fs.writeFileSync(path.join(source, 'weekly-report.md'), '# Weekly report\n\nSynthetic numbers.\n');
    h.queue({});
    const named = await h.write(h.turn('please import weekly-report.md into shop-data'), { set: 'shop-data', file: 'weekly.md', mode: 'import', from: 'weekly-report.md' });
    expect(named).toMatchObject({ status: 'applied' });
    expect(h.read('shop-data/weekly.md')).toBe('# Weekly report\n\nSynthetic numbers.\n');
    expect(parseGuide(h.read('shop-data/GUIDE.md')).rows.map((row) => row.file)).toContain('weekly.md');
    h.queue({});
    const unnamed = await h.write(h.turn('please add the report to shop-data'), { set: 'shop-data', file: 'weekly2.md', mode: 'import', from: 'weekly-report.md' });
    expect(unnamed).toMatchObject({ status: 'applied' });
  });

  it('refuses a source in BotBoy private state, a sensitive file, a credential, the library itself, a link out, ".." and a missing file', async () => {
    const priv = path.join(h.home, '.personal-productivity-tracker', 'tracker.db');
    fs.writeFileSync(priv, 'private');
    fs.writeFileSync(path.join(h.home, '.env'), 'TOKEN=abc\n');
    fs.writeFileSync(path.join(source, 'creds.md'), `# Notes\n${fakePrivateKeyBlock()}\n`);
    const cases: Array<[string, unknown]> = [[priv, 'import_source_denied'], [path.join(h.home, '.env'), 'import_source_denied'], ['creds.md', 'secret_in_content'], [h.abs('shop-data/orders.md'), 'import_source_denied'], ['../escape.md', 'import_source_denied'], ['missing.md', 'import_source_denied']];
    for (const [from, code] of cases) {
      const reply = await h.write(turn(), { set: 'shop-data', file: `i-${path.basename(from)}.md`, mode: 'import', from });
      expect(reply, String(from)).toMatchObject({ code, effect: 'none' });
    }
    expect(await h.write(turn(), { set: 'shop-data', file: 'x.md', mode: 'import' })).toMatchObject({ code: 'import_source_denied' });
    expect(h.llmCalls).toHaveLength(0);
  });

  it('a pinned source that changed after staging makes the apply stale instead of copying other bytes', async () => {
    fs.writeFileSync(path.join(source, 'weekly-report.md'), '# Weekly report\n\nv1\n');
    const reply = await h.write(h.turn('add the report to shop-data'), { set: 'shop-data', file: 'weekly.md', mode: 'import', from: 'weekly-report.md', stageAsIs: true });
    expect(reply).toMatchObject({ status: 'staged' });
    fs.writeFileSync(path.join(source, 'weekly-report.md'), '# Weekly report\n\nv2 (changed)\n');
    const applied = await h.writer.apply(String(reply.changeId));
    expect(applied).toMatchObject({ ok: false, code: 'stale_base' });
    expect(h.exists('shop-data/weekly.md')).toBe(false);
  });
});

describe('move and archive (there is no delete: a file leaves a set by being archived, and real deletion is the owner\'s)', () => {
  it('move renames a file, rewrites its table row and TOC heading, and Undo puts everything back', async () => {
    h.queue({});
    const reply = await h.write(h.turn('please rename orders.md in shop-data'), { set: 'shop-data', file: 'orders.md', mode: 'move', toFile: 'orders-core.md' });
    expect(reply).toMatchObject({ status: 'applied' });
    expect(h.exists('shop-data/orders.md')).toBe(false);
    expect(h.read('shop-data/orders-core.md')).toContain('Version one of the context file.');
    const guide = parseGuide(h.read('shop-data/GUIDE.md'));
    expect(guide.rows.map((row) => row.file)).toContain('orders-core.md');
    expect(guide.rows.map((row) => row.file)).not.toContain('orders.md');
    expect(guide.toc.map((entry) => entry.file)).toContain('orders-core.md');
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.exists('shop-data/orders.md')).toBe(true);
    expect(h.exists('shop-data/orders-core.md')).toBe(false);
    expect(parseGuide(h.read('shop-data/GUIDE.md')).rows.map((row) => row.file)).toContain('orders.md');
  });

  it('move refuses an existing target and a bad target name', async () => {
    expect(await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'move', toFile: 'orders_analysis.md' })).toMatchObject({ code: 'exists' });
    expect(await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'move', toFile: '../orders.md' })).toMatchObject({ code: 'invalid_path' });
    expect(await h.write(turn(), { set: 'shop-data', file: 'orders.md', mode: 'move' })).toMatchObject({ code: 'invalid_path' });
  });

  it('a move to another set edits both guides and needs the rules of both sets', async () => {
    h.put('notes/GUIDE.md', guideWith({ name: 'notes' }, '# Notes\n\nPersonal notes.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n|---|---|---|---|---|\n| `idea.md` | notes/ | On demand | An idea | Me |\n\n## Change Methodology\n\n- Keep it short\n\n## Guardrails\n\n- Do NOT store secrets\n\n## Conflict Priority Order\n\nA > B\n'));
    h.put('notes/idea.md', '# An idea\n');
    const context = h.turn('move orders_analysis.md from shop-data to notes');
    // Only the source set's rules were handed over: the destination set's are delivered by the answer, not assumed.
    const shopRules = await h.rules(context, 'shop-data', 'orders_analysis.md');
    context.guidesDelivered!['shop-data'].full = true;
    const args = { set: 'shop-data', file: 'orders_analysis.md', mode: 'move', toFile: 'analysis.md', toSet: 'notes', ownerRequested: true, rulesSha256: shopRules };
    const first = await h.writer.write(args, context, 'knowledge_write');
    expect(first).toMatchObject({ code: 'guide_not_read', reason: 'not_delivered' });
    expect(String(first.rules)).toContain('set="notes"');
    expect(context.guidesDelivered?.notes).toMatchObject({ full: true });
    h.queue({});
    const second = await h.writer.write(args, context, 'knowledge_write');
    expect(second, JSON.stringify(second).slice(0, 600)).toMatchObject({ status: 'applied' });
    expect(h.exists('shop-data/orders_analysis.md')).toBe(false);
    expect(h.read('notes/analysis.md')).toContain('Methodology only.');
    expect(parseGuide(h.read('shop-data/GUIDE.md')).rows.map((row) => row.file)).not.toContain('orders_analysis.md');
    expect(parseGuide(h.read('notes/GUIDE.md')).rows.map((row) => row.file)).toEqual(['idea.md', 'analysis.md']);
    expect(h.history.list()[0].files.map((file) => file.path).sort()).toEqual(['notes/GUIDE.md', 'notes/analysis.md', 'shop-data/GUIDE.md', 'shop-data/orders_analysis.md']);
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.exists('shop-data/orders_analysis.md')).toBe(true);
    expect(h.exists('notes/analysis.md')).toBe(false);
  });

  it('archive moves a file to the set\'s _archive, drops its row and TOC, and discovery then skips it', async () => {
    h.queue({});
    const reply = await h.write(h.turn('please archive orders_analysis.md in shop-data'), { set: 'shop-data', file: 'orders_analysis.md', mode: 'archive' });
    expect(reply).toMatchObject({ status: 'applied' });
    expect(h.exists('shop-data/orders_analysis.md')).toBe(false);
    expect(h.read('shop-data/_archive/orders_analysis.md')).toContain('Methodology only.');
    const guide = parseGuide(h.read('shop-data/GUIDE.md'));
    expect(guide.rows.map((row) => row.file)).not.toContain('orders_analysis.md');
    expect(guide.toc.map((entry) => entry.file)).not.toContain('orders_analysis.md');
    const detail = await h.library.getSet('shop-data');
    expect('files' in detail && detail.files.map((file) => file.name)).not.toContain('_archive/orders_analysis.md');
    expect('archived' in detail && detail.archived).toBe(1);
  });

  it('archiving the same name twice keeps both copies', async () => {
    h.queue({}, {});
    await h.write(h.turn('archive orders_analysis.md in shop-data'), { set: 'shop-data', file: 'orders_analysis.md', mode: 'archive' });
    h.put('shop-data/orders_analysis.md', '# Analysis again\n');
    await h.write(h.turn('archive orders_analysis.md in shop-data'), { set: 'shop-data', file: 'orders_analysis.md', mode: 'archive' });
    expect(fs.readdirSync(h.abs('shop-data/_archive')).sort()).toEqual(['orders_analysis-2.md', 'orders_analysis.md']);
  });

  it('a whole set is archived or moved only as a card, and applies on the owner\'s click as files moved, with Undo', async () => {
    h.put('scratch/GUIDE.md', guideWith({ name: 'scratch' }, '# Scratch\n\nTemp.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n|---|---|---|---|---|\n| `a.md` | scratch/ | On demand | A | Me |\n\n## Change Methodology\n\n- Keep it short\n\n## Guardrails\n\n- Do NOT store secrets\n\n## Conflict Priority Order\n\nA > B\n'));
    h.put('scratch/a.md', '# A\n');
    const context = h.turn('archive the scratch set');
    const rules = await h.rules(context, 'scratch', 'GUIDE.md');
    context.guidesDelivered!.scratch.full = true;
    const reply = await h.writer.write({ set: 'scratch', mode: 'archive', ownerRequested: true, rulesSha256: rules }, context, 'knowledge_write');
    expect(reply).toMatchObject({ status: 'staged', reason: 'set_level' });
    expect(h.exists('scratch/a.md')).toBe(true);
    const applied = await h.writer.apply(String(reply.changeId));
    expect(applied).toMatchObject({ ok: true });
    expect(h.exists('scratch/a.md')).toBe(false);
    const archived = fs.readdirSync(h.abs('_archive'));
    expect(archived).toHaveLength(1);
    expect(fs.readFileSync(path.join(h.abs('_archive'), archived[0], 'a.md'), 'utf8')).toBe('# A\n');
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.read('scratch/a.md')).toBe('# A\n');
  });

  it('the built-in analytics set cannot be moved or archived as a whole', async () => {
    const analytics = await makeHarness({ files: { 'GUIDE.md': fs.readFileSync(h.abs('GUIDE.md'), 'utf8'), 'analytics/GUIDE.md': fs.readFileSync(h.abs('shop-data/GUIDE.md'), 'utf8'), 'analytics/presets/a.md': '# A\n' } });
    try {
      const context = analytics.turn('archive analytics');
      const rules = await analytics.rules(context, 'analytics', 'GUIDE.md');
      context.guidesDelivered!.analytics.full = true;
      expect(await analytics.writer.write({ set: 'analytics', mode: 'archive', ownerRequested: true, rulesSha256: rules }, context, 'knowledge_write')).toMatchObject({ code: 'generated_file' });
    } finally {
      analytics.close();
      fs.rmSync(analytics.base, { recursive: true, force: true });
    }
  });
});

describe('creating a set (always a card)', () => {
  it('R12: the generated folders of the analytics set cannot become sets, also with adopt', async () => {
    const context = h.turn('create a set about presets');
    for (const args of [
      { name: 'Presets', kind: 'analytics', description: 'x' },
      { name: 'Presets', kind: 'analytics', description: 'x', adopt: true },
      { name: 'lessons', kind: 'generic', description: 'x', category: 'analytics' },
      { name: 'Sub', kind: 'generic', description: 'x', category: 'analytics/presets', addCategory: true },
    ]) {
      expect(await h.createSet(context, args), JSON.stringify(args)).toMatchObject({ ok: false, code: 'reserved_name', effect: 'none' });
    }
    expect(h.exists('analytics/presets/GUIDE.md')).toBe(false);
    expect(h.changes.list({ statuses: ['staged', 'held', 'revising'] })).toHaveLength(0);
  });

  it('R13: a changeId with anything around it is rejected as an argument on both tools', async () => {
    const context = h.turn(MSG);
    expect(await h.write(context, { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: 'Version one', replace: 'Version two' }], changeId: 'xxkc_000000000000yy' })).toMatchObject({ code: 'invalid_arguments' });
    expect(await h.createSet(context, { name: 'Bees', kind: 'research', description: 'Bees', changeId: 'xxkc_000000000000yy' })).toMatchObject({ code: 'invalid_arguments', effect: 'none' });
  });

  it('drafts a guide from the closest template and the files, stages one card, and creates folder, files and guide on the click', async () => {
    const context = h.turn('create a research set about bees with a first note');
    const reply = await h.createSet(context, {
      name: 'Bees', kind: 'research', description: 'Notes on the bee project', keywords: ['bees', 'hive'],
      files: [{ name: 'sources.md', content: '# Sources\n\nA field guide, 2019.\n' }],
    });
    expect(reply).toMatchObject({ ok: true, status: 'staged', effect: 'staged', reason: 'create_set' });
    expect(h.exists('research/bees/GUIDE.md')).toBe(false);
    const change = h.changes.get(String(reply.changeId));
    expect(change).toMatchObject({ kind: 'create_set', status: 'staged', setName: 'research/bees' });
    expect(change?.plan?.files.map((file) => file.path)).toEqual(['research/bees/sources.md', 'research/bees/GUIDE.md']);
    expect(h.llmCalls.length).toBe(2);
    const applied = await h.writer.apply(String(reply.changeId));
    expect(applied).toMatchObject({ ok: true });
    expect(h.read('research/bees/sources.md')).toContain('A field guide');
    const guide = parseGuide(h.read('research/bees/GUIDE.md'));
    expect(guide.frontMatter).toMatchObject({ name: 'Bees', kind: 'research', keywords: ['bees', 'hive'] });
    expect(guide.rows.map((row) => row.file)).toEqual(['sources.md']);
    expect(h.history.list()[0]).toMatchObject({ kind: 'create_set' });
    const status = await h.library.getSet('research/bees');
    expect('hasGuide' in status && status.hasGuide).toBe(true);
    expect(await h.writer.undo()).toMatchObject({ ok: true });
    expect(h.exists('research/bees/GUIDE.md')).toBe(false);
  });

  it('needs the owner live turn and the root rules; an unknown category needs addCategory, which edits the root guide in the same card', async () => {
    const context = h.turn('make a recipes set');
    expect(await h.writer.createSet({ name: 'Recipes', kind: 'generic', description: 'Cooking', ownerRequested: true }, context)).toMatchObject({ code: 'guide_not_read', reason: 'missing' });
    expect(await h.writer.createSet({ name: 'Recipes', kind: 'generic', description: 'Cooking' }, context)).toMatchObject({ code: 'owner_request_required' });
    expect(await h.writer.createSet({ name: 'Recipes', kind: 'generic', description: 'Cooking', ownerRequested: true }, h.turn('x', { callerKind: 'continuation' }))).toMatchObject({ code: 'owner_turn_required' });
    expect(await h.createSet(context, { name: 'Recipes', kind: 'generic', description: 'Cooking', category: 'kitchen' })).toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('not a category') });
    const reply = await h.createSet(context, { name: 'Recipes', kind: 'generic', description: 'Cooking notes', category: 'kitchen', addCategory: true, files: [{ name: 'soups.md', content: '# Soups\n\nStock first.\n' }] });
    expect(reply).toMatchObject({ status: 'staged' });
    expect(h.changes.get(String(reply.changeId))?.plan?.files.map((file) => file.path)).toContain('GUIDE.md');
    await h.writer.apply(String(reply.changeId));
    expect(parseGuide(h.read('GUIDE.md')).categories.map((category) => category.folder)).toContain('kitchen');
    expect(h.exists('kitchen/recipes/GUIDE.md')).toBe(true);
  });

  it('refuses an existing set, adopts an unguided folder with a drafted guide, and refuses adopt on a missing one', async () => {
    const context = h.turn('make a shop-data set');
    expect(await h.createSet(context, { name: 'shop-data', kind: 'generic', description: 'again' })).toMatchObject({ code: 'exists', effect: 'none' });
    h.put('notes/idea.md', '# An idea\n\nAbout bees.\n');
    h.put('notes/plan.md', '# A plan\n');
    const adopt = await h.createSet(context, { name: 'notes', kind: 'generic', description: 'Personal notes', adopt: true });
    expect(adopt).toMatchObject({ status: 'staged' });
    expect(h.changes.get(String(adopt.changeId))?.plan?.files.map((file) => file.path)).toEqual(['notes/GUIDE.md']);
    expect(await h.createSet(context, { name: 'ghost', kind: 'generic', description: 'x', adopt: true })).toMatchObject({ code: 'set_not_found' });
  });

  it('no model means draft_unavailable: nothing is created and the owner can write GUIDE.md in Finder', async () => {
    h.setClient(null);
    const reply = await h.createSet(h.turn('create a set about bees'), { name: 'Bees', kind: 'research', description: 'Bees' });
    expect(reply).toMatchObject({ code: 'draft_unavailable', effect: 'none', nextAction: expect.stringContaining('GUIDE.md in Finder') });
    expect(h.exists('research/bees')).toBe(false);
  });

  it('a draft the model gets wrong (a file missing from the table) is refused and nothing is created', async () => {
    h.draftGuide = () => '# Bees — Steering Guide\n\nA guide.\n\n## File Ecosystem\n\n| File | Path | Loading Mechanism | Purpose | Audience |\n|---|---|---|---|---|\n| `other.md` | | On demand | x | y |\n\n## Change Methodology\n\n- Short\n\n## Guardrails\n\n- Do NOT x\n\n## Conflict Priority Order\n\nA > B\n\n## File TOC Summaries\n\n### other.md\n- x\n';
    const reply = await h.createSet(h.turn('create a set about bees'), { name: 'Bees', kind: 'research', description: 'Bees', files: [{ name: 'sources.md', content: '# Sources\n' }] });
    expect(reply).toMatchObject({ code: 'draft_unavailable', effect: 'none', message: expect.stringContaining('does not list sources.md') });
  });

  it('a credential in an initial file is a fixable must_fix and never reaches the model or the folder', async () => {
    const reply = await h.createSet(h.turn('create a set about bees'), { name: 'Bees', kind: 'research', description: 'Bees', files: [{ name: 'keys.md', content: `# Keys\n${fakePrivateKeyBlock()}\n` }] });
    expect(reply).toMatchObject({ status: 'needs_changes' });
    expect(h.exists('research/bees')).toBe(false);
  });
});
