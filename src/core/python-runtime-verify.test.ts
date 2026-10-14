/**
 * `npm run python-runtime:verify` (scripts/verify-python-runtime.mjs): the pin file's format, CPython's end-of-life
 * date, the online comparison with what GitHub publishes, and the uv ↔ CPython build pairing (design review finding 14).
 * The real pin is checked offline; every online case talks to a server on 127.0.0.1 or to an injected fetch and uv,
 * never to github.com (the test setup closes the default URL), and no real uv or Python runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256, startDistServer, tempDir } from './node-runtime.testutil.js';
import { fakePythonTarball, fakeUvTarball, pyPinText, pythonPath, uvPath } from './python-runtime.testutil.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(packageRoot, 'scripts', 'verify-python-runtime.mjs');
// Dev-only: not in the release allowlist, so a botboy-app checkout has no such file; these tests skip there.
const present = fs.existsSync(script);
type Verifier = typeof import('../../scripts/verify-python-runtime.mjs');
const { checkOnline, distBase, eolStatus, pairedBuilds, parsePin, readPin, validatePin, verifyCommand } = (present ? await import('../../scripts/verify-python-runtime.mjs') : {}) as Verifier;
const temps: string[] = [];
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});
const dir = () => { const d = tempDir('botboy-python-verify-'); temps.push(d); return d; };
const runAsync = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, args, { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(64));
const good = (extra: Parameters<typeof pyPinText>[0] = {}) => pyPinText({
  uv: { arm64: { sha256: A, bytes: 14_000_000 }, x64: { sha256: B, bytes: 18_000_000 } },
  python: { arm64: { sha256: C, bytes: 25_000_000 }, x64: { sha256: D, bytes: 24_000_000 } },
  ...extra,
});
const check = (text: string) => { const parsed = parsePin(text); return parsed.problems.length ? { pin: null, problems: parsed.problems } : validatePin(parsed.values); };
const LISTING = [
  'cpython-3.14.1-macos-aarch64-none    https://releases.astral.sh/github/python-build-standalone/releases/download/20261009/cpython-3.14.1%2B20261009-aarch64-apple-darwin-install_only_stripped.tar.gz',
  'cpython-3.13.16-macos-aarch64-none   https://releases.astral.sh/github/python-build-standalone/releases/download/20261009/cpython-3.13.16%2B20261009-aarch64-apple-darwin-install_only_stripped.tar.gz',
  'cpython-3.13.16+freethreaded-macos-aarch64-none   https://releases.astral.sh/github/python-build-standalone/releases/download/20260101/x.tar.gz',
].join('\n');

describe.runIf(present)('the real python-runtime.pin', () => {
  it('is valid: uv 0.13.0 + CPython 3.13.16 from build 20261009, both chips (owner decision D1)', () => {
    const { pin, problems } = readPin(path.join(packageRoot, 'python-runtime.pin'));
    expect(problems).toEqual([]);
    expect(pin).toMatchObject({ uvVersion: '0.13.0', pythonVersion: '3.13.16', pythonMinor: '3.13', pythonBuild: '20261009', pythonEol: '2029-10-31' });
    expect(Object.keys(pin.chips).sort()).toEqual(['arm64', 'x64']);
    expect(pin.chips.arm64.uv).toEqual({ file: 'uv-aarch64-apple-darwin.tar.gz', sha256: 'a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6', bytes: 14_692_549 });
    expect(pin.chips.arm64.python).toEqual({ file: 'cpython-3.13.16+20261009-aarch64-apple-darwin-install_only_stripped.tar.gz', sha256: '11785155d0f70e634178219c20925d8f20be00a3da4684fc4f5019dd15602ef7', bytes: 25_257_849 });
    expect(pin.chips.x64.uv.file).toBe('uv-x86_64-apple-darwin.tar.gz');
    expect(pin.chips.x64.python.file).toBe('cpython-3.13.16+20261009-x86_64-apple-darwin-install_only_stripped.tar.gz');
  });
  it('holds no absolute path or user name', () => {
    const text = fs.readFileSync(path.join(packageRoot, 'python-runtime.pin'), 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/Library\/|\/private\//);
  });
  it('passes the command offline, and the CLI exits 0 saying nothing was compared', () => {
    const result = spawnSync(process.execPath, [script, '--offline'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('python-runtime.pin: uv 0.13.0 + CPython 3.13.16 (build 20261009, end of life 2029-10-31)');
    expect(result.stdout).toContain('offline');
  });
});

describe.runIf(present)('format', () => {
  it('accepts a complete pin and one chip alone (for both parts)', () => {
    expect(check(good()).problems).toEqual([]);
    expect(Object.keys(check(good({ uv: { arm64: { sha256: A, bytes: 14_000_000 } }, python: { arm64: { sha256: C, bytes: 25_000_000 } } })).pin!.chips)).toEqual(['arm64']);
  });
  it('rejects, naming the key: unknown and duplicate keys, a missing key, bad versions, hashes, sizes, build tags and dates, a chip pinned for one part only', () => {
    const cases: [string, string][] = [
      [`${good()}mystery=1\n`, 'unknown key "mystery"'],
      [`${good()}uv.version=0.13.1\n`, '"uv.version" appears twice'],
      [good().replace('schema=1\n', ''), 'schema is missing'],
      [good().replace('uv.version=0.13.0', 'uv.version=0.13'), 'uv.version is not a full version'],
      [good().replace('python.version=3.13.16', 'python.version=2.7.18'), 'python.version is not a full CPython 3 version'],
      [good().replace('python.build=20261009', 'python.build=2026-10-09'), 'python.build is not a python-build-standalone build tag'],
      [good().replace('python.eol=2099-10-31', 'python.eol=2099-13-45'), 'python.eol 2099-13-45 is not a real date'],
      [good().replace(A, 'A'.repeat(64)), 'uv.darwin-arm64.sha256 is not a lowercase SHA-256'],
      [good().replace('25000000', '12'), 'python.darwin-arm64.bytes 12 is outside'],
      [good().replace('python.darwin-x64.bytes=24000000\n', ''), 'python.darwin-x64.bytes is missing'],
      [good({ uv: { arm64: { sha256: A, bytes: 14_000_000 } } }), 'darwin-x64 is pinned for python only'],
      [pyPinText(), 'no chip is pinned'],
      ['nonsense\n', 'expected key=value'],
      [`${good()}# x\n${'#'.repeat(9000)}\n`, 'larger than 8192 bytes'],
    ];
    for (const [text, expected] of cases) {
      const result = check(text);
      expect(result.problems.join(' | '), expected).toContain(expected);
      expect(result.pin, expected).toBeNull();
    }
  });
  it('reads a CRLF file and ignores comments and blank lines', () => {
    expect(check(good().replace(/\n/g, '\r\n')).problems).toEqual([]);
  });
});

describe.runIf(present)('end of life', () => {
  const pinFor = (eol: string) => validatePin(parsePin(good({ eol })).values).pin!;
  const now = new Date('2026-10-14T00:00:00Z');
  it('is ok far ahead, soon within 120 days, past after the date, and only a warning', async () => {
    expect(eolStatus(pinFor('2029-10-31'), now).status).toBe('ok');
    expect(eolStatus(pinFor('2027-01-20'), now).status).toBe('soon');
    expect(eolStatus(pinFor('2026-10-13'), now).status).toBe('past');
    const file = path.join(dir(), 'python-runtime.pin');
    fs.writeFileSync(file, good({ eol: '2020-10-31' }));
    const errors: string[] = [];
    expect(await verifyCommand({ file, offline: true, log: () => {}, err: (line: unknown) => errors.push(String(line)) })).toBe(0);
    expect(errors.join('\n')).toContain('reached end of life on 2020-10-31');
  });
});

describe.runIf(present)('the uv ↔ CPython pairing', () => {
  it('reads the build tag uv names for the pinned version, and ignores other versions and variants', () => {
    expect(pairedBuilds(LISTING, '3.13.16')).toEqual({ builds: ['20261009'], seen: 1 });
    expect(pairedBuilds(LISTING, '3.12.9')).toEqual({ builds: [], seen: 0 });
  });
});

describe.runIf(present)('online comparison (injected fetch and uv)', () => {
  const pin = () => validatePin(parsePin(good()).values).pin!;
  const sums = (arm = C) => [`${arm}  cpython-3.13.16+20261009-aarch64-apple-darwin-install_only_stripped.tar.gz`, `${D}  cpython-3.13.16+20261009-x86_64-apple-darwin-install_only_stripped.tar.gz`, `${'e'.repeat(64)}  cpython-3.13.16+20261009-x86_64-unknown-linux-gnu-install_only.tar.gz`].join('\n');
  type Hit = { status?: number; text?: string; length?: number; body?: Buffer };
  const fakeFetch = (table: Record<string, Hit | 'down'>) => (async (url: string, init?: { method?: string }) => {
    const hit = table[`${init?.method ?? 'GET'} ${new URL(url).pathname}`];
    if (hit === 'down' || hit === undefined) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return {
      ok: (hit.status ?? 200) < 400,
      status: hit.status ?? 200,
      headers: new Headers(hit.length !== undefined ? { 'content-length': String(hit.length) } : {}),
      text: async () => hit.text ?? '',
      arrayBuffer: async () => (hit.body ?? Buffer.alloc(0)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  /** A uv tarball whose bytes have hash A in the pin (rewritten per test). */
  const uvTarball = () => fakeUvTarball(dir(), { version: '0.13.0', chip: 'arm64', pythonSha256: C, pythonVersion: '3.13.16', pythonBuild: '20261009', callLog: '/dev/null' });
  const agreeing = (uvSha = A, tarball?: Buffer) => ({
    [`GET ${uvPath('0.13.0', 'arm64')}.sha256`]: { text: `${uvSha}  uv-aarch64-apple-darwin.tar.gz\n` },
    [`GET ${uvPath('0.13.0', 'x64')}.sha256`]: { text: `${B}  uv-x86_64-apple-darwin.tar.gz\n` },
    [`HEAD ${uvPath('0.13.0', 'arm64')}`]: { length: 14_000_000 },
    [`HEAD ${uvPath('0.13.0', 'x64')}`]: { length: 18_000_000 },
    ['GET /astral-sh/python-build-standalone/releases/download/20261009/SHA256SUMS']: { text: sums() },
    [`HEAD ${pythonPath('3.13.16', '20261009', 'arm64')}`]: { length: 25_000_000 },
    [`HEAD ${pythonPath('3.13.16', '20261009', 'x64')}`]: { length: 24_000_000 },
    ...(tarball ? { [`GET ${uvPath('0.13.0', 'arm64')}`]: { body: tarball } } : {}),
  });
  const withUv = (text: string) => {
    const t = uvTarball();
    const p = validatePin(parsePin(good({ uv: { arm64: { sha256: t.sha256, bytes: 14_000_000 }, x64: { sha256: B, bytes: 18_000_000 } } })).values).pin!;
    return { pin: p, table: agreeing(t.sha256, t.body), runUv: () => text };
  };

  it('passes when every hash and size agrees and the pinned uv installs exactly the pinned build', async () => {
    const { pin: p, table, runUv } = withUv(LISTING);
    expect(await checkOnline(p, { base: 'https://x.test', fetchImpl: fakeFetch(table), chip: 'arm64', runUv })).toEqual({ failures: [], warnings: [], checked: true });
  });
  it('fails on a uv hash or a CPython hash that differs, naming the file and both values', async () => {
    const uvWrong = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ ...agreeing('f'.repeat(64)) }), chip: 'arm64', runUv: () => LISTING });
    expect(uvWrong.failures[0]).toBe(`uv-aarch64-apple-darwin.tar.gz: pinned sha256 ${A.slice(0, 12)}… but GitHub publishes ${'f'.repeat(12)}…`);
    const pyWrong = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ ...agreeing(), 'GET /astral-sh/python-build-standalone/releases/download/20261009/SHA256SUMS': { text: sums('9'.repeat(64)) } }), chip: 'arm64', runUv: () => LISTING });
    expect(pyWrong.failures).toContain(`cpython-3.13.16+20261009-aarch64-apple-darwin-install_only_stripped.tar.gz: pinned sha256 ${C.slice(0, 12)}… but GitHub publishes ${'9'.repeat(12)}…`);
  });
  it('fails on a size that differs and on a build that is not published', async () => {
    const sized = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ ...agreeing(), [`HEAD ${pythonPath('3.13.16', '20261009', 'x64')}`]: { length: 24_000_001 } }), chip: 'arm64', runUv: () => LISTING });
    expect(sized.failures).toContain('cpython-3.13.16+20261009-x86_64-apple-darwin-install_only_stripped.tar.gz: pinned 24000000 bytes but GitHub serves 24000001');
    const gone = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ ...agreeing(), 'GET /astral-sh/python-build-standalone/releases/download/20261009/SHA256SUMS': { status: 404 } }), chip: 'arm64', runUv: () => LISTING });
    expect(gone.failures.join('\n')).toContain('answered HTTP 404: build 20261009 is not published there');
  });
  it('fails when the pinned uv names another build for the pinned CPython (the pair would be refused by uv\'s own hash check)', async () => {
    const { pin: p, table, runUv } = withUv(LISTING.replace(/20261009/g, '20261013'));
    const result = await checkOnline(p, { base: 'https://x.test', fetchImpl: fakeFetch(table), chip: 'arm64', runUv });
    expect(result.failures).toEqual(['uv 0.13.0 downloads CPython 3.13.16 from build 20261013, not the pinned python.build 20261009: BotBoy\'s install would be refused by uv\'s own hash check']);
    const none = withUv('cpython-3.12.9-macos-aarch64-none https://x/download/20261009/y');
    expect((await checkOnline(none.pin, { base: 'https://x.test', fetchImpl: fakeFetch(none.table), chip: 'arm64', runUv: none.runUv })).failures[0]).toContain('offers no cpython-3.13.16-macos-* download');
  });
  it('never unpacks or runs a uv whose download does not match the pin', async () => {
    const t = uvTarball();
    let ran = false;
    const result = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch(agreeing(A, t.body)), chip: 'arm64', runUv: () => { ran = true; return LISTING; } });
    expect(result.failures[0]).toMatch(/the downloaded file's sha256 is .* not the pinned .* \(not unpacked or run\)/);
    expect(ran).toBe(false);
  });
  it('only warns when the network cannot be reached', async () => {
    const none = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({}), chip: 'arm64', runUv: () => LISTING });
    expect(none).toMatchObject({ failures: [], checked: false });
    expect(none.warnings[0]).toContain('could not reach x.test (ECONNREFUSED); the pinned hashes were NOT compared');
  });
  it('uses the test URL only when it is https or loopback', () => {
    expect(distBase({})).toBe('https://github.com');
    expect(distBase({ BOTBOY_TEST_PYTHON_DIST_URL: 'http://127.0.0.1:4000/' })).toBe('http://127.0.0.1:4000');
    expect(distBase({ BOTBOY_TEST_PYTHON_DIST_URL: 'http://evil.example' })).toBe('https://github.com');
    expect(distBase({ BOTBOY_TEST_PYTHON_DIST_URL: 'http://127.0.0.1.evil.example/x' })).toBe('https://github.com');
  });
});

