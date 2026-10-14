/**
 * scripts/release.sh pre-flight (scope C, review 1 findings 5 and 10): a release refuses a
 * snapshot that would be broken on a teammate's Mac, BEFORE anything is published, and the
 * whole script can be exercised without any chance of publishing.
 *
 * The harness (release-harness.testutil.ts) runs the real release.sh and the real
 * build-native-prebuilt.mjs on a throwaway dev repository against a LOCAL bare repository:
 * git itself refuses every non-file transport (GIT_ALLOW_PROTOCOL=file), the pair
 * BOTBOY_RELEASE_URL + BOTBOY_RELEASE_WORKDIR must be local, and release.sh checks that the
 * work clone's origin is that URL. These tests never run `npm run release`, never name the
 * real botboy-app, and never touch ~/.cache/botboy-app-release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLocalPath, packageRoot, releaseFixture, type ReleaseFixture } from './release-harness.testutil';
import { pinText, shasums, startDistServer } from './node-runtime.testutil';

vi.setConfig({ testTimeout: 180_000 });

// Dev-only: a botboy-app checkout has neither the builder nor release.sh's repository around it.
const distribution = fs.existsSync(path.join(packageRoot, '.botboy-distribution'));
const devOnly = describe.runIf(!distribution && fs.existsSync(path.join(packageRoot, 'scripts', 'build-native-prebuilt.mjs')));

const made: ReleaseFixture[] = [];
const fixture = (options: Parameters<typeof releaseFixture>[0] = {}) => {
  const f = releaseFixture(options);
  made.push(f);
  return f;
};
afterEach(() => {
  while (made.length) made.pop()!.cleanup();
});

const text = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`;

devOnly('release.sh --preflight: the checks, and nothing else', () => {
  it('passes on a clean tree and fetches, clones, writes and publishes nothing (the remote can be gone)', () => {
    const f = fixture();
    const originBefore = f.originHead();
    const workBefore = f.gitIn(f.work, 'rev-parse', 'HEAD');
    fs.renameSync(f.origin, `${f.origin}.gone`); // a preflight never looks at the remote
    const result = f.release(['--preflight']);
    expect(result.status, text(result)).toBe(0);
    expect(result.stdout).toContain('Release pre-flight passed');
    expect(result.stdout).toContain('Nothing was fetched, cloned, committed or published');
    fs.renameSync(`${f.origin}.gone`, f.origin);
    expect(f.originHead()).toBe(originBefore);
    expect(f.gitIn(f.work, 'rev-parse', 'HEAD')).toBe(workBefore);
    expect(fs.readdirSync(f.work).sort()).toEqual(['.git', 'README.md']);
  });

  it('refuses a native source changed after the helper was built, and names the fix', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.pkg, 'native', 'vision-ocr', 'main.swift'), '// edited after the build\n');
    f.commit('edit source');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('native/vision-ocr/main.swift changed after the ocr helper was built');
    expect(text(result)).toContain('npm run prebuilt:build');
  });

  it('refuses a truncated prebuilt binary', () => {
    const f = fixture();
    const binary = path.join(f.pkg, 'native', 'botboy-launcher', 'prebuilt', 'botboy-launcher');
    fs.truncateSync(binary, fs.statSync(binary).size - 16);
    fs.chmodSync(binary, 0o755);
    f.commit('truncate');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('native/botboy-launcher/prebuilt/botboy-launcher');
    expect(text(result)).toContain('does not match the manifest');
  });

  it('refuses a binary recorded as mode 100644, on disk too (Tier A: not executable)', () => {
    const f = fixture();
    const rel = 'native/vision-ocr/prebuilt/vision-ocr';
    fs.chmodSync(path.join(f.pkg, rel), 0o644);
    f.commit('lose the mode bit');
    expect(f.git('ls-tree', 'HEAD', `personal-productivity-tracker/${rel}`)).toMatch(/^100644 /);
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toMatch(/native\/vision-ocr\/prebuilt\/vision-ocr is not executable \(mode 644\)/);
  });

  it('refuses a binary that is 100644 in HEAD even when the file on disk is executable (Tier B: what git archive ships)', () => {
    const f = fixture();
    f.git('config', 'core.fileMode', 'false'); // a checkout that cannot see the mode: the disk looks fine, HEAD is wrong
    f.git('update-index', '--chmod=-x', 'personal-productivity-tracker/native/vision-ocr/prebuilt/vision-ocr');
    f.git('commit', '-q', '-m', 'lose the mode bit');
    expect(fs.statSync(path.join(f.pkg, 'native', 'vision-ocr', 'prebuilt', 'vision-ocr')).mode & 0o111).toBeGreaterThan(0);
    const result = f.release(['--preflight']);
    expect(result.status, text(result)).toBe(1);
    expect(text(result)).toMatch(/is mode 100644 in HEAD, it must be 100755/);
  });

  it('refuses an artifact that was removed from git but is still on disk', () => {
    const f = fixture();
    f.git('rm', '--cached', '-q', 'personal-productivity-tracker/native/botboy-launcher/prebuilt/botboy-launcher');
    f.git('commit', '-q', '-m', 'untrack the launcher');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('native/botboy-launcher/prebuilt/botboy-launcher');
  });

  it('refuses a new untracked file inside an allowlisted path (it would be missing from the snapshot)', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.pkg, 'src', 'new-module.ts'), 'export const x = 1;\n');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('Untracked files inside the release allowlist');
    expect(text(result)).toContain('src/new-module.ts');
  });

  it('ignores untracked files outside the allowlist, and files git ignores', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.pkg, 'scratch-notes.md'), 'dev only\n');
    fs.mkdirSync(path.join(f.pkg, 'src', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(f.dev, '.gitignore'), 'personal-productivity-tracker/src/ignored/\n');
    f.commit('ignore a folder');
    fs.writeFileSync(path.join(f.pkg, 'src', 'ignored', 'x.ts'), 'export {};\n');
    expect(f.release(['--preflight']).status).toBe(0);
  });

  it('still refuses uncommitted changes in the release inputs', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.pkg, 'start.sh'), '# uncommitted\n');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('Uncommitted changes in release inputs');
  });

  it('refuses when node is not on PATH, naming npm run release', () => {
    const f = fixture();
    const bin = path.join(f.root, 'bin');
    fs.mkdirSync(bin);
    const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(git, path.join(bin, 'git'));
    const result = f.release(['--preflight'], {}, { path: `${bin}:/usr/bin:/bin` });
    expect(result.status).toBe(1);
    expect(text(result)).toContain("Run the release through 'npm run release'");
  });

  it('rejects an unknown argument', () => {
    const f = fixture();
    const result = f.release(['--publish-now']);
    expect(result.status).toBe(2);
    expect(text(result)).toContain('usage: bash scripts/release.sh [--preflight]');
  });
});

devOnly('release.sh --preflight: the pinned private Node (node-runtime.pin)', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const customPin = (f: ReleaseFixture, extra: Partial<Parameters<typeof pinText>[0]> = {}) => {
    fs.writeFileSync(path.join(f.pkg, 'node-runtime.pin'), pinText({ version: '22.9.9', arm64: { sha256: HASH_A, bytes: 2_000_000 }, x64: { sha256: HASH_B, bytes: 2_100_000 }, ...extra }));
    f.commit('pin another Node');
  };
  const published = (arm = HASH_A, x64 = HASH_B) => ({
    '/v22.9.9/SHASUMS256.txt': { body: shasums([{ name: 'node-v22.9.9-darwin-arm64.tar.gz', sha256: arm }, { name: 'node-v22.9.9-darwin-x64.tar.gz', sha256: x64 }]) },
    '/v22.9.9/node-v22.9.9-darwin-arm64.tar.gz': { body: Buffer.alloc(0), headLength: 2_000_000 },
    '/v22.9.9/node-v22.9.9-darwin-x64.tar.gz': { body: Buffer.alloc(0), headLength: 2_100_000 },
  });

  it('passes with the real pin when nodejs.org cannot be reached, and says the hashes were NOT compared (the test URL is a closed port)', () => {
    const f = fixture();
    const result = f.release(['--preflight']);
    expect(result.status, text(result)).toBe(0);
    expect(result.stdout).toContain('node-runtime.pin: Node 24.');
    expect(result.stderr).toContain('were NOT compared with the published ones');
  });
  it('refuses a malformed pin and names the file and the fix', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.pkg, 'node-runtime.pin'), 'schema=1\nversion=22\n');
    f.commit('break the pin');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('node-runtime.pin is not valid');
    expect(text(result)).toContain('see the header of node-runtime.pin');
  });
  it('refuses an uncommitted change to the pin like any release input', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.pkg, 'node-runtime.pin'), '# edited\n');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('Uncommitted changes in release inputs');
    expect(text(result)).toContain('node-runtime.pin');
  });
  it('passes when the published hashes and sizes equal the pin, and refuses when one differs (a server on 127.0.0.1)', async () => {
    const f = fixture();
    customPin(f);
    const agree = await startDistServer(published());
    try {
      const ok = await f.releaseAsync(['--preflight'], { BOTBOY_TEST_NODE_DIST_URL: agree.url });
      expect(ok.status, text(ok)).toBe(0);
      expect(ok.stdout).toContain('both pinned hashes and sizes equal what nodejs.org publishes');
    } finally {
      await agree.close();
    }
    const differ = await startDistServer(published('c'.repeat(64)));
    try {
      const bad = await f.releaseAsync(['--preflight'], { BOTBOY_TEST_NODE_DIST_URL: differ.url });
      expect(bad.status, text(bad)).toBe(1);
      expect(text(bad)).toContain('pinned sha256 aaaaaaaaaaaa… but nodejs.org publishes cccccccccccc…');
      expect(text(bad)).toContain('Fix: take the values from https://nodejs.org/dist/v22.9.9/SHASUMS256.txt');
      expect(text(bad)).not.toContain('Release pre-flight passed');
    } finally {
      await differ.close();
    }
  });
});
devOnly('release.sh --preflight: the pinned private uv + CPython (python-runtime.pin)', () => {
  it('passes with the real pin when GitHub cannot be reached, and says the hashes were NOT compared (the test URL is a closed port)', () => {
    const f = fixture();
    const result = f.release(['--preflight']);
    expect(result.status, text(result)).toBe(0);
    expect(result.stdout).toContain('python-runtime.pin: uv 0.13.0 + CPython 3.13.16 (build 20261009');
    expect(result.stderr).toMatch(/could not reach 127\.0\.0\.1:9 .*the pinned hashes were NOT compared/);
  });
  it('refuses a malformed pin and names the file and the fix, before anything is published', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.pkg, 'python-runtime.pin'), 'schema=1\nuv.version=0.13\n');
    f.commit('break the Python pin');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('python-runtime.pin is not valid');
    expect(text(result)).toContain('see the header of python-runtime.pin');
    expect(text(result)).not.toContain('Release pre-flight passed');
  });
  it('refuses an uncommitted change to the pin like any release input', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.pkg, 'python-runtime.pin'), '# edited\n');
    const result = f.release(['--preflight']);
    expect(result.status).toBe(1);
    expect(text(result)).toContain('python-runtime.pin');
  });
});
devOnly('the import check (finding 10): a shipped script may not import what the release does not ship', () => {
  const forms: Array<[string, string]> = [
    ['a static import', "import './not-shipped.mjs';\n"],
    ['an import with bindings', "import { thing } from './not-shipped.mjs';\nvoid thing;\n"],
    ['a dynamic import', "const loaded = await import('./not-shipped.mjs');\nvoid loaded;\n"],
    ['an export-from', "export { thing } from './not-shipped.mjs';\n"],
    ['createRequire', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./not-shipped.mjs');\n"],
    ['new URL with import.meta.url', "const where = new URL('./not-shipped.json', import.meta.url);\nvoid where;\n"],
  ];
  for (const [name, code] of forms) {
    it(`refuses ${name}, naming file and line`, () => {
      const f = fixture();
      const script = path.join(f.pkg, 'scripts', 'bootstrap-deps.mjs');
      const before = fs.readFileSync(script, 'utf8');
      fs.writeFileSync(script, `${before}\n${code}`);
      fs.writeFileSync(path.join(f.pkg, 'scripts', code.includes('.json') ? 'not-shipped.json' : 'not-shipped.mjs'), 'export const thing = 1;\n');
      f.commit('import a file that is not shipped');
      const lineOfImport = `${before}\n${code}`.split('\n').findIndex((line) => line.includes('not-shipped')) + 1;
      const result = f.release(['--preflight']);
      expect(result.status, text(result)).toBe(1);
      expect(text(result)).toContain(`scripts/bootstrap-deps.mjs:${lineOfImport}`);
      expect(text(result)).toContain('which scripts/release.sh does not ship');
    });
  }

  it('accepts an import of an allowlisted script, and non-file specifiers', () => {
    const f = fixture();
    const script = path.join(f.pkg, 'scripts', 'bootstrap-deps.mjs');
    fs.appendFileSync(script, "\nimport fs from 'node:fs';\nimport './native-prebuilt.mjs';\nconst dynamic = await import('./native-prebuilt.mjs');\nvoid fs; void dynamic;\n");
    f.commit('import shipped things');
    expect(f.release(['--preflight']).status).toBe(0);
  });

  it('refuses an import of a file that is neither shipped nor present', () => {
    const f = fixture();
    // process-now.mjs is shipped but is not part of the builder's own imports, so the check can report it.
    fs.appendFileSync(path.join(f.pkg, 'scripts', 'process-now.mjs'), "\nimport './native-prebuilt-missing.mjs';\n");
    f.commit('import a missing file');
    const result = f.release(['--preflight']);
    expect(result.status, text(result)).toBe(1);
    expect(text(result)).toContain('scripts/process-now.mjs');
    expect(text(result)).toContain('which scripts/release.sh does not ship');
  });

  it('the real tree passes its own check', () => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'build-native-prebuilt.mjs'), '--check-imports'], { cwd: packageRoot, encoding: 'utf8' });
    expect(result.status, text(result)).toBe(0);
  });
});

devOnly('the whole release against a local bare repository (it cannot reach the real one)', () => {
  it('publishes one snapshot commit with the artifacts executable, the release marker, and then reports nothing to release', () => {
    const f = fixture();
    const result = f.release();
    expect(result.status, text(result)).toBe(0);
    expect(result.stdout).toContain('Released dev@');
    expect(result.stdout).toContain(f.origin);
    const sha = f.headSha();
    expect(f.gitIn(f.origin, 'log', '-1', '--format=%s', 'main')).toMatch(new RegExp(`^release: dev@${sha} \\(\\d{4}-\\d{2}-\\d{2}\\)\x24`));
    const tree = f.gitIn(f.origin, 'ls-tree', '-r', 'main');
    for (const artifact of ['native/vision-ocr/prebuilt/vision-ocr', 'native/botboy-launcher/prebuilt/botboy-launcher']) {
      expect(tree, artifact).toMatch(new RegExp(`^100755 blob \\w+\\t${artifact}\x24`, 'm'));
    }
    expect(tree).toMatch(/\t\.botboy-distribution$/m);
    expect(tree).toMatch(/\tREADME\.md$/m);
    expect(tree).not.toContain('scripts/build-native-prebuilt.mjs');
    // The pinned private Node ships (start.sh reads it); its dev-only verifier does not.
    expect(tree).toMatch(/\tnode-runtime\.pin$/m);
    expect(tree).not.toContain('scripts/verify-node-runtime.mjs');
    // The same for the pinned private uv + CPython.
    expect(tree).toMatch(/\tpython-runtime\.pin$/m);
    expect(tree).not.toContain('scripts/verify-python-runtime.mjs');
    expect(tree).not.toContain('docs/release/');
    // Run again: nothing new.
    const again = f.release();
    expect(again.status, text(again)).toBe(0);
    expect(again.stdout).toContain('Nothing to release');
    expect(f.gitIn(f.origin, 'rev-list', '--count', 'main')).toBe('2');
  });

  it('a refused release publishes nothing: the remote and the work clone are exactly as they were', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.pkg, 'native', 'botboy-launcher', 'main.swift'), '// changed without a rebuild\n');
    f.commit('edit source');
    const originBefore = f.originHead();
    const result = f.release();
    expect(result.status).toBe(1);
    expect(f.originHead()).toBe(originBefore);
    expect(fs.readdirSync(f.work).sort()).toEqual(['.git', 'README.md']);
  });
});

devOnly('the target guards (finding 5): a mis-set test can never reach the real botboy-app', () => {
  it('the harness itself refuses a remote URL, a remote work clone, and a missing file-only transport', () => {
    const f = fixture();
    expect(() => f.release([], { BOTBOY_RELEASE_URL: 'https://github.com/ybhagaab/botboy-app.git' })).toThrow(/not a local path/);
    expect(() => f.release([], { BOTBOY_RELEASE_URL: 'git@github.com:ybhagaab/botboy-app.git' })).toThrow(/not a local path/);
    expect(() => f.release([], { BOTBOY_RELEASE_WORKDIR: 'relative/work' })).toThrow(/not a local path/);
    expect(() => f.release([], { GIT_ALLOW_PROTOCOL: 'https' })).toThrow(/GIT_ALLOW_PROTOCOL must be file/);
    f.gitIn(f.work, 'remote', 'set-url', 'origin', 'https://github.com/ybhagaab/botboy-app.git');
    expect(() => f.release(['--preflight'])).toThrow(/work clone's origin is not a local path/);
    expect(isLocalPath(f.origin)).toBe(true);
    expect(isLocalPath('https://example.invalid/x.git')).toBe(false);
  });

  it('a custom work folder that is not a clone is refused before any clone or fetch, and is not created', () => {
    const f = fixture();
    const notAClone = path.join(f.root, 'not-a-clone');
    const result = f.release([], { BOTBOY_RELEASE_WORKDIR: notAClone });
    expect(result.status).toBe(1);
    expect(text(result)).toContain('is not a git clone. Refusing to clone for a custom work folder');
    expect(fs.existsSync(notAClone)).toBe(false);
  });

  it('BOTBOY_RELEASE_URL alone is refused: the default work clone belongs to the real botboy-app', () => {
    const f = fixture();
    const env = f.baseEnv({ BOTBOY_RELEASE_URL: f.origin, BOTBOY_TEST_XCODE_SELECT_BIN: path.join(f.stubs, 'xcode-select') });
    delete env.BOTBOY_RELEASE_WORKDIR;
    const result = spawnSync('bash', [path.join(f.pkg, 'scripts', 'release.sh')], { cwd: f.pkg, env, encoding: 'utf8', timeout: 120_000 });
    expect(result.status).toBe(1);
    expect(text(result)).toContain('BOTBOY_RELEASE_URL is for tests and needs BOTBOY_RELEASE_WORKDIR');
    expect(f.originHead()).toBeTruthy();
  });

  it('a work clone whose origin is not the release URL is refused before fetch and push', () => {
    const f = fixture();
    const other = path.join(f.root, 'other.git');
    spawnSync('git', ['init', '--bare', '-q', '-b', 'main', other], { env: f.baseEnv() });
    f.gitIn(f.work, 'remote', 'set-url', 'origin', other);
    const originBefore = f.originHead();
    const result = f.release();
    expect(result.status).toBe(1);
    expect(text(result)).toContain("The work clone's origin");
    expect(text(result)).toContain('is not the release URL');
    expect(f.originHead()).toBe(originBefore);
  });
});
