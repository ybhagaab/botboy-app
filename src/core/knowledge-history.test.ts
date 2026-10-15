/**
 * History and Undo (knowledge-library.md K13; brief 4.5): the journal is always written and powers Undo; edits made
 * outside BotBoy are found by content hash and recorded as such; an interrupted write is resolved by the next reconcile;
 * a secret is never copied into the store; blobs are pruned; and git, when it works, mirrors the same entries without ever
 * putting a `.git` entry in the folder. The journal works with git absent (a tripwire stand-in that must never run).
 * Synthetic content, a spaced library path, temp folders only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitMirror, resolveGit } from './knowledge-git.js';
import { HISTORY_KEEP_ENTRIES, createKnowledgeHistory, type KnowledgeHistory } from './knowledge-history.js';
import { fakePrivateKeyBlock } from './knowledge-fixtures.testutil.js';
import { sha256Hex } from './knowledge-fs.js';

let base: string;
let root: string;
let dir: string;
let clock: number;
let history: KnowledgeHistory;
const abs = (rel: string) => path.join(root, ...rel.split('/'));
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text); };
const bytes = (text: string | null) => (text === null ? null : Buffer.from(text));
/** What BotBoy's writer does for one change: the history is told after the files are in place. */
async function change(rel: string, before: string | null, after: string | null, summary = `change ${rel}`) {
  if (after === null) fs.rmSync(abs(rel), { force: true }); else write(rel, after);
  return history.record({ actor: 'botboy', kind: 'write', summary, files: [{ path: rel, before: bytes(before), after: bytes(after) }] });
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-hist-')));
  root = path.join(base, 'Docs', 'BotBoy Knowledge');
  dir = path.join(base, 'state', 'knowledge-history');
  fs.mkdirSync(root, { recursive: true });
  clock = 1_800_000_000_000;
  history = createKnowledgeHistory({ dir, root: () => root, now: () => clock });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('recording and reading', () => {
  it('records an entry with hashes, keeps blobs outside the folder, and lists newest first', async () => {
    const created = await change('shop-data/orders.md', null, '# Orders\n\nv1\n', 'create orders');
    clock += 5_000;
    const edited = await change('shop-data/orders.md', '# Orders\n\nv1\n', '# Orders\n\nv2\n', 'edit orders');
    expect(created).toMatchObject({ actor: 'botboy', kind: 'write', files: [{ path: 'shop-data/orders.md', before: null, after: sha256Hex('# Orders\n\nv1\n') }] });
    expect(edited.files[0]).toMatchObject({ before: sha256Hex('# Orders\n\nv1\n'), after: sha256Hex('# Orders\n\nv2\n') });
    expect(history.list().map((entry) => entry.summary)).toEqual(['edit orders', 'create orders']);
    expect(history.get(created.id)).toMatchObject({ summary: 'create orders' });
    expect(history.get('h_nope')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'log.jsonl'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'objects')).sort()).toEqual([sha256Hex('# Orders\n\nv1\n'), sha256Hex('# Orders\n\nv2\n')].sort());
    expect(fs.readdirSync(root).some((name) => name.startsWith('.'))).toBe(false);
  });

  it('shows a per-file diff built from the blobs, and says so when a blob was pruned', async () => {
    await change('shop-data/orders.md', null, '# Orders\n\nv1\n');
    const edited = await change('shop-data/orders.md', '# Orders\n\nv1\n', '# Orders\n\nv2\n');
    const shown = await history.diff(edited.id);
    expect(shown).toHaveLength(1);
    expect(shown?.[0]).toMatchObject({ path: 'shop-data/orders.md', kind: 'changed' });
    expect(shown?.[0].diff?.text).toContain('-v1\n+v2');
    fs.rmSync(path.join(dir, 'objects', sha256Hex('# Orders\n\nv1\n')));
    expect((await history.diff(edited.id))?.[0]).toMatchObject({ diff: null, note: expect.stringContaining('pruned') });
    expect(await history.diff('h_missing')).toBeNull();
  });

  it('keeps notes, overrides and sources on the entry', async () => {
    write('shop-data/orders.md', '# Orders\n');
    const entry = await history.record({
      actor: 'botboy', kind: 'write', summary: 'add', changeId: 'kc_abc123abc123',
      files: [{ path: 'shop-data/orders.md', before: null, after: bytes('# Orders\n') }],
      checkNotes: [{ tier: 'should_fix', rule: 'Do NOT add dates', problem: 'a date appears', fix: 'remove it' }],
      overrode: ['must_fix: Do NOT add dates'], sources: ['email'],
    });
    expect(history.get(entry.id)).toMatchObject({ changeId: 'kc_abc123abc123', checkNotes: [{ tier: 'should_fix' }], overrode: ['must_fix: Do NOT add dates'], sources: ['email'] });
  });
});

