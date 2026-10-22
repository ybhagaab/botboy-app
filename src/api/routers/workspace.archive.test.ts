/**
 * The project page's Archive and Restore buttons (owner request 2026-10-22) call these routes. What the confirmation
 * promises must hold: the archived project leaves the areas (the sidebar and area pages read GET /areas) while the
 * project list still has it (GET /projects), so its page stays open showing Archived with Restore; Restore puts it back
 * in its area; only the owner's own page can do either (same origin).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrainStore } from '../../core/brain-store.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import type { RouterDeps } from './deps.js';
import { createPipelineRouter } from './pipeline.js';
import { createWorkspaceRouter } from './workspace.js';

let storage: StorageLayer;
let dir: string;
let app: express.Express;

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-archive-'));
  const deps = { db: storage.getDb(), brainStore: createBrainStore(storage.getDb(), { brainsDir: path.join(dir, 'brains') }) } as unknown as RouterDeps;
  app = express();
  app.use(express.json());
  app.use('/api', createWorkspaceRouter(deps));
  app.use('/api', createPipelineRouter(deps));
});
afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const owner = (call: request.Test) => call.set('Host', 'localhost:7778').set('Origin', 'http://localhost:7778');

async function seed() {
  const area = await owner(request(app).post('/api/workspace/areas')).send({ title: 'Catalog' });
  expect(area.status).toBe(201);
  const project = await owner(request(app).post('/api/workspace/projects')).send({ title: 'MXP PV Capability Compatibility', areaId: area.body.area.id });
  expect(project.status).toBe(201);
  return { areaId: area.body.area.id as string, projectId: project.body.project.id as string };
}

async function areaProjects(areaId: string): Promise<string[]> {
  const areas = await request(app).get('/api/areas');
  return (areas.body.areas.find((area: { id: string }) => area.id === areaId)?.projects ?? []).map((project: { id: string }) => project.id);
}

async function listed(projectId: string) {
  const projects = await request(app).get('/api/projects');
  return projects.body.projects.find((project: { id: string }) => project.id === projectId);
}

describe('archive and restore from the project page', () => {
  it('archives with an empty body: the project leaves its area but stays open as Archived', async () => {
    const { areaId, projectId } = await seed();
    expect(await areaProjects(areaId)).toEqual([projectId]);
    const archived = await owner(request(app).post(`/api/workspace/projects/${projectId}/archive`)).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.project).toMatchObject({ id: projectId, status: 'archived' });
    expect(await areaProjects(areaId)).toEqual([]);
    expect(await listed(projectId)).toMatchObject({ status: 'archived', title: 'MXP PV Capability Compatibility' });
    // A second click is harmless.
    const again = await owner(request(app).post(`/api/workspace/projects/${projectId}/archive`)).send({});
    expect(again.status).toBe(200);
    expect(again.body.project.status).toBe('archived');
  });

  it('restores into the same area', async () => {
    const { areaId, projectId } = await seed();
    await owner(request(app).post(`/api/workspace/projects/${projectId}/archive`)).send({});
    const restored = await owner(request(app).post(`/api/workspace/projects/${projectId}/restore`)).send({});
    expect(restored.status).toBe(200);
    expect(restored.body.project).toMatchObject({ id: projectId, status: 'active', areaId });
    expect(await areaProjects(areaId)).toEqual([projectId]);
  });

  it('refuses another website, and changes nothing', async () => {
    const { areaId, projectId } = await seed();
    const foreign = await request(app).post(`/api/workspace/projects/${projectId}/archive`).set('Host', 'localhost:7778').set('Origin', 'https://example.invalid').send({});
    expect(foreign.status).toBe(403);
    expect(await areaProjects(areaId)).toEqual([projectId]);
    expect((await listed(projectId)).status).toBe('active');
  });

  it('answers 404 for a project that does not exist', async () => {
    const missing = await owner(request(app).post('/api/workspace/projects/proj_missing/archive')).send({});
    expect(missing.status).toBe(404);
  });
});
