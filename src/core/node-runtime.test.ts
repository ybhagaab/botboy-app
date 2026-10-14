/**
 * BotBoy's private Node (scripts/node-runtime.sh, sourced by start.sh): the hermetic harness.
 *
 * Every case runs the real start.sh and scripts/node-runtime.sh from a throwaway folder with a private HOME, a
 * PATH of recording stubs plus /usr/bin:/bin:/usr/sbin:/sbin and no Node, a fake "nodejs.org" on 127.0.0.1 (a few shell
 * scripts packed into a real .tar.gz; see node-runtime.testutil.ts), and stubs for sysctl-facing facts (macOS
 * version, free disk, Command Line Tools). Nothing here reaches the network beyond loopback, runs a browser,
 * osascript, open, lsregister or a bundle, signals a process, or touches the owner's ~/.personal-productivity-tracker.
 * Tripwire stubs for git, xcrun, swiftc, python3, make, lipo, otool and vtool prove that the bare-Mac path never
 * touches an Xcode shim; `pgrep` is stubbed so that no run can see (or stop) a real BotBoy.
 *
 * The runs are async on purpose: the fake nodejs.org lives in this process and a blocking spawn would starve it.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeNodeTarball, pinText, startDistServer, type FakeTarball } from './node-runtime.testutil.js';

vi.setConfig({ testTimeout: 180_000 });

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
// scripts/verify-node-runtime.mjs is dev-only (not in the release allowlist): the one block that compares the bash
// reader with it skips in a botboy-app checkout instead of failing to load the whole file.
const verifierPresent = fs.existsSync(path.join(packageRoot, 'scripts', 'verify-node-runtime.mjs'));
const { readPin } = (verifierPresent ? await import('../../scripts/verify-node-runtime.mjs') : {}) as typeof import('../../scripts/verify-node-runtime.mjs');
const roots: string[] = [];
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const XCODE_SHIMS = ['git', 'xcrun', 'swiftc', 'python3', 'make', 'lipo', 'otool', 'vtool'];
type Run = { status: number | null; stdout: string; stderr: string };

type BoxOptions = {
  /** Version the pin names (also the version in the fake tarballs). */
  version?: string;
  /** Chip of the Mac: arm64 (default) or x64. */
  arch?: 'arm64' | 'x64';
  /** Command Line Tools present (xcode-select answers). Default: absent, the bare Mac. */
  clt?: boolean;
  /** Free disk in KB. */
  freeKb?: number;
  /** macOS version `sw_vers` prints. */
  macos?: string;
  /** The macOS floor the pin names (the real pin: 13.5). */
  minMacos?: string;
  /** Pin only these chips. */
  chips?: ('arm64' | 'x64')[];
  /** Tarball options per chip (broken node, wrong version text, ...). */
  tarball?: Partial<Parameters<typeof fakeNodeTarball>[1]>;
  /** The dist server answers only after this many ms. */
  withServer?: boolean;
};

