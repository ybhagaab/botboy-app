import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createRouter } from './routes.js';
import { addLocalFolder } from '../core/local-folders-config.js';
import type {
  FilesystemMonitor,
  BackfillResult,
} from '../monitors/filesystem-monitor.js';

/**
 * SSE backfill route tests.
 *
 * The router uses a module-scoped `Map<number, AbortController>` keyed by
 * `folderId` to coordinate the POST stream and a sibling DELETE cancel call.
 * These tests drive the routes against a stubbed `FilesystemMonitor` so we
 * can deterministically choreograph progress events and abort signals
 * without involving chokidar or the real filesystem walker.
 *
 * Validates: Requirements 3.2, 3.3, 3.4
 */

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a buffered SSE text payload into an ordered list of
 * `{ event, data }` records. The route emits `event: <phase>` plus
 * `data: <json>` separated by a blank line, so we split on `\n\n` and walk
 * each block for the `event:` and `data:` prefixes.
 */
interface SSEEvent {
  event: string;
  data: any;
}

function parseSSE(text: string): SSEEvent[] {
  const out: SSEEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
      // Lines starting with `:` are SSE comments (keepalives) — ignore.
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let parsed: any = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Leave as string when not JSON.
    }
    out.push({ event, data: parsed });
  }
  return out;
}

/**
 * Buffer an SSE response into a string. Supertest stores the parsed value on
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
 * Build a `FilesystemMonitor` test double whose surface satisfies the
 * `FilesystemMonitor` interface but only the `backfill` method is meaningful
 * for these tests. The other methods are vi.fn no-ops so the route can call
 * them defensively without exploding.
 */
function makeMonitor(
  backfill: FilesystemMonitor['backfill'],
): FilesystemMonitor {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onWorkItem: vi.fn(),
    setWatchedFolders: vi.fn().mockResolvedValue(undefined),
    getWatchedFolders: vi.fn().mockReturnValue([]),
    backfill: vi.fn(backfill) as any,
  };
}