describe('Undo', () => {
  it('restores the previous content of an edit and then offers a redo', async () => {
    await change('shop-data/orders.md', null, '# Orders\n\nv1\n');
    await change('shop-data/orders.md', '# Orders\n\nv1\n', '# Orders\n\nv2\n', 'edit');
    const undone = await history.undo();
    expect(undone).toMatchObject({ ok: true, entry: { kind: 'undo', actor: 'owner-via-botboy' } });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toBe('# Orders\n\nv1\n');
    // An Undo is itself an entry, so Undo of it is the redo.
    const redone = await history.undo();
    expect(redone).toMatchObject({ ok: true });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toBe('# Orders\n\nv2\n');
    expect(history.list().map((entry) => entry.kind)).toEqual(['undo', 'undo', 'write', 'write']);
  });

  it('removes a file the change created, and restores a file the change removed', async () => {
    await change('shop-data/new.md', null, '# New\n', 'create');
    expect(await history.undo()).toMatchObject({ ok: true });
    expect(fs.existsSync(abs('shop-data/new.md'))).toBe(false);
    write('shop-data/old.md', '# Old\n');
    await history.reconcile({ force: true });
    await change('shop-data/old.md', '# Old\n', null, 'archive');
    expect(fs.existsSync(abs('shop-data/old.md'))).toBe(false);
    expect(await history.undo()).toMatchObject({ ok: true });
    expect(fs.readFileSync(abs('shop-data/old.md'), 'utf8')).toBe('# Old\n');
  });

  it('says blob_missing, and changes nothing, when the older copy was pruned', async () => {
    await change('shop-data/orders.md', null, '# Orders v1\n');
    await change('shop-data/orders.md', '# Orders v1\n', '# Orders v2\n');
    fs.rmSync(path.join(dir, 'objects', sha256Hex('# Orders v1\n')));
    expect(await history.undo()).toMatchObject({ ok: false, code: 'blob_missing', paths: ['shop-data/orders.md'] });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toBe('# Orders v2\n');
  });

  it('undoes a change that touched two files (content plus its guide) as one entry', async () => {
    write('shop-data/GUIDE.md', '# Guide v1\n');
    write('shop-data/orders.md', '# Orders v1\n');
    await history.reconcile({ force: true });
    write('shop-data/orders.md', '# Orders v2\n');
    write('shop-data/GUIDE.md', '# Guide v2\n');
    await history.record({
      actor: 'botboy', kind: 'write', summary: 'edit with summary refresh',
      files: [
        { path: 'shop-data/orders.md', before: bytes('# Orders v1\n'), after: bytes('# Orders v2\n') },
        { path: 'shop-data/GUIDE.md', before: bytes('# Guide v1\n'), after: bytes('# Guide v2\n') },
      ],
    });
    expect(await history.undo()).toMatchObject({ ok: true });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toBe('# Orders v1\n');
    expect(fs.readFileSync(abs('shop-data/GUIDE.md'), 'utf8')).toBe('# Guide v1\n');
  });

  it('refuses when a touched file changed after the entry (changed_since) and writes nothing', async () => {
    await change('shop-data/orders.md', null, '# Orders\n\nv1\n');
    fs.writeFileSync(abs('shop-data/orders.md'), '# Orders\n\nthe owner kept editing\n');
    const result = await history.undo();
    expect(result).toMatchObject({ ok: false, code: 'changed_since', paths: ['shop-data/orders.md'], nextAction: expect.stringContaining('History') });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toContain('the owner kept editing');
  });

  it('R10: refuses to undo through a folder that was swapped for a link leaving the library, and touches nothing outside', async () => {
    const entry = await change('shop-data/sub/n.md', null, '# n\n');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    // A decoy with the very bytes the change left, so only the containment check can stop the removal.
    fs.writeFileSync(path.join(outside, 'n.md'), '# n\n');
    fs.renameSync(abs('shop-data/sub'), path.join(base, 'moved-away'));
    fs.symlinkSync(outside, abs('shop-data/sub'));
    const result = await history.undo();
    expect(result).toMatchObject({ ok: false, code: 'io_error', message: expect.stringContaining('behind a link'), paths: ['shop-data/sub/n.md'] });
    expect(fs.readFileSync(path.join(outside, 'n.md'), 'utf8')).toBe('# n\n');
    expect(history.list()[0].id).toBe(entry.id);
  });

  it('says there is nothing to undo on an empty history and never undoes an outside edit', async () => {
    expect(await history.undo()).toMatchObject({ ok: false, code: 'nothing_to_undo' });
    write('shop-data/orders.md', '# Orders\n');
    await history.reconcile({ force: true });
    write('shop-data/orders.md', '# Orders edited in Finder\n');
    clock += 5_000;
    await history.reconcile({ force: true });
    expect(history.list()[0]).toMatchObject({ actor: 'outside', kind: 'outside' });
    expect(await history.undo()).toMatchObject({ ok: false, code: 'nothing_to_undo' });
  });

  it('reports a missing library instead of throwing', async () => {
    const lost = createKnowledgeHistory({ dir, root: () => null });
    expect(await lost.undo()).toMatchObject({ ok: false, code: 'root_unavailable' });
  });
});

