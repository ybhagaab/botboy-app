import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createBrainStore, newBrain, type BrainStore } from '../../core/brain-store.js';
import { createPipelineRouter } from './pipeline.js';
import type { RouterDeps } from './deps.js';

describe('PATCH /api/today/projects/:projectId', () => {
  let storage: StorageLayer;
  let brainsDir: string;
  let brains: BrainStore;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    brainsDir = mkdtempSync(path.join(os.tmpdir(), 'ppt-today-route-'));
    brains = createBrainStore(storage.getDb(), { brainsDir });
    const brain = newBrain('p_mixed', 'Mixed Project');
    brain.statusLine = 'Mixed Project in flight';
    brain.tasks = [
      { state: 'todo', text: 'Send the launch decision note' },
      { state: 'blocked', text: 'Complete migration after legal approval' },
    ];
    brain.blockers = ['Legal approval is outstanding'];
    brains.write(brain);
  });

  afterEach(() => {
    storage.close();
    rmSync(brainsDir, { recursive: true, force: true });
  });

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/api', createPipelineRouter({ db: storage.getDb(), brainStore: brains } as RouterDeps));
    return instance;
  }

  function session(view: any) {
    return {
      since: view.since,
      sinceRowId: view.cursor.sinceRowId,
      sinceLabel: view.sinceLabel,
    };
  }

  it('requires same origin and a complete fixed Today session', async () => {
    const instance = app();
    const opened = await request(instance)
      .post('/api/today/visit')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost');
    expect(opened.status).toBe(200);

    const crossOrigin = await request(instance)
      .patch('/api/today/projects/p_mixed')
      .set('Host', 'localhost')
      .set('Origin', 'https://example.invalid')
      .send({ section: 'attention', action: 'dismiss', ...session(opened.body) });
    expect(crossOrigin.status).toBe(403);

    const partial = await request(instance)
      .patch('/api/today/projects/p_mixed')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ section: 'attention', action: 'dismiss', since: opened.body.since });
    expect(partial.status).toBe(400);
    expect(partial.body.error).toContain('provided together');

    for (const invalid of [
      { section: 'changes', action: 'dismiss' },
      { section: 'attention', action: 'restore' },
      { section: 'deferred', action: 'dismiss' },
    ]) {
      const rejected = await request(instance)
        .patch('/api/today/projects/p_mixed')
        .set('Host', 'localhost')
        .set('Origin', 'http://localhost')
        .send({ ...invalid, ...session(opened.body) });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain('deferred with restore');
    }

    const noDeferred = await request(instance)
      .patch('/api/today/projects/p_mixed')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ section: 'deferred', action: 'restore', ...session(opened.body) });
    expect(noDeferred.status).toBe(404);

    const missing = await request(instance)
      .patch('/api/today/projects/p_missing')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ section: 'attention', action: 'dismiss', ...session(opened.body) });
    expect(missing.status).toBe(404);

    const invalidSnooze = await request(instance)
      .patch('/api/today/projects/p_mixed')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ section: 'attention', action: 'snooze', ...session(opened.body) });
    expect(invalidSnooze.status).toBe(400);
    expect(invalidSnooze.body.error).toContain('snoozedUntil');
  });

  it('dismisses only current attention items and snoozes only current waiting items', async () => {
    const instance = app();
    const opened = await request(instance)
      .post('/api/today/visit')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost');
    expect(opened.status).toBe(200);
    expect(opened.body.attentionGroups[0].items).toHaveLength(1);
    expect(opened.body.waitingGroups[0].items).toHaveLength(2);
    const fixedSession = session(opened.body);
    const projectControlId = opened.body.attentionGroups[0].projectControlId;
    const pinned = await request(instance)
      .patch(`/api/today/items/${encodeURIComponent(projectControlId)}`)
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ action: 'pin', ...fixedSession });
    expect(pinned.status).toBe(200);

    const dismissed = await request(instance)
      .patch('/api/today/projects/p_mixed')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ section: 'attention', action: 'dismiss', ...fixedSession });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({
      projectId: 'p_mixed',
      section: 'attention',
      action: 'dismiss',
      updated: 1,
    });

    const afterAttention = await request(instance).get('/api/today').query(fixedSession);
    expect(afterAttention.status).toBe(200);
    expect(afterAttention.body.attentionGroups).toHaveLength(1);
    expect(afterAttention.body.attentionGroups[0]).toMatchObject({ projectId: 'p_mixed', projectPinned: true, items: [] });
    expect(afterAttention.body.waitingGroups[0].items).toHaveLength(2);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const snoozed = await request(instance)
      .patch('/api/today/projects/p_mixed')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ section: 'waiting', action: 'snooze', snoozedUntil: tomorrow, ...fixedSession });
    expect(snoozed.status).toBe(200);
    expect(snoozed.body.updated).toBe(2);

    const afterWaiting = await request(instance).get('/api/today').query(fixedSession);
    expect(afterWaiting.status).toBe(200);
    expect(afterWaiting.body.waitingGroups).toHaveLength(0);
    expect(afterWaiting.body.deferred).toHaveLength(3);

    const restored = await request(instance)
      .patch('/api/today/projects/p_mixed')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ section: 'deferred', action: 'restore', ...fixedSession });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({
      projectId: 'p_mixed',
      section: 'deferred',
      action: 'restore',
      updated: 3,
    });
    expect(new Set(restored.body.itemIds).size).toBe(3);

    const afterRestore = await request(instance).get('/api/today').query(fixedSession);
    expect(afterRestore.status).toBe(200);
    expect(afterRestore.body.attentionGroups[0]).toMatchObject({ projectId: 'p_mixed', projectPinned: true });
    expect(afterRestore.body.attentionGroups[0].items).toHaveLength(1);
    expect(afterRestore.body.waitingGroups[0].items).toHaveLength(2);
    expect(afterRestore.body.deferred).toHaveLength(0);
  });
});
