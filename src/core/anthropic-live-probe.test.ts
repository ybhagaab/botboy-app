import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_ANTHROPIC_KEY,
  fakeErrorBody,
  fakeModelRow,
  startFakeAnthropic,
  type FakeAnthropicServer,
  type FakeErrorAnswer,
  type FakeMessageReply,
  type FakeRecordedRequest,
} from './anthropic-api.fake.js';
import { ANALYTICS_IMPORT_PROPOSAL_RESPONSE_FORMAT } from './analytics-import-semantic-proposal.js';
import * as anthropicErrors from './anthropic-errors.js';
import * as anthropicMessages from './anthropic-messages.js';
import * as anthropicModels from './anthropic-models.js';
import * as anthropicSchema from './anthropic-schema.js';
import * as replayGuard from './anthropic-replay-guard.js';
import * as inferenceProvider from './inference-provider.js';
import * as llmClient from './llm-client.js';

/**
 * scripts/anthropic-live-probe.mjs run for real against the fake Anthropic server: `--models` (cases P1 and P2,
 * slice A1) and the generation and shaping cases P3 to P10 (slice A2), both account-vintage ways. The script is
 * the owner-run tool: here it runs in `--base-url` mode with its built-in fake key, reading the adapter from
 * src/core through tsx instead of dist/core. A preload hook records every file path the process touches, which
 * proves that fake mode and a refused live run never open ai-model.json. The y/N gate in front of every
 * generating case is tested in process, through the cases module's IO seam.
 */
const PACKAGE_DIR = process.cwd();
const SCRIPT = path.join(PACKAGE_DIR, 'scripts', 'anthropic-live-probe.mjs');
const ADAPTER_DIR = path.join(PACKAGE_DIR, 'src', 'core');
const SYNTHETIC_PATH = path.join(PACKAGE_DIR, 'src', 'core', 'testdata', 'anthropic-models.synthetic.json');
const TSX_LOADER = pathToFileURL(path.join(PACKAGE_DIR, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const SYNTHETIC_ROWS: Record<string, any>[] = JSON.parse(fs.readFileSync(SYNTHETIC_PATH, 'utf8')).data;
// Assembled at runtime: a realistic key literal must never sit in a source file.
const PLANTED_KEY = ['sk', 'ant', 'api03', 'planted'.repeat(6)].join('-');

const HOOK = `
const fs = require('fs');
const fd = fs.openSync(process.env.PROBE_FS_LOG, 'a');
const write = fs.writeSync;
const record = (kind, target) => {
  try { write(fd, kind + ' ' + (target && target.href ? target.href : String(target)) + '\\n'); } catch {}
};
for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync',
  'writeFileSync', 'mkdirSync', 'createReadStream', 'readFile', 'open', 'stat', 'lstat', 'access', 'readdir', 'writeFile', 'mkdir']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function (...args) { record(name, args[0]); return original.apply(this, args); };
}
for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'readdir', 'writeFile', 'mkdir']) {
  const original = fs.promises[name];
  if (typeof original !== 'function') continue;
  fs.promises[name] = function (...args) { record('promises.' + name, args[0]); return original.apply(this, args); };
}
require('module').syncBuiltinESMExports();
`;

interface RunResult { code: number | null; stdout: string; stderr: string; files: string }

const callsTo = (server: FakeAnthropicServer, route: string) => server.requests.filter(request => request.method === 'POST' && request.path === route);

const EVIDENCE_FIELDS: string[] = (ANALYTICS_IMPORT_PROPOSAL_RESPONSE_FORMAT as any).schema.properties.evidence.items.properties.field.enum;
interface Behavior {
  /** Evidence entries the "model" returns for the import proposal (21 are required). */
  evidenceCount?: number;
  /** Stop the tool loop after this many calls (default: three). */
  loopSteps?: number;
  /** Return no thinking blocks at all. */
  noThinking?: boolean;
  /** Characters of the P9 page. */
  pageChars?: number;
  /** An enum-breaking `status` in the proposal. */
  badStatus?: boolean;
}

/**
 * A plausible model for the probe's prompts, keyed on the "(probe …)" markers in its user turns. It answers
 * the way a real model would, including thinking blocks (the fake signs them and binds them to a prefix).
 */
function scriptedModel(behavior: Behavior = {}) {
  const thinking = (text: string) => (behavior.noThinking ? [] : [{ type: 'thinking' as const, thinking: text }]);
  return (request: FakeRecordedRequest): FakeMessageReply | FakeErrorAnswer | undefined => {
    const body = request.body;
    const flat = JSON.stringify(body.messages);
    const results = flat.split('"type":"tool_result"').length - 1;
    const marker = (name: string) => flat.includes(`(probe ${name}`);
    if (marker('P6 planner')) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'needs_input', goal: 'Show monthly revenue by region.', question: 'Which dataset?', nextAction: 'Pick one.', planJson: '' }) }] };
    }
    if (marker('P6 proposal')) {
      const count = behavior.evidenceCount ?? EVIDENCE_FIELDS.length;
      return { content: [{ type: 'text', text: JSON.stringify({
        status: behavior.badStatus ? 'perhaps' : 'ready', datasetName: 'Revenue', description: 'd', domainKey: 'finance', layout: 'record_table', headerRow: 1, dataStartRow: 2, dataEndRow: 4,
        timeColumn: 'A', metricValueColumn: 'C', labelColumn: null, unitColumn: null, countingKeyColumn: null, dimensionColumns: ['B'], fillDownLabel: false, wideHeadings: [],
        metricId: 'revenue', metricDefinition: 'm', unit: 'USD', regimeId: 'r', regimeDefinition: 'r', grain: 'month', timeZone: 'UTC', classification: 'confidential',
        evidence: EVIDENCE_FIELDS.slice(0, count).map(field => ({ field, proposedValue: 'x', confidence: 0.9, contextTerms: [], profileCells: ['A1'], explanation: 'e' })), unresolved: [],
      }) }] };
    }
    if (marker('P7 loop')) {
      if (body.tool_choice?.type === 'none' || results >= (behavior.loopSteps ?? 3)) return { content: [{ type: 'text', text: 'DONE' }] };
      return { content: [...thinking('plan'), { type: 'tool_use', name: 'probe_lookup', input: { query: ['alpha', 'beta', 'gamma'][results] } }] };
    }
    if (marker('P7 screenshot')) {
      return results > 0 ? { content: [{ type: 'text', text: 'ok' }] }
        : { content: [...thinking('look'), { type: 'tool_use', name: 'probe_lookup', input: { query: 'shot' } }] };
    }
    if (marker('P7 parallel')) {
      return { content: [...thinking('left first'), { type: 'tool_use', name: 'probe_lookup', input: { query: 'left' } }, ...thinking('right next'), { type: 'tool_use', name: 'probe_lookup', input: { query: 'right' } }] };
    }
    if (marker('P8')) return { content: [{ type: 'text', text: 'OK' }] };
    if (marker('P9')) {
      return { content: [{ type: 'tool_use', name: 'write_file', input: { path: '/tmp/botboy-probe.html', content: `<html><body>${'paragraph '.repeat(Math.ceil((behavior.pageChars ?? 24_000) / 10))}</body></html>` } }] };
    }
    return undefined;
  };
}

