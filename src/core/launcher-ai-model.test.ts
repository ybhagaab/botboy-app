/**
 * start.sh and the owner's own AI model keys, Claude included (Claude slice C, design v3 D12 "Slice C", brief item 2;
 * the probe's transport from the post-merge polish, Claude review LOW C1-1):
 *
 * - `warn_if_no_llm_credentials` stays quiet for any `"apiKey"` in ai-model.json (a Claude-only file included) and
 *   otherwise asks for "an OpenAI, DeepSeek or Anthropic (Claude) API key".
 * - `doctor_ai_model_rows` (the doctor's `ai-model:` rows) reads `keys.anthropic`: the key SUFFIX only, the role choices
 *   and `anthropic probe: HTTP 200`; a Claude-only file is no longer "unreadable". The probe is
 *   `GET https://api.anthropic.com/v1/models?limit=1` through Node's fetch, like the app and the OpenAI and DeepSeek
 *   probes (curl followed proxy variables the app does not read), with the app's `x-api-key` and `anthropic-version`
 *   headers and no redirect followed. The key is read inside Node: never an argument, never in the process list, and
 *   nothing but the HTTP status is ever printed.
 *
 * Nothing here reaches the network. The Claude probe goes to a stand-in on 127.0.0.1 named by
 * BOTBOY_TEST_ANTHROPIC_PROBE_URL (the only value start.sh accepts is http://127.0.0.1:<port>). Node's `fetch` is
 * wrapped by a preload that lets loopback requests through and answers every other address itself with a canned
 * status, so the OpenAI and DeepSeek probes, and a Claude probe that lost its override, never leave the Mac. A
 * recording `curl` is first on PATH as a tripwire. HOME is private. Key literals are assembled at runtime from parts.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const launcher = fs.readFileSync(launcherPath, 'utf8');
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const tail = (key: string) => `…${key.slice(-4)}`;
const claudeKey = (tag = 'planted') => ['sk', 'ant', 'api03', `${tag}${'0123456789'.repeat(3)}`].join('-');
const adminKey = () => ['sk', 'ant', 'admin01', `admin${'0123456789'.repeat(3)}`].join('-');
const openAiKey = () => ['sk', 'proj', `openai${'abcdefghij'.repeat(3)}`].join('-');
const deepSeekKey = () => ['sk', 'f'.repeat(32)].join('-');
const entry = (apiKey: string) => ({ apiKey, savedAt: '2026-10-14T00:00:00.000Z', verifiedAt: '2026-10-14T00:00:00.000Z', models: [] });
const fileWith = (keys: Record<string, string>, roles: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  keys: Object.fromEntries(Object.entries(keys).map(([provider, key]) => [provider, entry(key)])),
  roles,
});

// A tripwire: the AI model rows run no curl at all.
const CURL_STUB = [
  '#!/bin/sh',
  'dir="$(dirname "$0")"',
  'mkdir -p "$dir/calls"',
  'printf "%s\\0" "$@" > "$dir/calls/$$.argv"',
  'exit 7',
  '',
].join('\n');

const FETCH_STUB = [
  "const fs = require('fs');",
  'const realFetch = globalThis.fetch;',
  'globalThis.fetch = async (url, init) => {',
  '  // Only the loopback stand-in is ever really fetched.',
  "  if (/^http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\//.test(String(url))) return realFetch(url, init);",
  '  const headers = (init && init.headers) || {};',
  "  fs.appendFileSync(process.env.STUB_FETCH_LOG, JSON.stringify({ url: String(url), bearer: Boolean(headers.Authorization), apiKeyHeader: Boolean(headers['x-api-key']) }) + '\\n');",
  "  if (process.env.STUB_FETCH_STATUS === 'offline') throw new Error('offline');",
  '  return { status: Number(process.env.STUB_FETCH_STATUS || 401) };',
  '};',
  '',
].join('\n');

/** The probes use Node's fetch; refuse to run a doctor unless the preload really wraps it. */
let fetchStubChecked = false;
function assertFetchStubActive(env: Record<string, string>) {
  if (fetchStubChecked) return;
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(globalThis.fetch.toString().includes("STUB_FETCH_LOG")))'], { env, encoding: 'utf8' });
  if (probe.stdout !== 'true') throw new Error('the fetch preload is not active: refusing to run a doctor that could reach a real host');
  fetchStubChecked = true;
}

