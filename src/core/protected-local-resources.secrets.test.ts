import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOTBOY_CREDENTIAL_ENV_KEYS,
  modelChildEnvironment,
  modelCommandSandboxInvocation,
  resolvesIntoPrivateState,
} from './protected-local-resources.js';
import { createToolExecutor, readFileHandler } from './tool-executor.js';
import { analyticsHandlingAllowsModelContext } from './analytics-data-room-policy.js';
import { createStorage } from './storage.js';
import { createNodeManager } from './node-manager.js';

const execFileAsync = promisify(execFile);

/**
 * The Settings → AI model key lives in BotBoy private state, never in the
 * environment. Model-run commands cannot read it (Seatbelt), in-process file
 * tools cannot be steered into it through links, and BotBoy's own inference
 * credentials are removed from every model-run child environment.
 */
describe('model-run processes and BotBoy credentials', () => {
  let root: string;
  let privateRoot: string;
  let filesDir: string;
  let keyFile: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-secrets-')));
    privateRoot = path.join(root, '.personal-productivity-tracker');
    filesDir = path.join(privateRoot, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    keyFile = path.join(privateRoot, 'ai-model.json');
    fs.writeFileSync(keyFile, JSON.stringify({ provider: 'openai', apiKey: 'sk-proj-privatekey0000000000000000' }), { mode: 0o600 });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('removes exactly BotBoy inference credentials from a child environment', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/Users/owner',
      AWS_PROFILE: 'owner-profile',
      GITHUB_TOKEN: 'owner-cli-token',
      BOTBOY_INFERENCE_PROVIDER: 'gateway',
      ...Object.fromEntries(BOTBOY_CREDENTIAL_ENV_KEYS.map(key => [key, `secret-${key}`])),
    };
    const env = modelChildEnvironment({ BOTBOY_FILES: filesDir }, base);
    for (const key of BOTBOY_CREDENTIAL_ENV_KEYS) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/Users/owner',
      AWS_PROFILE: 'owner-profile',
      GITHUB_TOKEN: 'owner-cli-token',
      BOTBOY_INFERENCE_PROVIDER: 'gateway',
      BOTBOY_FILES: filesDir,
    });
    expect(BOTBOY_CREDENTIAL_ENV_KEYS).toEqual(expect.arrayContaining([
      'BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET', 'BOTBOY_INFERENCE_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK',
    ]));
  });

  it('keeps run_command and the chat terminal on the scrubbed environment', () => {
    const executor = fs.readFileSync(new URL('./tool-executor.ts', import.meta.url), 'utf8');
    const terminal = fs.readFileSync(new URL('./chat-terminal.ts', import.meta.url), 'utf8');
    expect(executor).toContain('env: modelChildEnvironment({ BOTBOY_FILES: invocation.filesDir })');
    expect(executor).not.toContain('env: { ...process.env, BOTBOY_FILES');
    expect(terminal).toContain('env: modelChildEnvironment({');
    expect(terminal).not.toContain('...(process.env as Record<string, string>)');
  });

  it('classifies link targets against the private-state boundary', () => {
    const outside = path.join(root, 'source-checkout');
    fs.mkdirSync(outside);
    fs.symlinkSync(keyFile, path.join(filesDir, 'leak.json'));
    fs.symlinkSync(outside, path.join(filesDir, 'src'));
    const boundary = { privateRoot, filesDir };
    expect(resolvesIntoPrivateState(path.join(filesDir, 'leak.json'), boundary)).toBe(true);
    expect(resolvesIntoPrivateState(keyFile, boundary)).toBe(true);
    expect(resolvesIntoPrivateState(path.join(filesDir, 'src'), boundary)).toBe(false);
    expect(resolvesIntoPrivateState(path.join(filesDir, 'report.csv'), boundary)).toBe(false);
  });

  it('refuses read_file through a link into private state but keeps source links readable', () => {
    const outside = path.join(root, 'source-checkout');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'app.js'), 'console.log("source");');
    fs.symlinkSync(keyFile, path.join(filesDir, 'leak.json'));
    fs.symlinkSync(outside, path.join(filesDir, 'src'));
    fs.writeFileSync(path.join(filesDir, 'notes.md'), 'hello');

    const leaked = readFileHandler(filesDir, { filename: 'leak.json' }, { privateRoot });
    expect(leaked).toMatch(/^Error: .*private state/);
    expect(leaked).not.toContain('privatekey');
    expect(readFileHandler(filesDir, { filename: 'src/app.js' }, { privateRoot })).toBe('console.log("source");');
    expect(readFileHandler(filesDir, { filename: 'notes.md' }, { privateRoot })).toBe('hello');
  });

  it('refuses a link whose target spells private state in another letter case', () => {
    // macOS volumes fold case, so this link opens the real key file. A
    // model-run command may create it (links only need write access to files/).
    const variantKey = keyFile.replace('.personal-productivity-tracker', '.PERSONAL-Productivity-Tracker');
    if (!fs.existsSync(variantKey)) return; // case-sensitive volume: the variant is simply absent
    fs.symlinkSync(variantKey, path.join(filesDir, 'case.json'));

    expect(resolvesIntoPrivateState(path.join(filesDir, 'case.json'), { privateRoot, filesDir })).toBe(true);
    const leaked = readFileHandler(filesDir, { filename: 'case.json' }, { privateRoot });
    expect(leaked).toMatch(/^Error: .*private state/);
    expect(leaked).not.toContain('privatekey');
  });

  it.runIf(process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec'))(
    'denies a model-run command reading the saved key (live Seatbelt)',
    async () => {
      const invocation = modelCommandSandboxInvocation(`cat "${keyFile}"`, { privateRoot, filesDir, shell: '/bin/sh' });
      const result = await execFileAsync(invocation.executable, invocation.args, {
        cwd: filesDir,
        env: modelChildEnvironment({ BOTBOY_FILES: filesDir }),
      }).then(output => ({ ok: true, output: `${output.stdout}${output.stderr}` }))
        .catch((error: any) => ({ ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/Operation not permitted/);
      expect(result.output).not.toContain('privatekey');

      // The files workspace itself stays usable.
      fs.writeFileSync(path.join(filesDir, 'ok.txt'), 'workspace');
      const allowed = modelCommandSandboxInvocation(`cat "${path.join(filesDir, 'ok.txt')}"`, { privateRoot, filesDir, shell: '/bin/sh' });
      const { stdout } = await execFileAsync(allowed.executable, allowed.args, { cwd: filesDir });
      expect(stdout).toBe('workspace');
    },
    30_000,
  );
});

