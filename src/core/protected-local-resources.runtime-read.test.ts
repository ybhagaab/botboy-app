/**
 * Owner decision 2026-10-14 (B): a user-added MCP server must work on a Mac whose only Node is BotBoy's own copy
 * (`~/.personal-productivity-tracker/runtime/node-<version>-<chip>`, set up by start.sh). The sandbox around such a
 * server denies the whole private folder, so `npx` and `npm` failed with `Operation not permitted`. The profile now has
 * an explicit option, `runtimeReadDir`, that adds two rules: READ the runtime version folder in use, and read the
 * METADATA of the private root and `runtime/` as literals (Node's realpath walk lstats every parent). Nothing else.
 *
 * Every live case runs the real /usr/bin/sandbox-exec against a temporary HOME and private root with a copy of the
 * Node that runs this test and its npm, never the owner's ~/.personal-productivity-tracker. The copy is made with an
 * APFS clone where the volume allows it.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  pathValueWithFallbackDirectories,
  resolveCommandExecutable,
  resolveDefinitionExecutable,
  type McpServerDefinition,
} from './mcp-profiles.js';
import { createPrivateNodeFixture, livePrivateNode, RUNTIME_VERSION_NAME, type PrivateNodeFixture } from './private-node-fixture.testutil.js';
import {
  modelCommandSandboxInvocation,
  modelProcessSandboxInvocation,
  pathWithoutPrivateRuntime,
  privateRuntimeDirInUse,
  privateRuntimeRoot,
} from './protected-local-resources.js';

// The live cases run npm and node under sandbox-exec: slow when the machine is busy.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const execFileAsync = promisify(execFile);
const live = livePrivateNode;
const VERSION = RUNTIME_VERSION_NAME;

let fixture: PrivateNodeFixture;
let home: string;
let privateRoot: string;
let filesDir: string;
let runtimeRoot: string;
let versionDir: string;
let runtimeBin: string;
let nodeCopy: string;
let tools: string;

const PORTS = { appPort: 7778, cdpPort: 9222 };
/** The profile before the option existed, written out so an accidental change to it fails here. */
const baseline = (root: string, files: string) =>
  `(version 1) (allow default) (deny network-outbound (remote ip "localhost:7778")) (deny network-outbound (remote ip "localhost:9222")) (deny appleevent-send) (deny file-read* file-write* (subpath "${root}")) (allow file-read* file-write* (subpath "${files}"))`;
const profileOf = (options: Parameters<typeof modelProcessSandboxInvocation>[2] = {}) =>
  modelProcessSandboxInvocation('/usr/bin/true', [], { privateRoot, filesDir, ...PORTS, ...options }).profile;

beforeAll(() => {
  fixture = createPrivateNodeFixture();
  ({ home, privateRoot, filesDir, runtimeRoot, versionDir, runtimeBin, nodeCopy, tools } = fixture);
}, 120_000);

