/**
 * Small file helpers shared by the Knowledge library's write path and its history (knowledge-library.md K13): content
 * hashes, an atomic write (temp file in the same folder, then rename, the mode of an existing file kept), and reads that
 * report "absent" as null. Async, so a macOS permission prompt cannot freeze the event loop.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** The bytes of a file, or null when it does not exist. Any other failure (EPERM, EACCES) is thrown. */
export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Write `data` to `file` atomically. The folder is created when asked; an existing file keeps its mode. */
export async function writeFileAtomic(file: string, data: string | Buffer, options: { ensureDir?: boolean; mode?: number } = {}): Promise<void> {
  const dir = path.dirname(file);
  if (options.ensureDir) await fsp.mkdir(dir, { recursive: true });
  let mode = options.mode;
  if (mode === undefined) {
    try { mode = (await fsp.stat(file)).mode & 0o7777; } catch { mode = undefined; }
  }
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(5).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(temp, data, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** True when `candidate` is `root` or lies inside it (both absolute, compared as written). */
export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * True when the nearest existing ancestor of `absolute`'s folder resolves (on REAL paths) inside the real `root`. A folder
 * that was swapped for a link after a change was staged or recorded fails it, so neither a write nor an Undo goes through.
 */
export async function realParentInside(root: string, absolute: string): Promise<boolean> {
  let probe = path.dirname(absolute);
  let realParent: string | null = null;
  for (;;) {
    try { realParent = await fsp.realpath(probe); break; } catch {
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  const realRoot = await fsp.realpath(root).catch(() => root);
  return realParent !== null && isInside(realRoot, realParent);
}

/** Files Finder leaves in a folder it has shown; a folder holding nothing else counts as empty. */
const IGNORABLE_ENTRIES = new Set(['.DS_Store']);

/**
 * Remove the folders that taking `relPaths` away (posix names relative to `root`) left empty, deepest first, and return them.
 * A folder that still holds anything stays: `rmdir` refuses a non-empty folder, and a folder holding only `.DS_Store` is
 * treated as empty. Never removes `root`, a folder in `keep` (relative names, lower case: the categories the root guide
 * names), a link, or a folder whose parent chain now leaves `root`. Product code deleting in-process: it shells out to
 * nothing and takes no file with it but `.DS_Store` (knowledge-library.md K13, P2 review R32).
 */
export async function pruneEmptyFolders(root: string, relPaths: readonly string[], keep: ReadonlySet<string> = new Set()): Promise<string[]> {
  const folders = new Set<string>();
  for (const rel of relPaths) {
    const parts = rel.split('/').filter(Boolean);
    parts.pop();
    while (parts.length > 0) { folders.add(parts.join('/')); parts.pop(); }
  }
  const deepestFirst = [...folders].sort((left, right) => right.split('/').length - left.split('/').length || (left < right ? -1 : 1));
  const removed: string[] = [];
  for (const rel of deepestFirst) {
    if (keep.has(rel.toLowerCase())) continue;
    const absolute = path.join(root, ...rel.split('/'));
    if (absolute === root || !isInside(root, absolute)) continue;
    try {
      const stat = await fsp.lstat(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (!(await realParentInside(root, absolute))) continue;
      const entries = await fsp.readdir(absolute);
      if (entries.some((name) => !IGNORABLE_ENTRIES.has(name))) continue;
      for (const name of entries) await fsp.unlink(path.join(absolute, name));
      await fsp.rmdir(absolute);
      removed.push(rel);
    } catch { /* gone already, not empty after all, or not ours to remove: the folder stays and nothing else is affected */ }
  }
  return removed;
}

export const newId = (prefix: string, bytes = 6): string => `${prefix}_${randomBytes(bytes).toString('hex')}`;
