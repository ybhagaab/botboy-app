import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createDocumentParser } from './document-parser.js';
import {
  ANALYTICS_IMPORT_MEDIA_TYPE,
  AnalyticsImportInboxError,
  createAnalyticsImportInbox,
} from './analytics-import-inbox.js';
import { readAnalyticsDataRoomVersion } from './analytics-data-room-version.js';

const cleanups: Array<() => void> = [];
const storages: StorageLayer[] = [];

afterEach(() => {
  while (storages.length) {
    try { storages.pop()?.close(); } catch {}
  }
  while (cleanups.length) {
    try { cleanups.pop()?.(); } catch {}
  }
});

function sandbox(): { root: string; databasePath: string; importRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-import-inbox-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    databasePath: path.join(root, 'tracker.db'),
    importRoot: path.join(root, 'private-imports'),
  };
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeWorkbook(
  root: string,
  name = 'owner.xlsx',
  rowCount = 250,
  largeCellLength = 0,
  relationshipsXml?: string | null,
): string {
  const stage = path.join(root, `${name}-stage`);
  const rows = Array.from({ length: rowCount }, (_value, index) => {
    const row = index + 1;
    const firstValue = largeCellLength && row === 2 ? 'x'.repeat(largeCellLength) : row === 1 ? 'Region' : `R${row}`;
    return `<row r="${row}"><c r="A${row}" t="str"><v>${xml(firstValue)}</v></c><c r="B${row}" t="str"><v>${row === 1 ? 'Value' : String(row * 2)}</v></c></row>`;
  }).join('');
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationshipsXml === undefined
      ? '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      : relationshipsXml ?? '',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><dimension ref="A1:B${rowCount}"/><sheetData>${rows}</sheetData></worksheet>`,
  };
  if (relationshipsXml === null) delete entries['xl/_rels/workbook.xml.rels'];
  for (const [member, content] of Object.entries(entries)) {
    const target = path.join(stage, member);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const workbook = path.join(root, name);
  execFileSync('zip', ['-q', '-r', '-X', workbook, '.'], { cwd: stage });
  return workbook;
}

async function* chunks(bytes: Uint8Array, size = 997): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

function open(databasePath: string): StorageLayer {
  const storage = createStorage(databasePath);
  storage.initialize();
  storages.push(storage);
  return storage;
}