interface ProbeRequest { method: string; url: string; headers: http.IncomingHttpHeaders; processList: string }
type Reply =
  | { kind: 'status'; status: number; body?: string; headers?: Record<string, string> }
  | { kind: 'redirect'; location: string }
  | { kind: 'reset' }
  | { kind: 'endless' };

/** The Anthropic API as the doctor sees it: a stand-in on 127.0.0.1, ephemeral port, that records every request. */
async function standIn(initial: Reply = { kind: 'status', status: 200, body: '{"data":[]}' }) {
  const requests: ProbeRequest[] = [];
  let reply = initial;
  const server = http.createServer((req, res) => {
    // What every process on this Mac shows while the probe is in flight: the key must be in none of them.
    const processList = execFileSync('/bin/ps', ['-A', '-ww', '-o', 'command='], { encoding: 'utf8' });
    requests.push({ method: String(req.method), url: String(req.url), headers: req.headers, processList });
    if (reply.kind === 'reset') { req.socket.destroy(); return; }
    if (reply.kind === 'redirect') { res.writeHead(307, { Location: reply.location }); res.end(); return; }
    if (reply.kind === 'endless') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = 'x'.repeat(256 * 1024);
      const pump = () => { while (res.write(chunk)); };
      res.on('drain', pump);
      pump();
      return;
    }
    res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
    res.end(reply.body ?? '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  closers.push(close);
  return { origin: `http://127.0.0.1:${port}`, port, requests, answer: (next: Reply) => { reply = next; }, close };
}

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-ai-model-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const home = path.join(root, 'home');
  const state = path.join(home, '.personal-productivity-tracker');
  for (const d of [dir, stubs, state]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, body, { mode: 0o755 });
    return file;
  };
  // start.sh puts the folder of $NODE first on PATH, so a bare `curl` would reach this recording stub, never the network.
  stub('curl', CURL_STUB);
  const lsof = stub('lsof', '#!/bin/sh\nexit 0\n');
  const node = stub('node', `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  const npm = stub('npm', '#!/bin/sh\nexit 1\n');
  const preload = path.join(stubs, 'fetch-stub.cjs');
  fs.writeFileSync(preload, FETCH_STUB);
  const fetchLog = path.join(root, 'fetch.log');
  const settingsFile = path.join(state, 'ai-model.json');
  const writeSettings = (value: unknown, mode = 0o600) => {
    fs.writeFileSync(settingsFile, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    fs.chmodSync(settingsFile, mode);
  };
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM', 'BOTBOY_TEST_ANTHROPIC_PROBE_URL']) delete base[key];
    return {
      ...base,
      HOME: home,
      PPT_LOG_FILE: path.join(root, 'launcher.log'),
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_HW_ARM64: '0',
      BOTBOY_TEST_LSOF_BIN: lsof,
      BOTBOY_TEST_NODE_BIN: node,
      BOTBOY_TEST_NPM_BIN: npm,
      // Fail-safe: a launcher whose test hook stopped firing would run the real start flow; it must not open a browser.
      BOTBOY_TEST_CHROME_BIN: '/usr/bin/true',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${preload}`].filter(Boolean).join(' '),
      STUB_FETCH_LOG: fetchLog,
      // A developer Mac may carry real credentials; none of them may decide what the warning says.
      AWS_BEARER_TOKEN_BEDROCK: '',
      BOTBOY_INFERENCE_API_KEY: '',
      BOTBOY_INFERENCE_OAUTH_CLIENT_ID: '',
      BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET: '',
      ...extra,
    } as Record<string, string>;
  };
  /** Runs start.sh with one test hook. Asynchronous, so the stand-in in this process can answer the probe. */
  const run = (hook: string, extra: Record<string, string> = {}) => {
    const full = env({ [hook]: '1', ...extra });
    assertFetchStubActive(full);
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // Its own process group, so a doctor that hangs is killed with its node child.
      const child = spawn('/bin/bash', [path.join(dir, 'start.sh')], { cwd: dir, env: full, detached: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        reject(new Error(`start.sh did not finish\n${stdout}\n${stderr}`));
      }, 30_000);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
  };
  const curlCalls = () => {
    const folder = path.join(stubs, 'calls');
    return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  };
  const fetched = () => (fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { url: string; bearer: boolean; apiKeyHeader: boolean }) : []);
  return { dir, home, writeSettings, settingsFile, run, curlCalls, fetched };
}

