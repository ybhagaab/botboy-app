/**
 * BotBoy's own Python, uv + one CPython (scripts/python-runtime.sh, sourced by start.sh): the hermetic harness.
 *
 * Every case runs the real start.sh, scripts/node-runtime.sh and scripts/python-runtime.sh from a throwaway folder with
 * a private HOME, a PATH of recording stubs plus /usr/bin:/bin:/usr/sbin:/sbin, a working stand-in Node (so Node on
 * demand stays out of the way), a fake "github.com" on 127.0.0.1 (shell scripts packed into real .tar.gz files; see
 * python-runtime.testutil.ts), and stubs for the facts of the Mac (macOS version, free disk, Command Line Tools).
 * Nothing here reaches the network beyond loopback, runs a real uv or Python, or touches the owner's HOME.
 *
 * Apple's /usr/bin/python3 is an Xcode stand-in and is NEVER run. A tripwire `python3` first on PATH plays its part
 * (BOTBOY_TEST_PYTHON_SHIM names it): a run that executed it would log it, and every case that can see it asserts the
 * log is empty. The real /usr/bin/python3 comes later on the same PATH and is skipped by path, never by running it.
 *
 * The runs are async on purpose: the fake GitHub lives in this process and a blocking spawn would starve it.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDistServer } from './node-runtime.testutil.js';
import { fakePythonTarball, fakeUvTarball, pyPinText, pythonPath, type Chip, type FakePacked, TRIPLE_ARCH, uvPath } from './python-runtime.testutil.js';

vi.setConfig({ testTimeout: 180_000 });

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const verifierPresent = fs.existsSync(path.join(packageRoot, 'scripts', 'verify-python-runtime.mjs'));
const { readPin } = (verifierPresent ? await import('../../scripts/verify-python-runtime.mjs') : {}) as typeof import('../../scripts/verify-python-runtime.mjs');
const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const XCODE_SHIMS = ['git', 'xcrun', 'swiftc', 'make', 'lipo', 'otool', 'vtool', 'install_name_tool'];
type Run = { status: number | null; stdout: string; stderr: string; ms: number };
const text = (r: Run) => `${r.stdout}\n${r.stderr}`;

type BoxOptions = {
  arch?: Chip;
  clt?: boolean;
  freeKb?: number;
  macos?: string;
  uvVersion?: string;
  pythonVersion?: string;
  /** A Python on this Mac: [name, version it reports, folder under the private HOME (default .local/bin)]. */
  pythons?: [string, string, string?][];
  /** A uv on this Mac: its version, and whether uvx sits beside it. */
  uv?: { version: string; uvx?: boolean };
  /** Seconds the fake uv's python install takes. */
  installDelaySeconds?: number;
};

