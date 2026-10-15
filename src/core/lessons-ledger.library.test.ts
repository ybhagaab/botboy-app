/**
 * Lesson projections when the analytics knowledge lives in the Knowledge library (knowledge-library.md K10;
 * design amendments P2-12b, P2-13b): a deleted root is never recreated, a macOS refusal is not a crash, the adopted
 * row survives either way, and `renderAllLessonScopes` repairs only what differs from the text the ledger implies.
 * Legacy mode keeps its old behavior. Synthetic scopes only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_CONTEXT_DIR_KEY } from './analytics-context.js';
import {
  adoptLesson,
  getLesson,
  lessonScopeMarkdown,
  listLessons,
  proposeLesson,
  renderAllLessonScopes,
  renderLessonScope,
  retireLesson,
} from './lessons-ledger.js';
import { emptyKnowledgeState, writeKnowledgeState } from './knowledge-root.js';
import { createStorage, setSetting, type StorageLayer } from './storage.js';

let storage: StorageLayer;
let base: string;
let root: string;
const db = () => storage.getDb();
const lessonsDir = () => path.join(root, 'analytics', 'lessons');

function propose(scope: string, rule: string): string {
  const result = proposeLesson(db(), { scope, rule, evidence: 'observed in a synthetic run', provenance: 'test' });
  if (!result.ok) throw new Error(result.error);
  return result.lesson.id;
}

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-lessons-')));
  root = path.join(base, 'BotBoy Knowledge');
  fs.mkdirSync(path.join(root, 'analytics'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('legacy mode', () => {
  beforeEach(() => setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(base, 'legacy')));

  it('writes the projection exactly as before and returns true; the file is the pure markdown of the ledger', () => {
    fs.mkdirSync(path.join(base, 'legacy'));
    const id = propose('shopwave', 'Always name the filter regime beside a number.');
    adoptLesson(db(), id);
    const file = path.join(base, 'legacy', 'lessons', 'shopwave.md');
    expect(fs.readFileSync(file, 'utf8')).toBe(lessonScopeMarkdown('shopwave', listLessons(db(), { scope: 'shopwave', status: 'adopted' })));
    expect(renderLessonScope(db(), 'shopwave')).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'legacy', 'manifest.json'), 'utf8'));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ file: 'lessons/shopwave.md', source: 'lesson', business: 'shopwave' });
  });

  it('still throws on a permission failure: only library mode turns it into a held projection', () => {
    fs.mkdirSync(path.join(base, 'legacy'));
    const id = propose('shopwave', 'Rule one for the legacy case.');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); });
    expect(() => adoptLesson(db(), id)).toThrow(/nope/);
  });
});

describe('library mode', () => {
  beforeEach(() => writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' }));

  it('projects into <root>/analytics/lessons and returns true', () => {
    adoptLesson(db(), propose('shopwave', 'Count orders by order id, never by row.'));
    expect(fs.existsSync(path.join(lessonsDir(), 'shopwave.md'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'analytics', 'manifest.json'), 'utf8'));
    expect(manifest.files.map((entry: { file: string }) => entry.file)).toEqual(['lessons/shopwave.md']);
  });

  it('does not recreate a deleted root: the adoption stands, nothing is written, and it is logged once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    const first = propose('shopwave', 'Rule one while the folder is gone.');
    const second = propose('shopwave', 'A second rule while the folder is gone, different enough.');
    expect(adoptLesson(db(), first).status).toBe('adopted');
    expect(adoptLesson(db(), second).status).toBe('adopted');
    expect(fs.existsSync(root)).toBe(false);
    expect(renderLessonScope(db(), 'shopwave')).toBe(false);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('[Lessons] projection held'))).toHaveLength(1);
  });

  it('holds the projection on a macOS refusal instead of throwing, and keeps the adopted row', () => {
    const id = propose('shopwave', 'Rule that cannot be written yet.');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); });
    expect(adoptLesson(db(), id).status).toBe('adopted');
    expect(getLesson(db(), id)?.status).toBe('adopted');
    write.mockRestore();
    expect(renderAllLessonScopes(db())).toMatchObject({ rendered: ['shopwave'], held: false });
    expect(fs.existsSync(path.join(lessonsDir(), 'shopwave.md'))).toBe(true);
  });

  it('lets any other write error through', () => {
    const id = propose('shopwave', 'Rule that hits a disk error.');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
    expect(() => adoptLesson(db(), id)).toThrow(/disk full/);
  });
});

describe('renderAllLessonScopes', () => {
  beforeEach(() => writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' }));

  it('writes missing projections, leaves an equal file untouched, rewrites a stale one, and removes a retired scope', () => {
    const a = propose('shopwave', 'Rule A about orders.');
    const b = propose('streamly', 'Rule B about sessions.');
    adoptLesson(db(), a);
    adoptLesson(db(), b);
    const shopFile = path.join(lessonsDir(), 'shopwave.md');
    const streamFile = path.join(lessonsDir(), 'streamly.md');
    const manifestFile = path.join(root, 'analytics', 'manifest.json');

    // Equal files: nothing is rewritten, so bytes (and any receipt over them) cannot change.
    const before = { shop: fs.statSync(shopFile).mtimeMs, manifest: fs.readFileSync(manifestFile, 'utf8') };
    const untouched = renderAllLessonScopes(db());
    expect(untouched).toEqual({ rendered: [], unchanged: ['shopwave', 'streamly'], held: false });
    expect(fs.statSync(shopFile).mtimeMs).toBe(before.shop);
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before.manifest);

    // A stale projection (the ledger moved on while the folder was unavailable) is rewritten from the ledger.
    fs.writeFileSync(shopFile, '# stale\n');
    // A missing projection is written.
    fs.rmSync(streamFile);
    const repaired = renderAllLessonScopes(db());
    expect(repaired.rendered.sort()).toEqual(['shopwave', 'streamly']);
    expect(fs.readFileSync(shopFile, 'utf8')).toBe(lessonScopeMarkdown('shopwave', listLessons(db(), { scope: 'shopwave', status: 'adopted' })));
    expect(fs.existsSync(streamFile)).toBe(true);

    // A scope whose lessons are all retired loses a leftover projection.
    retireLesson(db(), b);
    fs.writeFileSync(streamFile, '# leftover\n');
    const removed = renderAllLessonScopes(db());
    expect(removed.rendered).toEqual(['streamly']);
    expect(fs.existsSync(streamFile)).toBe(false);
  });

  it('does nothing while the folder is unavailable', () => {
    adoptLesson(db(), propose('shopwave', 'Rule A about orders.'));
    fs.rmSync(root, { recursive: true, force: true });
    expect(renderAllLessonScopes(db())).toEqual({ rendered: [], unchanged: [], held: true });
    expect(fs.existsSync(root)).toBe(false);
  });

  it('is a no-op for an install with no lessons', () => {
    expect(renderAllLessonScopes(db())).toEqual({ rendered: [], unchanged: [], held: false });
  });
});
