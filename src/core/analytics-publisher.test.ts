/**
 * Publisher provider dispatch (dashboard-sharing plan §3): config round-trip,
 * single-active rule, provider-aware share requests, and token invalidation
 * when the provider or its settings change.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createDashboardPublisherService } from './analytics-publisher.js';
import { harmonyAppName } from './publish-harmony.js';
import type { AnalyticsDashboard, AnalyticsDashboardService } from './analytics-types.js';

const BINDLE = 'amzn1.bindle.resource.4jm6ucxzuawo46cdjhua';

let vendorDir: string;
beforeAll(() => {
  // renderDashboardBundle needs the Vega runtime; tests inject fixtures via
  // the service's vendorDir option (no repo or dist dependency).
  vendorDir = mkdtempSync(path.join(os.tmpdir(), 'pub-vendor-'));
  for (const name of ['vega.min.js', 'vega-lite.min.js', 'vega-embed.min.js', 'vega-interpreter.js']) {
    writeFileSync(path.join(vendorDir, name), `/* fixture ${name} */`);
  }
});
afterAll(() => {
  rmSync(vendorDir, { recursive: true, force: true });
});

function fakeAnalyticsService(dashboard: AnalyticsDashboard): AnalyticsDashboardService {
  return { getDashboard: (id: string) => (id === dashboard.id ? dashboard : null) } as unknown as AnalyticsDashboardService;
}

function dash(): AnalyticsDashboard {
  return {
    id: 'dash_pub',
    title: 'Publish Me',
    description: '',
    status: 'ready',
    lastRefreshedAt: '2026-09-08T00:00:00.000Z',
    widgets: [{
      id: 'w1', dashboardId: 'dash_pub', kind: 'metric', title: 'N', subtitle: '',
      config: {}, result: { trust: 'external_untrusted_data', columns: ['n'], rows: [[1]], rowCount: 1, truncated: false, refreshedAt: '2026-09-08T00:00:00.000Z' },
    }],
    recentRuns: [],
    projects: [],
  } as unknown as AnalyticsDashboard;
}

describe('publisher provider dispatch', () => {
  let storage: StorageLayer;
  let service: ReturnType<typeof createDashboardPublisherService>;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    // dashboard_share_requests FK references analytics_dashboards — the row must exist.
    storage.getDb().prepare("INSERT INTO analytics_dashboards (id, title, status) VALUES ('dash_pub', 'Publish Me', 'ready')").run();
    service = createDashboardPublisherService({ db: storage.getDb(), analyticsService: fakeAnalyticsService(dash()), vendorDir });
  });
  afterEach(() => storage.close());

  it('exposes all three providers; sftp is visible but unavailable', () => {
    const config = service.getConfig();
    expect(config.providers.map(p => p.id).sort()).toEqual(['harmony', 's3-cloudfront', 'sftp']);
    expect(config.providers.find(p => p.id === 'sftp')!.available).toBe(false);
    expect(config.id).toBeNull(); // nothing active on a fresh install
    expect(() => service.updateConfig({ provider: 'sftp', enabled: true } as any)).toThrow(/coming later/);
  });

  it('round-trips harmony config and enforces the single-active rule', () => {
    service.updateConfig({ provider: 's3-cloudfront', enabled: true, bucket: 'my-bucket', region: 'us-east-1', awsProfile: 'pub', cloudFrontBaseUrl: 'https://cdn.example.com' } as any);
    expect(service.getConfig().id).toBe('s3-cloudfront');

    const config = service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);
    expect(config.id).toBe('harmony');
    expect(config.harmony.bindleId).toBe(BINDLE);
    expect(config.harmony.appName).toBe(harmonyAppName()); // derived, never stored
    expect(config.harmony.visibility).toBe('everyone');
    // Enabling harmony paused S3 — exactly one active provider.
    expect(config.providers.find(p => p.id === 's3-cloudfront')!.enabled).toBe(false);
    expect(config.providers.find(p => p.id === 'harmony')!.enabled).toBe(true);
  });

  it('rejects invalid harmony settings with plain-language errors', () => {
    expect(() => service.updateConfig({ provider: 'harmony', enabled: true, bindleId: 'not-a-bindle', stage: 'beta' } as any)).toThrow(/amzn1\.bindle\.resource/);
    expect(() => service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'staging' } as any)).toThrow(/beta, gamma, or prod/);
    expect(() => service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'team' } as any)).toThrow(/everyone or private/);
    expect(() => service.updateConfig({ provider: 'harmony', enabled: true, bindleId: '', stage: 'beta' } as any)).toThrow(/team bindle ID/);
  });

  it('silently drops legacy appName/appDir keys from stored harmony config', () => {
    // Rows written by the pre-rework build carried appName/appDir; they are ignored, not fatal.
    storage.getDb().prepare("UPDATE dashboard_publishers SET config_json = ? WHERE id = 'harmony'")
      .run(JSON.stringify({ appName: 'old-app', appDir: '/tmp/old', stage: 'gamma' }));
    const config = service.getConfig();
    expect(config.harmony.stage).toBe('gamma');
    expect(config.harmony.bindleId).toBe('');
    expect(config.harmony.appName).toBe(harmonyAppName());
    expect(config.providers.find(p => p.id === 'harmony')!.configured).toBe(false); // no bindle yet
  });

  it('harmony share requests carry the derived app destination, audience disclosure, and bundle identity', () => {
    service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);
    const request = service.createShareRequest('dash_pub');
    expect(request.destination).toContain(`Harmony app "${harmonyAppName()}" (beta)`);
    expect(request.destination).toContain(`https://${harmonyAppName()}.beta.harmony.a2z.com/d/dash_pub/`);
    expect(request.warning).toContain('ANY Midway-authenticated Amazon employee');
    expect(request.objectKey).toBe('d/dash_pub/');
    expect(request.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('private visibility rewrites the share warning to only-you plus the classic-path caveat', () => {
    service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'private' } as any);
    const request = service.createShareRequest('dash_pub');
    expect(request.warning).toContain('ONLY YOU');
    expect(request.warning).toContain('classic console.harmony.a2z.com');
  });

  it('a pending confirmation dies when the provider settings change (config-hash binding)', async () => {
    service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);
    const request = service.createShareRequest('dash_pub');
    // Flipping ONLY the visibility toggle must kill pending confirmations too.
    service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'private' } as any);
    await expect(service.publish('dash_pub', request.confirmationToken)).rejects.toThrow(/settings changed/);
  });

  it('static artifact dry-run is non-publishing, CSP-safe, and bound to app-wide visibility', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-static-files-'));
    try {
      writeFileSync(path.join(filesRoot, 'mock.html'), '<!doctype html><style>body{color:red}</style><h1>Mock</h1><script>window.ready=true</script>');
      const staticService = createDashboardPublisherService({
        db: storage.getDb(),
        analyticsService: fakeAnalyticsService(dash()),
        vendorDir,
        staticFilesRoot: filesRoot,
      });
      staticService.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);
      const result = await staticService.publishStaticArtifact({
        filePath: 'mock.html',
        dryRun: true,
      });
      expect(result).toMatchObject({ published: false, dryRun: true, outcome: 'dry_run', phase: 'prepared', visibility: 'everyone' });
      expect(result.url).toBe(`https://${harmonyAppName()}.beta.harmony.a2z.com/a/mock/`);
      expect(result.files.map(file => file.relativePath)).toEqual([
        'botboy-inline-script-1.js',
        'botboy-inline-style-1.css',
        'index.html',
      ]);
      expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

      await expect(staticService.publishStaticArtifact({
        filePath: 'mock.html', visibility: 'private', dryRun: true,
      })).rejects.toThrow(/does not match.*app-wide/i);
      await expect(staticService.publishStaticArtifact({
        filePath: 'mock.html', visibility: 'everyone',
      })).rejects.toThrow(/ownerRequested must be true/);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('persists deployed partial state and resumes convergence without redeploying', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-static-resume-'));
    try {
      writeFileSync(path.join(filesRoot, 'mock.html'), '<!doctype html><h1>Mock</h1>');
      let deployCalls = 0;
      let accessCalls = 0;
      let verifyCalls = 0;
      const staticService = createDashboardPublisherService({
        db: storage.getDb(),
        analyticsService: fakeAnalyticsService(dash()),
        vendorDir,
        staticFilesRoot: filesRoot,
        staticPublishAdapter: async ({ settings, bundle }) => {
          deployCalls += 1;
          return {
            url: `https://${harmonyAppName()}.${settings.stage}.harmony.a2z.com/a/${bundle.slug}/`,
            appName: harmonyAppName(),
            artifactPath: '/tmp/mock',
            deploy: { appName: harmonyAppName(), stage: settings.stage, appExisted: true, deployedAt: '2026-09-10T00:00:00.000Z' },
          };
        },
        harmonyHooks: {
          provision: async () => { throw new Error('unused'); },
          ensureViewerAccess: async ({ settings }) => {
            accessCalls += 1;
            if (accessCalls === 1) throw new Error('viewer-access: transient fetch');
            return { resourceId: 'resource_1', owningTeamId: 'team_1', visibility: settings.visibility, changed: false, verified: true };
          },
          verifyStaticArtifact: async ({ files }) => {
            verifyCalls += 1;
            return { verified: true, files: files.map(file => ({ ...file, status: 200, responseUrl: `https://example/${file.relativePath}` })) };
          },
        },
      });
      staticService.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);

      const partial = await staticService.publishStaticArtifact({ filePath: 'mock.html', ownerRequested: true });
      expect(partial).toMatchObject({ ok: false, outcome: 'partial', deployed: true, published: false, visibilityConverged: false, phase: 'failed_after_deploy' });
      expect(partial.attemptId).toMatch(/^static_/);
      expect(partial.nextAction).toContain('without redeploying');
      expect(deployCalls).toBe(1);
      expect(verifyCalls).toBe(0);

      const completed = await staticService.publishStaticArtifact({
        filePath: 'mock.html', ownerRequested: true, resumeAttemptId: partial.attemptId,
      });
      expect(completed).toMatchObject({ ok: true, outcome: 'complete', deployed: true, published: true, visibilityConverged: true, contentVerified: true, resourceId: 'resource_1' });
      expect(deployCalls).toBe(1);
      expect(accessCalls).toBe(2);
      expect(verifyCalls).toBe(1);
      expect(staticService.listStaticArtifactAttempts(1)[0].attemptId).toBe(partial.attemptId);

      const idempotent = await staticService.publishStaticArtifact({ filePath: 'mock.html', ownerRequested: true });
      expect(idempotent.published).toBe(true);
      expect(deployCalls).toBe(1);
      expect(accessCalls).toBe(2);
      expect(verifyCalls).toBe(1);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('verifyExisting certifies and persists a pre-ledger route without calling deploy', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-static-adopt-'));
    try {
      writeFileSync(path.join(filesRoot, 'existing.html'), '<!doctype html><h1>Existing</h1>');
      let deployCalls = 0;
      const staticService = createDashboardPublisherService({
        db: storage.getDb(),
        analyticsService: fakeAnalyticsService(dash()),
        staticFilesRoot: filesRoot,
        staticPublishAdapter: async () => { deployCalls += 1; throw new Error('must not deploy'); },
        harmonyHooks: {
          provision: async () => { throw new Error('unused'); },
          ensureViewerAccess: async ({ settings }) => ({ resourceId: 'resource_existing', owningTeamId: 'team_1', visibility: settings.visibility, changed: false, verified: true }),
          verifyStaticArtifact: async ({ files }) => ({ verified: true, files: files.map(file => ({ ...file, status: 200, responseUrl: `https://example/${file.relativePath}` })) }),
        },
      });
      staticService.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);
      const result = await staticService.publishStaticArtifact({ filePath: 'existing.html', ownerRequested: true, verifyExisting: true });
      expect(result).toMatchObject({ published: true, deployed: true, contentVerified: true, visibilityConverged: true, resourceId: 'resource_existing' });
      expect(deployCalls).toBe(0);
      expect(staticService.listStaticArtifactAttempts(1)[0].attemptId).toBe(result.attemptId);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('legacy S3 updates without a provider field still work (back-compat)', () => {
    const config = service.updateConfig({ enabled: true, bucket: 'legacy-bucket', region: 'us-east-1', awsProfile: 'pub', cloudFrontBaseUrl: 'https://cdn.example.com' } as any);
    expect(config.id).toBe('s3-cloudfront');
    expect(config.s3.bucket).toBe('legacy-bucket');
  });
});