describe('edits made outside BotBoy', () => {
  it('first sight is a baseline, and a later edit, a new file and a removal are each recorded', async () => {
    write('shop-data/orders.md', '# Orders\n');
    write('shop-data/GUIDE.md', '# Guide\n');
    const first = await history.reconcile({ force: true });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'baseline', files: [], summary: expect.stringContaining('2 files') });

    clock += 10_000;
    write('shop-data/orders.md', '# Orders\n\nchanged in an editor\n');
    write('shop-data/extra.txt', 'a new note\n');
    fs.rmSync(abs('shop-data/GUIDE.md'));
    const second = await history.reconcile({ force: true });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ actor: 'outside', kind: 'outside', summary: expect.stringContaining('Edited outside BotBoy') });
    expect(second[0].files.map((file) => file.path).sort()).toEqual(['shop-data/GUIDE.md', 'shop-data/extra.txt', 'shop-data/orders.md']);
    expect(second[0].files.find((file) => file.path === 'shop-data/GUIDE.md')).toMatchObject({ after: null });
    expect(second[0].files.find((file) => file.path === 'shop-data/extra.txt')).toMatchObject({ before: null });
    // Nothing new on a second look.
    expect(await history.reconcile({ force: true })).toEqual([]);
  });

  it('is debounced for three seconds unless forced, and ignores hidden files, links and other types', async () => {
    write('a/one.md', '# One\n');
    await history.reconcile({ force: true });
    write('a/two.md', '# Two\n');
    expect(await history.reconcile()).toEqual([]);
    clock += 3_500;
    expect((await history.reconcile())[0]).toMatchObject({ kind: 'outside' });
    write('a/.hidden.md', 'hidden\n');
    write('a/data.csv', 'x,y\n');
    fs.symlinkSync(abs('a/one.md'), abs('a/link.md'));
    clock += 5_000;
    expect(await history.reconcile()).toEqual([]);
  });

  it('does not mistake BotBoy\'s own recorded writes for outside edits', async () => {
    write('a/one.md', '# One\n');
    await history.reconcile({ force: true });
    await change('a/one.md', '# One\n', '# One\n\nby BotBoy\n');
    clock += 5_000;
    expect(await history.reconcile({ force: true })).toEqual([]);
  });

  it('classifies files the server\'s own writers produce as generated', async () => {
    const classified = createKnowledgeHistory({ dir, root: () => root, now: () => clock, classify: (rel) => (rel.startsWith('analytics/lessons/') ? 'generated' : 'outside') });
    write('analytics/presets/a.md', '# A\n');
    await classified.reconcile({ force: true });
    write('analytics/lessons/general.md', '# Lessons\n');
    write('notes/mine.md', '# Mine\n');
    clock += 5_000;
    const found = await classified.reconcile({ force: true });
    expect(found.map((entry) => [entry.actor, entry.files.map((file) => file.path)])).toEqual(expect.arrayContaining([
      ['generated', ['analytics/lessons/general.md']],
      ['outside', ['notes/mine.md']],
    ]));
    expect(found.find((entry) => entry.actor === 'generated')?.summary).toMatch(/^Generated by BotBoy/);
  });

  it('never copies a credential into the store: the entry names the kind and the content is not kept', async () => {
    write('notes/a.md', '# A\n');
    await history.reconcile({ force: true });
    clock += 5_000;
    const secretText = `# Notes\n\n${fakePrivateKeyBlock()}\n`;
    write('notes/a.md', secretText);
    const found = await history.reconcile({ force: true });
    expect(found[0].files[0]).toMatchObject({ path: 'notes/a.md', secret: expect.stringMatching(/private key/i) });
    const stored = fs.existsSync(path.join(dir, 'objects')) ? fs.readdirSync(path.join(dir, 'objects')) : [];
    expect(stored).not.toContain(sha256Hex(secretText));
    for (const name of stored) expect(fs.readFileSync(path.join(dir, 'objects', name), 'utf8')).not.toContain('PRIVATE KEY');
    expect((await history.diff(found[0].id))?.[0]).toMatchObject({ diff: null, note: expect.stringContaining('not shown') });
  });
});

