import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createDocumentParser } from '../core/document-parser.js';
import {
  createFilesystemMonitor,
  type FilesystemMonitor,
} from '../monitors/filesystem-monitor.js';
import { createRouter } from './routes.js';
import type { RawWorkItem } from '../core/types.js';

/**
 * End-to-end integration test for the local-folders feature.
 *
 * Boots Express with the real router, real `FilesystemMonitor` (chokidar
 * UNMOCKED — we want real fs events), real document parser, real in-memory
 * SQLite, and a tmpdir under `$HOME`. Drives the full lifecycle:
 *
 *   1. POST /api/local-folders → write a fresh `.md` file → assert the
 *      monitor's `onWorkItem` callback fires with `source: 'filesystem'`
 *      and `metadata.filePath` pointing at the new file.
 *   2. Pre-create a file → POST → POST /backfill → assert the SSE stream
 *      contains a `done` event with `total >= 1` and `onWorkItem` fired
 *      for the pre-existing file.
 *   3. DELETE /api/local-folders/:id → modify a file in the (now-untracked)
 *      folder → assert NO new work item is emitted.
 *
 * Validates: Requirements 4.4, 4.5, 5.2, 5.3, 6.1, 6.2
 */

// ── SSE helpers (mirrors routes.local-folders.backfill.test.ts) ────────────

interface SSEEvent {
  event: string;
  data: any;
}

/**
 * Parse a buffered SSE text payload into an ordered list of `{ event, data }`
 * records. The route emits `event: <phase>` plus `data: <json>` separated by
 * a blank line, so we split on `\n\n` and walk each block.
 */
function parseSSE(text: string): SSEEvent[] {
  const out: SSEEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let parsed: any = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // leave as string
    }
    out.push({ event, data: parsed });
  }
  return out;
}

/**
 * Buffer an SSE response into a string. supertest stores the parsed value on
 * `res.body` when a custom parser is provided.
 */
function bufferSSE(req: request.Test): request.Test {
  return req.buffer(true).parse((response, cb) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
    response.on('error', (err) => cb(err, ''));
  });
}

