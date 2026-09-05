/**
 * Lessons router — the button-based approval flow. The chat card's
 * Adopt/Dismiss buttons land on these routes; the click is the owner's
 * approval (adoption renders the lesson into the knowledge dir).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer, setSetting } from '../../core/storage.js';
import { ANALYTICS_CONTEXT_DIR_KEY } from '../../core/analytics-context.js';
import { proposeLesson } from '../../core/lessons-ledger.js';
import { createLessonsRouter } from './lessons.js';

describe('lessons router (approval flow)', () => {
  let storage: StorageLayer;
  let tmpDir: string;
  let app: express.Express;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-router-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, tmpDir);
    app = express();
    app.use(express.json());
    app.use('/api', createLessonsRouter({ db: storage.getDb() } as any));
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const stage = () => {
    const result = proposeLesson(storage.getDb(), {
      scope: 'ott',
      rule: 'Use o_mxp_streamers (seconds; >3s validity guard) for OTT title metrics instead of raw event tables.',
      evidence: 'Profile 13072741 read + run 12869676717 first-try success.',
    });
    if (!result.ok) throw new Error(result.error);
    return result.lesson;
  };

  it('lists and fetches lessons for card hydration', async () => {
    const lesson = stage();
    const list = await request(app).get('/api/lessons?status=proposed');
    expect(list.status).toBe(200);
    expect(list.body.lessons).toHaveLength(1);
    const one = await request(app).get(`/api/lessons/${lesson.id}`);
    expect(one.status).toBe(200);
    expect(one.body.lesson.rule).toContain('o_mxp_streamers');
    expect(one.body.lesson.status).toBe('proposed');
  });

  it('adopt button: flips status and renders the knowledge projection', async () => {
    const lesson = stage();
    const response = await request(app).post(`/api/lessons/${lesson.id}/adopt`);
    expect(response.status).toBe(200);
    expect(response.body.lesson.status).toBe('adopted');
    expect(fs.readFileSync(path.join(tmpDir, 'lessons', 'ott.md'), 'utf8')).toContain('o_mxp_streamers');
  });

  it('dismiss button: retires without rendering; audit row kept', async () => {
    const lesson = stage();
    const response = await request(app).post(`/api/lessons/${lesson.id}/retire`);
    expect(response.status).toBe(200);
    expect(response.body.lesson.status).toBe('retired');
    expect(fs.existsSync(path.join(tmpDir, 'lessons', 'ott.md'))).toBe(false);
    const list = await request(app).get('/api/lessons?status=retired');
    expect(list.body.lessons).toHaveLength(1);
  });

  it('unknown ids 404', async () => {
    expect((await request(app).get('/api/lessons/lesson_nope')).status).toBe(404);
    expect((await request(app).post('/api/lessons/lesson_nope/adopt')).status).toBe(404);
  });
});