describe('an interrupted write', () => {
  it('a crash after the files changed but before the log line is finished as BotBoy\'s entry', async () => {
    write('shop-data/orders.md', '# Orders v1\n');
    await history.reconcile({ force: true });
    await history.begin({ actor: 'botboy', kind: 'write', summary: 'edit orders', changeId: 'kc_aaaaaaaaaaaa', files: [{ path: 'shop-data/orders.md', before: bytes('# Orders v1\n'), after: bytes('# Orders v2\n') }] });
    write('shop-data/orders.md', '# Orders v2\n');
    // The process ended here: a fresh history object reads the intent.
    const next = createKnowledgeHistory({ dir, root: () => root, now: () => clock });
    const found = await next.reconcile({ force: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ actor: 'botboy', kind: 'write', changeId: 'kc_aaaaaaaaaaaa', summary: expect.stringContaining('recovered') });
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(false);
    expect(await next.reconcile({ force: true })).toEqual([]);
  });

  it('a crash before any file changed leaves no entry and no intent', async () => {
    write('shop-data/orders.md', '# Orders v1\n');
    await history.reconcile({ force: true });
    await history.begin({ actor: 'botboy', kind: 'write', summary: 'edit orders', files: [{ path: 'shop-data/orders.md', before: bytes('# Orders v1\n'), after: bytes('# Orders v2\n') }] });
    const next = createKnowledgeHistory({ dir, root: () => root, now: () => clock });
    expect(await next.reconcile({ force: true })).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(false);
    expect(next.list()).toHaveLength(1);
  });
});

