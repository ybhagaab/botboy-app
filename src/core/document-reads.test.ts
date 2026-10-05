import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, getSetting, type StorageLayer } from './storage.js';
import { createContentStore, refToColumns, type ContentStore } from './content-store.js';
import { createBrainStore, newBrain, type BrainStore } from './brain-store.js';
import { createFailureRecorder } from './failures.js';
import { createBrainUpdater, type BrainUpdater } from './brain-updater.js';
import type { PipelineLlm } from './pipeline-llm.js';
import {
  DOCUMENT_DIFF_PROMPT_VERSION,
  DOCUMENT_PART_PROMPT_VERSION,
  createDocumentReads,
  documentKeyOf,
  isLargeDocument,
  nextDocumentPart,
  type DocumentReads,
} from './document-reads.js';
import { isRawFileText } from './raw-file-text.js';

/**
 * Policy C (owner decisions 2026-10-03/04): a document longer than one brain
 * call can show is read into its project brain in parts on idle ticks; a
 * later version is read as its changes; one longer than 40 parts keeps its
 * excerpt until the owner asks; existing long documents get one full read.
 */

describe('nextDocumentPart', () => {
  it('ends parts at paragraph breaks, then line breaks, and returns the rest whole', () => {
    const text = `${'a'.repeat(70)}\n\n${'b'.repeat(20)}\n${'c'.repeat(30)}`;
    expect(nextDocumentPart(text, 0, 100)).toEqual({ start: 0, end: 72, text: `${'a'.repeat(70)}\n\n` });
    expect(nextDocumentPart(text, 72, 100)).toMatchObject({ start: 72, end: text.length });
    const lines = `${'x'.repeat(80)}\n${'y'.repeat(80)}`;
    expect(nextDocumentPart(lines, 0, 100).end).toBe(81);
  });

  it('never cuts inside a surrogate pair', () => {
    const text = `${'a'.repeat(99)}😀${'b'.repeat(50)}`;
    const part = nextDocumentPart(text, 0, 100);
    expect(part.end).toBe(99);
  });
});

describe('document identity', () => {
  it('keys a document by its SharePoint docKey, local path, or Slack file, else the item', () => {
    expect(documentKeyOf({ id: 'a', source: 'sharepoint', metadata: { docKey: 'host/Doc.docx', filePath: '/x' } })).toBe('sharepoint:host/Doc.docx');
    expect(documentKeyOf({ id: 'b', source: 'filesystem', metadata: { filePath: '/w/plan.pdf' } })).toBe('file:/w/plan.pdf');
    expect(documentKeyOf({ id: 'c', source: 'slack', metadata: { fileId: 'F123' } })).toBe('slack:F123');
    expect(documentKeyOf({ id: 'd', source: 'browser', metadata: {} })).toBe('item:d');
    expect(isLargeDocument({ type: 'document_capture', content: 'x'.repeat(128_001) })).toBe(true);
    expect(isLargeDocument({ type: 'document_capture', content: 'x'.repeat(128_000) })).toBe(false);
    expect(isLargeDocument({ type: 'slack_message', content: 'x'.repeat(200_000) })).toBe(false);
  });

  it('tells raw file bytes from extracted text', () => {
    const control = String.fromCharCode(1);
    expect(isRawFileText(`%PDF-1.3\n%${'x'.repeat(200_000)}`)).toBe(true);
    expect(isRawFileText(`  %PDF-1.4 ${'y'.repeat(10)}`)).toBe(true);
    expect(isRawFileText(`PK${String.fromCharCode(3, 4)}${`${control}data`.repeat(1_000)}`)).toBe(true);
    // Tabs, line breaks, and form feeds are text; an odd control character is not a file.
    expect(isRawFileText(`--- sheet1 ---\nname\tvalue\r\n\f${'row\t1\n'.repeat(20_000)}${control.repeat(10)}`)).toBe(false);
    expect(isRawFileText('Page one of the plan.\f'.repeat(5_000))).toBe(false);
    expect(isRawFileText('a Windows line\r\n'.repeat(5_000))).toBe(false);
    expect(isRawFileText(`${'plain text '.repeat(1_000)}${`${control}bytes`.repeat(2_000)}${'plain text '.repeat(10_000)}`)).toBe(true);
    expect(isRawFileText(`The PDF spec says %PDF-1.7 starts a file. ${'text '.repeat(100)}`)).toBe(false);
    expect(isLargeDocument({ type: 'document_capture', content: `%PDF-1.3\n${'x'.repeat(200_000)}` })).toBe(false);
  });
});

