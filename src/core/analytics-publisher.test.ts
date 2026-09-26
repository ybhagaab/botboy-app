/**
 * Publisher provider dispatch (dashboard-sharing plan §3): config round-trip,
 * single-active rule, provider-aware share requests, and token invalidation
 * when the provider or its settings change.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import {
  createDashboardPublisherService,
  DashboardPublicationError,
  type DashboardPublishAdapter,
  type DashboardPublishAdapterInput,
} from './analytics-publisher.js';
import { HarmonyDashboardPublishError, harmonyAppName } from './publish-harmony.js';
import { SNAPSHOT_CSS } from './snapshot-render.js';
import type {
  AnalyticsDashboard,
  AnalyticsDashboardService,
  AnalyticsWidget,
  DashboardPublicationDataRoomIdentityV1,
} from './analytics-types.js';
import type { AnalyticsDashboardDataRoomBridge } from './analytics-dashboard-data-room.js';

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

  it('keeps identical Harmony bundles from different canonical source paths separate and rejects cross-source resume', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-static-source-identity-'));
    try {
      mkdirSync(path.join(filesRoot, 'a'));
      mkdirSync(path.join(filesRoot, 'b'));
      writeFileSync(path.join(filesRoot, 'a', 'demo.html'), '<!doctype html><h1>Same</h1>');
      writeFileSync(path.join(filesRoot, 'b', 'demo.html'), '<!doctype html><h1>Same</h1>');
      let deployCalls = 0;
      const staticService = createDashboardPublisherService({
        db: storage.getDb(), analyticsService: fakeAnalyticsService(dash()), staticFilesRoot: filesRoot,
        staticPublishAdapter: async ({ settings, bundle }) => {
          deployCalls += 1;
          return { url: `https://${harmonyAppName()}.${settings.stage}.harmony.a2z.com/a/${bundle.slug}/`, appName: harmonyAppName(), artifactPath: '/tmp/demo', deploy: { appName: harmonyAppName(), stage: settings.stage, appExisted: true, deployedAt: new Date().toISOString() } };
        },
        harmonyHooks: {
          provision: async () => { throw new Error('unused'); },
          ensureViewerAccess: async ({ settings }) => ({ resourceId: 'resource', owningTeamId: 'team', visibility: settings.visibility, changed: false, verified: true }),
          verifyStaticArtifact: async ({ files }) => ({ verified: true, files: files.map(file => ({ ...file, status: 200, responseUrl: `https://example/${file.relativePath}` })) }),
        },
      });
      staticService.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);
      const first = await staticService.publishStaticArtifact({ filePath: 'a/demo.html', ownerRequested: true });
      const second = await staticService.publishStaticArtifact({ filePath: 'b/demo.html', ownerRequested: true });
      expect(first.attemptId).not.toBe(second.attemptId);
      expect(first.sourcePath).toBe(realpathSync(path.join(filesRoot, 'a', 'demo.html')));
      expect(second.sourcePath).toBe(realpathSync(path.join(filesRoot, 'b', 'demo.html')));
      expect(deployCalls).toBe(2);
      await expect(staticService.publishStaticArtifact({ filePath: 'b/demo.html', ownerRequested: true, resumeAttemptId: first.attemptId })).rejects.toThrow(/does not match/);
    } finally {
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('verifyExisting certifies and persists a pre-ledger route without calling deploy', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-static-adopt-'));
    try {
      writeFileSync(path.join(filesRoot, 'existing.html'), '<!doctype html><h1>Existing</h1>');
      let deployCalls = 0;
      let mirrorCalls = 0;
      const staticService = createDashboardPublisherService({
        db: storage.getDb(),
        analyticsService: fakeAnalyticsService(dash()),
        staticFilesRoot: filesRoot,
        staticMirrorAdapter: ({ bundle }) => {
          mirrorCalls += 1;
          return { appName: harmonyAppName(), artifactPath: `/tmp/${bundle.slug}` };
        },
        staticPublishAdapter: async () => { deployCalls += 1; throw new Error('must not deploy'); },
        harmonyHooks: {
          provision: async () => { throw new Error('unused'); },
          ensureViewerAccess: async ({ settings }) => ({ resourceId: 'resource_existing', owningTeamId: 'team_1', visibility: settings.visibility, changed: false, verified: true }),
          verifyStaticArtifact: async ({ files }) => ({ verified: true, files: files.map(file => ({ ...file, status: 200, responseUrl: `https://example/${file.relativePath}` })) }),
        },
      });
      staticService.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'everyone' } as any);
      const result = await staticService.publishStaticArtifact({ filePath: 'existing.html', ownerRequested: true, verifyExisting: true });
      expect(result).toMatchObject({
        published: true, deployed: true, contentVerified: true, visibilityConverged: true,
        canonicalMirrorSynchronized: true, resourceId: 'resource_existing',
      });
      expect(deployCalls).toBe(0);
      expect(mirrorCalls).toBe(1);
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

const PROVENANCE_SHA = {
  binding: '1'.repeat(64),
  controlDefinition: '2'.repeat(64),
  controlValues: '3'.repeat(64),
  view: '4'.repeat(64),
  request: '5'.repeat(64),
  query: '6'.repeat(64),
  content: '7'.repeat(64),
  schema: '8'.repeat(64),
  contract: '9'.repeat(64),
  definition: 'a'.repeat(64),
  semantic: 'b'.repeat(64),
};

function publicationIdentity(): DashboardPublicationDataRoomIdentityV1 {
  return {
    datasetId: 'ds_publication_fixture',
    datasetDefinitionRevision: 2,
    bindingRevision: 1,
    bindingSha256: PROVENANCE_SHA.binding,
    versionPolicy: 'latest_compatible',
    lastAppliedVersionId: 'dsv_publication_fixture_1',
    head: { versionId: 'dsv_publication_fixture_1', headRevision: 1, definitionRevision: 2 },
    control: {
      revision: 1,
      projected: false,
      definitionSha256: PROVENANCE_SHA.controlDefinition,
      valuesSha256: PROVENANCE_SHA.controlValues,
      effectiveViewRequestSha256: PROVENANCE_SHA.view,
    },
    versionId: 'dsv_publication_fixture_1',
    requestSha256: PROVENANCE_SHA.request,
    querySha256: PROVENANCE_SHA.query,
    compilerVersion: 'sqlite-dashboard-view-v1',
    contentSha256: PROVENANCE_SHA.content,
    schemaSha256: PROVENANCE_SHA.schema,
    contractSha256: PROVENANCE_SHA.contract,
    definitionSha256: PROVENANCE_SHA.definition,
    semanticReceiptSha256: PROVENANCE_SHA.semantic,
  };
}

function publicationDashboard(): AnalyticsDashboard {
  const widget = {
    id: 'widget_publication_fixture',
    dashboardId: 'dash_publication_fixture',
    position: 0,
    revision: 1,
    bindingRevision: 1,
    kind: 'table',
    title: 'Published data',
    subtitle: '',
    config: {},
    binding: { datasetId: 'ds_publication_fixture' },
    result: {
      trust: 'local_verified_data',
      columns: ['value'],
      rows: [[1]],
      rowCount: 1,
      displayedRowCount: 1,
      truncated: false,
      refreshedAt: '2026-09-21T12:00:00.000Z',
    },
    createdAt: '2026-09-21T11:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  } as unknown as AnalyticsWidget;
  return {
    id: 'dash_publication_fixture',
    title: 'Publication fixture',
    description: 'Exact provenance fixture',
    theme: 'system',
    status: 'ready',
    lastRefreshedAt: '2026-09-21T12:00:00.000Z',
    widgets: [widget],
    recentRuns: [],
    projects: [],
    createdAt: '2026-09-21T11:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  } as AnalyticsDashboard;
}

function publicationFixture(options: {
  provider?: 'harmony' | 's3-cloudfront';
  adapter?: DashboardPublishAdapter;
  additionalDashboards?: AnalyticsDashboard[];
  staticFilesRoot?: string;
  staticPublishAdapter?: NonNullable<Parameters<typeof createDashboardPublisherService>[0]['staticPublishAdapter']>;
  staticMirrorAdapter?: NonNullable<Parameters<typeof createDashboardPublisherService>[0]['staticMirrorAdapter']>;
  harmonyHooks?: NonNullable<Parameters<typeof createDashboardPublisherService>[0]['harmonyHooks']>;
  harmonyDashboardPublishAdapter?: NonNullable<Parameters<typeof createDashboardPublisherService>[0]['harmonyDashboardPublishAdapter']>;
  s3ClientFactory?: NonNullable<Parameters<typeof createDashboardPublisherService>[0]['s3ClientFactory']>;
  useCompleteAdapter?: boolean;
} = {}) {
  const testStorage = createStorage(':memory:');
  testStorage.initialize();
  const db = testStorage.getDb();
  db.prepare("INSERT INTO analytics_dashboards (id, title, status) VALUES ('dash_publication_fixture', 'Publication fixture', 'ready')").run();
  const dashboard = publicationDashboard();
  const dashboards = [dashboard, ...(options.additionalDashboards ?? [])];
  for (const additional of options.additionalDashboards ?? []) {
    db.prepare('INSERT INTO analytics_dashboards (id, title, status) VALUES (?, ?, ?)')
      .run(additional.id, additional.title, additional.status);
  }
  const identity = publicationIdentity();
  const calls: DashboardPublishAdapterInput[] = [];
  const dataRoom = {
    validatePublicationResult: () => structuredClone(identity),
  } as unknown as AnalyticsDashboardDataRoomBridge;
  const service = createDashboardPublisherService({
    db,
    analyticsService: {
      getDashboard: (id: string) => dashboards.find(value => value.id === id) ?? null,
    } as unknown as AnalyticsDashboardService,
    dataRoom,
    vendorDir,
    ...(options.staticFilesRoot ? { staticFilesRoot: options.staticFilesRoot } : {}),
    ...(options.staticPublishAdapter ? { staticPublishAdapter: options.staticPublishAdapter } : {}),
    ...(options.staticMirrorAdapter ? { staticMirrorAdapter: options.staticMirrorAdapter } : {}),
    ...(options.harmonyHooks ? { harmonyHooks: options.harmonyHooks } : {}),
    ...(options.harmonyDashboardPublishAdapter ? { harmonyDashboardPublishAdapter: options.harmonyDashboardPublishAdapter } : {}),
    ...(options.s3ClientFactory ? { s3ClientFactory: options.s3ClientFactory } : {}),
    ...(options.useCompleteAdapter === false ? {} : {
      dashboardPublishAdapter: options.adapter ?? (async (input: DashboardPublishAdapterInput) => {
        calls.push(input);
        return { deployed: true as const, contentVerified: true as const, visibilityConverged: true as const };
      }),
    }),
  });
  if (options.provider === 's3-cloudfront') {
    service.updateConfig({
      provider: 's3-cloudfront', enabled: true, bucket: 'fixture-bucket', region: 'us-east-1',
      awsProfile: 'fixture-read-write', cloudFrontBaseUrl: 'https://fixture.example.com',
    } as any);
  } else {
    service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'beta', visibility: 'private' } as any);
  }
  return { storage: testStorage, db, dashboard, identity, calls, service };
}

describe('R5.5 exact dashboard publication provenance', () => {
  it.each(['harmony', 's3-cloudfront'] as const)(
    'dispatches one exact prebuilt %s artifact, persists one receipt, and consumes the token once',
    async provider => {
      const fixture = publicationFixture({ provider });
      try {
        const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
        expect(prepared.receipt.snapshotManifestSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(prepared.receipt.artifactContentSha256).toBe(prepared.contentSha256);
        expect(prepared.receipt.snapshot.widgets[0].dataRoom).toEqual(fixture.identity);
        const result = await fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken);

        expect(fixture.calls).toHaveLength(1);
        const dispatched = fixture.calls[0];
        expect(dispatched.provider).toBe(provider);
        expect(dispatched.dashboardId).toBe(fixture.dashboard.id);
        if (dispatched.artifact.provider === 'harmony') {
          const digest = (value: string) => createHash('sha256').update(value).digest('hex');
          expect(dispatched.artifact.listingHtml).toContain('Publication fixture');
          expect(digest(JSON.stringify({
            version: 1,
            dashboardBundleManifestSha256: dispatched.artifact.bundle.manifestSha256,
            listingHtmlSha256: digest(dispatched.artifact.listingHtml),
            rootStyleSha256: digest(SNAPSHOT_CSS),
          }))).toBe(prepared.receipt.artifactContentSha256);
        } else {
          const digest = createHash('sha256').update(dispatched.artifact.html).digest('hex');
          expect(digest).toBe(prepared.receipt.artifactContentSha256);
        }
        expect(result.publication).toMatchObject({
          deployed: true,
          contentVerified: true,
          visibilityConverged: true,
          shareRequestId: prepared.confirmationToken.split('.')[1],
        });
        expect(result.publication.receipt).toEqual(prepared.receipt);
        expect(result.publication.contentSha256).toBe(prepared.contentSha256);

        const requestRow = fixture.db.prepare('SELECT * FROM dashboard_share_requests').get() as any;
        const publicationRow = fixture.db.prepare('SELECT * FROM dashboard_publications').get() as any;
        expect(requestRow.used_at).not.toBeNull();
        expect(publicationRow).toMatchObject({
          status: 'published',
          share_request_id: requestRow.id,
          deployed: 1,
          content_verified: 1,
          visibility_converged: 1,
          content_sha256: prepared.receipt.artifactContentSha256,
          config_sha256: prepared.receipt.publisherConfigSha256,
          manifest_sha256: prepared.receipt.snapshotManifestSha256,
        });
        expect(JSON.parse(publicationRow.manifest_json)).toEqual(prepared.receipt.snapshot);

        await expect(fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken))
          .rejects.toMatchObject({ code: 'invalid_confirmation' });
        expect(fixture.calls).toHaveLength(1);
        fixture.service.createShareRequest(fixture.dashboard.id);
        expect(fixture.db.prepare('SELECT used_at FROM dashboard_share_requests WHERE id = ?').get(requestRow.id))
          .toEqual({ used_at: expect.any(String) });
      } finally {
        fixture.storage.close();
      }
    },
  );

  const driftCases: Array<{
    name: string;
    scope: string;
    mutate: (fixture: ReturnType<typeof publicationFixture>) => void;
  }> = [
    { name: 'dashboard presentation', scope: 'dashboard', mutate: fixture => { fixture.dashboard.title = 'Changed title'; } },
    { name: 'widget presentation', scope: 'widget', mutate: fixture => { fixture.dashboard.widgets[0].revision += 1; } },
    { name: 'displayed result', scope: 'result', mutate: fixture => { fixture.dashboard.widgets[0].result!.rows = [[2]]; } },
    { name: 'binding', scope: 'binding', mutate: fixture => { fixture.identity.bindingRevision += 1; } },
    { name: 'control', scope: 'control', mutate: fixture => { fixture.identity.control.valuesSha256 = 'c'.repeat(64); } },
    { name: 'dataset head', scope: 'dataset_head', mutate: fixture => { fixture.identity.head.headRevision += 1; } },
    { name: 'dataset version/query', scope: 'dataset_version', mutate: fixture => { fixture.identity.querySha256 = 'd'.repeat(64); } },
    { name: 'semantic receipt', scope: 'semantic_receipt', mutate: fixture => { fixture.identity.semanticReceiptSha256 = 'e'.repeat(64); } },
    { name: 'provider artifact only', scope: 'artifact', mutate: fixture => { fixture.dashboard.lastRefreshedAt = '2026-09-21T12:01:00.000Z'; } },
    {
      name: 'publisher config', scope: 'publisher_config', mutate: fixture => {
        fixture.service.updateConfig({ provider: 'harmony', enabled: true, bindleId: BINDLE, stage: 'gamma', visibility: 'private' } as any);
      },
    },
  ];

  it.each(driftCases)('rejects $name drift before token consumption or adapter dispatch', async ({ scope, mutate }) => {
    const fixture = publicationFixture();
    try {
      const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
      const requestId = prepared.confirmationToken.split('.')[1];
      mutate(fixture);
      let failure: unknown;
      try {
        await fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DashboardPublicationError);
      expect(failure).toMatchObject({ code: 'publication_snapshot_drift' });
      expect((failure as DashboardPublicationError).drift).toEqual(expect.arrayContaining([expect.objectContaining({ scope })]));
      expect(fixture.db.prepare('SELECT used_at FROM dashboard_share_requests WHERE id = ?').get(requestId)).toEqual({ used_at: null });
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM dashboard_publications').get()).toEqual({ count: 0 });
      expect(fixture.calls).toHaveLength(0);
    } finally {
      fixture.storage.close();
    }
  });

  it('rejects malformed persisted provenance as typed drift without consuming the token', async () => {
    const fixture = publicationFixture();
    try {
      const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
      const requestId = prepared.confirmationToken.split('.')[1];
      fixture.db.prepare('UPDATE dashboard_share_requests SET manifest_json = ? WHERE id = ?').run('{"version":1}', requestId);
      await expect(fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken)).rejects.toMatchObject({
        code: 'publication_snapshot_drift',
        drift: [{ scope: 'artifact' }],
      });
      expect(fixture.db.prepare('SELECT used_at FROM dashboard_share_requests WHERE id = ?').get(requestId)).toEqual({ used_at: null });
      expect(fixture.calls).toHaveLength(0);
    } finally {
      fixture.storage.close();
    }
  });

  it('records a failed exact receipt and consumes the token when the provider fails', async () => {
    let adapterCalls = 0;
    const fixture = publicationFixture({
      adapter: async () => {
        adapterCalls += 1;
        throw new Error('synthetic provider outage');
      },
    });
    try {
      const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
      const requestId = prepared.confirmationToken.split('.')[1];
      await expect(fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken)).rejects.toMatchObject({
        code: 'publication_provider_failed',
        nextAction: expect.stringContaining('confirmation was consumed'),
      });
      expect(adapterCalls).toBe(1);
      expect(fixture.db.prepare('SELECT used_at FROM dashboard_share_requests WHERE id = ?').get(requestId))
        .toEqual({ used_at: expect.any(String) });
      const failed = fixture.db.prepare('SELECT * FROM dashboard_publications').get() as any;
      expect(failed).toMatchObject({
        status: 'failed',
        content_sha256: prepared.receipt.artifactContentSha256,
        config_sha256: prepared.receipt.publisherConfigSha256,
        manifest_sha256: prepared.receipt.snapshotManifestSha256,
        error: 'synthetic provider outage',
      });
      expect(JSON.parse(failed.manifest_json)).toEqual(prepared.receipt.snapshot);
      await expect(fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken))
        .rejects.toMatchObject({ code: 'invalid_confirmation' });
      expect(adapterCalls).toBe(1);
    } finally {
      fixture.storage.close();
    }
  });
});


describe('R5.5 provider effect boundary', () => {
  it('includes exact listing bytes in the artifact identity and invalidates when another listed title drifts', async () => {
    const other = { ...publicationDashboard(), id: 'dash_other', title: 'Other published dashboard', widgets: [] } as AnalyticsDashboard;
    const fixture = publicationFixture({ additionalDashboards: [other] });
    try {
      fixture.db.prepare(`
        INSERT INTO dashboard_publications
          (id, dashboard_id, publisher_id, object_key, status, content_sha256,
           deployed, content_verified, visibility_converged, created_at, published_at)
        VALUES ('publication_other', ?, 'harmony', 'd/dash_other/', 'published', ?, 1, 1, 1, ?, ?)
      `).run(other.id, 'f'.repeat(64), '2026-09-21T10:00:00.000Z', '2026-09-21T10:00:01.000Z');
      const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
      other.title = 'Other title changed after prepare';
      await expect(fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken)).rejects.toMatchObject({
        code: 'publication_snapshot_drift',
        drift: expect.arrayContaining([{ scope: 'artifact' }]),
      });
      expect(fixture.calls).toHaveLength(0);
      expect(fixture.db.prepare('SELECT used_at FROM dashboard_share_requests WHERE id = ?')
        .get(prepared.confirmationToken.split('.')[1])).toEqual({ used_at: null });
    } finally {
      fixture.storage.close();
    }
  });

  it('serializes concurrent dashboard confirmations and validates each only after owning the provider slot', async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const fixture = publicationFixture({
      adapter: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        return { deployed: true, contentVerified: true, visibilityConverged: true };
      },
    });
    try {
      const first = fixture.service.createShareRequest(fixture.dashboard.id);
      const second = fixture.service.createShareRequest(fixture.dashboard.id);
      const results = await Promise.all([
        fixture.service.publish(fixture.dashboard.id, first.confirmationToken),
        fixture.service.publish(fixture.dashboard.id, second.confirmationToken),
      ]);
      expect(results).toHaveLength(2);
      expect(calls).toBe(2);
      expect(maximumActive).toBe(1);
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM dashboard_publications').get()).toEqual({ count: 2 });
    } finally {
      fixture.storage.close();
    }
  });

  it('serializes dashboard and static-artifact mutations against the same Harmony app', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-shared-capability-'));
    writeFileSync(path.join(filesRoot, 'artifact.html'), '<!doctype html><h1>Contained artifact</h1>');
    let active = 0;
    let maximumActive = 0;
    const enter = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
    };
    const fixture = publicationFixture({
      staticFilesRoot: filesRoot,
      adapter: async () => {
        await enter();
        return { deployed: true, contentVerified: true, visibilityConverged: true };
      },
      staticPublishAdapter: async ({ settings, bundle }) => {
        await enter();
        return {
          url: `https://${harmonyAppName()}.${settings.stage}.harmony.a2z.com/a/${bundle.slug}/`,
          appName: harmonyAppName(),
          artifactPath: '/tmp/contained-artifact',
          deploy: { appName: harmonyAppName(), stage: settings.stage, appExisted: true, deployedAt: '2026-09-21T12:00:00.000Z' },
        };
      },
      harmonyHooks: {
        provision: async () => { throw new Error('unused'); },
        ensureViewerAccess: async ({ settings }) => ({
          resourceId: 'resource', owningTeamId: 'team', visibility: settings.visibility, changed: false, verified: true,
        }),
        verifyStaticArtifact: async ({ files }) => ({
          verified: true,
          files: files.map(file => ({ ...file, status: 200, responseUrl: `https://example/${file.relativePath}` })),
        }),
      },
    });
    try {
      const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
      const [dashboardResult, staticResult] = await Promise.all([
        fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken),
        fixture.service.publishStaticArtifact({ filePath: 'artifact.html', ownerRequested: true }),
      ]);
      expect(dashboardResult.publication.status).toBe('published');
      expect(staticResult.published).toBe(true);
      expect(maximumActive).toBe(1);
    } finally {
      fixture.storage.close();
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });

  it('persists partial effect truth when an adapter returns an incomplete verification receipt', async () => {
    const fixture = publicationFixture({
      adapter: async () => ({ deployed: true, contentVerified: false, visibilityConverged: true } as any),
    });
    try {
      const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
      await expect(fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken)).rejects.toMatchObject({
        code: 'publication_provider_failed',
        nextAction: expect.stringContaining('partial/unknown remote effect'),
      });
      expect(fixture.db.prepare(`
        SELECT status, deployed, content_verified, visibility_converged, share_request_id
        FROM dashboard_publications
      `).get()).toEqual({
        status: 'failed', deployed: 1, content_verified: 0, visibility_converged: 1,
        share_request_id: prepared.confirmationToken.split('.')[1],
      });
    } finally {
      fixture.storage.close();
    }
  });

  it('terminalizes an interrupted publishing row at service startup without guessing the remote effect', () => {
    const interrupted = createStorage(':memory:');
    interrupted.initialize();
    try {
      const db = interrupted.getDb();
      db.prepare("INSERT INTO analytics_dashboards (id, title, status) VALUES ('dash_interrupted', 'Interrupted', 'ready')").run();
      db.prepare(`
        INSERT INTO dashboard_publications
          (id, dashboard_id, publisher_id, object_key, status, content_sha256, deployed)
        VALUES ('publication_interrupted', 'dash_interrupted', 'harmony', 'd/dash_interrupted/', 'publishing', ?, 1)
      `).run('f'.repeat(64));
      createDashboardPublisherService({ db, analyticsService: fakeAnalyticsService({
        ...publicationDashboard(), id: 'dash_interrupted', title: 'Interrupted', widgets: [],
      } as AnalyticsDashboard), vendorDir });
      expect(db.prepare(`
        SELECT status, deployed, content_verified, error FROM dashboard_publications
        WHERE id = 'publication_interrupted'
      `).get()).toEqual({
        status: 'failed', deployed: 1, content_verified: 0,
        error: expect.stringContaining('PUBLICATION_STATE_UNKNOWN'),
      });
    } finally {
      interrupted.close();
    }
  });
});


describe('R5.5 production provider composition seams', () => {
  it('composes Harmony deploy, complete changed-file verification, and published effect truth', async () => {
    let deployInput: any = null;
    let verifyInput: any = null;
    const fixture = publicationFixture({
      useCompleteAdapter: false,
      harmonyDashboardPublishAdapter: async input => {
        deployInput = input;
        return {
          url: 'https://fixture.example/d/dash_publication_fixture/',
          deploy: { appName: 'fixture', stage: input.settings.stage, appExisted: true, deployedAt: '2026-09-21T12:00:00.000Z' },
          visibilityConverged: true,
        };
      },
      harmonyHooks: {
        provision: async () => { throw new Error('unused'); },
        ensureViewerAccess: async ({ settings }) => ({
          resourceId: 'resource', owningTeamId: 'team', visibility: settings.visibility, changed: false, verified: true,
        }),
        verifyStaticArtifact: async input => {
          verifyInput = input;
          return {
            verified: true,
            files: input.files.map(file => ({ ...file, status: 200, responseUrl: `https://fixture.example/${file.relativePath}` })),
          };
        },
      },
    });
    try {
      const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
      const result = await fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken);
      expect(deployInput.bundle).toBeTruthy();
      expect(deployInput.listingHtml).toContain('Publication fixture');
      expect(verifyInput.url).toBe(`https://${harmonyAppName()}.beta.harmony.a2z.com/`);
      expect(verifyInput.files.map((file: any) => file.relativePath)).toEqual(expect.arrayContaining([
        'index.html', 'assets/style.css',
        'd/dash_publication_fixture/index.html',
        'd/dash_publication_fixture/assets/data.js',
      ]));
      expect(result.publication).toMatchObject({
        status: 'published', deployed: true, contentVerified: true, visibilityConverged: true,
      });
    } finally {
      fixture.storage.close();
    }
  });

  it('verifies exact S3 object bytes after PutObject and persists mismatch as a deployed partial effect', async () => {
    for (const mismatch of [false, true]) {
      let uploaded = '';
      let destroyed = false;
      const commands: string[] = [];
      const fixture = publicationFixture({
        provider: 's3-cloudfront',
        useCompleteAdapter: false,
        s3ClientFactory: () => ({
          send: async (command: any) => {
            if ('Body' in command.input) {
              commands.push('put');
              uploaded = String(command.input.Body);
              return {};
            }
            commands.push('get');
            const body = mismatch ? `${uploaded}-changed` : uploaded;
            return { Body: { transformToByteArray: async () => Buffer.from(body, 'utf8') } };
          },
          destroy: () => { destroyed = true; },
        }),
      });
      try {
        const prepared = fixture.service.createShareRequest(fixture.dashboard.id);
        if (!mismatch) {
          const result = await fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken);
          expect(result.publication).toMatchObject({ status: 'published', deployed: true, contentVerified: true });
        } else {
          await expect(fixture.service.publish(fixture.dashboard.id, prepared.confirmationToken)).rejects.toMatchObject({
            code: 'publication_provider_failed',
            nextAction: expect.stringContaining('partial/unknown remote effect'),
          });
          expect(fixture.db.prepare('SELECT status, deployed, content_verified FROM dashboard_publications').get())
            .toEqual({ status: 'failed', deployed: 1, content_verified: 0 });
        }
        expect(commands).toEqual(['put', 'get']);
        expect(destroyed).toBe(true);
      } finally {
        fixture.storage.close();
      }
    }
  });
});


describe('static Harmony canonical mirror recovery', () => {
  it('forces exact redeploy and promotion before a post-deploy mirror failure can become published', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-mirror-recovery-'));
    writeFileSync(path.join(filesRoot, 'artifact.html'), '<!doctype html><h1>Mirror recovery</h1>');
    let deployCalls = 0;
    const fixture = publicationFixture({
      staticFilesRoot: filesRoot,
      staticPublishAdapter: async ({ settings, bundle }) => {
        deployCalls += 1;
        const deploy = {
          appName: harmonyAppName(), stage: settings.stage, appExisted: true,
          deployedAt: `2026-09-21T12:00:0${deployCalls}.000Z`,
        };
        if (deployCalls === 1) {
          throw new HarmonyDashboardPublishError(
            'synthetic canonical promotion failure', false, deploy, false,
          );
        }
        return {
          url: `https://${harmonyAppName()}.${settings.stage}.harmony.a2z.com/a/${bundle.slug}/`,
          appName: harmonyAppName(), artifactPath: `/tmp/${bundle.slug}`, deploy,
        };
      },
      harmonyHooks: {
        provision: async () => { throw new Error('unused'); },
        ensureViewerAccess: async ({ settings }) => ({
          resourceId: 'resource', owningTeamId: 'team', visibility: settings.visibility, changed: false, verified: true,
        }),
        verifyStaticArtifact: async ({ files }) => ({
          verified: true,
          files: files.map(file => ({ ...file, status: 200, responseUrl: `https://example/${file.relativePath}` })),
        }),
      },
    });
    try {
      const partial = await fixture.service.publishStaticArtifact({ filePath: 'artifact.html', ownerRequested: true });
      expect(partial).toMatchObject({
        published: false,
        deployed: true,
        canonicalMirrorSynchronized: false,
        phase: 'failed_after_deploy',
        nextAction: expect.stringContaining('must redeploy and promote'),
      });
      expect(deployCalls).toBe(1);

      const recovered = await fixture.service.publishStaticArtifact({
        filePath: 'artifact.html', ownerRequested: true, resumeAttemptId: partial.attemptId,
      });
      expect(recovered).toMatchObject({
        published: true,
        deployed: true,
        canonicalMirrorSynchronized: true,
        contentVerified: true,
        visibilityConverged: true,
      });
      expect(deployCalls).toBe(2);

      const idempotent = await fixture.service.publishStaticArtifact({ filePath: 'artifact.html', ownerRequested: true });
      expect(idempotent.published).toBe(true);
      expect(deployCalls).toBe(2);
    } finally {
      fixture.storage.close();
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });
});


describe('static Harmony verifyExisting mirror ordering', () => {
  it('does not admit an unverified adopted route into the canonical mirror', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-adopt-order-'));
    writeFileSync(path.join(filesRoot, 'artifact.html'), '<!doctype html><h1>Adoption</h1>');
    let mirrorCalls = 0;
    let deployCalls = 0;
    const fixture = publicationFixture({
      staticFilesRoot: filesRoot,
      staticMirrorAdapter: ({ bundle }) => {
        mirrorCalls += 1;
        return { appName: harmonyAppName(), artifactPath: `/tmp/${bundle.slug}` };
      },
      staticPublishAdapter: async () => {
        deployCalls += 1;
        throw new Error('verifyExisting must not deploy');
      },
      harmonyHooks: {
        provision: async () => { throw new Error('unused'); },
        ensureViewerAccess: async ({ settings }) => ({
          resourceId: 'resource', owningTeamId: 'team', visibility: settings.visibility, changed: false, verified: true,
        }),
        verifyStaticArtifact: async () => { throw new Error('synthetic remote mismatch'); },
      },
    });
    try {
      const partial = await fixture.service.publishStaticArtifact({
        filePath: 'artifact.html', ownerRequested: true, verifyExisting: true,
      });
      expect(partial).toMatchObject({
        published: false,
        deployed: true,
        contentVerified: false,
        canonicalMirrorSynchronized: false,
        phase: 'failed_after_deploy',
      });
      expect(deployCalls).toBe(0);
      expect(mirrorCalls).toBe(0);
    } finally {
      fixture.storage.close();
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });
});


describe('static Harmony deployment-scoped verification recovery', () => {
  it('clears adopted verification bits before mirror-zero redeploy and verifies the new bytes again', async () => {
    const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'publisher-adopt-redeploy-'));
    writeFileSync(path.join(filesRoot, 'artifact.html'), '<!doctype html><h1>Adopt then recover</h1>');
    let mirrorCalls = 0;
    let deployCalls = 0;
    let accessCalls = 0;
    let verifyCalls = 0;
    const fixture = publicationFixture({
      staticFilesRoot: filesRoot,
      staticMirrorAdapter: ({ bundle }) => {
        mirrorCalls += 1;
        throw new Error(`synthetic mirror failure for ${bundle.slug}`);
      },
      staticPublishAdapter: async ({ settings, bundle }) => {
        deployCalls += 1;
        return {
          url: `https://${harmonyAppName()}.${settings.stage}.harmony.a2z.com/a/${bundle.slug}/`,
          appName: harmonyAppName(), artifactPath: `/tmp/${bundle.slug}`,
          deploy: { appName: harmonyAppName(), stage: settings.stage, appExisted: true, deployedAt: '2026-09-21T12:00:02.000Z' },
        };
      },
      harmonyHooks: {
        provision: async () => { throw new Error('unused'); },
        ensureViewerAccess: async ({ settings }) => {
          accessCalls += 1;
          return { resourceId: 'resource', owningTeamId: 'team', visibility: settings.visibility, changed: false, verified: true };
        },
        verifyStaticArtifact: async ({ files }) => {
          verifyCalls += 1;
          if (verifyCalls === 2) throw new Error('synthetic post-redeploy content mismatch');
          return { verified: true, files: files.map(file => ({ ...file, status: 200, responseUrl: `https://example/${file.relativePath}` })) };
        },
      },
    });
    try {
      const adopted = await fixture.service.publishStaticArtifact({
        filePath: 'artifact.html', ownerRequested: true, verifyExisting: true,
      });
      expect(adopted).toMatchObject({
        published: false, deployed: true, contentVerified: true,
        visibilityConverged: true, canonicalMirrorSynchronized: false,
      });
      expect({ mirrorCalls, deployCalls, accessCalls, verifyCalls }).toEqual({
        mirrorCalls: 1, deployCalls: 0, accessCalls: 1, verifyCalls: 1,
      });

      const reDeployed = await fixture.service.publishStaticArtifact({
        filePath: 'artifact.html', ownerRequested: true, resumeAttemptId: adopted.attemptId,
      });
      expect(reDeployed).toMatchObject({
        published: false, deployed: true, contentVerified: false,
        visibilityConverged: true, canonicalMirrorSynchronized: true,
        error: 'synthetic post-redeploy content mismatch',
      });
      expect({ deployCalls, accessCalls, verifyCalls }).toEqual({ deployCalls: 1, accessCalls: 2, verifyCalls: 2 });

      const verified = await fixture.service.publishStaticArtifact({
        filePath: 'artifact.html', ownerRequested: true, resumeAttemptId: adopted.attemptId,
      });
      expect(verified).toMatchObject({
        published: true, contentVerified: true, visibilityConverged: true,
        canonicalMirrorSynchronized: true,
      });
      expect({ deployCalls, accessCalls, verifyCalls }).toEqual({ deployCalls: 1, accessCalls: 2, verifyCalls: 3 });
    } finally {
      fixture.storage.close();
      rmSync(filesRoot, { recursive: true, force: true });
    }
  });
});