function box(options: BoxOptions = {}) {
  const version = options.version ?? '22.1.2';
  const arch = options.arch ?? 'arm64';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-node-runtime-'));
  roots.push(root);
  const app = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const home = path.join(root, 'home');
  const dl = path.join(root, 'dl');
  for (const d of [path.join(app, 'scripts'), stubs, home, dl]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'start.sh'), path.join(app, 'start.sh'));
  fs.chmodSync(path.join(app, 'start.sh'), 0o755);
  fs.copyFileSync(path.join(packageRoot, 'scripts', 'node-runtime.sh'), path.join(app, 'scripts', 'node-runtime.sh'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'x' }));
  const log = path.join(root, 'launcher.log');
  const stub = (name: string, body: string, dir = stubs) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const tripwire = path.join(root, 'tripwire.log');
  fs.writeFileSync(tripwire, '');
  for (const name of XCODE_SHIMS) stub(name, `echo "${name} $*" >> '${tripwire}'\nexit 0`);
  stub('pgrep', 'exit 1');
  const curlCalls = path.join(root, 'curl-calls.log');
  const tarCalls = path.join(root, 'tar-calls.log');
  const realTool = (name: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate))!;
  const curl = stub('curl-recorder', `echo "$@" >> '${curlCalls}'\nexec '${realTool('curl')}' "$@"`);
  const tar = stub('tar-recorder', `echo "$@" >> '${tarCalls}'\nexec '${realTool('tar')}' "$@"`);
  const xcodeSelect = stub('xcode-select', options.clt ? 'echo /stub/clt' : 'exit 2');
  const swVers = stub('sw_vers', `echo '${options.macos ?? '14.5'}'`);
  const df = stub('df', `echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho '/dev/stub 100000000 1 ${options.freeKb ?? 50_000_000} 1% /'`);
  const fileTool = stub('file', "echo 'ASCII text'");
  const chromeDummy = path.join(root, 'chrome-dummy');
  fs.writeFileSync(chromeDummy, '');

  // The tarballs and the pin
  const chips = options.chips ?? ['arm64', 'x64'];
  const tarballs: Partial<Record<'arm64' | 'x64', FakeTarball>> = {};
  const makeTarballs = (v: string, extra: Partial<Parameters<typeof fakeNodeTarball>[1]> = options.tarball ?? {}) => {
    const out: Partial<Record<'arm64' | 'x64', FakeTarball>> = {};
    for (const chip of ['arm64', 'x64'] as const) {
      const sub = path.join(dl, `${v}-${chip}`);
      fs.mkdirSync(sub, { recursive: true });
      out[chip] = fakeNodeTarball(sub, { version: v, arch: chip, padBytes: 200_000, ...extra });
    }
    return out;
  };
  Object.assign(tarballs, makeTarballs(version));
  const writePin = (v: string, set: Partial<Record<'arm64' | 'x64', FakeTarball>>, pinChips = chips) => {
    fs.writeFileSync(path.join(app, 'node-runtime.pin'), pinText({
      version: v,
      minMacos: options.minMacos,
      arm64: pinChips.includes('arm64') && set.arm64 ? { sha256: set.arm64.sha256, bytes: set.arm64.bytes } : null,
      x64: pinChips.includes('x64') && set.x64 ? { sha256: set.x64.sha256, bytes: set.x64.bytes } : null,
    }));
  };
  writePin(version, tarballs);

  const systemNode = (versionText: string, smoke: 'pass' | 'fail' = 'fail') =>
    stub('node', `case "$1" in --version) echo '${versionText}' ;; -e) exit ${smoke === 'pass' ? 0 : 1} ;; *) exit 0 ;; esac`, path.join(root, 'sysnode'));

  const env = (extra: Record<string, string> = {}): Record<string, string> => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM', 'BOTBOY_NODE_RUNTIME', 'BOTBOY_TEST_NODE_BIN']) delete base[key];
    return {
      ...base,
      HOME: home,
      PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
      PPT_LOG_FILE: log,
      PPT_STARTUP_SAFETY_BLOCK: path.join(root, 'safety-block.json'),
      PPT_PID_FILE: path.join(root, 'ppt.pid'),
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_HW_ARM64: arch === 'arm64' ? '1' : '0',
      BOTBOY_TEST_SHELL_TRANSLATED: '0',
      BOTBOY_TEST_ARCH_PROBE_OK: '0',
      BOTBOY_TEST_FILE_BIN: fileTool,
      BOTBOY_TEST_CHROME_BIN: chromeDummy,
      BOTBOY_TEST_NODE_BIN: 'none',
      // start.sh adds /usr/local/bin and /opt/homebrew/bin to PATH: a Node installed there on the Mac that runs the tests
      // must not change what a case finds, so those two folders are left out of the search (the private HOME's are not).
      BOTBOY_TEST_NO_HOST_BIN_DIRS: '1',
      BOTBOY_TEST_GIT_SHIM: path.join(stubs, 'git'),
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_XCRUN_BIN: path.join(stubs, 'xcrun'),
      BOTBOY_TEST_SW_VERS_BIN: swVers,
      BOTBOY_TEST_DF_BIN: df,
      BOTBOY_TEST_CURL_BIN: curl,
      BOTBOY_TEST_TAR_BIN: tar,
      BOTBOY_TEST_XATTR_BIN: stub('xattr', 'exit 1'),
      BOTBOY_TEST_LSOF_BIN: stub('lsof', ''),
      ...extra,
    };
  };
  const run = (hook: string | null, args: string[] = [], extra: Record<string, string> = {}) => new Promise<Run>((resolve) => {
    const child = spawn('/bin/bash', [path.join(app, 'start.sh'), ...args], { cwd: app, env: env({ ...(hook ? { [hook]: '1' } : {}), ...extra }) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const runtimeRoot = path.join(home, '.personal-productivity-tracker', 'runtime');
  const decision = (r: Run) => Object.fromEntries(r.stdout.split('\n').filter((line) => /^[a-z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) as Record<string, string>;
  const serve = async (extra: Record<string, Parameters<typeof startDistServer>[0][string]> = {}, v = version, set = tarballs) => {
    const files: Record<string, Parameters<typeof startDistServer>[0][string]> = {};
    for (const chip of ['arm64', 'x64'] as const) if (set[chip]) files[`/v${v}/${set[chip]!.name}`] = { body: set[chip]!.body };
    const server = await startDistServer({ ...files, ...extra });
    servers.push(server);
    return server;
  };
  return {
    root, app, stubs, home, log, tripwire, runtimeRoot, tarballs, stub, systemNode, env, run, decision, serve, makeTarballs, writePin, version, arch,
    runtimeDir: (v = version, chip = arch) => path.join(runtimeRoot, `node-${v}-${chip}`),
    tripwireCalls: () => fs.readFileSync(tripwire, 'utf8').split('\n').filter(Boolean),
    curlCalls: () => (fs.existsSync(curlCalls) ? fs.readFileSync(curlCalls, 'utf8').split('\n').filter(Boolean) : []),
    tarCalls: () => (fs.existsSync(tarCalls) ? fs.readFileSync(tarCalls, 'utf8').split('\n').filter(Boolean) : []),
    logText: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
    leftovers: () => (fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot).filter((name) => name.startsWith('node-') === false).sort() : []),
    runtimes: () => (fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot).filter((name) => name.startsWith('node-')).sort() : []),
    downloadsLeft: () => { const d = path.join(runtimeRoot, '.download'); return fs.existsSync(d) ? fs.readdirSync(d) : []; },
  };
}
type Box = ReturnType<typeof box>;
const ENSURE = 'BOTBOY_TEST_NODE_ENSURE';
const SELECT = 'BOTBOY_TEST_NODE_SELECT';
const text = (r: Run) => `${r.stdout}\n${r.stderr}`;
const requestsFor = (server: { requests: { method: string; url: string }[] }) => server.requests.filter((request) => request.method === 'GET');

describe('a Mac with no Node at all', () => {
  it('downloads the pinned Node once, checks it, unpacks it into the runtime folder and uses it (the whole first run)', async () => {
    const b = box();
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    const d = b.decision(r);
    expect(d.source).toBe('private');
    expect(d.node).toBe(path.join(b.runtimeDir(), 'bin', 'node'));
    expect(d.path_first).toBe(path.join(b.runtimeDir(), 'bin'));
    expect(d.needs_runtime).toBe('0');
    expect(d.chip).toBe('arm64');
    expect(r.stdout).toContain('BotBoy needs a working Node.js, and no Node was found on this Mac. Setting up its own copy: Node v22.1.2 for Apple silicon (about 1 MB) from nodejs.org. It is checked against a checksum kept in this folder before it is unpacked into ~/.personal-productivity-tracker/runtime, and only BotBoy uses it.');
    expect(r.stdout).toContain('✅ Node v22.1.2 is ready (checksum verified)');
    expect(requestsFor(server).map((request) => request.url)).toEqual([`/v22.1.2/${b.tarballs.arm64!.name}`]);
    // Complete, smoke-tested, marked, and nothing else left behind.
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
    expect(b.leftovers()).toEqual(['.download']);
    expect(b.downloadsLeft()).toEqual([]);
    expect(fs.readFileSync(path.join(b.runtimeDir(), '.botboy-runtime'), 'utf8')).toMatch(/^version=22\.1\.2\narch=arm64\nsource=http:\/\/127\.0\.0\.1:\d+\/v22\.1\.2\ninstalled=\d{4}-\d\d-\d\dT/);
    expect(fs.statSync(path.join(b.runtimeDir(), 'bin', 'node')).mode & 0o111).toBeGreaterThan(0);
    // The log says the same, and the bare-Mac path never touched an Xcode shim.
    expect(b.logText()).toContain('✅ Node v22.1.2 is ready (checksum verified)');
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('downloads nothing at the second start, and the first line of PATH is the runtime', async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    const before = server.requests.length;
    for (const hook of [SELECT, ENSURE]) {
      const r = await b.run(hook, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
      expect(r.status, text(r)).toBe(0);
      expect(b.decision(r)).toMatchObject({ source: 'private', needs_runtime: '0', node: path.join(b.runtimeDir(), 'bin', 'node'), path_first: path.join(b.runtimeDir(), 'bin') });
      expect(r.stdout).not.toContain('Setting up BotBoy');
    }
    expect(server.requests.length).toBe(before);
    expect(b.curlCalls()).toHaveLength(1);
  });

  it('selects the x64 tarball on an Intel Mac and the arm64 one on Apple silicon', async () => {
    for (const arch of ['x64', 'arm64'] as const) {
      const b = box({ arch });
      const server = await b.serve();
      const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
      expect(r.status, text(r)).toBe(0);
      expect(b.decision(r)).toMatchObject({ source: 'private', chip: arch, node: path.join(b.runtimeDir('22.1.2', arch), 'bin', 'node') });
      expect(requestsFor(server).map((request) => request.url)).toEqual([`/v22.1.2/node-v22.1.2-darwin-${arch}.tar.gz`]);
      expect(r.stdout).toContain(arch === 'arm64' ? 'for Apple silicon' : 'for Intel');
    }
  });

  it('says so, and downloads nothing, when the pin has no build for this Mac\'s processor', async () => {
    const b = box({ arch: 'x64', chips: ['arm64'] });
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("BotBoy's Node has no build for this Mac's processor (Intel).");
    expect(r.stdout).toContain('Next: Install Node from nodejs.org for this Mac, then run ./start.sh again.');
    expect(server.requests).toEqual([]);
    expect(b.runtimes()).toEqual([]);
  });

  it('refuses a macOS older than the pin\'s floor, with the way to update', async () => {
    const b = box({ macos: '10.15.7' });
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("BotBoy's Node v22.1.2 needs macOS 11.0 or newer, and this Mac runs macOS 10.15.7.");
    expect(r.stdout).toContain('Update macOS in System Settings > General > Software Update');
    expect(server.requests).toEqual([]);
    expect(b.runtimes()).toEqual([]);
  });

  it('refuses a full disk before it downloads or creates anything', async () => {
    const b = box({ freeKb: 400_000 });
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Not enough free disk space to set up BotBoy\'s Node: it needs about 1 GB free and this Mac has 0.4 GB.');
    expect(r.stdout).toContain('Next: Free some space, then run ./start.sh again.');
    expect(server.requests).toEqual([]);
    expect(fs.existsSync(path.join(b.home, '.personal-productivity-tracker'))).toBe(false);
  });
});

describe('when the download goes wrong', () => {
  it('offline (nothing listens): names the connection, the VPN and the proxy, leaves no partial folder, and offers the way around', async () => {
    const b = box();
    const r = await b.run(ENSURE); // the test setup's closed loopback port
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Could not reach nodejs\.org to download Node \(curl exit 7\)\./);
    expect(r.stdout).toContain('Next: Check your internet connection, VPN or proxy, then run ./start.sh again.');
    expect(r.stdout).toContain('Or install Node 24 or newer from nodejs.org yourself (the LTS download; its installer needs no other tools), then run ./start.sh again.');
    expect(b.runtimes()).toEqual([]);
    expect(b.leftovers().filter((name) => name !== '.download')).toEqual([]);
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('a hash mismatch deletes the file, never unpacks it, and says not to run it', async () => {
    const b = box();
    // Same size, other bytes: it reaches the hash check.
    const wrong = Buffer.from(b.tarballs.arm64!.body);
    wrong[wrong.length - 1] ^= 0xff;
    const server = await b.serve({ [`/v22.1.2/${b.tarballs.arm64!.name}`]: { body: wrong } });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("BotBoy deleted the Node download: its checksum does not match the one BotBoy has on record (expected ");
    expect(r.stdout).toContain('It was not unpacked or run.');
    expect(r.stdout).toContain('Try another network and run ./start.sh again; if it repeats, tell the owner.');
    expect(b.tarCalls()).toEqual([]); // never extracted
    expect(b.runtimes()).toEqual([]);
    expect(b.downloadsLeft()).toEqual([]);
    expect(requestsFor(server)).toHaveLength(1); // a first download that never resumed is not retried
  });

  it('a damaged partial file is dropped and fetched fresh once; a second mismatch still refuses', async () => {
    const b = box();
    const name = b.tarballs.arm64!.name;
    fs.mkdirSync(path.join(b.runtimeRoot, '.download'), { recursive: true });
    fs.writeFileSync(path.join(b.runtimeRoot, '.download', `${name}.part`), Buffer.alloc(1000, 1)); // garbage start of the file
    const good = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: good.url });
    expect(r.status, text(r)).toBe(0);
    expect(good.requests.filter((request) => request.method === 'GET').map((request) => request.range)).toEqual(['bytes=1000-', null]);
    const b2 = box();
    const wrong = Buffer.from(b2.tarballs.arm64!.body);
    wrong[0] ^= 0xff;
    fs.mkdirSync(path.join(b2.runtimeRoot, '.download'), { recursive: true });
    fs.writeFileSync(path.join(b2.runtimeRoot, '.download', `${b2.tarballs.arm64!.name}.part`), wrong.subarray(0, 1000));
    const bad = await b2.serve({ [`/v22.1.2/${b2.tarballs.arm64!.name}`]: { body: wrong } });
    const r2 = await b2.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: bad.url });
    expect(r2.status).toBe(1);
    expect(r2.stdout).toContain('its checksum does not match');
    expect(b2.runtimes()).toEqual([]);
    expect(b2.tarCalls()).toEqual([]);
  });

  it('an interrupted download resumes with a Range request and finishes', async () => {
    const b = box();
    const name = b.tarballs.arm64!.name;
    const half = Math.floor(b.tarballs.arm64!.bytes / 2);
    const server = await b.serve({ [`/v22.1.2/${name}`]: { body: b.tarballs.arm64!.body, cutAfter: half, cutTimes: 1 } });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    const gets = requestsFor(server);
    expect(gets).toHaveLength(2);
    expect(gets[0].range).toBeNull();
    expect(gets[1].range).toMatch(/^bytes=\d+-$/);
    expect(Number(/bytes=(\d+)-/.exec(gets[1].range!)![1])).toBeGreaterThan(0);
    expect(b.decision(r).source).toBe('private');
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
  });

  it('a partial file from an earlier run is resumed, not started again', async () => {
    const b = box();
    const name = b.tarballs.arm64!.name;
    fs.mkdirSync(path.join(b.runtimeRoot, '.download'), { recursive: true });
    fs.writeFileSync(path.join(b.runtimeRoot, '.download', `${name}.part`), b.tarballs.arm64!.body.subarray(0, 5000));
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(requestsFor(server).map((request) => request.range)).toEqual(['bytes=5000-']);
  });

  it('a server that cannot resume starts the file over', async () => {
    const b = box();
    const name = b.tarballs.arm64!.name;
    fs.mkdirSync(path.join(b.runtimeRoot, '.download'), { recursive: true });
    fs.writeFileSync(path.join(b.runtimeRoot, '.download', `${name}.part`), b.tarballs.arm64!.body.subarray(0, 5000));
    const server = await b.serve({ [`/v22.1.2/${name}`]: { body: b.tarballs.arm64!.body, ignoreRange: true } });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
  });

  it('keeps going to the end of its attempts, then names the interruption', async () => {
    const b = box();
    const name = b.tarballs.arm64!.name;
    const server = await b.serve({ [`/v22.1.2/${name}`]: { body: b.tarballs.arm64!.body, cutAfter: 1000 } }); // every response is cut
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/The download of Node was interrupted \(curl exit \d+\)\./);
    expect(r.stdout).toContain('Next: Run ./start.sh again; it resumes where it stopped.');
    expect(b.runtimes()).toEqual([]);
    expect(fs.statSync(path.join(b.runtimeRoot, '.download', `${name}.part`)).size).toBeGreaterThan(0); // kept, so the next run resumes
  });

  it('a file nodejs.org no longer serves is named as such', async () => {
    const b = box();
    const server = await b.serve({ [`/v22.1.2/${b.tarballs.arm64!.name}`]: { body: Buffer.alloc(0), status: 404 } });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('nodejs.org did not serve BotBoy\'s Node file (curl exit 22: the answer was an error).');
    expect(r.stdout).toContain('Tell the owner: the pinned Node may have been removed from nodejs.org.');
  });

  it('a network that replaces secure connections (curl exit 60) is named, with where to go next', async () => {
    const b = box();
    const tls = b.stub('curl-tls', 'exit 60');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_CURL_BIN: tls });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Your network is replacing secure connections to nodejs.org, so the download was refused (curl exit 60).');
    expect(r.stdout).toContain('Ask IT, or try another network');
    expect(b.runtimes()).toEqual([]);
  });

  it('an archive that does not hold the Node folder, or a Node that does not run, is refused and removed', async () => {
    const wrongTop = box({ tarball: { brokenNode: true } });
    const server = await wrongTop.serve();
    const r = await wrongTop.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("BotBoy's Node was unpacked but does not run here");
    expect(r.stdout).toContain('BotBoy removed it.');
    expect(wrongTop.runtimes()).toEqual([]);
    expect(wrongTop.leftovers().filter((name) => name !== '.download')).toEqual([]);
    expect(requestsFor(server)).toHaveLength(1); // one attempt per run: no loop
    const wrongVersion = box({ tarball: { versionOutput: 'v20.0.0' } });
    const s2 = await wrongVersion.serve();
    const r2 = await wrongVersion.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: s2.url });
    expect(r2.status).toBe(1);
    expect(r2.stdout).toContain('its bin/node said "v20.0.0" instead of v22.1.2');
    const noNpm = box({ tarball: { withoutNpm: true } });
    const s3 = await noNpm.serve();
    const r3 = await noNpm.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: s3.url });
    expect(r3.status).toBe(1);
    expect(r3.stdout).toContain('npm is missing from it');
    expect(noNpm.runtimes()).toEqual([]);
  });
});