describe('long documents in project brains', () => {
  let storage: StorageLayer;
  let dir: string;
  let store: ContentStore;
  let brains: BrainStore;
  let prompts: string[];
  let budgetTokens: number;
  let available: boolean;
  let failNext: number;
  let duringCall: (() => void) | null;
  let reads: DocumentReads;
  let updater: BrainUpdater;
  const PROJECT = 'proj_kestrel';

  function db() { return storage.getDb(); }

  const llm: PipelineLlm = {
    isAvailable: () => available,
    getContextBudgetTokens: () => budgetTokens,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      duringCall?.();
      if (failNext > 0) { failNext--; throw new Error('gateway 502'); }
      return JSON.stringify({
        summary: `### Kestrel launch plan\n- Brief after call ${prompts.length} of the Kestrel launch plan review.`,
        statusLine: 'active', tasks: [], blockers: [], people: [], newActivity: [],
      });
    },
  };

  /** A document whose text names the project once per paragraph, with a marker per paragraph. */
  function documentText(paragraphs: number, opts: { anchor?: boolean; prefix?: string } = {}): string {
    const parts: string[] = [];
    for (let index = 0; index < paragraphs; index++) {
      const anchor = opts.anchor === false ? 'quarterly figures' : 'Kestrel launch plan';
      parts.push(`${opts.prefix ?? 'para'}${String(index).padStart(5, '0')} ${anchor} detail ${'lorem ipsum dolor sit amet '.repeat(36)}`);
    }
    return parts.join('\n\n');
  }

  function insertDoc(id: string, text: string, opts: { docKey?: string; capturedAt?: string; batchId?: string; state?: string; projectId?: string; metadata?: Record<string, unknown>; title?: string } = {}): void {
    const cols = refToColumns(store.put(id, text));
    db().prepare(`
      INSERT INTO work_items (id, type, source, title, captured_at, process_state, project_id, batch_id,
        raw_text, content_storage, content_path, content_sha256, content_bytes, metadata)
      VALUES (?, 'document_capture', 'sharepoint', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.title ?? 'Kestrel launch plan.docx', opts.capturedAt ?? '2026-10-01T00:00:00Z', opts.state ?? 'routed',
      opts.projectId ?? PROJECT, opts.batchId ?? null,
      cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
      JSON.stringify({ docKey: opts.docKey ?? 'host/sites/team/Kestrel launch plan.docx', ...(opts.metadata ?? {}) }),
    );
  }

  function insertSlack(id: string, text: string, batchId: string): void {
    const cols = refToColumns(store.put(id, text));
    db().prepare(`
      INSERT INTO work_items (id, type, source, title, captured_at, process_state, project_id, batch_id,
        raw_text, content_storage, content_path, content_sha256, content_bytes, metadata)
      VALUES (?, 'slack_message', 'slack', 'DM', '2026-10-01T00:00:00Z', 'routed', ?, ?, ?, ?, ?, ?, ?, '{"direction":"sent","channelType":"dm"}')
    `).run(id, PROJECT, batchId, cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
  }

  function readRow() {
    return db().prepare('SELECT * FROM brain_document_reads WHERE project_id = ?').get(PROJECT) as {
      item_id: string; base_item_id: string | null; mode: string; status: string; next_offset: number; parts_done: number; attempts: number; reason: string | null; text_chars: number;
    } | undefined;
  }

  function promptVersions(): string[] {
    return (db().prepare("SELECT prompt_version AS v FROM pipeline_llm_audit WHERE pass = 'brain' ORDER BY rowid").all() as Array<{ v: string }>).map((row) => row.v);
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-doc-reads-'));
    store = createContentStore(db(), { contentDir: dir, inlineThresholdBytes: 1024 });
    brains = createBrainStore(db(), { brainsDir: path.join(dir, 'brains') });
    brains.write(newBrain(PROJECT, 'Kestrel Launch Plan'));
    prompts = [];
    budgetTokens = 100_000;
    available = true;
    failNext = 0;
    duringCall = null;
    reads = createDocumentReads({ db: db(), contentStore: store, brainStore: brains, llm });
    updater = createBrainUpdater({ db: db(), contentStore: store, brainStore: brains, failures: createFailureRecorder(db()), llm, documentReads: reads });
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function readAll(): Promise<number> {
    let parts = 0;
    for (let guard = 0; guard < 20; guard++) {
      const tick = await reads.tick(updater);
      if (!tick.ran) break;
      parts++;
    }
    return parts;
  }

  it('leaves a long document out of its batch, then reads it in order, one part per tick', async () => {
    // Its second half never names the project: scope is judged once, on the whole document.
    const text = `${documentText(250)}\n\n${documentText(250, { anchor: false, prefix: 'tail' })}`;
    insertDoc('doc1', text, { batchId: 'b1' });
    insertSlack('s1', 'Kestrel launch plan: I will ship the review deck', 'b1');
    // The seeding pass found nothing (no long document was routed before the batch).
    expect(updater.partBudgetChars(PROJECT)).toBe(220_000);

    await updater.runForBatch('b1');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('I will ship the review deck');
    expect(prompts[0]).not.toContain('para00000');
    expect(readRow()).toMatchObject({ item_id: 'doc1', mode: 'full', status: 'reading', next_offset: 0 });

    const parts = await readAll();
    expect(parts).toBe(Math.ceil(text.length / 220_000));
    const partPrompts = prompts.slice(1);
    expect(partPrompts[0]).toContain('DOCUMENT READING:');
    expect(partPrompts[0]).toContain(`part 1 of ${parts} of this document (characters 1–`);
    expect(partPrompts[0]).toContain('para00000');
    expect(partPrompts[0]).not.toContain('tail00249');
    expect(partPrompts[parts - 1]).toContain('tail00249');
    // Each part is shown whole, never excerpted again.
    expect(partPrompts.every((prompt) => !prompt.includes('balanced excerpt') && prompt.includes('; complete: '))).toBe(true);
    // Every character is read once, in order.
    const shown = partPrompts.map((prompt) => prompt.match(/characters ([\d,]+)–([\d,]+) of ([\d,]+)/)!.slice(1).map((n) => Number(n.replace(/,/g, ''))));
    expect(shown[0][0]).toBe(1);
    for (let index = 1; index < shown.length; index++) expect(shown[index][0]).toBe(shown[index - 1][1] + 1);
    expect(shown.at(-1)![1]).toBe(text.length);
    expect(promptVersions().slice(1).every((version) => version === DOCUMENT_PART_PROMPT_VERSION)).toBe(true);
    expect(readRow()).toMatchObject({ status: 'done', parts_done: parts, next_offset: text.length });
    expect(brains.read(PROJECT)!.summary).toContain(`Brief after call ${prompts.length}`);
    expect(await reads.tick(updater)).toEqual({ ran: false });
  });

  it('reads a later version as its changes, and in full again when most of it changed', async () => {
    const v1 = documentText(400);
    insertDoc('v1', v1, { batchId: 'b1' });
    await updater.runForBatch('b1');
    await readAll();
    prompts.length = 0;

    const v2 = v1.replace('para00200 Kestrel launch plan detail', 'para00200 Kestrel launch plan REVISED budget line');
    insertDoc('v2', v2, { capturedAt: '2026-10-02T00:00:00Z' });
    expect(await updater.updateProject(PROJECT, ['v2'])).toMatchObject({ status: 'skipped', skipReason: 'document_read_queued' });
    expect(readRow()).toMatchObject({ item_id: 'v2', base_item_id: 'v1', mode: 'diff', status: 'reading' });
    expect(await readAll()).toBe(1);
    expect(prompts[0]).toContain('CHANGES since the version this brain last read');
    expect(prompts[0]).toContain('+ para00200 Kestrel launch plan REVISED budget line');
    expect(prompts[0]).not.toContain('para00300');
    expect(prompts[0].length).toBeLessThan(60_000);
    expect(promptVersions().at(-1)).toBe(DOCUMENT_DIFF_PROMPT_VERSION);
    expect(readRow()).toMatchObject({ item_id: 'v2', status: 'done', mode: 'diff' });

    // A version that changed nothing finishes without a model call.
    insertDoc('v3', v2, { capturedAt: '2026-10-03T00:00:00Z' });
    await updater.updateProject(PROJECT, ['v3']);
    prompts.length = 0;
    expect(await reads.tick(updater)).toMatchObject({ ran: false, outcome: 'done' });
    expect(prompts).toEqual([]);
    expect(readRow()).toMatchObject({ item_id: 'v3', status: 'done', reason: 'no text changed' });

    // Most of it rewritten: read in full again.
    insertDoc('v4', documentText(400, { prefix: 'new' }), { capturedAt: '2026-10-04T00:00:00Z' });
    await updater.updateProject(PROJECT, ['v4']);
    await reads.tick(updater);
    expect(prompts[0]).toContain('part 1 of');
    expect(readRow()).toMatchObject({ item_id: 'v4', mode: 'full', reason: 'more than half of it changed' });
  });

  it('reads a resumed file in full even after a complete read', async () => {
    insertDoc('v1', documentText(300), { batchId: 'b1' });
    await updater.runForBatch('b1');
    await readAll();
    insertDoc('v2', documentText(300).replace('para00001', 'para00001 changed'), { capturedAt: '2026-10-02T00:00:00Z', metadata: { briefRead: 'full' } });
    await updater.updateProject(PROJECT, ['v2']);
    expect(readRow()).toMatchObject({ item_id: 'v2', mode: 'full', base_item_id: null, reason: 'owner resumed the file' });
  });

  it('keeps the excerpt of a document longer than 40 parts until the owner asks for a full read', async () => {
    budgetTokens = 20_000; // a part of about 30k characters, so 40 parts is about 1.2M
    const budget = updater.partBudgetChars(PROJECT);
    expect(budget).toBeGreaterThan(20_000);
    const text = documentText(Math.ceil((41 * budget) / 1_000));
    expect(text.length).toBeGreaterThan(40 * budget);
    insertDoc('big', text, { batchId: 'b1' });
    await updater.runForBatch('b1');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('balanced excerpt');
    expect(readRow()).toMatchObject({ item_id: 'big', status: 'sample', mode: 'sample' });
    expect(await reads.tick(updater)).toEqual({ ran: false });

    const requested = reads.readInFull(PROJECT, 'big');
    expect(requested).toMatchObject({ ok: true, info: { status: 'reading', mode: 'full', reason: 'owner_requested' } });
    expect(await reads.tick(updater)).toMatchObject({ ran: true, part: 1 });
    expect(prompts.at(-1)).toContain('part 1 of');
    expect(reads.readInFull('proj_other', 'big')).toMatchObject({ ok: false, status: 404 });
  });

  it('retries a failing part three times, then stops and offers a full read', async () => {
    insertDoc('doc1', documentText(300), { batchId: 'b1' });
    await updater.runForBatch('b1');
    failNext = 5;
    for (let index = 0; index < 3; index++) await reads.tick(updater);
    expect(readRow()).toMatchObject({ status: 'failed', attempts: 3, next_offset: 0 });
    expect(await reads.tick(updater)).toEqual({ ran: false });
    expect(reads.forProject(PROJECT).get('doc1')).toMatchObject({ status: 'failed', reason: 'the model failed on part 1' });
  });

  it('restarts the read on a version that arrives while a part is being read', async () => {
    insertDoc('v1', documentText(300), { batchId: 'b1' });
    await updater.runForBatch('b1');
    insertDoc('v2', documentText(300, { prefix: 'other' }), { capturedAt: '2026-10-02T00:00:00Z' });
    duringCall = () => { duringCall = null; reads.enqueue(PROJECT, { id: 'v2', type: 'document_capture', source: 'sharepoint', content: documentText(300, { prefix: 'other' }), metadata: { docKey: 'host/sites/team/Kestrel launch plan.docx' } }, 10_000_000); };
    await reads.tick(updater);
    // v1's part was read, but its progress no longer applies: v2 starts from the beginning.
    expect(readRow()).toMatchObject({ item_id: 'v2', mode: 'full', next_offset: 0, parts_done: 0, status: 'reading' });
  });

  it('stops without a model call when the document is outside the project scope, or the model is down', async () => {
    available = false;
    insertDoc('doc1', documentText(300, { anchor: false }), { batchId: 'b1', title: 'quarterly.docx' });
    await updater.runForBatch('b1');
    expect(await reads.tick(updater)).toEqual({ ran: false });
    expect(readRow()).toMatchObject({ status: 'reading' });
    available = true;
    await reads.tick(updater);
    expect(prompts).toEqual([]);
    expect(readRow()).toMatchObject({ status: 'skipped', reason: "outside this project's scope" });
  });

  it('seeds one full read of each long document routed before parts, newest version only, once', async () => {
    brains.write(newBrain('proj_archived', 'Archived Kestrel'));
    db().prepare("UPDATE projects SET status = 'archived' WHERE id = 'proj_archived'").run();
    insertDoc('old', documentText(300), { capturedAt: '2026-09-01T00:00:00Z' });
    insertDoc('new', documentText(301), { capturedAt: '2026-09-02T00:00:00Z' });
    insertDoc('other', documentText(300), { docKey: 'host/other.docx', capturedAt: '2026-09-03T00:00:00Z' });
    insertDoc('small', 'Kestrel launch plan short note '.repeat(100), { docKey: 'host/small.docx' });
    insertDoc('gone', documentText(300), { docKey: 'host/gone.docx', projectId: 'proj_archived' });
    available = false; // seeding needs no model
    await reads.tick(updater);
    const rows = db().prepare('SELECT doc_key AS docKey, item_id AS itemId, status FROM brain_document_reads ORDER BY doc_key').all();
    expect(rows).toEqual([
      { docKey: 'sharepoint:host/other.docx', itemId: 'other', status: 'reading' },
      { docKey: 'sharepoint:host/sites/team/Kestrel launch plan.docx', itemId: 'new', status: 'reading' },
    ]);
    expect(getSetting(db(), 'brain_document_reads.seeded.v1')).toMatchObject({ reading: 2, sample: 0 });
    db().prepare('DELETE FROM brain_document_reads').run();
    await reads.tick(updater);
    expect(db().prepare('SELECT COUNT(*) AS c FROM brain_document_reads').get()).toEqual({ c: 0 });
  });

  it('never seeds an older long version when the newest version fit its batch', async () => {
    insertDoc('long-old', documentText(300), { capturedAt: '2026-09-01T00:00:00Z' });
    insertDoc('short-new', 'Kestrel launch plan, trimmed to one page. '.repeat(50), { capturedAt: '2026-09-02T00:00:00Z' });
    available = false;
    await reads.tick(updater);
    expect(db().prepare('SELECT COUNT(*) AS c FROM brain_document_reads').get()).toEqual({ c: 0 });
    expect(getSetting(db(), 'brain_document_reads.seeded.v1')).toMatchObject({ reading: 0, sample: 0 });
  });

  it('seeds without holding the event loop: one document loaded per turn', async () => {
    for (const [index, name] of ['a', 'b', 'c'].entries()) {
      insertDoc(name, documentText(300), { docKey: `host/${name}.docx`, capturedAt: `2026-09-0${index + 1}T00:00:00Z` });
    }
    const events: string[] = [];
    const get = store.get.bind(store);
    store.get = (ref) => { events.push('load'); return get(ref); };
    let turns = 0;
    const spin = () => { events.push('turn'); if (++turns < 100) setImmediate(spin); };
    setImmediate(spin);
    available = false;
    await reads.tick(updater);
    const loads = events.flatMap((event, index) => (event === 'load' ? [index] : []));
    expect(loads).toHaveLength(3);
    expect(events.slice(0, loads[0])).toContain('turn');
    for (let index = 1; index < loads.length; index++) expect(events.slice(loads[index - 1], loads[index])).toContain('turn');
  });

  it('reads one text once per project, however many names it has', async () => {
    const text = documentText(300);
    insertDoc('slack-copy', text, { docKey: 'host/slack/Kestrel launch plan.docx', capturedAt: '2026-09-02T00:00:00Z' });
    insertDoc('downloads-copy', text, { docKey: 'host/downloads/Kestrel launch plan.docx', capturedAt: '2026-09-01T00:00:00Z' });
    expect(await readAll()).toBe(2);
    const rows = () => db().prepare('SELECT item_id AS itemId, status, parts_done AS partsDone, reason FROM brain_document_reads ORDER BY item_id').all();
    expect(rows()).toEqual([
      { itemId: 'downloads-copy', status: 'done', partsDone: 0, reason: 'same text as Kestrel launch plan.docx, read already' },
      { itemId: 'slack-copy', status: 'done', partsDone: 2, reason: null },
    ]);
    expect(prompts).toHaveLength(2);

    // The owner can still ask for it.
    reads.readInFull(PROJECT, 'downloads-copy');
    expect(await readAll()).toBe(2);

    // Read only in another project, or by copies that have since left this
    // one (orphaned, or moved elsewhere): this brain has not read it.
    db().prepare("UPDATE work_items SET project_id = 'proj_elsewhere' WHERE id = 'slack-copy'").run();
    db().prepare("UPDATE brain_document_reads SET project_id = 'proj_elsewhere' WHERE item_id = 'slack-copy'").run();
    db().prepare("UPDATE work_items SET process_state = 'orphaned' WHERE id = 'downloads-copy'").run();
    insertDoc('moved-copy', text, { docKey: 'host/moved/Kestrel launch plan.docx', projectId: 'proj_elsewhere' });
    insertDoc('failed-copy', text, { docKey: 'host/failed/Kestrel launch plan.docx' });
    const insertRead = db().prepare(`INSERT INTO brain_document_reads (project_id, doc_key, item_id, mode, status, queued_at, updated_at)
      VALUES (?, ?, ?, 'full', ?, '2026-09-01', '2026-09-01')`);
    insertRead.run(PROJECT, 'sharepoint:host/moved/Kestrel launch plan.docx', 'moved-copy', 'done');
    insertRead.run(PROJECT, 'sharepoint:host/failed/Kestrel launch plan.docx', 'failed-copy', 'failed');
    const third = { id: 'third-copy', type: 'document_capture', source: 'sharepoint', content: text, metadata: { docKey: 'host/third/Kestrel launch plan.docx' } };
    insertDoc('third-copy', text, { docKey: third.metadata.docKey, capturedAt: '2026-09-03T00:00:00Z' });
    reads.enqueue(PROJECT, third, 10_000_000);
    prompts.length = 0;
    expect(await reads.tick(updater)).toMatchObject({ ran: true, part: 1 });
    expect(prompts).toHaveLength(1);
  });

  it('never reads a document stored as raw file bytes in parts', async () => {
    // Captures from before local parsing stored some PDFs as their bytes.
    const raw = `%PDF-1.3\n%\u00e2\u00e3\n5 0 obj << /Filter /FlateDecode >> stream\n${'Kestrel launch plan x\u00ff\u00fe '.repeat(12_000)}`;
    insertDoc('raw-old', raw, { docKey: 'host/raw-old.pdf' });
    available = false;
    await reads.tick(updater);
    expect(db().prepare('SELECT COUNT(*) AS c FROM brain_document_reads').get()).toEqual({ c: 0 });

    // A batch keeps its excerpt, as before parts.
    available = true;
    insertDoc('raw-new', raw, { docKey: 'host/raw-new.pdf', batchId: 'b1' });
    await updater.runForBatch('b1');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('balanced excerpt');
    expect(db().prepare('SELECT COUNT(*) AS c FROM brain_document_reads').get()).toEqual({ c: 0 });

    // A read queued before this rule stops without a model call; the owner cannot start one.
    reads.enqueue(PROJECT, { id: 'raw-old', type: 'document_capture', source: 'sharepoint', content: raw, metadata: { docKey: 'host/raw-old.pdf' } }, 10_000_000);
    prompts.length = 0;
    expect(await reads.tick(updater)).toMatchObject({ ran: false, outcome: 'skipped' });
    expect(prompts).toEqual([]);
    expect(readRow()).toMatchObject({ status: 'skipped', reason: 'stored as raw file bytes, not text' });
    expect(reads.readInFull(PROJECT, 'raw-old')).toMatchObject({ ok: false, status: 409 });
  });

  it('never defers a document in a rebuild: rebuilds publish once and keep excerpts', async () => {
    insertDoc('doc1', documentText(300));
    const staged = await updater.stageProject(PROJECT, ['doc1'], newBrain(PROJECT, 'Kestrel Launch Plan'));
    expect(staged.status).toBe('updated');
    expect(prompts[0]).toContain('balanced excerpt');
    expect(readRow()).toBeUndefined();
  });
});
