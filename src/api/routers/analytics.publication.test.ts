import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  DashboardPublicationError,
} from '../../core/analytics-publisher.js';
import type { DashboardPublisherService } from '../../core/analytics-types.js';
import { createAnalyticsRouter } from './analytics.js';

function appWithPublisher(
  publisher: Partial<DashboardPublisherService>,
  dashboardState?: { bump: () => number; current: () => number },
) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAnalyticsRouter({
    nodeManager: {} as any,
    dashboardPublisher: publisher as DashboardPublisherService,
  }, dashboardState));
  return app;
}

const RECEIPT = {
  snapshot: {
    version: 1 as const,
    dashboardId: 'dash_1',
    snapshotCreatedAt: '2026-09-21T12:00:00.000Z',
    presentationSha256: '1'.repeat(64),
    resultSha256: '2'.repeat(64),
    widgets: [],
  },
  snapshotManifestSha256: '3'.repeat(64),
  artifactContentSha256: '4'.repeat(64),
  publisherConfigSha256: '5'.repeat(64),
};

describe('analytics R5.5 publication routes', () => {
  it('returns a local-owner, no-store exact receipt from preparation and confirmation', async () => {
    const createShareRequest = vi.fn(() => ({
      dashboardId: 'dash_1',
      confirmationToken: 'secret.share_1.content.config',
      expiresAt: '2026-09-21T12:05:00.000Z',
      destination: 'synthetic destination',
      objectKey: 'd/dash_1/',
      contentSha256: RECEIPT.artifactContentSha256,
      receipt: RECEIPT,
      warning: 'Synthetic external publication warning',
    }));
    const publish = vi.fn(async () => ({
      publication: {
        id: 'publication_1', dashboardId: 'dash_1', publisherId: 'harmony', objectKey: 'd/dash_1/',
        status: 'published', contentSha256: RECEIPT.artifactContentSha256, receipt: RECEIPT,
        shareRequestId: 'share_1', deployed: true, contentVerified: true, visibilityConverged: true,
        createdAt: '2026-09-21T12:00:00.000Z', publishedAt: '2026-09-21T12:00:01.000Z',
      },
      url: 'https://example.invalid/d/dash_1/',
    }));
    let version = 0;
    const dashboardState = { bump: vi.fn(() => ++version), current: () => version };
    const app = appWithPublisher({ createShareRequest, publish }, dashboardState);

    const prepared = await request(app).post('/api/analytics/dashboards/dash_1/share-request').send({});
    expect(prepared.status).toBe(201);
    expect(prepared.headers['cache-control']).toBe('no-store');
    expect(prepared.body.shareRequest.receipt).toEqual(RECEIPT);
    expect(createShareRequest).toHaveBeenCalledWith('dash_1');

    const confirmed = await request(app).post('/api/analytics/dashboards/dash_1/publish').send({
      confirmed: true,
      confirmationToken: 'secret.share_1.content.config',
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(confirmed.body.publication.receipt).toEqual(RECEIPT);
    expect(publish).toHaveBeenCalledWith('dash_1', 'secret.share_1.content.config');
    expect(dashboardState.bump).toHaveBeenCalledTimes(1);
    expect(dashboardState.current()).toBe(1);
  });

  it('maps typed snapshot drift to 409 with next action and exact drift while retaining server control', async () => {
    const publish = vi.fn(async () => {
      throw new DashboardPublicationError(
        'publication_snapshot_drift',
        'The prepared snapshot changed.',
        'Prepare a new snapshot.',
        [{ scope: 'dataset_head', widgetId: 'widget_1' }],
      );
    });
    const response = await request(appWithPublisher({ publish }))
      .post('/api/analytics/dashboards/dash_1/publish')
      .send({ confirmed: true, confirmationToken: 'secret.share_1.content.config' });
    expect(response.status).toBe(409);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      code: 'publication_snapshot_drift',
      error: 'The prepared snapshot changed.',
      nextAction: 'Prepare a new snapshot.',
      drift: [{ scope: 'dataset_head', widgetId: 'widget_1' }],
    });
  });

  it.each([
    ['publication_not_ready', 409],
    ['publication_provider_failed', 502],
    ['policy_denied', 403],
    ['not_found', 404],
    ['invalid_confirmation', 400],
  ] as const)('maps %s to HTTP %s', async (code, status) => {
    const publish = vi.fn(async () => {
      throw new DashboardPublicationError(code, `Synthetic ${code}`, 'Synthetic next action');
    });
    let version = 0;
    const dashboardState = { bump: vi.fn(() => ++version), current: () => version };
    const response = await request(appWithPublisher({ publish }, dashboardState))
      .post('/api/analytics/dashboards/dash_1/publish')
      .send({ confirmed: true, confirmationToken: 'secret.share_1.content.config' });
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code, error: `Synthetic ${code}`, nextAction: 'Synthetic next action', drift: [] });
    expect(dashboardState.bump).toHaveBeenCalledTimes(code === 'publication_provider_failed' ? 1 : 0);
  });

  it('requires explicit confirmation and rejects cross-origin preparation/confirmation before service calls', async () => {
    const createShareRequest = vi.fn();
    const publish = vi.fn();
    const app = appWithPublisher({ createShareRequest, publish });

    const missing = await request(app).post('/api/analytics/dashboards/dash_1/publish').send({});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'invalid_confirmation', drift: [] });

    const prepared = await request(app)
      .post('/api/analytics/dashboards/dash_1/share-request')
      .set('Origin', 'https://example.invalid')
      .send({});
    const confirmed = await request(app)
      .post('/api/analytics/dashboards/dash_1/publish')
      .set('Origin', 'https://example.invalid')
      .send({ confirmed: true, confirmationToken: 'secret.share_1.content.config' });
    expect(prepared.status).toBe(403);
    expect(confirmed.status).toBe(403);
    expect(createShareRequest).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