describe('where the download comes from, where it goes, and what it leaves behind', () => {
  it('uses only https, or http on this Mac, as the download address; anything else is ignored for nodejs.org', async () => {
    const cases: [string, string][] = [
      ['http://example.test/dist', 'https://nodejs.org/dist'],
      ['ftp://example.test/dist', 'https://nodejs.org/dist'],
      ['http://127.0.0.1.example.test/dist', 'https://nodejs.org/dist'], // a look-alike host is not loopback
      ['http://localhost.example.test/dist', 'https://nodejs.org/dist'],
      ['http://127.0.0.1:8123/dist/', 'http://127.0.0.1:8123/dist'],
      ['http://localhost:8123', 'http://localhost:8123'],
      ['https://mirror.example/dist', 'https://mirror.example/dist'],
    ];
    for (const [given, expected] of cases) {
      const b = box();
      const asked = path.join(b.root, 'curl-asked.log');
      const curl = b.stub('curl-asks', `echo "$@" >> '${asked}'\nexit 7`); // records the address and never connects
      const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: given, BOTBOY_TEST_CURL_BIN: curl });
      expect(r.status, given).toBe(1);
      const lines = fs.readFileSync(asked, 'utf8').trim().split('\n');
      expect(lines, given).toHaveLength(1);
      expect(lines[0].split(' ').pop(), given).toBe(`${expected}/v22.1.2/${b.tarballs.arm64!.name}`);
    }
  });

  it('refuses a home folder that is not an absolute path before it creates anything', async () => {
    for (const home of ['relative-home', '']) {
      const b = box();
      const r = await b.run(ENSURE, [], { HOME: home });
      expect(r.status, home).toBe(1);
      expect(r.stdout, home).toContain(`BotBoy cannot place its Node: this Mac's home folder (${home}) is not usable.`);
      expect(fs.existsSync(path.join(b.app, 'relative-home', '.personal-productivity-tracker', 'runtime')), home).toBe(false);
      expect(b.curlCalls(), home).toEqual([]);
    }
  });

  it('clears macOS\'s download flag from the unpacked files, and only when there is one', async () => {
    const run = async (flagged: boolean) => {
      const b = box();
      const calls = path.join(b.root, 'xattr-calls.log');
      const xattr = b.stub('xattr-recorder', `echo "$@" >> '${calls}'\ncase "$1" in -p) exit ${flagged ? 0 : 1} ;; *) exit 0 ;; esac`);
      const server = await b.serve();
      const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url, BOTBOY_TEST_XATTR_BIN: xattr });
      expect(r.status, text(r)).toBe(0);
      return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
    };
    const withFlag = await run(true);
    expect(withFlag.some((line) => /^-p com\.apple\.quarantine \S+\/\.extract-\d+\/node-v22\.1\.2-darwin-arm64\/bin\/node$/.test(line))).toBe(true);
    expect(withFlag.some((line) => /^-r -d com\.apple\.quarantine \S+\/\.extract-\d+\/node-v22\.1\.2-darwin-arm64$/.test(line))).toBe(true);
    const withoutFlag = await run(false);
    expect(withoutFlag.filter((line) => line.startsWith('-r'))).toEqual([]);
  });

  it('does not swap BotBoy\'s own Node for another one on Apple silicon, even when its architecture reads as Intel-only', async () => {
    const b = box();
    const server = await b.serve();
    expect((await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url })).status).toBe(0);
    // A Homebrew Node with an arm64 slice, and a `file` that calls everything else Intel-only: the swap that
    // start.sh makes for a leftover Intel Node on PATH must leave BotBoy's own copy alone.
    b.stub('node', 'echo v99.0.0', path.join(b.home, 'homebrew', 'bin'));
    const file = b.stub('file-by-path', `case "$2" in */homebrew/*) echo 'Mach-O 64-bit executable arm64' ;; *) echo 'Mach-O 64-bit executable x86_64' ;; esac`);
    const r = await b.run(SELECT, [], { BOTBOY_TEST_FILE_BIN: file });
    expect(b.decision(r)).toMatchObject({ source: 'private', node: path.join(b.runtimeDir(), 'bin', 'node') });
  });

  it('a failed native check names BotBoy\'s own Node in its next step, and not "run npm install" from the user\'s shell', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    expect((await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url })).status).toBe(0);
    const status = 'better-sqlite3|Could not locate the bindings file.';
    const own = await b.run(null, [], { BOTBOY_TEST_NATIVE_FAILURE: status });
    expect(own.status, text(own)).toBe(0);
    expect(own.stdout).toContain('❌ BotBoy did not start: its native modules do not work with Node v22.1.2');
    expect(own.stdout).toContain("(npm install ran with BotBoy's own Node), then run ./start.sh again");
    expect(own.stdout).not.toContain('Next: run npm install in');
    const theirs = await b.run(null, [], { BOTBOY_TEST_NATIVE_FAILURE: status, BOTBOY_TEST_NODE_BIN: b.systemNode('v24.1.0') });
    expect(theirs.stdout).toContain('Next: run npm install in');
    expect(theirs.stdout).not.toContain("BotBoy's own Node");
  });
});

