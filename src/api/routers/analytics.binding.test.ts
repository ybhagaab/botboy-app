import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsDashboardService } from '../../core/analytics-types.js';
import { AnalyticsDashboardDataRoomError } from '../../core/analytics-dashboard-data-room.js';
import { createAnalyticsRouter } from './analytics.js';

function appWith(service: Partial<AnalyticsDashboardService>, analyticsScheduler?: { runDueNow: () => Promise<number> }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAnalyticsRouter({
    nodeManager: {} as any,
    analyticsService: service as AnalyticsDashboardService,
    analyticsScheduler: analyticsScheduler as any,
  }));
  return app;
}

describe('analytics dashboard R4 owner routes', () => {
  it('targets one exact widget revision without invoking bulk dashboard replacement', async () => {
    const updateWidget = vi.fn(() => ({ id: 'widget_1', revision: 2 } as any));
    const updateDashboard = vi.fn();
    const getDashboard = vi.fn(() => ({ id: 'dash_1', widgets: [{ id: 'widget_1', revision: 2 }] } as any));
    const response = await request(appWith({ updateWidget, updateDashboard, getDashboard }))
      .put('/api/analytics/dashboards/dash_1/widgets/widget_1')
      .send({
        expectedRevision: 1,
        widget: { kind: 'metric', title: 'Updated', sql: 'SELECT 1' },
      });

    expect(response.status).toBe(200);
    expect(updateWidget).toHaveBeenCalledWith('dash_1', 'widget_1', {
      expectedRevision: 1,
      widget: { kind: 'metric', title: 'Updated', sql: 'SELECT 1' },
    });
    expect(updateDashboard).not.toHaveBeenCalled();
    expect(response.body.widget).toMatchObject({ id: 'widget_1', revision: 2 });
  });

  it('returns a selective run for one binding mutation and maps stale revisions to 409', async () => {
    const getDashboard = vi.fn(() => ({ id: 'dash_1' } as any));
    const updateWidgetBinding = vi.fn()
      .mockReturnValueOnce({
        widget: { id: 'widget_1', binding: { revision: 1 } },
        run: { id: 'run_1', refreshScope: 'selective', widgetCount: 1 },
      })
      .mockImplementationOnce(() => {
        throw new AnalyticsDashboardDataRoomError('conflict', 'Binding revision changed from expected 0 to 1.');
      });
    const app = appWith({ updateWidgetBinding, getDashboard });
    const body = {
      expectedRevision: 0,
      binding: {
        datasetId: 'ds_events',
        versionPolicy: 'latest_compatible',
        expectedSchemaSha256: 'a'.repeat(64),
        requiredColumns: ['event_date', 'events'],
        request: {},
        presentationLimit: 200,
      },
    };

    const created = await request(app)
      .put('/api/analytics/dashboards/dash_1/widgets/widget_1/binding')
      .send(body);
    expect(created.status).toBe(202);
    expect(created.body.run).toMatchObject({ id: 'run_1', refreshScope: 'selective', widgetCount: 1 });
    expect(updateWidgetBinding).toHaveBeenCalledWith('dash_1', 'widget_1', body);

    const stale = await request(app)
      .put('/api/analytics/dashboards/dash_1/widgets/widget_1/binding')
      .send(body);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/revision changed/i);
  });

  it('queues only explicit widget IDs and rejects malformed selective requests', async () => {
    const getDashboard = vi.fn(() => ({ id: 'dash_1' } as any));
    const enqueueSelectiveRefresh = vi.fn()
      .mockReturnValueOnce({ id: 'run_1', refreshScope: 'selective', widgetCount: 2 } as any)
      .mockImplementationOnce(() => { throw new Error('Selective refresh requires 1 to 24 widget IDs'); });
    const app = appWith({ enqueueSelectiveRefresh, getDashboard });

    const accepted = await request(app)
      .post('/api/analytics/dashboards/dash_1/refresh/widgets')
      .send({ widgetIds: ['widget_1', 'widget_2'] });
    expect(accepted.status).toBe(202);
    expect(enqueueSelectiveRefresh).toHaveBeenCalledWith('dash_1', ['widget_1', 'widget_2'], 'manual');

    const rejected = await request(app)
      .post('/api/analytics/dashboards/dash_1/refresh/widgets')
      .send({});
    expect(rejected.status).toBe(400);
  });
  it('reads and applies exact controls, waking the scheduler only for a committed run', async () => {
    const controls = {
      widgetId: 'widget_1', controlRevision: 2, currentValuesSha256: 'a'.repeat(64),
      definitionSha256: 'b'.repeat(64), currentValues: { version: 1, dateRange: { start: '2026-09-01', end: '2026-09-02' }, filters: [], sort: null },
    } as any;
    const getDashboard = vi.fn(() => ({ id: 'dash_1' } as any));
    const getWidgetControls = vi.fn(() => controls);
    const applyWidgetControls = vi.fn()
      .mockReturnValueOnce({ outcome: 'queued', controls, widget: { id: 'widget_1' }, run: { id: 'run_1', refreshScope: 'selective', widgetCount: 1 } })
      .mockReturnValueOnce({ outcome: 'no_op', controls, widget: { id: 'widget_1' } })
      .mockImplementationOnce(() => { throw new AnalyticsDashboardDataRoomError('conflict', 'Control revision changed.'); })
      .mockImplementationOnce(() => { throw new AnalyticsDashboardDataRoomError('invalid_input', 'Control field is not allowed.'); });
    const scheduler = { runDueNow: vi.fn(async () => 1) };
    const app = appWith({ getDashboard, getWidgetControls, applyWidgetControls }, scheduler);

    const read = await request(app).get('/api/analytics/dashboards/dash_1/widgets/widget_1/controls');
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body.controls).toMatchObject({ widgetId: 'widget_1', controlRevision: 2 });

    const body = { expected: { controlRevision: 2 }, controls: controls.currentValues };
    const queued = await request(app).put('/api/analytics/dashboards/dash_1/widgets/widget_1/controls').send(body);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ outcome: 'queued', run: { id: 'run_1' } });
    expect(scheduler.runDueNow).toHaveBeenCalledTimes(1);

    const noOp = await request(app).put('/api/analytics/dashboards/dash_1/widgets/widget_1/controls').send(body);
    expect(noOp.status).toBe(200);
    expect(noOp.body.outcome).toBe('no_op');
    expect(scheduler.runDueNow).toHaveBeenCalledTimes(1);

    const stale = await request(app).put('/api/analytics/dashboards/dash_1/widgets/widget_1/controls').send(body);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'conflict', nextAction: expect.stringMatching(/Reload/) });

    const invalid = await request(app).put('/api/analytics/dashboards/dash_1/widgets/widget_1/controls').send(body);
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ code: 'invalid_input', nextAction: expect.stringMatching(/server-returned/) });
  });

  it('returns 200 for zero-run unbind and does not wake the scheduler', async () => {
    const scheduler = { runDueNow: vi.fn(async () => 0) };
    const updateWidgetBinding = vi.fn(() => ({
      outcome: 'cleared', widget: { id: 'widget_1', bindingRevision: 2 }, bindingRevision: 2,
    } as any));
    const getDashboard = vi.fn(() => ({ id: 'dash_1' } as any));
    const response = await request(appWith({ updateWidgetBinding, getDashboard }, scheduler))
      .put('/api/analytics/dashboards/dash_1/widgets/widget_1/binding')
      .send({ expectedRevision: 1, binding: null });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'cleared', bindingRevision: 2 });
    expect(scheduler.runDueNow).not.toHaveBeenCalled();
  });
});

describe('analytics R4 owner-route boundary', () => {
  it('rejects a cross-origin binding mutation before service execution', async () => {
    const updateWidgetBinding = vi.fn();
    const response = await request(appWith({ updateWidgetBinding }))
      .put('/api/analytics/dashboards/dash_1/widgets/widget_1/binding')
      .set('Origin', 'https://example.invalid')
      .send({ expectedRevision: 0, binding: null });

    expect(response.status).toBe(403);
    const wrongScheme = await request(appWith({ updateWidgetBinding }))
      .put('/api/analytics/dashboards/dash_1/widgets/widget_1/binding')
      .set('Host', 'localhost:7778')
      .set('Origin', 'https://localhost:7778')
      .send({ expectedRevision: 0, binding: null });
    expect(wrongScheme.status).toBe(403);
    expect(updateWidgetBinding).not.toHaveBeenCalled();
  });
});