/**
 * Wait until `predicate` returns true, polling every 5 ms. Used to
 * synchronize the test against side-effects of the stubbed backfill (e.g.
 * "the stream has started, you can fire DELETE now").
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('SSE backfill routes', () => {
  let storage: StorageLayer;
  let folderId: number;
  let folderPath: string;
  /** Directory we created under $HOME — removed in afterEach. */
  let cleanupDir: string | null = null;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();

    // `addLocalFolder` requires the path to be a real directory inside
    // $HOME. Create a unique tmpdir under home so the inside-home guard
    // passes for every test.
    cleanupDir = fs.mkdtempSync(path.join(os.homedir(), '.test-lf-backfill-'));
    folderPath = cleanupDir;

    const result = addLocalFolder(storage.getDb(), { path: folderPath });
    if (!result.ok) {
      throw new Error(`Test setup failed to add folder: ${result.message}`);
    }
    folderId = result.folder.id;
  });

  afterEach(() => {
    storage.close();
    if (cleanupDir) {
      try {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
      cleanupDir = null;
    }
  });

  /**
   * Validates: Requirement 3.2, 3.3
   *
   * The happy-path SSE stream forwards `started`, `progress`, and `done`
   * events from the monitor onto the wire as `event: <phase>` blocks with
   * the phase-stripped payload as `data:`. Order matches emit order.
   */
  it('streams started, progress, and done events with the expected shapes', async () => {
    const monitor = makeMonitor(async (id, opts): Promise<BackfillResult> => {
      opts?.onProgress?.({ phase: 'started', folderId: id });
      opts?.onProgress?.({
        phase: 'progress',
        folderId: id,
        processed: 1,
        total: 3,
      });
      opts?.onProgress?.({
        phase: 'progress',
        folderId: id,
        processed: 2,
        total: 3,
      });
      opts?.onProgress?.({
        phase: 'progress',
        folderId: id,
        processed: 3,
        total: 3,
      });
      opts?.onProgress?.({ phase: 'done', folderId: id, total: 3 });
      return { aborted: false, total: 3 };
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createRouter({
        nodeManager: {} as any,
        db: storage.getDb(),
        filesystemMonitor: monitor,
      }),
    );

    const res = await bufferSSE(
      request(app).post(`/api/local-folders/${folderId}/backfill`),
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const events = parseSSE(res.body as string);
    const phases = events.map((e) => e.event);

    // First event is `started`, last is `done`, with progress in between.
    expect(phases[0]).toBe('started');
    expect(phases[phases.length - 1]).toBe('done');
    expect(phases.filter((p) => p === 'progress').length).toBe(3);

    // Shape checks: every payload carries the folderId; phase is stripped.
    const started = events.find((e) => e.event === 'started')!;
    expect(started.data).toEqual({ folderId });
    expect(started.data).not.toHaveProperty('phase');

    const firstProgress = events.find((e) => e.event === 'progress')!;
    expect(firstProgress.data).toEqual({
      folderId,
      processed: 1,
      total: 3,
    });

    const done = events.find((e) => e.event === 'done')!;
    expect(done.data).toEqual({ folderId, total: 3 });

    // The route invoked backfill exactly once with our folderId.
    expect(monitor.backfill).toHaveBeenCalledTimes(1);
    const [calledId, calledOpts] = (monitor.backfill as any).mock.calls[0];
    expect(calledId).toBe(folderId);
    expect(typeof calledOpts.onProgress).toBe('function');
    expect(calledOpts.signal).toBeDefined();
  });

  /**
   * Validates: Requirement 3.4
   *
   * `DELETE /api/local-folders/:id/backfill` while a backfill is in flight
   * fires the `AbortController`, which the stub observes and uses to emit
   * a final `aborted` event before resolving. The POST stream then ends.
   */
  it('DELETE aborts an in-flight backfill and the stream emits aborted before ending', async () => {
    let signalRef: AbortSignal | undefined;
    let started = false;

    const monitor = makeMonitor(async (id, opts): Promise<BackfillResult> => {
      signalRef = opts?.signal;
      opts?.onProgress?.({ phase: 'started', folderId: id });
      opts?.onProgress?.({
        phase: 'progress',
        folderId: id,
        processed: 1,
        total: 100,
      });
      started = true;

      // Block until the route's controller fires `abort` (triggered by the
      // sibling DELETE call below). `aborted: true` short-circuits if the
      // signal already fired before we registered the listener.
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) return resolve();
        opts?.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });

      opts?.onProgress?.({ phase: 'aborted', folderId: id, processed: 1 });
      return { aborted: true };
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createRouter({
        nodeManager: {} as any,
        db: storage.getDb(),
        filesystemMonitor: monitor,
      }),
    );

    // Kick off the POST without awaiting so we can fire DELETE concurrently.
    // supertest's Test is lazy — it only sends the request when `.end()` is
    // called (either explicitly or implicitly via `.then()`), so we wrap it
    // in a manual `.end(cb)` Promise to fire the request immediately rather
    // than waiting for a tick after `await postPromise`.
    const postPromise = new Promise<request.Response>((resolve, reject) => {
      bufferSSE(request(app).post(`/api/local-folders/${folderId}/backfill`))
        .end((err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
    });

    // Wait for the stub to register the AbortController and emit `started`
    // — guarantees the controller is in the route's map before DELETE runs.
    await waitFor(() => started);

    const deleteRes = await request(app).delete(
      `/api/local-folders/${folderId}/backfill`,
    );
    expect(deleteRes.status).toBe(204);

    // Once DELETE fires abort(), the stub resolves and the route ends the
    // response. Awaiting the POST should therefore complete promptly.
    const postRes = await postPromise;
    expect(postRes.status).toBe(200);

    const events = parseSSE(postRes.body as string);
    const phases = events.map((e) => e.event);

    expect(phases).toContain('started');
    expect(phases).toContain('aborted');
    // `aborted` is the terminal event — nothing after it.
    expect(phases[phases.length - 1]).toBe('aborted');
    // No `done` event when the run was cancelled.
    expect(phases).not.toContain('done');

    const aborted = events.find((e) => e.event === 'aborted')!;
    expect(aborted.data).toEqual({ folderId, processed: 1 });

    // The signal we captured did flip to aborted.
    expect(signalRef?.aborted).toBe(true);
  });

  /**
   * Validates: Requirement 3.4 (idempotency)
   *
   * `DELETE` against a folder with no in-flight backfill is a no-op that
   * still responds 204 — the cancel API is idempotent so the UI can fire
   * it freely without first probing for an active stream.
   */
  it('DELETE on a folder with no in-flight backfill responds 204 (idempotent)', async () => {
    const monitor = makeMonitor(async () => ({ aborted: false, total: 0 }));

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createRouter({
        nodeManager: {} as any,
        db: storage.getDb(),
        filesystemMonitor: monitor,
      }),
    );

    // No prior POST — the controllers map has no entry for this id.
    const res = await request(app).delete(
      `/api/local-folders/${folderId}/backfill`,
    );

    expect(res.status).toBe(204);
    // 204 responses MUST NOT have a body per HTTP spec; supertest exposes
    // this as an empty object/string.
    expect(res.text === '' || res.text === undefined).toBe(true);

    // The monitor was never asked to run a backfill.
    expect(monitor.backfill).not.toHaveBeenCalled();

    // Calling DELETE a second time is still 204 — confirms idempotency.
    const second = await request(app).delete(
      `/api/local-folders/${folderId}/backfill`,
    );
    expect(second.status).toBe(204);
  });
});