describe('the "usable Node" rule: a Mac whose Node works keeps it', () => {
  it('a working Node 22 is used as it is: no download, no private folder, no PATH change beyond its own folder', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const node = b.systemNode('v22.4.0');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.decision(r)).toMatchObject({ source: 'system', node, needs_runtime: '0', reason: '', path_first: path.dirname(node) });
    expect(server.requests).toEqual([]);
    expect(b.curlCalls()).toEqual([]);
    expect(fs.existsSync(path.join(b.home, '.personal-productivity-tracker'))).toBe(false);
  });

  it('finds a Node in the n and nvm folders when none is on PATH, as start.sh always did, and keeps it', async () => {
    for (const layout of ['.nvm/versions/node/v22.4.0', 'n/n/versions/node/22.4.0', '.n/versions/node/22.4.0']) {
      const b = box({ clt: true });
      const server = await b.serve();
      const node = b.stub('node', 'case "$1" in --version) echo v22.4.0 ;; *) exit 0 ;; esac', path.join(b.home, layout, 'bin'));
      const env = b.env({ [SELECT]: '1', BOTBOY_TEST_NODE_DIST_URL: server.url });
      delete (env as Record<string, string | undefined>).BOTBOY_TEST_NODE_BIN; // the search is by PATH, then the folders
      const result = spawnSync('/bin/bash', [path.join(b.app, 'start.sh')], { cwd: b.app, env, encoding: 'utf8' });
      expect(b.decision(result), layout).toMatchObject({ source: 'system', node, needs_runtime: '0', reason: '' });
      expect(server.requests, layout).toEqual([]);
      expect(b.curlCalls(), layout).toEqual([]);
    }
  });

  it('keeps a working Node 22 on a Mac with no Command Line Tools too (Node 22 needs none, and no smoke is run for it)', async () => {
    const b = box({ clt: false });
    const marker = path.join(b.root, 'node-calls.log');
    const node = b.stub('node', `echo "$@" >> '${marker}'\ncase "$1" in --version) echo v24.1.0 ;; *) exit 1 ;; esac`, path.join(b.root, 'sysnode'));
    const r = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: node });
    expect(b.decision(r)).toMatchObject({ source: 'system', needs_runtime: '0' });
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['--version']); // never asked to open a database
  });

  it('Node 20 with the Command Line Tools is kept (it builds the database module itself)', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const node = b.systemNode('v20.19.0');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(b.decision(r)).toMatchObject({ source: 'system', node, needs_runtime: '0' });
    expect(server.requests).toEqual([]);
  });

  it('Node 20 on a Mac with no Command Line Tools and no working modules is unusable: BotBoy\'s own Node is chosen, with the reason', async () => {
    const b = box({ clt: false });
    const server = await b.serve();
    const node = b.systemNode('v20.19.0', 'fail');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.decision(r)).toMatchObject({ source: 'private', node: path.join(b.runtimeDir(), 'bin', 'node') });
    expect(b.decision(r).reason).toBe("Node 20.19.0 is below 22 and this Mac has no Command Line Tools to build BotBoy's database module (Node 24 and newer need none)");
    expect(r.stdout).toContain('BotBoy needs a working Node.js, and Node 20.19.0 is below 22 and this Mac has no Command Line Tools');
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('Node 20 with no Command Line Tools whose modules already work in this checkout is kept: it works today', async () => {
    const b = box({ clt: false });
    fs.mkdirSync(path.join(b.app, 'node_modules', 'better-sqlite3'), { recursive: true });
    fs.writeFileSync(path.join(b.app, 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3","version":"12.11.1"}');
    const server = await b.serve();
    const node = b.systemNode('v20.19.0', 'pass');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(b.decision(r)).toMatchObject({ source: 'system', node, needs_runtime: '0' });
    expect(server.requests).toEqual([]);
  });

  it('a Node older than 20.16, a Node that will not run, and one that reports no version are unusable', async () => {
    for (const [body, reason] of [
      ['case "$1" in --version) echo v18.20.4 ;; esac', 'Node 18.20.4 is older than the 20.16 BotBoy needs'],
      ['case "$1" in --version) echo v20.15.9 ;; esac', 'Node 20.15.9 is older than the 20.16 BotBoy needs'],
      ['exit 1', 'does not run'],
      ['echo hello', 'did not report a Node version'],
    ] as const) {
      const b = box({ clt: true });
      const node = b.stub('node', body, path.join(b.root, 'sysnode'));
      const r = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: node });
      expect(b.decision(r).needs_runtime, body).toBe('1');
      expect(b.decision(r).reason, body).toContain(reason);
    }
    const exactly = box({ clt: true });
    const ok = exactly.stub('node', 'case "$1" in --version) echo v20.16.0 ;; esac', path.join(exactly.root, 'sysnode'));
    expect(exactly.decision(await exactly.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: ok }))).toMatchObject({ source: 'system', needs_runtime: '0' });
  });

  it('a Node too old downloads the private one; the old Node stays where it is, untouched', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const node = b.systemNode('v18.20.4');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(b.decision(r)).toMatchObject({ source: 'private' });
    expect(b.decision(r).reason).toContain('Node 18.20.4 is older than the 20.16');
    expect(fs.existsSync(node)).toBe(true);
  });

  it('a failed download with a Node that still runs the installed modules carries on with that Node, with a warning', async () => {
    const b = box({ clt: false });
    fs.mkdirSync(path.join(b.app, 'node_modules', 'better-sqlite3'), { recursive: true });
    fs.writeFileSync(path.join(b.app, 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3","version":"12.11.1"}');
    // Too old to be "usable", but its smoke passes: the start must not die offline.
    const node = b.stub('node', 'case "$1" in --version) echo v18.20.4 ;; -e) exit 0 ;; esac', path.join(b.root, 'sysnode'));
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node });
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain('Could not reach nodejs.org');
    expect(r.stdout).toContain(`Continuing with ${node} (Node 18.20.4): BotBoy could not set up its own Node, and this one runs with the modules already installed.`);
    expect(b.decision(r)).toMatchObject({ source: 'system', node });
  });

  it('with an unusable Node that cannot run the modules either, an offline start ends with the reason (no half start)', async () => {
    const b = box({ clt: true });
    const node = b.systemNode('v18.20.4', 'fail');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Could not reach nodejs.org');
    expect(r.stdout).not.toContain('Continuing with');
  });
});

/** A system Node stub laid out like nodejs.org's (bin/node next to lib/node_modules/npm/package.json), logging its calls. */
function nodeWithNpm(b: Box, nodeVersion: string, npmVersion: string | null, options: { smoke?: 'pass' | 'fail'; pending?: string } = {}) {
  const prefix = path.join(b.root, 'sys-node');
  const calls = path.join(b.root, 'sys-node-calls.log');
  const node = b.stub('node', [
    'echo "$1" >> \'' + calls + '\'',
    'case "$1" in',
    `  --version) echo '${nodeVersion}' ;;`,
    // `native_modules_status check` passes the word `check` as the third argument; missing_npm_dependencies passes a folder.
    `  -e) if [ "$3" = "check" ]; then exit ${options.smoke === 'pass' ? 0 : 1}; else printf '%s' '${options.pending ?? ''}'; fi ;;`,
    'esac',
  ].join('\n'), path.join(prefix, 'bin'));
  if (npmVersion) {
    fs.mkdirSync(path.join(prefix, 'lib', 'node_modules', 'npm'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'lib', 'node_modules', 'npm', 'package.json'), `{\n  "name": "npm",\n  "version": "${npmVersion}",\n  "description": "a package manager for JavaScript"\n}\n`);
  }
  const installModules = () => {
    fs.mkdirSync(path.join(b.app, 'node_modules', 'better-sqlite3'), { recursive: true });
    fs.writeFileSync(path.join(b.app, 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3","version":"12.11.1"}');
  };
  return { node, installModules, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []) };
}

describe('npm 10.9.x (Node 22) cannot install BotBoy from a clean checkout (npm/cli#8261)', () => {
  const REASON = (npm: string, node: string) => `Node ${node} comes with npm ${npm}, which cannot install BotBoy's dependencies (npm bug "Cannot read properties of null (reading 'edgesOut')"; Node 24 comes with npm 11, which can)`;
  it('a clean checkout on a Mac with Node 22 and npm 10.9.x gets BotBoy\'s own Node 24, with the reason; the system Node is left alone', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const sys = nodeWithNpm(b, 'v22.14.0', '10.9.2');
    const sel = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: sys.node });
    expect(b.decision(sel)).toMatchObject({ source: 'system', needs_runtime: '1', reason: REASON('10.9.2', '22.14.0') });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: sys.node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.decision(r)).toMatchObject({ source: 'private', node: path.join(b.runtimeDir(), 'bin', 'node') });
    expect(r.stdout).toContain(`BotBoy needs a working Node.js, and ${REASON('10.9.2', '22.14.0')}.`);
    expect(fs.existsSync(sys.node)).toBe(true);
  });
  it('npm 10.8.2, npm 11, and an npm whose version cannot be read are not bad: the system Node stays, and no smoke is run for it', async () => {
    for (const npm of ['10.8.2', '11.19.0', '10.10.0', null]) {
      const b = box({ clt: true });
      const sys = nodeWithNpm(b, 'v22.14.0', npm);
      const r = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: sys.node });
      expect(b.decision(r), String(npm)).toMatchObject({ source: 'system', needs_runtime: '0', reason: '' });
      expect(sys.calls(), String(npm)).toEqual(['--version']);
    }
  });
  it('a Mac that already runs BotBoy keeps its Node 22 and npm 10.9.x: node_modules is there and the native smoke passes', async () => {
    const b = box({ clt: true });
    const sys = nodeWithNpm(b, 'v22.14.0', '10.9.9', { smoke: 'pass' });
    sys.installModules();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: sys.node });
    expect(b.decision(r)).toMatchObject({ source: 'system', needs_runtime: '0', node: sys.node, reason: '' });
    expect(b.curlCalls()).toEqual([]);
  });
  it('modules built for another Node (the smoke fails) do not count as working: Node 22 with npm 10.9.x is not used to reinstall them', async () => {
    const b = box({ clt: true });
    const sys = nodeWithNpm(b, 'v22.14.0', '10.9.9', { smoke: 'fail' });
    sys.installModules();
    const r = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: sys.node });
    expect(b.decision(r)).toMatchObject({ needs_runtime: '1', reason: REASON('10.9.9', '22.14.0') });
  });
  it('once BotBoy\'s own Node built the modules, a Node 22 with npm 10.9.x does not take over at the next start (no flip back)', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const sys = nodeWithNpm(b, 'v22.14.0', '10.9.9', { smoke: 'fail' }); // its smoke fails: the modules are the private Node's
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: sys.node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    sys.installModules(); // npm install under the private Node has run
    const again = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: sys.node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(b.decision(again)).toMatchObject({ source: 'private', needs_runtime: '0', node: path.join(b.runtimeDir(), 'bin', 'node') });
    expect(requestsFor(server)).toHaveLength(1);
  });
  it('the old Node 20 rule still comes first: Node 20 without the Command Line Tools names the tools, not npm', async () => {
    const b = box({ clt: false });
    const sys = nodeWithNpm(b, 'v20.19.0', '10.9.9', { smoke: 'fail' });
    const r = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: sys.node });
    expect(b.decision(r).reason).toContain('is below 22 and this Mac has no Command Line Tools');
  });
  it('the doctor adds an advice row for it only on a first install (nothing installed yet); an installed tree that lacks a package gets none, and neither does Node 24', async () => {
    // Measured 2026-10-14 with Node 22.23.3 / npm 10.9.9: a clean checkout fails 2 of 2; adding missing packages (ws,
    // then vitest and @vitest/*) to a tree an older npm built succeeded 2 of 2. The row follows the crash, not the npm.
    const advice = (npm: string) => `node advice: this Node comes with npm ${npm}, which can fail the first install of BotBoy's packages with "Cannot read properties of null (reading 'edgesOut')", and none are installed yet. Install Node 24 or newer from nodejs.org (the LTS download), or update npm: npm install -g npm@11.`;
    const fresh = box({ clt: true });
    const a = nodeWithNpm(fresh, 'v22.14.0', '10.9.2');
    expect((await fresh.run('BOTBOY_TEST_DOCTOR_NODE', [], { BOTBOY_TEST_NODE_BIN: a.node })).stdout.trim()).toBe(advice('10.9.2'));
    const installed = box({ clt: true });
    const f = nodeWithNpm(installed, 'v22.14.0', '10.9.2', { pending: 'left-pad' }); // one package is missing, the rest is there
    f.installModules();
    expect((await installed.run('BOTBOY_TEST_DOCTOR_NODE', [], { BOTBOY_TEST_NODE_BIN: f.node })).stdout).toBe('');
    const newer = box({ clt: true });
    const n = nodeWithNpm(newer, 'v24.21.0', '11.19.0');
    expect((await newer.run('BOTBOY_TEST_DOCTOR_NODE', [], { BOTBOY_TEST_NODE_BIN: n.node })).stdout).toBe('');
    const eol = box({ clt: true });
    const e = nodeWithNpm(eol, 'v20.19.0', '10.8.2');
    expect((await eol.run('BOTBOY_TEST_DOCTOR_NODE', [], { BOTBOY_TEST_NODE_BIN: e.node })).stdout).toContain('node advice: Node 20 is end-of-life');
  });
});