describe('a reconcile that overlaps a write of this process (R4)', () => {
  const v1 = '# Orders v1\n';
  const v2 = '# Orders v2\n';
  const files = [{ path: 'shop-data/orders.md', before: bytes(v1), after: bytes(v2) }];

  it('does not judge the folder between begin and record: no outside entry, no recovered entry, and the intent record stays', async () => {
    write('shop-data/orders.md', v1);
    await history.reconcile({ force: true });
    await history.begin({ actor: 'botboy', kind: 'write', summary: 'edit orders', files });
    write('shop-data/orders.md', v2);
    expect(await history.reconcile({ force: true })).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(true);
    await history.record({ actor: 'botboy', kind: 'write', summary: 'edit orders', files });
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(false);
    expect(history.list().map((entry) => entry.kind)).toEqual(['write', 'baseline']);
    expect(await history.reconcile({ force: true })).toEqual([]);
    // record ended the write: an edit made by hand afterwards is found again.
    write('shop-data/orders.md', '# Orders edited by hand\n');
    expect(await history.reconcile({ force: true })).toEqual([expect.objectContaining({ actor: 'outside', kind: 'outside' })]);
  });

  it('leaves the intent record of a write that began while the reconcile was still starting (it is not a leftover of an earlier process)', async () => {
    write('shop-data/orders.md', v1);
    await history.reconcile({ force: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realStat = fs.promises.stat.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(fs.promises, 'stat').mockImplementationOnce((async (...args: unknown[]) => { await gate; return realStat(...args); }) as never);
    try {
      const overlapping = history.reconcile({ force: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await history.begin({ actor: 'botboy', kind: 'write', summary: 'edit orders', files });
      release();
      expect(await overlapping).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(true);
    write('shop-data/orders.md', v2);
    await history.record({ actor: 'botboy', kind: 'write', summary: 'edit orders', files });
    expect(history.list().map((entry) => entry.kind)).toEqual(['write', 'baseline']);
  });

  it('throws away a walk that started before begin and finished during the write (the walk is parked at its first folder read)', async () => {
    write('shop-data/orders.md', v1);
    await history.reconcile({ force: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementationOnce((async (...args: unknown[]) => { await gate; return realReaddir(...args); }) as never);
    try {
      const overlapping = history.reconcile({ force: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await history.begin({ actor: 'botboy', kind: 'write', summary: 'edit orders', files });
      write('shop-data/orders.md', v2);
      release();
      expect(await overlapping).toEqual([]);
    } finally {
      release();
      spy.mockRestore();
    }
    await history.record({ actor: 'botboy', kind: 'write', summary: 'edit orders', files });
    expect(history.list().map((entry) => entry.kind)).toEqual(['write', 'baseline']);
    expect(history.list().some((entry) => /outside|recovered/i.test(entry.summary))).toBe(false);
    expect(await history.reconcile({ force: true })).toEqual([]);
  });

  it('abandon ends the write: with every file restored the intent is dropped, otherwise it stays for the next reconcile, and reconcile works again', async () => {
    write('shop-data/orders.md', v1);
    await history.reconcile({ force: true });
    await history.begin({ actor: 'botboy', kind: 'write', summary: 'edit orders', files });
    await history.abandon({ restored: true });
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(false);
    write('shop-data/orders.md', '# Orders edited by hand\n');
    expect(await history.reconcile({ force: true })).toEqual([expect.objectContaining({ actor: 'outside', kind: 'outside' })]);
    await history.begin({ actor: 'botboy', kind: 'write', summary: 'edit orders again', files: [{ path: 'shop-data/orders.md', before: bytes('# Orders edited by hand\n'), after: bytes(v2) }] });
    await history.abandon({ restored: false });
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(true);
    // Neither before nor after: the next reconcile resolves the leftover intent and records the folder as it is.
    write('shop-data/orders.md', '# Something else\n');
    const found = await history.reconcile({ force: true });
    expect(found.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'intent.json'))).toBe(false);
  });
});

describe('pruning', () => {
  it('keeps the blobs of the newest entries only; the log keeps every line and Undo of the latest still works', async () => {
    let previous: string | null = null;
    for (let index = 0; index < HISTORY_KEEP_ENTRIES + 6; index += 1) {
      const next = `# Orders\n\nversion ${index}\n`;
      await change('shop-data/orders.md', previous, next, `edit ${index}`);
      previous = next;
    }
    expect(history.list({ limit: 500 })).toHaveLength(HISTORY_KEEP_ENTRIES + 6);
    const objects = fs.readdirSync(path.join(dir, 'objects'));
    expect(objects.length).toBeLessThanOrEqual(HISTORY_KEEP_ENTRIES + 2);
    expect(objects).toContain(sha256Hex(previous as string));
    expect(await history.undo()).toMatchObject({ ok: true });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toBe(`# Orders\n\nversion ${HISTORY_KEEP_ENTRIES + 4}\n`);
  }, 60_000);
});

describe('with git as the mirror', () => {
  const REAL_GIT = ['/Library/Developer/CommandLineTools/usr/bin/git', path.join(os.homedir(), 'homebrew', 'bin', 'git'), '/opt/homebrew/bin/git']
    .find((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) ?? null;

  it.skipIf(!REAL_GIT)('mirrors each entry as a commit, with no .git inside the folder, and Undo works the same', async () => {
    const gitDir = path.join(base, 'state', 'knowledge-history.git');
    const mirror = createGitMirror({ gitDir, homeDir: path.join(base, 'state', 'home'), workTree: () => root, resolve: () => ({ path: REAL_GIT, state: 'ready' }) });
    const withGit = createKnowledgeHistory({ dir, root: () => root, git: mirror, now: () => clock });
    write('shop-data/orders.md', '# Orders\n\nv1\n');
    await withGit.record({ actor: 'botboy', kind: 'write', summary: 'create orders', files: [{ path: 'shop-data/orders.md', before: null, after: bytes('# Orders\n\nv1\n') }] });
    write('shop-data/orders.md', '# Orders\n\nv2\n');
    await withGit.record({ actor: 'botboy', kind: 'write', summary: 'edit orders', files: [{ path: 'shop-data/orders.md', before: bytes('# Orders\n\nv1\n'), after: bytes('# Orders\n\nv2\n') }] });
    expect(fs.existsSync(path.join(gitDir, 'HEAD'))).toBe(true);
    expect(fs.readdirSync(root).includes('.git')).toBe(false);
    expect(withGit.gitStatus()).toMatchObject({ state: 'active', notice: null });
    expect(await withGit.undo()).toMatchObject({ ok: true });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toContain('v1');
  });

  it('without a usable git the journal alone does everything, the stand-in is never run, and the owner is told once', async () => {
    const tripwire = path.join(base, 'git');
    const log = path.join(base, 'tripwire.log');
    fs.writeFileSync(tripwire, `#!/bin/sh\necho RAN >> '${log}'\nexit 0\n`, { mode: 0o755 });
    const mirror = createGitMirror({
      gitDir: path.join(base, 'state', 'knowledge-history.git'), homeDir: path.join(base, 'state', 'home'), workTree: () => root,
      resolve: () => resolveGit({ find: () => tripwire, shimTools: new Set([tripwire]), commandLineTools: () => false }),
    });
    const noGit = createKnowledgeHistory({ dir, root: () => root, git: mirror, now: () => clock });
    write('shop-data/orders.md', '# Orders\n\nv1\n');
    await noGit.record({ actor: 'botboy', kind: 'write', summary: 'create', files: [{ path: 'shop-data/orders.md', before: null, after: bytes('# Orders\n\nv1\n') }] });
    write('shop-data/orders.md', '# Orders\n\nv2\n');
    await noGit.record({ actor: 'botboy', kind: 'write', summary: 'edit', files: [{ path: 'shop-data/orders.md', before: bytes('# Orders\n\nv1\n'), after: bytes('# Orders\n\nv2\n') }] });
    expect(fs.existsSync(log)).toBe(false);
    expect(noGit.gitStatus()).toMatchObject({ state: 'degraded', notice: expect.stringContaining('plain copies') });
    expect(await noGit.undo()).toMatchObject({ ok: true });
    expect(fs.readFileSync(abs('shop-data/orders.md'), 'utf8')).toContain('v1');
    expect(fs.existsSync(path.join(base, 'state', 'knowledge-history.git'))).toBe(false);
  });
});

describe('the baseline entry wording', () => {
  it('says "was" for one file and "were" for several, in the first entry of a folder that already holds files', async () => {
    write('shop-data/orders.md', '# Orders\n');
    const one = await history.reconcile({ force: true });
    expect(one[0]).toMatchObject({ kind: 'baseline', summary: '1 file was in the folder when history started' });
  });

  it('says "were" for several files', async () => {
    write('shop-data/orders.md', '# Orders\n');
    write('shop-data/GUIDE.md', '# Guide\n');
    const two = await history.reconcile({ force: true });
    expect(two[0]).toMatchObject({ kind: 'baseline', summary: '2 files were in the folder when history started' });
  });
});