describe.runIf(present)('the command, end to end against a local server', () => {
  // The command downloads the uv of THIS Mac's chip; the fake below is the arm64 one.
  const arm64Host = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).stdout.trim() === '1';
  it.runIf(arm64Host)('an agreeing pin passes (the fake uv lists the pinned build); a wrong hash fails with exit 1 and the fix', async () => {
    const d = dir();
    const py = fakePythonTarball(d, { version: '3.13.16', build: '20261009', chip: 'arm64', padBytes: 1_100_000 });
    const pyX = fakePythonTarball(d, { version: '3.13.16', build: '20261009', chip: 'x64', padBytes: 1_100_000 });
    const listingScript = (uvFile: string) => {
      // The fake uv answers `python list` with a listing that names build 20261009.
      const text = fs.readFileSync(uvFile, 'utf8').replace('case "$1" in', `case "$1" in\n  python) [ "$2" = list ] && { echo 'cpython-3.13.16-macos-aarch64-none  https://releases.astral.sh/github/python-build-standalone/releases/download/20261009/f.tar.gz'; exit 0; } ;;`);
      fs.writeFileSync(uvFile, text);
    };
    // Build the uv tarball by hand so its uv answers `python list`.
    const uvTree = path.join(d, 'uvtree');
    const t = fakeUvTarball(d, { version: '0.13.0', chip: 'arm64', pythonSha256: py.sha256, pythonVersion: '3.13.16', pythonBuild: '20261009', callLog: '/dev/null', padBytes: 1_100_000 });
    fs.mkdirSync(uvTree);
    spawnSync('/usr/bin/tar', ['-xzf', t.file, '-C', uvTree]);
    listingScript(path.join(uvTree, 'uv-aarch64-apple-darwin', 'uv'));
    const repacked = path.join(d, 'repacked.tar.gz');
    spawnSync('/usr/bin/tar', ['-czf', repacked, '-C', uvTree, 'uv-aarch64-apple-darwin']);
    const uvBody = fs.readFileSync(repacked);
    const uvSha = sha256(uvBody);
    const server = await startDistServer({
      [`${uvPath('0.13.0', 'arm64')}.sha256`]: { body: Buffer.from(`${uvSha}  uv-aarch64-apple-darwin.tar.gz\n`) },
      [`${uvPath('0.13.0', 'x64')}.sha256`]: { body: Buffer.from(`${B}  uv-x86_64-apple-darwin.tar.gz\n`) },
      [uvPath('0.13.0', 'arm64')]: { body: uvBody },
      [uvPath('0.13.0', 'x64')]: { body: Buffer.alloc(10), headLength: 18_000_000 },
      ['/astral-sh/python-build-standalone/releases/download/20261009/SHA256SUMS']: { body: Buffer.from(`${py.sha256}  ${py.name}\n${pyX.sha256}  ${pyX.name}\n`) },
      [pythonPath('3.13.16', '20261009', 'arm64')]: { body: py.body },
      [pythonPath('3.13.16', '20261009', 'x64')]: { body: pyX.body },
    });
    servers.push(server);
    const pinFile = path.join(d, 'python-runtime.pin');
    const write = (uvArm: string) => fs.writeFileSync(pinFile, pyPinText({
      uv: { arm64: { sha256: uvArm, bytes: uvBody.length }, x64: { sha256: B, bytes: 18_000_000 } },
      python: { arm64: { sha256: py.sha256, bytes: py.bytes }, x64: { sha256: pyX.sha256, bytes: pyX.bytes } },
    }));
    write(uvSha);
    const env = { ...process.env, BOTBOY_TEST_PYTHON_DIST_URL: server.url };
    const ok = await runAsync([script, '--pin', pinFile], env);
    expect(ok.status, `${ok.stdout}\n${ok.stderr}`).toBe(0);
    expect(ok.stdout).toContain('✓ every pinned hash and size equals what GitHub publishes, and the pinned uv installs exactly this CPython build');
    write(A);
    const bad = await runAsync([script, '--pin', pinFile], env);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('The pin disagrees with GitHub');
    expect(bad.stderr).toContain('Fix: take the values from the uv 0.13.0 release (.sha256 files) and the SHA256SUMS of python-build-standalone 20261009');
  });
  it('with the default (closed) test URL it warns and passes: the release pre-flight stays offline in tests', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('could not reach 127.0.0.1');
    expect(result.stderr).toContain('were NOT compared');
  });
  it('rejects an unknown flag with usage (exit 2) and an invalid file with exit 1', () => {
    expect(spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' }).status).toBe(2);
    const file = path.join(dir(), 'bad.pin');
    fs.writeFileSync(file, 'schema=1\n');
    const result = spawnSync(process.execPath, [script, '--offline', '--pin', file], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('python-runtime.pin is not valid');
    expect(result.stderr).toContain('uv.version is missing');
  });
});