describe('BOTBOY_TEST_PREFER_PRIVATE_NODE: a Mac whose Node works can be made to run BotBoy on its own Node (for a live run)', () => {
  const REASON = 'BOTBOY_TEST_PREFER_PRIVATE_NODE=1 treats every system Node as unusable (a test switch)';
  const modulesWork = (b: Box) => {
    fs.mkdirSync(path.join(b.app, 'node_modules', 'better-sqlite3'), { recursive: true });
    fs.writeFileSync(path.join(b.app, 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3","version":"12.11.1"}');
  };

  it('without the switch a working Node 22 is used and nothing is downloaded; with it the pinned private Node is installed and used, exactly like on a Mac with none', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const node = b.systemNode('v22.4.0');
    const plain = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(b.decision(plain)).toMatchObject({ source: 'system', node, needs_runtime: '0' });
    expect(server.requests).toEqual([]);

    const phase1 = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url, BOTBOY_TEST_PREFER_PRIVATE_NODE: '1' });
    expect(b.decision(phase1)).toMatchObject({ needs_runtime: '1', reason: REASON });
    expect(server.requests).toEqual([]); // phase 1 never downloads

    const switched = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url, BOTBOY_TEST_PREFER_PRIVATE_NODE: '1' });
    expect(switched.status, text(switched)).toBe(0);
    expect(b.decision(switched)).toMatchObject({ source: 'private', node: path.join(b.runtimeDir(), 'bin', 'node'), needs_runtime: '0', reason: REASON, path_first: path.join(b.runtimeDir(), 'bin') });
    expect(requestsFor(server)).toHaveLength(1);
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);

    // The next start finds it installed: no second download, still the private Node.
    const again = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url, BOTBOY_TEST_PREFER_PRIVATE_NODE: '1' });
    expect(b.decision(again)).toMatchObject({ source: 'private', needs_runtime: '0' });
    expect(requestsFor(server)).toHaveLength(1);
  });

  it('the doctor names the switch as the reason', async () => {
    const b = box({ clt: true });
    const node = b.systemNode('v22.4.0');
    const r = await b.run('BOTBOY_TEST_DOCTOR_NODE_RUNTIME', [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_PREFER_PRIVATE_NODE: '1' });
    expect(r.stdout).toContain(`node source: system v22.4.0 at ${node} is NOT usable (${REASON}); ./start.sh will set up BotBoy's own Node`);
  });

  it('a failed download does not fall back to the system Node under the switch (a Mac with none has nothing to fall back to), though it does without it', async () => {
    const closed = 'http://127.0.0.1:9';
    const b = box({ clt: true });
    modulesWork(b);
    const node = b.systemNode('v22.4.0', 'pass');
    const switched = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: closed, BOTBOY_TEST_PREFER_PRIVATE_NODE: '1' });
    expect(switched.status, text(switched)).toBe(1);
    expect(text(switched)).toContain('Could not reach nodejs.org');
    expect(text(switched)).not.toContain('Continuing with');

    // Control: a Node too old to count as usable, whose installed modules work, still carries a start on when the download fails.
    const old = box({ clt: true });
    modulesWork(old);
    const oldNode = old.systemNode('v18.19.0', 'pass');
    const carried = await old.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: oldNode, BOTBOY_TEST_NODE_DIST_URL: closed });
    expect(carried.status, text(carried)).toBe(0);
    expect(text(carried)).toContain('Continuing with');
  });

  it('BOTBOY_NODE_RUNTIME=system still wins: BotBoy never uses or downloads a private Node', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const node = b.systemNode('v22.4.0');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url, BOTBOY_TEST_PREFER_PRIVATE_NODE: '1', BOTBOY_NODE_RUNTIME: 'system' });
    expect(b.decision(r)).toMatchObject({ source: 'system', node, needs_runtime: '0' });
    expect(server.requests).toEqual([]);
  });

  it('only the value 1 turns it on', async () => {
    const b = box({ clt: true });
    const node = b.systemNode('v22.4.0');
    for (const value of ['0', '', 'yes', 'true']) {
      const r = await b.run(SELECT, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_PREFER_PRIVATE_NODE: value });
      expect(b.decision(r), value).toMatchObject({ source: 'system', node, needs_runtime: '0' });
    }
  });
});

describe('the macOS floor of the pinned Node (the real pin: 13.5)', () => {
  it('refuses macOS 13.0 to 13.4 and downloads nothing: update macOS first, and only a Mac that cannot update gets Node 22 + npm 11; 13.5 and newer go ahead', async () => {
    for (const macos of ['13.0', '13.4.1']) {
      const b = box({ minMacos: '13.5', macos });
      const server = await b.serve();
      const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
      expect(r.status, macos).toBe(1);
      expect(r.stdout, macos).toContain(`BotBoy's Node v22.1.2 needs macOS 13.5 or newer, and this Mac runs macOS ${macos}.`);
      expect(r.stdout, macos).toContain('    Next: Update macOS in System Settings > General > Software Update (on macOS 13 Ventura, 13.5 or newer is a free update), then run ./start.sh again.\n');
      expect(r.stdout, macos).toContain("    Only if this Mac cannot update: install Node 22 from nodejs.org, run sudo npm install -g npm@11 once in Terminal (it asks for your Mac password; Node 22's own npm 10.9 cannot do BotBoy's first install), then run ./start.sh again.\n");
      // Updating macOS comes first; the Node 22 way round is the second choice.
      expect(r.stdout.indexOf('Software Update'), macos).toBeLessThan(r.stdout.indexOf('Node 22'));
      expect(r.stdout, macos).not.toContain('Node 24 or newer');
      expect(server.requests, macos).toEqual([]);
    }
    for (const macos of ['13.5', '13.7.8', '14.0', '26.7.1', 'unreadable']) {
      const b = box({ minMacos: '13.5', macos });
      const server = await b.serve();
      const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
      expect(r.status, `${macos}: ${text(r)}`).toBe(0);
      expect(b.decision(r).source, macos).toBe('private');
    }
  });
});

