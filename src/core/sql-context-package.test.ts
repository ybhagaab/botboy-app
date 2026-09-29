import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareSqlContextVersions,
  createSqlContextPackageResolver,
  managedSqlContextCopies,
  newestSupportedRelease,
  SQL_CONTEXT_PACKAGE_NAME,
  type SqlContextPackageCopy,
} from './sql-context-package.js';

const directories: string[] = [];
afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});
function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-context-package-'));
  directories.push(directory);
  return directory;
}

/** Lays out one installed package the way npm does. */
function writePackage(packageDir: string, version: string, name = SQL_CONTEXT_PACKAGE_NAME): void {
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(packageDir, 'dist', 'index.js'), '// server\n');
}

function bundledAt(version: string): () => SqlContextPackageCopy {
  const dir = path.join(tempDir(), 'node_modules', SQL_CONTEXT_PACKAGE_NAME);
  writePackage(dir, version);
  return () => ({ version, entry: path.join(dir, 'dist', 'index.js'), source: 'bundled' });
}

const fakeInstall = (installedVersion?: string) => vi.fn(async (version: string, prefix: string) => {
  writePackage(path.join(prefix, 'node_modules', SQL_CONTEXT_PACKAGE_NAME), installedVersion ?? version);
});

describe('sql-context package versions', () => {
  it('picks the newest stable release in the supported major line', () => {
    expect(newestSupportedRelease(['1.3.0', '1.10.0', '1.9.9', '2.0.0', '1.11.0-beta.1', 'junk'])).toBe('1.10.0');
    expect(newestSupportedRelease(['2.0.0'])).toBeNull();
    expect(compareSqlContextVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSqlContextVersions('1.5.0', '1.5.0')).toBe(0);
  });
});

describe('sql-context package lifecycle (launch-time auto-update)', () => {
  it('installs a newer registry release into its own folder and launches it', async () => {
    const root = tempDir();
    const install = fakeInstall();
    const log = vi.fn();
    const resolver = createSqlContextPackageResolver({
      root, bundled: bundledAt('1.5.0'), fetchVersions: async () => ['1.4.0', '1.5.0', '1.6.2', '2.0.0'], install, log,
    });

    const chosen = await resolver.resolveLaunch();

    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0][0]).toBe('1.6.2');
    expect(chosen).toEqual({
      version: '1.6.2',
      entry: path.join(root, '1.6.2', 'node_modules', SQL_CONTEXT_PACKAGE_NAME, 'dist', 'index.js'),
      source: 'managed',
    });
    expect(fs.readdirSync(root)).toEqual(['1.6.2']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1.5.0 → 1.6.2'));
  });

  it('launches the newest local copy without installing when the registry has nothing newer', async () => {
    const root = tempDir();
    writePackage(path.join(root, '1.5.1', 'node_modules', SQL_CONTEXT_PACKAGE_NAME), '1.5.1');
    const install = fakeInstall();
    const resolver = createSqlContextPackageResolver({ root, bundled: bundledAt('1.5.0'), fetchVersions: async () => ['1.5.0', '1.5.1'], install });
    await expect(resolver.resolveLaunch()).resolves.toMatchObject({ version: '1.5.1', source: 'managed' });
    expect(install).not.toHaveBeenCalled();
  });

  it('falls back to the newest local copy when the registry is unreachable', async () => {
    const log = vi.fn();
    const resolver = createSqlContextPackageResolver({
      root: tempDir(), bundled: bundledAt('1.5.0'), log,
      fetchVersions: async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); },
    });
    await expect(resolver.resolveLaunch()).resolves.toMatchObject({ version: '1.5.0', source: 'bundled' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('update check skipped'));
  });

  it.each([
    ['a failed install', vi.fn(async () => { throw new Error('npm install failed: E401'); })],
    ['an install that produced another version', fakeInstall('1.6.1')],
  ])('keeps the local copy and no partial folder after %s', async (_label, install) => {
    const root = tempDir();
    const resolver = createSqlContextPackageResolver({ root, bundled: bundledAt('1.5.0'), fetchVersions: async () => ['1.6.2'], install });
    await expect(resolver.resolveLaunch()).resolves.toMatchObject({ version: '1.5.0', source: 'bundled' });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('checks the registry at most once per interval, so restart loops stay local', async () => {
    let clock = 0;
    const fetchVersions = vi.fn(async () => ['1.5.0']);
    const resolver = createSqlContextPackageResolver({ root: tempDir(), bundled: bundledAt('1.5.0'), fetchVersions, now: () => clock });
    await resolver.resolveLaunch();
    clock += 60_000;
    await resolver.resolveLaunch();
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    clock += 10 * 60_000;
    await resolver.resolveLaunch();
    expect(fetchVersions).toHaveBeenCalledTimes(2);
  });

  it('keeps the two newest installs and ignores foreign or other-major folders', async () => {
    const root = tempDir();
    for (const version of ['1.3.0', '1.4.0', '1.5.0']) writePackage(path.join(root, version, 'node_modules', SQL_CONTEXT_PACKAGE_NAME), version);
    writePackage(path.join(root, '2.0.0', 'node_modules', SQL_CONTEXT_PACKAGE_NAME), '2.0.0');
    writePackage(path.join(root, '1.9.0', 'node_modules', SQL_CONTEXT_PACKAGE_NAME), '1.9.0', 'someone-else');
    const resolver = createSqlContextPackageResolver({ root, bundled: () => null, fetchVersions: async () => ['1.6.0'], install: fakeInstall() });
    await expect(resolver.resolveLaunch()).resolves.toMatchObject({ version: '1.6.0' });
    expect(managedSqlContextCopies(root).map(copy => copy.version)).toEqual(['1.5.0', '1.6.0']);
  });

  // BotBoy's shutdown aborts the launch preparation: npm is killed, nothing
  // partial stays behind, and the next launch checks again.
  it('cancels an install when BotBoy stops and retries at the next launch', async () => {
    const root = tempDir();
    const stop = new AbortController();
    let installSignal: AbortSignal | undefined;
    // The first install hangs until BotBoy stops; the retry completes.
    const install = vi.fn((version: string, prefix: string, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      if (!signal) {
        writePackage(path.join(prefix, 'node_modules', SQL_CONTEXT_PACKAGE_NAME), version);
        resolve();
        return;
      }
      installSignal = signal;
      fs.writeFileSync(path.join(prefix, 'partial'), '');
      signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
    }));
    const fetchVersions = vi.fn(async () => ['1.6.0']);
    const log = vi.fn();
    const resolver = createSqlContextPackageResolver({ root, bundled: bundledAt('1.5.0'), fetchVersions, install, log });

    const pending = resolver.resolveLaunch({ signal: stop.signal });
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    stop.abort();

    await expect(pending).resolves.toMatchObject({ version: '1.5.0', source: 'bundled' });
    expect(installSignal?.aborted).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cancelled because BotBoy is stopping'));
    // A cancelled check does not count: the next launch checks and installs.
    await expect(resolver.resolveLaunch()).resolves.toMatchObject({ version: '1.6.0', source: 'managed' });
    expect(fetchVersions).toHaveBeenCalledTimes(2);
  });

  it('names the fix when no copy exists at all', async () => {
    const resolver = createSqlContextPackageResolver({
      root: tempDir(), bundled: () => null,
      fetchVersions: async () => { throw new Error('offline'); },
    });
    await expect(resolver.resolveLaunch()).rejects.toThrow(/npm install/);
  });
});