const doctor = (b: ReturnType<typeof box>, extra: Record<string, string> = {}) => b.run('BOTBOY_TEST_DOCTOR_AI_MODEL', extra);
/** The doctor with its Claude probe pointed at `api`. */
const doctorAt = (b: ReturnType<typeof box>, api: { origin: string }, extra: Record<string, string> = {}) =>
  doctor(b, { BOTBOY_TEST_ANTHROPIC_PROBE_URL: api.origin, ...extra });
const lines = (text: string) => text.split('\n').filter(Boolean);
const NETWORK_HINT = 'anthropic probe: HTTP 000 (network, proxy, or VPN blocks api.anthropic.com)';

describe('start.sh › warn_if_no_llm_credentials', () => {
  const second = '    In BotBoy, open Settings → AI model and paste an OpenAI, DeepSeek or Anthropic (Claude) API key (it takes effect right away).';
  const third = '    Or, if the owner sent you a botboy-credentials file, put it in ~/Downloads and re-run ./start.sh.';

  it('asks for any of the three keys when nothing is set up', async () => {
    const result = await box().run('BOTBOY_TEST_LLM_WARNING');
    expect(result.status).toBe(0);
    const out = lines(result.stdout);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('No AI model set up yet — chat and background organizing stay off until you add one.');
    expect(out[1]).toBe(second);
    expect(out[2]).toBe(third);
    expect(result.stdout).not.toContain('OpenAI or DeepSeek');
  });

  it('stays quiet for a file that holds a key of any provider, a Claude-only file included', async () => {
    const withKeys: Record<string, string>[] = [{ anthropic: claudeKey() }, { openai: openAiKey() }, { deepseek: deepSeekKey() }, { anthropic: claudeKey(), openai: openAiKey() }];
    for (const keys of withKeys) {
      const b = box();
      b.writeSettings(fileWith(keys));
      const result = await b.run('BOTBOY_TEST_LLM_WARNING');
      expect(result.status, JSON.stringify(Object.keys(keys))).toBe(0);
      expect(result.stdout, JSON.stringify(Object.keys(keys))).toBe('');
    }
  });

  it('still warns when the file holds only model choices, or nothing readable', async () => {
    for (const content of [fileWith({}, { processing: { modelKey: 'anthropic.claude-haiku-5-5' } }), '{}', 'not json']) {
      const b = box();
      b.writeSettings(content);
      const result = await b.run('BOTBOY_TEST_LLM_WARNING');
      expect(lines(result.stdout)[1], String(JSON.stringify(content)).slice(0, 40)).toBe(second);
    }
  });

  it('stays quiet with a Bedrock token, an inference API key, or the complete OAuth pair (and a lone OAuth id does not count)', async () => {
    const credentialEnvs: Record<string, string>[] = [
      { AWS_BEARER_TOKEN_BEDROCK: 'x' },
      { BOTBOY_INFERENCE_API_KEY: 'x' },
      { BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'id', BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET: 'secret' },
    ];
    for (const env of credentialEnvs) {
      expect((await box().run('BOTBOY_TEST_LLM_WARNING', env)).stdout, JSON.stringify(Object.keys(env))).toBe('');
    }
    expect(lines((await box().run('BOTBOY_TEST_LLM_WARNING', { BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'id' })).stdout)).toHaveLength(3);
  });

  it('start.sh names no provider list without Claude anywhere', () => {
    expect(launcher).not.toContain('OpenAI or DeepSeek');
    expect(launcher).toContain('OpenAI, DeepSeek or Anthropic (Claude)');
  });
});