/**
 * Poll `predicate` every 25 ms until it returns `true` or the timeout
 * expires. Used to await the chokidar event loop without sleeping for a
 * fixed (and brittle) duration.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Sleep for `ms`. Used to assert "no event fires within the window" — the
 * inverse of `waitFor`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('Local folders end-to-end integration', () => {
  let storage: StorageLayer;
  let monitor: FilesystemMonitor;
  let app: express.Express;
  let tmpdir: string;
  let emits: RawWorkItem[];

  beforeEach(() => {
    // Real in-memory SQLite — initialize() runs the schema migrations
    // including the `local_folders` table created in task 1.1.
    storage = createStorage(':memory:');
    storage.initialize();

    // tmpdir under $HOME so the inside-home guard in `addLocalFolder` is
    // satisfied. We deliberately use a non-dot prefix (`test-lf-…` rather
    // than `.test-lf-…`) because the FilesystemMonitor's `STATIC_IGNORES`
    // includes a dotfile regex `/(^|[/\\])\..*/` that chokidar evaluates
    // against the FULL path of every event — so a watched root whose
    // basename starts with `.` (e.g. `~/.test-lf-XXXX/`) would cause every
    // event under it to match that regex and be silently dropped by
    // chokidar before reaching `handleAddOrChange`. (The backfill walker
    // re-implements the same ignore set basename-only and is unaffected,
    // which is why the SSE test still works under either prefix.)
    tmpdir = fs.mkdtempSync(path.join(os.homedir(), 'test-lf-integration-'));

    // Real monitor — chokidar is NOT mocked here. We want the real fs
    // event pipeline so this test catches regressions the unit tests miss
    // (e.g. an attachWatcher config change that breaks live ingestion).
    const documentParser = createDocumentParser();
    monitor = createFilesystemMonitor({
      db: storage.getDb(),
      documentParser,
    });

    emits = [];
    monitor.onWorkItem((item) => {
      emits.push(item);
    });

    app = express();
    app.use(express.json());
    app.use(
      '/api',
      createRouter({
        nodeManager: {} as any,
        db: storage.getDb(),
        filesystemMonitor: monitor,
      }),
    );
  });

  afterEach(async () => {
    // stop() closes every chokidar watcher and clears state. Always-await
    // so we don't leak fds across tests.
    try {
      await monitor.stop();
    } catch {
      // best-effort
    }
    storage.close();
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /**
   * Validates: Requirements 4.5, 5.2, 5.3, 6.1
   *
   * The full live-ingestion path: POST registers the folder and the route
   * awaits `setWatchedFolders` before responding (Requirement 4.5), so by
   * the time the 201 lands chokidar is mounted on the directory. Writing a
   * supported file then triggers an `add` event that flows through the
   * filter chain and lands in `onWorkItem` with the canonical
   * `source: 'filesystem'` shape and `metadata.filePath` echoing the
   * absolute path of the file we wrote.
   */
  it('POST /api/local-folders → writing a .md file fires onWorkItem with source filesystem', { timeout: 20000 }, async () => {
    // Register the folder. The route awaits setWatchedFolders → chokidar
    // is constructed by the time the 201 arrives, but its internal `ready`
    // event still fires asynchronously. The poll-on-emit strategy below
    // tolerates that latency without a fixed sleep.
    const res = await request(app)
      .post('/api/local-folders')
      .send({ path: tmpdir });

    expect(res.status).toBe(201);
    expect(res.body.folder).toMatchObject({
      // The route stores the realpath-canonicalized form, so we compare
      // against the same canonicalization here.
      path: fs.realpathSync(tmpdir),
      enabled: true,
    });

    // Give chokidar a moment to finish its initial scan and be ready to
    // observe new entries. With `ignoreInitial: true` this is fast (no
    // existing files to enumerate) but still not synchronous.
    await sleep(300);

    const filePath = path.join(tmpdir, 'note.md');
    fs.writeFileSync(filePath, '# Hello\n\nFrom integration test.\n');

    // Wait up to 5s for the work item to appear. chokidar's
    // `awaitWriteFinish` adds a 500ms stability window, plus the parser
    // and emit chain — anything under a couple seconds is normal.
    await waitFor(() => emits.length > 0, 5000);

    // Find the emit for this file (ignore any stragglers from prior writes
    // — there shouldn't be any but the assertion is shape-based, not
    // count-based).
    const realFilePath = fs.realpathSync(filePath);
    const ours = emits.find(
      (e) =>
        e.metadata?.filePath === filePath ||
        e.metadata?.filePath === realFilePath,
    );

    expect(ours).toBeDefined();
    expect(ours!.source).toBe('filesystem');
    expect(ours!.sourceApp).toBe('Local Files');
    expect(ours!.type).toBe('document_capture');
    expect(ours!.url).toBe('file://' + ours!.metadata.filePath);
    // Sanity: the parser returned the file body, not an archive sentinel.
    expect(ours!.metadata.archived).toBeUndefined();
    expect(ours!.content).toContain('From integration test');
  });

  /**
   * Validates: Requirements 4.5, 5.2, 6.2
   *
   * The backfill SSE stream is the explicit opt-in for picking up
   * pre-existing files. `ignoreInitial: true` on chokidar means a fresh
   * watcher will NOT replay files dropped before registration, so the
   * only way to ingest them is the backfill walker. We:
   *
   *   1. Drop a `.md` file BEFORE registering the folder.
   *   2. POST the folder (chokidar attaches but skips the existing file).
   *   3. POST /backfill — drives the BFS walker which reuses
   *      `handleAddOrChange`, so the same emit shape is produced.
   *   4. Buffer and parse the SSE stream; assert `done` with `total >= 1`.
   *   5. Assert the work-item listener fired for the pre-existing file.
   */
  it('POST /backfill emits done with total ≥ 1 and replays pre-existing files via onWorkItem', { timeout: 20000 }, async () => {
    // Pre-existing file BEFORE registration — this is the file backfill
    // must surface (chokidar with ignoreInitial:true won't see it on its
    // own).
    const preexisting = path.join(tmpdir, 'preexisting.md');
    fs.writeFileSync(preexisting, '# Pre-existing\n\nBackfill should find me.\n');
    const realPreexisting = fs.realpathSync(preexisting);

    const addRes = await request(app)
      .post('/api/local-folders')
      .send({ path: tmpdir });
    expect(addRes.status).toBe(201);
    const folderId = addRes.body.folder.id as number;

    // Snapshot the live-emit count from the POST so we can isolate
    // backfill emits below. With ignoreInitial:true chokidar should NOT
    // have emitted for `preexisting.md` — the count should be 0.
    const liveBeforeBackfill = emits.length;

    // Drive the SSE stream end-to-end.
    const sseRes = await bufferSSE(
      request(app).post(`/api/local-folders/${folderId}/backfill`),
    );

    expect(sseRes.status).toBe(200);
    expect(sseRes.headers['content-type']).toMatch(/text\/event-stream/);

    const events = parseSSE(sseRes.body as string);
    const phases = events.map((e) => e.event);

    // Stream is started → … → done.
    expect(phases[0]).toBe('started');
    expect(phases[phases.length - 1]).toBe('done');

    const done = events.find((e) => e.event === 'done')!;
    expect(done).toBeDefined();
    expect(done.data.folderId).toBe(folderId);
    expect(typeof done.data.total).toBe('number');
    expect(done.data.total).toBeGreaterThanOrEqual(1);

    // The handleAddOrChange path runs synchronously inside the awaited
    // backfill, so by the time the SSE stream ends `emits` already
    // contains the pre-existing file's work item — no extra polling needed.
    const backfillEmits = emits.slice(liveBeforeBackfill);
    const matched = backfillEmits.find(
      (e) =>
        e.metadata?.filePath === preexisting ||
        e.metadata?.filePath === realPreexisting,
    );
    expect(matched).toBeDefined();
    expect(matched!.source).toBe('filesystem');
    expect(matched!.content).toContain('Backfill should find me');
  });

  /**
   * Validates: Requirement 4.4
   *
   * After DELETE the folder is removed from `local_folders` and the route
   * awaits `setWatchedFolders([])` before responding, so chokidar tears
   * down the watcher synchronously with the response. Any subsequent
   * mutation in the now-untracked directory must NOT produce a work item.
   *
   * The assertion is "no emit within a generous window" — chokidar's
   * `awaitWriteFinish` is 500ms, so a 1.5s window is comfortably above
   * the latency we'd expect if the watcher were still attached.
   */
  it('DELETE /api/local-folders/:id stops emitting for files in the (now-untracked) folder', { timeout: 20000 }, async () => {
    // Register, watch a fresh file land, then unregister.
    const addRes = await request(app)
      .post('/api/local-folders')
      .send({ path: tmpdir });
    expect(addRes.status).toBe(201);
    const folderId = addRes.body.folder.id as number;

    await sleep(300);

    const filePath = path.join(tmpdir, 'tracked.md');
    fs.writeFileSync(filePath, '# Tracked\n\nFirst version.\n');

    // Confirm the watcher is in fact attached — without this assertion a
    // bug that breaks `attachWatcher` would silently make the post-DELETE
    // assertion vacuously true ("no emits because none were ever emitted").
    await waitFor(() => emits.length >= 1, 5000);
    const emitsAfterRegister = emits.length;

    const delRes = await request(app).delete(`/api/local-folders/${folderId}`);
    expect(delRes.status).toBe(204);

    // setWatchedFolders([]) is awaited inside the DELETE handler, so by
    // this point the chokidar instance has been .close()'d. Any pending
    // events queued internally are dropped.
    //
    // Mutate the file in the untracked folder. With awaitWriteFinish at
    // 500ms, a re-attached watcher would surface this within ~1s; we wait
    // 1.5s to be safe before asserting silence.
    fs.writeFileSync(filePath, '# Tracked\n\nSecond version (post-delete).\n');
    await sleep(1500);

    // The post-delete window must be event-free. We compare against the
    // count snapshotted right before DELETE returned, NOT before the
    // tracked.md write — that way a late-arriving emit from the original
    // watcher (race with .close()) would still be caught.
    expect(emits.length).toBe(emitsAfterRegister);
  });
});
