import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPipelineRouter } from './pipeline.js';
import type { RouterDeps } from './deps.js';

function appWith(orchestrator: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPipelineRouter({ pipelineOrchestrator: orchestrator } as unknown as RouterDeps));
  return app;
}

describe('POST /api/pipeline/rebuild-brains', () => {
  it('requires same-origin explicit owner attestation and an exact target', async () => {
    const rebuildBrain = vi.fn().mockResolvedValue({ status: 'rebuilt', items: 7 });
    const rebuildAllBrains = vi.fn().mockResolvedValue({ projects: 2, items: 9 });
    const app = appWith({ rebuildBrain, rebuildAllBrains });

    const inferred = await request(app)
      .post('/api/pipeline/rebuild-brains')
      .send({ projectId: 'proj_critical' });
    expect(inferred.status).toBe(403);
    expect(rebuildBrain).not.toHaveBeenCalled();

    const crossOrigin = await request(app)
      .post('/api/pipeline/rebuild-brains')
      .set('Host', 'localhost')
      .set('Origin', 'https://example.invalid')
      .send({ projectId: 'proj_critical', ownerRequested: true });
    expect(crossOrigin.status).toBe(403);
    expect(rebuildBrain).not.toHaveBeenCalled();

    const missingTarget = await request(app)
      .post('/api/pipeline/rebuild-brains')
      .send({ ownerRequested: true });
    expect(missingTarget.status).toBe(400);
    expect(rebuildAllBrains).not.toHaveBeenCalled();

    const authorized = await request(app)
      .post('/api/pipeline/rebuild-brains')
      .send({ projectId: 'proj_critical', ownerRequested: true, chunkSize: 5 });
    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({ ok: true, status: 'rebuilt', items: 7 });
    expect(rebuildBrain).toHaveBeenCalledWith('proj_critical', { chunkSize: 5 });
  });
});