describe('start.sh › the doctor ai-model rows', () => {
  it('shows a Claude-only file: the key suffix, the role choices and the probe (never "unreadable")', async () => {
    const b = box();
    const api = await standIn();
    const key = claudeKey();
    b.writeSettings(fileWith({ anthropic: key }));
    const result = await doctorAt(b, api);
    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual([
      `ai-model: Anthropic (Claude) key ${tail(key)} saved in Settings (mode 600)`,
      'ai-model: organizing model automatic; document writing automatic',
      'anthropic probe: HTTP 200 (200=key works, 401=key rejected)',
    ]);
    expect(result.stdout).not.toContain('unreadable');
    expect(result.stderr).toBe('');
  });

  it('prints the stored role choices beside the Claude key', async () => {
    const b = box();
    const api = await standIn();
    b.writeSettings(fileWith({ anthropic: claudeKey() }, { processing: { modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' }, documents: { modelKey: 'anthropic.claude-sonnet-5-5' } }));
    expect(lines((await doctorAt(b, api)).stdout)[1]).toBe('ai-model: organizing model anthropic.claude-haiku-5-5; document writing anthropic.claude-sonnet-5-5');
  });

  it('probes once with `GET /v1/models?limit=1` and the headers the app sends, through fetch: no curl, and the key in no process list', async () => {
    const b = box();
    const api = await standIn();
    const key = claudeKey();
    b.writeSettings(fileWith({ anthropic: key }));
    const result = await doctorAt(b, api);
    expect(api.requests).toHaveLength(1);
    const [probe] = api.requests;
    expect(probe.method).toBe('GET');
    expect(probe.url).toBe('/v1/models?limit=1');
    expect(probe.headers['x-api-key']).toBe(key);
    expect(probe.headers['anthropic-version']).toBe('2023-06-01');
    expect(probe.headers.authorization).toBeUndefined();
    // While the probe was in flight no process on this Mac carried the key in its command line.
    expect(probe.processList).toContain('BOTBOY_TEST_ANTHROPIC_PROBE_URL accepts only');
    expect(probe.processList).not.toContain(key);
    for (const text of [result.stdout, result.stderr]) expect(text).not.toContain(key);
    // The only network path was Node's fetch to the stand-in: no curl ran, and nothing went to another address.
    expect(b.curlCalls()).toEqual([]);
    expect(b.fetched()).toEqual([]);
  });

  it('prints the status the API answers, and `HTTP 000` with the network hint when nothing answers', async () => {
    for (const status of [401, 403, 529]) {
      const b = box();
      const api = await standIn({ kind: 'status', status, body: '{"type":"error"}' });
      b.writeSettings(fileWith({ anthropic: claudeKey() }));
      const result = await doctorAt(b, api);
      expect(result.status, String(status)).toBe(0);
      expect(lines(result.stdout).at(-1), String(status)).toBe(`anthropic probe: HTTP ${status} (200=key works, 401=key rejected)`);
    }
    const reset = box();
    const resetApi = await standIn({ kind: 'reset' });
    reset.writeSettings(fileWith({ anthropic: claudeKey() }));
    expect(lines((await doctorAt(reset, resetApi)).stdout).at(-1)).toBe(NETWORK_HINT);
    expect(resetApi.requests).toHaveLength(1);
    const closed = box();
    const closedApi = await standIn();
    await closedApi.close();
    closed.writeSettings(fileWith({ anthropic: claudeKey() }));
    expect(lines((await doctorAt(closed, closedApi)).stdout).at(-1)).toBe(NETWORK_HINT);
  });

  it('follows no redirect, so the key never reaches another address (the status is printed as it came)', async () => {
    const b = box();
    const elsewhere = await standIn();
    const api = await standIn({ kind: 'redirect', location: `${elsewhere.origin}/v1/models?limit=1` });
    const key = claudeKey();
    b.writeSettings(fileWith({ anthropic: key }));
    const result = await doctorAt(b, api);
    expect(lines(result.stdout).at(-1)).toBe('anthropic probe: HTTP 307 (200=key works, 401=key rejected)');
    expect(api.requests).toHaveLength(1);
    expect(elsewhere.requests).toEqual([]);
  });

  it('is not held up by an answer that never ends (only the status is read)', async () => {
    const b = box();
    const api = await standIn({ kind: 'endless' });
    b.writeSettings(fileWith({ anthropic: claudeKey() }));
    const started = Date.now();
    const result = await doctorAt(b, api);
    expect(lines(result.stdout).at(-1)).toBe('anthropic probe: HTTP 200 (200=key works, 401=key rejected)');
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it('never prints the key, even when the API echoes it back, or the role choice is a pasted key', async () => {
    const b = box();
    const key = claudeKey();
    const api = await standIn({ kind: 'status', status: 401, body: JSON.stringify({ error: { message: `invalid x-api-key ${key}` } }), headers: { 'x-echo': key } });
    b.writeSettings(fileWith({ anthropic: key }, { processing: { modelKey: key }, documents: { modelKey: `anthropic.${key}-and-more` } }));
    const result = await doctorAt(b, api);
    expect(result.status).toBe(0);
    for (const text of [result.stdout, result.stderr]) expect(text).not.toContain(key);
    // The pasted-key choices are masked; the probe line is only the status.
    expect(lines(result.stdout)[1]).toBe('ai-model: organizing model sk-…; document writing anthropic.sk-…');
    expect(lines(result.stdout).at(-1)).toBe('anthropic probe: HTTP 401 (200=key works, 401=key rejected)');
    // The launcher log (written only by some modes) never holds it either.
    const log = path.join(b.dir, '..', 'launcher.log');
    if (fs.existsSync(log)) expect(fs.readFileSync(log, 'utf8')).not.toContain(key);
  });

  it('sends nothing for a key that is not a regular Claude key: an Admin key, a short one, one with a quote or a newline', async () => {
    const api = await standIn();
    for (const bad of [
      adminKey(),
      ['sk', 'ant', 'api03', 'short'].join('-'),
      `${claudeKey()}"\nheader = "x-evil: 1`,
      `${claudeKey()} extra`,
    ]) {
      const b = box();
      b.writeSettings(fileWith({ anthropic: bad }));
      const result = await doctorAt(b, api);
      expect(result.status).toBe(0);
      expect(lines(result.stdout), JSON.stringify(bad).slice(0, 30)).toEqual(['ai-model: Settings file is unreadable (mode 600) — save the key again in Settings → AI model']);
      expect(b.fetched(), JSON.stringify(bad).slice(0, 30)).toEqual([]);
    }
    expect(api.requests).toEqual([]);
  });

  it('takes only http://127.0.0.1:<port> as the test probe address and otherwise sends nothing anywhere', async () => {
    const api = await standIn();
    for (const address of [
      `http://localhost:${api.port}`,
      `https://127.0.0.1:${api.port}`,
      `http://127.0.0.1:${api.port}/`,
      `http://127.0.0.1:${api.port}/elsewhere`,
      `http://127.0.0.1.example.test:${api.port}`,
      `http://[::1]:${api.port}`,
      'http://10.0.0.1:80',
      'https://api.anthropic.com',
      'file:///etc/passwd',
    ]) {
      const b = box();
      b.writeSettings(fileWith({ anthropic: claudeKey() }));
      const result = await doctor(b, { BOTBOY_TEST_ANTHROPIC_PROBE_URL: address });
      expect(result.status, address).toBe(0);
      expect(lines(result.stdout).at(-1), address).toBe('anthropic probe: not sent (BOTBOY_TEST_ANTHROPIC_PROBE_URL accepts only http://127.0.0.1:<port>)');
      expect(b.fetched(), address).toEqual([]);
    }
    expect(api.requests).toEqual([]);
  });

  it('without the test address, probes https://api.anthropic.com (answered here by the fetch preload, never the network)', async () => {
    const b = box();
    b.writeSettings(fileWith({ anthropic: claudeKey() }));
    const result = await doctor(b, { STUB_FETCH_STATUS: '401' });
    expect(lines(result.stdout).at(-1)).toBe('anthropic probe: HTTP 401 (200=key works, 401=key rejected)');
    expect(b.fetched()).toEqual([{ url: 'https://api.anthropic.com/v1/models?limit=1', bearer: false, apiKeyHeader: true }]);
    expect(b.curlCalls()).toEqual([]);
  });

  it('keeps the OpenAI and DeepSeek rows as they were, and lists Claude after them with its own probe', async () => {
    const b = box();
    const api = await standIn();
    const keys = { openai: openAiKey(), deepseek: deepSeekKey(), anthropic: claudeKey() };
    b.writeSettings(fileWith(keys, { documents: { modelKey: 'openai.gpt-5.6-terra' } }));
    const result = await doctorAt(b, api, { STUB_FETCH_STATUS: '401' });
    expect(lines(result.stdout)).toEqual([
      `ai-model: OpenAI key ${tail(keys.openai)} saved in Settings (mode 600)`,
      `ai-model: DeepSeek key ${tail(keys.deepseek)} saved in Settings (mode 600)`,
      `ai-model: Anthropic (Claude) key ${tail(keys.anthropic)} saved in Settings (mode 600)`,
      'ai-model: organizing model automatic; document writing openai.gpt-5.6-terra',
      'openai probe: HTTP 401 (200=key works, 401=key rejected)',
      'deepseek probe: HTTP 401 (200=key works, 401=key rejected)',
      'anthropic probe: HTTP 200 (200=key works, 401=key rejected)',
    ]);
    // OpenAI and DeepSeek still go through fetch with a bearer header; the Claude key goes only to its own probe.
    expect(b.fetched()).toEqual([
      { url: 'https://api.openai.com/v1/models', bearer: true, apiKeyHeader: false },
      { url: 'https://api.deepseek.com/models', bearer: true, apiKeyHeader: false },
    ]);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].headers['x-api-key']).toBe(keys.anthropic);
    for (const key of Object.values(keys)) expect(result.stdout).not.toContain(key);
  });

  it('prints the same lines as before for an OpenAI-only file (schema 2 and schema 1), and the offline answer', async () => {
    const api = await standIn();
    const key = openAiKey();
    const v2 = box();
    v2.writeSettings(fileWith({ openai: key }));
    expect(lines((await doctorAt(v2, api, { STUB_FETCH_STATUS: '200' })).stdout)).toEqual([
      `ai-model: OpenAI key ${tail(key)} saved in Settings (mode 600)`,
      'ai-model: organizing model automatic; document writing automatic',
      'openai probe: HTTP 200 (200=key works, 401=key rejected)',
    ]);
    const v1 = box();
    v1.writeSettings({ schemaVersion: 1, provider: 'openai', apiKey: key });
    expect(lines((await doctorAt(v1, api, { STUB_FETCH_STATUS: 'offline' })).stdout)).toEqual([
      `ai-model: OpenAI key ${tail(key)} saved in Settings (mode 600)`,
      'ai-model: organizing model automatic; document writing automatic',
      'openai probe: HTTP 000 (network, proxy, or VPN blocks api.openai.com)',
    ]);
    expect(api.requests).toEqual([]);
  });

  it('keeps the other file answers: choices only, an unreadable file, and no file at all (which now names Claude)', async () => {
    const choices = box();
    choices.writeSettings(fileWith({}, { processing: { modelKey: 'openai.gpt-5.6-terra' } }));
    expect(lines((await doctor(choices)).stdout)).toEqual([
      'ai-model: no API key saved; background model choices only (mode 600)',
      'ai-model: organizing model openai.gpt-5.6-terra; document writing automatic',
    ]);
    const garbage = box();
    garbage.writeSettings('not json', 0o644);
    expect(lines((await doctor(garbage)).stdout)).toEqual(['ai-model: Settings file is unreadable (mode 644) — save the key again in Settings → AI model']);
    expect(lines((await doctor(box())).stdout)).toEqual(['ai-model: no API key saved (add an OpenAI, DeepSeek or Anthropic (Claude) key in Settings → AI model)']);
  });
});

describe('start.sh › the Claude key leaves the launcher only in its own probe request', () => {
  const code = launcher.split('\n').filter((line) => !line.trim().startsWith('#'));
  const rows = launcher.slice(launcher.indexOf('doctor_ai_model_rows() {'), launcher.indexOf('warn_if_no_llm_credentials() {'));

  it('puts the x-api-key header only in the fetch request of the Claude probe, with no redirect followed', () => {
    const headerLines = code.filter((line) => line.includes('x-api-key'));
    expect(headerLines).toHaveLength(1);
    expect(headerLines[0]).toContain('? { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, redirect: "manual" }');
    expect(rows).toContain('fetch(url, { ...request(id, keys[id]), signal: AbortSignal.timeout(10000) })');
    // No other process: the rows spawn nothing, and start.sh has no curl seam for them any more.
    expect(rows).not.toMatch(/child_process|spawn\(|\bcurl\b|-K -/);
    expect(launcher).not.toContain('BOTBOY_TEST_CURL_BIN');
  });

  it('sends the same auth header as the app (anthropic-models.ts › AUTH_STYLE): flip one without the other and this fails', () => {
    // Probe P1 of the owner-run script decides which header the real API accepts; the doctor must follow that choice.
    const models = fs.readFileSync(path.join(path.dirname(launcherPath), 'src', 'core', 'anthropic-models.ts'), 'utf8');
    expect(models).toContain("export const AUTH_STYLE: AnthropicAuthStyle = 'x-api-key';");
    expect(launcher).toContain('{ headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, redirect: "manual" }');
    expect(models).toContain("export const ANTHROPIC_VERSION = '2023-06-01';");
  });

  it('takes the test probe address from BOTBOY_TEST_ANTHROPIC_PROBE_URL only, and accepts nothing but http://127.0.0.1:<port>', () => {
    expect(launcher).toContain(`' "$AI_MODEL_SETTINGS_FILE" "\${BOTBOY_TEST_ANTHROPIC_PROBE_URL:-}" 2>/dev/null || echo "ai-model: could not inspect the Settings file"`);
    expect(rows).toContain(': /^http:\\/\\/127\\.0\\.0\\.1:[0-9]{1,5}$/.test(probeOverride) ? probeOverride : "";');
    expect(rows).toContain('const anthropicOrigin = !probeOverride ? "https://api.anthropic.com"');
    expect(launcher).toContain('const claudePattern = /^sk-ant-(?!admin)[A-Za-z0-9]+-[A-Za-z0-9_-]{16,400}$/;');
  });

  it('wires the rows into the doctor once, and defines both functions and their hooks before the start flow can touch anything', () => {
    const doctorBlock = launcher.slice(launcher.indexOf('if [ "$DOCTOR" = "1" ]; then'));
    expect(doctorBlock.match(/^ {2}doctor_ai_model_rows$/gm)).toHaveLength(1);
    expect(doctorBlock.indexOf('doctor_ai_model_rows')).toBeGreaterThan(doctorBlock.indexOf('echo "llm-provider (launcher)'));
    expect(doctorBlock.indexOf('doctor_ai_model_rows')).toBeLessThan(doctorBlock.indexOf('# Connections → Gmail.'));
    expect(doctorBlock).not.toContain('ai-model: no API key saved');
    const firstEffect = launcher.indexOf('# 1. Start debug Chrome if not already running');
    for (const marker of ['doctor_ai_model_rows() {', 'warn_if_no_llm_credentials() {', 'BOTBOY_TEST_DOCTOR_AI_MODEL:-0', 'BOTBOY_TEST_LLM_WARNING:-0']) {
      const at = launcher.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      expect(at, marker).toBeLessThan(firstEffect);
    }
    expect(launcher.match(/^ {0,2}warn_if_no_llm_credentials$/gm)!.length).toBeGreaterThanOrEqual(3);
  });
});
