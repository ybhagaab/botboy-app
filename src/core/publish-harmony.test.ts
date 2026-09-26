/**
 * Harmony adapter rework (dashboard-sharing plan §5, 1c′): derived app name,
 * BotBoy-owned scaffold + metadata file, first-deploy --parentBindleId,
 * prod-via-expect PTY, install-first probe, next-action failures.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  renderHarmonyDashboardListing,
  scaffoldHarmonyApp,
  type ExecFn,
  type HarmonySettings,
} from './publish-harmony.js';
import type { AnalyticsDashboard } from './analytics-types.js';
import { renderDashboardBundle } from './publish-bundle.js';
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

function dashboardBundle() {
  return renderDashboardBundle(dash(), '2026-09-09T00:00:00.000Z', { vendorDir });
}

function dashboardListing() {
  return renderHarmonyDashboardListing([]);
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
      settings: settings(), dashboardId: 'dash_x', bundle: dashboardBundle(),
      listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot, exec: first.exec,
    });
    const firstDeploy = first.calls.find(call => call.args[1] === 'deploy')!;
    expect(firstDeploy.args).toContain('--parentBindleId');
    expect(firstDeploy.args).toContain(BINDLE);

    const again = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    await publishToHarmony({
      settings: settings(), dashboardId: 'dash_x', bundle: dashboardBundle(),
      listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot, exec: again.exec,
    });
    const secondDeploy = again.calls.find(call => call.args[1] === 'deploy')!;
    expect(secondDeploy.args).not.toContain('--parentBindleId');
    // Assets are pre-built + self-packaged (app.tar via tar step): ALWAYS deploy with -B.
    expect(secondDeploy.args).toContain('-B');
    expect(again.calls.some(call => call.cmd === 'tar' && call.args.includes('app.tar'))).toBe(true);
  });

  it('stages static artifacts under a/<slug>/ and returns a deploy-phase receipt before convergence', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'harmony-static-source-'));
    try {
      writeFileSync(path.join(filesRoot, 'mock.html'), '<!doctype html><style>body{color:red}</style><h1>Mock</h1><script>window.ready=true</script>');
      const bundle = buildStaticArtifactBundle({ filePath: 'mock.html', filesRoot });
      const run = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
      const result = await publishStaticArtifactToHarmony({
        settings: settings(),
        bundle,
        appName: 'me-botboy-dashboard',
        appRoot,
        exec: run.exec,
      });
      expect(result.url).toBe('https://me-botboy-dashboard.beta.harmony.a2z.com/a/mock/');
      expect(readFileSync(path.join(result.artifactPath, 'index.html'), 'utf8')).toContain('botboy-inline-style-1.css');
      expect(existsSync(path.join(result.artifactPath, 'botboy-inline-script-1.js'))).toBe(true);
      expect(run.calls.some(call => call.cmd === 'tar')).toBe(true);
      expect(run.calls.some(call => call.args[1] === 'deploy')).toBe(true);
      expect(result.deploy).toMatchObject({ appName: 'me-botboy-dashboard', stage: 'beta', appExisted: true });
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('discards a failed static-artifact candidate before it reaches the canonical app tree', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'harmony-static-failed-source-'));
    try {
      writeFileSync(path.join(filesRoot, 'failed.html'), '<!doctype html><h1>Must not persist</h1>');
      const bundle = buildStaticArtifactBundle({ filePath: 'failed.html', filesRoot });
      const run = scriptedExec([
        cliOk,
        tarOk,
        appKnown(true),
        { match: (c, a) => c === 'harmony' && a[0] === 'app' && a[1] === 'deploy', result: { code: 1, stderr: 'synthetic deploy rejection' } },
      ]);
      await expect(publishStaticArtifactToHarmony({
        settings: settings(), bundle, appName: 'me-botboy-dashboard', appRoot, exec: run.exec,
      })).rejects.toThrow(/synthetic deploy rejection|Harmony deploy failed/);
      expect(existsSync(path.join(appRoot, 'src', 'me-botboy-dashboard', 'src', 'a', 'failed'))).toBe(false);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('prod deploys run under /usr/bin/expect with a PTY script carrying the deploy args', async () => {
    const prod = scriptedExec([cliOk, tarOk, appKnown(true), { match: c => c === '/usr/bin/expect', result: { code: 0, stdout: 'Deployed' } }]);
    let script = '';
    const exec: ExecFn = async (command, args, options) => {
      if (command === '/usr/bin/expect') script = readFileSync(args[0], 'utf8');
      return prod.exec(command, args, options);
    };
    const result = await publishToHarmony({
      settings: settings({ stage: 'prod' }), dashboardId: 'dash_x', bundle: dashboardBundle(),
      listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot, exec,
    });
    const expectCall = prod.calls.find(call => call.cmd === '/usr/bin/expect')!;
    expect(expectCall).toBeTruthy();
    expect(script).toContain('spawn harmony app deploy --stage prod');
    expect(script).toContain('exit 124'); // unexpected prompt = timeout, never a guessed answer
    expect(result.url).toBe('https://me-botboy-dashboard.harmony.a2z.com/d/dash_x/');
  });

  it('restricts an existing private app before deploy and converges a deny-by-default first deploy afterward', async () => {
    const existingRun = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    const existingOrder: string[] = [];
    const existingExec: ExecFn = async (command, args, options) => {
      if (command === 'harmony' && args[0] === 'app' && args[1] === 'deploy') existingOrder.push('deploy');
      return existingRun.exec(command, args, options);
    };
    const existing = await publishToHarmony({
      settings: settings({ visibility: 'private' }), dashboardId: 'dash_x', bundle: dashboardBundle(),
      listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot, exec: existingExec,
      ensureViewerAccess: async () => { existingOrder.push('access'); },
    });
    expect(existingOrder).toEqual(['access', 'deploy']);
    expect(existing.visibilityConverged).toBe(true);

    const firstRoot = mkdtempSync(path.join(os.tmpdir(), 'harmony-first-private-'));
    const firstRun = scriptedExec([cliOk, tarOk, appKnown(false), deployOk]);
    const firstOrder: string[] = [];
    const firstExec: ExecFn = async (command, args, options) => {
      if (command === 'harmony' && args[0] === 'app' && args[1] === 'deploy') firstOrder.push('deploy');
      return firstRun.exec(command, args, options);
    };
    try {
      const first = await publishToHarmony({
        settings: settings({ visibility: 'private' }), dashboardId: 'dash_x', bundle: dashboardBundle(),
        listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot: firstRoot, exec: firstExec,
        ensureViewerAccess: async () => { firstOrder.push('access'); },
      });
      expect(firstOrder).toEqual(['deploy', 'access']);
      expect(first.deploy.appExisted).toBe(false);
      expect(first.visibilityConverged).toBe(true);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
    }
  });

  it('reports whether viewer convergence failed before or after provider deployment', async () => {
    const postRun = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    await expect(publishToHarmony({
      settings: settings({ visibility: 'everyone' }), dashboardId: 'dash_x', bundle: dashboardBundle(),
      listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot, exec: postRun.exec,
      ensureViewerAccess: async () => { throw new Error('synthetic access failure'); },
    })).rejects.toMatchObject({ deployed: true, visibilityConverged: false });
    expect(postRun.calls.some(call => call.args[1] === 'deploy')).toBe(true);

    const preRoot = mkdtempSync(path.join(os.tmpdir(), 'harmony-existing-private-fail-'));
    const preRun = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    try {
      await expect(publishToHarmony({
        settings: settings({ visibility: 'private' }), dashboardId: 'dash_x', bundle: dashboardBundle(),
        listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot: preRoot, exec: preRun.exec,
        ensureViewerAccess: async () => { throw new Error('synthetic restriction failure'); },
      })).rejects.toThrow(/synthetic restriction failure/);
      expect(preRun.calls.some(call => call.args[1] === 'deploy')).toBe(false);
    } finally {
      rmSync(preRoot, { recursive: true, force: true });
    }
  });

  it('discards a failed pre-deploy candidate so it cannot hitchhike on the next deploy', async () => {
    const failed = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    await expect(publishToHarmony({
      settings: settings({ visibility: 'private' }), dashboardId: 'dash_failed', bundle: dashboardBundle(),
      listingHtml: renderHarmonyDashboardListing([{ dashboardId: 'dash_failed', title: 'Failed', description: '', publishedAt: '2026-09-09T00:00:00.000Z' }]),
      appName: 'me-botboy-dashboard', appRoot, exec: failed.exec,
      ensureViewerAccess: async () => { throw new Error('synthetic pre-deploy denial'); },
    })).rejects.toThrow(/synthetic pre-deploy denial/);
    const canonicalAssets = path.join(appRoot, 'src', 'me-botboy-dashboard', 'src');
    expect(existsSync(path.join(canonicalAssets, 'd', 'dash_failed'))).toBe(false);

    const next = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    await publishToHarmony({
      settings: settings({ visibility: 'everyone' }), dashboardId: 'dash_next', bundle: dashboardBundle(),
      listingHtml: renderHarmonyDashboardListing([{ dashboardId: 'dash_next', title: 'Next', description: '', publishedAt: '2026-09-09T00:01:00.000Z' }]),
      appName: 'me-botboy-dashboard', appRoot, exec: next.exec,
      ensureViewerAccess: async () => {},
    });
    expect(existsSync(path.join(canonicalAssets, 'd', 'dash_next'))).toBe(true);
    expect(existsSync(path.join(canonicalAssets, 'd', 'dash_failed'))).toBe(false);
    expect(readFileSync(path.join(canonicalAssets, 'index.html'), 'utf8')).not.toContain('dash_failed');
  });

  it('restores a marker-backed canonical mirror before allowing another whole-app deploy', async () => {
    const base = path.basename(appRoot);
    const parent = path.dirname(appRoot);
    const backupRoot = `${appRoot}.previous-synthetic-recovery`;
    const staleContainer = path.join(parent, `.${base}-candidate-synthetic-recovery`);
    rmSync(appRoot, { recursive: true, force: true });
    const priorPath = path.join(backupRoot, 'src', 'me-botboy-dashboard', 'src', 'd', 'prior', 'index.html');
    mkdirSync(path.dirname(priorPath), { recursive: true });
    writeFileSync(priorPath, '<!doctype html><h1>Prior route</h1>');
    mkdirSync(path.join(staleContainer, base), { recursive: true });
    writeFileSync(`${appRoot}.botboy-recovery.json`, JSON.stringify({
      version: 1,
      canonicalRoot: appRoot,
      backupRoot,
      candidateContainer: staleContainer,
    }));

    const next = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    await publishToHarmony({
      settings: settings({ visibility: 'everyone' }), dashboardId: 'dash_after_recovery', bundle: dashboardBundle(),
      listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot, exec: next.exec,
      ensureViewerAccess: async () => {},
    });
    expect(readFileSync(path.join(appRoot, 'src', 'me-botboy-dashboard', 'src', 'd', 'prior', 'index.html'), 'utf8'))
      .toContain('Prior route');
    expect(existsSync(path.join(appRoot, 'src', 'me-botboy-dashboard', 'src', 'd', 'dash_after_recovery'))).toBe(true);
    expect(existsSync(`${appRoot}.botboy-recovery.json`)).toBe(false);
    expect(existsSync(staleContainer)).toBe(false);
  });

  it('refuses an empty-tree deploy when a recovery marker has no valid backup', async () => {
    const base = path.basename(appRoot);
    const parent = path.dirname(appRoot);
    const missingBackup = `${appRoot}.previous-missing`;
    const staleContainer = path.join(parent, `.${base}-candidate-missing`);
    rmSync(appRoot, { recursive: true, force: true });
    mkdirSync(staleContainer, { recursive: true });
    writeFileSync(`${appRoot}.botboy-recovery.json`, JSON.stringify({
      version: 1,
      canonicalRoot: appRoot,
      backupRoot: missingBackup,
      candidateContainer: staleContainer,
    }));
    const run = scriptedExec([cliOk, tarOk, appKnown(true), deployOk]);
    await expect(publishToHarmony({
      settings: settings(), dashboardId: 'must_not_deploy', bundle: dashboardBundle(),
      listingHtml: dashboardListing(), appName: 'me-botboy-dashboard', appRoot, exec: run.exec,
    })).rejects.toThrow(/backup is missing|refusing an empty-tree deploy/i);
    expect(run.calls).toHaveLength(0);
    rmSync(`${appRoot}.botboy-recovery.json`, { force: true });
    rmSync(staleContainer, { recursive: true, force: true });
  });

  it('classifies failures into next actions', () => {
    expect(classifyHarmonyFailure('', 'zsh: command not found: harmony')).toContain('Install button');
    expect(classifyHarmonyFailure('', 'Error: amzn1.bindle.resource.x is not a valid non-personal bindle Id')).toContain('team bindle');
    expect(classifyHarmonyFailure('', 'Please run mwinit to refresh Midway')).toContain('mwinit -o');
    expect(classifyHarmonyFailure('Deploying to prod is not allowed in non-interactive mode', '')).toContain('PTY');
    expect(classifyHarmonyFailure('', 'weird explosion')).toContain('Harmony deploy failed');
  });
});
