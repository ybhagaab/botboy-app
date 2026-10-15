/**
 * Release allowlist, test-support imports (Knowledge library P2 review R6): `scripts/release.sh › PATHS` ships `src` (tests
 * included) and the root `vitest.*.ts` files, and `release:check --check-imports` reads only `scripts/*.mjs`. A root
 * `vitest.*.ts` file that is imported but not shipped would fail every vitest run in `botboy-app` at setup, with all of this
 * repo's own checks green. This test closes that gap for the config, for every setup file it names, for every root vitest
 * file, and for every file under `src` that imports something outside `src`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT, releaseAllowlist } from './release-allowlist.testutil.js';

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** A relative specifier as a file inside the package, or null when it names no file (a folder import is looked up too). */
function resolveFile(fromFile: string, specifier: string): string | null {
  const base = path.resolve(PACKAGE_ROOT, path.dirname(fromFile), specifier);
  const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
  const candidates = [base, `${base}.ts`, `${stripped}.ts`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return path.relative(PACKAGE_ROOT, candidate).split(path.sep).join('/');
    } catch { /* try the next spelling */ }
  }
  return null;
}

function walkTs(rel: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(path.join(PACKAGE_ROOT, rel))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const child = path.join(rel, name);
    const stat = fs.statSync(path.join(PACKAGE_ROOT, child));
    if (stat.isDirectory()) walkTs(child, out);
    else if (/\.(ts|mjs)$/.test(name)) out.push(child.split(path.sep).join('/'));
  }
  return out;
}

/**
 * Dev-only release verifiers that four shipped tests import (node-runtime.test, node-runtime-verify.test, python-runtime.test,
 * python-runtime-verify.test). `release.sh` runs the verifiers itself and does not ship them, so those four test files cannot
 * load in botboy-app. That gap predates this test and is not a setup-file gap (the rest of a run is unaffected); it is named
 * here so any NEW unshipped import fails, and the next test fails once the gap is closed so this list cannot go stale.
 */
const KNOWN_UNSHIPPED_TEST_IMPORTS = ['scripts/verify-node-runtime.mjs', 'scripts/verify-python-runtime.mjs'];

const shipped = () => releaseAllowlist();
const isShipped = (rel: string, entries: string[]) => entries.some((entry) => rel === entry || rel.startsWith(`${entry}/`));

describe('release allowlist: the test-support files that shipped tests import', () => {
  it('ships every root vitest.*.ts file that exists', () => {
    const entries = shipped();
    const roots = fs.readdirSync(PACKAGE_ROOT).filter((name) => /^vitest\..*\.ts$/.test(name));
    expect(roots.length).toBeGreaterThanOrEqual(5);
    expect(roots.filter((name) => !isShipped(name, entries))).toEqual([]);
  });

  it('ships every file that vitest.config.ts names as a setup or global setup file', () => {
    const config = fs.readFileSync(path.join(PACKAGE_ROOT, 'vitest.config.ts'), 'utf8');
    const named = [...config.matchAll(/(?:globalSetup|setupFiles)\s*:\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/['"]\.\/([^'"]+)['"]/g)].map((entry) => entry[1]));
    expect(named.length).toBeGreaterThanOrEqual(3);
    const entries = shipped();
    expect(named.filter((file) => !isShipped(file, entries))).toEqual([]);
  });

  it('ships everything that a shipped root vitest file or a file under src imports from outside src', () => {
    const entries = shipped();
    const sources = [...fs.readdirSync(PACKAGE_ROOT).filter((name) => /^vitest\..*\.ts$/.test(name)), ...walkTs('src')];
    const missing: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
      for (const match of text.matchAll(SPECIFIER)) {
        const target = resolveFile(file, match[1]);
        if (!target || target.startsWith('src/')) continue;
        if (!isShipped(target, entries) && !KNOWN_UNSHIPPED_TEST_IMPORTS.includes(target)) missing.push(`${file} imports ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the named exceptions are still unshipped (close the gap and delete the exception together)', () => {
    const entries = shipped();
    expect(KNOWN_UNSHIPPED_TEST_IMPORTS.filter((file) => isShipped(file, entries))).toEqual([]);
    for (const file of KNOWN_UNSHIPPED_TEST_IMPORTS) expect(fs.existsSync(path.join(PACKAGE_ROOT, file))).toBe(true);
  });

  it('would notice the gap: without its PATHS entry vitest.git-standin.ts is reported', () => {
    const without = shipped().filter((entry) => entry !== 'vitest.git-standin.ts');
    expect(isShipped('vitest.git-standin.ts', without)).toBe(false);
    expect(isShipped('vitest.git-standin.ts', shipped())).toBe(true);
  });
});
