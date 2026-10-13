/**
 * A release.sh harness that CANNOT publish (review 1, finding 5). Every call runs the real
 * scripts/release.sh and scripts/build-native-prebuilt.mjs against a throwaway "dev repo"
 * made here, with:
 *  - BOTBOY_RELEASE_URL and BOTBOY_RELEASE_WORKDIR pointing at a LOCAL bare repository and a
 *    clone of it (release.sh refuses the pair otherwise, and refuses either alone);
 *  - GIT_ALLOW_PROTOCOL=file, so git itself refuses http, https and ssh whatever a URL says;
 *  - a private HOME and no global git configuration;
 *  - a check, before each run, that the work clone's origin and the URL are absolute local paths.
 * The real botboy-app, ~/.cache/botboy-app-release and the real HOME are never named.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const identity = {
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
};

/** The PATHS=( ... ) allowlist of the real scripts/release.sh. */
export function allowlist(): string[] {
  const script = fs.readFileSync(path.join(packageRoot, 'scripts', 'release.sh'), 'utf8');
  const block = script.match(/^PATHS=\(\n([\s\S]*?)^\)/m);
  if (!block) throw new Error('release.sh PATHS block not found');
  return block[1].split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
}

export function isLocalPath(value: string): boolean {
  return path.isAbsolute(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.includes('@');
}

export type ReleaseFixture = ReturnType<typeof releaseFixture>;

export function releaseFixture(options: { artifacts?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-release-test-'));
  const dev = path.join(root, 'dev');
  const pkg = path.join(dev, 'personal-productivity-tracker');
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  const stubs = path.join(root, 'stubs');
  for (const dir of [pkg, home, stubs]) fs.mkdirSync(dir, { recursive: true });

  const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    ...identity,
    HOME: home,
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  });
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: baseEnv() });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
    return result.stdout.trim();
  };

  // 1. The package tree: every allowlisted path, with the real release/verify scripts and the real artifacts.
  const copy = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, rel), path.join(pkg, rel));
  };
  const real = ['scripts/release.sh', 'scripts/build-native-prebuilt.mjs', 'scripts/native-prebuilt.mjs', 'scripts/bootstrap-deps.mjs'];
  real.forEach(copy);
  if (options.artifacts !== false) {
    ['native/prebuilt-manifest.json', 'native/vision-ocr/main.swift', 'native/vision-ocr/prebuilt/vision-ocr', 'native/botboy-launcher/main.swift', 'native/botboy-launcher/prebuilt/botboy-launcher'].forEach(copy);
    for (const rel of ['native/vision-ocr/prebuilt/vision-ocr', 'native/botboy-launcher/prebuilt/botboy-launcher']) fs.chmodSync(path.join(pkg, rel), 0o755);
  }
  for (const entry of allowlist()) {
    const target = path.join(pkg, entry);
    if (fs.existsSync(target)) continue;
    if (path.extname(entry) || entry === 'start.sh') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.endsWith('.json') ? '{}\n' : entry.endsWith('.sh') ? '#!/bin/sh\n' : `// ${entry}\n`, { mode: entry.endsWith('.sh') ? 0o755 : 0o644 });
    } else {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'placeholder.txt'), `${entry}\n`);
    }
  }
  fs.mkdirSync(path.join(pkg, 'docs', 'release'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'docs', 'release', 'README.md'), '# botboy-app\n');
  fs.writeFileSync(path.join(pkg, 'docs', 'release', 'gitignore'), 'node_modules/\n');
  // The shipped TypeScript and the shipped scripts need no content for these checks.
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'src', 'index.ts'), 'export {};\n');

  git(dev, 'init', '-q', '-b', 'main');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'fixture');

  // 2. The local "release repository" and its work clone.
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', origin], { env: baseEnv() });
  const seed = path.join(root, 'seed');
  spawnSync('git', ['clone', '-q', origin, seed], { env: baseEnv() });
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  fs.rmSync(seed, { recursive: true, force: true });
  spawnSync('git', ['clone', '-q', origin, work], { env: baseEnv() });

  // 3. No Swift toolchain: the structural and rebuild tiers (C, D) are skipped, the hash/HEAD tiers are not.
  const noClt = path.join(stubs, 'xcode-select');
  fs.writeFileSync(noClt, '#!/bin/sh\nexit 2\n', { mode: 0o755 });

  const release = (args: string[] = [], extraEnv: Record<string, string> = {}, spawnOptions: { path?: string } = {}): SpawnSyncReturns<string> => {
    const env = baseEnv({
      BOTBOY_RELEASE_URL: origin,
      BOTBOY_RELEASE_WORKDIR: work,
      BOTBOY_TEST_XCODE_SELECT_BIN: noClt,
      ...extraEnv,
    });
    if (spawnOptions.path !== undefined) env.PATH = spawnOptions.path;
    // The structural guard of the harness: whatever a test passes, nothing here can name a remote.
    for (const key of ['BOTBOY_RELEASE_URL', 'BOTBOY_RELEASE_WORKDIR']) {
      if (env[key] && !isLocalPath(env[key])) throw new Error(`refusing to run release.sh: ${key} is not a local path (${env[key]})`);
    }
    if (env.GIT_ALLOW_PROTOCOL !== 'file') throw new Error('refusing to run release.sh: GIT_ALLOW_PROTOCOL must be file');
    if (fs.existsSync(path.join(env.BOTBOY_RELEASE_WORKDIR!, '.git'))) {
      const workOrigin = spawnSync('git', ['-C', env.BOTBOY_RELEASE_WORKDIR!, 'remote', 'get-url', 'origin'], { encoding: 'utf8', env: baseEnv() }).stdout.trim();
      if (!isLocalPath(workOrigin)) throw new Error(`refusing to run release.sh: the work clone's origin is not a local path (${workOrigin})`);
    }
    return spawnSync('bash', [path.join(pkg, 'scripts', 'release.sh'), ...args], { cwd: pkg, env, encoding: 'utf8', timeout: 180_000 });
  };

  return {
    root, dev, pkg, origin, work, home, stubs,
    git: (...args: string[]) => git(dev, ...args),
    gitIn: git,
    /** Commit every change in the fixture dev repo. */
    commit: (message = 'change') => {
      git(dev, 'add', '-A');
      git(dev, 'commit', '-q', '-m', message);
    },
    release,
    baseEnv,
    headSha: () => git(dev, 'rev-parse', '--short', 'HEAD'),
    originHead: () => git(origin, 'rev-parse', 'main'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