function box(options: BoxOptions = {}) {
  const arch = options.arch ?? 'arm64';
  const uvVersion = options.uvVersion ?? '0.13.0';
  const pythonVersion = options.pythonVersion ?? '3.13.16';
  const build = '20261009';
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-python-runtime-')));
  roots.push(root);
  const app = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const standIn = path.join(root, 'stand-in');
  const home = path.join(root, 'home');
  const dl = path.join(root, 'dl');
  for (const d of [path.join(app, 'scripts'), stubs, standIn, home, dl]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'start.sh'), path.join(app, 'start.sh'));
  fs.chmodSync(path.join(app, 'start.sh'), 0o755);
  for (const file of ['scripts/node-runtime.sh', 'scripts/python-runtime.sh', 'node-runtime.pin']) fs.copyFileSync(path.join(packageRoot, file), path.join(app, file));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'x' }));
  const log = path.join(root, 'launcher.log');
  const order = path.join(root, 'order.log');
  const tripwire = path.join(root, 'tripwire.log');
  for (const file of [order, tripwire]) fs.writeFileSync(file, '');
  const stub = (name: string, body: string, dir = stubs) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  for (const name of XCODE_SHIMS) stub(name, `echo "${name} $*" >> '${tripwire}'\nexit 0`);
  // Apple's python3, played by a tripwire first on PATH: if anything ran it, the log says so.
  const shim = stub('python3', `echo "python3 $*" >> '${tripwire}'\necho 3.9.6\nexit 0`, standIn);
  stub('pgrep', 'exit 1');
  const realTool = (name: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate))!;
  const curlCalls = path.join(root, 'curl-calls.log');
  const tarCalls = path.join(root, 'tar-calls.log');
  const curl = stub('curl-recorder', `echo "$@" >> '${curlCalls}'\necho "curl $*" >> '${order}'\nexec '${realTool('curl')}' "$@"`);
  const tar = stub('tar-recorder', `echo "$@" >> '${tarCalls}'\nexec '${realTool('tar')}' "$@"`);
  const xcodeSelect = stub('xcode-select', options.clt ? 'echo /stub/clt' : 'exit 2');
  const swVers = stub('sw_vers', `echo '${options.macos ?? '14.5'}'`);
  const df = stub('df', `echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho '/dev/stub 100000000 1 ${options.freeKb ?? 50_000_000} 1% /'`);
  const fileTool = stub('file', "echo 'ASCII text'");
  // BOTBOY_FAKE_BUILD_AFTER_LOG: the build begins only once the launcher log holds that text (at most 30 s), so a case
  // can make the background download end before the join without racing it.
  const npm = stub('npm', `echo "build start" >> '${order}'\ni=0\nwhile [ -n "\${BOTBOY_FAKE_BUILD_AFTER_LOG:-}" ] && ! /usr/bin/grep -qF -- "$BOTBOY_FAKE_BUILD_AFTER_LOG" '${log}' 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done\nsleep "\${BOTBOY_FAKE_BUILD_SECONDS:-0}"\necho "build end" >> '${order}'\nexit "\${BOTBOY_FAKE_BUILD_RC:-0}"`);
  // A Node of this Mac's own that works (v22, no smoke needed): Node on demand keeps it.
  const node = stub('node', "case \"$1\" in --version) echo v22.4.0 ;; *) exit 0 ;; esac", path.join(root, 'sysnode'));
  const chromeDummy = path.join(root, 'chrome-dummy');
  fs.writeFileSync(chromeDummy, '');
  // The Mac's own Pythons and uv, when the case has them (each a recording script that reports a version).
  const ownCalls = path.join(root, 'own-calls.log');
  fs.writeFileSync(ownCalls, '');
  for (const [name, version, folder] of options.pythons ?? []) {
    stub(name, `echo "${name} $*" >> '${ownCalls}'\ncase "$1" in -V|--version) echo "Python ${version}" ;; *) echo '${version}' ;; esac`, path.join(home, folder ?? '.local/bin'));
  }
  if (options.uv) {
    stub('uv', `echo "uv $*" >> '${ownCalls}'\necho 'uv ${options.uv.version} (Homebrew 2026-01-01)'`, path.join(home, '.local', 'bin'));
    if (options.uv.uvx !== false) stub('uvx', 'echo uvx', path.join(home, '.local', 'bin'));
  }

  // The tarballs, the pin, the fake GitHub.
  const uvLog = path.join(root, 'uv-calls.log');
  fs.writeFileSync(uvLog, '');
  const makeSet = (v: { uv: string; python: string }) => {
    const out: Partial<Record<Chip, { uv: FakePacked; python: FakePacked }>> = {};
    for (const chip of ['arm64', 'x64'] as const) {
      const sub = path.join(dl, `${v.uv}-${v.python}-${chip}`);
      fs.mkdirSync(sub, { recursive: true });
      const python = fakePythonTarball(sub, { version: v.python, build, chip, padBytes: 200_000 });
      const uv = fakeUvTarball(sub, { version: v.uv, chip, pythonSha256: python.sha256, pythonVersion: v.python, pythonBuild: build, callLog: uvLog, installDelaySeconds: options.installDelaySeconds, padBytes: 200_000 });
      out[chip] = { uv, python };
    }
    return out;
  };
  const sets = new Map<string, ReturnType<typeof makeSet>>();
  const setFor = (v = { uv: uvVersion, python: pythonVersion }) => {
    const key = `${v.uv}/${v.python}`;
    if (!sets.has(key)) sets.set(key, makeSet(v));
    return sets.get(key)!;
  };
  const pinFile = path.join(root, 'python-runtime.pin');
  const writePin = (v = { uv: uvVersion, python: pythonVersion }) => {
    const set = setFor(v);
    fs.writeFileSync(pinFile, pyPinText({
      uvVersion: v.uv, pythonVersion: v.python, pythonBuild: build,
      uv: { arm64: { sha256: set.arm64!.uv.sha256, bytes: set.arm64!.uv.bytes }, x64: { sha256: set.x64!.uv.sha256, bytes: set.x64!.uv.bytes } },
      python: { arm64: { sha256: set.arm64!.python.sha256, bytes: set.arm64!.python.bytes }, x64: { sha256: set.x64!.python.sha256, bytes: set.x64!.python.bytes } },
    }));
  };
  writePin();
  type Served = Parameters<typeof startDistServer>[0][string];
  const files = (v = { uv: uvVersion, python: pythonVersion }) => {
    const set = setFor(v);
    const out: Record<string, Served> = {};
    for (const chip of ['arm64', 'x64'] as const) {
      out[uvPath(v.uv, chip)] = { body: set[chip]!.uv.body };
      out[pythonPath(v.python, build, chip)] = { body: set[chip]!.python.body };
    }
    return out;
  };
  const serve = async (extra: Record<string, Served> = {}, v?: { uv: string; python: string }) => {
    const server = await startDistServer({ ...files(v), ...extra });
    closers.push(server.close);
    return server;
  };

  const env = (extra: Record<string, string> = {}): Record<string, string> => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(base)) {
      if (/^(UV_|PIP_|PYTHON|VIRTUAL_ENV|CONDA)/.test(key)) delete base[key];
      if (key.startsWith('BOTBOY_') && key !== 'BOTBOY_TEST_UI_STUBS_RUN_DIR' && key !== 'BOTBOY_TEST_LSREGISTER_BIN') delete base[key];
    }
    return {
      ...(base as Record<string, string>),
      HOME: home,
      PATH: `${standIn}:${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
      PPT_LOG_FILE: log,
      PPT_STARTUP_SAFETY_BLOCK: path.join(root, 'safety-block.json'),
      PPT_PID_FILE: path.join(root, 'ppt.pid'),
      PPT_START_LOCK_DIR: path.join(root, 'start.lock'),
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_HW_ARM64: arch === 'arm64' ? '1' : '0',
      BOTBOY_TEST_SHELL_TRANSLATED: '0',
      BOTBOY_TEST_ARCH_PROBE_OK: '0',
      BOTBOY_TEST_FILE_BIN: fileTool,
      BOTBOY_TEST_CHROME_BIN: chromeDummy,
      BOTBOY_TEST_NODE_BIN: node,
      BOTBOY_TEST_NO_HOST_BIN_DIRS: '1',
      BOTBOY_TEST_GIT_SHIM: path.join(stubs, 'git'),
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_XCRUN_BIN: path.join(stubs, 'xcrun'),
      BOTBOY_TEST_SW_VERS_BIN: swVers,
      BOTBOY_TEST_DF_BIN: df,
      BOTBOY_TEST_PYTHON_CURL_BIN: curl,
      BOTBOY_TEST_PYTHON_TAR_BIN: tar,
      BOTBOY_TEST_XATTR_BIN: stub('xattr', 'exit 1'),
      BOTBOY_TEST_LSOF_BIN: stub('lsof', ''),
      BOTBOY_TEST_NPM_BIN: npm,
      BOTBOY_TEST_PYTHON_RUNTIME_PIN: pinFile,
      BOTBOY_TEST_PYTHON_SHIM: shim,
      BOTBOY_TEST_PYTHON_DEVTOOLS_DIR: path.join(root, 'CommandLineTools'),
      ...extra,
    };
  };
  const run = (hook: string | null, args: string[] = [], extra: Record<string, string> = {}) => new Promise<Run>((resolve) => {
    const started = Date.now();
    const child = spawn('/bin/bash', [path.join(app, 'start.sh'), ...args], { cwd: app, env: env({ ...(hook ? { [hook]: '1' } : {}), ...extra }) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, ms: Date.now() - started }); });
  });
  const runtimeRoot = path.join(home, '.personal-productivity-tracker', 'runtime');
  const decision = (r: Run) => Object.fromEntries(r.stdout.split('\n').filter((line) => /^[a-z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) as Record<string, string>;
  const minorKey = `cpython-${pythonVersion.split('.').slice(0, 2).join('.')}-macos-${TRIPLE_ARCH[arch]}-none`;
  const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  return {
    root, app, stubs, standIn, home, log, order, runtimeRoot, stub, env, run, decision, serve, setFor, writePin, arch, uvVersion, pythonVersion, build, shim, minorKey,
    uvDir: (v = uvVersion, chip = arch) => path.join(runtimeRoot, `uv-${v}-${chip}`),
    pyBin: () => path.join(runtimeRoot, 'python', minorKey, 'bin'),
    pyKeyDir: (v = pythonVersion) => path.join(runtimeRoot, 'python', `cpython-${v}-macos-${TRIPLE_ARCH[arch]}-none`),
    tripwireCalls: () => lines(tripwire),
    ownCalls: () => lines(ownCalls),
    uvCalls: () => lines(uvLog),
    curlCalls: () => lines(curlCalls),
    tarCalls: () => lines(tarCalls),
    orderLines: () => lines(order),
    logText: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
    runtimeEntries: () => (fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot).sort() : []),
    downloadsLeft: () => { const d = path.join(runtimeRoot, '.download'); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; },
  };
}
type Box = ReturnType<typeof box>;
const SELECT = 'BOTBOY_TEST_PYTHON_SELECT';
const ENSURE = 'BOTBOY_TEST_PYTHON_ENSURE';
const DOCTOR = 'BOTBOY_TEST_DOCTOR_PYTHON_RUNTIME';
const gets = (server: { requests: { method: string; url: string; range: string | null }[] }) => server.requests.filter((request) => request.method === 'GET');

/** A fake GitHub that sends the first `sendBytes` of a file and then holds the connection open (a stalled or slow link). */
async function startStallServer(files: Record<string, { body: Buffer; sendBytes: number }>) {
  const sockets = new Set<import('node:net').Socket>();
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    requests.push(url);
    const file = files[url];
    if (!file) { res.writeHead(404, { 'Content-Length': 0 }); res.end(); return; }
    const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
    const start = range ? Number(range[1]) : 0;
    const slice = file.body.subarray(start);
    res.writeHead(range ? 206 : 200, { 'Content-Length': slice.length, ...(range ? { 'Content-Range': `bytes ${start}-${file.body.length - 1}/${file.body.length}` } : {}) });
    res.write(slice.subarray(0, file.sendBytes));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
  closers.push(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A DevTools stand-in that answers every request, so start.sh never launches a Chrome in these runs. */
async function startCdpStandIn() {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('which Python and uv BotBoy uses: a Mac whose own work keeps them', () => {
  it('a Mac with only Apple\'s python3 stand-in and no uv needs BotBoy\'s own; the stand-in is skipped, never run', async () => {
    const b = box();
    const r = await b.run(SELECT);
    expect(r.status, text(r)).toBe(0);
    const d = b.decision(r);
    expect(d).toMatchObject({ python_source: 'none', uv_source: 'none', needs_runtime: '1', download_allowed: '1' });
    expect(d.python_reason).toContain(`${b.shim} is Apple's Python stand-in (not run)`);
    expect(d.python_reason).toContain("/usr/bin/python3 is Apple's Python stand-in (not run)");
    expect(d.uv_reason).toBe('no uv was found on this Mac');
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('a link or a hard link to the stand-in, and a Python inside the Command Line Tools or an Xcode app, are skipped the same way and never run', async () => {
    const b = box();
    const clt = path.join(b.root, 'CommandLineTools', 'usr', 'bin');
    b.stub('python3', `echo "clt python3 $*" >> '${path.join(b.root, 'tripwire.log')}'\necho 3.9.6`, clt);
    fs.mkdirSync(path.join(b.home, '.local', 'bin'), { recursive: true });
    fs.symlinkSync(path.join(clt, 'python3'), path.join(b.home, '.local', 'bin', 'python3.12'));
    fs.symlinkSync(b.shim, path.join(b.home, '.local', 'bin', 'python3.13'));
    // A hard link has its own path and real path: only the inode says it is the stand-in (Apple's xcselect shims are hard links of one file).
    fs.linkSync(b.shim, path.join(b.home, '.local', 'bin', 'python3.11'));
    const r = await b.run(SELECT);
    const d = b.decision(r);
    expect(d.python_source).toBe('none');
    expect(d.python_reason).toContain(`${path.join(b.home, '.local', 'bin', 'python3.12')} is Apple's Python stand-in (not run)`);
    expect(d.python_reason).toContain(`${path.join(b.home, '.local', 'bin', 'python3.13')} is Apple's Python stand-in (not run)`);
    expect(d.python_reason).toContain(`${path.join(b.home, '.local', 'bin', 'python3.11')} is Apple's Python stand-in (not run)`);
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('a python3 that reports 3.9 elsewhere is not usable, and says so', async () => {
    const b = box({ pythons: [['python3', '3.9.18']] });
    const d = b.decision(await b.run(SELECT));
    expect(d.python_source).toBe('none');
    expect(d.python_reason).toContain(`${path.join(b.home, '.local', 'bin', 'python3')} is Python 3.9.18 (BotBoy needs 3.10 or newer)`);
    expect(b.ownCalls()).toEqual(['python3 -I -c import sys; print("%d.%d.%d" % sys.version_info[:3])']);
  });

  it('a Mac with only a working python3.12 (no python3) keeps it: a2-analytics picks python3.13..3.10 first (finding 6)', async () => {
    const b = box({ pythons: [['python3.12', '3.12.7']], uv: { version: '0.10.6' } });
    const d = b.decision(await b.run(SELECT));
    expect(d).toMatchObject({ python_source: 'system', python_system: path.join(b.home, '.local', 'bin', 'python3.12'), uv_source: 'system', needs_runtime: '0' });
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('a python3.12 that reports 3.9 does not count', async () => {
    const b = box({ pythons: [['python3.12', '3.9.6']], uv: { version: '0.10.6' } });
    const d = b.decision(await b.run(SELECT));
    expect(d.python_source).toBe('none');
    expect(d.needs_runtime).toBe('1');
  });

  it('a Python of 3.10 or newer and no uv: Python stays the Mac\'s, BotBoy\'s uv is needed (the runtime is one unit)', async () => {
    const b = box({ pythons: [['python3', '3.12.7']] });
    const d = b.decision(await b.run(SELECT));
    expect(d).toMatchObject({ python_source: 'system', uv_source: 'none', needs_runtime: '1' });
  });

  it('a uv older than 0.3.0, or one without uvx beside it, is not usable', async () => {
    const old = box({ pythons: [['python3', '3.12.7']], uv: { version: '0.2.37' } });
    expect(old.decision(await old.run(SELECT)).uv_reason).toBe(`${path.join(old.home, '.local', 'bin', 'uv')} is uv 0.2.37 (BotBoy needs 0.3.0 or newer)`);
    const lone = box({ pythons: [['python3', '3.12.7']], uv: { version: '0.13.0', uvx: false } });
    expect(lone.decision(await lone.run(SELECT)).uv_reason).toBe(`${path.join(lone.home, '.local', 'bin', 'uv')} has no uvx beside it`);
  });

  it('a Mac whose Python and uv both work: nothing is needed, nothing is downloaded at a start', async () => {
    const b = box({ pythons: [['python3', '3.12.7']], uv: { version: '0.13.0' } });
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(b.decision(r)).toMatchObject({ python_source: 'system', uv_source: 'system', needs_runtime: '0' });
    expect(server.requests).toEqual([]);
    expect(r.stdout).not.toContain('Waiting for BotBoy'); // no job, so the (long) join has nothing to announce
    expect(fs.existsSync(b.runtimeRoot)).toBe(false);
    expect(fs.existsSync(path.join(b.home, '.botboy-python'))).toBe(false);
  });

  it('BOTBOY_TEST_PREFER_PRIVATE_PYTHON=1 treats this Mac\'s own as unusable without running any of it; BOTBOY_PYTHON_RUNTIME=system still wins', async () => {
    const b = box({ pythons: [['python3', '3.12.7']], uv: { version: '0.13.0' } });
    const d = b.decision(await b.run(SELECT, [], { BOTBOY_TEST_PREFER_PRIVATE_PYTHON: '1' }));
    expect(d).toMatchObject({ python_source: 'none', uv_source: 'none', needs_runtime: '1' });
    expect(d.python_reason).toBe('BOTBOY_TEST_PREFER_PRIVATE_PYTHON=1 treats every system Python as unusable (a test switch)');
    expect(b.ownCalls()).toEqual([]);
    const sys = b.decision(await b.run(SELECT, [], { BOTBOY_TEST_PREFER_PRIVATE_PYTHON: '1', BOTBOY_PYTHON_RUNTIME: 'system' }));
    expect(sys).toMatchObject({ python_source: 'system', uv_source: 'system', needs_runtime: '0', mode: 'system' });
    const other = b.decision(await b.run(SELECT, [], { BOTBOY_TEST_PREFER_PRIVATE_PYTHON: 'yes' }));
    expect(other.python_source).toBe('system'); // only the value 1 turns it on
  });

  it('BOTBOY_PYTHON_RUNTIME=system never uses or downloads BotBoy\'s; =private always does', async () => {
    const off = box();
    const server = await off.serve();
    const r = await off.run(ENSURE, [], { BOTBOY_PYTHON_RUNTIME: 'system', BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(off.decision(r)).toMatchObject({ python_source: 'none', uv_source: 'none', needs_runtime: '0', mode: 'system' });
    expect(server.requests).toEqual([]);
    const on = box({ pythons: [['python3', '3.12.7']], uv: { version: '0.13.0' } });
    const s2 = await on.serve();
    const forced = await on.run(ENSURE, [], { BOTBOY_PYTHON_RUNTIME: 'private', BOTBOY_TEST_PYTHON_DIST_URL: s2.url });
    expect(on.decision(forced)).toMatchObject({ python_source: 'private', uv_source: 'private', python_reason: 'BOTBOY_PYTHON_RUNTIME=private is set' });
    expect(on.ownCalls()).toEqual([]);
  });
});

describe('the install (a real start runs it in the background)', () => {
  it('downloads both files once, checks them before unpacking, installs the CPython through BotBoy\'s uv from a local mirror, and puts both first on PATH', async () => {
    const b = box();
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    const d = b.decision(r);
    expect(d).toMatchObject({ python_source: 'private', uv_source: 'private', needs_runtime: '0', python_bin: b.pyBin(), uv_dir: b.uvDir() });
    expect(d.path.split(':').slice(0, 2)).toEqual([b.pyBin(), b.uvDir()]);
    expect(r.stdout).toContain("Setting up BotBoy's own Python in the background (uv 0.13.0 and CPython 3.13.16, about 40 MB from github.com, checksum verified, into ~/.personal-productivity-tracker/runtime)");
    expect(r.stdout).toContain("✅ BotBoy's Python is ready: uv 0.13.0 and CPython 3.13.16 (checksums verified)");
    expect(gets(server).map((request) => request.url)).toEqual([uvPath('0.13.0', 'arm64'), pythonPath('3.13.16', '20261009', 'arm64')]);
    // The uv folder: real binaries in libexec/, two wrappers, a marker; the CPython: the patch folder and its minor link.
    expect(fs.readdirSync(b.uvDir()).sort()).toEqual(['.botboy-runtime', 'libexec', 'uv', 'uvx']);
    expect(fs.readdirSync(path.join(b.uvDir(), 'libexec')).sort()).toEqual(['uv', 'uvx']);
    expect(fs.readlinkSync(path.join(b.runtimeRoot, 'python', b.minorKey))).toBe(b.pyKeyDir());
    expect(fs.readFileSync(path.join(b.pyKeyDir(), 'lib', 'python3.13', 'EXTERNALLY-MANAGED'), 'utf8')).toBe(
      '[externally-managed]\nError=BotBoy keeps its own Python read-only. In BotBoy chat, pip install <package> adds it to ~/.botboy-python. Elsewhere, use a virtual environment: python3 -m venv .venv && .venv/bin/pip install <package> (or uv venv, then uv pip install <package>).\n');
    // Nothing else is left behind, and Node's own folder lock and extract folders were never used.
    expect(b.runtimeEntries()).toEqual(['.download', 'python', 'uv-0.13.0-arm64']);
    expect(b.downloadsLeft()).toEqual([]);
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('the install step: PATH without /usr/bin (no install_name_tool, no Apple python3), no config, NO uv cache (the user\'s ~/.cache/uv is never touched), a file:// mirror', async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    const install = b.uvCalls().find((line) => line.startsWith('uv python install '))!;
    expect(install).toContain(`uv python install cpython-3.13.16-macos-aarch64-none --no-bin | env PATH=/bin:/usr/sbin:/sbin HOME=${b.home} UV_NO_CACHE=1 UV_NO_CONFIG=1 UV_CACHE_DIR= UV_PYTHON_INSTALL_DIR=${path.join(b.runtimeRoot, 'python')} UV_PYTHON_INSTALL_MIRROR=file://`);
    expect(install).toMatch(/UV_PYTHON_INSTALL_MIRROR=file:\/\/\/\S+\/\.py-extract-\d+\/mirror /);
    expect(install).toContain('install_name_tool=none');
    expect(fs.existsSync(path.join(b.home, '.cache'))).toBe(false);
    // Every uv call BotBoy makes runs without a cache of its own.
    for (const line of b.uvCalls()) expect(line, line).toContain('UV_NO_CACHE=1');
  });

  it('downloads nothing at the second start', async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    const before = server.requests.length;
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(b.decision(r)).toMatchObject({ python_source: 'private', uv_source: 'private', needs_runtime: '0' });
    expect(r.stdout).not.toContain('Setting up');
    expect(server.requests.length).toBe(before);
  });

  it('chooses the x86_64 files on an Intel Mac and the aarch64 ones on Apple silicon', async () => {
    for (const arch of ['x64', 'arm64'] as const) {
      const b = box({ arch });
      const server = await b.serve();
      const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
      expect(b.decision(r), arch).toMatchObject({ python_source: 'private', chip: arch, uv_dir: b.uvDir('0.13.0', arch) });
      expect(gets(server).map((request) => request.url)).toEqual([uvPath('0.13.0', arch), pythonPath('3.13.16', '20261009', arch)]);
      expect(fs.existsSync(path.join(b.runtimeRoot, 'python', `cpython-3.13-macos-${TRIPLE_ARCH[arch]}-none`))).toBe(true);
    }
  });

  it('a checksum that does not match deletes the file, never unpacks it, and the start goes on without Python', async () => {
    const b = box();
    const wrong = Buffer.from(b.setFor().arm64!.uv.body);
    wrong[wrong.length - 1] ^= 0xff;
    const server = await b.serve({ [uvPath('0.13.0', 'arm64')]: { body: wrong } });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain("BotBoy deleted a download of its Python: its checksum does not match the one BotBoy has on record (uv-aarch64-apple-darwin.tar.gz: expected ");
    expect(r.stdout).toContain('It was not unpacked or run. BotBoy starts without Python.');
    expect(b.tarCalls()).toEqual([]);
    expect(b.decision(r)).toMatchObject({ python_source: 'none', uv_source: 'none' });
    expect(b.downloadsLeft()).toEqual([]);
    expect(gets(server).map((request) => request.url)).toEqual([uvPath('0.13.0', 'arm64')]); // the second file is never fetched
  });

  it('offline (nothing listens): one line names github.com and the next step; the start goes on without Python; no partial folder', async () => {
    const b = box();
    const r = await b.run(ENSURE); // the test setup's closed loopback port
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toMatch(/Could not reach github\.com to download BotBoy's Python \(curl exit 7\)\. BotBoy starts without Python; the next \.\/start\.sh continues\./);
    expect(r.stdout).toContain('Next: Check your internet connection, VPN or proxy.');
    expect(b.curlCalls()).toHaveLength(1); // it stops at the first network failure
    expect(b.runtimeEntries().filter((name) => !['.download'].includes(name))).toEqual([]);
    expect(b.tripwireCalls()).toEqual([]);
  });

  it('an interrupted download resumes with a Range request and finishes', async () => {
    const b = box();
    const server = await b.serve({ [uvPath('0.13.0', 'arm64')]: { body: b.setFor().arm64!.uv.body, cutAfter: 50_000, cutTimes: 1 } });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(r.status, text(r)).toBe(0);
    expect(b.decision(r).python_source).toBe('private');
    const uvGets = gets(server).filter((request) => request.url === uvPath('0.13.0', 'arm64'));
    expect(uvGets.length).toBeGreaterThanOrEqual(2);
    expect(uvGets[1].range).toMatch(/^bytes=\d+-$/);
  });

  it('a link too slow for the deadline: curl exit 28 after bytes arrived is "slow", not "offline"; the partial file stays and the next start resumes it', async () => {
    const b = box();
    const uvBody = b.setFor().arm64!.uv.body;
    const slow = await startStallServer({ [uvPath('0.13.0', 'arm64')]: { body: uvBody, sendBytes: 30_000 } });
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: slow.url, BOTBOY_TEST_PYTHON_BUDGET_SECONDS: '6' }); // room for the job's checks before curl, on a loaded machine
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain("BotBoy's Python is still downloading (the link is slow, curl exit 28). BotBoy starts without it and continues at the next start.");
    expect(r.stdout).not.toContain('Could not reach github.com');
    expect(r.ms).toBeLessThan(15_000); // curl's own retries stop at the deadline too
    const part = path.join(b.runtimeRoot, '.download', 'uv-aarch64-apple-darwin.tar.gz.part');
    const kept = fs.statSync(part).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(30_000);
    const good = await b.serve();
    const again = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: good.url });
    expect(b.decision(again).python_source).toBe('private');
    expect(gets(good).find((request) => request.url === uvPath('0.13.0', 'arm64'))!.range).toBe(`bytes=${kept}-`);
  });

  it('refuses a full disk and a macOS older than 11 before it downloads or creates anything; the start goes on', async () => {
    const full = box({ freeKb: 400_000 });
    const s1 = await full.serve();
    const r1 = await full.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: s1.url });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("Not enough free disk space to set up BotBoy's Python: it needs about 1 GB free and this Mac has 0.4 GB. BotBoy starts without Python.");
    expect(s1.requests).toEqual([]);
    const old = box({ macos: '10.15.7' });
    const s2 = await old.serve();
    const r2 = await old.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: s2.url });
    expect(r2.stdout).toContain("BotBoy's Python needs macOS 11.0 or newer, and this Mac runs macOS 10.15.7. BotBoy starts without Python.");
    expect(s2.requests).toEqual([]);
  });

  it('its own folder lock: a live holder makes this start go on without waiting; a dead holder\'s lock is taken over; Node\'s lock is never used', async () => {
    const b = box();
    const server = await b.serve();
    const lock = path.join(b.runtimeRoot, '.python.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); // this test process: alive
    const held = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(held.status, text(held)).toBe(0);
    expect(held.stdout).toContain("Another ./start.sh is already setting up BotBoy's Python");
    expect(server.requests).toEqual([]);
    fs.writeFileSync(path.join(lock, 'pid'), String(spawnSync(process.execPath, ['-e', '0']).pid)); // gone
    const taken = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(b.decision(taken).python_source).toBe('private');
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(path.join(b.runtimeRoot, '.lock'))).toBe(false);
  });

  it('a CPython that no longer runs is detected and fetched again once (only that file); a broken uv folder is replaced the same way', async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    fs.writeFileSync(path.join(b.pyKeyDir(), 'bin', 'python3.13'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const sel = await b.run(SELECT);
    expect(b.decision(sel)).toMatchObject({ python_source: 'none', needs_runtime: '1' });
    const before = gets(server).length;
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(b.decision(r).python_source).toBe('private');
    expect(gets(server).slice(before).map((request) => request.url)).toEqual([pythonPath('3.13.16', '20261009', 'arm64')]);
    fs.writeFileSync(path.join(b.uvDir(), 'libexec', 'uv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const again = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(b.decision(again).uv_source).toBe('private');
    expect(gets(server).at(-1)!.url).toBe(uvPath('0.13.0', 'arm64'));
  });

  it('a new pin: the new uv and CPython are fetched and checked first; the old uv goes unless a process still runs from it', async () => {
    const b = box();
    const first = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: first.url });
    b.writePin({ uv: '0.13.1', python: '3.13.16' });
    const second = await b.serve({}, { uv: '0.13.1', python: '3.13.16' });
    // Until the new uv is in place the old one stays in use.
    expect(b.decision(await b.run(SELECT))).toMatchObject({ uv_source: 'private', uv_dir: b.uvDir('0.13.0'), needs_runtime: '1' });
    b.stub('pgrep', `case "$*" in *uv-0.13.0-arm64*) exit 0 ;; *) exit 1 ;; esac`);
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: second.url });
    expect(b.decision(r)).toMatchObject({ uv_source: 'private', uv_dir: b.uvDir('0.13.1') });
    expect(gets(second).map((request) => request.url)).toEqual([uvPath('0.13.1', 'arm64')]); // the CPython did not change
    expect(fs.existsSync(b.uvDir('0.13.0'))).toBe(true); // a process runs from it
    expect(b.logText()).toContain(`Kept ${b.uvDir('0.13.0')}: a process still runs from it`);
    // The next start retires it, right before its server starts, once nothing runs from it.
    b.stub('pgrep', 'exit 1');
    await b.run('BOTBOY_TEST_PYTHON_MAINTENANCE');
    expect(fs.readdirSync(b.runtimeRoot).filter((name) => name.startsWith('uv-')).sort()).toEqual(['uv-0.13.1-arm64']);
  });

  it('wrappers of an older generation are written again at the next start, without a download', async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    fs.writeFileSync(path.join(b.uvDir(), 'uv'), '#!/bin/sh\nexec "$(dirname "$0")/libexec/uv" "$@"\n', { mode: 0o755 });
    expect(b.decision(await b.run(SELECT))).toMatchObject({ uv_source: 'none', needs_runtime: '1' });
    const before = server.requests.length;
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(b.decision(r).uv_source).toBe('private');
    expect(server.requests.length).toBe(before);
    expect(fs.readFileSync(path.join(b.uvDir(), 'uv'), 'utf8')).toContain('# botboy-uv-wrapper 1');
    expect(r.stdout).not.toContain('Setting up');
  });
});

