/**
 * `npm run node-runtime:verify` (scripts/verify-node-runtime.mjs): the pin file's format, its end-of-life date, and
 * the online comparison with what nodejs.org publishes. The real pin is checked offline; every online case talks to a
 * server on 127.0.0.1 or to an injected fetch, never to nodejs.org (the test setup closes the default URL).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeNodeTarball, pinText, shasums, startDistServer, tempDir } from './node-runtime.testutil.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(packageRoot, 'scripts', 'verify-node-runtime.mjs');
// Dev-only: scripts/verify-node-runtime.mjs is not in the release allowlist, so a botboy-app checkout has no such file
// (design amendment 14(d)): these tests skip there instead of failing to load.
const present = fs.existsSync(script);
type Verifier = typeof import('../../scripts/verify-node-runtime.mjs');
const { checkOnline, distBase, eolStatus, parsePin, readPin, validatePin, verifyCommand } = (present ? await import('../../scripts/verify-node-runtime.mjs') : {}) as Verifier;
const temps: string[] = [];
const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});
const dir = () => { const d = tempDir(); temps.push(d); return d; };
/** Async on purpose: the test serves the download in this same process, which a blocking spawn would starve. */
const runAsync = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, args, { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const good = (extra: Partial<Parameters<typeof pinText>[0]> = {}) => pinText({ version: '22.1.2', arm64: { sha256: HASH_A, bytes: 50_000_000 }, x64: { sha256: HASH_B, bytes: 51_000_000 }, ...extra });
const check = (text: string) => { const parsed = parsePin(text); return parsed.problems.length ? { pin: null, problems: parsed.problems } : validatePin(parsed.values); };

describe.runIf(present)('the real node-runtime.pin', () => {
  it('is valid, pins one exact Node 24 version, and both chips', () => {
    const { pin, problems } = readPin(path.join(packageRoot, 'node-runtime.pin'));
    expect(problems).toEqual([]);
    expect(pin).toMatchObject({ version: '24.21.0', line: 24, minMacos: '13.5' });
    expect(Object.keys(pin.chips).sort()).toEqual(['arm64', 'x64']);
    expect(pin.chips.arm64.file).toBe('node-v24.21.0-darwin-arm64.tar.gz');
    expect(pin.chips.x64.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('holds no absolute path, user name or URL (nothing in it can drift from the machine)', () => {
    const text = fs.readFileSync(path.join(packageRoot, 'node-runtime.pin'), 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/Library\/|https?:\/\/[^\s]*[^\s/]\.(pkg|dmg)/);
  });
  it('passes the command offline, and the CLI exits 0 saying nothing was compared', () => {
    const result = spawnSync(process.execPath, [script, '--offline'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('node-runtime.pin: Node 24.21.0 (line 24');
    expect(result.stdout).toContain('offline');
  });
});

describe.runIf(present)('format', () => {
  it('accepts a complete pin and one chip alone', () => {
    expect(check(good()).problems).toEqual([]);
    expect(check(good({ x64: null })).problems).toEqual([]);
    expect(Object.keys(check(good({ arm64: null })).pin!.chips)).toEqual(['x64']);
  });
  it('rejects, naming the key: unknown and duplicate keys, a missing key, bad hashes and sizes, a line that is not the major, a false date', () => {
    const cases: [string, string][] = [
      [`${good()}mystery=1\n`, 'unknown key "mystery"'],
      [`${good()}version=22.1.3\n`, '"version" appears twice'],
      [good().replace('schema=1\n', ''), 'schema is missing'],
      [good().replace('schema=1', 'schema=2'), 'schema is not schema 1'],
      [good().replace(/version=22\.1\.2/, 'version=22.1'), 'version is not a full version'],
      [good().replace('line=22', 'line=24'), 'line 24 is not the major of version 22.1.2'],
      [good().replace('eol=2099-04-30', 'eol=2099-02-31x'), 'eol is not a date'],
      [good().replace('eol=2099-04-30', 'eol=2099-13-45'), 'eol 2099-13-45 is not a real date'],
      [good().replace(HASH_A, 'A'.repeat(64)), 'darwin-arm64.sha256 is not a lowercase SHA-256'],
      [good().replace(HASH_A, 'a'.repeat(63)), 'darwin-arm64.sha256 is not a lowercase SHA-256'],
      [good().replace('50000000', '12'), 'darwin-arm64.bytes 12 is outside'],
      [good().replace('50000000', 'many'), 'darwin-arm64.bytes is not a size in bytes'],
      [good().replace('min_macos=11.0', 'min_macos=eleven'), 'min_macos is not a macOS version'],
      [pinText({ version: '22.1.2' }), 'no chip is pinned'],
      [good().replace('darwin-x64.bytes=51000000\n', ''), 'darwin-x64.bytes is missing'],
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
  it('reports a file that does not exist', () => {
    expect(readPin(path.join(dir(), 'missing.pin')).problems[0]).toContain('cannot be read');
  });
});

describe.runIf(present)('end of life', () => {
  const pinFor = (eol: string) => validatePin(parsePin(good({ eol })).values).pin!;
  const now = new Date('2026-10-14T00:00:00Z');
  it('is ok far ahead, soon within 120 days, past after the date', () => {
    expect(eolStatus(pinFor('2027-04-30'), now)).toMatchObject({ status: 'ok' });
    expect(eolStatus(pinFor('2027-01-20'), now).status).toBe('soon');
    expect(eolStatus(pinFor('2026-10-13'), now)).toMatchObject({ status: 'past' });
  });
  it('is a warning only: the command still exits 0', async () => {
    const d = dir();
    const file = path.join(d, 'node-runtime.pin');
    fs.writeFileSync(file, good({ eol: '2020-04-30' }));
    const errors: string[] = [];
    expect(await verifyCommand({ file, offline: true, log: () => {}, err: (line) => errors.push(String(line)) })).toBe(0);
    expect(errors.join('\n')).toContain('reached end of life on 2020-04-30');
  });
});

describe.runIf(present)('online comparison', () => {
  const pin = () => validatePin(parsePin(good()).values).pin!;
  const sums = (a = HASH_A, b = HASH_B) => shasums([{ name: 'node-v22.1.2-darwin-arm64.tar.gz', sha256: a }, { name: 'node-v22.1.2-darwin-x64.tar.gz', sha256: b }, { name: 'node-v22.1.2-linux-x64.tar.gz', sha256: 'c'.repeat(64) }]);
  // A HEAD needs only a Content-Length header, which an injected fetch provides directly.
  const fakeFetch = (table: Record<string, { status?: number; text?: string; length?: number } | 'down'>) => (async (url: string, init?: { method?: string }) => {
    const hit = table[`${init?.method ?? 'GET'} ${new URL(url).pathname}`];
    if (hit === 'down' || hit === undefined) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return {
      ok: (hit.status ?? 200) < 400,
      status: hit.status ?? 200,
      headers: new Headers(hit.length !== undefined ? { 'content-length': String(hit.length) } : {}),
      text: async () => hit.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const agreeing = () => ({
    'GET /v22.1.2/SHASUMS256.txt': { text: sums().toString() },
    'HEAD /v22.1.2/node-v22.1.2-darwin-arm64.tar.gz': { length: 50_000_000 },
    'HEAD /v22.1.2/node-v22.1.2-darwin-x64.tar.gz': { length: 51_000_000 },
  });
  it('passes when both hashes and sizes agree', async () => {
    expect(await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch(agreeing()) })).toEqual({ failures: [], warnings: [], checked: true });
  });
  it('fails on a different hash, naming the file and both values', async () => {
    const table = { ...agreeing(), 'GET /v22.1.2/SHASUMS256.txt': { text: sums('d'.repeat(64)).toString() } };
    const result = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch(table) });
    expect(result.failures).toEqual([`node-v22.1.2-darwin-arm64.tar.gz: pinned sha256 ${HASH_A.slice(0, 12)}… but nodejs.org publishes ${'d'.repeat(12)}…`]);
  });
  it('fails on a different size and on a file missing from the list', async () => {
    const sized = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ ...agreeing(), 'HEAD /v22.1.2/node-v22.1.2-darwin-x64.tar.gz': { length: 51_000_001 } }) });
    expect(sized.failures).toEqual(['node-v22.1.2-darwin-x64.tar.gz: pinned 51000000 bytes but nodejs.org serves 51000001']);
    const missing = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ ...agreeing(), 'GET /v22.1.2/SHASUMS256.txt': { text: `${'c'.repeat(64)}  node-v22.1.2-linux-x64.tar.gz\n` } }) });
    expect(missing.failures.join('\n')).toContain('node-v22.1.2-darwin-arm64.tar.gz is not in nodejs.org');
  });
  it('fails on an unpublished version (HTTP 404), because that is an answer', async () => {
    const result = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ 'GET /v22.1.2/SHASUMS256.txt': { status: 404 } }) });
    expect(result.failures[0]).toContain('answered HTTP 404');
  });
  it('only warns when the network cannot be reached, at either request', async () => {
    const none = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({}) });
    expect(none.failures).toEqual([]);
    expect(none.checked).toBe(false);
    expect(none.warnings[0]).toContain('could not reach x.test (ECONNREFUSED); the pinned hashes were NOT compared');
    const half = await checkOnline(pin(), { base: 'https://x.test', fetchImpl: fakeFetch({ 'GET /v22.1.2/SHASUMS256.txt': { text: sums().toString() } }) });
    expect(half.failures).toEqual([]);
    expect(half.warnings).toHaveLength(1);
  });
  it('uses the test URL only when it is https or loopback, and trims the slash', () => {
    expect(distBase({})).toBe('https://nodejs.org/dist');
    expect(distBase({ BOTBOY_TEST_NODE_DIST_URL: 'http://127.0.0.1:4000/' })).toBe('http://127.0.0.1:4000');
    expect(distBase({ BOTBOY_TEST_NODE_DIST_URL: 'https://mirror.example/dist' })).toBe('https://mirror.example/dist');
    expect(distBase({ BOTBOY_TEST_NODE_DIST_URL: 'http://evil.example/dist' })).toBe('https://nodejs.org/dist');
    expect(distBase({ BOTBOY_TEST_NODE_DIST_URL: 'http://127.0.0.1.evil.example/dist' })).toBe('https://nodejs.org/dist');
  });

  it('end to end against a local server: agreeing pin passes, a wrong hash fails with exit 1 and a fix', async () => {
    const d = dir();
    const arm = fakeNodeTarball(d, { version: '22.1.2', arch: 'arm64', padBytes: 1_100_000 });
    const x64 = fakeNodeTarball(d, { version: '22.1.2', arch: 'x64', padBytes: 1_100_000 });
    const server = await startDistServer({
      '/v22.1.2/SHASUMS256.txt': { body: shasums([{ name: arm.name, sha256: arm.sha256 }, { name: x64.name, sha256: x64.sha256 }]) },
      [`/v22.1.2/${arm.name}`]: { body: arm.body },
      [`/v22.1.2/${x64.name}`]: { body: x64.body },
    });
    servers.push(server);
    const pinFile = path.join(d, 'node-runtime.pin');
    fs.writeFileSync(pinFile, pinText({ version: '22.1.2', arm64: { sha256: arm.sha256, bytes: arm.bytes }, x64: { sha256: x64.sha256, bytes: x64.bytes } }));
    const env = { ...process.env, BOTBOY_TEST_NODE_DIST_URL: server.url };
    const ok = await runAsync([script, '--pin', pinFile], env);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('✓ both pinned hashes and sizes equal what nodejs.org publishes');
    expect(server.requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET /v22.1.2/SHASUMS256.txt`, `HEAD /v22.1.2/${arm.name}`, `HEAD /v22.1.2/${x64.name}`,
    ].sort());
    fs.writeFileSync(pinFile, pinText({ version: '22.1.2', arm64: { sha256: HASH_A, bytes: arm.bytes }, x64: { sha256: x64.sha256, bytes: x64.bytes } }));
    const bad = await runAsync([script, '--pin', pinFile], env);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('The pin disagrees with nodejs.org');
    expect(bad.stderr).toContain(`Fix: take the values from https://nodejs.org/dist/v22.1.2/SHASUMS256.txt`);
  });
  it('with the default (closed) test URL it warns and passes: the release pre-flight stays offline in tests', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('could not reach 127.0.0.1');
    expect(result.stderr).toContain('were NOT compared');
  });
  it('rejects an unknown flag with usage (exit 2) and an invalid file with exit 1', () => {
    expect(spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' }).status).toBe(2);
    const d = dir();
    const file = path.join(d, 'bad.pin');
    fs.writeFileSync(file, 'schema=1\n');
    const result = spawnSync(process.execPath, [script, '--offline', '--pin', file], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node-runtime.pin is not valid');
    expect(result.stderr).toContain('version is missing');
  });
});