afterAll(() => {
  fixture?.cleanup();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the profile around a user-added MCP server', () => {
  it('is byte-identical to the profile before the option existed, whatever is not named', () => {
    const expected = baseline(privateRoot, filesDir);
    expect(profileOf()).toBe(expected);
    expect(profileOf({ runtimeReadDir: undefined })).toBe(expected);
    expect(profileOf({ runtimeReadDir: null })).toBe(expected);
    expect(profileOf({ runtimeReadDir: '' })).toBe(expected);
    // The model-run shell and the chat terminal never pass it: their profile is the same string.
    expect(modelCommandSandboxInvocation('true', { privateRoot, filesDir, ...PORTS }).profile).toBe(expected);
  });

  describe('adds nothing (fail closed) when the folder is not exactly a runtime version folder under the real private root', () => {
    const outside = () => path.join(home, 'elsewhere');
    /** [what is named, the folder, the private root the profile is built for (default: the fixture's)] */
    const cases: [string, () => string, (() => string)?][] = [
      ['a relative path', () => `runtime/${VERSION}`],
      ['a folder that does not exist', () => path.join(runtimeRoot, 'node-99.0.0-arm64')],
      ['a folder outside the private root with a version name', () => path.join(outside(), VERSION)],
      ['the runtime folder itself', () => runtimeRoot],
      ['the private root', () => privateRoot],
      ['the files workspace', () => filesDir],
      ['a folder under runtime/ that is not a version folder', () => path.join(runtimeRoot, '.download')],
      ['a folder whose name does not fit the pattern (no patch number)', () => path.join(runtimeRoot, 'node-24-arm64')],
      ['a folder inside the version folder', () => runtimeBin],
      ['a file named like a version folder', () => path.join(runtimeRoot, 'node-1.0.0-arm64')],
      ['a link named like a version folder that leads out of the runtime folder', () => path.join(runtimeRoot, 'node-2.0.0-arm64')],
      ['a version folder whose runtime/ is a link out of the private root', () => path.join(home, 'linked-root', 'runtime', VERSION), () => path.join(home, 'linked-root')],
    ];
    beforeAll(() => {
      fs.mkdirSync(path.join(outside(), VERSION), { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, 'node-1.0.0-arm64'), 'a file');
      fs.symlinkSync(path.join(outside(), VERSION), path.join(runtimeRoot, 'node-2.0.0-arm64'));
      fs.mkdirSync(path.join(outside(), 'runtime-elsewhere', VERSION), { recursive: true });
      fs.mkdirSync(path.join(home, 'linked-root'), { recursive: true });
      fs.symlinkSync(path.join(outside(), 'runtime-elsewhere'), path.join(home, 'linked-root', 'runtime'));
    });
    for (const [name, folder, root] of cases) {
      it(name, () => {
        const forRoot = root ? root() : privateRoot;
        const forFiles = root ? path.join(forRoot, 'files') : filesDir;
        expect(profileOf({ privateRoot: forRoot, filesDir: forFiles, runtimeReadDir: folder() })).toBe(baseline(forRoot, forFiles));
      });
    }
  });

  it('adds exactly two rules for the version folder in use: read it, and read the metadata of its two parents', () => {
    const profile = profileOf({ runtimeReadDir: versionDir });
    const added = ` (allow file-read* (subpath "${versionDir}")) (allow file-read-metadata (literal "${privateRoot}") (literal "${runtimeRoot}"))`;
    expect(profile).toBe(baseline(privateRoot, filesDir) + added);
    // After the private-root deny and the files allow, because the later rule wins.
    expect(profile.indexOf('(deny file-read* file-write*')).toBeLessThan(profile.indexOf('(allow file-read* (subpath'));
    // Read only, and metadata only for the parents (so they still cannot be listed).
    expect(added).not.toMatch(/file-write|process-exec|file-read-data|file-read\* \(literal/);
    expect(added.match(/\(allow /g)).toHaveLength(2);
  });

  it('names real paths: a link to the version folder, or a private root reached through a link, is resolved', () => {
    fs.symlinkSync(VERSION, path.join(runtimeRoot, 'node-1.2.3-x64'));
    expect(profileOf({ runtimeReadDir: path.join(runtimeRoot, 'node-1.2.3-x64') }))
      .toBe(baseline(privateRoot, filesDir) + ` (allow file-read* (subpath "${versionDir}")) (allow file-read-metadata (literal "${privateRoot}") (literal "${runtimeRoot}"))`);
    const linkedRoot = path.join(home, 'rootlink');
    fs.symlinkSync(privateRoot, linkedRoot);
    const viaLink = modelProcessSandboxInvocation('/usr/bin/true', [], { privateRoot: linkedRoot, ...PORTS, runtimeReadDir: path.join(linkedRoot, 'runtime', VERSION) }).profile;
    // The existing lines keep the spelling they were given; only the added rules are real paths.
    expect(viaLink).toBe(baseline(linkedRoot, path.join(linkedRoot, 'files'))
      + ` (allow file-read* (subpath "${versionDir}")) (allow file-read-metadata (literal "${privateRoot}") (literal "${runtimeRoot}"))`);
  });

  it('escapes quotes and backslashes in the folder names like every other path in the profile', () => {
    const odd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-odd "name" ')));
    try {
      const root = path.join(odd, '.personal-productivity-tracker');
      const dir = path.join(root, 'runtime', VERSION);
      fs.mkdirSync(dir, { recursive: true });
      const profile = modelProcessSandboxInvocation('/usr/bin/true', [], { privateRoot: root, ...PORTS, runtimeReadDir: dir }).profile;
      expect(profile).toContain(`(allow file-read* (subpath "${dir.replace(/"/g, '\\"')}"))`);
      expect(profile).not.toContain(`(subpath "${dir}")`);
    } finally {
      fs.rmSync(odd, { recursive: true, force: true });
    }
  });
});

describe('which runtime version folder is in use', () => {
  it('is the folder of the Node this process runs on, when that Node lies inside the runtime folder', () => {
    expect(privateRuntimeDirInUse({ execPath: nodeCopy, privateRoot })).toBe(versionDir);
  });

  it('counts a link into the runtime folder and ignores a link out of it: the real path decides', () => {
    fs.mkdirSync(path.join(home, 'bin-in'), { recursive: true });
    fs.symlinkSync(nodeCopy, path.join(home, 'bin-in', 'node'));
    expect(privateRuntimeDirInUse({ execPath: path.join(home, 'bin-in', 'node'), privateRoot })).toBe(versionDir);
    const away = path.join(runtimeRoot, 'node-5.5.5-arm64', 'bin');
    fs.mkdirSync(away, { recursive: true });
    fs.symlinkSync('/usr/bin/true', path.join(away, 'node'));
    expect(privateRuntimeDirInUse({ execPath: path.join(away, 'node'), privateRoot })).toBeNull();
  });

  it('is null on a Mac that uses its own Node, for a file that is no version folder\'s, and for what cannot be resolved', () => {
    expect(privateRuntimeDirInUse({ privateRoot })).toBeNull(); // this process's own Node, outside the temporary private root
    expect(privateRuntimeDirInUse({ execPath: path.join(tools, 'hello.js'), privateRoot })).toBeNull();
    expect(privateRuntimeDirInUse({ execPath: path.join(runtimeRoot, '.download', 'partial.part'), privateRoot })).toBeNull();
    expect(privateRuntimeDirInUse({ execPath: path.join(runtimeRoot, 'node-99.0.0-arm64', 'bin', 'node'), privateRoot })).toBeNull();
    expect(privateRuntimeDirInUse({ execPath: nodeCopy, privateRoot: path.join(home, 'no-such-root') })).toBeNull();
  });

  it('asks the home folder\'s private root when none is given (what the MCP manager does)', () => {
    vi.stubEnv('HOME', home);
    expect(privateRuntimeDirInUse({ execPath: nodeCopy })).toBe(versionDir);
    expect(profileOf({ privateRoot: undefined, filesDir: undefined, runtimeReadDir: privateRuntimeDirInUse({ execPath: nodeCopy }) }))
      .toBe(baseline(privateRoot, filesDir) + ` (allow file-read* (subpath "${versionDir}")) (allow file-read-metadata (literal "${privateRoot}") (literal "${runtimeRoot}"))`);
  });
});

describe.runIf(live)('live Seatbelt: a user-added server on BotBoy\'s own Node (real sandbox-exec, temporary private root)', () => {
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${runtimeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: home,
    npm_config_update_notifier: 'false',
    npm_config_cache: path.join(home, '.npm'),
    ...extra,
  });
  const sandboxed = (executable: string, args: string[], withRuntime = true) =>
    modelProcessSandboxInvocation(executable, args, { privateRoot, filesDir, ...PORTS, ...(withRuntime ? { runtimeReadDir: versionDir } : {}) });
  const run = async (invocation: { executable: string; args: string[] }, childEnv = env()) => {
    try {
      const done = await execFileAsync(invocation.executable, invocation.args, { cwd: filesDir, env: childEnv, timeout: 60_000 });
      return { ok: true, out: `${done.stdout}${done.stderr}` };
    } catch (error: any) {
      return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}` };
    }
  };
  const sh = (script: string, ...args: string[]) => sandboxed('/bin/sh', ['-c', script, 'sh', ...args]);
  const denied = (result: { ok: boolean; out: string }) => {
    expect(result.ok, result.out).toBe(false);
    expect(result.out).toMatch(/Operation not permitted/);
  };

  describe('what works', () => {
    it('npx --version runs from the runtime, and so does npm --version', async () => {
      const npx = await run(sandboxed(path.join(runtimeBin, 'npx'), ['--version']));
      expect(npx.ok, npx.out).toBe(true);
      expect(npx.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
      const npm = await run(sandboxed(path.join(runtimeBin, 'npm'), ['--version']));
      expect(npm.ok, npm.out).toBe(true);
      expect(npm.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }, 90_000);

    it('a script outside the private root that starts with #!/usr/bin/env node runs on the runtime\'s node', async () => {
      const result = await run(sandboxed(path.join(tools, 'hello.js'), []));
      expect(result.ok, result.out).toBe(true);
      expect(result.out.trim()).toBe(nodeCopy);
    }, 60_000);

    it('the files workspace still reads and writes, and the metadata of the two parents can be read', async () => {
      const written = await run(sh('echo workspace > "$1" && cat "$1"', path.join(filesDir, 'ok.txt')));
      expect(written.ok, written.out).toBe(true);
      expect(written.out.trim()).toBe('workspace');
      const stat = await run(sandboxed('/usr/bin/stat', ['-f', '%N', privateRoot]));
      expect(stat.ok, stat.out).toBe(true);
      const statRuntime = await run(sandboxed('/usr/bin/stat', ['-f', '%N', runtimeRoot]));
      expect(statRuntime.ok, statRuntime.out).toBe(true);
    });

    it('without the option the same npx and npm still fail with Operation not permitted (the reason for the rule)', async () => {
      denied(await run(sandboxed(path.join(runtimeBin, 'npx'), ['--version'], false)));
      denied(await run(sandboxed(path.join(runtimeBin, 'npm'), ['--version'], false)));
    }, 60_000);
  });

  describe('what stays denied with the rule', () => {
    it('the saved key and the database: read, and stat', async () => {
      for (const secret of ['ai-model.json', 'tracker.db']) {
        const read = await run(sh('cat "$1"', path.join(privateRoot, secret)));
        denied(read);
        expect(read.out).not.toContain('secretkey');
        expect(read.out).not.toContain('secret rows');
      }
      denied(await run(sandboxed('/usr/bin/stat', [path.join(privateRoot, 'ai-model.json')])));
    });

    it('a link inside the runtime that points at the saved key', async () => {
      const read = await run(sh('cat "$1"', path.join(versionDir, 'leak')));
      denied(read);
      expect(read.out).not.toContain('secretkey');
    });

    it('listing the private root and runtime/ (only their metadata is readable)', async () => {
      denied(await run(sandboxed('/bin/ls', [privateRoot])));
      denied(await run(sandboxed('/bin/ls', [runtimeRoot])));
    });

    it('an older runtime folder and the download folder: only the version folder in use is readable', async () => {
      denied(await run(sh('cat "$1"', path.join(runtimeRoot, 'node-22.1.2-arm64', 'old.txt'))));
      denied(await run(sh('cat "$1"', path.join(runtimeRoot, '.download', 'partial.part'))));
    });

    it('every write: inside the runtime, beside it, in the private root, and appending to the node binary', async () => {
      const before = fs.statSync(nodeCopy);
      for (const target of [path.join(versionDir, 'new.txt'), path.join(runtimeRoot, 'new.txt'), path.join(privateRoot, 'new.txt')]) {
        denied(await run(sh('echo x > "$1"', target)));
        expect(fs.existsSync(target), target).toBe(false);
      }
      denied(await run(sh('echo x >> "$1"', nodeCopy)));
      denied(await run(sh('echo x > "$1"', path.join(versionDir, 'LICENSE'))));
      const after = fs.statSync(nodeCopy);
      expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
      expect(fs.readFileSync(path.join(versionDir, 'LICENSE'), 'utf8')).toBe('license text\n');
    });

    it('deleting or renaming what is in the runtime', async () => {
      denied(await run(sh('rm "$1"', path.join(versionDir, 'LICENSE'))));
      denied(await run(sh('mv "$1" "$2"', path.join(versionDir, 'LICENSE'), path.join(versionDir, 'LICENSE.moved'))));
      denied(await run(sh('mv "$1" "$2"', path.join(runtimeRoot, '.download'), path.join(runtimeRoot, '.download2'))));
      expect(fs.existsSync(path.join(versionDir, 'LICENSE'))).toBe(true);
      expect(fs.existsSync(path.join(runtimeRoot, '.download'))).toBe(true);
    });
  });
});

describe.runIf(live)('a built-in or AIM server (no sandbox) on a Mac that uses BotBoy\'s own Node', () => {
  it('resolves node and npx to the runtime from the server\'s PATH, and npx --version runs', async () => {
    // What mcp-manager.ts › startServer does for every launch that is not a user-added command: the SDK's default
    // environment (it copies PATH, which start.sh put the runtime in front of), extended with the fallback folders.
    vi.stubEnv('PATH', `${runtimeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`);
    const childEnv = getDefaultEnvironment();
    childEnv.PATH = pathValueWithFallbackDirectories(childEnv.PATH ?? process.env.PATH);
    expect(childEnv.PATH.split(path.delimiter)[0]).toBe(runtimeBin);

    const builtIn = (executableName: string) => ({ launch: { type: 'local-executable', executableName } }) as unknown as McpServerDefinition;
    const npx = await resolveDefinitionExecutable(builtIn('npx'));
    const node = await resolveDefinitionExecutable(builtIn('node'));
    expect(npx).toBe(path.join(runtimeBin, 'npx'));
    expect(node).toBe(nodeCopy);
    // The same answer for a user-added command (which the manager then sandboxes).
    expect(await resolveCommandExecutable('npx', process.env.PATH)).toBe(npx);

    const run = await execFileAsync(npx!, ['--version'], { env: { ...childEnv, HOME: home, npm_config_update_notifier: 'false', npm_config_cache: path.join(home, '.npm') }, timeout: 60_000 });
    expect(`${run.stdout}${run.stderr}`.trim()).toMatch(/^\d+\.\d+\.\d+/);
    // An AIM wrapper script starts with a shebang line like this one and meets the same PATH.
    const wrapper = path.join(tools, 'aim-like.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\ncommand -v node\n', { mode: 0o755 });
    const seen = await execFileAsync(wrapper, [], { env: { ...childEnv, HOME: home } });
    expect(seen.stdout.trim()).toBe(nodeCopy);
  }, 120_000);
});

describe('the callers', () => {
  const source = (file: string) => fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

  it('the MCP manager passes the option to user-added servers only, and to nothing else', () => {
    const manager = source('mcp-manager.ts');
    expect(manager).toContain("modelProcessSandboxInvocation(executable, launchArgs, { runtimeReadDir: nodeUse?.runtimeDir, ...pythonSandboxOptions(");
    expect(manager.match(/modelProcessSandboxInvocation\(/g)).toHaveLength(1);
    expect(manager.match(/runtimeReadDir/g)).toHaveLength(1);
    // Every launch executable is looked up through the manager's helper, which adds the global bin for user-added commands only.
    expect(manager.match(/resolveDefinitionExecutable\(/g)).toHaveLength(1);
    expect(manager.match(/resolveExecutable\(/g)!.length).toBeGreaterThanOrEqual(7);
    // The sandbox call sits in the custom-command branch.
    expect(manager).toMatch(/profile\.launch\.type === 'custom-command'\s*\? modelProcessSandboxInvocation\(/);
  });

  it('run_command and the chat terminal get the rule only through modelShellLaunch, never by hand (protected-local-resources.chat-node.test.ts)', () => {
    for (const file of ['tool-executor.ts', 'chat-terminal.ts']) {
      expect(source(file), file).toContain('modelShellLaunch(');
      expect(source(file), file).not.toContain('runtimeReadDir');
      expect(source(file), file).not.toContain('privateRuntimeDirInUse');
    }
    // A child whose sandbox did not open the runtime still gets a PATH without it.
    expect(pathWithoutPrivateRuntime(`${runtimeBin}${path.delimiter}/usr/bin`, privateRuntimeRoot(home))).toBe('/usr/bin');
  });
});