describe('the uv and uvx wrappers', () => {
  const installed = async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    return b;
  };
  const wrapped = (b: Box, name: 'uv' | 'uvx', extra: Record<string, string> = {}) => {
    const result = spawnSync(path.join(b.uvDir(), name), ['--version'], { env: { HOME: b.home, PATH: '/usr/bin:/bin', ...extra }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return b.uvCalls().at(-1)!;
  };

  it('set BotBoy\'s settings as defaults: managed Python only, no automatic downloads, the read-only runtime, and everything written in ~/.botboy-python', async () => {
    const b = await installed();
    const real = fs.realpathSync(b.runtimeRoot);
    const line = wrapped(b, 'uv');
    expect(line).toContain(`UV_CACHE_DIR=${b.home}/.botboy-python/cache`);
    expect(line).toContain(`UV_PYTHON_INSTALL_DIR=${real}/python `);
    expect(line).toContain('UV_MANAGED_PYTHON=1 UV_PYTHON_DOWNLOADS=manual');
    expect(line).toContain(`UV_TOOL_DIR=${b.home}/.botboy-python/tools UV_TOOL_BIN_DIR=${b.home}/.botboy-python/bin UV_PYTHON_BIN_DIR=${b.home}/.botboy-python/bin`);
    expect(wrapped(b, 'uvx')).toContain('UV_MANAGED_PYTHON=1');
  });

  it('a value the environment already has wins, and a declared preference turns the managed-only default off', async () => {
    const b = await installed();
    const line = wrapped(b, 'uv', { UV_CACHE_DIR: '/declared/cache', UV_PYTHON_DOWNLOADS: 'automatic', UV_TOOL_BIN_DIR: '/declared/bin' });
    expect(line).toContain('UV_CACHE_DIR=/declared/cache');
    expect(line).toContain('UV_PYTHON_DOWNLOADS=automatic');
    expect(line).toContain('UV_TOOL_BIN_DIR=/declared/bin');
    expect(wrapped(b, 'uv', { UV_PYTHON_PREFERENCE: 'only-system' })).toContain('UV_MANAGED_PYTHON= ');
    expect(wrapped(b, 'uv', { UV_NO_MANAGED_PYTHON: '1' })).toContain('UV_MANAGED_PYTHON= ');
  });

  it('a runtime folder with a quote in its path still works (every path is one shell word)', async () => {
    const b = box();
    const oddHome = path.join(b.root, "o'dd home");
    fs.mkdirSync(oddHome);
    const server = await b.serve();
    const r = await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url, HOME: oddHome });
    expect(b.decision(r).uv_source, text(r)).toBe('private');
    const uv = path.join(oddHome, '.personal-productivity-tracker', 'runtime', 'uv-0.13.0-arm64', 'uv');
    const result = spawnSync(uv, ['--version'], { env: { HOME: oddHome, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(result.stdout.trim()).toBe('uv 0.13.0 (fake)');
    expect(b.uvCalls().at(-1)).toContain(`UV_PYTHON_INSTALL_DIR=${fs.realpathSync(oddHome)}/.personal-productivity-tracker/runtime/python `);
  });
});

describe('modes that must never download', () => {
  it('--doctor, --stop, --recover-shutdown, --open-window and --rebuild-ocr fetch nothing; a start and --foreground may', async () => {
    const b = box();
    const server = await b.serve();
    for (const [args, allowed] of [
      [['--doctor'], '0'], [['--stop'], '0'], [['--recover-shutdown'], '0'], [['--open-window'], '0'], [['--rebuild-ocr'], '0'],
      [[], '1'], [['--foreground'], '1'],
    ] as const) {
      const r = await b.run(SELECT, [...args], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
      expect(b.decision(r).download_allowed, args.join(' ')).toBe(allowed);
    }
    for (const mode of ['--doctor', '--stop', '--recover-shutdown', '--open-window', '--rebuild-ocr']) {
      const r = await b.run(ENSURE, [mode], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
      expect(b.decision(r).needs_runtime, mode).toBe('1');
    }
    expect(server.requests).toEqual([]);
    const fg = await b.run(ENSURE, ['--foreground'], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(b.decision(fg).python_source).toBe('private');
  });

  it('the download has exactly the callers it should: the start flow (after the lock) and the update that will not start', () => {
    const source = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    const begin = [...source.matchAll(/^\[ "\$PYTHON_RUNTIME_LOADED" != "1" \] \|\| python_runtime_fetch_begin$/gm)];
    expect(begin).toHaveLength(1);
    const ensureNode = source.indexOf('[ "$NODE_RUNTIME_LOADED" != "1" ] || ensure_node_runtime\n');
    // Right after Node's own setup, before npm install and the build, after the start lock.
    expect(begin[0].index!).toBeGreaterThan(ensureNode);
    expect(begin[0].index!).toBeLessThan(source.indexOf('heal_missing_npm_dependencies\n', ensureNode));
    expect(begin[0].index!).toBeGreaterThan(source.indexOf('trap on_start_exit EXIT'));
    expect([...source.matchAll(/python_runtime_update_prefetch/g)]).toHaveLength(1);
    const library = fs.readFileSync(path.join(packageRoot, 'scripts', 'python-runtime.sh'), 'utf8');
    expect([...library.matchAll(/"\$PY_CURL" /g)]).toHaveLength(2); // the -x check and the one call, in one download function
    expect(source).not.toMatch(/astral-sh|python-build-standalone/);
  });
});

describe('a real start: the download overlaps npm and the build, and is joined before the server starts', () => {
  const startEnv = async (b: Box, extra: Record<string, string> = {}) => ({
    BOTBOY_TEST_CDP_ORIGIN: await startCdpStandIn(),
    BOTBOY_TEST_APP_ORIGIN: 'http://127.0.0.1:9',
    ...extra,
  });
  const built = (b: Box) => {
    // A checkout whose build is current: dist/index.js and a build marker newer than everything it compares.
    fs.mkdirSync(path.join(b.app, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(b.app, 'dist', 'index.js'), '');
    const marker = path.join(b.app, 'dist', '.build-commit');
    fs.writeFileSync(marker, '');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(marker, future, future);
  };

  it('a first start: the download began before the build ended, the join waited for it, and the server\'s PATH has BotBoy\'s Python first', async () => {
    const b = box();
    const server = await b.serve();
    const r = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], await startEnv(b, { BOTBOY_TEST_PYTHON_DIST_URL: server.url, BOTBOY_FAKE_BUILD_SECONDS: '2' }));
    expect(r.status, text(r)).toBe(0);
    const d = b.decision(r);
    expect(d).toMatchObject({ python_source: 'private', uv_source: 'private' });
    expect(d.server_path.split(':').slice(0, 2)).toEqual([b.pyBin(), b.uvDir()]);
    const order = b.orderLines();
    expect(order.findIndex((line) => line.startsWith('curl '))).toBeGreaterThanOrEqual(0);
    expect(order.findIndex((line) => line.startsWith('curl '))).toBeLessThan(order.indexOf('build end'));
    expect(fs.existsSync(path.join(b.root, 'start.lock'))).toBe(false);
  });

  it('a restart with nothing to build waits at most 20 s (here 5 s), then stops the download, keeps its partial file, and starts without Python', async () => {
    const b = box();
    built(b);
    const stall = await startStallServer({ [uvPath('0.13.0', 'arm64')]: { body: b.setFor().arm64!.uv.body, sendBytes: 20_000 } });
    // 5 s leaves room for the job's checks before curl writes its first bytes, on a loaded machine.
    const r = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], await startEnv(b, { BOTBOY_TEST_PYTHON_DIST_URL: stall.url, BOTBOY_TEST_PYTHON_RESTART_JOIN_SECONDS: '5' }));
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain("BotBoy's Python is still downloading; BotBoy starts without it and continues at the next start.");
    // The job was still running at the join: one line names the bound first, then the wait, then the stop.
    const said = r.stdout.split('\n');
    expect(said.filter((line) => line.includes('Waiting for BotBoy'))).toEqual(["ℹ️  Waiting for BotBoy's Python download (at most 5 s)…"]);
    expect(said.indexOf("ℹ️  Waiting for BotBoy's Python download (at most 5 s)…")).toBeLessThan(said.findIndex((line) => line.includes("BotBoy's Python is still downloading; BotBoy starts without it")));
    expect(r.ms).toBeLessThan(15_000);
    const d = b.decision(r);
    expect(d).toMatchObject({ python_source: 'none', uv_source: 'none' });
    expect(d.server_path).not.toContain('.personal-productivity-tracker/runtime/');
    const kept = fs.statSync(path.join(b.runtimeRoot, '.download', 'uv-aarch64-apple-darwin.tar.gz.part')).size;
    expect(kept).toBeGreaterThan(0); // what arrived stays for the next start
    expect(kept).toBeLessThanOrEqual(20_000);
    expect(fs.existsSync(path.join(b.runtimeRoot, '.python.lock'))).toBe(false);
    expect(spawnSync('/usr/bin/pgrep', ['-f', stall.url]).status).toBe(1); // no curl left running
  });

  it('the start of an update (BOTBOY_FORCE_BUILD) builds and still waits only the short limit for a stalled download', async () => {
    const b = box();
    const stall = await startStallServer({ [uvPath('0.13.0', 'arm64')]: { body: b.setFor().arm64!.uv.body, sendBytes: 20_000 } });
    const r = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], await startEnv(b, { BOTBOY_TEST_PYTHON_DIST_URL: stall.url, BOTBOY_TEST_PYTHON_RESTART_JOIN_SECONDS: '2', BOTBOY_FORCE_BUILD: '1', BOTBOY_TEST_PYTHON_BUDGET_SECONDS: '60' }));
    expect(r.status, text(r)).toBe(0);
    expect(b.orderLines()).toContain('build end');
    expect(r.stdout).toContain("Waiting for BotBoy's Python download (at most 2 s)…");
    expect(r.stdout).toContain("BotBoy's Python is still downloading");
    expect(r.ms).toBeLessThan(20_000);
  });

  it('a first start whose download still runs after the build: one line names the long bound (the deadline + 10 s) before the wait, then the job\'s own lines', async () => {
    const b = box();
    const stall = await startStallServer({ [uvPath('0.13.0', 'arm64')]: { body: b.setFor().arm64!.uv.body, sendBytes: 20_000 } });
    // A 6 s deadline ends curl by itself; the long join's bound (the deadline + 10 s) stays far above the restart's 3 s.
    const r = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], await startEnv(b, { BOTBOY_TEST_PYTHON_DIST_URL: stall.url, BOTBOY_TEST_PYTHON_BUDGET_SECONDS: '6', BOTBOY_TEST_PYTHON_RESTART_JOIN_SECONDS: '3', BOTBOY_FAKE_BUILD_SECONDS: '1' }));
    expect(r.status, text(r)).toBe(0);
    const waiting = /Waiting for BotBoy's Python download \(at most (\d+) s\)…/.exec(r.stdout);
    expect(waiting, text(r)).not.toBeNull();
    expect(Number(waiting![1])).toBeGreaterThan(3);
    expect(Number(waiting![1])).toBeLessThanOrEqual(16);
    expect(r.stdout.match(/Waiting for BotBoy/g)).toHaveLength(1);
    expect(waiting!.index).toBeGreaterThan(r.stdout.indexOf('✅ Build complete'));
    const jobLine = /⚠️ {2}(BotBoy's Python is still downloading \(the link is slow|Could not reach github\.com)/.exec(r.stdout);
    expect(jobLine, text(r)).not.toBeNull();
    expect(waiting!.index).toBeLessThan(jobLine!.index); // the job's own lines are printed after the wait
    expect(b.decision(r)).toMatchObject({ python_source: 'none', uv_source: 'none' });
  });

  it('a download that ended before the join: its own lines, and no waiting line', async () => {
    const b = box();
    // Offline (the test setup's closed port): the job stops at its first curl call, and the build begins only after the
    // job has said why, so the join finds it finished.
    const r = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], await startEnv(b, { BOTBOY_FAKE_BUILD_AFTER_LOG: 'Next: Check your internet connection', BOTBOY_FAKE_BUILD_SECONDS: '1' }));
    expect(r.status, text(r)).toBe(0);
    expect(r.stdout).toContain("Could not reach github.com to download BotBoy's Python (curl exit 7)");
    expect(r.stdout).not.toContain('Waiting for BotBoy');
    expect(b.decision(r)).toMatchObject({ python_source: 'none', uv_source: 'none' });
  });

  it('a failed build ends the start and leaves no download job behind', async () => {
    const b = box();
    const stall = await startStallServer({ [uvPath('0.13.0', 'arm64')]: { body: b.setFor().arm64!.uv.body, sendBytes: 20_000 } });
    const r = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], await startEnv(b, { BOTBOY_TEST_PYTHON_DIST_URL: stall.url, BOTBOY_FAKE_BUILD_RC: '1', BOTBOY_FAKE_BUILD_SECONDS: '1' }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Build failed');
    expect(fs.existsSync(path.join(b.runtimeRoot, '.python.lock'))).toBe(false);
    expect(spawnSync('/usr/bin/pgrep', ['-f', stall.url]).status).toBe(1);
    expect(fs.existsSync(path.join(b.root, 'start.lock'))).toBe(false);
  });

  it('a Mac whose own Python and uv work: the server\'s PATH and environment are byte-identical to a checkout without scripts/python-runtime.sh', async () => {
    const b = box({ pythons: [['python3', '3.12.7'], ['python3.13', '3.13.5']], uv: { version: '0.13.0' } });
    built(b);
    const extra = await startEnv(b);
    const withIt = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], extra);
    expect(withIt.status, text(withIt)).toBe(0);
    expect(b.decision(withIt)).toMatchObject({ python_source: 'system', uv_source: 'system', needs_runtime: '0' });
    expect(withIt.stdout).not.toContain('Waiting for BotBoy');
    fs.rmSync(path.join(b.app, 'scripts', 'python-runtime.sh'));
    const without = await b.run('BOTBOY_TEST_PYTHON_AFTER_JOIN', [], extra);
    expect(without.status, text(without)).toBe(0);
    const server = (r: Run) => r.stdout.split('\n').filter((line) => line.startsWith('server_path=') || line.startsWith('server_env: '));
    expect(server(withIt).length).toBeGreaterThan(5);
    expect(server(withIt)).toEqual(server(without));
    expect(fs.existsSync(path.join(b.home, '.botboy-python'))).toBe(false);
  });

  it('the join sits right before the server is started, and the upkeep right after the last takeover, in both modes', () => {
    const source = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    const joins = [...source.matchAll(/\n {2}python_runtime_fetch_join\nfi\n/g)];
    expect(joins).toHaveLength(1); // the flow's join (the test hook's is indented deeper)
    const join = joins[0].index!;
    expect(join).toBeGreaterThan(source.indexOf('echo "✅ Build complete"'));
    expect(join).toBeLessThan(source.indexOf('if [ "$FOREGROUND" = "1" ]; then\n  # ── Foreground mode'));
    const spawns = [...source.matchAll(/"\$NODE" dist\/index\.js/g)].map((match) => match.index!);
    expect(spawns).toHaveLength(2);
    for (const at of spawns) {
      const before = source.slice(0, at);
      const takeover = before.lastIndexOf('safe_takeover || exit 1');
      const upkeep = before.lastIndexOf('[ "$PYTHON_RUNTIME_LOADED" != "1" ] || python_runtime_maintenance');
      expect(upkeep).toBeGreaterThan(takeover);
      expect(source.slice(upkeep, at)).not.toContain('safe_takeover');
    }
    expect(source).toMatch(/on_start_exit\(\) \{\n {2}release_start_lock\n {2}\[ "\$PYTHON_RUNTIME_LOADED" != "1" \] \|\| python_runtime_fetch_abort\n\}/);
  });
});

