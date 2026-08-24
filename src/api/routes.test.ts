import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStorage, StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';

describe('REST API', () => {
  let storage: StorageLayer;
  let app: express.Express;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    const nm = createNodeManager(storage.getDb());
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ nodeManager: nm }));
  });

  afterEach(() => storage.close());

  it('POST /api/nodes creates a node', async () => {
    const res = await request(app).post('/api/nodes').send({ title: 'Test', description: 'Desc' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Test');
    expect(res.body.status).toBe('active');
  });

  it('GET /api/nodes lists active nodes with item counts', async () => {
    await request(app).post('/api/nodes').send({ title: 'A' });
    const res = await request(app).get('/api/nodes');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].itemCount).toBe(0);
  });

  it('GET /api/nodes/:id returns node with items', async () => {
    const create = await request(app).post('/api/nodes').send({ title: 'Detail' });
    const res = await request(app).get(`/api/nodes/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Detail');
    expect(res.body.items).toEqual([]);
  });

  it('POST /api/nodes/:id/archive archives a node', async () => {
    const create = await request(app).post('/api/nodes').send({ title: 'Archive Me' });
    await request(app).post(`/api/nodes/${create.body.id}/archive`);
    const archived = await request(app).get('/api/nodes/archived');
    expect(archived.body).toHaveLength(1);
  });

  it('POST /api/nodes/:id/reactivate restores a node', async () => {
    const create = await request(app).post('/api/nodes').send({ title: 'Reactivate' });
    await request(app).post(`/api/nodes/${create.body.id}/archive`);
    await request(app).post(`/api/nodes/${create.body.id}/reactivate`);
    const active = await request(app).get('/api/nodes');
    expect(active.body).toHaveLength(1);
  });

  it('DELETE /api/nodes/:id deletes a node', async () => {
    const create = await request(app).post('/api/nodes').send({ title: 'Delete' });
    await request(app).delete(`/api/nodes/${create.body.id}`);
    const res = await request(app).get(`/api/nodes/${create.body.id}`);
    expect(res.status).toBe(404);
  });

  it('POST /api/items creates a manual work item', async () => {
    const res = await request(app).post('/api/items').send({ title: 'Manual Item', url: 'https://example.com' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Manual Item');
    expect(res.body.source).toBe('manual');
  });

  it('GET /api/items/unassigned lists unassigned items', async () => {
    await request(app).post('/api/items').send({ title: 'Orphan' });
    const res = await request(app).get('/api/items/unassigned');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /api/connections returns empty for no shared items', async () => {
    const res = await request(app).get('/api/connections');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 400 for missing title on node creation', async () => {
    const res = await request(app).post('/api/nodes').send({});
    expect(res.status).toBe(400);
  });

  it('PATCH /api/nodes/:id updates a node', async () => {
    const create = await request(app).post('/api/nodes').send({ title: 'Old' });
    const res = await request(app).patch(`/api/nodes/${create.body.id}`).send({ title: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New');
  });
});