// Each case spawns child processes (the refusal case spawns nine): explicit headroom for a loaded machine.
describe('anthropic-live-probe --models', { timeout: 60_000 }, () => {
  let work: string;
  let home: string;
  let hook: string;
  let fake: FakeAnthropicServer | undefined;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-probe-'));
    home = path.join(work, 'home');
    fs.mkdirSync(home);
    hook = path.join(work, 'fs-hook.cjs');
    fs.writeFileSync(hook, HOOK);
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    fs.rmSync(work, { recursive: true, force: true });
  });

  /** Run the script exactly as an owner would, except for the adapter folder; stdio is piped (no terminal). */
  function run(args: string[], options: { cwd?: string; adapterDir?: string | null } = {}): Promise<RunResult> {
    const log = path.join(work, `fs-${Math.random().toString(36).slice(2)}.log`);
    fs.writeFileSync(log, '');
    const adapterArgs = options.adapterDir === null ? [] : ['--adapter-dir', options.adapterDir ?? ADAPTER_DIR];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', hook, '--import', TSX_LOADER, SCRIPT, ...args, ...adapterArgs], {
        cwd: options.cwd ?? work,
        env: { PATH: process.env.PATH ?? '', HOME: home, PROBE_FS_LOG: log },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`probe timed out\n${stdout}\n${stderr}`)); }, 60_000);
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, files: fs.readFileSync(log, 'utf8') });
      });
    });
  }

  const row = (stdout: string, what: string) => stdout.split('\n').find(line => line.includes(what)) ?? '';
  const decoyHome = () => {
    fs.mkdirSync(path.join(home, '.personal-productivity-tracker'), { recursive: true });
    fs.writeFileSync(path.join(home, '.personal-productivity-tracker', 'ai-model.json'), JSON.stringify({ schemaVersion: 2, keys: { anthropic: { apiKey: PLANTED_KEY } } }));
  };

  it('runs end to end against the fake: both auth headers, the model list, picks, profiles, the comparison and the capture', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    decoyHome();
    const saved = path.join(work, 'captured', 'models.json');
    const result = await run(['--base-url', fake.url, '--models', '--save-list', saved, '--fixture', SYNTHETIC_PATH]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const out = result.stdout;

    // Header: the fake key's suffix only.
    expect(out.split('\n')[0]).toContain(`fake server ${fake.url}`);
    expect(out.split('\n')[0]).toContain(`key …${FAKE_ANTHROPIC_KEY.slice(-4)}`);
    expect(out).not.toContain(FAKE_ANTHROPIC_KEY);

    // P1: both headers, the shipped one decides.
    expect(row(out, 'x-api-key header (shipped)')).toMatch(/^P1\s+x-api-key header \(shipped\)\s+PASS\s+HTTP 200/);
    expect(row(out, 'Authorization: Bearer header')).toMatch(/^P1\s+Authorization: Bearer header\s+PASS\s+HTTP 200/);

    // P2: the list, lifecycle counts, picks per role, profiles, table agreement, comparison, capture.
    expect(row(out, 'model list pages')).toMatch(/PASS\s+14 model\(s\) in 1 page\(s\)/);
    expect(row(out, 'lifecycle')).toContain('13 active, 1 deprecated (offered only when already held), 0 retired (never offered); 13 offered');
    expect(row(out, 'default pick per role')).toContain('chat and document writing: claude-sonnet-5-5; organizing: claude-haiku-5-5; verification tries: claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-4-6');
    expect(row(out, 'derived profiles')).toMatch(/INFO\s+A=4 B=7 C=3 D=0/);
    expect(row(out, 'capabilities agree with the known-model table')).toMatch(/PASS\s+no listed model differs from the table/);
    expect(row(out, 'compare with anthropic-models.synthetic.json')).toMatch(/PASS\s+14 model\(s\) in common/);
    expect(row(out, 'saved the raw model rows')).toMatch(/PASS\s+14 row\(s\) to .*models\.json \(no key inside\)/);
    expect(out).toMatch(/\n7 passed, 0 failed\.\n$/);

    // Each model's derived profile and thinkingOff, as the owner compares them with what they know.
    const cells = (id: string) => row(out, `  ${id} `).trim().split(/\s{2,}/);
    expect(cells('claude-opus-5-5')).toEqual(expect.arrayContaining(['active', 'A', 'lowest_effort', 'yes', 'adaptive', 'low,medium,high,xhigh,max', '1M/128K', 'table']));
    expect(cells('claude-haiku-5-5')).toEqual(expect.arrayContaining(['B', 'native_without_tools', 'yes', 'adaptive+disabled']));
    expect(cells('claude-opus-5')).toEqual(expect.arrayContaining(['B', 'native_without_tools', 'no']));
    expect(cells('claude-opus-4-5-20251101')).toEqual(expect.arrayContaining(['C', 'native', 'no', 'enabled+disabled', 'low,medium,high', '200K/64K']));
    expect(cells('claude-sonnet-4-5-20250929')).toEqual(expect.arrayContaining(['deprecated', 'C']));

    // The capture is the raw list as received (no key), private to the owner.
    const file = JSON.parse(fs.readFileSync(saved, 'utf8'));
    expect(file.data.map((entry: any) => entry.id)).toEqual(SYNTHETIC_ROWS.filter(entry => entry.lifecycle !== 'retired').map(entry => entry.id));
    expect(file.data[0]).toEqual(SYNTHETIC_ROWS[0]);
    expect(file).toMatchObject({ has_more: false, first_id: 'claude-haiku-5-5' });
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(saved, 'utf8')).not.toContain('sk-ant');
    expect(out).toContain('Reduce the saved list to the ids on the public models overview');

    // What the fake saw: only the free GETs, both header styles, the fake key, no beta header, no message call.
    const calls = fake.requests.map(request => `${request.method} ${request.path} ${request.auth.style}`);
    expect(calls.slice(0, 2)).toEqual(['GET /v1/models x-api-key', 'GET /v1/models bearer']);
    expect(fake.requests[0].query).toEqual({ limit: ['1'] });
    expect(calls.slice(2)).toEqual(['GET /v1/models x-api-key']);
    expect(fake.requests.every(request => request.auth.key === FAKE_ANTHROPIC_KEY && request.headers['anthropic-beta'] === undefined)).toBe(true);
    expect(fake.requests.some(request => request.method === 'POST')).toBe(false);

    // Fake mode never opens ai-model.json (the decoy holds a different key), though the hook sees the process work.
    expect(result.files).toContain('writeFileSync');
    expect(result.files).not.toMatch(/ai-model\.json|\.personal-productivity-tracker/);
    expect(out).not.toContain(PLANTED_KEY);
  });

  it('reports differences from a saved list and fails when capabilities disagree with the known table', async () => {
    const live = SYNTHETIC_ROWS
      .filter(entry => entry.lifecycle !== 'retired' && entry.id !== 'claude-fable-5')
      .map(entry => (entry.id === 'claude-opus-4-7'
        // The key claims Opus 4.7 cannot turn thinking off: the docs table says it can.
        ? { ...entry, capabilities: { ...entry.capabilities, thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false }, disabled: { supported: false } } } } }
        : entry));
    live.push(fakeModelRow({ id: 'claude-new-9', name: 'Claude New 9', line: 'sonnet', variant: 'A' }));
    fake = await startFakeAnthropic({ models: live });
    const result = await run(['--base-url', fake.url, '--models', '--fixture', SYNTHETIC_PATH]);
    expect(result.code).toBe(1);
    const out = result.stdout;
    expect(row(out, 'capabilities agree with the known-model table')).toMatch(/FAIL\s+1 model\(s\) disagree; record a known-id exception \(D2\)\. BotBoy sends the stricter shape meanwhile: claude-opus-4-7 \[thinking\.disabled\]/);
    expect(row(out, 'models the known table does not know')).toContain('1: claude-new-9 (A)');
    const comparison = row(out, 'compare with anthropic-models.synthetic.json');
    expect(comparison).toMatch(/INFO/);
    expect(comparison).toContain('only in the live list: claude-new-9');
    expect(comparison).toContain('only in the saved list: claude-fable-5');
    // The stricter shape holds: Opus 4.7 still reads as a switchable model only through the table AND capabilities.
    expect(cellsOf(out, 'claude-opus-4-7')).toEqual(expect.arrayContaining(['A', 'lowest_effort']));
    expect(out).toMatch(/\n4 passed, 1 failed\. See the FAIL rows above\.\n$/);
    // The new unknown adaptive model runs the prefix check and is shaped from its capabilities alone.
    expect(cellsOf(out, 'claude-new-9')).toEqual(expect.arrayContaining(['A', 'lowest_effort', 'yes', 'caps-only']));
  });

  it('fails the shipped header and the list, with classified text, and never prints a planted key', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.respond = () => ({
      status: 401,
      headers: { 'request-id': PLANTED_KEY },
      body: fakeErrorBody('authentication_error', `invalid x-api-key ${PLANTED_KEY} ${'z'.repeat(400)}`),
    });
    const result = await run(['--base-url', fake.url, '--models']);
    expect(result.code).toBe(1);
    const out = result.stdout;
    expect(row(out, 'x-api-key header (shipped)')).toMatch(/FAIL\s+HTTP 401 auth_rejected: invalid x-api-key sk-…\[redacted\]/);
    // The other header style is information only.
    expect(row(out, 'Authorization: Bearer header')).toMatch(/INFO\s+HTTP 401 auth_rejected/);
    expect(row(out, 'model list pages')).toMatch(/FAIL\s+HTTP 401 auth_rejected/);
    expect(out).not.toContain(PLANTED_KEY);
    expect(out).not.toContain('planted');
    expect(out).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(result.stderr).not.toContain('planted');
    expect(out).toMatch(/\n0 passed, 2 failed\. See the FAIL rows above\.\n$/);
    // Nothing below a failed list: no model table.
    expect(out).not.toContain('Models (kind:');
  });

  it('redacts a key-shaped model id or name from the list before printing it', async () => {
    fake = await startFakeAnthropic({
      models: [
        fakeModelRow({ id: 'claude-sonnet-5-5', name: `Claude ${PLANTED_KEY}`, line: 'sonnet', variant: 'A' }),
        fakeModelRow({ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', line: 'haiku', variant: 'B' }),
      ],
    });
    const result = await run(['--base-url', fake.url, '--models']);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('planted');
    expect(result.stdout).toContain('[redacted]');
  });

  it('refuses a live run without a terminal before reading any file or contacting anything', async () => {
    // No key is planted here: were the check ever broken, the run would stop at "no key saved", never at the network.
    const result = await run(['--live', '--models'], { adapterDir: null });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('needs an interactive terminal');
    expect(result.stderr).not.toContain('No Anthropic key is saved');
    // The settings file is never even looked for, and the adapter is not loaded: the check comes first.
    expect(result.files).not.toMatch(/ai-model\.json|\.personal-productivity-tracker|anthropic-models|anthropic-errors|llm-client/);
  });

  it('refuses unusable options with the usage text and a distinct exit status', async () => {
    const cases: [string[], RegExp][] = [
      [[], /Choose exactly one of --live or --base-url/],
      [['--models'], /Choose exactly one of --live or --base-url/],
      [['--cases', 'P3'], /Choose exactly one of --live or --base-url/],
      [['--base-url', 'http://127.0.0.1:9', '--models', '--cases', 'P3'], /Choose --models or --cases, not both/],
      [['--base-url', 'http://127.0.0.1:9', '--cases', 'P99'], /--cases takes a list of P3, P4, P5, P6, P7, P8, P9, P10 .*got P99/],
      [['--base-url', 'http://127.0.0.1:9', '--cases', ','], /--cases takes a list/],
      [['--base-url', 'http://127.0.0.1:9', '--cases'], /--cases needs a value/],
      [['--base-url', 'http://127.0.0.1:9', '--vintage', 'sometimes'], /--vintage takes both, default or enforce/],
      [['--live', '--models', '--base-url', 'http://127.0.0.1:9'], /Choose exactly one of --live or --base-url/],
      [['--models', '--base-url', 'https://api.example.com'], /must point at a loopback fake server/],
      [['--models', '--base-url', 'http://10.0.0.5:8080'], /must point at a loopback fake server/],
      [['--models', '--base-url', 'not a url'], /--base-url is not a URL/],
      [['--models', '--base-url'], /--base-url needs a value/],
      [['--models', '--frobnicate'], /unknown option --frobnicate/],
    ];
    for (const [args, message] of cases) {
      const result = await run(args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr, args.join(' ')).toMatch(message);
      expect(result.stdout, args.join(' ')).toBe('');
      expect(result.files, args.join(' ')).not.toMatch(/ai-model\.json/);
    }
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--live [--models | --cases P3,P7,...]');
    expect(help.stdout).toContain('--vintage');
    expect(help.stdout).toContain('never reads ai-model.json');
  });

  it('says to build first when the adapter cannot be loaded', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    const result = await run(['--base-url', fake.url, '--models'], { adapterDir: path.join(work, 'missing-dist') });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Run `npm run build` first');
    expect(fake.requests).toHaveLength(0);
  });

  it('asks for a saved key when none exists (fake mode is the only way past that check without one)', () => {
    // Real mode needs a terminal, which a test cannot provide; the guard that reads the key is the same code path
    // as the "No Anthropic key is saved yet" message below, checked here on the source so the wording cannot rot.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain('No Anthropic key is saved yet. Open Settings → AI model in BotBoy');
    expect(source).toContain('const apiKey = baseUrl ? fake.FAKE_ANTHROPIC_KEY : readSavedKey();');
    // Live mode talks to the fixed endpoint only; --base-url and --live exclude each other.
    expect(source).toContain('const endpoint = baseUrl || ANTHROPIC_API_ENDPOINT;');
  });

  it('is a dev tool: it is not in the release allowlist and holds no credential', () => {
    const release = fs.readFileSync(path.join(PACKAGE_DIR, 'scripts', 'release.sh'), 'utf8');
    expect(release).not.toContain('anthropic-live-probe');
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    const cases = fs.readFileSync(path.join(PACKAGE_DIR, 'scripts', 'anthropic-live-probe-cases.mjs'), 'utf8');
    expect(cases).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    expect(release).not.toContain('anthropic-live-probe-cases');
  });

  // ── Cases P3 to P10 (slice A2) ──
  const CASE_TIMEOUT = 240_000;

  it('runs every case against the fake of an older account: shaping, tools, history, schemas, replay, caching, a long page and images', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.reply = scriptedModel();
    decoyHome();
    const result = await run(['--base-url', fake.url]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out.split('\n')[0]).toContain(`Anthropic probe · all cases · fake server ${fake.url}`);
    expect(out).toMatch(/\n\d+ passed, 0 failed\.\n$/);
    expect(out).not.toContain(FAKE_ANTHROPIC_KEY);

    // P3: one model per profile, Off/Low/High/Max with and without tools, and the documented-bad form.
    expect(row(out, 'shaping · kind A · claude-sonnet-5-5')).toMatch(/PASS\s+8 shaped requests accepted/);
    expect(row(out, 'shaping · kind B · claude-haiku-5-5')).toMatch(/PASS\s+8 shaped requests accepted/);
    expect(row(out, 'shaping · kind C · claude-opus-4-5-20251101')).toMatch(/PASS\s+8 shaped requests accepted/);
    expect(row(out, 'shaping · kind D')).toMatch(/INFO\s+no offered model has this thinking profile/);
    for (const kind of ['A', 'B', 'C']) expect(row(out, `bad form · kind ${kind}`)).toMatch(/PASS\s+rejected as documented via count_tokens/);
    expect(out).not.toContain('count_tokens self-test');

    // P4: the real chat tool set, sanitized, with real sizes; the raw oneOf form is refused today (fake default).
    expect(row(out, 'chat tools, sanitized, plus the system prompt')).toMatch(/P4\s+all \d+ chat tools.*PASS\s+accepted by count_tokens: system prompt about [\d.]+K tokens, \d+ tools about [\d.]+K/);
    expect(row(out, 'raw create_data_room_dataset')).toMatch(/INFO\s+rejected unsanitized .*oneOf.*the sanitizer is needed/);

    // P5: the API's answer for each raw shape, and that the adapter's rewrite is accepted.
    for (const label of ['assistant turn first', 'two user turns in a row', 'empty text block', 'tool_result without its tool_use']) {
      expect(row(out, `raw: ${label}`), label).toMatch(/PASS/);
      expect(row(out, `rewrite: ${label}`), label).toMatch(/PASS\s+the adapter's body: HTTP 200/);
    }

    // P6: both real schemas on a Sonnet-line and a Haiku-line model.
    for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(row(out, `planner envelope · ${model}`)).toMatch(/PASS\s+valid JSON, all bounds hold/);
      expect(row(out, `import proposal · ${model}`)).toMatch(/PASS\s+valid JSON, all bounds hold; \d+ bound\(s\) were removed from the wire schema; parseEvidence accepts the evidence/);
    }

    // P7: the loop, edit detection both ways, the vintage verdict, the guard and the parallel case.
    expect(row(out, '3-step tool loop')).toMatch(/PASS\s+3 of 3 tool step\(s\) completed, 3 thinking block\(s\) returned and replayed, 4 request\(s\) accepted; the final call without tools sent tool_choice none with the real tools: yes/);
    expect(row(out, 'unedited replay · default behavior')).toMatch(/PASS\s+HTTP 200/);
    expect(row(out, 'edited earlier tool_result · default behavior')).toMatch(/INFO\s+HTTP 200/);
    expect(row(out, 'unedited replay · forced prefix check')).toMatch(/PASS\s+HTTP 200/);
    expect(row(out, 'edited earlier tool_result · forced prefix check')).toMatch(/PASS\s+HTTP 400 invalid_request: .*Invalid `signature` in `thinking` block/);
    expect(row(out, 'account vintage')).toMatch(/INFO\s+this account does NOT enforce the thinking-prefix check by default/);
    expect(row(out, 'drop_block retry')).toMatch(/INFO\s+HTTP 200; the API dropped \d+ block\(s\) itself; RECOVERY_DROP_BLOCK_FIRST stays off/);
    expect(row(out, 'screenshot-style loop (guard)')).toMatch(/PASS\s+the guard dropped 1 thinking block\(s\).*default HTTP 200.*forced HTTP 400/);
    expect(row(out, 'guard cost on a non-enforcing account')).toMatch(/INFO\s+the API would have accepted the dropped block\(s\) here; withholding them removes \d+ input token/);
    expect(row(out, 'guard drops vs the API')).toMatch(/PASS\s+the guard dropped 1 block\(s\); the API \(drop_block\) reported 1/);
    expect(row(out, 'parallel case')).toMatch(/PASS\s+edited tool_use, thinking replayed verbatim: HTTP 200.*second thinking block removed: HTTP 200.*SAME_MESSAGE_EDIT should be 'keep', shipped value 'keep'/);

    // P8, P9, P10.
    expect(row(out, 'cache read on the second call')).toMatch(/PASS\s+cache_read_input_tokens \d+ of \d+ input tokens/);
    expect(row(out, 'long write_file turn')).toMatch(/PASS\s+\d+ stream event\(s\) in [\d.]+ s, longest silence [\d.]+ s .*arguments parsed, content 24\d{3} characters; finish reason tool_calls/);
    expect(row(out, 'base64 image in a user turn')).toMatch(/PASS\s+HTTP 200/);
    expect(row(out, 'base64 image inside a tool_result')).toMatch(/INFO\s+HTTP 200/);

    // The shipped client's guard line is reported once in the output, not left on stderr.
    expect(out).toMatch(/Note: the shipped client logged: \[Anthropic\] replay guard: dropped 1 earlier thinking block/);

    // What the fake saw: only its own key; generations never carry a temperature; the beta field only where forced.
    expect(fake.requests.every(request => request.auth.key === FAKE_ANTHROPIC_KEY)).toBe(true);
    for (const request of callsTo(fake, '/v1/messages')) expect(request.body).not.toHaveProperty('temperature');
    const betaRequests = fake.requests.filter(request => request.headers['anthropic-beta'] !== undefined);
    expect(betaRequests.length).toBeGreaterThan(0);
    expect(betaRequests.every(request => request.headers['anthropic-beta'] === 'thinking-binding-controls-2026-08-01' && request.body?.thinking?.block_binding)).toBe(true);
    expect(callsTo(fake, '/v1/messages/count_tokens').every(request => request.body.max_tokens === undefined && request.body.stream === undefined)).toBe(true);
    // The real structured-output requests went out as native schemas with effort low.
    const schemaCalls = callsTo(fake, '/v1/messages').filter(request => request.body.output_config?.format);
    expect(schemaCalls).toHaveLength(4);
    expect(schemaCalls.every(request => request.body.output_config.effort === 'low')).toBe(true);
    // Fake mode never opens ai-model.json and never prints the decoy key.
    expect(result.files).not.toMatch(/ai-model\.json|\.personal-productivity-tracker/);
    expect(out).not.toContain(PLANTED_KEY);
  }, CASE_TIMEOUT);

  it('runs the same cases against the fake of an account that enforces the thinking-prefix check by default', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS, thinkingChecks: { prefix: true, latestRun: true } });
    fake.reply = scriptedModel();
    const result = await run(['--base-url', fake.url, '--cases', 'P7']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(row(out, 'edited earlier tool_result · default behavior')).toMatch(/INFO\s+HTTP 400 invalid_request: .*Invalid `signature` in `thinking` block/);
    expect(row(out, 'edited earlier tool_result · forced prefix check')).toMatch(/PASS\s+HTTP 400/);
    expect(row(out, 'account vintage')).toMatch(/INFO\s+this account ENFORCES the thinking-prefix check by default/);
    // The unguarded screenshot request is refused both ways, so the drop is required, not a cost.
    expect(row(out, 'screenshot-style loop (guard)')).toMatch(/PASS\s+the guard dropped 1 thinking block\(s\).*default HTTP 400.*forced HTTP 400/);
    expect(row(out, 'guard cost on a non-enforcing account')).toMatch(/INFO\s+not applicable: this account refuses the unguarded request/);
    // The guarded requests the shipped client sent were all accepted: the loop completed.
    expect(row(out, '3-step tool loop')).toMatch(/PASS/);
    // Verbatim replay of an edited tool_use is accepted, a partial thinking drop is refused (S9): 'keep' stays.
    expect(row(out, 'parallel case')).toMatch(/PASS\s+edited tool_use, thinking replayed verbatim: HTTP 200.*second thinking block removed: HTTP 400.*latest assistant message cannot be modified.*all thinking removed: HTTP 200.*should be 'keep', shipped value 'keep'/);
  }, CASE_TIMEOUT);

  it('keeps the loop honest on an account that refuses the verbatim edited replay: the probe says to switch SAME_MESSAGE_EDIT', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.reply = scriptedModel();
    // This account also refuses an edited tool_use input inside a message that holds thinking.
    fake.respond = request => {
      if (request.path !== '/v1/messages/count_tokens' || !request.rawBody.includes('(compacted)')) return undefined;
      return { status: 400, body: fakeErrorBody('invalid_request_error', 'messages.1.content.1: tool_use input was modified; thinking blocks of this message can not be replayed') };
    };
    const result = await run(['--base-url', fake.url, '--cases', 'P7']);
    expect(result.code).toBe(1);
    expect(row(result.stdout, 'parallel case')).toMatch(/FAIL\s+edited tool_use, thinking replayed verbatim: HTTP 400.*SAME_MESSAGE_EDIT should be 'drop_run', shipped value 'keep': CHANGE THE CONSTANT in anthropic-replay-guard\.ts/);
    expect(result.stdout).toMatch(/\n\d+ passed, 1 failed\. See the FAIL rows above\.\n$/);
  }, CASE_TIMEOUT);

  it('repeats a known-bad form as a max_tokens generation when count_tokens accepts anything, and says so', async () => {
    fake = await startFakeAnthropic({
      models: [...SYNTHETIC_ROWS, fakeModelRow({ id: 'claude-legacy-3', name: 'Claude Legacy 3', line: 'haiku', variant: 'D', maxInputTokens: 200_000, maxTokens: 4096 })],
      countTokensValidates: false,
    });
    fake.reply = scriptedModel();
    const result = await run(['--base-url', fake.url, '--cases', 'P3,P4']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(row(out, 'shaping · kind D · claude-legacy-3')).toMatch(/PASS/);
    for (const kind of ['A', 'B', 'C', 'D']) {
      expect(row(out, `bad form · kind ${kind}`), kind).toMatch(/PASS\s+rejected as documented via max_tokens (1|1100) generation \(count_tokens: HTTP 200/);
    }
    expect(row(out, 'count_tokens self-test')).toMatch(/INFO\s+count_tokens accepted a form the docs call invalid/);
    // The tool-set row is weak evidence now and is repeated as a one-token generation.
    expect(row(out, 'chat tools, sanitized')).toMatch(/INFO.*\[count_tokens is not trusted on this key\]/);
    expect(row(out, 'the same request as a max_tokens 1 generation')).toMatch(/PASS\s+HTTP 200/);
    // The generations were bounded: one or 1,100 output tokens, never a thinking-sized request.
    const generations = callsTo(fake, '/v1/messages');
    expect(generations).toHaveLength(5);
    expect(generations.map(request => request.body.max_tokens).sort((a, b) => a - b)).toEqual([1, 1, 1, 1, 1100]);
  }, CASE_TIMEOUT);

  it('selects cases and account-vintage ways: --cases adds to P1 and P2, --vintage limits P7', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.reply = scriptedModel();
    const only = await run(['--base-url', fake.url, '--cases', 'p10,P5']);
    expect(only.code).toBe(0);
    expect(only.stdout.split('\n')[0]).toContain('cases P10,P5');
    const ids = only.stdout.split('\n').map(line => /^(P\d+)\s/.exec(line)?.[1]).filter(Boolean);
    // P5 and P10 rely on count_tokens, so the P3 self-test runs first (one "bad form" row) and is reported.
    expect([...new Set(ids)]).toEqual(['P1', 'P2', 'P3', 'P5', 'P10']);
    expect(row(only.stdout, 'bad form · kind A')).toMatch(/P3\s+bad form · kind A .*PASS/);
    expect(only.stdout).not.toContain('shaping · kind');
    expect(callsTo(fake, '/v1/messages')).toHaveLength(0);

    fake.requests.length = 0;
    const defaultOnly = await run(['--base-url', fake.url, '--cases', 'P7', '--vintage', 'default']);
    expect(defaultOnly.code).toBe(0);
    expect(defaultOnly.stdout).toContain('edited earlier tool_result · default behavior');
    expect(defaultOnly.stdout).not.toContain('forced prefix check');
    // Only the parallel case (three count_tokens replays) and the transformations check (one generation) force the control.
    expect(fake.requests.filter(request => request.headers['anthropic-beta'] !== undefined)).toHaveLength(4);

    fake.requests.length = 0;
    const forcedOnly = await run(['--base-url', fake.url, '--cases', 'P7', '--vintage', 'enforce']);
    expect(forcedOnly.code).toBe(0);
    expect(forcedOnly.stdout).toContain('edited earlier tool_result · forced prefix check');
    expect(forcedOnly.stdout).not.toContain('default behavior');
    expect(forcedOnly.stdout).not.toMatch(/account vintage/);
  }, CASE_TIMEOUT);

  it('reports the stripped bounds a model violates as information and a broken enum as a failure', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.reply = scriptedModel({ evidenceCount: 20 });
    const short = await run(['--base-url', fake.url, '--cases', 'P6']);
    expect(short.code).toBe(0);
    expect(row(short.stdout, 'import proposal · claude-sonnet-5-5')).toMatch(/INFO\s+valid JSON, but 1 stripped bound\(s\) are violated \(\$\.evidence minItems\): the local validators exist for this; \d+ bound\(s\) were removed from the wire schema; parseEvidence rejects it: evidence must contain exactly 21 ordered entries/);
    expect(row(short.stdout, 'planner envelope · claude-sonnet-5-5')).toMatch(/PASS/);

    fake.reply = scriptedModel({ badStatus: true });
    const broken = await run(['--base-url', fake.url, '--cases', 'P6']);
    expect(broken.code).toBe(1);
    expect(row(broken.stdout, 'import proposal · claude-haiku-5-5')).toMatch(/FAIL\s+1 structural violation\(s\) the API should have prevented: \$\.status enum/);
  }, CASE_TIMEOUT);

  it('treats a model that stops early, writes a short page or skips thinking as information, not as an adapter fault', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.reply = scriptedModel({ loopSteps: 1, pageChars: 5000 });
    const early = await run(['--base-url', fake.url, '--cases', 'P7,P9']);
    expect(early.code).toBe(0);
    expect(row(early.stdout, '3-step tool loop')).toMatch(/PASS\s+1 of 3 tool step\(s\) completed \(the model chose to stop early\)/);
    expect(row(early.stdout, 'long write_file turn')).toMatch(/INFO\s+.*content 5\d{3} characters \(below the 20,000 asked for/);

    fake.reply = scriptedModel({ noThinking: true });
    const bare = await run(['--base-url', fake.url, '--cases', 'P7']);
    expect(bare.code).toBe(0);
    expect(row(bare.stdout, 'edit detection')).toMatch(/INFO\s+the model returned no thinking block in the loop/);
    expect(row(bare.stdout, 'screenshot-style loop (guard)')).toMatch(/INFO\s+the model returned no thinking block/);
    expect(row(bare.stdout, 'parallel case')).toMatch(/INFO\s+the model returned 0 thinking block\(s\) and 2 tool call\(s\)/);
  }, CASE_TIMEOUT);

  it('fails the rows an error hits, redacts a key-shaped upstream string, and keeps running', async () => {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.reply = scriptedModel();
    fake.respond = request => (request.path === '/v1/messages/count_tokens' && request.rawBody.includes('probe_lookup')
      ? { status: 400, body: fakeErrorBody('invalid_request_error', `tools.0: refused ${PLANTED_KEY}`) }
      : undefined);
    const result = await run(['--base-url', fake.url, '--cases', 'P3']);
    expect(result.code).toBe(1);
    expect(row(result.stdout, 'shaping · kind A')).toMatch(/FAIL\s+4 of 8 shaped requests rejected: .*\+tools: HTTP 400 invalid_request: tools\.0: refused sk-…\[redacted\]/);
    expect(result.stdout).not.toContain('planted');
    expect(result.stderr).not.toContain('planted');
    // The other kinds still ran.
    expect(row(result.stdout, 'shaping · kind C')).toMatch(/FAIL/);
    expect(row(result.stdout, 'bad form · kind C')).toMatch(/PASS/);
  }, CASE_TIMEOUT);
});