describe('the weekly upkeep (right before the server starts, after the old one is gone)', () => {
  const MAINT = 'BOTBOY_TEST_PYTHON_MAINTENANCE';
  const installed = async () => {
    const b = box();
    const server = await b.serve();
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    const cache = path.join(b.home, '.botboy-python', 'cache');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'blob'), Buffer.alloc(64 * 1024));
    return b;
  };
  const stamp = (b: Box) => fs.readFileSync(path.join(b.home, '.botboy-python', '.maintenance'), 'utf8');

  it('does nothing without ~/.botboy-python', async () => {
    const b = box();
    const r = await b.run(MAINT);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(b.home, '.botboy-python'))).toBe(false);
  });

  it('is skipped at once, without waiting, while a process runs from BotBoy\'s Python, and the stamp says so', async () => {
    const b = await installed();
    b.stub('pgrep', 'exit 0');
    const r = await b.run(MAINT, [], { BOTBOY_TEST_PYTHON_PRUNE_KB: '1' });
    expect(r.ms).toBeLessThan(10_000);
    expect(stamp(b)).toMatch(/^\d+ skipped: a process runs from BotBoy's Python\n$/);
    expect(b.uvCalls().some((line) => line.startsWith('uv cache'))).toBe(false);
  });

  it('prunes BotBoy\'s own cache above the limit (never the user\'s), cleans it when still above the second limit, writes the stamp, and waits a week', async () => {
    const b = await installed();
    const r = await b.run(MAINT, [], { BOTBOY_TEST_PYTHON_PRUNE_KB: '1', BOTBOY_TEST_PYTHON_CLEAN_KB: '1' });
    expect(r.status).toBe(0);
    const calls = b.uvCalls().filter((line) => line.startsWith('uv cache'));
    expect(calls.map((line) => line.split(' | ')[0])).toEqual(['uv cache prune', 'uv cache clean']);
    for (const line of calls) expect(line).toContain(`UV_CACHE_DIR=${b.home}/.botboy-python/cache`);
    expect(stamp(b)).toMatch(/^\d+ pruned the cache \(\d+ KB\); cleaned the cache \(\d+ KB\)\n$/);
    const upkeep = () => b.uvCalls().filter((line) => line.startsWith('uv cache') || line.startsWith('uv python uninstall')).length;
    const again = upkeep();
    await b.run(MAINT, [], { BOTBOY_TEST_PYTHON_PRUNE_KB: '1' });
    expect(upkeep()).toBe(again);
  });

  it('below the limit it only measures; an older patch of the pinned minor is uninstalled through uv', async () => {
    const b = await installed();
    fs.mkdirSync(path.join(b.runtimeRoot, 'python', 'cpython-3.13.15-macos-aarch64-none'), { recursive: true });
    await b.run(MAINT);
    expect(b.uvCalls().filter((line) => line.startsWith('uv cache'))).toEqual([]);
    expect(b.uvCalls().find((line) => line.startsWith('uv python uninstall'))).toContain('uv python uninstall cpython-3.13.15-macos-aarch64-none');
    expect(fs.existsSync(path.join(b.runtimeRoot, 'python', 'cpython-3.13.15-macos-aarch64-none'))).toBe(false);
    expect(fs.existsSync(b.pyKeyDir())).toBe(true);
    expect(stamp(b)).toMatch(/cache \d+ KB, nothing to prune; removed the older cpython-3\.13\.15-macos-aarch64-none/);
  });
});

