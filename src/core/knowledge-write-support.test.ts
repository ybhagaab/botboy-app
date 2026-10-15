/**
 * The deterministic helpers under the write path (knowledge-library.md K17): names and paths that stay inside the folder,
 * the writable-type rule, generated files, exact edits, line-ending views and the source of an import. Each layer is tested
 * ALONE here, because the composite writer stacks several of them and a test through the writer cannot tell which one held.
 * Temp folders with a space in their names; synthetic content; credentials assembled at run time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrivateKeyBlock } from './knowledge-fixtures.testutil.js';
import { parseGuide } from './knowledge-guide.js';
import type { LibrarySet } from './knowledge-library.js';
import {
  applyEdits, generatedFileReason, readImportSource, readLibraryText, relativeToRoot, resolveInsideSet, restoreView, validateFileName, validateWritableType, viewOf,
} from './knowledge-write-support.js';

let base: string;
let dir: string;
beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-support-')));
  dir = path.join(base, 'BotBoy Knowledge', 'shop data');
  fs.mkdirSync(dir, { recursive: true });
  vi.stubEnv('HOME', path.join(base, 'home'));
  fs.mkdirSync(path.join(base, 'home', 'Documents'), { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(base, { recursive: true, force: true }); });

describe('validateFileName', () => {
  it('accepts a plain relative name with up to three sub-folders and returns its segments', () => {
    expect(validateFileName('notes.md')).toEqual({ ok: true, name: 'notes.md', segments: ['notes.md'] });
    expect(validateFileName('how-to/steps/one.md')).toMatchObject({ ok: true, segments: ['how-to', 'steps', 'one.md'] });
  });

  it.each([
    ['traversal', '../x.md'], ['a middle ..', 'a/../x.md'], ['a hidden file', '.env'], ['a hidden folder', '.git/config'], ['an absolute path', '/etc/passwd'], ['a home path', '~/x.md'],
    ['a backslash', 'a\\b.md'], ['a NUL', 'a\0b.md'], ['empty parts', 'a//b.md'], ['a dot part', './a.md'], ['four sub-folders', 'a/b/c/d/e.md'], ['a part over 80 characters', `${'a'.repeat(81)}.md`],
    ['over 200 characters', `${'a/'.repeat(60)}x.md`], ['a control character', 'a\u0007b.md'], ['not a string', 42], ['an empty string', ' '],
  ])('refuses %s with a next action', (_label, value) => {
    const result = validateFileName(value);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'invalid_path', nextAction: expect.any(String) });
  });
});

describe('validateFileName: a GUIDE.md has no folder part (P2 review R33)', () => {
  it('accepts GUIDE.md alone and a file whose name only starts with it', () => {
    expect(validateFileName('GUIDE.md')).toEqual({ ok: true, name: 'GUIDE.md', segments: ['GUIDE.md'] });
    expect(validateFileName('guide.md')).toMatchObject({ ok: true });
    expect(validateFileName('child/GUIDE.md.bak')).toMatchObject({ ok: true });
    expect(validateFileName('child/MY_GUIDE.md')).toMatchObject({ ok: true });
  });

  it.each([['child/GUIDE.md'], ['a/b/guide.md'], ['child/Guide.MD']])('refuses %s and says how to address a nested set', (value) => {
    const result = validateFileName(value);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'invalid_path', message: expect.stringContaining('folder in front of GUIDE.md'), nextAction: expect.stringContaining('nested set by its own id') });
  });
});

describe('resolveInsideSet: containment on REAL paths', () => {
  it('finds an existing file and a new name inside the set', async () => {
    fs.writeFileSync(path.join(dir, 'orders.md'), '# x\n');
    expect(await resolveInsideSet(dir, ['orders.md'])).toMatchObject({ ok: true, exists: true });
    expect(await resolveInsideSet(dir, ['new.md'])).toMatchObject({ ok: true, exists: false });
    expect(await resolveInsideSet(dir, ['sub', 'deeper', 'new.md'])).toMatchObject({ ok: true, exists: false });
  });

  it('refuses a path that climbs out of the set even when every part exists', async () => {
    fs.writeFileSync(path.join(base, 'BotBoy Knowledge', 'other.md'), '# other\n');
    const result = await resolveInsideSet(dir, ['..', 'other.md']);
    expect(result).toMatchObject({ ok: false, code: 'invalid_path' });
    expect(await resolveInsideSet(dir, ['sub', '..', '..', 'new.md'])).toMatchObject({ ok: false, code: 'invalid_path' });
  });

  it('refuses a folder that is a link to somewhere outside, for an existing and for a new file', async () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.md'), '# outside\n');
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    expect(await resolveInsideSet(dir, ['linked', 'secret.md'])).toMatchObject({ ok: false, code: 'invalid_path' });
    expect(await resolveInsideSet(dir, ['linked', 'new.md'])).toMatchObject({ ok: false, code: 'invalid_path' });
  });

  it('a set folder that does not exist yet resolves a new name inside it and creates nothing (the walk stops at the set\'s own edge)', async () => {
    const missing = path.join(base, 'BotBoy Knowledge', 'not yet');
    expect(await resolveInsideSet(missing, ['new.md'])).toMatchObject({ ok: true, exists: false });
    expect(await resolveInsideSet(missing, ['sub', 'new.md'])).toMatchObject({ ok: true, exists: false });
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('refuses a name that is itself a link, even to a file inside the set, and a folder', async () => {
    fs.writeFileSync(path.join(dir, 'real.md'), '# real\n');
    fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'alias.md'));
    fs.mkdirSync(path.join(dir, 'folder.md'));
    expect(await resolveInsideSet(dir, ['alias.md'])).toMatchObject({ ok: false, code: 'invalid_path' });
    expect(await resolveInsideSet(dir, ['folder.md'])).toMatchObject({ ok: false, code: 'invalid_path' });
  });
});

describe('readLibraryText', () => {
  it('reads a regular text file, treats absence as null, and refuses a link, a binary file and an oversize file', async () => {
    fs.writeFileSync(path.join(dir, 'a.md'), 'hello\n');
    expect(await readLibraryText(path.join(dir, 'a.md'))).toMatchObject({ ok: true, text: 'hello\n' });
    expect(await readLibraryText(path.join(dir, 'missing.md'))).toMatchObject({ ok: true, text: null, bytes: null });
    fs.symlinkSync(path.join(dir, 'a.md'), path.join(dir, 'link.md'));
    expect(await readLibraryText(path.join(dir, 'link.md'))).toMatchObject({ ok: false, code: 'invalid_path' });
    fs.writeFileSync(path.join(dir, 'bin.md'), Buffer.from([65, 0, 66]));
    expect(await readLibraryText(path.join(dir, 'bin.md'))).toMatchObject({ ok: false, code: 'not_text' });
    fs.writeFileSync(path.join(dir, 'big.md'), Buffer.alloc(4 * 1024 * 1024 + 1, 97));
    expect(await readLibraryText(path.join(dir, 'big.md'))).toMatchObject({ ok: false, code: 'result_too_large' });
  });

  it('turns a macOS permission refusal into a next action and never throws', async () => {
    const spy = vi.spyOn(fs.promises, 'lstat').mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    const result = await readLibraryText(path.join(dir, 'a.md'));
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, code: 'root_unavailable', nextAction: expect.stringContaining('System Settings') });
  });
});

describe('validateWritableType', () => {
  const jsonGuide = parseGuide('---\nname: Data\nwriteTypes: json\n---\n# Data\n');
  const plainGuide = parseGuide('---\nname: Notes\n---\n# Notes\n');
  it('allows .md and .txt, and nothing else by default', () => {
    expect(validateWritableType('a.md', plainGuide, null)).toBeNull();
    expect(validateWritableType('a.TXT', null, null)).toBeNull();
    for (const name of ['a.yaml', 'a.yml', 'a.sql', 'a.json', 'a.sh', 'a']) expect(validateWritableType(name, plainGuide, '{}'), name).toMatchObject({ code: 'unsupported_type' });
  });
  it('allows .json only where the guide declares it, and the text must parse', () => {
    expect(validateWritableType('a.json', jsonGuide, '{"a": 1}')).toBeNull();
    expect(validateWritableType('a.json', jsonGuide, '{ nope')).toMatchObject({ code: 'invalid_json' });
    expect(validateWritableType('a.json', jsonGuide, null)).toBeNull();
    expect(validateWritableType('a.json', null, '{}')).toMatchObject({ code: 'unsupported_type' });
  });
});

describe('generatedFileReason: the analytics set\'s own files', () => {
  const analytics = (files: Array<{ name: string; analytics?: { source: string } }> = []) => ({ reserved: true, files } as unknown as LibrarySet);
  it('names lessons/, the manifest, etl-derived presets and lesson projections, and nothing else', () => {
    const set = analytics([{ name: 'presets/shop.md', analytics: { source: 'etl-derived' } }, { name: 'presets/mine.md', analytics: { source: 'user-dropped' } }, { name: 'extra/lesson-copy.md', analytics: { source: 'lesson' } }]);
    expect(generatedFileReason(set, 'lessons/new-scope.md')).toContain('lessons');
    expect(generatedFileReason(set, 'Lessons/Other.md')).toContain('lessons');
    expect(generatedFileReason(set, 'manifest.json')).toContain('manifest');
    expect(generatedFileReason(set, 'presets/shop.md')).toContain('generated from ETL');
    expect(generatedFileReason(set, 'extra/lesson-copy.md')).toContain('lesson');
    expect(generatedFileReason(set, 'presets/mine.md')).toBeNull();
    expect(generatedFileReason(set, 'notes.md')).toBeNull();
  });
  it('is null for every other set and for none', () => {
    expect(generatedFileReason({ reserved: false, files: [] } as unknown as LibrarySet, 'lessons/x.md')).toBeNull();
    expect(generatedFileReason(null, 'lessons/x.md')).toBeNull();
  });
});

describe('applyEdits: each find exactly once', () => {
  it('applies edits in order against the running text', () => {
    expect(applyEdits('a b c', [{ find: 'a', replace: 'x' }, { find: 'x b', replace: 'y' }])).toEqual({ ok: true, text: 'y c' });
  });
  it('refuses a missing, an ambiguous and a malformed edit with the index and a next action', () => {
    expect(applyEdits('a b', [{ find: 'z', replace: 'q' }])).toMatchObject({ ok: false, code: 'edit_not_found', details: { index: 0 } });
    expect(applyEdits('a a', [{ find: 'a', replace: 'q' }])).toMatchObject({ ok: false, code: 'edit_not_unique' });
    expect(applyEdits('a', [{ find: '', replace: 'q' }])).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(applyEdits('a', [{ find: 'a', replace: 5 as never }])).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });
});

describe('line endings and BOM', () => {
  it('edits run on LF and the file\'s own endings and BOM come back', () => {
    const crlf = '\uFEFFone\r\ntwo\r\n';
    const view = viewOf(crlf);
    expect(view).toMatchObject({ bom: true, eol: '\r\n', lf: 'one\ntwo\n' });
    expect(restoreView('one\nTWO\n', view)).toBe('\uFEFFone\r\nTWO\r\n');
    expect(viewOf('a\nb\n')).toMatchObject({ bom: false, eol: '\n' });
    expect(relativeToRoot('/r/Root Dir', '/r/Root Dir/sub/a.md')).toBe('sub/a.md');
  });
});

describe('readImportSource: one file under the Data Room\'s local-file policy', () => {
  const home = () => path.join(base, 'home');
  const library = () => path.join(base, 'BotBoy Knowledge');
  const put = (file: string, body: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };

  it('reads a text file under the home folder and pins its hash and exact bytes', () => {
    const file = put(path.join(home(), 'Documents', 'notes.md'), '# Notes\n\nA plain note.\n');
    const result = readImportSource(file, library());
    expect(result).toMatchObject({ fileName: 'notes.md', text: '# Notes\n\nA plain note.\n' });
    expect((result as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readImportSource('~/Documents/notes.md', library())).toMatchObject({ fileName: 'notes.md' });
  });

  it.each([
    ['nothing', ''], ['a NUL', 'a\0b'], ['a relative path with ..', '../x.md'], ['a file that does not exist', '/no/such/file.md'], ['a folder', '__FOLDER__'],
  ])('refuses %s', (_label, value) => {
    const folder = path.join(home(), 'Documents');
    const result = readImportSource(value === '__FOLDER__' ? folder : value, library());
    expect(result).toMatchObject({ ok: false, nextAction: expect.any(String) });
  });

  it('refuses a hidden file, a hidden folder, a file inside the library, a sensitive name, a binary, an oversize file and a credential', () => {
    expect(readImportSource(put(path.join(home(), '.env'), 'A=1\n'), library())).toMatchObject({ ok: false, code: 'import_source_denied' });
    expect(readImportSource(put(path.join(home(), '.config', 'notes.md'), '# x\n'), library())).toMatchObject({ ok: false, code: 'import_source_denied' });
    expect(readImportSource(put(path.join(library(), 'inside.md'), '# x\n'), library())).toMatchObject({ ok: false, code: 'import_source_denied', message: expect.stringContaining('already inside the library') });
    expect(readImportSource(put(path.join(home(), 'Documents', 'id_rsa'), 'x'), library())).toMatchObject({ ok: false, code: 'import_source_denied' });
    expect(readImportSource(put(path.join(home(), 'Documents', 'bin.md'), Buffer.from([65, 0, 66])), library())).toMatchObject({ ok: false, code: 'not_text' });
    expect(readImportSource(put(path.join(home(), 'Documents', 'big.md'), Buffer.alloc(4 * 1024 * 1024 + 1, 97)), library())).toMatchObject({ ok: false, code: 'import_source_denied', message: expect.stringContaining('between 1 byte and 4 MB') });
    expect(readImportSource(put(path.join(home(), 'Documents', 'keys.md'), `# Keys\n${fakePrivateKeyBlock()}\n`), library())).toMatchObject({ ok: false, code: 'secret_in_content' });
  });

  it('refuses a link that leads into a hidden folder (the real path is judged, not the name)', () => {
    const hidden = put(path.join(home(), '.hidden', 'real.md'), '# real\n');
    fs.symlinkSync(hidden, path.join(home(), 'Documents', 'innocent.md'));
    expect(readImportSource(path.join(home(), 'Documents', 'innocent.md'), library())).toMatchObject({ ok: false, code: 'import_source_denied' });
  });
});
