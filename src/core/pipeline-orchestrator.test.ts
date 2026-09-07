import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createContentStore, refToColumns } from './content-store.js';
import { createBrainStore } from './brain-store.js';
import { createBatcher } from './batcher.js';
import { createFailureRecorder } from './failures.js';
import { createExtractor } from './extractor.js';
import { createLibrarian } from './librarian.js';
import { createBrainUpdater } from './brain-updater.js';
import { createReconciler } from './reconciler.js';
import { createProjectOrganizer } from './project-organizer.js';
import { createPipelineOrchestrator, isFullOrganizeDue } from './pipeline-orchestrator.js';
import type { DocumentParser } from './document-parser.js';
import type { OcrEngine, OcrResult } from './ocr-engine.js';
import type { PipelineLlm } from './pipeline-llm.js';

describe('PipelineOrchestrator', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-orch-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const parser = (text: string): DocumentParser => ({
    getSupportedFormats: () => ['.txt', '.md'],
    parse: (fp) => ({ success: true, text, filePath: fp, fileType: path.extname(fp) }),
  });
  const ocr: OcrEngine = {
    name: 'stub', isAvailable: () => true,
    async ocr(): Promise<OcrResult> { return { text: '', lines: [], aggConfidence: 0 }; },
    async ocrPdfPages(): Promise<OcrResult> { return { text: '', lines: [], aggConfidence: 0 }; },
  };

  function insertCaptured(id: string, filePath: string, source = 'filesystem') {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, metadata, process_state)
       VALUES (?, 'document_capture', ?, ?, ?, ?, 'captured')`,
    ).run(id, source, `title-${id}`, new Date().toISOString(), JSON.stringify({ filePath }));
  }

  function build(llm: PipelineLlm) {
    const db = storage.getDb();
    const contentStore = createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 });
    const failures = createFailureRecorder(db);
    const brainStore = createBrainStore(db, { brainsDir: path.join(dir, 'brains') });
    const batcher = createBatcher(db, { waveSize: 50, sizeTrigger: 1, ageTriggerMs: 60000 });
    const extractor = createExtractor({ db, documentParser: parser('extracted body'), ocrEngine: ocr, contentStore, failures });
    const librarian = createLibrarian({ db, batcher, contentStore, brainStore, failures, llm });
    const brainUpdater = createBrainUpdater({ db, contentStore, brainStore, failures, llm });
    const reconciler = createReconciler({ db, batcher, contentStore, brainStore, failures, llm });
    const organizer = createProjectOrganizer({ db, brainStore, failures, llm });
    return createPipelineOrchestrator({ db, extractor, batcher, librarian, brainUpdater, reconciler, organizer, brainStore, config: { extractionConcurrency: 2 } });
  }

  it('extraction tick processes at most `concurrency` items per call (bounded load)', async () => {
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `f${i}.txt`);
      writeFileSync(f, 'x');
      insertCaptured(`i${i}`, f);
    }
    const orch = build({ isAvailable: () => true, complete: async () => '[]' });

    const n1 = await orch.tickExtraction();
    expect(n1).toBe(2); // bounded to concurrency
    const extractedCount = (storage.getDb().prepare("SELECT COUNT(*) AS c FROM work_items WHERE process_state='extracted'").get() as any).c;
    expect(extractedCount).toBe(2);
  });

  it('runs a full extract → interpret cycle end to end', async () => {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'x');
    insertCaptured('a', f, 'manual');

    const llm: PipelineLlm = {
      isAvailable: () => true,
      complete: async (prompt) => {
        // Librarian prompt asks for an array; brain-updater asks for an object.
        if (prompt.includes('librarian')) {
          return JSON.stringify([{ itemId: 'a', decision: 'new', newTitle: 'Extracted Body Project' }]);
        }
        return JSON.stringify({ summary: 's', statusLine: 'active', tasks: [], blockers: [], people: [], newActivity: ['first activity'] });
      },
    };
    const orch = build(llm);

    await orch.tickExtraction();
    const res = await orch.tickInterpretation();
    expect(res.ran).toBe(true);

    const row = storage.getDb().prepare('SELECT process_state, project_id FROM work_items WHERE id = ?').get('a') as any;
    expect(row.process_state).toBe('routed');
    expect(row.project_id).toBeTruthy();
  });

  it('interpretation tick does not fire when nothing is pending', async () => {
    const orch = build({ isAvailable: () => true, complete: async () => '[]' });
    const res = await orch.tickInterpretation();
    expect(res.ran).toBe(false);
  });

  it('processAll drains extraction + routes everything in one call (ignores the timer gate)', async () => {
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `p${i}.txt`);
      writeFileSync(f, 'x');
      insertCaptured(`p${i}`, f, 'manual');
    }
    const llm: PipelineLlm = {
      isAvailable: () => true,
      complete: async (prompt) => {
        if (prompt.includes('librarian')) {
          // Route all wave items into one shared project.
          const ids = [...prompt.matchAll(/id=(p\d+)/g)].map((m) => m[1]);
          return JSON.stringify(ids.map((id) => ({ itemId: id, decision: 'new', newTitle: 'Extracted Body Batch' })));
        }
        return JSON.stringify({ summary: 's', statusLine: 'active', tasks: [], blockers: [], people: [], newActivity: ['x'] });
      },
    };
    const orch = build(llm);
    // Extraction is handled by the timer (not processAll) — drain it first.
    for (let i = 0; i < 5; i++) await orch.tickExtraction();
    const r = await orch.processAll();
    expect(r.routed + r.created).toBe(5); // all 5 extracted items routed
    const pending = (storage.getDb().prepare("SELECT COUNT(*) AS c FROM work_items WHERE process_state='extracted' AND project_id IS NULL").get() as any).c;
    expect(pending).toBe(0); // fully routed
  });

  it('interpretation defers (no state change) when the LLM is down', async () => {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'x');
    insertCaptured('a', f);
    const orch = build({ isAvailable: () => false, complete: async () => '' });
    await orch.tickExtraction(); // extraction is local, still works
    const res = await orch.tickInterpretation();
    expect(res.ran).toBe(false);
    const row = storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any;
    expect(row.process_state).toBe('extracted'); // not lost, awaiting LLM
  });
});

describe('isFullOrganizeDue (persistent full-organize schedule)', () => {
  let storage: StorageLayer;
  const HOUR = 60 * 60 * 1000;
  const INTERVAL = 3 * HOUR;
  const BACKOFF = 30 * 60 * 1000;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  /** Insert a pipeline_runs row with explicit timestamps (ms since epoch). */
  function insertRun(opts: {
    batchId: 'full' | 'assign-only';
    status: 'completed' | 'failed' | 'running';
    startedAtMs: number;
    completedAtMs?: number;
    /** SQLite's native datetime('now') format is space-separated UTC. */
    spaceSeparated?: boolean;
  }): void {
    const fmt = (ms: number) => {
      const iso = new Date(ms).toISOString();
      return opts.spaceSeparated ? iso.slice(0, 19).replace('T', ' ') : iso;
    };
    storage.getDb().prepare(
      "INSERT INTO pipeline_runs (id, pass, batch_id, status, started_at, completed_at) VALUES (?, 'organize', ?, ?, ?, ?)",
    ).run(
      `run_${Math.random().toString(36).slice(2, 10)}`,
      opts.batchId,
      opts.status,
      fmt(opts.startedAtMs),
      opts.completedAtMs !== undefined ? fmt(opts.completedAtMs) : null,
    );
  }

  it('is due immediately when no full pass has ever completed (the restart starvation fix)', () => {
    expect(isFullOrganizeDue(storage.getDb(), Date.now(), INTERVAL, BACKOFF)).toBe(true);
  });

  it('is not due when a full pass completed within the interval', () => {
    const now = Date.now();
    insertRun({ batchId: 'full', status: 'completed', startedAtMs: now - HOUR, completedAtMs: now - HOUR });
    expect(isFullOrganizeDue(storage.getDb(), now, INTERVAL, BACKOFF)).toBe(false);
  });

  it('is due when the last completed full pass is older than the interval', () => {
    const now = Date.now();
    insertRun({ batchId: 'full', status: 'completed', startedAtMs: now - 4 * HOUR, completedAtMs: now - 4 * HOUR });
    expect(isFullOrganizeDue(storage.getDb(), now, INTERVAL, BACKOFF)).toBe(true);
  });

  it('parses SQLite space-separated UTC timestamps (datetime(\'now\') format)', () => {
    const now = Date.now();
    insertRun({ batchId: 'full', status: 'completed', startedAtMs: now - HOUR, completedAtMs: now - HOUR, spaceSeparated: true });
    expect(isFullOrganizeDue(storage.getDb(), now, INTERVAL, BACKOFF)).toBe(false);
    // Were the timestamp misread as LOCAL time (the classic trap), a
    // UTC+ offset would make it look like the future or hours stale —
    // an overdue row must still read as due.
    const db2 = storage.getDb();
    db2.prepare('DELETE FROM pipeline_runs').run();
    insertRun({ batchId: 'full', status: 'completed', startedAtMs: now - 4 * HOUR, completedAtMs: now - 4 * HOUR, spaceSeparated: true });
    expect(isFullOrganizeDue(db2, now, INTERVAL, BACKOFF)).toBe(true);
  });

  it('holds back while a recent attempt is inside the retry backoff (failed runs do not hot-loop)', () => {
    const now = Date.now();
    insertRun({ batchId: 'full', status: 'completed', startedAtMs: now - 4 * HOUR, completedAtMs: now - 4 * HOUR });
    insertRun({ batchId: 'full', status: 'failed', startedAtMs: now - 5 * 60 * 1000 });
    expect(isFullOrganizeDue(storage.getDb(), now, INTERVAL, BACKOFF)).toBe(false);
    // …and retries once the backoff has elapsed.
    expect(isFullOrganizeDue(storage.getDb(), now + BACKOFF, INTERVAL, BACKOFF)).toBe(true);
  });

  it('ignores assign-only runs entirely', () => {
    const now = Date.now();
    insertRun({ batchId: 'assign-only', status: 'completed', startedAtMs: now - HOUR, completedAtMs: now - HOUR });
    expect(isFullOrganizeDue(storage.getDb(), now, INTERVAL, BACKOFF)).toBe(true);
  });
});
