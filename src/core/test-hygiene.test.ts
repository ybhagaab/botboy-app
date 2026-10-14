/**
 * Test hygiene: no test may put UI on the owner's screen or register an app with macOS.
 *
 * 2026-10-13: a test run made "BotBoy launcher is stale" dialogs appear (the generated shell
 * launcher calls `osascript` when it finds no folder) and left a temporary BotBoy.app registered
 * with LaunchServices next to /Applications/BotBoy.app. vitest.no-ui-tools.setup.ts is the net
 * under every test file; this suite proves the net holds, and scans the tests for the other
 * half of the rule (a bundle test has a HOME and an lsregister stub of its own, and no test names
 * a temporary bundle like an app, because macOS assesses what looks like one once it runs).
 *
 * Nothing here ever starts the real osascript, open or lsregister: the refusal happens before a
 * process exists, and the arguments are harmless anyway.
 */
import cp, { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';

// A loaded Mac needs more than 5 s for the shell commands below.
vi.setConfig({ testTimeout: 60_000 });

type Guard = {
  stubDir: string;
  lsregisterStub: string;
  calls: () => string[];
  reset: () => void;
};
const guard = (globalThis as unknown as { __botboyUiGuard?: Guard }).__botboyUiGuard;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const srcRoot = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = path.resolve(srcRoot, '..');

afterEach(() => guard?.reset());

/** The run-level half of the net, loaded by path (it sits beside vitest.config.ts, outside src). */
const loadGlobalSetup = () => import(/* @vite-ignore */ pathToFileURL(path.join(packageRoot, 'vitest.no-ui-tools.global.ts')).href) as Promise<{
  default: () => () => void;
  RUN_DIR_ENV: string;
  RUN_DIR_PREFIX: string;
  sweepStaleRunFolders: (tmp?: string) => string[];
}>;

/** A nested vitest run in a private TMPDIR. It starts with no run folder of the outer run in its environment. */
function runNestedVitest(tmp: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  delete env.BOTBOY_TEST_UI_STUBS_RUN_DIR;
  return spawnSync(process.execPath, [path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', path.join(tmp, 'vitest.config.mjs'), '--root', tmp], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
    timeout: 90_000,
  });
}

describe('the net under every test file (vitest.no-ui-tools.setup.ts)', () => {
  it('is installed: stub tools come first on PATH and the lsregister hook defaults to a stub', () => {
    expect(guard, 'the setup file did not run').toBeTruthy();
    expect(process.env.PATH!.split(path.delimiter)[0]).toBe(guard!.stubDir);
    expect(process.env.BOTBOY_TEST_LSREGISTER_BIN).toBe(guard!.lsregisterStub);
    for (const name of ['osascript', 'open', 'lsregister', 'install_name_tool']) {
      expect(fs.statSync(path.join(guard!.stubDir, name)).mode & 0o111, name).toBeGreaterThan(0);
    }
    // No python3 stub: it would shadow every real python3 a test means to find (the real /usr/bin one is refused instead).
    expect(fs.existsSync(path.join(guard!.stubDir, 'python3'))).toBe(false);
  });

  describe('the two Xcode stand-ins, /usr/bin/python3 and /usr/bin/install_name_tool (Python on demand)', () => {
    // Both are xcselect shims: with the Command Line Tools they run Apple's tools, without them they raise the
    // "install developer tools" dialog. No test may run either. The refusal is RECORDED as well as thrown, so a
    // file whose code under test swallows the error still fails in the setup file's afterAll.
    const standIns: Array<[string, string, () => unknown]> = [
      ['python3', 'spawnSync', () => spawnSync('/usr/bin/python3', ['-V'])],
      ['python3', 'execFileSync', () => execFileSync('/usr/bin/python3', ['-V'])],
      ['python3', 'execFile', () => execFile('/usr/bin/python3', ['-V'], () => undefined)],
      ['python3', 'exec (a shell line)', () => exec('echo hi; /usr/bin/python3 -V', () => undefined)],
      ['python3', 'a bare name that PATH resolves to it', () => spawnSync('python3', ['-V'], { env: { PATH: '/usr/bin:/bin' } })],
      ['install_name_tool', 'spawnSync', () => spawnSync('/usr/bin/install_name_tool', ['-h'])],
      ['install_name_tool', 'execFileSync', () => execFileSync('/usr/bin/install_name_tool', ['-h'])],
    ];
    for (const [tool, how, attempt] of standIns) {
      it(`refuses the real ${tool} through ${how}, before any process starts, and records it`, () => {
        if (process.platform !== 'darwin') return;
        expect(attempt).toThrow(new RegExp(`would run the REAL ${tool}, an Xcode stand-in`));
        const calls = guard!.calls();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatch(new RegExp(`^REFUSED the real ${tool}: `));
      });
    }

    it('a bare install_name_tool reaches the recording stub, even with a PATH the test passes (uv looks it up by name)', () => {
      const result = spawnSync('/bin/sh', ['-c', 'command -v install_name_tool; install_name_tool -id x y'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(path.join(guard!.stubDir, 'install_name_tool'));
      expect(guard!.calls()).toEqual(['install_name_tool -id x y']);
    });

    it('lets a python3 that is not the stand-in through (a tripwire of the test\'s own, first on its PATH)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-hygiene-py-'));
      try {
        fs.writeFileSync(path.join(dir, 'python3'), '#!/bin/sh\necho tripwire-python\n', { mode: 0o755 });
        const result = spawnSync('python3', ['-V'], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' });
        expect(result.stdout.trim()).toBe('tripwire-python');
        expect(guard!.calls()).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  const refusals: Array<[string, string, () => unknown]> = [
    ['osascript', 'spawnSync', () => spawnSync('/usr/bin/osascript', ['-e', 'return 1'])],
    ['osascript', 'spawn', () => spawn('/usr/bin/osascript', ['-e', 'return 1'])],
    ['osascript', 'execFileSync', () => execFileSync('/usr/bin/osascript', ['-e', 'return 1'])],
    ['osascript', 'execFile', () => execFile('/usr/bin/osascript', ['-e', 'return 1'], () => undefined)],
    ['osascript', 'exec (a shell line)', () => exec('/usr/bin/osascript -e "return 1"', () => undefined)],
    ['osascript', 'execSync (a shell line)', () => execSync('echo hi; /usr/bin/osascript -e "return 1"')],
    ['open', 'spawnSync', () => spawnSync('/usr/bin/open', ['--help'])],
    ['open', 'execFileSync', () => execFileSync('/usr/bin/open', ['--help'])],
    ['lsregister', 'spawnSync', () => spawnSync(LSREGISTER, ['-h'])],
    ['lsregister', 'execFileSync', () => execFileSync(LSREGISTER, ['-h'])],
    ['lsregister', 'the module object itself', () => cp.spawnSync(LSREGISTER, ['-h'])],
  ];
  for (const [tool, how, attempt] of refusals) {
    it(`refuses to run the real ${tool} through ${how}, before any process starts`, () => {
      if (process.platform !== 'darwin') return;
      expect(attempt).toThrow(new RegExp(`would run the REAL ${tool}`));
      // Not even the stub ran: the refusal comes first.
      expect(guard!.calls()).toEqual([]);
    });
  }

  it('turns a bare tool name into the stub, even when the test passes a PATH of its own', () => {
    const result = spawnSync('/bin/sh', ['-c', 'command -v osascript open lsregister; osascript -e x; open -a Nothing; lsregister -f /nowhere'], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const resolved = result.stdout.split('\n').filter(Boolean);
    expect(resolved).toEqual([path.join(guard!.stubDir, 'osascript'), path.join(guard!.stubDir, 'open'), path.join(guard!.stubDir, 'lsregister')]);
    // They only record, and the afterAll check of the setup file reports a call that reaches one.
    expect(guard!.calls()).toEqual(['osascript -e x', 'open -a Nothing', 'lsregister -f /nowhere']);
  });

  it('gives a child the lsregister hook even when the test builds its environment from scratch, and keeps one the test sets', () => {
    const scratch = spawnSync('/bin/sh', ['-c', 'echo "$BOTBOY_TEST_LSREGISTER_BIN"'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(scratch.stdout.trim()).toBe(guard!.lsregisterStub);
    const own = spawnSync('/bin/sh', ['-c', 'echo "$BOTBOY_TEST_LSREGISTER_BIN"'], { env: { PATH: '/usr/bin:/bin', BOTBOY_TEST_LSREGISTER_BIN: '/tmp/my-stub' }, encoding: 'utf8' });
    expect(own.stdout.trim()).toBe('/tmp/my-stub');
  });

  it('keeps util.promisify(execFile) and util.promisify(exec) resolving { stdout, stderr }, and refuses the real tools through them too', async () => {
    const run = promisify(execFile);
    const out = await run('/bin/echo', ['hi']);
    expect(out.stdout.trim()).toBe('hi');
    expect(typeof out.stderr).toBe('string');
    const viaShell = await promisify(exec)('echo shell');
    expect(viaShell.stdout.trim()).toBe('shell');
    if (process.platform === 'darwin') {
      await expect(run('/usr/bin/osascript', ['-e', 'return 1'])).rejects.toThrow(/would run the REAL osascript/);
      await expect(promisify(exec)('/usr/bin/open --help')).rejects.toThrow(/would run the REAL open/);
    }
    expect(guard!.calls()).toEqual([]);
  });

  it('closes the Node download URL: a loopback port nothing listens on, also for a child whose environment a test builds from scratch', async () => {
    // start.sh and scripts/verify-node-runtime.mjs download BotBoy's private Node from nodejs.org. A test that
    // forgets to start its own server must get "connection refused", never the real nodejs.org.
    const url = new URL(process.env.BOTBOY_TEST_NODE_DIST_URL ?? '');
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    const refused = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: Number(url.port) });
      socket.once('connect', () => { socket.destroy(); resolve('connected'); });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');
    const child = spawnSync(process.execPath, ['-p', 'process.env.BOTBOY_TEST_NODE_DIST_URL'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(child.stdout.trim()).toBe(url.origin);
    const own = spawnSync(process.execPath, ['-p', 'process.env.BOTBOY_TEST_NODE_DIST_URL'], { env: { PATH: process.env.PATH ?? '', BOTBOY_TEST_NODE_DIST_URL: 'http://127.0.0.1:4242' }, encoding: 'utf8' });
    expect(own.stdout.trim()).toBe('http://127.0.0.1:4242'); // a test's own server URL is kept
  });

  it('closes the Python download URL the same way (scripts/python-runtime.sh and verify-python-runtime.mjs fetch from github.com)', () => {
    expect(process.env.BOTBOY_TEST_PYTHON_DIST_URL).toBe(process.env.BOTBOY_TEST_NODE_DIST_URL);
    const child = spawnSync(process.execPath, ['-p', 'process.env.BOTBOY_TEST_PYTHON_DIST_URL'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(child.stdout.trim()).toBe(process.env.BOTBOY_TEST_NODE_DIST_URL);
    const own = spawnSync(process.execPath, ['-p', 'process.env.BOTBOY_TEST_PYTHON_DIST_URL'], { env: { PATH: process.env.PATH ?? '', BOTBOY_TEST_PYTHON_DIST_URL: 'http://127.0.0.1:4343' }, encoding: 'utf8' });
    expect(own.stdout.trim()).toBe('http://127.0.0.1:4343');
  });
  it('lets ordinary commands through untouched', () => {
    expect(spawnSync('/usr/bin/true').status).toBe(0);
    expect(execFileSync('/bin/echo', ['hi'], { encoding: 'utf8' }).trim()).toBe('hi');
    expect(execSync('echo open osascript', { encoding: 'utf8' }).trim()).toBe('open osascript');
    expect(guard!.calls()).toEqual([]);
  });

  it('without a run folder, removes its own stub folder when a test file ends (vitest ends a worker with a signal, so an exit handler never runs)', () => {
    // A nested vitest run in a private TMPDIR, with the setup file alone (no globalSetup, so no run folder): when it
    // is over, that directory holds no stub folder. Before this check every test file left one behind (761 in a day).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-hygiene-clean-'));
    try {
      fs.writeFileSync(path.join(tmp, 'probe.test.ts'), "it('runs', () => { expect(1).toBe(1); });\n");
      fs.writeFileSync(path.join(tmp, 'vitest.config.mjs'), `export default { test: { globals: true, environment: 'node', include: ['probe.test.ts'], setupFiles: [${JSON.stringify(path.join(packageRoot, 'vitest.no-ui-tools.setup.ts'))}] } };\n`);
      const result = runNestedVitest(tmp);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readdirSync(tmp).filter((name) => name.startsWith('botboy-test-ui-stubs-'))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('with the run folder (vitest.no-ui-tools.global.ts), keeps every file\'s stubs until the run ends, so a process that outlives its file still finds a stub, then removes them all', () => {
    // Two probe files record the stub folder they were given. The real globalSetup is wrapped only to look at those
    // folders at the moment the run ends, before it removes them.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-hygiene-run-'));
    try {
      const seen = path.join(tmp, 'seen');
      fs.mkdirSync(seen);
      for (const name of ['one', 'two']) {
        fs.writeFileSync(path.join(tmp, `${name}.test.ts`), `import fs from 'node:fs';\nit('records its stub folder', () => { fs.writeFileSync(${JSON.stringify(path.join(seen, name))}, (globalThis as any).__botboyUiGuard.stubDir); });\n`);
      }
      fs.writeFileSync(path.join(tmp, 'global.ts'), [
        "import fs from 'node:fs';",
        `import real from ${JSON.stringify(path.join(packageRoot, 'vitest.no-ui-tools.global.ts'))};`,
        'export default function setup() {',
        '  const teardown = real();',
        '  return () => {',
        `    const folders = fs.readdirSync(${JSON.stringify(seen)}).sort().map((name) => fs.readFileSync(${JSON.stringify(seen)} + '/' + name, 'utf8'));`,
        `    fs.writeFileSync(${JSON.stringify(path.join(tmp, 'at-teardown.json'))}, JSON.stringify({ run: process.env.BOTBOY_TEST_UI_STUBS_RUN_DIR, folders, exist: folders.map((folder) => fs.existsSync(folder)) }));`,
        '    teardown();',
        '  };',
        '}',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(tmp, 'vitest.config.mjs'), `export default { test: { globals: true, environment: 'node', include: ['*.test.ts'], globalSetup: [${JSON.stringify(path.join(tmp, 'global.ts'))}], setupFiles: [${JSON.stringify(path.join(packageRoot, 'vitest.no-ui-tools.setup.ts'))}] } };\n`);
      const result = runNestedVitest(tmp);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const atEnd = JSON.parse(fs.readFileSync(path.join(tmp, 'at-teardown.json'), 'utf8')) as { run: string; folders: string[]; exist: boolean[] };
      expect(path.basename(atEnd.run)).toMatch(/^botboy-test-ui-stubs-run-\d+-/);
      expect(atEnd.folders).toHaveLength(2);
      expect(atEnd.exist, 'a file\'s stub folder was removed when the file ended').toEqual([true, true]);
      for (const folder of atEnd.folders) expect(path.dirname(folder), 'the stub folder is outside the run folder').toBe(atEnd.run);
      // The run is over: the main process removed the whole tree.
      expect(fs.readdirSync(tmp).filter((name) => name.startsWith('botboy-test-ui-stubs-'))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the run folder is named after its process, handed to the workers by environment, and removed by its own teardown', async () => {
    const global = await loadGlobalSetup();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-hygiene-global-'));
    const saved = { tmp: process.env.TMPDIR, run: process.env[global.RUN_DIR_ENV] };
    process.env.TMPDIR = tmp;
    try {
      const teardown = global.default();
      const folder = process.env[global.RUN_DIR_ENV]!;
      expect(fs.realpathSync(path.dirname(folder))).toBe(fs.realpathSync(tmp));
      expect(path.basename(folder)).toMatch(new RegExp(`^${global.RUN_DIR_PREFIX}${process.pid}-`));
      expect(fs.statSync(folder).isDirectory()).toBe(true);
      teardown();
      expect(fs.existsSync(folder)).toBe(false);
      expect(process.env[global.RUN_DIR_ENV]).toBeUndefined();
    } finally {
      if (saved.tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved.tmp;
      if (saved.run === undefined) delete process.env[global.RUN_DIR_ENV];
      else process.env[global.RUN_DIR_ENV] = saved.run;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a run that was killed outright leaves a folder that the next run sweeps; the folder of a run still going, and anything else, is left alone', async () => {
    const global = await loadGlobalSetup();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-hygiene-sweep-'));
    try {
      const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!; // exited by the time spawnSync returns
      const dead = `${global.RUN_DIR_PREFIX}${deadPid}-abc`;
      const live = `${global.RUN_DIR_PREFIX}${process.pid}-abc`;
      const others = [`${global.RUN_DIR_PREFIX}notapid-abc`, 'botboy-test-ui-stubs-12345', 'unrelated'];
      for (const name of [dead, live, ...others]) fs.mkdirSync(path.join(tmp, name));
      expect(global.sweepStaleRunFolders(tmp)).toEqual([dead]);
      expect(fs.readdirSync(tmp).sort()).toEqual([live, ...others].sort());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!fs.existsSync(path.join(packageRoot, 'scripts', 'release.sh')))('every file vitest.config.ts names is in the release allowlist: a teammate checkout cannot start vitest without it', () => {
    const config = fs.readFileSync(path.join(packageRoot, 'vitest.config.ts'), 'utf8');
    const named = [...config.matchAll(/'\.\/(vitest\.[\w.-]+\.ts)'/g)].map((match) => match[1]);
    expect(named, 'the pattern no longer sees setupFiles or globalSetup').toEqual(expect.arrayContaining(['vitest.setup.ts', 'vitest.no-ui-tools.setup.ts', 'vitest.no-ui-tools.global.ts']));
    const release = fs.readFileSync(path.join(packageRoot, 'scripts', 'release.sh'), 'utf8');
    for (const file of named) {
      expect(fs.existsSync(path.join(packageRoot, file)), `${file} is named by vitest.config.ts but missing`).toBe(true);
      expect(new RegExp(`^\\s+${file.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(release), `${file} is not in release.sh PATHS`).toBe(true);
    }
  });
});

describe('the tests themselves', () => {
  const testFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(test|testutil)\.ts$/.test(entry.name)) out.push(full);
      }
    };
    walk(srcRoot);
    return out;
  };
  const self = fileURLToPath(import.meta.url);

  it('no test or test helper names the real osascript, open, lsregister or install_name_tool', () => {
    const offenders = testFiles()
      .filter((file) => file !== self)
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return text.includes('/usr/bin/osascript') || text.includes("'/usr/bin/open'") || text.includes('LaunchServices.framework/Support/lsregister') || text.includes('/usr/bin/install_name_tool');
      })
      .map((file) => path.relative(srcRoot, file));
    expect(offenders, 'stub the tool (a recording script on PATH or the BOTBOY_TEST_* hook) instead').toEqual([]);
  });

  it('a test that runs the bundle builder or the launcher\'s app hooks names an lsregister stub and a HOME of its own', () => {
    const runsBundles = /make-app-bundle\.mjs|BOTBOY_TEST_APP_LAUNCHER_APPLY|BOTBOY_TEST_APP_PLIST_PATCH|installLauncher|chooseLauncher/;
    const offenders = testFiles()
      .filter((file) => file !== self)
      .filter((file) => runsBundles.test(fs.readFileSync(file, 'utf8')))
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        const stubbed = /BOTBOY_TEST_LSREGISTER_BIN|stubUiTools/.test(text);
        const privateHome = /\bHOME\b/.test(text);
        return !stubbed || !privateHome;
      })
      .map((file) => path.relative(srcRoot, file));
    expect(offenders, 'give the test its own HOME and an lsregister stub (stubUiTools in launcher-fixtures.testutil.ts)').toEqual([]);
  });

  it('no launcher or bundle test names its temporary bundle like an application', () => {
    const files = ['make-app-bundle.test.ts', 'launcher-app-bundle.test.ts', 'launcher-prebuilt.test.ts', 'launcher-migration.test.ts', 'launcher-arch.test.ts'];
    const offenders = files
      .map((name) => path.join(srcRoot, 'core', name))
      .filter((file) => fs.existsSync(file))
      .filter((file) => /path\.join\([^)\n]*\.app['"`]\)/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file));
    expect(offenders, "name it like 'bundle-under-test': macOS assesses and may register what looks like an app once something runs from it").toEqual([]);
  });
});
