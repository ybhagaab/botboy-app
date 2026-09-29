import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * sql-context-presets-mcp keeps its own release lifecycle, like any MCP.
 *
 * Each time BotBoy launches the connector it asks npm for the newest release
 * in the supported major line. When that release is newer than every copy on
 * this machine, BotBoy installs it into its own package folder (never into
 * BotBoy's node_modules) and starts it; otherwise it starts the newest local
 * copy. The copy bundled with BotBoy is the fallback, so an unreachable
 * registry or a failed install never takes SQL down.
 */
export const SQL_CONTEXT_PACKAGE_NAME = 'sql-context-presets-mcp';
/** Releases in this major line keep the tool names and documented output contracts BotBoy reads. */
export const SQL_CONTEXT_SUPPORTED_MAJOR = 1;
export const SQL_CONTEXT_REGISTRY = 'https://registry.npmjs.org';

const REGISTRY_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 180_000;
/** A crash-restart loop must not query the registry on every attempt. */
const CHECK_INTERVAL_MS = 10 * 60_000;
/** The newest two installs stay, so a still-exiting previous child keeps its files. */
const KEEP_MANAGED_VERSIONS = 2;

export interface SqlContextPackageCopy {
  version: string;
  /** The server entry point (`dist/index.js`) run with BotBoy's node. */
  entry: string;
  source: 'managed' | 'bundled';
}

export function sqlContextPackagesDir(homeDir = os.homedir()): string {
  return path.join(homeDir, '.personal-productivity-tracker', 'mcp-packages', SQL_CONTEXT_PACKAGE_NAME);
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Semver order of two stable `x.y.z` versions; unparseable versions sort first. */
export function compareSqlContextVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Newest stable release in the supported major line; pre-releases never auto-install. */
export function newestSupportedRelease(versions: readonly string[], major = SQL_CONTEXT_SUPPORTED_MAJOR): string | null {
  return versions
    .filter(version => parseVersion(version)?.[0] === major)
    .sort(compareSqlContextVersions)
    .at(-1) ?? null;
}

function readCopy(packageDir: string, source: SqlContextPackageCopy['source']): SqlContextPackageCopy | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    const entry = path.join(packageDir, 'dist', 'index.js');
    if (manifest.name !== SQL_CONTEXT_PACKAGE_NAME || typeof manifest.version !== 'string'
      || !parseVersion(manifest.version) || !fs.statSync(entry).isFile()) return null;
    return { version: manifest.version, entry, source };
  } catch {
    return null;
  }
}

/** The copy installed with BotBoy itself (its package.json dependency). */
export function bundledSqlContextCopy(): SqlContextPackageCopy | null {
  try {
    const require = createRequire(import.meta.url);
    return readCopy(path.dirname(require.resolve(`${SQL_CONTEXT_PACKAGE_NAME}/package.json`)), 'bundled');
  } catch {
    return null;
  }
}

/** Installs BotBoy made earlier: `<root>/<version>/node_modules/<package>`. */
export function managedSqlContextCopies(root: string): SqlContextPackageCopy[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter(name => parseVersion(name)?.[0] === SQL_CONTEXT_SUPPORTED_MAJOR)
    .map(name => readCopy(path.join(root, name, 'node_modules', SQL_CONTEXT_PACKAGE_NAME), 'managed'))
    .filter((copy): copy is SqlContextPackageCopy => copy !== null && parseVersion(copy.version)?.[0] === SQL_CONTEXT_SUPPORTED_MAJOR)
    .sort((a, b) => compareSqlContextVersions(a.version, b.version));
}