describe('the doctor rows (read-only)', () => {
  it('say system with version and path on a Mac whose own work, and that BotBoy\'s is not needed', async () => {
    const b = box({ pythons: [['python3', '3.12.7']], uv: { version: '0.13.0' } });
    const r = await b.run(DOCTOR);
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      `python source: system 3.12.7 at ${path.join(b.home, '.local', 'bin', 'python3')} (BotBoy's own Python is not needed for it)`,
      `uv source: system 0.13.0 at ${path.join(b.home, '.local', 'bin', 'uv')} (BotBoy's own uv is not needed for it)`,
      'python runtime: pinned uv 0.13.0 + CPython 3.13.16 (build 20261009, supported until 2099-10-31), arm64; not installed, and not needed: this Mac\'s own Python and uv work',
      'python files: ~/.botboy-python not created (it holds what BotBoy\'s chat and servers install with pip or uv)',
    ]);
  });

  it('say private, why, and where, once installed; and the real doctor shows them once, after the Node rows', async () => {
    const b = box();
    const server = await b.serve();
    expect((await b.run(DOCTOR)).stdout).toContain('not installed; the next ./start.sh downloads it from github.com in the background');
    await b.run(ENSURE, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    const r = await b.run(DOCTOR, [], { BOTBOY_TEST_PYTHON_DIST_URL: server.url });
    expect(r.stdout).toContain(`python source: private 3.13.16 because ${b.shim} is Apple's Python stand-in (not run)`);
    expect(r.stdout).toContain(`uv source: private 0.13.0 because no uv was found on this Mac (${b.uvDir()}/uv)`);
    expect(r.stdout).toContain('installed in ~/.personal-productivity-tracker/runtime (uv-0.13.0-arm64, python/) and in use; no download needed');
    const source = fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8');
    const doctor = source.slice(source.indexOf('if [ "$DOCTOR" = "1" ]; then'));
    expect(doctor.match(/^ {2}\[ "\$PYTHON_RUNTIME_LOADED" != "1" \] \|\| doctor_python_rows$/gm)).toHaveLength(1);
    expect(doctor.indexOf('doctor_python_rows')).toBeGreaterThan(doctor.indexOf('doctor_node_runtime_rows'));
    expect(server.requests.length).toBe(2); // the doctor itself downloaded nothing
  });
});

