/**
 * Removing the folders a change left empty (knowledge-library.md K13; P2 review R32). Real folders in a temp directory with
 * a space in its name; the only thing ever removed is an empty folder (and a Finder `.DS_Store` inside one).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneEmptyFolders } from './knowledge-fs.js';

let base: string;
let root: string;
beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fs-')));
  root = path.join(base, 'BotBoy Knowledge');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'GUIDE.md'), '# Root\n');
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const dir = (rel: string) => fs.mkdirSync(path.join(root, ...rel.split('/')), { recursive: true });
const file = (rel: string, text = 'x\n') => { dir(rel.split('/').slice(0, -1).join('/')); fs.writeFileSync(path.join(root, ...rel.split('/')), text); };
const exists = (rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));

describe('pruneEmptyFolders', () => {
  it('removes every folder the removed files left empty, deepest first, and returns them', async () => {
    dir('garden/beds/spring');
    expect(await pruneEmptyFolders(root, ['garden/beds/spring/notes.md', 'garden/GUIDE.md'])).toEqual(['garden/beds/spring', 'garden/beds', 'garden']);
    expect(exists('garden')).toBe(false);
    expect(exists('GUIDE.md')).toBe(true);
  });

  it('stops at the first folder that still holds something, and leaves everything above it', async () => {
    file('garden/GUIDE.md');
    dir('garden/beds/spring');
    expect(await pruneEmptyFolders(root, ['garden/beds/spring/notes.md'])).toEqual(['garden/beds/spring', 'garden/beds']);
    expect(exists('garden/beds')).toBe(false);
    expect(exists('garden/GUIDE.md')).toBe(true);
  });

  it('never removes a folder that holds a file, a hidden file other than .DS_Store, or a non-empty sub-folder', async () => {
    file('a/keep.md');
    file('b/.hidden', 'x');
    file('c/inner/keep.md');
    expect(await pruneEmptyFolders(root, ['a/gone.md', 'b/gone.md', 'c/gone.md'])).toEqual([]);
    expect(exists('a/keep.md') && exists('b/.hidden') && exists('c/inner/keep.md')).toBe(true);
  });

  it('treats a folder that holds only a Finder .DS_Store as empty', async () => {
    file('garden/beds/.DS_Store', 'finder');
    file('garden/.DS_Store', 'finder');
    expect(await pruneEmptyFolders(root, ['garden/beds/notes.md'])).toEqual(['garden/beds', 'garden']);
    expect(exists('garden')).toBe(false);
  });

  it('never removes the root, and keeps a folder named in `keep` (a category) even when it is empty', async () => {
    dir('research/bees');
    expect(await pruneEmptyFolders(root, ['research/bees/a.md', 'top.md'], new Set(['research']))).toEqual(['research/bees']);
    expect(exists('research')).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
    // The match is case-insensitive on the folder, as the root guide may spell it differently.
    dir('Memory/me');
    expect(await pruneEmptyFolders(root, ['Memory/me/a.md'], new Set(['memory']))).toEqual(['Memory/me']);
    expect(exists('Memory')).toBe(true);
  });

  it('does not follow a link: a folder that is a link, or sits behind one, is left alone and its target untouched', async () => {
    const outside = path.join(base, 'elsewhere');
    fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'inner', '.DS_Store'), 'finder');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    expect(await pruneEmptyFolders(root, ['linked/inner/gone.md', 'linked/gone.md'])).toEqual([]);
    expect(fs.existsSync(path.join(outside, 'inner', '.DS_Store'))).toBe(true);
    expect(fs.lstatSync(path.join(root, 'linked')).isSymbolicLink()).toBe(true);
    // A link to a folder that holds only a .DS_Store is no folder of the library: its target keeps the file.
    const almostEmpty = path.join(base, 'almost-empty');
    fs.mkdirSync(almostEmpty);
    fs.writeFileSync(path.join(almostEmpty, '.DS_Store'), 'finder');
    fs.symlinkSync(almostEmpty, path.join(root, 'linked-too'));
    expect(await pruneEmptyFolders(root, ['linked-too/gone.md'])).toEqual([]);
    expect(fs.existsSync(path.join(almostEmpty, '.DS_Store'))).toBe(true);
    expect(fs.lstatSync(path.join(root, 'linked-too')).isSymbolicLink()).toBe(true);
  });

  it('answers quietly for a folder that is already gone and for names that climb out', async () => {
    expect(await pruneEmptyFolders(root, ['never/was/here.md'])).toEqual([]);
    fs.mkdirSync(path.join(base, 'outside-empty'));
    expect(await pruneEmptyFolders(root, ['../outside-empty/a.md'])).toEqual([]);
    expect(fs.existsSync(path.join(base, 'outside-empty'))).toBe(true);
  });
});