describe('modes that must never download', () => {
  const noNode = { BOTBOY_TEST_NODE_BIN: 'none' };
  it('--doctor on a Mac with no Node prints a short report with the Node rows, exits 0, and downloads nothing', async () => {
    const b = box();
    const server = await b.serve();
    const r = await b.run(null, ['--doctor'], { ...noNode, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toMatch(/^== BotBoy doctor — /);
    expect(r.stdout).toContain('node:  none usable on this Mac');
    expect(r.stdout).toContain("node source: none (no Node was found on this Mac); ./start.sh will set up BotBoy's own Node");
    expect(r.stdout).toContain('node runtime: pinned Node 22.1.2 (Node 22, supported until 2099-04-30), arm64; not installed; the next ./start.sh downloads it from nodejs.org');
    expect(r.stdout).toContain('The doctor never downloads.');
    expect(server.requests).toEqual([]);
    expect(b.curlCalls()).toEqual([]);
    expect(b.runtimes()).toEqual([]);
    expect(b.tripwireCalls()).toEqual([]);
  });
  it('--stop with nothing running says so and exits 0 without a Node; with something running it names the way out', async () => {
    const b = box();
    const server = await b.serve();
    const none = await b.run(null, ['--stop'], { ...noNode, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(none.status, text(none)).toBe(0);
    expect(none.stdout).toContain('BotBoy is not running');
    const running = b.stub('pgrep', 'exit 0');
    expect(running).toContain('pgrep');
    const busy = await b.run(null, ['--stop'], { ...noNode, BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(busy.status).toBe(1);
    expect(busy.stdout).toContain('node not found — this Mac has no Node yet, and this command never downloads one. Run ./start.sh first');
    expect(server.requests).toEqual([]);
  });
  it('--recover-shutdown, --open-window and --rebuild-ocr say "run ./start.sh first" and download nothing', async () => {
    for (const mode of ['--recover-shutdown', '--open-window', '--rebuild-ocr']) {
      const b = box();
      const server = await b.serve();
      const r = await b.run(null, [mode], { ...noNode, BOTBOY_TEST_NODE_DIST_URL: server.url });
      expect(r.status, mode).toBe(1);
      expect(r.stdout, mode).toContain('node not found — this Mac has no Node yet, and this command never downloads one. Run ./start.sh first');
      expect(server.requests, mode).toEqual([]);
      expect(b.runtimes(), mode).toEqual([]);
    }
  });
  it('the mode decides whether a download is allowed, before anything runs: none of the five may, a start and --foreground may', async () => {
    const b = box({ clt: true });
    const node = b.systemNode('v22.4.0');
    for (const [args, allowed] of [
      [['--doctor'], '0'], [['--stop'], '0'], [['--recover-shutdown'], '0'], [['--open-window'], '0'], [['--rebuild-ocr'], '0'],
      [[], '1'], [['--foreground'], '1'],
    ] as const) {
      const r = await b.run(SELECT, [...args], { BOTBOY_TEST_NODE_BIN: node });
      expect(b.decision(r).download_allowed, args.join(' ')).toBe(allowed);
    }
  });
  it('with a Node that is unusable, a mode that cannot download still runs on it: nothing changes for --doctor and the hooks', async () => {
    const b = box({ clt: true });
    const node = b.systemNode('v18.20.4');
    const r = await b.run(SELECT, ['--doctor'], { BOTBOY_TEST_NODE_BIN: node });
    expect(b.decision(r)).toMatchObject({ source: 'system', node, needs_runtime: '1', download_allowed: '0' });
    const rows = await b.run('BOTBOY_TEST_DOCTOR_NODE_RUNTIME', ['--doctor'], { BOTBOY_TEST_NODE_BIN: node });
    expect(rows.stdout).toContain(`node source: system v18.20.4 at ${node} is NOT usable (Node 18.20.4 is older than the 20.16 BotBoy needs); ./start.sh will set up BotBoy's own Node`);
    expect(rows.stdout).toContain('not installed; the next ./start.sh downloads it from nodejs.org (checksum verified, about 1 GB free needed)');
  });
  it('the download has exactly two callers: the real start flow, after the doctor, stop and recovery handlers and the start lock, and the update that will not start', () => {
    const source = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    const calls = [...source.matchAll(/^\s*(?:\[ "\$NODE_RUNTIME_LOADED" != "1" \] \|\| )?ensure_node_runtime$/gm)].map((match) => match.index!);
    expect(calls).toHaveLength(2); // the test hook and the flow
    const flow = calls[1];
    for (const marker of ['if [ "$OPEN_WINDOW_ONLY" = "1" ]; then', 'if [ "$STOP_ONLY" = "1" ]; then', 'if [ "$DOCTOR" = "1" ]; then', 'if [ "$RECOVER_SHUTDOWN" = "1" ]; then', 'release_start_lock() {']) {
      expect(source.indexOf(marker), marker).toBeGreaterThan(-1);
      expect(source.indexOf(marker), marker).toBeLessThan(flow);
    }
    expect(source).toContain('node_runtime_update_prefetch');
    expect([...source.matchAll(/node_runtime_update_prefetch/g)]).toHaveLength(1);
    // And curl is named once, inside the one download function.
    const library = fs.readFileSync(path.join(packageRoot, 'scripts', 'node-runtime.sh'), 'utf8');
    expect([...library.matchAll(/"\$NODE_RUNTIME_CURL" /g)]).toHaveLength(2); // the -x check and the single call
    expect(source).not.toMatch(/nodejs\.org\/dist/);
  });
});

describe('a runtime that is already there', () => {
  it('a damaged one is detected by its smoke and fetched again once', async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(requestsFor(server)).toHaveLength(1);
    fs.writeFileSync(path.join(b.runtimeDir(), 'bin', 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const sel = await b.run(SELECT, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(b.decision(sel)).toMatchObject({ needs_runtime: '1' }); // phase 1 sees it is not healthy and downloads nothing
    expect(requestsFor(server)).toHaveLength(1);
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain("BotBoy's Node in ~/.personal-productivity-tracker/runtime/node-22.1.2-arm64 does not run; fetching it again");
    expect(requestsFor(server)).toHaveLength(2);
    expect(b.decision(r)).toMatchObject({ source: 'private', needs_runtime: '0' });
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
    expect(spawnSync(path.join(b.runtimeDir(), 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('v22.1.2');
  });

  it('a tarball whose Node never runs is tried once per start, not in a loop, and leaves nothing', async () => {
    const b = box({ tarball: { brokenNode: true } });
    const server = await b.serve();
    for (let i = 0; i < 2; i += 1) {
      const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
      expect(r.status).toBe(1);
    }
    expect(requestsFor(server)).toHaveLength(2);
    expect(b.runtimes()).toEqual([]);
  });

  it('a new pin replaces the runtime: the new one is fetched and smoke-tested first, then the old one goes', async () => {
    const b = box();
    const first = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: first.url });
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
    const next = b.makeTarballs('22.1.3');
    b.writePin('22.1.3', next);
    const second = await b.serve({}, '22.1.3', next);
    // Phase 1 (nothing downloads): the old runtime keeps serving, and the new pin is flagged as needed.
    const sel = await b.run(SELECT, [], { BOTBOY_TEST_NODE_DIST_URL: second.url });
    expect(b.decision(sel)).toMatchObject({ source: 'private', needs_runtime: '1', node: path.join(b.runtimeDir('22.1.2'), 'bin', 'node') });
    expect(second.requests).toEqual([]);
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: second.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.decision(r)).toMatchObject({ source: 'private', needs_runtime: '0', node: path.join(b.runtimeDir('22.1.3'), 'bin', 'node') });
    expect(b.runtimes()).toEqual(['node-22.1.3-arm64']);
  });

  it('a new pin that cannot be fetched keeps the old runtime in use, with a warning (the start does not die offline)', async () => {
    const b = box();
    const first = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: first.url });
    b.writePin('22.1.3', b.makeTarballs('22.1.3'));
    const r = await b.run(ENSURE); // closed port
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain('Could not reach nodejs.org');
    expect(r.stdout).toContain('Could not fetch the pinned Node v22.1.3 now; continuing with the BotBoy Node already installed (~/.personal-productivity-tracker/runtime/node-22.1.2-arm64), which still works.');
    expect(b.decision(r)).toMatchObject({ source: 'private', node: path.join(b.runtimeDir('22.1.2'), 'bin', 'node') });
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
  });

  it('keeps an older runtime while a process still runs from it (pgrep), and removes it at the next start', async () => {
    const b = box();
    const first = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: first.url });
    const next = b.makeTarballs('22.1.3');
    b.writePin('22.1.3', next);
    const second = await b.serve({}, '22.1.3', next);
    b.stub('pgrep', 'exit 0'); // "something runs from every runtime"
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: second.url });
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64', 'node-22.1.3-arm64']);
    expect(b.logText()).toContain('a process still runs from it');
    b.stub('pgrep', 'exit 1'); // the old server is gone
    const again = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: second.url });
    expect(again.status, text(again)).toBe(0);
    expect(b.runtimes()).toEqual(['node-22.1.3-arm64']); // the next start retires it
    expect(requestsFor(second)).toHaveLength(1); // and downloaded nothing to do so
  });
});