describe('Analytics Import Inbox', () => {
  it('stages exact private bytes, replays request identity, and stores an honest bounded preview without Data Room effects', async () => {
    const fixture = sandbox();
    const workbook = makeWorkbook(fixture.root);
    const source = fs.readFileSync(workbook);
    const expectedSha = createHash('sha256').update(source).digest('hex');
    const storage = open(fixture.databasePath);
    const db = storage.getDb();
    const beforeVersion = readAnalyticsDataRoomVersion(db);
    const service = createAnalyticsImportInbox({
      db,
      documentParser: createDocumentParser(),
      rootDir: fixture.importRoot,
      createId: () => 'a'.repeat(24),
    });

    const uploaded = await service.uploadXlsx({
      originalName: 'owner.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-0001',
      chunks: chunks(source),
    });
    expect(uploaded.importItem).toMatchObject({
      id: `dri_${'a'.repeat(24)}`,
      revision: 2,
      status: 'uploaded',
      originalName: 'owner.xlsx',
      sourceBytes: source.length,
      sourceSha256: expectedSha,
      sheets: ['Summary'],
      sheetCount: 1,
    });
    expect(uploaded.dataRoomVersion).not.toBe(beforeVersion);

    const candidateDirectory = path.join(fixture.importRoot, uploaded.importItem.id);
    const storedWorkbook = path.join(candidateDirectory, 'source.xlsx');
    expect(fs.readFileSync(storedWorkbook)).toEqual(source);
    expect(fs.statSync(fixture.importRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(candidateDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(storedWorkbook).mode & 0o777).toBe(0o600);

    const replay = await service.uploadXlsx({
      originalName: 'owner.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-0001',
      chunks: chunks(Buffer.from('different bytes are never consumed')),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.importItem.id).toBe(uploaded.importItem.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_import_inbox_items').get()).toEqual({ count: 1 });
    await expect(service.uploadXlsx({
      originalName: 'different.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-0001',
      chunks: chunks(source),
    })).rejects.toMatchObject({ code: 'conflict' });

    const inspected = await service.inspectSheet({
      importId: uploaded.importItem.id,
      expectedRevision: uploaded.importItem.revision,
      sheetName: 'Summary',
    });
    expect(inspected.importItem).toMatchObject({ revision: 4, status: 'ready', selectedSheet: 'Summary' });
    expect(inspected.importItem.preview).toMatchObject({
      sheetName: 'Summary',
      rowsShown: 200,
      rowsTotal: 250,
      complete: false,
      truncation: { rowsCut: true, charsCut: false, sharedStringsBudgetHit: false },
    });
    expect(inspected.importItem.preview?.rows[0]).toEqual(['Region', 'Value']);
    expect(inspected.importItem.preview?.limitations.join(' ')).toMatch(/not a complete typed dataset/i);
    await expect(service.inspectSheet({
      importId: uploaded.importItem.id,
      expectedRevision: 2,
      sheetName: 'Summary',
    })).rejects.toMatchObject({ code: 'conflict' });

    fs.appendFileSync(storedWorkbook, 'tamper');
    await expect(service.inspectSheet({
      importId: uploaded.importItem.id,
      expectedRevision: inspected.importItem.revision,
      sheetName: 'Summary',
    })).rejects.toMatchObject({ code: 'integrity_failed' });
    expect(service.get(uploaded.importItem.id)?.importItem).toMatchObject({ status: 'failed', revision: 6 });
    expect(service.get(uploaded.importItem.id)?.importItem.preview).toBeUndefined();
    expect(service.get(uploaded.importItem.id)?.importItem.selectedSheet).toBeUndefined();

    const safe = JSON.stringify(service.list());
    expect(safe).not.toContain(fixture.root);
    expect(safe).not.toContain('source_rel_path');
    expect(safe).not.toContain('request_identity_sha256');
    expect(service.list().sources.captured.status).toBe('unavailable');
    expect(service.list().sources.email.status).toBe('unavailable');
    const beforeSourceCapture = service.list().dataRoomVersion;
    db.prepare(`
      INSERT INTO work_items (id, type, source, url, metadata, captured_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('wi_import_xlsx', 'file', 'filesystem', 'file:///private/report.xlsx', JSON.stringify({ fileType: '.xlsx' }), '2026-09-22T01:00:00.000Z');
    db.prepare(`
      INSERT INTO work_items (id, type, source, metadata, captured_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('wi_import_mail', 'email', 'grasp', JSON.stringify({ hasAttachments: 'true' }), '2026-09-22T01:01:00.000Z');
    const afterSourceCapture = service.list();
    expect(afterSourceCapture.sources.captured.observedWorkbookCount).toBe(1);
    expect(afterSourceCapture.sources.email.reportedAttachmentMessages).toBe(1);
    expect(afterSourceCapture.dataRoomVersion).not.toBe(beforeSourceCapture);
    for (const table of [
      'analytics_datasets',
      'analytics_dataset_versions',
      'analytics_dataset_heads',
      'analytics_widget_dataset_bindings',
      'analytics_runs',
      'dashboard_publications',
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(0);
    }
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces the advertised character ceiling even when one worksheet cell is larger than the budget', async () => {
    const fixture = sandbox();
    const source = fs.readFileSync(makeWorkbook(fixture.root, 'wide.xlsx', 3, 30_000));
    const storage = open(fixture.databasePath);
    const service = createAnalyticsImportInbox({
      db: storage.getDb(),
      documentParser: createDocumentParser(),
      rootDir: fixture.importRoot,
      createId: () => 'f'.repeat(24),
    });
    const uploaded = await service.uploadXlsx({
      originalName: 'wide.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-wide-0001',
      chunks: chunks(source),
    });
    const inspected = await service.inspectSheet({
      importId: uploaded.importItem.id,
      expectedRevision: uploaded.importItem.revision,
      sheetName: 'Summary',
    });
    expect(inspected.importItem.preview?.charsShown).toBeLessThanOrEqual(20_000);
    expect(inspected.importItem.preview?.truncation.charsCut).toBe(true);
    expect(inspected.importItem.preview?.rows).toHaveLength(2);
    expect(inspected.importItem.preview?.rows[1][0].length).toBeLessThan(30_000);
  });

  it('persists a verified candidate across reopen and recovers interrupted state without inventing completion', async () => {
    const fixture = sandbox();
    const source = fs.readFileSync(makeWorkbook(fixture.root, 'restart.xlsx', 3));
    const firstStorage = open(fixture.databasePath);
    const first = createAnalyticsImportInbox({
      db: firstStorage.getDb(),
      documentParser: createDocumentParser(),
      rootDir: fixture.importRoot,
      createId: () => 'b'.repeat(24),
    });
    const uploaded = await first.uploadXlsx({
      originalName: 'restart.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-0002',
      chunks: chunks(source),
    });
    firstStorage.close();
    storages.pop();

    const secondStorage = open(fixture.databasePath);
    const second = createAnalyticsImportInbox({
      db: secondStorage.getDb(),
      documentParser: createDocumentParser(),
      rootDir: fixture.importRoot,
    });
    expect(second.get(uploaded.importItem.id)?.importItem).toMatchObject({
      id: uploaded.importItem.id,
      status: 'uploaded',
      revision: 2,
      sourceSha256: uploaded.importItem.sourceSha256,
    });

    secondStorage.getDb().prepare(`
      UPDATE analytics_import_inbox_items
      SET status = 'inspecting', revision = 3
      WHERE id = ?
    `).run(uploaded.importItem.id);

    const interruptedId = `dri_${'c'.repeat(24)}`;
    const interruptedCandidate = path.join(fixture.importRoot, interruptedId);
    const interruptedDirectory = path.join(interruptedCandidate, 'staging');
    fs.mkdirSync(interruptedDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(interruptedDirectory, 'partial'), 'partial', { mode: 0o600 });
    // Simulate the exact post-rename/pre-commit crash window: a receiving row
    // has finalized bytes but no committed byte/SHA receipt.
    fs.writeFileSync(path.join(interruptedCandidate, 'source.xlsx'), 'unreceipted-final', { mode: 0o600 });
    secondStorage.getDb().prepare(`
      INSERT INTO analytics_import_inbox_items (
        id, owner_request_id, request_identity_sha256, revision, status, source_kind,
        original_name, media_type, source_rel_path, created_at, updated_at
      ) VALUES (?, 'owner-upload-0003', ?, 1, 'receiving', 'upload', 'partial.xlsx', ?, ?, ?, ?)
    `).run(
      interruptedId,
      'd'.repeat(64),
      ANALYTICS_IMPORT_MEDIA_TYPE,
      `${interruptedId}/source.xlsx`,
      '2026-09-22T00:00:00.000Z',
      '2026-09-22T00:00:00.000Z',
    );
    expect(second.recoverInterrupted()).toBe(2);
    expect(second.get(uploaded.importItem.id)?.importItem).toMatchObject({
      status: 'uploaded',
      revision: 4,
      error: { code: 'aborted' },
    });
    expect(fs.existsSync(path.join(fixture.importRoot, uploaded.importItem.id, 'source.xlsx'))).toBe(true);
    expect(second.get(interruptedId)?.importItem).toMatchObject({
      status: 'failed',
      revision: 2,
      error: { code: 'aborted' },
    });
    expect(fs.existsSync(interruptedCandidate)).toBe(false);

    // A tampered source can never be restored to uploaded after an interrupted
    // inspection; recovery names integrity failure instead.
    fs.appendFileSync(path.join(fixture.importRoot, uploaded.importItem.id, 'source.xlsx'), 'tamper');
    secondStorage.getDb().prepare(`
      UPDATE analytics_import_inbox_items
      SET status = 'inspecting', revision = 5
      WHERE id = ?
    `).run(uploaded.importItem.id);
    expect(second.recoverInterrupted()).toBe(1);
    expect(second.get(uploaded.importItem.id)?.importItem).toMatchObject({
      status: 'failed',
      revision: 6,
      error: { code: 'integrity_failed' },
    });
    expect(secondStorage.getDb().pragma('quick_check', { simple: true })).toBe('ok');
  });

  it('fails closed on invalid bytes and aborts partial intake without retaining source bytes', async () => {
    const fixture = sandbox();
    const storage = open(fixture.databasePath);
    let ordinal = 0;
    const service = createAnalyticsImportInbox({
      db: storage.getDb(),
      documentParser: createDocumentParser(),
      rootDir: fixture.importRoot,
      createId: () => String(++ordinal).padStart(24, '0'),
      maxUploadBytes: 12,
    });

    await expect(service.uploadXlsx({
      originalName: 'invalid.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-0004',
      chunks: chunks(Buffer.from('not a zip')),
    })).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(service.uploadXlsx({
      originalName: 'oversized.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-0004-over',
      chunks: chunks(Buffer.alloc(13)),
    })).rejects.toMatchObject({ code: 'too_large' });

    const controller = new AbortController();
    async function* interrupted(): AsyncGenerator<Uint8Array> {
      yield Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      controller.abort();
      yield Buffer.alloc(100);
    }
    await expect(service.uploadXlsx({
      originalName: 'aborted.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-upload-0005',
      chunks: interrupted(),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'aborted' });

    const rows = storage.getDb().prepare(`
      SELECT status, source_sha256, source_bytes, error_code
      FROM analytics_import_inbox_items ORDER BY owner_request_id
    `).all();
    expect(rows).toEqual([
      { status: 'failed', source_sha256: null, source_bytes: null, error_code: 'invalid_input' },
      { status: 'failed', source_sha256: null, source_bytes: null, error_code: 'too_large' },
      { status: 'failed', source_sha256: null, source_bytes: null, error_code: 'aborted' },
    ]);
    expect(fs.readdirSync(fixture.importRoot).every(id => !fs.existsSync(path.join(fixture.importRoot, id, 'source.xlsx')))).toBe(true);
  });

  it('rejects missing or empty workbook relationship maps instead of relabeling sheets positionally', async () => {
    const fixture = sandbox();
    const storage = open(fixture.databasePath);
    let ordinal = 0;
    const service = createAnalyticsImportInbox({
      db: storage.getDb(),
      documentParser: createDocumentParser(),
      rootDir: fixture.importRoot,
      createId: () => (++ordinal).toString(16).padStart(24, 'a'),
    });
    const emptyRelationships = fs.readFileSync(makeWorkbook(
      fixture.root,
      'empty-rels.xlsx',
      2,
      0,
      '<Relationships/>',
    ));
    await expect(service.uploadXlsx({
      originalName: 'empty-rels.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-empty-rels-0001',
      chunks: chunks(emptyRelationships),
    })).rejects.toMatchObject({ code: 'invalid_input' });

    const missingRelationships = fs.readFileSync(makeWorkbook(
      fixture.root,
      'missing-rels.xlsx',
      2,
      0,
      null,
    ));
    await expect(service.uploadXlsx({
      originalName: 'missing-rels.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-missing-rels-0001',
      chunks: chunks(missingRelationships),
    })).rejects.toMatchObject({ code: 'invalid_input' });

    const wrongType = fs.readFileSync(makeWorkbook(
      fixture.root,
      'wrong-type.xlsx',
      2,
      0,
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="worksheets/sheet1.xml"/></Relationships>',
    ));
    await expect(service.uploadXlsx({
      originalName: 'wrong-type.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-wrong-rel-type-0001',
      chunks: chunks(wrongType),
    })).rejects.toMatchObject({ code: 'invalid_input' });

    const shadowedTarget = fs.readFileSync(makeWorkbook(
      fixture.root,
      'shadowed-target.xlsx',
      2,
      0,
      '<Relationships xmlns:x="urn:test"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" x:Target="worksheets/sheet1.xml" Target="styles.xml"/></Relationships>',
    ));
    await expect(service.uploadXlsx({
      originalName: 'shadowed-target.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-shadowed-target-0001',
      chunks: chunks(shadowedTarget),
    })).rejects.toMatchObject({ code: 'invalid_input' });

    const externalTarget = fs.readFileSync(makeWorkbook(
      fixture.root,
      'external-rel.xlsx',
      2,
      0,
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" TargetMode="External"/></Relationships>',
    ));
    await expect(service.uploadXlsx({
      originalName: 'external-rel.xlsx',
      mediaType: ANALYTICS_IMPORT_MEDIA_TYPE,
      requestId: 'owner-external-rel-0001',
      chunks: chunks(externalTarget),
    })).rejects.toMatchObject({ code: 'invalid_input' });

    expect(storage.getDb().prepare(`
      SELECT status, error_code, source_sha256 FROM analytics_import_inbox_items ORDER BY owner_request_id
    `).all()).toEqual([
      { status: 'failed', error_code: 'invalid_input', source_sha256: null },
      { status: 'failed', error_code: 'invalid_input', source_sha256: null },
      { status: 'failed', error_code: 'invalid_input', source_sha256: null },
      { status: 'failed', error_code: 'invalid_input', source_sha256: null },
      { status: 'failed', error_code: 'invalid_input', source_sha256: null },
    ]);
  });

  it('rejects unsupported filenames and media types before creating a candidate', async () => {
    const fixture = sandbox();
    const storage = open(fixture.databasePath);
    const service = createAnalyticsImportInbox({
      db: storage.getDb(),
      documentParser: createDocumentParser(),
      rootDir: fixture.importRoot,
    });
    const source = Buffer.from('unused');
    for (const input of [
      { originalName: '../escape.xlsx', mediaType: ANALYTICS_IMPORT_MEDIA_TYPE },
      { originalName: 'macro.xlsm', mediaType: ANALYTICS_IMPORT_MEDIA_TYPE },
      { originalName: 'book.xlsx', mediaType: 'application/octet-stream' },
    ]) {
      await expect(service.uploadXlsx({
        ...input,
        requestId: `owner-${Math.random().toString(16).slice(2)}`,
        chunks: chunks(source),
      })).rejects.toBeInstanceOf(AnalyticsImportInboxError);
    }
    expect(storage.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_import_inbox_items').get()).toEqual({ count: 0 });
  });
});