describe('the update that will not start BotBoy', () => {
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const hasGit = spawnSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }).status === 0;
  it.runIf(hasGit)('fetches a changed pin before the start that would, and a Mac whose own Python and uv work downloads nothing', async () => {
    for (const own of [false, true]) {
      const b = own ? box({ clt: true, pythons: [['python3', '3.12.7']], uv: { version: '0.13.0' } }) : box({ clt: true });
      fs.rmSync(path.join(b.stubs, 'git'));
      fs.writeFileSync(path.join(b.app, '.botboy-distribution'), '');
      // The pin lives in the checkout for this case (the release changes it).
      fs.copyFileSync(path.join(b.root, 'python-runtime.pin'), path.join(b.app, 'python-runtime.pin'));
      const origin = path.join(b.root, 'origin.git');
      spawnSync('/usr/bin/git', ['init', '-q', '--bare', '-b', 'main', origin]);
      git(b.app, ['init', '-q', '-b', 'main']);
      git(b.app, ['add', '-A']);
      git(b.app, ['commit', '-q', '-m', 'release 1']);
      git(b.app, ['remote', 'add', 'origin', origin]);
      git(b.app, ['push', '-q', '-u', 'origin', 'main']);
      const extraEnv = { BOTBOY_TEST_PYTHON_RUNTIME_PIN: path.join(b.app, 'python-runtime.pin'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file', BOTBOY_TEST_GIT_SHIM: '/usr/bin/git' };
      const first = await b.serve();
      if (!own) await b.run(ENSURE, [], { ...extraEnv, BOTBOY_TEST_PYTHON_DIST_URL: first.url });
      const publisher = path.join(b.root, 'publisher');
      spawnSync('/usr/bin/git', ['clone', '-q', origin, publisher]);
      b.writePin({ uv: '0.13.1', python: '3.13.16' });
      fs.copyFileSync(path.join(b.root, 'python-runtime.pin'), path.join(publisher, 'python-runtime.pin'));
      git(publisher, ['add', '-A']);
      git(publisher, ['commit', '-q', '-m', 'release 2']);
      git(publisher, ['push', '-q', 'origin', 'main']);
      const second = await b.serve({}, { uv: '0.13.1', python: '3.13.16' });
      const r = await b.run(null, ['--update'], { ...extraEnv, BOTBOY_UPDATE_NO_START: '1', BOTBOY_TEST_PYTHON_DIST_URL: second.url });
      expect(r.status, text(r)).toBe(0);
      if (own) {
        expect(second.requests, 'own').toEqual([]);
        expect(fs.existsSync(b.runtimeRoot)).toBe(false);
      } else {
        expect(r.stdout).toContain("✅ BotBoy's Python is ready for the new release");
        expect(gets(second).map((request) => request.url)).toEqual([uvPath('0.13.1', 'arm64')]);
        expect(fs.existsSync(b.uvDir('0.13.1'))).toBe(true);
      }
    }
  });
});

