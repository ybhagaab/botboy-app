import { describe, expect, it } from 'vitest';
import { createAnalyticsDashboardService } from './analytics-dashboard.js';
import { createStorage } from './storage.js';

const SNAPSHOT = {
  version: 1,
  dashboardId: '',
  snapshotCreatedAt: '2026-09-21T12:00:00.000Z',
  presentationSha256: '1'.repeat(64),
  resultSha256: '2'.repeat(64),
  widgets: [],
};

describe('analytics dashboard publication projection', () => {
  it('reconstructs persisted exact provenance and leaves legacy rows receipt-free', () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    try {
      const service = createAnalyticsDashboardService({ db: storage.getDb(), mcpManager: {} as any });
      const dashboard = service.createDashboard({
        title: 'Publication projection',
        widgets: [{ kind: 'metric', title: 'Count', sql: 'SELECT 1' }],
      });
      const snapshot = { ...SNAPSHOT, dashboardId: dashboard.id };
      storage.getDb().prepare(`
        INSERT INTO dashboard_publications
          (id, dashboard_id, publisher_id, object_key, status, content_sha256,
           config_sha256, manifest_sha256, manifest_json, share_request_id,
           deployed, content_verified, visibility_converged, created_at, published_at)
        VALUES (?, ?, 'harmony', ?, 'published', ?, ?, ?, ?, 'share_exact', 1, 1, 1, ?, ?)
      `).run(
        'publication_exact', dashboard.id, `d/${dashboard.id}/`, '3'.repeat(64),
        '4'.repeat(64), '5'.repeat(64), JSON.stringify(snapshot),
        '2026-09-21T12:00:00.000Z', '2026-09-21T12:00:01.000Z',
      );
      expect(service.getDashboard(dashboard.id)?.latestPublication).toMatchObject({
        shareRequestId: 'share_exact',
        deployed: true,
        contentVerified: true,
        visibilityConverged: true,
        receipt: {
          snapshot,
          snapshotManifestSha256: '5'.repeat(64),
          artifactContentSha256: '3'.repeat(64),
          publisherConfigSha256: '4'.repeat(64),
        },
      });

      storage.getDb().prepare(`
        INSERT INTO dashboard_publications
          (id, dashboard_id, publisher_id, object_key, status, content_sha256, error, created_at)
        VALUES (?, ?, 'harmony', ?, 'failed', ?, 'legacy failure', ?)
      `).run(
        'publication_legacy', dashboard.id, `d/${dashboard.id}/legacy/`, '6'.repeat(64),
        '2026-09-21T12:01:00.000Z',
      );
      expect(service.getDashboard(dashboard.id)?.latestPublication).toMatchObject({
        id: 'publication_legacy', status: 'failed', deployed: false, contentVerified: false,
      });
      expect(service.getDashboard(dashboard.id)?.latestPublication?.receipt).toBeUndefined();
      expect(service.getDashboard(dashboard.id)?.latestSuccessfulPublication).toMatchObject({
        id: 'publication_exact', status: 'published', contentVerified: true,
      });
    } finally {
      storage.close();
    }
  });
});
