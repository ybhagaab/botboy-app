import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalyticsImportInboxRouter } from './analytics-import-inbox.js';
import { createAnalyticsImportInbox, ANALYTICS_IMPORT_MEDIA_TYPE } from '../../core/analytics-import-inbox.js';
import { createDocumentParser } from '../../core/document-parser.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createRouter } from '../routes.js';

const roots: string[] = [];
const storages: StorageLayer[] = [];

afterEach(() => {
  while (storages.length) {
    try { storages.pop()?.close(); } catch {}
  }
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch {}
  }
});

function workbookFixture(root: string): Buffer {
  const stage = path.join(root, 'xlsx-stage');
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'xl/workbook.xml': '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="str"><v>Name</v></c><c r="B1" t="str"><v>Count</v></c></row><row r="2"><c r="A2" t="str"><v>One</v></c><c r="B2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
  };
  for (const [member, content] of Object.entries(entries)) {
    const target = path.join(stage, member);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const file = path.join(root, 'api.xlsx');
  execFileSync('zip', ['-q', '-r', '-X', file, '.'], { cwd: stage });
  return fs.readFileSync(file);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-import-api-'));
  roots.push(root);
  const storage = createStorage(path.join(root, 'tracker.db'));
  storage.initialize();
  storages.push(storage);
  const service = createAnalyticsImportInbox({
    db: storage.getDb(),
    documentParser: createDocumentParser(),
    rootDir: path.join(root, 'private'),
    createId: () => 'e'.repeat(24),
  });
  const activeWork = new Set<string>();
  const registerWork = vi.fn((work: { id: string }) => {
    activeWork.add(work.id);
    return () => activeWork.delete(work.id);
  });
  const deps = {
    analyticsImportInbox: service,
    shutdown: {
      signal: new AbortController().signal,
      isShuttingDown: () => false,
      registerWork,
    },
  } as any;
  const app = express();
  app.use(express.json());
  app.use('/api', createAnalyticsImportInboxRouter(deps));
  return { root, storage, service, app, activeWork, registerWork };
}