describe('PATH', () => {
  it('npm and its shebang node both resolve to the private runtime (the heal step runs npm install through PATH)', async () => {
    const b = box();
    fs.writeFileSync(path.join(b.app, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.3.0' } }));
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    const r = await b.run('BOTBOY_TEST_HEAL_DEPS', [], { BOTBOY_TEST_NODE_DIST_URL: server.url, BOTBOY_TEST_NPM_BIN: 'npm' });
    expect(r.status, text(r)).toBe(0);
    const bin = path.join(b.runtimeDir(), 'bin');
    expect(b.logText()).toContain(`npm-called install --no-audit --no-fund node=${bin}/node path1=${bin}`);
  });

  it('an inherited private entry on PATH is not mistaken for a system Node (the update child inherits the server\'s PATH)', async () => {
    const b = box();
    const first = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: first.url });
    const oldBin = path.join(b.runtimeDir('22.1.2'), 'bin');
    const next = b.makeTarballs('22.1.3');
    b.writePin('22.1.3', next);
    const inherited = `${oldBin}:${path.join(b.stubs)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    // BOTBOY_TEST_NODE_BIN unset: the search is by PATH, which would find the old private node first.
    const env = b.env({ [SELECT]: '1', PATH: inherited });
    delete (env as Record<string, string | undefined>).BOTBOY_TEST_NODE_BIN;
    const result = spawnSync('/bin/bash', [path.join(b.app, 'start.sh')], { cwd: b.app, env, encoding: 'utf8' });
    const d = Object.fromEntries(result.stdout.split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(d.source).toBe('private');
    expect(d.needs_runtime).toBe('1'); // the new pin is wanted: it did not look like a working system Node
    expect(d.reason).toBe('no Node was found on this Mac');
    // and the entry appears once, first, because the library puts the chosen runtime there, not because it was inherited
    expect(d.path_first).toBe(oldBin);
    expect((result.stdout.match(/path_first/g) ?? []).length).toBe(1);
  });

  it('BOTBOY_NODE_RUNTIME=private uses BotBoy\'s own Node even when this Mac has a good one; =system never downloads and keeps the old "node not found"', async () => {
    const b = box({ clt: true });
    const server = await b.serve();
    const node = b.systemNode('v22.4.0');
    const forced = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_BIN: node, BOTBOY_TEST_NODE_DIST_URL: server.url, BOTBOY_NODE_RUNTIME: 'private' });
    expect(forced.status, text(forced)).toBe(0);
    expect(b.decision(forced)).toMatchObject({ source: 'private', reason: 'BOTBOY_NODE_RUNTIME=private is set', mode: 'private' });
    const off = box();
    const s2 = await off.serve();
    const r = await off.run(null, ['--foreground'], { BOTBOY_NODE_RUNTIME: 'system', BOTBOY_TEST_NODE_DIST_URL: s2.url });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('node not found — install Node 24 or newer from nodejs.org (the LTS download; the installer needs no other tools)');
    expect(r.stdout).toContain('BOTBOY_NODE_RUNTIME=system keeps BotBoy from using its own copy');
    expect(s2.requests).toEqual([]);
    const bad = await off.run(SELECT, [], { BOTBOY_NODE_RUNTIME: 'maybe' });
    expect(bad.stdout).toContain('BOTBOY_NODE_RUNTIME=maybe is not auto, system or private; using auto');
  });

  it('the foreground flow (BotBoy.app) chooses and prepares the runtime like a start', async () => {
    const b = box();
    const server = await b.serve();
    const r = await b.run(ENSURE, ['--foreground'], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.decision(r)).toMatchObject({ source: 'private', download_allowed: '1', path_first: path.join(b.runtimeDir(), 'bin') });
    expect(requestsFor(server)).toHaveLength(1);
  });
});

describe('every caller searches for a system Node the same way', () => {
  // start.sh puts START_EXTRA_PATH in front of PATH only a few lines AFTER its --update block, and that block's prefetch
  // asks for a Node too (scripts/node-runtime.sh › node_find_system). The search therefore adds the folders itself.
  const lookup = (extraFolders: string, nodeIn: string[], body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-node-find-'));
    roots.push(dir);
    for (const folder of ['home', 'empty', 'extra', 'onpath', 'cwd']) fs.mkdirSync(path.join(dir, folder));
    for (const folder of nodeIn) fs.writeFileSync(path.join(dir, folder, 'node'), '#!/bin/sh\necho v22.4.0\n', { mode: 0o755 });
    const script = `PROJ_DIR='${packageRoot}'; HOME='${dir}/home'; HW_ARM64=1; LOG_FILE='${dir}/log'; START_EXTRA_PATH=${extraFolders.replace(/@/g, dir)}
clt_installed() { return 0; }; native_exec() { "$@"; }; native_modules_status() { return 0; }; arch_prepare() { :; }
. '${path.join(packageRoot, 'scripts', 'node-runtime.sh')}'
${body}`;
    // PATH is two folders and there is no discovery hook: only what node_find_system itself adds can find another Node.
    // The shell runs in a folder of its own that may hold a `node`: an empty PATH entry would mean "here" and find it.
    const run = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', cwd: path.join(dir, 'cwd'), env: { PATH: `${dir}/onpath:${dir}/empty` } });
    return { dir, out: run.stdout.trim(), err: run.stderr };
  };

  it('finds a Node in the folders start.sh adds, though PATH does not hold it, and leaves PATH as it was', () => {
    const r = lookup("'@/extra'", ['extra'], 'before="$PATH"; node_find_system; echo "found=$NODE_SYSTEM"; [ "$PATH" = "$before" ] && echo path-unchanged');
    expect(r.out, r.err).toBe(`found=${r.dir}/extra/node\npath-unchanged`);
  });

  it('puts those folders first, as a real start does: a Node there wins over one on PATH', () => {
    const r = lookup("'@/extra'", ['extra', 'onpath'], 'node_find_system; echo "found=$NODE_SYSTEM"');
    expect(r.out, r.err).toBe(`found=${r.dir}/extra/node`);
  });

  it('with no folder list the search is PATH alone (no stray empty entry that would mean the current folder)', () => {
    const none = lookup("''", ['cwd'], 'node_find_system; echo "found=[$NODE_SYSTEM]"');
    expect(none.out, none.err).toBe('found=[]');
    const onPath = lookup("''", ['onpath'], 'node_find_system; echo "found=$NODE_SYSTEM"');
    expect(onPath.out, onPath.err).toBe(`found=${onPath.dir}/onpath/node`);
  });

  it('the test hook leaves out exactly the two system-wide folders and nothing else (it is never set in production)', () => {
    const start = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    const block = start.match(/^if \[ "\$\{BOTBOY_TEST_NO_HOST_BIN_DIRS:-0\}" = "1" \]; then\n[\s\S]*?^fi\n/m)![0];
    // The real block, evaluated: a minimal environment, so nothing the developer exported can change the answer.
    const list = (hook: string) => spawnSync('/bin/bash', ['-c', `HOME=/h; ${hook}${block}\necho "$START_EXTRA_PATH"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim();
    expect(list('')).toBe('/h/homebrew/bin:/h/.local/bin:/h/.toolbox/bin:/usr/local/bin:/opt/homebrew/bin');
    expect(list('BOTBOY_TEST_NO_HOST_BIN_DIRS=1; ')).toBe('/h/homebrew/bin:/h/.local/bin:/h/.toolbox/bin');
  });

  it('start.sh keeps ONE list of those folders, defined before the --update block can ask, and the real start exports from it', () => {
    const start = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    expect(start).toContain('START_EXTRA_PATH="$HOME/homebrew/bin:$HOME/.local/bin:$HOME/.toolbox/bin:/usr/local/bin:/opt/homebrew/bin"');
    expect(start).toContain('export PATH="$START_EXTRA_PATH:$PATH"');
    expect(start).not.toContain('export PATH="$HOME/homebrew/bin'); // no second copy of the list
    const defined = start.indexOf('START_EXTRA_PATH="$HOME/homebrew/bin');
    expect(defined).toBeGreaterThan(-1);
    expect(defined).toBeLessThan(start.indexOf('. "$PROJ_DIR/scripts/node-runtime.sh"'));
    expect(defined).toBeLessThan(start.indexOf('node_runtime_update_prefetch'));
  });
});

describe('two starts at once', () => {
  it('a start that finds the folder lock held by a live start waits for it: it says so, exits 0, and downloads nothing', async () => {
    const b = box();
    const server = await b.serve();
    fs.mkdirSync(path.join(b.runtimeRoot, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(b.runtimeRoot, '.lock', 'pid'), String(process.pid));
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain("Another ./start.sh is already setting up BotBoy's Node");
    expect(server.requests).toEqual([]);
    expect(b.runtimes()).toEqual([]);
  });
  it('a lock whose start is gone (killed mid-download) is taken over', async () => {
    const b = box();
    const server = await b.serve();
    fs.mkdirSync(path.join(b.runtimeRoot, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(b.runtimeRoot, '.lock', 'pid'), '999999');
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
    expect(fs.existsSync(path.join(b.runtimeRoot, '.lock'))).toBe(false);
  });
  it('leftover scratch folders of a killed start are swept, and the lock is released after a failure too', async () => {
    const b = box();
    fs.mkdirSync(path.join(b.runtimeRoot, '.extract-4242', 'x'), { recursive: true });
    fs.mkdirSync(path.join(b.runtimeRoot, '.corrupt-4242'), { recursive: true });
    const r = await b.run(ENSURE); // offline: fails after taking the lock
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(b.runtimeRoot, '.lock'))).toBe(false);
    expect(b.leftovers().filter((name) => name !== '.download')).toEqual([]);
  });
});

describe('the doctor rows', () => {
  it('say system Node in use, with its version and path, and that the private one is not needed', async () => {
    const b = box({ clt: true });
    const node = b.systemNode('v22.4.0');
    const r = await b.run('BOTBOY_TEST_DOCTOR_NODE_RUNTIME', [], { BOTBOY_TEST_NODE_BIN: node });
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      `node source: system v22.4.0 at ${node} (BotBoy's own Node is not needed)`,
      'node runtime: pinned Node 22.1.2 (Node 22, supported until 2099-04-30), arm64; not installed, and not needed: this Mac\'s own Node works',
    ]);
  });
  it('say private, because, and the folder; and warn when an installed private Node is not in use', async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server.url });
    const using = await b.run('BOTBOY_TEST_DOCTOR_NODE_RUNTIME', []);
    expect(using.stdout).toContain(`node source: private v22.1.2 because no Node was found on this Mac (${b.runtimeDir()}/bin/node)`);
    expect(using.stdout).toContain(`installed in ~/.personal-productivity-tracker/runtime/node-22.1.2-arm64 and in use; no download needed`);
    const clt = box({ clt: true });
    fs.cpSync(b.runtimeRoot, clt.runtimeRoot, { recursive: true });
    const node = clt.systemNode('v22.4.0');
    const idle = await clt.run('BOTBOY_TEST_DOCTOR_NODE_RUNTIME', [], { BOTBOY_TEST_NODE_BIN: node });
    expect(idle.stdout).toContain('but not in use: this Mac\'s own Node works (rm -rf ~/.personal-productivity-tracker/runtime removes it)');
  });
  it('are part of the real doctor, once, right after the Node advice row', () => {
    const source = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    const doctor = source.slice(source.indexOf('if [ "$DOCTOR" = "1" ]; then'));
    expect(doctor.match(/^ {2}\[ "\$NODE_RUNTIME_LOADED" != "1" \] \|\| doctor_node_runtime_rows$/gm)).toHaveLength(1);
    expect(doctor.indexOf('doctor_node_runtime_rows')).toBeGreaterThan(doctor.indexOf('doctor_node_row'));
    expect(doctor.indexOf('doctor_node_runtime_rows')).toBeLessThan(doctor.indexOf('doctor_machine_rows'));
  });
});

describe('a checkout without scripts/node-runtime.sh behaves as it did before', () => {
  it('finds a Node the old way, and "node not found" is the old line and exit 1', async () => {
    const b = box();
    fs.rmSync(path.join(b.app, 'scripts', 'node-runtime.sh'));
    const ok = await b.run('BOTBOY_TEST_DOCTOR_NODE', [], { BOTBOY_TEST_NODE_BIN: process.execPath });
    expect(ok.status, text(ok)).toBe(0);
    const none = await b.run('BOTBOY_TEST_DOCTOR_NODE', [], { BOTBOY_TEST_NODE_BIN: '' });
    // no node on this PATH and no stub: the legacy branch
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('❌ node not found — install Node 24 or newer from nodejs.org (the LTS download; the installer needs no other tools), then re-run ./start.sh');
  });
});

