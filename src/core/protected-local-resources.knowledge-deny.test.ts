/**
 * Option A, final for now (owner, 2026-10-15; knowledge-library.md K2): commands BotBoy runs can READ the Knowledge
 * library and cannot WRITE it. Every write goes through the knowledge tools in the server process, which this profile
 * does not reach. The rule is the LAST one in the profile, so nothing above can re-open the folder.
 *
 * The profile cases are plain string checks. The live cases run the real /usr/bin/sandbox-exec against a folder with a
 * space in its name under a temporary base, never the owner's Documents or private state.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  modelCommandSandboxInvocation,
  modelProcessSandboxInvocation,
  registerWriteProtectedRoots,
  writeProtectedRootsInEffect,
} from './protected-local-resources.js';

const execFileAsync = promisify(execFile);
const PORTS = { appPort: 7778, cdpPort: 9222 };
const LIVE = fs.existsSync('/usr/bin/sandbox-exec');

let base: string;
let privateRoot: string;
let filesDir: string;
let root: string;
let elsewhere: string;

/** The profile as it was before the library existed, written out so an accidental change to it fails here. */
const baseline = () =>
  `(version 1) (allow default) (deny network-outbound (remote ip "localhost:7778")) (deny network-outbound (remote ip "localhost:9222")) (deny appleevent-send) (deny file-read* file-write* (subpath "${privateRoot}")) (allow file-read* file-write* (subpath "${filesDir}"))`;
const profileOf = () => modelProcessSandboxInvocation('/usr/bin/true', [], { privateRoot, filesDir, ...PORTS }).profile;
const denyRule = (folder: string) => `(deny file-write* (subpath "${folder}"))`;

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync('/private/tmp/kl-deny-'));
  privateRoot = path.join(base, 'home', '.personal-productivity-tracker');
  filesDir = path.join(privateRoot, 'files');
  root = path.join(base, 'Docs', 'BotBoy Knowledge');
  elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'analytics', 'lessons'), { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(root, 'GUIDE.md'), '# Guide\n');
  fs.writeFileSync(path.join(root, 'analytics', 'lessons', 'general.md'), '# Lessons\n');
  fs.writeFileSync(path.join(elsewhere, 'outside.md'), 'outside\n');
  fs.symlinkSync(path.join(root, 'analytics', 'lessons'), path.join(elsewhere, 'link-into-library'));
});