describe('Data Room rows and an external model provider', () => {
  const runtime = (providerLocality: 'device_local' | 'amazon_managed_remote' | 'external_remote') => ({
    providerLocality,
    endpointSha256: 'a'.repeat(64),
  });

  it('never places rows in an external model context, even for legacy versions without a policy', () => {
    const legacy = { classification: 'internal', allowModelContext: true } as any;
    expect(analyticsHandlingAllowsModelContext(legacy, runtime('amazon_managed_remote'))).toBe(true);
    expect(analyticsHandlingAllowsModelContext(legacy, runtime('external_remote'))).toBe(false);

    const pinned = {
      classification: 'internal',
      allowModelContext: true,
      modelContextPolicy: { allowedProviderLocalities: ['amazon_managed_remote'], disclosurePolicyVersion: 'botboy-data-room-v1' },
    } as any;
    expect(analyticsHandlingAllowsModelContext(pinned, runtime('amazon_managed_remote'))).toBe(true);
    expect(analyticsHandlingAllowsModelContext(pinned, runtime('external_remote'))).toBe(false);
  });

  it('withholds dashboard widget rows from every caller once the live provider is external', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    try {
      // The runtime object is read at use time, like index.ts answerProviderReceipt.
      const live: { providerLocality: 'amazon_managed_remote' | 'external_remote'; endpointSha256: string } = runtime('amazon_managed_remote') as any;
      const dashboard = {
        id: 'dash_rows',
        widgets: [{
          id: 'widget_rows',
          result: { source: { provider: 'data-room-query', versionId: 'dsv_legacy' }, columns: ['month', 'value'], rows: [['2026-09', 5]], displayedRowCount: 1 },
        }],
      };
      // Legacy version with no pinned policy: background reads were allowed on the gateway.
      const legacyVersion = { handling: { classification: 'internal', allowModelContext: true } };
      const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
        analyticsService: { getDashboard: (id: string) => (id === 'dash_rows' ? dashboard : null) } as any,
        analyticsDataRoom: { getDatasetVersion: (id: string) => (id === 'dsv_legacy' ? legacyVersion : null) } as any,
        modelContextRuntime: live,
      });
      const read = async (callerKind: 'interactive' | 'background') => {
        const result = await executor.executeTool({
          id: `dash-${callerKind}`, type: 'function', function: { name: 'get_analytics_dashboard', arguments: JSON.stringify({ dashboardId: 'dash_rows' }) },
        }, { callerKind, currentUserMessage: 'show the dashboard' });
        return JSON.parse(result.content).widgets[0].result;
      };

      expect((await read('interactive')).rows).toEqual([['2026-09', 5]]);
      expect((await read('background')).rows).toEqual([['2026-09', 5]]);

      live.providerLocality = 'external_remote';
      for (const callerKind of ['interactive', 'background'] as const) {
        const withheld = await read(callerKind);
        expect(withheld).toMatchObject({ columns: [], rows: [], displayedRowCount: 0, truncated: true });
        expect(JSON.stringify(withheld)).not.toContain('2026-09');
      }
    } finally {
      storage.close();
    }
  });

  it('tells the model why a query was refused on the owner’s OpenAI key and what to say instead', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    try {
      const live: { providerLocality: 'amazon_managed_remote' | 'external_remote'; endpointSha256: string } = runtime('external_remote') as any;
      const denied = Object.assign(new Error('Dataset ds_rows cannot place rows in the active chat model context.'), { code: 'policy_denied' });
      const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
        analyticsDataRoomRead: { query: async () => { throw denied; } } as any,
        modelContextRuntime: live,
      });
      const query = async () => JSON.parse((await executor.executeTool({
        id: 'q1', type: 'function', function: { name: 'query_data_room', arguments: JSON.stringify({ datasets: [{ alias: 'a', datasetId: 'ds_rows' }], sql: 'SELECT * FROM a.data' }) },
      }, { callerKind: 'interactive', currentUserMessage: 'what were sales in September?' })).content);

      const external = await query();
      expect(external).toMatchObject({ code: 'policy_denied', effect: expect.anything() });
      expect(external.nextAction).toMatch(/own OpenAI key/);
      expect(external.nextAction).toMatch(/Data Room page or a local dashboard/);

      live.providerLocality = 'amazon_managed_remote';
      expect((await query()).nextAction).toMatch(/^Do not bypass the handling policy/);
    } finally {
      storage.close();
    }
  });
});