describe('the update that will not start BotBoy brings the pinned Node', () => {
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const hasGit = spawnSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }).status === 0;
  // A botboy-app checkout: the app folder is a clone of a local bare repository (file transport only).
  async function release(system?: 'good') {
    const b = box({ clt: true });
    fs.rmSync(path.join(b.stubs, 'git')); // the real git, not the tripwire
    fs.writeFileSync(path.join(b.app, '.botboy-distribution'), '');
    const origin = path.join(b.root, 'origin.git');
    spawnSync('/usr/bin/git', ['init', '-q', '--bare', '-b', 'main', origin]);
    git(b.app, ['init', '-q', '-b', 'main']);
    git(b.app, ['add', '-A']);
    git(b.app, ['commit', '-q', '-m', 'release 1']);
    git(b.app, ['remote', 'add', 'origin', origin]);
    git(b.app, ['push', '-q', '-u', 'origin', 'main']);
    const publisher = path.join(b.root, 'publisher');
    spawnSync('/usr/bin/git', ['clone', '-q', origin, publisher]);
    const server1 = await b.serve();
    if (!system) await b.run(ENSURE, [], { BOTBOY_TEST_NODE_DIST_URL: server1.url });
    const next = b.makeTarballs('22.1.3');
    const newPin = pinText({ version: '22.1.3', arm64: { sha256: next.arm64!.sha256, bytes: next.arm64!.bytes }, x64: { sha256: next.x64!.sha256, bytes: next.x64!.bytes } });
    fs.writeFileSync(path.join(publisher, 'node-runtime.pin'), newPin);
    git(publisher, ['add', '-A']);
    git(publisher, ['commit', '-q', '-m', 'release 2']);
    git(publisher, ['push', '-q', 'origin', 'main']);
    const server2 = await b.serve({}, '22.1.3', next);
    const env = { BOTBOY_UPDATE_NO_START: '1', BOTBOY_TEST_GIT_SHIM: '/usr/bin/git', BOTBOY_TEST_NODE_DIST_URL: server2.url, GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' };
    return { b, server2, env };
  }
  it.runIf(hasGit)('fetches the new pin before the old runtime goes, and says so (BOTBOY_UPDATE_NO_START)', async () => {
    const { b, server2, env } = await release();
    const r = await b.run(null, ['--update'], env);
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain('✅ BotBoy\'s Node is ready for the new release');
    expect(b.runtimes()).toEqual(['node-22.1.3-arm64']);
    expect(requestsFor(server2)).toHaveLength(1);
    expect(fs.readFileSync(path.join(b.app, 'node-runtime.pin'), 'utf8')).toContain('version=22.1.3');
  });
  it.runIf(hasGit)('an offline update still updates the code, keeps the old runtime, and says the next start tries again', async () => {
    const { b, env } = await release();
    const r = await b.run(null, ['--update'], { ...env, BOTBOY_TEST_NODE_DIST_URL: 'http://127.0.0.1:9' });
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain("BotBoy's new Node could not be fetched now; the next ./start.sh tries again.");
    expect(fs.readFileSync(path.join(b.app, 'node-runtime.pin'), 'utf8')).toContain('version=22.1.3');
    expect(b.runtimes()).toEqual(['node-22.1.2-arm64']);
  });
  it.runIf(hasGit)('a Mac whose own Node works downloads nothing at an update', async () => {
    const { b, server2, env } = await release('good');
    const node = b.systemNode('v22.4.0');
    const r = await b.run(null, ['--update'], { ...env, BOTBOY_TEST_NODE_BIN: node });
    expect(r.status, text(r)).toBe(0);
    expect(server2.requests).toEqual([]);
    expect(b.runtimes()).toEqual([]);
  });
  it.runIf(hasGit)('a Mac whose working Node sits only in a folder start.sh adds to PATH downloads nothing at an update (the same search as a start)', async () => {
    const { b, server2, env } = await release('good');
    // $HOME/homebrew/bin is one of the folders start.sh puts in front of PATH, a few lines AFTER the update block runs.
    // The shell's own PATH (the stubs, /usr/bin, ...) has no Node and the discovery hook is off, so only the real search finds it.
    b.stub('node', 'case "$1" in --version) echo v22.4.0 ;; *) exit 0 ;; esac', path.join(b.home, 'homebrew', 'bin'));
    const r = await b.run(null, ['--update'], { ...env, BOTBOY_TEST_NODE_BIN: '' });
    expect(r.status, text(r)).toBe(0);
    expect(text(r)).not.toContain('no Node was found');
    expect(server2.requests).toEqual([]);
    expect(b.curlCalls()).toEqual([]);
    expect(fs.existsSync(b.runtimeRoot)).toBe(false);
  });
});

describe.runIf(fs.existsSync(path.join(packageRoot, 'scripts', 'release.sh')))('what the release ships', () => {
  it('has the library start.sh sources and the pin it reads, and keeps the verifier out', () => {
    const script = fs.readFileSync(path.join(packageRoot, 'scripts', 'release.sh'), 'utf8');
    const block = script.match(/^PATHS=\(\n([\s\S]*?)^\)/m)![1].split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
    expect(block).toContain('scripts/node-runtime.sh');
    expect(block).toContain('node-runtime.pin');
    expect(block).not.toContain('scripts/verify-node-runtime.mjs');
    // The live MCP check needs the network and is a developer tool: nothing under scripts/dev ships.
    expect(block.filter((entry) => entry.startsWith('scripts/dev'))).toEqual([]);
    // Everything start.sh sources or reads for this feature is on that list.
    const start = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    expect(start).toContain('"$PROJ_DIR/scripts/node-runtime.sh"');
    const library = fs.readFileSync(path.join(packageRoot, 'scripts', 'node-runtime.sh'), 'utf8');
    expect(library).toContain('$PROJ_DIR/node-runtime.pin');
  });
});

describe.runIf(verifierPresent)('the bash reader and the Node reader agree on the pin', () => {
  const bashRead = (pinFile: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-pin-read-'));
    roots.push(dir);
    const script = `PROJ_DIR='${packageRoot}'; HOME='${dir}'; HW_ARM64=1; LOG_FILE='${dir}/log'
clt_installed() { return 0; }; native_exec() { "$@"; }; native_modules_status() { return 0; }; arch_prepare() { :; }
. '${path.join(packageRoot, 'scripts', 'node-runtime.sh')}'
NODE_RUNTIME_PIN_FILE='${pinFile}'
if node_runtime_read_pin; then echo "ok version=$NR_VERSION line=$NR_LINE eol=$NR_EOL mac=$NR_MIN_MACOS arm=$NR_SHA_ARM64:$NR_BYTES_ARM64 x64=$NR_SHA_X64:$NR_BYTES_X64"; else echo "error $NR_ERROR"; fi`;
    return spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' }).stdout.trim();
  };
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const good = pinText({ version: '22.1.2', arm64: { sha256: A, bytes: 50_000_000 }, x64: { sha256: B, bytes: 51_000_000 } });
  const cases: [string, string, boolean][] = [
    ['the real pin', fs.readFileSync(path.join(packageRoot, 'node-runtime.pin'), 'utf8'), true],
    ['a full pin', good, true],
    ['one chip', pinText({ version: '22.1.2', arm64: { sha256: A, bytes: 50_000_000 } }), true],
    ['a CRLF file', good.replace(/\n/g, '\r\n'), true],
    ['trailing spaces', good.replace('version=22.1.2', 'version=22.1.2   '), true],
    ['an unknown key', `${good}mystery=1\n`, false],
    ['a duplicate key', `${good}version=22.1.3\n`, false],
    ['no schema', good.replace('schema=1\n', ''), false],
    ['schema 2', good.replace('schema=1', 'schema=2'), false],
    ['a short version', good.replace('version=22.1.2', 'version=22.1'), false],
    ['a line that is not the major', good.replace('line=22', 'line=24'), false],
    ['an upper-case hash', good.replace(A, 'A'.repeat(64)), false],
    ['a short hash', good.replace(A, 'a'.repeat(63)), false],
    ['a non-numeric size', good.replace('50000000', 'many'), false],
    ['a hash without its size', good.replace('darwin-x64.bytes=51000000\n', ''), false],
    ['no chip at all', pinText({ version: '22.1.2' }), false],
    ['a bad macOS version', good.replace('min_macos=11.0', 'min_macos=eleven'), false],
    ['a bad date', good.replace('eol=2099-04-30', 'eol=soon'), false],
    ['a line with no equals sign', `${good}nonsense\n`, false],
  ];
  for (const [name, content, valid] of cases) {
    it(`${name}: ${valid ? 'both accept it, with the same values' : 'both refuse it'}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-pin-'));
      roots.push(dir);
      const file = path.join(dir, 'node-runtime.pin');
      fs.writeFileSync(file, content);
      const js = readPin(file);
      const bash = bashRead(file);
      expect(js.pin !== null, `node reader: ${js.problems.join(' | ')}`).toBe(valid);
      expect(bash.startsWith('ok '), `bash reader: ${bash}`).toBe(valid);
      if (valid) {
        const chip = (c: 'arm64' | 'x64') => (js.pin.chips[c] ? `${js.pin.chips[c].sha256}:${js.pin.chips[c].bytes}` : ':');
        expect(bash).toBe(`ok version=${js.pin.version} line=${js.pin.line} eol=${js.pin.eol} mac=${js.pin.minMacos} arm=${chip('arm64')} x64=${chip('x64')}`);
      }
    });
  }
  it('version_at_least compares like numbers, not like text', () => {
    const script = `PROJ_DIR='${packageRoot}'; HOME='/tmp'; LOG_FILE=/dev/null; . '${path.join(packageRoot, 'scripts', 'node-runtime.sh')}'
for pair in "20.16.0 20.16.0 y" "20.16.1 20.16.0 y" "20.15.9 20.16.0 n" "20.9.0 20.16.0 n" "22.0.0 20.16.0 y" "21.0.0 22.0.0 n" "9.9.9 20.16.0 n" "100.0.0 20.16.0 y" "20.16 20.16.0 y" "20 20.16.0 n" "14.5 11.0 y" "10.15.7 11.0 n" "26.7.1 11 y" "11.0 11.0.0 y"; do
  set -- $pair; if version_at_least "$1" "$2"; then r=y; else r=n; fi; [ "$r" = "$3" ] || echo "WRONG $pair got $r"; done; echo done`;
    const out = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' }).stdout.trim();
    expect(out).toBe('done');
  });
});