describe('Analytics Import Inbox router', () => {
  it('accepts exact raw xlsx bytes, returns path-free no-store projections, and inspects one explicit sheet', async () => {
    const { root, app, activeWork, registerWork } = setup();
    const workbook = workbookFixture(root);
    const upload = await request(app)
      .post('/api/analytics/data-room/imports/upload')
      .query({ filename: 'api.xlsx', requestId: 'owner-api-upload-0001' })
      .set('Content-Type', ANALYTICS_IMPORT_MEDIA_TYPE)
      .set('X-BotBoy-Owner-Requested', 'true')
      .send(workbook);
    expect(upload.status).toBe(201);
    expect(upload.headers['cache-control']).toBe('no-store');
    expect(upload.body.importItem).toMatchObject({
      id: `dri_${'e'.repeat(24)}`,
      status: 'uploaded',
      revision: 2,
      originalName: 'api.xlsx',
      sheets: ['Data'],
    });
    expect(JSON.stringify(upload.body)).not.toContain(root);
    expect(JSON.stringify(upload.body)).not.toContain('source_rel_path');
    expect(registerWork).toHaveBeenCalledWith(expect.objectContaining({ kind: 'data_room_import_upload' }));
    expect(activeWork.size).toBe(0);

    const replay = await request(app)
      .post('/api/analytics/data-room/imports/upload')
      .query({ filename: 'api.xlsx', requestId: 'owner-api-upload-0001' })
      .set('Content-Type', ANALYTICS_IMPORT_MEDIA_TYPE)
      .set('X-BotBoy-Owner-Requested', 'true')
      .send(workbook);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, importItem: { id: upload.body.importItem.id } });
    const uploadWorkIds = registerWork.mock.calls
      .map(([work]) => work)
      .filter(work => work.kind === 'data_room_import_upload')
      .map(work => work.id);
    expect(new Set(uploadWorkIds).size).toBe(2);

    const list = await request(app).get('/api/analytics/data-room/imports');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toMatchObject({ count: 1, truncated: false });
    expect(list.body.sources.captured.status).toBe('unavailable');
    expect(list.body.sources.email.status).toBe('unavailable');

    const detail = await request(app).get(`/api/analytics/data-room/imports/${upload.body.importItem.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.importItem.sheets).toEqual(['Data']);

    const inspected = await request(app)
      .post(`/api/analytics/data-room/imports/${upload.body.importItem.id}/inspect`)
      .send({ ownerRequested: true, expectedRevision: 2, sheetName: 'Data' });
    expect(inspected.status).toBe(200);
    expect(inspected.body.importItem).toMatchObject({ status: 'ready', revision: 4, selectedSheet: 'Data' });
    expect(inspected.body.importItem.preview).toMatchObject({
      rows: [['Name', 'Count'], ['One', '2']],
      complete: false,
      formulaCellsInPreview: 1,
    });
    expect(inspected.body.importItem.preview.limitations.join(' ')).toMatch(/cannot power a dashboard/i);
    expect(registerWork).toHaveBeenCalledWith(expect.objectContaining({ kind: 'data_room_import_inspection' }));
    expect(activeWork.size).toBe(0);
  });

  it('rejects cross-origin, unattested, unsupported, stale, malformed, and unavailable requests safely', async () => {
    const { root, app, service } = setup();
    const workbook = workbookFixture(root);

    const crossOrigin = await request(app)
      .post('/api/analytics/data-room/imports/upload')
      .query({ filename: 'api.xlsx', requestId: 'owner-api-upload-0002' })
      .set('Host', 'localhost:7778')
      .set('Origin', 'https://example.invalid')
      .set('Content-Type', ANALYTICS_IMPORT_MEDIA_TYPE)
      .set('X-BotBoy-Owner-Requested', 'true')
      .send(workbook);
    expect(crossOrigin.status).toBe(403);

    const unattested = await request(app)
      .post('/api/analytics/data-room/imports/upload')
      .query({ filename: 'api.xlsx', requestId: 'owner-api-upload-0003' })
      .set('Content-Type', ANALYTICS_IMPORT_MEDIA_TYPE)
      .send(workbook);
    expect(unattested.status).toBe(400);

    const unsupported = await request(app)
      .post('/api/analytics/data-room/imports/upload')
      .query({ filename: 'api.xlsm', requestId: 'owner-api-upload-0004' })
      .set('Content-Type', 'application/octet-stream')
      .set('X-BotBoy-Owner-Requested', 'true')
      .send(workbook);
    expect(unsupported.status).toBe(415);

    const uploaded = await request(app)
      .post('/api/analytics/data-room/imports/upload')
      .query({ filename: 'api.xlsx', requestId: 'owner-api-upload-0005' })
      .set('Content-Type', ANALYTICS_IMPORT_MEDIA_TYPE)
      .set('X-BotBoy-Owner-Requested', 'true')
      .send(workbook);
    expect(uploaded.status).toBe(201);
    const stale = await request(app)
      .post(`/api/analytics/data-room/imports/${uploaded.body.importItem.id}/inspect`)
      .send({ ownerRequested: true, expectedRevision: 1, sheetName: 'Data' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'conflict', nextAction: expect.any(String) });

    expect((await request(app).get('/api/analytics/data-room/imports/not-an-id')).status).toBe(400);
    expect((await request(app).get('/api/analytics/data-room/imports?limit=101')).status).toBe(400);

    const unavailable = express();
    unavailable.use(express.json());
    unavailable.use('/api', createAnalyticsImportInboxRouter({} as any));
    expect((await request(unavailable).get('/api/analytics/data-room/imports')).status).toBe(503);

    const registrationBlocked = express();
    registrationBlocked.use(express.json());
    registrationBlocked.use('/api', createAnalyticsImportInboxRouter({
      analyticsImportInbox: service,
      shutdown: {
        signal: new AbortController().signal,
        isShuttingDown: () => false,
        registerWork: () => { throw new Error('duplicate internal work id'); },
      },
    } as any));
    const blocked = await request(registrationBlocked)
      .post('/api/analytics/data-room/imports/upload')
      .query({ filename: 'api.xlsx', requestId: 'owner-api-upload-0006' })
      .set('Content-Type', ANALYTICS_IMPORT_MEDIA_TYPE)
      .set('X-BotBoy-Owner-Requested', 'true')
      .send(workbook);
    expect(blocked.status).toBe(503);
    expect(blocked.body).toMatchObject({ code: 'unavailable', nextAction: expect.any(String) });
    expect(JSON.stringify(blocked.body)).not.toContain('duplicate internal work id');
  });

  it('is mounted through the full API composition root without widening the catalog reader', async () => {
    const { service } = setup();
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({ nodeManager: {} as any, analyticsImportInbox: service }));
    const response = await request(app).get('/api/analytics/data-room/imports');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ count: 0, imports: [] });
  });
});