describe('scripts/python-runtime.sh never reaches an Xcode stand-in', () => {
  const library = fs.readFileSync(path.join(packageRoot, 'scripts', 'python-runtime.sh'), 'utf8');
  const code = library.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  it('names /usr/bin/python3 only as the path it skips, never runs git, xcrun, xcode-select, install_name_tool or brew', () => {
    expect(code.filter((line) => line.includes('/usr/bin/python3'))).toEqual(['PY_SHIM="/usr/bin/python3"']);
    expect(code.filter((line) => /\b(git|xcrun|xcode-select|install_name_tool|brew|lipo|otool)\b/.test(line))).toEqual([]);
  });
  it('runs a Python only after the stand-in check, and every install-step uv runs without /usr/bin on PATH and without a cache', () => {
    const find = library.slice(library.indexOf('python_find_system() {'), library.indexOf('# Rule 1 for uv.'));
    expect(find.indexOf('python_is_apple_stand_in "$candidate"')).toBeLessThan(find.indexOf('python_probe_version "$found"'));
    const installs = code.filter((line) => line.includes('python install') || line.includes('python uninstall'));
    expect(installs.length).toBeGreaterThanOrEqual(2);
    for (const line of code.filter((l) => /env -i /.test(l))) expect(line).toContain('PATH=/bin:/usr/sbin:/sbin');
    expect(library).toMatch(/env -i HOME="\$HOME" PATH=\/bin:\/usr\/sbin:\/sbin UV_NO_CONFIG=1 UV_NO_CACHE=1 \\\n\s+UV_PYTHON_INSTALL_DIR=/);
  });
});