// ── The y/N gate, in process through the cases module's IO seam ──
describe('anthropic-live-probe cases: nothing is billed without a yes', { timeout: 120_000 }, () => {
  let fake: FakeAnthropicServer | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function runWith(selected: string[], answers: string[] | 'closed') {
    fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
    fake.reply = scriptedModel();
    const { runCases } = await import(/* @vite-ignore */ pathToFileURL(path.join(PACKAGE_DIR, 'scripts', 'anthropic-live-probe-cases.mjs')).href);
    const listed = anthropicModels.parseAnthropicModelPage({ data: SYNTHETIC_ROWS }).models;
    const offered = anthropicModels.selectOfferedModels(listed);
    // Answer each prompt when it appears, as a person at a terminal would; 'closed' is Ctrl-D at the first prompt.
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = answers === 'closed' ? [] : [...answers];
    output.on('data', chunk => {
      if (!String(chunk).includes('[y/N]')) return;
      if (answers === 'closed') input.end(); else input.write(`${pending.shift() ?? ''}\n`);
    });
    const rows: { id: string; name: string; result: string; detail: string }[] = [];
    const said: string[] = [];
    const notes: string[] = [];
    const loaders: Record<string, () => Promise<unknown>> = {
      'prompt-manager.js': () => import('./prompt-manager.js'),
      'analytics-job-planner.js': () => import('./analytics-job-planner.js'),
      'analytics-import-semantic-proposal.js': () => import('./analytics-import-semantic-proposal.js'),
    };
    await runCases({
      isFake: false, endpoint: fake.url, apiKey: FAKE_ANTHROPIC_KEY, authStyle: 'x-api-key',
      adapter: { models: anthropicModels, errors: anthropicErrors, client: llmClient, messages: anthropicMessages, schema: anthropicSchema, guard: replayGuard, provider: inferenceProvider },
      load: (name: string) => loaders[name](),
      offered, defaultModel: 'claude-sonnet-5-5', organizingModel: 'claude-haiku-5-5',
      selected: new Set(selected), vintage: 'both',
      add: (id: string, name: string, result: string, detail: string) => rows.push({ id, name, result, detail }),
      show: (value: unknown, max = 120) => String(value ?? '').slice(0, max),
      note: (text: string) => notes.push(text),
      say: () => {},
      io: { input, output, say: (line: string) => said.push(line) },
    });
    return { rows, said, notes };
  }

  it('asks for P6 to P9 with max_tokens and a ceiling, and a "no" sends no generation at all', async () => {
    const { rows, said } = await runWith(['P6', 'P7', 'P8', 'P9'], ['n', 'no', '', 'maybe']);
    for (const id of ['P6', 'P7', 'P8', 'P9']) {
      const skipped = rows.filter(entry => entry.id === id);
      expect(skipped.map(entry => entry.result), id).toEqual(['INFO']);
      expect(skipped[0].detail, id).toMatch(/skipped at your request/);
    }
    expect(callsTo(fake!, '/v1/messages')).toHaveLength(0);
    const asked = said.join('\n');
    expect(asked).toMatch(/P6 sends the two real structured-output schemas/);
    expect(asked).toMatch(/import proposal on claude-sonnet-5-5: max_tokens \d+/);
    expect(asked).toMatch(/P7 runs about 9 generations/);
    expect(asked).toMatch(/P9 asks for one write_file call/);
    expect(asked).toMatch(/ceiling [\d.]+ dollars at an assumed 15\/75 dollars per million tokens/);
    expect(asked).toMatch(/max_tokens \d+ each \(16 asked for plus this model's thinking allowance\); about [\d.]+K input tokens each/);
  });

  it('treats closed input as a no, and runs exactly the case that got a yes', async () => {
    const closed = await runWith(['P8'], 'closed');
    expect(closed.rows.map(entry => entry.detail)).toEqual(['skipped at your request']);
    expect(callsTo(fake!, '/v1/messages')).toHaveLength(0);
    await fake!.close();

    const yes = await runWith(['P8'], ['y']);
    expect(yes.rows.map(entry => [entry.name, entry.result])).toEqual([['cache write on the first call', 'INFO'], ['cache read on the second call', 'PASS']]);
    expect(callsTo(fake!, '/v1/messages')).toHaveLength(2);
    // 16 asked for plus the always-on model's 2,048-token thinking allowance, exactly what the prompt announced.
    expect(callsTo(fake!, '/v1/messages').every(request => request.body.max_tokens === 2064)).toBe(true);
  });

  it('never asks for the free cases', async () => {
    const free = await runWith(['P3', 'P4', 'P5', 'P10'], []);
    expect(free.said).toEqual([]);
    expect(free.rows.some(entry => entry.result === 'FAIL')).toBe(false);
    expect(callsTo(fake!, '/v1/messages')).toHaveLength(0);
  });
});

function cellsOf(stdout: string, id: string): string[] {
  const line = stdout.split('\n').find(candidate => candidate.startsWith(`  ${id} `)) ?? '';
  return line.trim().split(/\s{2,}/);
}
