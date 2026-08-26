import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createDocumentsRouter } from './documents.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createContentStore, refToColumns, type ContentStore } from '../../core/content-store.js';
import type { RouterDeps } from './deps.js';

/**
 * Document workbench router (document-workbench R1/R2): grouped project
 * documents, the reader payload (content + threaded comments + revisions),
 * and the on-demand refresh handoff to the sync engine.
 */

describe('documents router', () => {
  let storage: StorageLayer;
  let dir: string;
  let cs: ContentStore;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-docs-router-'));
    cs = createContentStore(storage.getDb(), { contentDir: dir });
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function appWith(extra: Partial<RouterDeps> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api', createDocumentsRouter({ db: storage.getDb(), contentStore: cs, ...extra } as RouterDeps));
    return app;
  }

  const DOC_KEY = 'amazon.sharepoint.com/sites/t/Shared Documents/HLD.docx';

  function insertCapture(id: string, capturedAt: string, opts: { rev?: boolean; tier?: string; content?: string; summary?: string | null; changeSummary?: string } = {}) {
    const cols = refToColumns(cs.put(id, opts.content ?? ''));
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, project_id, metadata, summary,
                              raw_text, content_storage, content_path, content_sha256, content_bytes)
      VALUES (?, 'document_capture', 'sharepoint', 'HLD.docx', ?, ?, 'routed', 'p1', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      `https://x/hld${opts.rev ? `#rev=${id}` : ''}`,
      capturedAt,
      JSON.stringify({
        docKey: DOC_KEY,
        webUrl: 'https://x/hld',
        serverRelativeUrl: '/sites/t/Shared Documents/HLD.docx',
        fileType: '.docx',
        extractionTier: opts.tier ?? 'full',
        sizeBytes: '2048',
        lastModified: capturedAt,
        sharePointSource: 'shared_with_me',
        ...(opts.changeSummary ? { changeSummary: opts.changeSummary } : {}),
      }),
      opts.summary ?? null,
      cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
    );
  }

  function insertComment(id: string, commentedAt: string, opts: { author?: string; parent?: string; root?: string; resolved?: boolean; direction?: string } = {}) {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, project_id, metadata, raw_text)
      VALUES (?, 'document_comment', 'sharepoint', 'Comment', ?, ?, 'routed', 'p1', ?, ?)
    `).run(
      id, `https://x/hld#comment=${id}`, commentedAt,
      JSON.stringify({
        docKey: DOC_KEY, docTitle: 'HLD.docx', commentId: id,
        threadRoot: opts.root ?? id,
        ...(opts.parent ? { parentCommentId: opts.parent } : {}),
        author: opts.author ?? 'Ng, Hui Jun',
        direction: opts.direction ?? 'received',
        mentionedMe: 'false',
        commentedAt,
        ...(opts.resolved ? { resolved: 'true' } : {}),
      }),
      `comment text ${id}`,
    );
  }

  it('groups project documents by docKey with revision and comment counts', async () => {
    storage.getDb().prepare("INSERT INTO projects (id, title, one_liner, brain_path, status) VALUES ('p1','Catalog','x','/b','active')").run();
    insertCapture('c0', '2026-08-20T10:00:00Z', { content: 'v1 body' });
    insertCapture('c1', '2026-08-24T10:00:00Z', { rev: true, content: 'v2 body', changeSummary: 'Changed — "Rollout": 1 added' });
    insertComment('m1', '2026-08-24T11:00:00Z');
    insertComment('m2', '2026-08-24T12:00:00Z', { resolved: true });

    const res = await request(appWith()).get('/api/projects/p1/documents');
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    const doc = res.body.documents[0];
    expect(doc.docKey).toBe(DOC_KEY);
    expect(doc.revisionCount).toBe(2);
    expect(doc.commentCount).toBe(2);
    expect(doc.resolvedCommentCount).toBe(1);
    expect(doc.latestChangeSummary).toContain('Rollout');
    expect(doc.extractionTier).toBe('full');
  });

  it('reader view returns newest content, threaded comments, and the revisions timeline', async () => {
    insertCapture('c0', '2026-08-20T10:00:00Z', { content: '# HLD\n\nOriginal body.' });
    insertCapture('c1', '2026-08-24T10:00:00Z', { rev: true, content: '# HLD\n\nRevised body.', changeSummary: 'Changed — document: 1 added, 1 removed' });
    insertComment('m1', '2026-08-24T11:00:00Z', { author: 'Bhagat, AB', direction: 'sent' });
    insertComment('m2', '2026-08-24T12:00:00Z', { parent: 'm1', root: 'm1' });

    const res = await request(appWith()).get(`/api/documents/view?docKey=${encodeURIComponent(DOC_KEY)}`);
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('Revised body');
    expect(res.body.contentTier).toBe('full');
    expect(res.body.doc.title).toBe('HLD.docx');
    expect(res.body.comments).toHaveLength(2);
    const reply = res.body.comments.find((c: any) => c.commentId === 'm2');
    expect(reply.parentCommentId).toBe('m1');
    expect(reply.threadRoot).toBe('m1');
    expect(res.body.revisions).toHaveLength(2);
    expect(res.body.revisions[0].changeSummary).toContain('1 added');
    expect(res.body.pendingEdits).toEqual([]);
    // Unknown docKey → 404.
    const missing = await request(appWith()).get('/api/documents/view?docKey=nope');
    expect(missing.status).toBe(404);
  });

  it('reader falls back to the newest CONTENT-BEARING revision when the latest is metadata-only', async () => {
    insertCapture('c0', '2026-08-20T10:00:00Z', { content: 'real extracted body' });
    insertCapture('c1', '2026-08-24T10:00:00Z', { rev: true, tier: 'metadata_only', content: '' });
    const res = await request(appWith()).get(`/api/documents/view?docKey=${encodeURIComponent(DOC_KEY)}`);
    expect(res.body.doc.extractionTier).toBe('metadata_only'); // header tells the truth about the LATEST
    expect(res.body.content).toBe('real extracted body');      // content comes from the newest readable revision
    expect(res.body.contentTier).toBe('full');
  });

  it('pending-edits lane: create (validated) → approve → sync applies via ONE upload with per-edit results', async () => {
    insertCapture('c0', '2026-08-20T10:00:00Z', { content: 'The rollout starts in EU next quarter.' });
    // Fake manager: download writes a real docx fixture; upload records; read-back confirms.
    const { execFileSync } = await import('child_process');
    const { mkdirSync: mkdir, writeFileSync: write, copyFileSync } = await import('fs');
    const src = path.join(dir, 'fixture-src');
    mkdir(path.join(src, 'word'), { recursive: true });
    write(path.join(src, '[Content_Types].xml'), '<Types/>');
    write(path.join(src, 'word', 'document.xml'),
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The rollout starts in EU next quarter.</w:t></w:r></w:p></w:body></w:document>');
    const fixture = path.join(dir, 'fixture.docx');
    execFileSync('zip', ['-X', '-q', '-r', fixture, '.'], { cwd: src });
    const writes: Record<string, unknown>[] = [];
    const mcpManager = {
      callTool: async (_id: string, tool: string, args: Record<string, unknown>, options: Record<string, unknown> = {}) => {
        if (tool === 'sharepoint_read_file' && args.savePath) { copyFileSync(fixture, String(args.savePath)); return { text: '{}', isError: false }; }
        if (tool === 'sharepoint_read_file') return { text: 'The rollout begins in NA in Q1.', isError: false };
        if (tool === 'sharepoint_write_file') { writes.push(options); return { text: '{"saved":true}', isError: false }; }
        throw new Error(`unexpected ${tool}`);
      },
    };
    // The docx in this fixture lives at a personal path so the target maps.
    storage.getDb().prepare("UPDATE work_items SET metadata = json_set(metadata, '$.serverRelativeUrl', '/personal/u_amazon_com/Documents/HLD.docx')").run();
    const app = appWith({ mcpManager: mcpManager as never });

    const tooShort = await request(app).post('/api/documents/pending-edits').send({
      docKey: DOC_KEY, serverRelativeUrl: '/personal/u_amazon_com/Documents/HLD.docx',
      operation: 'replaceText', findText: 'short', replaceWith: 'x',
    });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toMatch(/20 characters/);

    const created = await request(app).post('/api/documents/pending-edits').send({
      docKey: DOC_KEY, serverRelativeUrl: '/personal/u_amazon_com/Documents/HLD.docx',
      operation: 'replaceText', findText: 'The rollout starts in EU next quarter.', replaceWith: 'The rollout begins in NA in Q1.',
    });
    expect(created.status).toBe(200);
    const editId = created.body.edit.id;
    expect(created.body.edit.kind).toBe('manual');

    // Sync refuses without approval.
    const early = await request(app).post('/api/documents/sync').send({ docKey: DOC_KEY });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/no approved edits/);

    const approved = await request(app).post(`/api/documents/pending-edits/${editId}/approve`).send({});
    expect(approved.body.edit.status).toBe('approved');

    const synced = await request(app).post('/api/documents/sync').send({ docKey: DOC_KEY });
    expect(synced.status).toBe(200);
    expect(synced.body.uploaded).toBe(true);
    expect(synced.body.verifiedOnReadBack).toBe(true);
    expect(synced.body.results).toEqual([{ id: editId, applied: true }]);
    expect(writes).toHaveLength(1);
    expect(writes[0].guidedFlow).toBe(true); // server-side waiver, owner Approve clicks are the approval
    expect(synced.body.edits[0].status).toBe('synced');

    // Reader view carries the ledger.
    const view = await request(app).get(`/api/documents/view?docKey=${encodeURIComponent(DOC_KEY)}`);
    expect(view.body.pendingEdits).toHaveLength(1);
    expect(view.body.pendingEdits[0].status).toBe('synced');
  });

  it('SOAK REGRESSION: a SharePoint lock (teammate co-authoring) returns 202 and background-retries until the lock clears', async () => {
    // Soak find 2026-08-25: the lock belongs to ANY active editing session —
    // the owner's teammates reviewing the doc hold it for hours. Sync must
    // not bounce the owner; it queues a background retry that lands the
    // moment the document goes quiet.
    process.env.PPT_LOCK_RETRY_INTERVAL_MS = '25'; // real retry chain, fast
    try {
      insertCapture('c0', '2026-08-20T10:00:00Z', { content: 'The rollout starts in EU next quarter.' });
      storage.getDb().prepare("UPDATE work_items SET metadata = json_set(metadata, '$.serverRelativeUrl', '/personal/u_amazon_com/Documents/HLD.docx')").run();
      const { execFileSync } = await import('child_process');
      const { mkdirSync: mkdir, writeFileSync: write, copyFileSync } = await import('fs');
      const src = path.join(dir, 'lock-src');
      mkdir(path.join(src, 'word'), { recursive: true });
      write(path.join(src, '[Content_Types].xml'), '<Types/>');
      write(path.join(src, 'word', 'document.xml'),
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The rollout starts in EU next quarter.</w:t></w:r></w:p></w:body></w:document>');
      const fixture = path.join(dir, 'lock.docx');
      execFileSync('zip', ['-X', '-q', '-r', fixture, '.'], { cwd: src });
      let locked = true;
      const writes: Array<Record<string, unknown>> = [];
      const mcpManager = {
        callTool: async (_id: string, tool: string, args: Record<string, unknown>) => {
          if (tool === 'sharepoint_read_file' && args.savePath) { copyFileSync(fixture, String(args.savePath)); return { text: '{}', isError: false }; }
          if (tool === 'sharepoint_write_file') {
            if (locked) return { text: 'Error: File is locked (likely open in browser or Office). Close the file and try again.', isError: true };
            writes.push(args);
            return { text: 'uploaded', isError: false };
          }
          return { text: '', isError: false };
        },
      };
      const app = appWith({ mcpManager: mcpManager as never });
      const created = await request(app).post('/api/documents/pending-edits').send({
        docKey: DOC_KEY, serverRelativeUrl: '/personal/u_amazon_com/Documents/HLD.docx',
        operation: 'replaceText', findText: 'The rollout starts in EU next quarter.', replaceWith: 'changed text long enough',
      });
      await request(app).post(`/api/documents/pending-edits/${created.body.edit.id}/approve`).send({});

      const response = await request(app).post('/api/documents/sync').send({ docKey: DOC_KEY });
      expect(response.status).toBe(202);
      expect(response.body.retrying).toBe(true);
      expect(response.body.note).toMatch(/retry automatically/);
      // Edit unchanged — still approved, lands when the lock clears.
      expect(response.body.edits[0].status).toBe('approved');

      // Retry state is queryable (reader view surfaces it as a banner).
      const status = await request(app).get(`/api/documents/sync-retry?docKey=${encodeURIComponent(DOC_KEY)}`);
      expect(status.body.retrying).toBe(true);
      expect(status.body.attempts).toBeGreaterThanOrEqual(0); // ticks may already have run (25 ms interval)
      const view = await request(app).get(`/api/documents/view?docKey=${encodeURIComponent(DOC_KEY)}`);
      expect(view.body.syncRetry?.retrying).toBe(true);

      // First tick still locked (attempts advance), then the teammates close
      // the doc — the next tick publishes without anyone pressing Sync.
      await new Promise(resolve => setTimeout(resolve, 40));
      locked = false;
      const deadline = Date.now() + 5000;
      let editStatus = '';
      while (editStatus !== 'synced' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
        const edits = await request(app).get(`/api/documents/pending-edits?docKey=${encodeURIComponent(DOC_KEY)}`);
        editStatus = edits.body.edits[0].status;
      }
      expect(editStatus).toBe('synced');
      expect(writes).toHaveLength(1);
      const cleared = await request(app).get(`/api/documents/sync-retry?docKey=${encodeURIComponent(DOC_KEY)}`);
      expect(cleared.body.retrying).toBe(false);
    } finally {
      delete process.env.PPT_LOCK_RETRY_INTERVAL_MS;
    }
  });

  it('AUTHORING BRIDGE: an approved .md creation publishes with existence guard, guided write, and read-back probes', async () => {
    const CREATE_KEY = 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/BotBoyTests/rollout-plan.md';
    const TARGET = '/personal/u_amazon_com/Documents/BotBoyTests/rollout-plan.md';
    const CONTENT = '# Rollout plan\n\nPhase one covers the EU storefront migration and the catalog dual-write window.';
    const calls: Array<{ tool: string; args: Record<string, unknown>; options: Record<string, unknown> }> = [];
    let uploaded = '';
    const mcpManager = {
      callTool: async (_id: string, tool: string, args: Record<string, unknown>, options: Record<string, unknown> = {}) => {
        calls.push({ tool, args, options });
        if (tool === 'sharepoint_read_file' && !uploaded) return { text: 'Error: File not found at the given path', isError: true };
        if (tool === 'sharepoint_read_file') return { text: uploaded, isError: false };
        if (tool === 'sharepoint_write_file') { uploaded = String(args.content ?? ''); return { text: 'written', isError: false }; }
        return { text: '', isError: false };
      },
    };
    const app = appWith({ mcpManager: mcpManager as never });
    const { createPendingEdit: stage } = await import('../../core/pending-edits.js');
    const edit = stage(storage.getDb(), {
      docKey: CREATE_KEY, serverRelativeUrl: TARGET, kind: 'botboy',
      operation: 'createDocument', createContent: CONTENT, projectId: 'p1',
    });
    await request(app).post(`/api/documents/pending-edits/${edit.id}/approve`).send({});

    const synced = await request(app).post('/api/documents/sync').send({ docKey: CREATE_KEY });
    expect(synced.status).toBe(200);
    expect(synced.body.uploaded).toBe(true);
    expect(synced.body.verifiedOnReadBack).toBe(true);
    expect(synced.body.results).toEqual([{ id: edit.id, applied: true }]);
    // Guided waiver on the write; existence probe came FIRST.
    const write = calls.find(c => c.tool === 'sharepoint_write_file')!;
    expect(write.options.guidedFlow).toBe(true);
    expect(write.args.folderPath).toBe('BotBoyTests');
    expect(calls[0].tool).toBe('sharepoint_read_file');
    const rows = await request(app).get(`/api/documents/pending-edits?docKey=${encodeURIComponent(CREATE_KEY)}`);
    expect(rows.body.edits[0].status).toBe('synced');
  });

  it('AUTHORING BRIDGE: a target that appeared since approval lands conflicted — never overwritten', async () => {
    const CREATE_KEY = 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/BotBoyTests/taken.md';
    const mcpManager = {
      callTool: async (_id: string, tool: string) => {
        if (tool === 'sharepoint_read_file') return { text: 'someone else made this file', isError: false };
        return { text: 'should never write', isError: false };
      },
    };
    const app = appWith({ mcpManager: mcpManager as never });
    const { createPendingEdit: stage } = await import('../../core/pending-edits.js');
    const edit = stage(storage.getDb(), {
      docKey: CREATE_KEY, serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/taken.md',
      kind: 'botboy', operation: 'createDocument',
      createContent: 'A plan document that is long enough to stage cleanly.', projectId: 'p1',
    });
    await request(app).post(`/api/documents/pending-edits/${edit.id}/approve`).send({});
    const synced = await request(app).post('/api/documents/sync').send({ docKey: CREATE_KEY });
    expect(synced.status).toBe(200);
    expect(synced.body.uploaded).toBe(false);
    expect(synced.body.results[0].reason).toMatch(/already exists/);
    const rows = await request(app).get(`/api/documents/pending-edits?docKey=${encodeURIComponent(CREATE_KEY)}`);
    expect(rows.body.edits[0].status).toBe('conflicted');
  });

  it('AUTHORING BRIDGE: a .docx creation builds a real package, uploads via sourcePath, and verifies on read-back', async () => {
    const CREATE_KEY = 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/BotBoyTests/design.docx';
    const { copyFileSync, existsSync } = await import('fs');
    const holding = path.join(dir, 'uploaded-design.docx');
    let hasUploaded = false;
    const mcpManager = {
      callTool: async (_id: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'sharepoint_read_file' && !hasUploaded) return { text: 'Error: 404 not found', isError: true };
        if (tool === 'sharepoint_read_file' && args.savePath) { copyFileSync(holding, String(args.savePath)); return { text: '{}', isError: false }; }
        if (tool === 'sharepoint_write_file') {
          expect(existsSync(String(args.sourcePath))).toBe(true);
          copyFileSync(String(args.sourcePath), holding);
          hasUploaded = true;
          return { text: 'written', isError: false };
        }
        return { text: '', isError: false };
      },
    };
    const app = appWith({ mcpManager: mcpManager as never });
    const { createPendingEdit: stage } = await import('../../core/pending-edits.js');
    const edit = stage(storage.getDb(), {
      docKey: CREATE_KEY, serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/design.docx',
      kind: 'botboy', operation: 'createDocument',
      createContent: '# Design overview\n\nThe unification service owns catalog identity end to end.', projectId: 'p1',
    });
    await request(app).post(`/api/documents/pending-edits/${edit.id}/approve`).send({});
    const synced = await request(app).post('/api/documents/sync').send({ docKey: CREATE_KEY });
    expect(synced.status).toBe(200);
    expect(synced.body.uploaded).toBe(true);
    expect(synced.body.verifiedOnReadBack).toBe(true);
  });

  it('XLSX DEEP READ: sheet route downloads once, parses the requested sheet, and serves the version cache after', async () => {
    const XKEY = 'amazon.sharepoint.com/sites/t/Shared Documents/metrics.xlsx';
    const { execFileSync } = await import('child_process');
    const { mkdirSync: mkdir, writeFileSync: write, copyFileSync } = await import('fs');
    const src = path.join(dir, 'xlsx-src');
    mkdir(path.join(src, 'xl', '_rels'), { recursive: true });
    mkdir(path.join(src, 'xl', 'worksheets'), { recursive: true });
    write(path.join(src, 'xl', 'workbook.xml'), '<?xml version="1.0"?><workbook><sheets><sheet name="Headcount" sheetId="1" r:id="rId1"/></sheets></workbook>');
    write(path.join(src, 'xl', '_rels', 'workbook.xml.rels'), '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="http://sheet" Target="worksheets/sheet1.xml"/></Relationships>');
    write(path.join(src, 'xl', 'worksheets', 'sheet1.xml'), '<?xml version="1.0"?><worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="str"><v>Team</v></c><c r="B1" t="str"><v>Count</v></c></row><row r="2"><c r="A2" t="str"><v>Catalog</v></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>');
    const fixture = path.join(dir, 'metrics.xlsx');
    execFileSync('zip', ['-X', '-q', '-r', fixture, '.'], { cwd: src });

    // Corpus row: an .xlsx capture with a UNIQUE lastModified so the version
    // cache key cannot collide across test runs.
    const stamp = `2026-08-26T${Date.now() % 1000}Z-test`;
    const cols = refToColumns(cs.put('x1', 'bounded sample'));
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, project_id, metadata,
                              raw_text, content_storage, content_path, content_sha256, content_bytes)
      VALUES ('x1', 'document_capture', 'sharepoint', 'metrics.xlsx', 'https://x/metrics', '2026-08-26T09:00:00Z', 'routed', 'p1', ?, ?, ?, ?, ?, ?)
    `).run(
      JSON.stringify({ docKey: XKEY, serverRelativeUrl: '/sites/t/Shared Documents/metrics.xlsx', siteUrl: 'https://amazon.sharepoint.com/sites/t', fileType: '.xlsx', sizeBytes: '2048', lastModified: stamp }),
      cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
    );

    let downloads = 0;
    const mcpManager = {
      callTool: async (_id: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'sharepoint_read_file' && args.savePath) { downloads++; copyFileSync(fixture, String(args.savePath)); return { text: '{}', isError: false }; }
        return { text: '', isError: false };
      },
    };
    const { createDocumentParser } = await import('../../core/document-parser.js');
    const app = appWith({ mcpManager: mcpManager as never, documentParser: createDocumentParser() });

    // Inventory (no sheet).
    const inventory = await request(app).get(`/api/documents/sheet?docKey=${encodeURIComponent(XKEY)}&refresh=true`);
    expect(inventory.status).toBe(200);
    expect(inventory.body.sheets).toEqual(['Headcount']);

    const first = await request(app).get(`/api/documents/sheet?docKey=${encodeURIComponent(XKEY)}&sheet=Headcount&refresh=true`);
    expect(first.status).toBe(200);
    expect(first.body.fromCache).toBe(false);
    expect(first.body.sheet.rows).toEqual([['Team', 'Count'], ['Catalog', '12']]);

    // Same version → cache, no new download.
    const before = downloads;
    const second = await request(app).get(`/api/documents/sheet?docKey=${encodeURIComponent(XKEY)}&sheet=Headcount`);
    expect(second.body.fromCache).toBe(true);
    expect(downloads).toBe(before);

    // Unknown sheet is a 400 carrying the inventory.
    const missing = await request(app).get(`/api/documents/sheet?docKey=${encodeURIComponent(XKEY)}&sheet=Nope&refresh=true`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/workbook has: Headcount/);

    // Non-xlsx docKeys refuse.
    const wrongType = await request(app).get(`/api/documents/sheet?docKey=${encodeURIComponent(DOC_KEY)}&sheet=x`);
    expect([400, 404]).toContain(wrongType.status);
  });

  it('refresh queues through the engine and drains; failures surface honestly', async () => {
    const calls: string[] = [];
    const sync = {
      refreshDocument: (docKey: string) => { calls.push(docKey); return { queued: true }; },
      drainNow: async () => 2,
    };
    const ok = await request(appWith({ sharePointSync: sync as never })).post('/api/documents/refresh').send({ docKey: DOC_KEY });
    expect(ok.status).toBe(200);
    expect(ok.body.refreshed).toBe(true);
    expect(calls).toEqual([DOC_KEY]);

    const rejecting = { refreshDocument: () => ({ queued: false, reason: 'unknown document' }), drainNow: async () => 0 };
    const bad = await request(appWith({ sharePointSync: rejecting as never })).post('/api/documents/refresh').send({ docKey: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/unknown document/);

    const unwired = await request(appWith()).post('/api/documents/refresh').send({ docKey: DOC_KEY });
    expect(unwired.status).toBe(503);
  });
});