describe.runIf(fs.existsSync(path.join(packageRoot, 'scripts', 'release.sh')))('what the release ships', () => {
  it('the library start.sh sources and the pin it reads; never the verifier or the dev live check', () => {
    const script = fs.readFileSync(path.join(packageRoot, 'scripts', 'release.sh'), 'utf8');
    const block = script.match(/^PATHS=\(\n([\s\S]*?)^\)/m)![1].split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
    expect(block).toContain('scripts/python-runtime.sh');
    expect(block).toContain('python-runtime.pin');
    expect(block).not.toContain('scripts/verify-python-runtime.mjs');
    expect(block.filter((entry) => entry.startsWith('scripts/dev'))).toEqual([]);
    expect(fs.readFileSync(path.join(packageRoot, 'start.sh'), 'utf8')).toContain('"$PROJ_DIR/scripts/python-runtime.sh"');
    expect(fs.readFileSync(path.join(packageRoot, 'scripts', 'python-runtime.sh'), 'utf8')).toContain('$PROJ_DIR/python-runtime.pin');
  });
});

describe.runIf(verifierPresent)('the bash reader and the Node reader agree on the pin', () => {
  const bashRead = (pinFile: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-pypin-read-'));
    roots.push(dir);
    const script = `PROJ_DIR='${packageRoot}'; HOME='${dir}'; HW_ARM64=1; LOG_FILE='${dir}/log'
. '${path.join(packageRoot, 'scripts', 'python-runtime.sh')}'
PY_RUNTIME_PIN_FILE='${pinFile}'
if python_runtime_read_pin; then echo "ok uv=$PR_UV_VERSION py=$PR_PY_VERSION build=$PR_PY_BUILD eol=$PR_PY_EOL uvarm=$PR_UV_SHA_ARM64:$PR_UV_BYTES_ARM64 uvx64=$PR_UV_SHA_X64:$PR_UV_BYTES_X64 pyarm=$PR_PY_SHA_ARM64:$PR_PY_BYTES_ARM64 pyx64=$PR_PY_SHA_X64:$PR_PY_BYTES_X64"; else echo "error $PR_ERROR"; fi`;
    return spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' }).stdout.trim();
  };
  const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(64));
  const good = pyPinText({ uv: { arm64: { sha256: A, bytes: 14_000_000 }, x64: { sha256: B, bytes: 18_000_000 } }, python: { arm64: { sha256: C, bytes: 25_000_000 }, x64: { sha256: D, bytes: 24_000_000 } } });
  const cases: [string, string, boolean][] = [
    ['the real pin', fs.readFileSync(path.join(packageRoot, 'python-runtime.pin'), 'utf8'), true],
    ['a full pin', good, true],
    ['a CRLF file', good.replace(/\n/g, '\r\n'), true],
    ['trailing spaces', good.replace('uv.version=0.13.0', 'uv.version=0.13.0   '), true],
    ['an unknown key', `${good}mystery=1\n`, false],
    ['a duplicate key', `${good}uv.version=0.13.1\n`, false],
    ['no schema', good.replace('schema=1\n', ''), false],
    ['a short uv version', good.replace('uv.version=0.13.0', 'uv.version=0.13'), false],
    ['a Python 2', good.replace('python.version=3.13.16', 'python.version=2.7.18'), false],
    ['a build tag that is not 8 digits', good.replace('python.build=20261009', 'python.build=2026109'), false],
    ['an upper-case hash', good.replace(A, 'A'.repeat(64)), false],
    ['a chip pinned for uv only', good.replace(/python\.darwin-x64\.\w+=\w+\n/g, ''), false],
    ['no chip at all', pyPinText(), false],
    ['a bad date', good.replace('python.eol=2099-10-31', 'python.eol=soon'), false],
  ];
  for (const [name, content, valid] of cases) {
    it(`${name}: ${valid ? 'both accept it, with the same values' : 'both refuse it'}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-pypin-'));
      roots.push(dir);
      const file = path.join(dir, 'python-runtime.pin');
      fs.writeFileSync(file, content);
      const js = readPin(file);
      const bash = bashRead(file);
      expect(js.pin !== null, `node reader: ${js.problems.join(' | ')}`).toBe(valid);
      expect(bash.startsWith('ok '), `bash reader: ${bash}`).toBe(valid);
      if (valid) {
        const part = (chip: 'arm64' | 'x64', which: 'uv' | 'python') => (js.pin.chips[chip] ? `${js.pin.chips[chip][which].sha256}:${js.pin.chips[chip][which].bytes}` : ':');
        expect(bash).toBe(`ok uv=${js.pin.uvVersion} py=${js.pin.pythonVersion} build=${js.pin.pythonBuild} eol=${js.pin.pythonEol} uvarm=${part('arm64', 'uv')} uvx64=${part('x64', 'uv')} pyarm=${part('arm64', 'python')} pyx64=${part('x64', 'python')}`);
      }
    });
  }
});