/** Registry versions of the package (abbreviated metadata document). */
async function fetchRegistryVersions(signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`${SQL_CONTEXT_REGISTRY}/${SQL_CONTEXT_PACKAGE_NAME}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal,
  });
  if (!response.ok) throw new Error(`npm registry answered HTTP ${response.status}`);
  const body = await response.json() as { versions?: Record<string, unknown> };
  if (!body || typeof body.versions !== 'object' || body.versions === null) throw new Error('npm registry metadata has no versions');
  return Object.keys(body.versions);
}

/** npm's CLI next to BotBoy's node, run by that node, so PATH and shebangs never matter. */
function npmCommand(): { command: string; prefixArgs: string[] } {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  try {
    return { command: process.execPath, prefixArgs: [fs.realpathSync(beside)] };
  } catch {
    return { command: 'npm', prefixArgs: [] };
  }
}

/**
 * `npm install` of one exact release into an empty prefix. Lifecycle scripts
 * are off: the server is plain JavaScript and needs none. The signal kills
 * npm, so BotBoy's shutdown never waits for a download.
 */
async function npmInstall(version: string, prefix: string, signal?: AbortSignal): Promise<void> {
  const npm = npmCommand();
  await new Promise<void>((resolve, reject) => {
    execFile(npm.command, [
      ...npm.prefixArgs,
      'install',
      `${SQL_CONTEXT_PACKAGE_NAME}@${version}`,
      '--prefix', prefix,
      '--registry', SQL_CONTEXT_REGISTRY,
      '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      '--loglevel=error',
    ], {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
      ...(signal ? { signal } : {}),
    }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`npm install failed: ${String(stderr || error.message).trim().slice(0, 500)}`));
      else resolve();
    });
  });
}

export interface SqlContextPackageResolver {
  /**
   * The copy to launch now, after at most one update check per interval.
   * Aborting the signal (BotBoy stopping) ends a check or install at once and
   * falls back to the newest local copy.
   */
  resolveLaunch(options?: { signal?: AbortSignal }): Promise<SqlContextPackageCopy>;
}

export function createSqlContextPackageResolver(deps: {
  root?: string;
  fetchVersions?: (signal: AbortSignal) => Promise<string[]>;
  install?: (version: string, prefix: string, signal?: AbortSignal) => Promise<void>;
  bundled?: () => SqlContextPackageCopy | null;
  now?: () => number;
  log?: (message: string) => void;
} = {}): SqlContextPackageResolver {
  const root = deps.root ?? sqlContextPackagesDir();
  const fetchVersions = deps.fetchVersions ?? fetchRegistryVersions;
  const install = deps.install ?? npmInstall;
  const bundled = deps.bundled ?? bundledSqlContextCopy;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.log(`[MCP:sql-context] ${message}`));
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let checking: Promise<void> | null = null;

  function localCopies(): SqlContextPackageCopy[] {
    const copies = managedSqlContextCopies(root);
    const shipped = bundled();
    if (shipped) copies.push(shipped);
    // Newest last; on a tie the managed copy (already verified here) wins.
    return copies.sort((a, b) => compareSqlContextVersions(a.version, b.version)
      || (a.source === b.source ? 0 : a.source === 'managed' ? 1 : -1));
  }

  function prune(): void {
    for (const stale of managedSqlContextCopies(root).slice(0, -KEEP_MANAGED_VERSIONS)) {
      try {
        fs.rmSync(path.join(root, stale.version), { recursive: true, force: true });
      } catch {
        // an old copy that cannot be removed is harmless
      }
    }
  }

  async function checkForUpdate(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    let release: string | null;
    try {
      const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MS);
      release = newestSupportedRelease(await fetchVersions(signal ? AbortSignal.any([timeout, signal]) : timeout));
    } catch (error) {
      if (!signal?.aborted) log(`update check skipped (${error instanceof Error ? error.message : String(error)}); using the newest local copy`);
      return;
    }
    const newestLocal = localCopies().at(-1);
    if (!release || (newestLocal && compareSqlContextVersions(release, newestLocal.version) <= 0)) return;
    const target = path.join(root, release);
    const staging = path.join(root, `.staging-${release}-${process.pid}`);
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging);
      await install(release, staging, signal);
      if (signal?.aborted) throw new Error('BotBoy is stopping');
      const installed = readCopy(path.join(staging, 'node_modules', SQL_CONTEXT_PACKAGE_NAME), 'managed');
      if (!installed || installed.version !== release) throw new Error(`the installed package is not ${SQL_CONTEXT_PACKAGE_NAME}@${release}`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      log(`updated ${SQL_CONTEXT_PACKAGE_NAME} ${newestLocal?.version ?? 'none'} → ${release}`);
      prune();
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      log(signal?.aborted
        ? `update to ${release} cancelled because BotBoy is stopping; it retries at the next launch`
        : `update to ${release} failed (${error instanceof Error ? error.message : String(error)}); using the newest local copy`);
    }
  }

  async function resolveLaunch(options: { signal?: AbortSignal } = {}): Promise<SqlContextPackageCopy> {
    if (!options.signal?.aborted && now() - lastCheckAt >= CHECK_INTERVAL_MS) {
      checking ??= checkForUpdate(options.signal).finally(() => {
        // A cancelled check does not count: the next launch checks again.
        if (!options.signal?.aborted) lastCheckAt = now();
        checking = null;
      });
      await checking;
    }
    const chosen = localCopies().at(-1);
    if (!chosen) throw new Error(`${SQL_CONTEXT_PACKAGE_NAME} is not installed. Run npm install in the BotBoy folder, then restart BotBoy.`);
    return chosen;
  }

  return { resolveLaunch };
}
