/**
 * Paths the always-on capture pipeline must never read (knowledge-library.md K1, design amendment P2-1).
 *
 * The Knowledge library is on-demand knowledge the owner chose to keep: it is read when a task needs it, through the
 * knowledge tools, and never pushed through capture (extract, classify, route, gist, brain, search index). The Local
 * folders watcher seeds Downloads, Desktop and Documents on a first run, and the library's default home is
 * `~/Documents/BotBoy Knowledge`, so without an exclusion every library file would become a capture on its first write.
 *
 * One registry, one predicate. `index.ts` registers a provider (the library's current root plus every former root)
 * right after the database opens; the filesystem monitor (live events, walks, the per-file funnel, unlinks), the folder
 * registration (`addLocalFolder`) and the extractor re-check all ask `isCaptureExcludedPath`. With no provider
 * registered, or no root recorded, nothing is excluded and every caller behaves exactly as it did before.
 *
 * Matching is by path prefix on a normalized spelling (resolved, NFC, lower case): APFS is case-insensitive by
 * default, and a wrong "excluded" on a case-sensitive volume only hides a path that differs from the library's by case,
 * which fails closed. A provider returns every spelling it knows (the recorded path and its real path).
 */
import fs from 'fs';
import path from 'path';

/** The roots to keep out of capture, as absolute paths. May be called often; the registry caches the answer. */
export type CaptureExclusionProvider = () => readonly string[];

/** A cached answer expires on its own, so a missed `invalidateCaptureExclusions()` heals within seconds. */
const CACHE_TTL_MS = 5_000;

let provider: CaptureExclusionProvider | null = null;
let cache: { at: number; roots: readonly string[] } | null = null;

function normalizeForCompare(value: string): string {
  return path.resolve(value).normalize('NFC').toLowerCase();
}

/** Install (or with null, remove) the provider. Called once at boot, before any watcher or walk starts. */
export function registerCaptureExcludedRoots(next: CaptureExclusionProvider | null): void {
  provider = next;
  cache = null;
}

/** Forget the cached answer. Called when the library's root, or its list of former roots, changes. */
export function invalidateCaptureExclusions(): void {
  cache = null;
}

function currentRoots(): readonly string[] {
  if (!provider) return [];
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.roots;
  let raw: readonly string[] = [];
  try { raw = provider(); } catch { raw = []; }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim() && path.isAbsolute(entry)) seen.add(normalizeForCompare(entry));
  }
  const roots = [...seen];
  cache = { at: now, roots };
  return roots;
}

/** The normalized roots in effect now (for tests, activation checks and diagnostics). */
export function captureExcludedRootsInEffect(): string[] {
  return [...currentRoots()];
}

function insideAny(target: string, roots: readonly string[]): boolean {
  return roots.some(root => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/**
 * True when `candidate` is a library root or lies inside one. `resolveLinks` also tests the real path of the
 * candidate (one `realpath`, only when a root exists), for the per-file funnel where `stat` follows a link that a
 * live event can name from outside the library.
 */
export function isCaptureExcludedPath(candidate: string, options: { resolveLinks?: boolean } = {}): boolean {
  const roots = currentRoots();
  if (roots.length === 0 || typeof candidate !== 'string' || candidate.length === 0) return false;
  if (insideAny(normalizeForCompare(candidate), roots)) return true;
  if (options.resolveLinks) {
    try {
      if (insideAny(normalizeForCompare(fs.realpathSync.native(candidate)), roots)) return true;
    } catch { /* a path that cannot be resolved is not a link into the library */ }
  }
  return false;
}