afterEach(() => {
  registerWriteProtectedRoots(null);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the write-deny in the model sandbox profile', () => {
  it('is byte-identical to the profile before the library existed without a provider, or while it answers null', () => {
    expect(profileOf()).toBe(baseline());
    registerWriteProtectedRoots(() => null);
    expect(profileOf()).toBe(baseline());
    expect(writeProtectedRootsInEffect({ privateRoot, filesDir })).toEqual([]);
    expect(modelCommandSandboxInvocation('true', { privateRoot, filesDir, ...PORTS }).profile).toBe(baseline());
  });

  it('adds one deny for the canonical root as the LAST rule, for every launch path', () => {
    registerWriteProtectedRoots(() => root);
    expect(profileOf()).toBe(`${baseline()} ${denyRule(root)}`);
    expect(profileOf().endsWith(denyRule(root))).toBe(true);
    expect(modelCommandSandboxInvocation('true', { privateRoot, filesDir, ...PORTS }).profile).toBe(`${baseline()} ${denyRule(root)}`);
    expect(writeProtectedRootsInEffect({ privateRoot, filesDir })).toEqual([root]);
  });

  it('writes the real path of a root that is spelled through a link', () => {
    const link = path.join(base, 'Docs Link');
    fs.symlinkSync(path.join(base, 'Docs'), link);
    registerWriteProtectedRoots(() => path.join(link, 'BotBoy Knowledge'));
    expect(profileOf().endsWith(denyRule(root))).toBe(true);
  });

  it('escapes quotes and backslashes in the folder name like every other rule', () => {
    const odd = path.join(base, 'Odd "Name" \\ Knowledge');
    registerWriteProtectedRoots(() => odd);
    expect(profileOf().endsWith('(deny file-write* (subpath "' + odd.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"))')).toBe(true);
  });

  it.each([
    ['a relative path', 'Documents/BotBoy Knowledge'],
    ['an empty string', ''],
    ['a path with a NUL byte', '/private/tmp/kl-deny-x/Knowledge\0'],
    ['a path with a line break', '/private/tmp/kl-deny-x/Know\nledge'],
  ])('adds nothing for %s', (_label, bad) => {
    registerWriteProtectedRoots(() => bad);
    expect(profileOf()).toBe(baseline());
  });

  it('adds nothing when the provider throws or answers something that is not a string', () => {
    registerWriteProtectedRoots(() => { throw new Error('boom'); });
    expect(profileOf()).toBe(baseline());
    registerWriteProtectedRoots(() => 42 as unknown as string);
    expect(profileOf()).toBe(baseline());
  });

  describe('when the provider answers several roots (a location change copies into a new folder while the old one stays current)', () => {
    const second = () => path.join(base, 'Second Docs', 'BotBoy Knowledge');

    it('adds one deny per root, in order, all after the baseline and last', () => {
      registerWriteProtectedRoots(() => [second(), root]);
      expect(profileOf()).toBe(`${baseline()} ${denyRule(second())} ${denyRule(root)}`);
      expect(profileOf().endsWith(denyRule(root))).toBe(true);
      expect(modelCommandSandboxInvocation('true', { privateRoot, filesDir, ...PORTS }).profile).toBe(`${baseline()} ${denyRule(second())} ${denyRule(root)}`);
      expect(writeProtectedRootsInEffect({ privateRoot, filesDir })).toEqual([second(), root]);
    });

    it('keeps the roots that can be honored and drops the rest, one by one', () => {
      registerWriteProtectedRoots(() => [privateRoot, 'relative/place', '', `${root}\0`, root, filesDir, 7 as unknown as string]);
      expect(writeProtectedRootsInEffect({ privateRoot, filesDir })).toEqual([root]);
      expect(profileOf()).toBe(`${baseline()} ${denyRule(root)}`);
    });

    it('names a root once when two spellings meet at the same real folder', () => {
      const link = path.join(base, 'Docs Alias');
      fs.symlinkSync(path.join(base, 'Docs'), link);
      registerWriteProtectedRoots(() => [path.join(link, 'BotBoy Knowledge'), root]);
      expect(writeProtectedRootsInEffect({ privateRoot, filesDir })).toEqual([root]);
    });

    it('adds nothing for an empty answer, exactly like null', () => {
      registerWriteProtectedRoots(() => []);
      expect(profileOf()).toBe(baseline());
      expect(writeProtectedRootsInEffect({ privateRoot, filesDir })).toEqual([]);
    });
  });

  it.each([
    ['BotBoy private state itself', () => privateRoot],
    ['a folder that contains private state', () => path.dirname(privateRoot)],
    ['a folder inside private state', () => path.join(privateRoot, 'knowledge')],
    ['the files workspace itself', () => filesDir],
    ['a folder inside the files workspace', () => path.join(filesDir, 'Knowledge')],
  ])('does not honor %s: the deny comes after the files-workspace allow and would block run_command', (_label, pick) => {
    registerWriteProtectedRoots(pick);
    expect(profileOf()).toBe(baseline());
    expect(writeProtectedRootsInEffect({ privateRoot, filesDir })).toEqual([]);
  });
});

describe.skipIf(!LIVE)('the real sandbox-exec around a library with a space in its name', () => {
  const run = (script: string, ...args: string[]) => {
    const invocation = modelProcessSandboxInvocation('/bin/sh', ['-c', script, 'sh', ...args], { privateRoot, filesDir, ...PORTS });
    return execFileAsync(invocation.executable, invocation.args, { timeout: 30_000 })
      .then((out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }))
      .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
  };

  it('reads fine, and every kind of write fails with "Operation not permitted" and changes nothing', async () => {
    registerWriteProtectedRoots(() => root);
    const guide = path.join(root, 'GUIDE.md');
    const lessons = path.join(root, 'analytics', 'lessons', 'general.md');

    const read = await run('cat "$1"', guide);
    expect(read).toMatchObject({ code: 0, stdout: '# Guide\n' });

    const denied: Array<[string, string, string[]]> = [
      ['append to a guide', 'printf x >> "$1"', [guide]],
      ['overwrite a lesson projection', 'printf x > "$1"', [lessons]],
      ['create a file', 'printf x > "$1/analytics/new.md"', [root]],
      ['create a folder', 'mkdir "$1/newdir"', [root]],
      ['truncate', ': > "$1"', [guide]],
      ['move a file out of the library (a delete in effect)', 'mv "$1" "$2/gone.md"', [guide, elsewhere]],
      ['move a file into the library', 'mv "$2/outside.md" "$1/analytics/moved.md"', [root, elsewhere]],
      ['write through a link that lives outside the library', 'printf x >> "$1/link-into-library/general.md"', [elsewhere]],
    ];
    for (const [label, script, args] of denied) {
      const result = await run(script, ...args);
      expect(result.code, label).not.toBe(0);
      expect(result.stderr, label).toMatch(/Operation not permitted/i);
    }

    expect(fs.readFileSync(guide, 'utf8')).toBe('# Guide\n');
    expect(fs.readFileSync(lessons, 'utf8')).toBe('# Lessons\n');
    expect(fs.existsSync(path.join(root, 'analytics', 'new.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'newdir'))).toBe(false);
    expect(fs.existsSync(path.join(elsewhere, 'gone.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'analytics', 'moved.md'))).toBe(false);
    expect(fs.readFileSync(path.join(elsewhere, 'outside.md'), 'utf8')).toBe('outside\n');
  }, 120_000);

  it('still lets the command write the files workspace and any other folder', async () => {
    registerWriteProtectedRoots(() => root);
    const inFiles = path.join(filesDir, 'ok.md');
    const inElsewhere = path.join(elsewhere, 'ok.md');
    expect(await run('printf ok > "$1"', inFiles)).toMatchObject({ code: 0 });
    expect(await run('printf ok > "$1"', inElsewhere)).toMatchObject({ code: 0 });
    expect(fs.readFileSync(inFiles, 'utf8')).toBe('ok');
    expect(fs.readFileSync(inElsewhere, 'utf8')).toBe('ok');
  }, 60_000);

  it('denies writes to both roots while a location change answers two, and still reads both', async () => {
    const incoming = path.join(base, 'Incoming Docs', 'BotBoy Knowledge');
    fs.mkdirSync(path.join(incoming, 'analytics'), { recursive: true });
    fs.writeFileSync(path.join(incoming, 'GUIDE.md'), '# Incoming\n');
    registerWriteProtectedRoots(() => [incoming, root]);
    expect(await run('cat "$1"', path.join(incoming, 'GUIDE.md'))).toMatchObject({ code: 0, stdout: '# Incoming\n' });
    for (const folder of [incoming, root]) {
      const result = await run('printf x > "$1/analytics/new-in-window.md"', folder);
      expect(result.code, folder).not.toBe(0);
      expect(result.stderr, folder).toMatch(/Operation not permitted/i);
      expect(fs.existsSync(path.join(folder, 'analytics', 'new-in-window.md')), folder).toBe(false);
    }
    expect(await run('printf ok > "$1"', path.join(elsewhere, 'still-writable.md'))).toMatchObject({ code: 0 });
  }, 90_000);

  it('does not deny anything while no library exists', async () => {
    const target = path.join(root, 'analytics', 'free.md');
    expect(await run('printf x > "$1"', target)).toMatchObject({ code: 0 });
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  }, 60_000);
});
