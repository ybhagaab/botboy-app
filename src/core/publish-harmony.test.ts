/**
 * Harmony adapter rework (dashboard-sharing plan §5, 1c′): derived app name,
 * BotBoy-owned scaffold + metadata file, first-deploy --parentBindleId,
 * prod-via-expect PTY, install-first probe, next-action failures.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  classifyHarmonyFailure,
  harmonyAppName,
  harmonyDashboardUrl,
  harmonyStaticArtifactUrl,
  installHarmonyCli,
  probeHarmony,
  publishStaticArtifactToHarmony,
  publishToHarmony,
  scaffoldHarmonyApp,
  type ExecFn,
  type HarmonySettings,
} from './publish-harmony.js';
import type { AnalyticsDashboard } from './analytics-types.js';
import { buildStaticArtifactBundle } from './publish-static-artifact.js';

const BINDLE = 'amzn1.bindle.resource.4jm6ucxzuawo46cdjhua';

let vendorDir: string;
let appRoot: string;

beforeAll(() => {
  vendorDir = mkdtempSync(path.join(os.tmpdir(), 'harmony-vendor-'));
  for (const name of ['vega.min.js', 'vega-lite.min.js', 'vega-embed.min.js', 'vega-interpreter.js']) {
    writeFileSync(path.join(vendorDir, name), `/* fixture ${name} */`);
  }
});
afterAll(() => {
  rmSync(vendorDir, { recursive: true, force: true });
});
beforeEach(() => {
  appRoot = mkdtempSync(path.join(os.tmpdir(), 'harmony-app-'));
});

function settings(overrides: Partial<HarmonySettings> = {}): HarmonySettings {
  return { bindleId: BINDLE, stage: 'beta', visibility: 'everyone', ...overrides };
}

function dash(): AnalyticsDashboard {
  return {
    id: 'dash_x',
    title: 'D',
    description: '',
    status: 'ready',
    lastRefreshedAt: '2026-09-09T00:00:00.000Z',
    widgets: [{
      id: 'w1', dashboardId: 'dash_x', kind: 'metric', title: 'N', subtitle: '',
      config: {}, result: { trust: 'external_untrusted_data', columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, refreshedAt: '2026-09-09T00:00:00.000Z' },
    }],
    recentRuns: [],
    projects: [],
  } as unknown as AnalyticsDashboard;
}

/** Scripted exec: match on command + first args, record everything. */
function scriptedExec(script: Array<{ match: (cmd: string, args: string[]) => boolean; result: { code: number; stdout?: string; stderr?: string } }>): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const hit = script.find(entry => entry.match(cmd, args));
    if (!hit) return { code: 1, stdout: '', stderr: `unscripted call: ${cmd} ${args.join(' ')}` };
    return { code: hit.result.code, stdout: hit.result.stdout ?? '', stderr: hit.result.stderr ?? '' };
  };
  return { exec, calls };
}

const cliOk = { match: (c: string, a: string[]) => c === 'harmony' && a[0] === '--version', result: { code: 0, stdout: '1.2.3' } };
const appKnown = (exists: boolean) => ({
  match: (c: string, a: string[]) => c === 'harmony' && a[0] === 'app' && a[1] === 'display-versions',
  result: exists ? { code: 0, stdout: 'v1' } : { code: 1, stderr: 'App not found' },
});
const deployOk = { match: (c: string, a: string[]) => c === 'harmony' && a[0] === 'app' && a[1] === 'deploy', result: { code: 0, stdout: 'Deployed' } };
const tarOk = { match: (c: string) => c === 'tar', result: { code: 0 } };

describe('harmony adapter (reworked)', () => {
  it('derives the app name from the alias and never accepts weird characters', () => {
    expect(harmonyAppName('YBhagaab')).toBe('ybhagaab-botboy-dashboard');
    expect(harmonyAppName('user.name+x')).toBe('user-name-x-botboy-dashboard');
    expect(harmonyAppName()).toBe(`${os.userInfo().username.toLowerCase()}-botboy-dashboard`);
  });

  it('derives SUBDOMAIN viewer URLs for every stage (new apps are subdomain-served; console path 404s — live-fire)', () => {
    expect(harmonyDashboardUrl(settings(), 'dash_x', 'me-botboy-dashboard')).toBe('https://me-botboy-dashboard.beta.harmony.a2z.com/d/dash_x/');
    expect(harmonyDashboardUrl(settings({ stage: 'gamma' }), 'dash_x', 'me-botboy-dashboard')).toBe('https://me-botboy-dashboard.gamma.harmony.a2z.com/d/dash_x/');
    expect(harmonyDashboardUrl(settings({ stage: 'prod' }), 'dash_x', 'me-botboy-dashboard')).toBe('https://me-botboy-dashboard.harmony.a2z.com/d/dash_x/');
    expect(harmonyStaticArtifactUrl(settings(), 'prime-mock', 'me-botboy-dashboard')).toBe('https://me-botboy-dashboard.beta.harmony.a2z.com/a/prime-mock/');
  });

  it('scaffolds package.json + harmony-metadata.json with the bindle id (non-interactive deploys)', () => {
    const { assetRoot } = scaffoldHarmonyApp(settings(), { appName: 'me-botboy-dashboard', appRoot });
    const metadata = JSON.parse(readFileSync(path.join(appRoot, '.harmony', 'harmony-metadata.json'), 'utf8'));
    expect(metadata.appName).toBe('me-botboy-dashboard');
    expect(metadata.bindleId).toBe(BINDLE);
    expect(metadata['content-security-policy']).toEqual({});
    // Directory paths must serve their OWN index.html (default routing = SPA fallback to root).
    expect(metadata.routes).toEqual([
      { pattern: '(\\.\\w+)$', uri: '$1' },
      { pattern: '(.+/)$', uri: '$1index.html' },
      { pattern: '(\\w+)$', uri: '$1/index.html' },
    ]);
    expect(existsSync(path.join(appRoot, 'package.json'))).toBe(true);
    expect(assetRoot).toBe(path.join(appRoot, 'src', 'me-botboy-dashboard', 'src'));
  });

  it('probe steps: install-cli → configure-bindle → ready; stale CLI Midway is flagged', async () => {
    const missing = scriptedExec([{ match: () => true, result: { code: 1, stderr: 'command not found' } }]);
    expect((await probeHarmony(settings(), missing.exec, () => true)).nextAction).toBe('install-cli');

    const noBindle = scriptedExec([cliOk]);
    expect((await probeHarmony({ stage: 'beta' } as any, noBindle.exec, () => true)).nextAction).toBe('configure-bindle');

    const ready = scriptedExec([cliOk]);
    const probe = await probeHarmony(settings(), ready.exec, () => true);
    expect(probe.nextAction).toBe('ready');
    expect(probe.cliVersion).toBe('1.2.3');
    expect(probe.midwayLive).toBe(true);

    const stale = scriptedExec([cliOk]);
    const staleProbe = await probeHarmony(settings(), stale.exec, () => false);
    expect(staleProbe.midwayLive).toBe(false);
    expect(staleProbe.detail).toContain('mwinit -o');
  });

  it('installHarmonyCli runs toolbox and verifies, with a next-action when toolbox itself is missing', async () => {
    const happy = scriptedExec([
      { match: (c, a) => c === 'harmony' && a[0] === '--version', result: { code: 1, stderr: 'ENOENT' } },
      { match: c => c === 'toolbox', result: { code: 0, stdout: 'installed' } },
    ]);
    // second harmony --version (verify) must succeed: refine script after first call
    let harmonyCalls = 0;
    const exec: ExecFn = async (cmd, args, options) => {
      if (cmd === 'harmony') {
        harmonyCalls += 1;
        return harmonyCalls === 1 ? { code: 1, stdout: '', stderr: 'ENOENT' } : { code: 0, stdout: '1.2.3', stderr: '' };
      }
      return happy.exec(cmd, args, options);
    };
    const result = await installHarmonyCli(exec);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('1.2.3');

    const noToolbox = scriptedExec([
      { match: c => c === 'harmony', result: { code: 1, stderr: 'ENOENT' } },
      { match: c => c === 'toolbox', result: { code: 1, stderr: 'toolbox: command not found' } },
    ]);
    const failed = await installHarmonyCli(noToolbox.exec);
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain('Install Amazon Toolbox');
  });

  it('first deploy carries --parentBindleId; subsequent deploys do not', async () => {
    const first = scriptedExec([cliOk, tarOk, appKnown(false), deployOk]);
    await publishToHarmony({
      settings: settings(), dashboard: dash(), snapshotCreatedAt: '2026-09-09T00:00:00.000Z',
      publishedEntries: [], vendorDir, appName: 'me-botboy-dashboard', appRoot, exec: first.exec,
    });
    const firstDeploy = first.calls.find(call => call.args[1] === 'deploy')!;
    expect(firstDeploy.args).toContain('--parentBindleId');
    expect(firstDeploy.args).toContain(BINDLE);

    const again = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    await publishToHarmony({
      settings: settings(), dashboard: dash(), snapshotCreatedAt: '2026-09-09T00:00:00.000Z',
      publishedEntries: [], vendorDir, appName: 'me-botboy-dashboard', appRoot, exec: again.exec,
    });
    const secondDeploy = again.calls.find(call => call.args[1] === 'deploy')!;
    expect(secondDeploy.args).not.toContain('--parentBindleId');
    // Assets are pre-built + self-packaged (app.tar via tar step): ALWAYS deploy with -B.
    expect(secondDeploy.args).toContain('-B');
    expect(again.calls.some(call => call.cmd === 'tar' && call.args.includes('app.tar'))).toBe(true);
  });

  it('stages static artifacts under a/<slug>/ and reuses the same deploy/viewer path', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'harmony-static-source-'));
    try {
      writeFileSync(path.join(filesRoot, 'mock.html'), '<!doctype html><style>body{color:red}</style><h1>Mock</h1><script>window.ready=true</script>');
      const bundle = buildStaticArtifactBundle({ filePath: 'mock.html', filesRoot });
      const run = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
      const audiences: string[] = [];
      const result = await publishStaticArtifactToHarmony({
        settings: settings(),
        bundle,
        appName: 'me-botboy-dashboard',
        appRoot,
        exec: run.exec,
        ensureViewerAccess: async ({ settings: current }) => { audiences.push(current.visibility); },
      });
      expect(result.url).toBe('https://me-botboy-dashboard.beta.harmony.a2z.com/a/mock/');
      expect(readFileSync(path.join(result.artifactPath, 'index.html'), 'utf8')).toContain('botboy-inline-style-1.css');
      expect(existsSync(path.join(result.artifactPath, 'botboy-inline-script-1.js'))).toBe(true);
      expect(run.calls.some(call => call.cmd === 'tar')).toBe(true);
      expect(run.calls.some(call => call.args[1] === 'deploy')).toBe(true);
      expect(audiences).toEqual(['everyone']);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('prod deploys run under /usr/bin/expect with a PTY script carrying the deploy args', async () => {
    const prod = scriptedExec([cliOk, tarOk, appKnown(true), { match: c => c === '/usr/bin/expect', result: { code: 0, stdout: 'Deployed' } }]);
    const result = await publishToHarmony({
      settings: settings({ stage: 'prod' }), dashboard: dash(), snapshotCreatedAt: '2026-09-09T00:00:00.000Z',
      publishedEntries: [], vendorDir, appName: 'me-botboy-dashboard', appRoot, exec: prod.exec,
    });
    const expectCall = prod.calls.find(call => call.cmd === '/usr/bin/expect')!;
    expect(expectCall).toBeTruthy();
    const script = readFileSync(expectCall.args[0], 'utf8');
    expect(script).toContain('spawn harmony app deploy --stage prod');
    expect(script).toContain('exit 124'); // unexpected prompt = timeout, never a guessed answer
    expect(result.url).toBe('https://me-botboy-dashboard.harmony.a2z.com/d/dash_x/');
  });

  it('runs the injected viewer-access converger after a successful deploy', async () => {
    const run = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    const seen: string[] = [];
    await publishToHarmony({
      settings: settings({ visibility: 'private' }), dashboard: dash(), snapshotCreatedAt: '2026-09-09T00:00:00.000Z',
      publishedEntries: [], vendorDir, appName: 'me-botboy-dashboard', appRoot, exec: run.exec,
      ensureViewerAccess: async ({ appName, settings: s }) => { seen.push(`${appName}:${s.visibility}`); },
    });
    expect(seen).toEqual(['me-botboy-dashboard:private']);
  });

  it('classifies failures into next actions', () => {
    expect(classifyHarmonyFailure('', 'zsh: command not found: harmony')).toContain('Install button');
    expect(classifyHarmonyFailure('', 'Error: amzn1.bindle.resource.x is not a valid non-personal bindle Id')).toContain('team bindle');
    expect(classifyHarmonyFailure('', 'Please run mwinit to refresh Midway')).toContain('mwinit -o');
    expect(classifyHarmonyFailure('Deploying to prod is not allowed in non-interactive mode', '')).toContain('PTY');
    expect(classifyHarmonyFailure('', 'weird explosion')).toContain('Harmony deploy failed');
  });
});
