import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, utimesSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer, setSetting, getSetting } from '../core/storage.js';
import { createSharePointSync, SharePointSync } from './sharepoint-sync.js';
import { getSuggestedChanges } from '../core/document-corpus.js';
import type { RawWorkItem } from '../core/types.js';
import type { McpManager, McpCallResult, McpProfileSnapshot } from '../core/mcp-types.js';

/**
 * Fake-MCP suite for the SharePoint sync engine (sharepoint-docs-brain R3–R5,
 * R7, R10). The fake manager scripts listings, inline reads, and savePath
 * downloads (writing real bytes to the requested path, like the server).
 */

const MB = 1024 * 1024;

type ToolHandler = (tool: string, args: Record<string, unknown>) => McpCallResult | Promise<McpCallResult>;

function ok(text: string): McpCallResult {
  return { text, isError: false } as McpCallResult;
}

function sharedDoc(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    Title: 'Roadmap.docx',
    Path: '/sites/mx-team/Shared Documents/Roadmap.docx',
    WebUrl: 'https://amazon.sharepoint.com/sites/mx-team/Doc.aspx?sourcedoc=%7BAAA%7D&file=Roadmap.docx',
    SiteUrl: 'https://amazon.sharepoint.com/sites/mx-team',
    Author: 'Wang, Chen',
    LastModifiedTime: '2026-08-20T10:00:00Z',
    LastModifiedBy: 'Wang, Chen',
    FileType: 'docx',
    Size: String(2 * MB),
    IsDocument: 'true',
    SharePointDomain: 'amazon.sharepoint.com',
    ...overrides,
  };
}

describe('SharePointSync engine', () => {
  let storage: StorageLayer;
  let dir: string;
  let cacheDir: string;
  let emitted: RawWorkItem[];
  let clock: { value: number };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-sp-'));
    cacheDir = path.join(dir, 'cache');
    emitted = [];
    clock = { value: Date.parse('2026-08-24T12:00:00Z') };
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function fakeManager(handler: ToolHandler, profileState: Partial<McpProfileSnapshot> = {}): { manager: McpManager; calls: Array<{ tool: string; args: Record<string, unknown> }> } {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const profile = {
      id: 'sharepoint', kind: 'sharepoint', enabled: true, state: 'running',
      compatibilityState: 'compatible', installationState: 'installed',
      ...profileState,
    } as unknown as McpProfileSnapshot;
    const restarts: string[] = [];
    const manager = {
      getProfile: async () => profile,
      callTool: async (_id: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return handler(tool, args);
      },
      restart: async (serverId: string) => { restarts.push(serverId); return profile; },
    } as unknown as McpManager;
    return { manager, calls, restarts };
  }

  function build(handler: ToolHandler, opts: { profileState?: Partial<McpProfileSnapshot>; parser?: { parseLargeAsync?: (fp: string) => Promise<{ text: string; truncation: Record<string, unknown> }> } } = {}) {
    const { manager, calls, restarts } = fakeManager(handler, opts.profileState ?? {});
    const sync: SharePointSync = createSharePointSync({
      db: storage.getDb(),
      mcpManager: manager,
      documentParser: opts.parser,
      emit: item => emitted.push(item),
      config: { cacheDir, authJarDir: path.join(dir, 'auth-jars'), nowMs: () => clock.value, surgeThreshold: 5, backlogHighWater: 50 },
    });
    return { sync, calls, restarts };
  }

  function enableSharedWithMe(sync: SharePointSync) {
    sync.updateConfig({ enabled: true }); // seeds shared_with_me / days90 (R3.2)
  }

  const listShared = (docs: Record<string, unknown>[]): ToolHandler => (tool, args) => {
    if (tool === 'sharepoint_list_shared_with_me') return ok(JSON.stringify({ totalResults: docs.length, results: docs }));
    if (tool === 'sharepoint_read_file') {
      if (args.inline) return ok('# Roadmap\n\nContent body.');
      // savePath mode: write the exact advertised size.
      const target = String(args.savePath);
      const doc = docs.find(d => d.Path === args.serverRelativeUrl);
      const size = Number(doc?.Size ?? 0);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, Buffer.alloc(size, 1));
      return ok(JSON.stringify({ saved: target }));
    }
    if (tool === 'sharepoint_read_loop') return ok('Loop page content');
    if (tool === 'sharepoint_read_docx_comments') return ok('[]'); // docx docs default to no comments
    throw new Error(`unexpected tool ${tool}`);
  };

  it('R3.2: first enable with no config seeds shared-with-me at days90', () => {
    const { sync } = build(listShared([]));
    enableSharedWithMe(sync);
    const status = sync.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.sources).toHaveLength(1);
    expect(status.sources[0].kind).toBe('shared_with_me');
    expect(status.sources[0].baseline).toBe('days90');
  });

  it('discovery skips when sync disabled or profile not ready', async () => {
    const { sync, calls } = build(listShared([sharedDoc()]));
    const disabled = await sync.runNow();
    expect(disabled.status).toBe('skipped');
    expect(calls).toHaveLength(0);

    const { sync: sync2, calls: calls2 } = build(listShared([sharedDoc()]), { profileState: { state: 'stopped' } });
    sync2.updateConfig({ enabled: true });
    const notReady = await sync2.runNow();
    expect(notReady.status).toBe('skipped');
    expect(calls2).toHaveLength(0);
  });

  it('baseline recent30 keeps the 30 newest as backfill-priority rows', async () => {
    const docs = Array.from({ length: 40 }, (_, i) => sharedDoc({
      Title: `Doc${i}.docx`,
      Path: `/sites/mx-team/Shared Documents/Doc${i}.docx`,
      WebUrl: `https://amazon.sharepoint.com/sites/mx-team/doc${i}`,
      LastModifiedTime: new Date(Date.parse('2026-08-01T00:00:00Z') - i * 86_400_000).toISOString(),
    }));
    const { sync } = build(listShared(docs));
    sync.updateConfig({ enabled: true, sources: [{ kind: 'shared_with_me', baseline: 'recent30' }] });
    const result = await sync.runNow();
    expect(result.status).toBe('completed');
    const row = storage.getDb().prepare("SELECT COUNT(*) AS c FROM sharepoint_sync_queue WHERE priority = 'backfill' AND kind='content'").get() as any;
    expect(row.c).toBe(30);
  });

  it('baseline days90 keeps only documents newer than 90 days', async () => {
    const oldDoc = sharedDoc({ Path: '/sites/mx-team/Shared Documents/Old.docx', WebUrl: 'https://amazon.sharepoint.com/old', LastModifiedTime: '2026-01-01T00:00:00Z' });
    const newDoc = sharedDoc({ Path: '/sites/mx-team/Shared Documents/New.docx', WebUrl: 'https://amazon.sharepoint.com/new', LastModifiedTime: '2026-08-20T00:00:00Z' });
    const { sync } = build(listShared([oldDoc, newDoc]));
    sync.updateConfig({ enabled: true, sources: [{ kind: 'shared_with_me', baseline: 'days90' }] });
    await sync.runNow();
    const keys = (storage.getDb().prepare("SELECT doc_key FROM sharepoint_sync_queue WHERE kind='content'").all() as any[]).map(r => r.doc_key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('/New.docx');
  });

  it('REGRESSION (live 2026-08-24): baseline-excluded docs never leak in on the next cycle, but sync when they later change', async () => {
    const oldDoc = sharedDoc({ Path: '/sites/mx-team/Shared Documents/Old.docx', WebUrl: 'https://amazon.sharepoint.com/old', LastModifiedTime: '2026-01-01T00:00:00Z' });
    const newDoc = sharedDoc({ Path: '/sites/mx-team/Shared Documents/New.docx', WebUrl: 'https://amazon.sharepoint.com/new', LastModifiedTime: '2026-08-20T00:00:00Z' });
    const { sync } = build(listShared([oldDoc, newDoc]));
    sync.updateConfig({ enabled: true, sources: [{ kind: 'shared_with_me', baseline: 'days90' }] });
    await sync.runNow(); // baseline: only New.docx enqueued; Old.docx seen-without-sync
    await sync.drainNow();
    emitted.length = 0;

    // Second cycle, nothing changed: the old doc must NOT appear as "changed".
    const second = await sync.runNow();
    const counters = Object.values(second.perSource)[0];
    expect(counters.enqueued).toBe(0);
    expect(counters.unchanged).toBe(2);

    // The old doc is edited later → it genuinely changed → it syncs now.
    oldDoc.LastModifiedTime = '2026-08-24T09:00:00Z';
    await sync.runNow();
    const rows = (storage.getDb().prepare("SELECT doc_key, priority FROM sharepoint_sync_queue WHERE state='queued' AND kind='content'").all() as any[]);
    expect(rows).toHaveLength(1);
    expect(rows[0].doc_key).toContain('/Old.docx');
    expect(rows[0].priority).toBe('live');
  });

  it('REGRESSION (live 2026-08-24): a still-queued unchanged doc is not re-upserted (no priority promotion, no attempts reset)', async () => {
    const doc = sharedDoc();
    const { sync } = build(listShared([doc]));
    enableSharedWithMe(sync);
    await sync.runNow(); // enqueued as backfill, NOT drained yet
    storage.getDb().prepare('UPDATE sharepoint_sync_queue SET attempts = 2').run();

    const second = await sync.runNow();
    const counters = Object.values(second.perSource)[0];
    expect(counters.enqueued).toBe(0);
    expect(counters.unchanged).toBe(1);
    const row = storage.getDb().prepare('SELECT priority, attempts FROM sharepoint_sync_queue WHERE kind=\'content\'').get() as any;
    expect(row.priority).toBe('backfill'); // not promoted to live
    expect(row.attempts).toBe(2); // not reset

    // A genuinely newer version DOES refresh the row.
    doc.LastModifiedTime = '2026-08-25T08:00:00Z';
    await sync.runNow();
    const updated = storage.getDb().prepare('SELECT priority, attempts FROM sharepoint_sync_queue WHERE kind=\'content\'').get() as any;
    expect(updated.priority).toBe('live');
    expect(updated.attempts).toBe(0);
  });

  it('change detection: unchanged docs are not re-enqueued; changed docs re-enqueue as live with reset attempts', async () => {
    const doc = sharedDoc();
    const { sync } = build(listShared([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    expect((storage.getDb().prepare('SELECT COUNT(*) AS c FROM sharepoint_sync_queue WHERE kind=\'content\'').get() as any).c).toBe(1);
    await sync.drainNow();
    expect(emitted).toHaveLength(1);

    // Second discovery, same modified/size → nothing enqueued.
    const second = await sync.runNow();
    const counters = Object.values(second.perSource)[0];
    expect(counters.unchanged).toBe(1);
    expect(counters.enqueued).toBe(0);

    // Changed modified → live-priority row.
    doc.LastModifiedTime = '2026-08-22T09:00:00Z';
    await sync.runNow();
    const row = storage.getDb().prepare("SELECT priority, attempts, state FROM sharepoint_sync_queue WHERE kind='content'").get() as any;
    expect(row.priority).toBe('live');
    expect(row.state).toBe('queued');
  });

  it('drain routes docx through the BINARY lane (extractor parses natively — tables survive), bare URL first, #rev= on revision', async () => {
    // .docx moved inline→binary 2026-08-26: the MCP inline conversion
    // flattened Word tables to one line per cell (owner report).
    const doc = sharedDoc();
    const { sync } = build(listShared([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    expect(emitted).toHaveLength(1);
    const first = emitted[0];
    expect(first.type).toBe('document_capture');
    expect(first.source).toBe('sharepoint');
    expect(first.url).toBe(doc.WebUrl);
    expect(first.metadata.filePath).toBeDefined(); // extractor hand-off
    expect(String(first.metadata.filePath).endsWith('.part')).toBe(false);
    expect(first.content).toBe('');
    expect(first.metadata.extractionTier).toBe('full');
    expect(first.metadata.author).toBe('Wang, Chen');
    // Queue empty, seen recorded.
    expect((storage.getDb().prepare('SELECT COUNT(*) AS c FROM sharepoint_sync_queue WHERE kind=\'content\'').get() as any).c).toBe(0);
    expect((storage.getDb().prepare('SELECT COUNT(*) AS c FROM sharepoint_seen').get() as any).c).toBe(1);

    // Revision: modified bumps → re-emit with #rev= fragment.
    doc.LastModifiedTime = '2026-08-23T11:30:00Z';
    await sync.runNow();
    await sync.drainNow();
    expect(emitted).toHaveLength(2);
    expect(emitted[1].url).toBe(`${doc.WebUrl}#rev=20260823113000`);
  });

  it('binary ≤25MB downloads via .part → verify → rename and hands off to the extractor', async () => {
    const doc = sharedDoc({ Title: 'Metrics.xlsx', FileType: 'xlsx', Size: String(3 * MB), Path: '/sites/mx-team/Shared Documents/Metrics.xlsx', WebUrl: 'https://amazon.sharepoint.com/xlsx' });
    const { sync } = build(listShared([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    expect(emitted).toHaveLength(1);
    const item = emitted[0];
    expect(item.metadata.filePath).toBeDefined();
    expect(item.metadata.filePath.endsWith('.part')).toBe(false);
    expect(existsSync(item.metadata.filePath)).toBe(true);
    expect(item.content).toBe('');
    expect(item.metadata.extractionTier).toBe('full');
  });

  it('torn (empty) download records an attempt, keeps the entry queued, and fails visibly after 5', async () => {
    // NOTE (signals R1): a non-empty size mismatch is no longer a failure —
    // the actual bytes win (stale-listing tolerance, tested above). The
    // attempts ladder now rides the remaining hard-failure: empty downloads.
    const doc = sharedDoc({ Title: 'Bad.pdf', FileType: 'pdf', Size: String(4 * MB), Path: '/sites/mx-team/Shared Documents/Bad.pdf', WebUrl: 'https://amazon.sharepoint.com/pdf' });
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_list_shared_with_me') return ok(JSON.stringify({ results: [doc] }));
      if (tool === 'sharepoint_read_file') {
        const target = String(args.savePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.alloc(0)); // torn: empty download
        return ok('{}');
      }
      throw new Error(`unexpected ${tool}`);
    };
    const { sync } = build(handler);
    enableSharedWithMe(sync);
    await sync.runNow();

    for (let i = 1; i <= 4; i++) {
      await sync.drainNow();
      const row = storage.getDb().prepare('SELECT attempts, state FROM sharepoint_sync_queue').get() as any;
      expect(row.attempts).toBe(i);
      expect(row.state).toBe('queued');
    }
    await sync.drainNow();
    const final = storage.getDb().prepare('SELECT attempts, state, last_error FROM sharepoint_sync_queue').get() as any;
    expect(final.state).toBe('failed');
    expect(final.last_error).toMatch(/size mismatch/);
    expect(emitted).toHaveLength(0);
    // No torn file left behind.
    const partFiles = existsSync(cacheDir)
      ? readdirSync(cacheDir, { recursive: true }).filter(f => String(f).endsWith('.part'))
      : [];
    expect(partFiles).toHaveLength(0);
  });

  it('large lane (25–150MB) self-parses, emits truncated tier with detail, and deletes the binary', async () => {
    const doc = sharedDoc({ Title: 'Huge.xlsx', FileType: 'xlsx', Size: String(40 * MB), Path: '/sites/mx-team/Shared Documents/Huge.xlsx', WebUrl: 'https://amazon.sharepoint.com/huge' });
    const parsed = { text: 'sheet rows...', truncation: { sheets: [{ name: 'Data', rowsKept: 200, rowsTotal: 48213 }] } };
    const { sync } = build(listShared([doc]), { parser: { parseLargeAsync: async () => parsed } });
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    expect(emitted).toHaveLength(1);
    const item = emitted[0];
    expect(item.metadata.extractionTier).toBe('truncated');
    expect(item.content).toBe('sheet rows...');
    expect(JSON.parse(item.metadata.truncation).sheets[0].rowsTotal).toBe(48213);
    expect(item.metadata.filePath).toBeUndefined();
    // Binary deleted immediately (self-parsed lane).
    const files = existsSync(cacheDir) ? readdirSync(cacheDir, { recursive: true }).map(String).filter(f => f.endsWith('.xlsx')) : [];
    expect(files).toHaveLength(0);
  });

  it('large lane without a parser degrades to metadata-only presence', async () => {
    const doc = sharedDoc({ Title: 'Huge.pptx', FileType: 'pptx', Size: String(60 * MB), Path: '/sites/mx-team/Shared Documents/Huge.pptx', WebUrl: 'https://amazon.sharepoint.com/hugepptx' });
    const { sync } = build(listShared([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata.extractionTier).toBe('metadata_only');
    expect(emitted[0].content).toContain('60 MB');
  });

  it('>150MB emits presence evidence without any download call', async () => {
    const doc = sharedDoc({ Title: 'Massive.pptx', FileType: 'pptx', Size: String(300 * MB), Path: '/sites/mx-team/Shared Documents/Massive.pptx', WebUrl: 'https://amazon.sharepoint.com/massive' });
    const { sync, calls } = build(listShared([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata.extractionTier).toBe('metadata_only');
    expect(emitted[0].content).toContain('300 MB');
    expect(emitted[0].content).toContain('Wang, Chen');
    expect(calls.filter(c => c.tool === 'sharepoint_read_file')).toHaveLength(0);
  });

  it('disallowed types are skipped with a counter', async () => {
    const image = sharedDoc({ Title: 'photo.png', FileType: 'png', Path: '/sites/mx-team/Shared Documents/photo.png', WebUrl: 'https://amazon.sharepoint.com/png' });
    const { sync } = build(listShared([image]));
    enableSharedWithMe(sync);
    const result = await sync.runNow();
    const counters = Object.values(result.perSource)[0];
    expect(counters.skippedType).toBe(1);
    expect(counters.enqueued).toBe(0);
  });

  it('invalid listing rows are rejected without failing the run', async () => {
    const bad = sharedDoc({ WebUrl: 'https://evil.example.com/doc', Path: '/x/doc.docx' });
    const good = sharedDoc();
    const { sync } = build(listShared([bad, good]));
    enableSharedWithMe(sync);
    const result = await sync.runNow();
    const counters = Object.values(result.perSource)[0];
    expect(result.status).toBe('completed');
    expect(counters.invalid).toBe(1);
    expect(counters.enqueued).toBe(1);
  });

  it('backlog gate pauses the drain and resumes when the pipeline catches up', async () => {
    const { sync } = build(listShared([sharedDoc()]));
    enableSharedWithMe(sync);
    await sync.runNow();

    const insert = storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, captured_at, process_state) VALUES (?, 'website_visit', 'browser', '2026-08-24T10:00:00Z', 'captured')",
    );
    for (let i = 0; i < 60; i++) insert.run(`wi${i}`);
    expect(await sync.drainNow()).toBe(0);
    expect(emitted).toHaveLength(0);
    expect(sync.getStatus().gates.backlog).toBe(false);

    storage.getDb().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'p1'").run();
    expect(await sync.drainNow()).toBe(2); // content + paired comments row (empty thread)
    expect(emitted).toHaveLength(1);
  });

  it('throttle (429) sets a per-domain backoff that expires with the clock and resets on success', async () => {
    let throttle = true;
    const doc = sharedDoc();
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_list_shared_with_me') return ok(JSON.stringify({ results: [doc] }));
      if (tool === 'sharepoint_read_file') {
        if (throttle) throw new Error('HTTP 429 Too Many Requests');
        // docx rides the binary lane now — success = bytes at savePath.
        const target = String(args.savePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from('# Roadmap content bytes'));
        return ok('{}');
      }
      throw new Error(`unexpected ${tool}`);
    };
    const { sync, calls } = build(handler);
    enableSharedWithMe(sync);
    await sync.runNow();

    await sync.drainNow();
    expect(emitted).toHaveLength(0);
    expect(Object.keys(sync.getStatus().backoffs)).toContain('amazon.sharepoint.com');

    // Backoff active: next drain makes NO read call.
    const readsBefore = calls.filter(c => c.tool === 'sharepoint_read_file').length;
    await sync.drainNow();
    expect(calls.filter(c => c.tool === 'sharepoint_read_file').length).toBe(readsBefore);

    // Clock past backoff → retry succeeds → backoff cleared.
    throttle = false;
    clock.value += 31_000;
    await sync.drainNow();
    expect(emitted).toHaveLength(1);
    expect(Object.keys(sync.getStatus().backoffs)).toHaveLength(0);
  });

  it('surge guard pauses a non-baseline source pending confirmSurge', async () => {
    const docs = Array.from({ length: 8 }, (_, i) => sharedDoc({
      Path: `/sites/mx-team/Shared Documents/S${i}.docx`,
      WebUrl: `https://amazon.sharepoint.com/s${i}`,
    }));
    const { sync } = build(listShared([docs[0]]));
    enableSharedWithMe(sync);
    await sync.runNow(); // baseline (1 doc) — exempt from surge
    await sync.drainNow();
    emitted.length = 0;

    // Next cycle: 7 changed docs (docs[0] is already seen and unchanged)
    // > threshold (5) → paused with the changed count recorded.
    const { sync: sync2 } = build(listShared(docs));
    const result = await sync2.runNow();
    void result;
    const status = sync2.getStatus();
    const source = status.sources[0];
    expect(source.paused).toBe(true);
    expect(source.surgePending).toBe(7);
    // Paused source does not drain.
    expect(await sync2.drainNow()).toBe(0);

    sync2.confirmSurge(source.id);
    const after = sync2.getStatus().sources[0];
    expect(after.paused).toBe(false);
    expect(after.surgePending).toBeUndefined();
  });

  it('removing a source deletes its queued entries in the same transaction', async () => {
    const { sync } = build(listShared([sharedDoc()]));
    enableSharedWithMe(sync);
    await sync.runNow();
    expect((storage.getDb().prepare('SELECT COUNT(*) AS c FROM sharepoint_sync_queue WHERE kind=\'content\'').get() as any).c).toBe(1);
    sync.updateConfig({ sources: [] });
    expect((storage.getDb().prepare('SELECT COUNT(*) AS c FROM sharepoint_sync_queue WHERE kind=\'content\'').get() as any).c).toBe(0);
  });

  it('source validation rejects non-sharepoint domains, missing library names, and traversal folder paths', () => {
    const { sync } = build(listShared([]));
    expect(() => sync.updateConfig({ sources: [{ kind: 'library', siteUrl: 'https://evil.example.com/sites/x', libraryName: 'Docs' }] }))
      .toThrow(/sharepoint\.com/);
    expect(() => sync.updateConfig({ sources: [{ kind: 'library', siteUrl: 'https://amazon.sharepoint.com/sites/x' }] }))
      .toThrow(/libraryName/);
    expect(() => sync.updateConfig({ sources: [{ kind: 'library', siteUrl: 'https://amazon.sharepoint.com/sites/x', libraryName: 'Docs', folderPath: '../etc' }] }))
      .toThrow(/relative/);
    expect(() => sync.updateConfig({ sources: [{ kind: 'weird' }] })).toThrow(/not supported/);
  });

  it('restart resume: a new engine instance over the same db drains the existing queue', async () => {
    const doc = sharedDoc();
    const { sync } = build(listShared([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    expect((storage.getDb().prepare('SELECT COUNT(*) AS c FROM sharepoint_sync_queue WHERE kind=\'content\'').get() as any).c).toBe(1);

    // "Restart": brand-new instance, same database.
    const { sync: reborn } = build(listShared([doc]));
    expect(await reborn.drainNow()).toBe(2); // content + paired comments row
    expect(emitted).toHaveLength(1);
  });

  it('library listing paginates with skipToken and passes siteUrl + personal:false', async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => ({
      Name: `A${i}.docx`, Path: `/sites/lib/Shared Documents/A${i}.docx`, IsFolder: false,
      Modified: '2026-08-20T10:00:00Z', WebUrl: `https://amazon.sharepoint.com/a${i}`, Size: 1024,
    }));
    const page2 = [{
      Name: 'B.docx', Path: '/sites/lib/Shared Documents/B.docx', IsFolder: false,
      Modified: '2026-08-21T10:00:00Z', WebUrl: 'https://amazon.sharepoint.com/b', Size: 1024,
    }];
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_list_files') {
        expect(args.siteUrl).toBe('https://amazon.sharepoint.com/sites/lib');
        expect(args.personal).toBe(false);
        return args.skipToken
          ? ok(JSON.stringify({ files: page2 }))
          : ok(JSON.stringify({ files: page1, nextToken: 'tok1' }));
      }
      throw new Error(`unexpected ${tool}`);
    };
    const { sync } = build(handler);
    sync.updateConfig({ enabled: true, sources: [{ kind: 'library', siteUrl: 'https://amazon.sharepoint.com/sites/lib', libraryName: 'Documents', baseline: 'all' }] });
    const result = await sync.runNow();
    const counters = Object.values(result.perSource)[0];
    expect(counters.listed).toBe(3);
    expect(counters.enqueued).toBe(3);
  });

  it('cache sweep deletes stale .part files and respects captured items + LRU cap', async () => {
    // Arrange a cached file referenced by a captured item, plus a stale .part.
    const sub = path.join(cacheDir, 'deadbeef');
    mkdirSync(sub, { recursive: true });
    const kept = path.join(sub, 'kept.xlsx');
    const stalePart = path.join(sub, 'torn.xlsx.part');
    writeFileSync(kept, Buffer.alloc(1024));
    writeFileSync(stalePart, Buffer.alloc(1024));
    const old = new Date(clock.value - 2 * 60 * 60_000);
    utimesSync(stalePart, old, old);
    storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, captured_at, metadata, process_state) VALUES ('k1', 'document_capture', 'sharepoint', '2026-08-24T10:00:00Z', ?, 'captured')",
    ).run(JSON.stringify({ filePath: kept }));

    const { sync } = build(listShared([sharedDoc()]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow(); // sweep runs at drain end

    expect(existsSync(stalePart)).toBe(false); // torn download removed
    expect(existsSync(kept)).toBe(true); // awaiting extraction — protected
  });

  it('purge removes items, FTS rows, queue, seen, and the cache directory', async () => {
    const { sync } = build(listShared([sharedDoc()]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    expect(emitted).toHaveLength(1);

    // Simulate the capture path having stored the emitted item.
    const db = storage.getDb();
    db.prepare(
      "INSERT INTO work_items (id, type, source, title, url, captured_at, metadata, process_state) VALUES ('sp1', 'document_capture', 'sharepoint', 'Roadmap.docx', ?, '2026-08-24T10:00:00Z', '{}', 'extracted')",
    ).run(emitted[0].url);
    db.prepare("INSERT INTO work_items_fts (item_id, title, body) VALUES ('sp1', 'Roadmap.docx', 'body')").run();

    const result = sync.purge();
    expect(result.items).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM work_items WHERE source = 'sharepoint'").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM work_items_fts WHERE item_id = 'sp1'").get() as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM sharepoint_seen').get() as any).c).toBe(0);
    expect(existsSync(cacheDir)).toBe(false);
    // Baselines reset with the seen-state: the next discovery re-applies the
    // chosen depth instead of re-syncing the whole corpus as live changes.
    expect(sync.getStatus().sources.every(s => !s.baselineDone)).toBe(true);
  });

  it('auth self-heal: a "Silent authorize" failure deletes stale cookie jars (once per window) so the server re-bootstraps', async () => {
    const jarDir = path.join(dir, 'auth-jars');
    mkdirSync(jarDir, { recursive: true });
    writeFileSync(path.join(jarDir, 'cookies-amazon.sharepoint.com.json'), '{}');
    writeFileSync(path.join(jarDir, 'cookies-amazon-my.sharepoint.com.json'), '{}');
    writeFileSync(path.join(jarDir, 'other.json'), '{}'); // untouched

    const doc = sharedDoc();
    const handler: ToolHandler = (tool) => {
      if (tool === 'sharepoint_list_shared_with_me') return ok(JSON.stringify({ results: [doc] }));
      if (tool === 'sharepoint_read_file') throw new Error('sharepoint_read_file failed: Error: Silent authorize did not return a code');
      throw new Error(`unexpected ${tool}`);
    };
    const { sync, restarts } = build(handler);
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    expect(existsSync(path.join(jarDir, 'cookies-amazon.sharepoint.com.json'))).toBe(false);
    expect(existsSync(path.join(jarDir, 'cookies-amazon-my.sharepoint.com.json'))).toBe(false);
    expect(existsSync(path.join(jarDir, 'other.json'))).toBe(true);
    // Both halves of the heal: jars removed AND the server restarted.
    expect(restarts).toContain('sharepoint');
    // Entry stays queued for retry after the heal.
    const row = storage.getDb().prepare('SELECT state, attempts FROM sharepoint_sync_queue').get() as any;
    expect(row.state).toBe('queued');
    expect(row.attempts).toBe(1);

    // Within the 10-minute window a recreated jar is left alone (no thrash).
    writeFileSync(path.join(jarDir, 'cookies-amazon.sharepoint.com.json'), '{"fresh":true}');
    await sync.drainNow();
    expect(existsSync(path.join(jarDir, 'cookies-amazon.sharepoint.com.json'))).toBe(true);
  });

  it('getStatus reports queue depth by priority and per-source counts', async () => {
    const docs = [sharedDoc(), sharedDoc({ Path: '/sites/mx-team/Shared Documents/Two.docx', WebUrl: 'https://amazon.sharepoint.com/two' })];
    const { sync } = build(listShared(docs));
    enableSharedWithMe(sync);
    await sync.runNow();
    const status = sync.getStatus();
    expect(status.queue.queued).toBe(2);
    expect(status.queue.backfill).toBe(2);
    expect(status.sources[0].queued).toBe(2);
  });

  // ── Phase 2: comments lane (sharepoint-comments R1–R3, R5) ───────────────

  const HLD_COMMENTS = [
    { id: '1', author: 'Ng, Hui Jun', initials: 'NH', date: '2026-08-20T09:00:00Z', text: 'Should we split the catalog API by region?' },
    { id: '2', author: 'Bhagat, AB', initials: 'BA', date: '2026-08-20T10:00:00Z', text: 'Good catch — regional split is planned for v2.', parentId: '1' },
    { id: '3', author: 'Wang, Chen', initials: 'WC', date: '2026-08-21T08:00:00Z', text: 'AB Bhagat please confirm the auth flow for backend unification.', done: true },
  ];

  function commentsHandler(docs: Record<string, unknown>[], comments: unknown = HLD_COMMENTS): ToolHandler {
    const base = listShared(docs);
    return (tool, args) => {
      if (tool === 'sharepoint_read_docx_comments') return ok(JSON.stringify(comments));
      return base(tool, args);
    };
  }

  function setOwner(name: string, email = 'ybhagaab@amazon.com') {
    setSetting(storage.getDb(), 'grasp_sync.owner_name', name);
    setSetting(storage.getDb(), 'grasp_sync.owner_email', email);
  }

  it('R1.1: a changed docx enqueues a paired comments row; a pdf without an item Id does not', async () => {
    const docs = [sharedDoc(), sharedDoc({ Title: 'Report.pdf', FileType: 'pdf', Path: '/sites/mx-team/Shared Documents/Report.pdf', WebUrl: 'https://amazon.sharepoint.com/pdf' })];
    const { sync } = build(listShared(docs));
    enableSharedWithMe(sync);
    await sync.runNow();
    const rows = storage.getDb().prepare('SELECT doc_key, kind FROM sharepoint_sync_queue ORDER BY doc_key').all() as any[];
    expect(rows.filter(r => r.kind === 'comments')).toHaveLength(1);
    expect(rows.find(r => r.kind === 'comments').doc_key).toContain('/Roadmap.docx#comments');
    expect(rows.filter(r => r.kind === 'content')).toHaveLength(2);
  });

  it('comment anchors: the comments fetch downloads the docx once and stamps metadata.anchorText (replies inherit the root range)', async () => {
    setOwner('Bhagat, AB');
    const { execFileSync } = await import('child_process');
    const anchorSrc = path.join(dir, 'anchor-src');
    mkdirSync(path.join(anchorSrc, 'word'), { recursive: true });
    writeFileSync(path.join(anchorSrc, '[Content_Types].xml'), '<Types/>');
    writeFileSync(path.join(anchorSrc, 'word', 'document.xml'),
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Should we split the catalog API by region?</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>'
      + '<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>auth flow for backend unification</w:t></w:r><w:commentRangeEnd w:id="3"/></w:p>'
      + '</w:body></w:document>');
    const anchorDocx = path.join(dir, 'anchor.docx');
    execFileSync('zip', ['-X', '-q', '-r', anchorDocx, '.'], { cwd: anchorSrc });

    const base = commentsHandler([sharedDoc()]);
    const { sync } = build((tool, args) => {
      if (tool === 'sharepoint_read_file' && args.savePath) {
        mkdirSync(path.dirname(String(args.savePath)), { recursive: true });
        writeFileSync(String(args.savePath), readFileSync(anchorDocx));
        return ok('{}');
      }
      return base(tool, args);
    });
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    const comments = emitted.filter(i => i.type === 'document_comment');
    expect(comments.find(c => c.metadata.commentId === '1')!.metadata.anchorText).toBe('Should we split the catalog API by region?');
    // Reply 2 (parentId 1) inherits the root's passage.
    expect(comments.find(c => c.metadata.commentId === '2')!.metadata.anchorText).toBe('Should we split the catalog API by region?');
    expect(comments.find(c => c.metadata.commentId === '3')!.metadata.anchorText).toBe('auth flow for backend unification');
  });

  it('R2/R3: comments drain emits one document_comment per comment with threading, owner direction, mention, and resolved flags', async () => {
    setOwner('Bhagat, AB');
    const { sync } = build(commentsHandler([sharedDoc()]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    const comments = emitted.filter(i => i.type === 'document_comment');
    expect(comments).toHaveLength(3);

    const question = comments.find(c => c.metadata.commentId === '1')!;
    expect(question.title).toBe('Comment by Ng, Hui Jun on Roadmap.docx');
    expect(question.url).toBe(`${sharedDoc().WebUrl}#comment=1`);
    expect(question.metadata.direction).toBe('received');
    expect(question.metadata.mentionedMe).toBe('false');
    expect(question.metadata.threadRoot).toBe('1');
    expect(question.metadata.docTitle).toBe('Roadmap.docx');
    expect(question.metadata.commentedAt).toBe('2026-08-20T09:00:00.000Z');

    // Owner-authored reply: direction sent, parent quoted, thread rooted.
    const reply = comments.find(c => c.metadata.commentId === '2')!;
    expect(reply.metadata.direction).toBe('sent');
    expect(reply.metadata.parentCommentId).toBe('1');
    expect(reply.metadata.threadRoot).toBe('1');
    expect(reply.content).toContain('↪ replying to Ng, Hui Jun: "Should we split the catalog API by region?"');
    expect(reply.content).toContain('Good catch');

    // Mention by "First Last" variant + resolved comment still emits.
    const mention = comments.find(c => c.metadata.commentId === '3')!;
    expect(mention.metadata.mentionedMe).toBe('true');
    expect(mention.metadata.direction).toBe('received');
    expect(mention.metadata.resolved).toBe('true');
  });

  it('R2.1: durable URL dedupe — a re-fetched thread emits only comments not already in work_items', async () => {
    setOwner('Bhagat, AB');
    const doc = sharedDoc();
    const { sync } = build(commentsHandler([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    expect(emitted.filter(i => i.type === 'document_comment')).toHaveLength(3);

    // Persist the first two as captured work items (what the capture
    // pipeline does in prod); leave #3 unpersisted to prove per-URL checks.
    const insert = storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, url, captured_at, process_state) VALUES (?, 'document_comment', 'sharepoint', ?, '2026-08-24T10:00:00Z', 'captured')",
    );
    insert.run('c1', `${doc.WebUrl}#comment=1`);
    insert.run('c2', `${doc.WebUrl}#comment=2`);
    emitted.length = 0;

    // Same doc modified again → paired comments row re-enqueued → re-drain.
    doc.LastModifiedTime = '2026-08-22T09:00:00Z';
    await sync.runNow();
    await sync.drainNow();
    const again = emitted.filter(i => i.type === 'document_comment');
    expect(again).toHaveLength(1);
    expect(again[0].metadata.commentId).toBe('3');
  });

  it('REGRESSION (owner 2026-08-26): a resolution toggle on an UNCHANGED comment id updates the stored row — dedup skips the emit, never the state', async () => {
    setOwner('Bhagat, AB');
    const doc = sharedDoc();
    const live: Array<Record<string, unknown>> = [
      { id: '1', author: 'Bhagat, AB', initials: 'BA', date: '2026-08-20T09:00:00Z', text: 'Please review the tenets wording in section II before Friday.' },
      { id: '2', author: 'Zhuo, Wei', initials: 'ZW', date: '2026-08-20T10:00:00Z', text: 'Left one concern on tenet #2 — it reads like a description.', parentId: '1' },
    ];
    const { sync } = build(commentsHandler([doc], live));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    persistEmittedComments();
    emitted.length = 0;

    // The owner resolves the thread in Word Online: same ids, same URLs —
    // the done flag lands on the ROOT only. Doc modified → comments lane
    // re-enqueued → re-drain hits the durable-dedup branch.
    live[0].done = true;
    doc.LastModifiedTime = '2026-08-22T09:00:00Z';
    await sync.runNow();
    await sync.drainNow();

    expect(emitted.filter(i => i.type === 'document_comment')).toHaveLength(0); // dedup held — no re-emission
    const metaOf = (id: string) => JSON.parse((storage.getDb().prepare('SELECT metadata FROM work_items WHERE url = ?')
      .get(`${doc.WebUrl}#comment=${id}`) as { metadata: string }).metadata) as Record<string, string>;
    expect(metaOf('1').resolved).toBe('true');  // the resolution reached the stored row
    expect(metaOf('2').resolved).toBe('false'); // live state stamped on the reply too
  });

  // ── Renumbered comment ids (soak find 2026-08-25) ─────────────────────────
  // Word renumbers comment ids under co-authoring; the same comment must not
  // re-emit under its new id — the stored row is remapped in place instead.

  function persistEmittedComments() {
    const insert = storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, url, title, captured_at, process_state, metadata, raw_text)
      VALUES (?, 'document_comment', 'sharepoint', ?, ?, ?, 'captured', ?, ?)
    `);
    let n = 0;
    for (const item of emitted.filter(i => i.type === 'document_comment')) {
      insert.run(`c${++n}`, item.url, item.title, item.capturedAt.toISOString(), JSON.stringify(item.metadata), item.content);
    }
  }

  it('SOAK REGRESSION: renumbered ids remap the stored rows in place — no duplicate emissions, live ids restored', async () => {
    setOwner('Bhagat, AB');
    const doc = sharedDoc();
    const { sync } = build(commentsHandler([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    expect(emitted.filter(i => i.type === 'document_comment')).toHaveLength(3);
    persistEmittedComments();
    emitted.length = 0;

    // Co-authors edit the doc: Word renumbers 1/2/3 → 11/12/13.
    const renumbered = [
      { id: '11', author: 'Ng, Hui Jun', date: '2026-08-20T09:00:00Z', text: 'Should we split the catalog API by region?' },
      { id: '12', author: 'Bhagat, AB', date: '2026-08-20T10:00:00Z', text: 'Good catch — regional split is planned for v2.', parentId: '11' },
      { id: '13', author: 'Wang, Chen', date: '2026-08-21T08:00:00Z', text: 'AB Bhagat please confirm the auth flow for backend unification.', done: true },
    ];
    doc.LastModifiedTime = '2026-08-22T09:00:00Z';
    const { sync: sync2 } = build(commentsHandler([doc], renumbered));
    enableSharedWithMe(sync2);
    await sync2.runNow();
    await sync2.drainNow();

    // Nothing re-emitted — and the stored rows now carry the live ids.
    expect(emitted.filter(i => i.type === 'document_comment')).toHaveLength(0);
    const rows = storage.getDb().prepare(`
      SELECT url, json_extract(metadata,'$.commentId') AS cid,
             json_extract(metadata,'$.threadRoot') AS root,
             json_extract(metadata,'$.parentCommentId') AS parent,
             json_extract(metadata,'$.resolved') AS resolved
      FROM work_items WHERE type='document_comment' ORDER BY cid
    `).all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.cid).sort()).toEqual(['11', '12', '13']);
    const reply = rows.find(r => r.cid === '12');
    expect(reply.url).toBe(`${doc.WebUrl}#comment=12`);
    expect(reply.root).toBe('11');
    expect(reply.parent).toBe('11');
    expect(rows.find(r => r.cid === '13').resolved).toBe('true');
  });

  it('SOAK REGRESSION: the boot sweep collapses existing renumbered duplicates to the earliest capture, merging anchors', async () => {
    const insert = storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, url, captured_at, process_state, metadata, raw_text)
      VALUES (?, 'document_comment', 'sharepoint', ?, ?, 'captured', ?, ?)
    `);
    const meta = (cid: string, anchor?: string) => JSON.stringify({
      docKey: 'amazon.sharepoint.com/x/HLD.docx', commentId: cid, threadRoot: cid,
      author: 'Ng, Hui Jun', commentedAt: '2026-08-24T16:23:00.000Z', direction: 'received',
      ...(anchor ? { anchorText: anchor } : {}),
    });
    // The same comment captured under three id generations; only a later
    // duplicate carries the anchor (extraction landed after gen 1).
    insert.run('dup-a', 'https://x/hld#comment=8', '2026-08-24T16:25:00Z', meta('8'), 'What the process of dialup will be?');
    insert.run('dup-b', 'https://x/hld#comment=17', '2026-08-24T18:00:00Z', meta('17', 'dialup passage'), 'What the process of dialup will be?');
    insert.run('dup-c', 'https://x/hld#comment=20', '2026-08-24T19:00:00Z', meta('20'), 'What the process of dialup will be?');
    // A different comment (different author) at the same timestamp survives.
    insert.run('other', 'https://x/hld#comment=9', '2026-08-24T16:25:00Z', JSON.stringify({
      docKey: 'amazon.sharepoint.com/x/HLD.docx', commentId: '9', threadRoot: '9',
      author: 'Wang, Chen', commentedAt: '2026-08-24T16:23:00.000Z', direction: 'received',
    }), 'Different question entirely.');

    build(listShared([])); // constructing the engine runs the sweep

    const rows = storage.getDb().prepare(`
      SELECT id, json_extract(metadata,'$.anchorText') AS anchor
      FROM work_items WHERE type='document_comment' ORDER BY id
    `).all() as any[];
    expect(rows.map((r: any) => r.id)).toEqual(['dup-a', 'other']);
    // Earliest capture kept, the duplicate's anchor merged onto it.
    expect(rows.find((r: any) => r.id === 'dup-a').anchor).toBe('dialup passage');
  });

  it('SOAK REGRESSION: a re-stamped date (Word edits both id and timestamp) still remaps by text identity', async () => {
    setOwner('Bhagat, AB');
    const doc = sharedDoc();
    const original = [
      { id: '22', author: 'Bhagat, AB', date: '2026-08-25T12:38:00Z', text: 'updated- please review the metadata pull section carefully' },
    ];
    const { sync } = build(commentsHandler([doc], original));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    persistEmittedComments();
    emitted.length = 0;

    // Word re-issues the comment with a NEW id AND a NEW timestamp.
    const restamped = [
      { id: '28', author: 'Bhagat, AB', date: '2026-08-25T12:58:00Z', text: 'updated- please review the metadata pull section carefully' },
    ];
    doc.LastModifiedTime = '2026-08-25T13:00:00Z';
    const { sync: sync2 } = build(commentsHandler([doc], restamped));
    enableSharedWithMe(sync2);
    await sync2.runNow();
    await sync2.drainNow();

    expect(emitted.filter(i => i.type === 'document_comment')).toHaveLength(0);
    const row = storage.getDb().prepare(`
      SELECT url, json_extract(metadata,'$.commentId') AS cid, json_extract(metadata,'$.commentedAt') AS at
      FROM work_items WHERE type='document_comment'
    `).get() as any;
    expect(row.cid).toBe('28');
    expect(row.url).toBe(`${doc.WebUrl}#comment=28`);
    // The live (newest) stamp wins so thread ordering matches Word.
    expect(row.at).toBe('2026-08-25T12:58:00.000Z');
  });

  it('SOAK REGRESSION: a reused comment id evicts the ghost of a deleted comment instead of swallowing the live one', async () => {
    setOwner('Bhagat, AB');
    const doc = sharedDoc();
    // A comment captured earlier, since DELETED from the doc; Word reused
    // its id 1 for Hui Jun's brand-new reply (live find 2026-08-25: the
    // "Tenet #2" comment was skipped because this ghost squatted the URL).
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, url, captured_at, process_state, metadata, raw_text)
      VALUES ('ghost', 'document_comment', 'sharepoint', ?, '2026-08-24T16:04:00Z', 'captured', ?, 'AB to update these')
    `).run(`${doc.WebUrl}#comment=1`, JSON.stringify({
      docKey: 'amazon.sharepoint.com/sites/mx-team/Shared Documents/Roadmap.docx',
      commentId: '1', threadRoot: '1', author: 'Bhagat, AB',
      commentedAt: '2026-08-24T16:04:00.000Z', direction: 'sent',
    }));

    const live = [
      { id: '1', author: 'Ng, Hui Jun', date: '2026-08-25T16:46:00Z', text: "Tenet #2 doesn't sound like a tenet and sounds more like a description. Can I modify it?" },
    ];
    const { sync } = build(commentsHandler([doc], live));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    // The live comment EMITTED (this was the swallowed one).
    const fresh = emitted.filter(i => i.type === 'document_comment');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].metadata.author).toBe('Ng, Hui Jun');
    expect(fresh[0].url).toBe(`${doc.WebUrl}#comment=1`);
    // The ghost is tombstoned: relocated URL + deletedFromDoc, text intact.
    const ghost = storage.getDb().prepare("SELECT url, json_extract(metadata,'$.deletedFromDoc') AS del, raw_text FROM work_items WHERE id='ghost'").get() as any;
    expect(ghost.url).toBe(`${doc.WebUrl}#comment~deleted=ghost`);
    expect(ghost.del).toBe('true');
    expect(ghost.raw_text).toBe('AB to update these');
  });

  it('comments absent from the live thread are flagged deletedFromDoc; reappearing revives them', async () => {
    setOwner('Bhagat, AB');
    const doc = sharedDoc();
    const both = [
      { id: '1', author: 'Ng, Hui Jun', date: '2026-08-20T09:00:00Z', text: 'Should we split the catalog API by region?' },
      { id: '2', author: 'Wang, Chen', date: '2026-08-20T10:00:00Z', text: 'Also check the auth flow for unification here.' },
    ];
    const { sync } = build(commentsHandler([doc], both));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    persistEmittedComments();
    emitted.length = 0;

    // Comment 2 deleted from the doc.
    doc.LastModifiedTime = '2026-08-21T09:00:00Z';
    const { sync: sync2 } = build(commentsHandler([doc], [both[0]]));
    enableSharedWithMe(sync2);
    await sync2.runNow();
    await sync2.drainNow();
    expect(emitted.filter(i => i.type === 'document_comment')).toHaveLength(0);
    const flagged = storage.getDb().prepare("SELECT json_extract(metadata,'$.deletedFromDoc') AS del FROM work_items WHERE json_extract(metadata,'$.commentId')='2'").get() as any;
    expect(flagged.del).toBe('true');
    const kept = storage.getDb().prepare("SELECT json_extract(metadata,'$.deletedFromDoc') AS del FROM work_items WHERE json_extract(metadata,'$.commentId')='1'").get() as any;
    expect(kept.del).toBeNull();

    // It comes back (undo / restore) under a new id → remap revives it.
    doc.LastModifiedTime = '2026-08-22T09:00:00Z';
    const restored = [both[0], { ...both[1], id: '9' }];
    const { sync: sync3 } = build(commentsHandler([doc], restored));
    enableSharedWithMe(sync3);
    await sync3.runNow();
    await sync3.drainNow();
    expect(emitted.filter(i => i.type === 'document_comment')).toHaveLength(0);
    const revived = storage.getDb().prepare("SELECT json_extract(metadata,'$.commentId') AS cid, json_extract(metadata,'$.deletedFromDoc') AS del FROM work_items WHERE json_extract(metadata,'$.author')='Wang, Chen'").get() as any;
    expect(revived.cid).toBe('9');
    expect(revived.del).toBeNull();
  });

  it('unaccepted tracked changes (suggestions) are extracted from the docx and recorded per docKey; acceptance clears them', async () => {
    setOwner('Bhagat, AB');
    const { execFileSync } = await import('child_process');
    const mkDocx = (bodyXml: string, name: string) => {
      const src = path.join(dir, `${name}-src`);
      mkdirSync(path.join(src, 'word'), { recursive: true });
      writeFileSync(path.join(src, '[Content_Types].xml'), '<Types/>');
      writeFileSync(path.join(src, 'word', 'document.xml'),
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`);
      const out = path.join(dir, `${name}.docx`);
      execFileSync('zip', ['-X', '-q', '-r', out, '.'], { cwd: src });
      return out;
    };
    const withSuggestion = mkDocx(
      '<w:p><w:r><w:t>Tenet #2: existing text.</w:t></w:r>'
      + '<w:ins w:id="5" w:author="Ng, Hui Jun" w:date="2026-08-25T08:50:00Z"><w:r><w:t>We keep components independently deployable and rollback-capable.</w:t></w:r></w:ins>'
      + '<w:del w:id="7" w:author="Ng, Hui Jun" w:date="2026-08-25T08:51:00Z"><w:r><w:delText>old descriptive wording</w:delText></w:r></w:del></w:p>',
      'suggested');
    const accepted = mkDocx('<w:p><w:r><w:t>Tenet #2: final text.</w:t></w:r></w:p>', 'accepted');

    let fixture = withSuggestion;
    const doc = sharedDoc();
    const base = commentsHandler([doc], [{ id: '1', author: 'Ng, Hui Jun', date: '2026-08-25T08:52:00Z', text: 'Suggested a Tenet #2 rewrite, please review.' }]);
    const { sync } = build((tool, args) => {
      if (tool === 'sharepoint_read_file' && args.savePath) {
        mkdirSync(path.dirname(String(args.savePath)), { recursive: true });
        writeFileSync(String(args.savePath), readFileSync(fixture));
        return ok('{}');
      }
      return base(tool, args);
    });
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    const docKey = 'amazon.sharepoint.com/sites/mx-team/Shared Documents/Roadmap.docx';
    const state = getSuggestedChanges(storage.getDb(), docKey);
    expect(state).not.toBeNull();
    expect(state!.changes).toHaveLength(2);
    const ins = state!.changes.find(c => c.kind === 'insertion')!;
    expect(ins.author).toBe('Ng, Hui Jun');
    expect(ins.date).toBe('2026-08-25T08:50:00.000Z');
    expect(ins.text).toContain('independently deployable');
    expect(state!.changes.find(c => c.kind === 'deletion')!.text).toBe('old descriptive wording');

    // Suggestion accepted → next pass clears the state.
    fixture = accepted;
    doc.LastModifiedTime = '2026-08-26T09:00:00Z';
    await sync.runNow();
    await sync.drainNow();
    const cleared = getSuggestedChanges(storage.getDb(), docKey);
    expect(cleared).not.toBeNull();
    expect(cleared!.changes).toHaveLength(0);
  });

  it("Word's 1900-01-01 placeholder dates are dropped at normalization and cleared from stored rows by the sweep", async () => {
    setOwner('Bhagat, AB');
    // Stored row with the placeholder stamp (captured before this fix).
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, url, captured_at, process_state, metadata, raw_text)
      VALUES ('old', 'document_comment', 'sharepoint', 'https://x/hld#comment=5', '2026-08-25T07:00:00Z', 'captured', ?, 'updated- please review')
    `).run(JSON.stringify({
      docKey: 'amazon.sharepoint.com/x/HLD.docx', commentId: '5', threadRoot: '5',
      author: 'Bhagat, AB', commentedAt: '1900-01-01T00:00:00.000Z', direction: 'sent',
    }));

    const doc = sharedDoc();
    const undated = [
      { id: '7', author: 'Ng, Hui Jun', date: '1900-01-01T00:00:00.000Z', text: 'Fresh comment with a placeholder date.' },
    ];
    const { sync } = build(commentsHandler([doc], undated)); // construction sweeps
    // Sweep dropped the stored placeholder stamp.
    const cleaned = storage.getDb().prepare("SELECT json_extract(metadata,'$.commentedAt') AS at FROM work_items WHERE id='old'").get() as any;
    expect(cleaned.at).toBeNull();

    // Newly fetched placeholder dates never stamp commentedAt at all.
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    const fresh = emitted.filter(i => i.type === 'document_comment').find(c => c.metadata.commentId === '7')!;
    expect(fresh.metadata.commentedAt).toBeUndefined();
  });

  it('renumber guard does not swallow a same-second sibling comment by the same author', async () => {
    setOwner('Bhagat, AB');
    const doc = sharedDoc();
    const twins = [
      { id: '1', author: 'Ng, Hui Jun', date: '2026-08-20T09:00:00Z', text: 'First question about the API.' },
    ];
    const { sync } = build(commentsHandler([doc], twins));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    persistEmittedComments();
    emitted.length = 0;

    // Next fetch: id 1 unchanged, PLUS a new comment by the same author with
    // the same timestamp. The exact-url match consumes id 1's fingerprint,
    // so the sibling must emit as genuinely new — not remap over row 1.
    const withSibling = [
      ...twins,
      { id: '9', author: 'Ng, Hui Jun', date: '2026-08-20T09:00:00Z', text: 'Second, unrelated question.' },
    ];
    doc.LastModifiedTime = '2026-08-22T09:00:00Z';
    const { sync: sync2 } = build(commentsHandler([doc], withSibling));
    enableSharedWithMe(sync2);
    await sync2.runNow();
    await sync2.drainNow();

    const again = emitted.filter(i => i.type === 'document_comment');
    expect(again).toHaveLength(1);
    expect(again[0].metadata.commentId).toBe('9');
    // Row 1 untouched.
    const row1 = storage.getDb().prepare("SELECT url FROM work_items WHERE json_extract(metadata,'$.commentId')='1'").get() as any;
    expect(row1.url).toBe(`${doc.WebUrl}#comment=1`);
  });

  it('R3.3: owner matching — "Last, First" setting matches both author orders and the email local part; unknown owner fails quiet', async () => {
    setOwner('Bhagat, AB');
    const swapped = [
      { id: '9', author: 'AB Bhagat', date: '2026-08-20T09:00:00Z', text: 'LGTM.' },
      { id: '10', author: 'ybhagaab', date: '2026-08-20T09:05:00Z', text: 'Shipping it.' },
    ];
    const { sync } = build(commentsHandler([sharedDoc()], swapped));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    const comments = emitted.filter(i => i.type === 'document_comment');
    expect(comments.map(c => c.metadata.direction)).toEqual(['sent', 'sent']);

    // Owner unknown → nothing matches, nothing throws.
    setSetting(storage.getDb(), 'grasp_sync.owner_name', '');
    setSetting(storage.getDb(), 'grasp_sync.owner_email', '');
    emitted.length = 0;
    const doc2 = sharedDoc({ Path: '/sites/mx-team/Shared Documents/Other.docx', WebUrl: 'https://amazon.sharepoint.com/other' });
    const { sync: sync2 } = build(commentsHandler([doc2], swapped));
    enableSharedWithMe(sync2);
    await sync2.runNow();
    await sync2.drainNow();
    const blind = emitted.filter(i => i.type === 'document_comment');
    expect(blind.map(c => c.metadata.direction)).toEqual(['received', 'received']);
    expect(blind.map(c => c.metadata.mentionedMe)).toEqual(['false', 'false']);
  });

  it('R5.1: comments inherit parentProjectId from the routed document_capture of the same docKey', async () => {
    const doc = sharedDoc();
    const docKey = `amazon.sharepoint.com${doc.Path}`;
    storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, captured_at, metadata, process_state, project_id) VALUES ('d1', 'document_capture', 'sharepoint', '2026-08-23T10:00:00Z', ?, 'routed', 'proj-hld')",
    ).run(JSON.stringify({ docKey }));

    const { sync } = build(commentsHandler([doc]));
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    const comments = emitted.filter(i => i.type === 'document_comment');
    expect(comments).toHaveLength(3);
    expect(comments.every(c => c.metadata.parentProjectId === 'proj-hld')).toBe(true);
  });

  it('R1.4: a failing comments fetch retries independently — the content row still lands', async () => {
    const base = listShared([sharedDoc()]);
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_read_docx_comments') throw new Error('comments endpoint exploded');
      return base(tool, args);
    };
    const { sync } = build(handler);
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();

    expect(emitted.filter(i => i.type === 'document_capture')).toHaveLength(1);
    const row = storage.getDb().prepare("SELECT attempts, state FROM sharepoint_sync_queue WHERE kind='comments'").get() as any;
    expect(row.attempts).toBe(1);
    expect(row.state).toBe('queued');
    // Content row is gone (processed); only the comments row remains.
    expect((storage.getDb().prepare("SELECT COUNT(*) AS c FROM sharepoint_sync_queue WHERE kind='content'").get() as any).c).toBe(0);
  });

  // ── Signals: size tolerance (sharepoint-signals R1) ───────────────────────

  it('R1(signals): a stale listed size is corrected to the actual download size and the doc still lands', async () => {
    const doc = sharedDoc({ Title: 'Sheet.xlsx', FileType: 'xlsx', Size: String(43_970), Path: '/sites/mx-team/Shared Documents/Sheet.xlsx', WebUrl: 'https://amazon.sharepoint.com/sheet' });
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_list_shared_with_me') return ok(JSON.stringify({ results: [doc] }));
      if (tool === 'sharepoint_read_file') {
        const target = String(args.savePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.alloc(44_540, 1)); // actual ≠ listed (observed live)
        return ok('{}');
      }
      throw new Error(`unexpected ${tool}`);
    };
    const { sync } = build(handler);
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata.sizeBytes).toBe('44540'); // corrected, not listed
    expect(emitted[0].metadata.extractionTier).toBe('full');
    const seen = storage.getDb().prepare('SELECT size FROM sharepoint_seen').get() as any;
    expect(seen.size).toBe(44_540);
  });

  it('R1.2(signals): a correction crossing the large-lane ceiling re-routes to metadata_only instead of feeding the parser', async () => {
    const doc = sharedDoc({ Title: 'Deck.pptx', FileType: 'pptx', Size: String(95_402), Path: '/sites/mx-team/Shared Documents/Deck.pptx', WebUrl: 'https://amazon.sharepoint.com/deck' });
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_list_shared_with_me') return ok(JSON.stringify({ results: [doc] }));
      if (tool === 'sharepoint_read_file') {
        const target = String(args.savePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.alloc(600_000, 1)); // actual is over the (injected) large-lane max
        return ok('{}');
      }
      throw new Error(`unexpected ${tool}`);
    };
    const { manager } = fakeManager(handler);
    const sync = createSharePointSync({
      db: storage.getDb(),
      mcpManager: manager,
      emit: item => emitted.push(item),
      config: {
        cacheDir, authJarDir: path.join(dir, 'auth-jars'), nowMs: () => clock.value,
        fullParseMaxBytes: 200_000, largeLaneMaxBytes: 500_000, // shrink tiers for the fixture
      },
    });
    sync.updateConfig({ enabled: true });
    await sync.runNow();
    await sync.drainNow();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata.extractionTier).toBe('metadata_only');
    expect(emitted[0].content).toContain('listing reported a wrong size');
    // Nothing left squatting in the cache.
    const leftovers = existsSync(cacheDir) ? readdirSync(cacheDir, { recursive: true }).filter(f => String(f).includes('Deck')) : [];
    expect(leftovers).toHaveLength(0);
  });

  it('R1.1(signals): an empty download is still a torn-file failure', async () => {
    const doc = sharedDoc({ Title: 'Empty.pdf', FileType: 'pdf', Size: String(4 * MB), Path: '/sites/mx-team/Shared Documents/Empty.pdf', WebUrl: 'https://amazon.sharepoint.com/empty' });
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_list_shared_with_me') return ok(JSON.stringify({ results: [doc] }));
      if (tool === 'sharepoint_read_file') {
        const target = String(args.savePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.alloc(0));
        return ok('{}');
      }
      throw new Error(`unexpected ${tool}`);
    };
    const { sync } = build(handler);
    enableSharedWithMe(sync);
    await sync.runNow();
    await sync.drainNow();
    expect(emitted).toHaveLength(0);
    const row = storage.getDb().prepare("SELECT attempts, last_error FROM sharepoint_sync_queue WHERE kind='content'").get() as any;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/empty download/);
  });

  it('refreshDocument (workbench R2.3) enqueues content + comments at live priority from stored metadata', async () => {
    const db = storage.getDb();
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata)
      VALUES ('d1', 'document_capture', 'sharepoint', 'HLD.docx', 'https://amazon.sharepoint.com/hld', '2026-08-24T10:00:00Z', 'routed', ?)
    `).run(JSON.stringify({
      docKey: 'amazon.sharepoint.com/sites/t/Shared Documents/HLD.docx',
      webUrl: 'https://amazon.sharepoint.com/hld',
      serverRelativeUrl: '/sites/t/Shared Documents/HLD.docx',
      fileType: '.docx', sizeBytes: '2048', sharePointSource: 'shared_with_me',
    }));
    const { sync } = build(listShared([]));
    enableSharedWithMe(sync); // provides the source the queue rows attach to
    const result = sync.refreshDocument('amazon.sharepoint.com/sites/t/Shared Documents/HLD.docx');
    expect(result.queued).toBe(true);
    const rows = storage.getDb().prepare("SELECT kind, priority FROM sharepoint_sync_queue ORDER BY kind").all() as any[];
    expect(rows).toEqual([{ kind: 'comments', priority: 'live' }, { kind: 'content', priority: 'live' }]);

    expect(sync.refreshDocument('unknown/doc').queued).toBe(false);
  });

  // ── Signals: revision diff stamping (sharepoint-signals R2) ───────────────

  it('R2(signals): a #rev= capture gets a section-attributed changeSummary against the prior revision', async () => {
    const db = storage.getDb();
    const { createContentStore, refToColumns } = await import('../core/content-store.js');
    const cs = createContentStore(db, { contentDir: path.join(dir, 'content') });
    const insert = (id: string, url: string, capturedAt: string, content: string, summary: string | null = null) => {
      const cols = refToColumns(cs.put(id, content));
      db.prepare(`
        INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, summary,
                                raw_text, content_storage, content_path, content_sha256, content_bytes)
        VALUES (?, 'document_capture', 'sharepoint', 'HLD.docx', ?, ?, 'routed', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, url, capturedAt, JSON.stringify({ docKey: 'amazon.sharepoint.com/hld', extractionTier: 'full' }), summary,
        cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
    };
    insert('rev0', 'https://x/hld', '2026-08-20T10:00:00Z', '# Rollout plan\nEU first.\n');
    insert('rev1', 'https://x/hld#rev=20260825', '2026-08-25T10:00:00Z', '# Rollout plan\nEU first.\nNA targets Q1.\n');

    const { manager } = fakeManager(listShared([]));
    const sync = createSharePointSync({
      db, mcpManager: manager, contentStore: cs,
      emit: item => emitted.push(item),
      config: { cacheDir, authJarDir: path.join(dir, 'auth-jars'), nowMs: () => clock.value },
    });
    sync.updateConfig({ enabled: true });
    await sync.drainNow(); // sweep runs even with an empty queue

    const stamped = db.prepare("SELECT summary, json_extract(metadata,'$.changeSummary') AS cs, json_extract(metadata,'$.changedSections') AS sections FROM work_items WHERE id = 'rev1'").get() as any;
    expect(stamped.cs).toContain('"Rollout plan": 1 added');
    expect(stamped.summary).toContain('Rollout plan'); // empty summary column filled
    expect(JSON.parse(stamped.sections)).toEqual(['Rollout plan']);
    // Baseline (non-#rev=) capture untouched; sweep does not revisit rev1.
    const baseline = db.prepare("SELECT json_extract(metadata,'$.changeSummary') AS cs FROM work_items WHERE id = 'rev0'").get() as any;
    expect(baseline.cs).toBeNull();
  });

  it('R2.4(signals): first revision, metadata-only tiers, and existing summaries are handled without diffing', async () => {
    const db = storage.getDb();
    const { createContentStore, refToColumns } = await import('../core/content-store.js');
    const cs = createContentStore(db, { contentDir: path.join(dir, 'content') });
    const insert = (id: string, docKey: string, url: string, capturedAt: string, content: string, tier = 'full', summary: string | null = null) => {
      const cols = refToColumns(cs.put(id, content));
      db.prepare(`
        INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, summary,
                                raw_text, content_storage, content_path, content_sha256, content_bytes)
        VALUES (?, 'document_capture', 'sharepoint', 'Doc', ?, ?, 'routed', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, url, capturedAt, JSON.stringify({ docKey, extractionTier: tier }), summary,
        cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
    };
    insert('only', 'k/one', 'https://x/one#rev=1', '2026-08-25T10:00:00Z', 'content'); // no prior
    insert('meta0', 'k/two', 'https://x/two', '2026-08-20T10:00:00Z', 'placeholder', 'metadata_only');
    insert('meta1', 'k/two', 'https://x/two#rev=2', '2026-08-25T10:00:00Z', 'placeholder', 'metadata_only');
    insert('sum0', 'k/three', 'https://x/three', '2026-08-20T10:00:00Z', 'a');
    insert('sum1', 'k/three', 'https://x/three#rev=3', '2026-08-25T10:00:00Z', 'b', 'full', 'existing human summary');

    const { manager } = fakeManager(listShared([]));
    const sync = createSharePointSync({
      db, mcpManager: manager, contentStore: cs,
      emit: item => emitted.push(item),
      config: { cacheDir, authJarDir: path.join(dir, 'auth-jars'), nowMs: () => clock.value },
    });
    sync.updateConfig({ enabled: true });
    await sync.drainNow();

    const get = (id: string) => db.prepare("SELECT summary, json_extract(metadata,'$.changeSummary') AS cs FROM work_items WHERE id = ?").get(id) as any;
    expect(get('only').cs).toBe('first captured revision');
    expect(get('meta1').cs).toContain('content not synced');
    expect(get('sum1').cs).toContain('document: 1 added, 1 removed');
    expect(get('sum1').summary).toBe('existing human summary'); // never overwritten
  });

  it('R1.3: library files carrying a list-item Id fetch Details-pane comments with the right args and fragment', async () => {
    const file = {
      Name: 'Spec.docx', Path: '/sites/lib/Shared Documents/Spec.docx', IsFolder: false, Id: 42,
      Modified: '2026-08-20T10:00:00Z', WebUrl: 'https://amazon.sharepoint.com/spec', Size: 1024,
    };
    const itemComments = [{ id: 7, author: { name: 'Zhang, Yaqiong' }, createdDate: '2026-08-21T11:00:00Z', text: 'Uploaded the latest revision.' }];
    const handler: ToolHandler = (tool, args) => {
      if (tool === 'sharepoint_list_files') return ok(JSON.stringify({ files: [file] }));
      if (tool === 'sharepoint_read_file') return ok('# Spec body');
      if (tool === 'sharepoint_read_docx_comments') return ok('[]');
      if (tool === 'sharepoint_list_item_comments') {
        expect(args.listTitle).toBe('Documents');
        expect(args.itemId).toBe(42);
        expect(args.siteUrl).toBe('https://amazon.sharepoint.com/sites/lib');
        expect(args.personal).toBe(false);
        return ok(JSON.stringify({ comments: itemComments }));
      }
      throw new Error(`unexpected ${tool}`);
    };
    const { sync } = build(handler);
    sync.updateConfig({ enabled: true, sources: [{ kind: 'library', siteUrl: 'https://amazon.sharepoint.com/sites/lib', libraryName: 'Documents', baseline: 'all' }] });
    await sync.runNow();
    await sync.drainNow();

    const comments = emitted.filter(i => i.type === 'document_comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].url).toBe('https://amazon.sharepoint.com/spec#itemcomment=7');
    expect(comments[0].metadata.author).toBe('Zhang, Yaqiong');
    expect(comments[0].title).toBe('Comment by Zhang, Yaqiong on Spec.docx');
  });
});

/**
 * Link sweep (doc-link-graph L1): bounded pure-local extraction in the drain
 * tick; dirty-stamped per doc so clean docs cost nothing on later ticks.
 */
describe('link sweep', () => {
  let storage: StorageLayer;
  let dir: string;
  let cacheDir: string;
  const emitted: RawWorkItem[] = [];
  const clock = { value: Date.parse('2026-08-26T10:00:00Z') };
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-links-'));
    cacheDir = path.join(dir, 'cache');
    emitted.length = 0;
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('extracts corpus-internal edges during the drain, stamps docs clean, and rescans only on new content', async () => {
    const db = storage.getDb();
    const { createContentStore, refToColumns } = await import('../core/content-store.js');
    const cs = createContentStore(db, { contentDir: path.join(dir, 'content') });
    const insert = (id: string, docKey: string, title: string, serverRelativeUrl: string, capturedAt: string, content: string) => {
      const cols = refToColumns(cs.put(id, content));
      db.prepare(`
        INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata,
                                raw_text, content_storage, content_path, content_sha256, content_bytes)
        VALUES (?, 'document_capture', 'sharepoint', ?, ?, ?, 'routed', ?, ?, ?, ?, ?, ?)
      `).run(id, title, `https://x/${id}`, capturedAt,
        JSON.stringify({ docKey, serverRelativeUrl, extractionTier: 'full' }),
        cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
    };
    const HLD = 'amazon.sharepoint.com/sites/t/Shared Documents/Unification High Level Design.docx';
    const NOTES = 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/meeting-notes-catalog.md';
    insert('hld1', HLD, 'Unification High Level Design.docx', '/sites/t/Shared Documents/Unification High Level Design.docx',
      '2026-08-25T10:00:00Z', 'The design. No outward links.');
    insert('note1', NOTES, 'meeting-notes-catalog.md', '/personal/u_amazon_com/Documents/meeting-notes-catalog.md',
      '2026-08-25T11:00:00Z', 'Decisions follow the Unification High Level Design as agreed.');

    // Sweeps are pure-local and run before connection gates — a stub manager
    // that answers nothing is enough.
    const manager = {
      callTool: async () => ({ text: '[]', isError: false }),
      getProfile: async () => undefined, // gates close after the pure-local sweeps
    } as unknown as McpManager;
    const sync = createSharePointSync({
      db, mcpManager: manager, contentStore: cs,
      emit: item => emitted.push(item),
      config: { cacheDir, authJarDir: path.join(dir, 'auth-jars'), nowMs: () => clock.value },
    });
    sync.updateConfig({ enabled: true });
    await sync.drainNow();

    const edges = db.prepare('SELECT from_doc_key AS f, to_doc_key AS t, kind FROM document_links').all() as any[];
    expect(edges).toEqual([{ f: NOTES, t: HLD, kind: 'reference' }]);

    // Clean docs are not rescanned: drop the table row underneath — a second
    // drain must NOT recreate it (stamps say both docs are clean).
    db.prepare('DELETE FROM document_links').run();
    await sync.drainNow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_links').get()).toEqual({ n: 0 });

    // A NEW revision of the notes re-dirties exactly that doc.
    insert('note2', NOTES, 'meeting-notes-catalog.md', '/personal/u_amazon_com/Documents/meeting-notes-catalog.md',
      '2026-08-26T09:00:00Z', 'Updated: still per the Unification High Level Design.');
    await sync.drainNow();
    const after = db.prepare('SELECT from_doc_key AS f, to_doc_key AS t FROM document_links').all() as any[];
    expect(after).toEqual([{ f: NOTES, t: HLD }]);
  });
});

/**
 * Comment-email trigger (owner design 2026-08-27). SharePoint's Modified
 * bump can lag an open co-authoring session by hours (measured: 128 min),
 * but every comment produces a notification mail that GRASP captures within
 * minutes. A captured mail announcing comment activity on a KNOWN document
 * refreshes that document immediately — content + comments rows enqueued —
 * without waiting for discovery to observe a version change.
 */
import { extractCommentNotificationDocName } from './sharepoint-sync.js';

describe('comment-email trigger', () => {
  it('extracts the quoted document name from real notification subjects', () => {
    // Shapes observed in the owner's captured mail (2026-08-25..27).
    expect(extractCommentNotificationDocName(
      'Zhuo, Wei mentioned you in "MX Android Catalog & Backend Unification High Level Design - Final".',
    )).toBe('MX Android Catalog & Backend Unification High Level Design - Final');
    expect(extractCommentNotificationDocName(
      'Bhagat, AB left a comment in "Phase 2 Status Update"',
    )).toBe('Phase 2 Status Update');
    expect(extractCommentNotificationDocName(
      'Zhuo, Wei replied to a comment in "MX Android Catalog & Backend Unification High Level Design - Final".',
    )).toBe('MX Android Catalog & Backend Unification High Level Design - Final');
  });

  it('ignores non-comment mail', () => {
    expect(extractCommentNotificationDocName('Zhuo, Wei shared "MX Android Catalog" with you')).toBeNull();
    expect(extractCommentNotificationDocName('Weekly metrics digest')).toBeNull();
    expect(extractCommentNotificationDocName('')).toBeNull();
  });
});

describe('mailTriggerSweep through the drain tick', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-sp-mail-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function buildEngine() {
    const calls: Array<{ tool: string }> = [];
    const manager = {
      getProfile: async () => ({ id: 'sharepoint', kind: 'sharepoint', enabled: true, state: 'running', compatibilityState: 'compatible', installationState: 'installed' }),
      // Connection gates fail fast — the sweep must have already enqueued.
      callTool: async (_id: string, tool: string) => { calls.push({ tool }); return { text: 'Error: offline', isError: true }; },
      restart: async () => ({}),
    } as unknown as McpManager;
    const engine = createSharePointSync({
      db: storage.getDb(),
      mcpManager: manager,
      emit: () => {},
      cacheDir: path.join(dir, 'cache'),
    } as any);
    return engine;
  }

  const DOC_KEY = 'amazon-my.sharepoint.com/personal/tanweeh_amazon_com/Documents/HLD Final.docx';

  function insertCapture(): void {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, raw_text)
      VALUES ('cap1', 'document_capture', 'sharepoint', 'HLD Final.docx', 'https://x/doc', '2026-08-26T10:00:00Z', 'routed', ?, 'body')
    `).run(JSON.stringify({
      docKey: DOC_KEY,
      serverRelativeUrl: '/personal/tanweeh_amazon_com/Documents/HLD Final.docx',
      webUrl: 'https://amazon-my.sharepoint.com/personal/tanweeh_amazon_com/Documents/HLD%20Final.docx',
      fileType: '.docx',
      sizeBytes: 12345,
    }));
    setSetting(storage.getDb(), 'sharepoint_sync.sources', [
      { id: 'src1', kind: 'onedrive', label: 'OneDrive', paused: false },
    ]);
    setSetting(storage.getDb(), 'sharepoint_sync.enabled', 'true');
  }

  function insertMail(id: string, title: string, createdAt: string): void {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, created_at, process_state, raw_text)
      VALUES (?, 'email_read', 'grasp', ?, 'https://outlook/x', ?, ?, 'routed', 'mail body')
    `).run(id, title, createdAt, createdAt);
  }

  it('first tick arms the cursor; a NEW comment mail enqueues content + comments for the named doc', async () => {
    insertCapture();
    const engine = buildEngine();

    // Tick 1: cursor arms at the current high-water mark, nothing enqueued.
    insertMail('m0', 'Zhuo, Wei mentioned you in "HLD Final".', '2026-08-27T03:00:00Z');
    await engine.drainNow();
    let queued = storage.getDb().prepare('SELECT doc_key FROM sharepoint_sync_queue').all() as any[];
    expect(queued).toHaveLength(0);

    // NEW mail after the cursor → both rows enqueued for the matched doc.
    insertMail('m1', 'Zhuo, Wei mentioned you in "HLD Final".', '2026-08-27T03:34:00Z');
    await engine.drainNow();
    queued = storage.getDb().prepare('SELECT doc_key, kind FROM sharepoint_sync_queue ORDER BY doc_key').all() as any[];
    expect(queued.map((row: any) => row.kind).sort()).toEqual(['comments', 'content']);
    expect(queued[0].doc_key).toBe(DOC_KEY);
    expect(queued[1].doc_key).toBe(`${DOC_KEY}#comments`);

    // Re-drain: cursor advanced, no duplicate churn (rows unchanged).
    await engine.drainNow();
    const again = storage.getDb().prepare('SELECT COUNT(*) AS n FROM sharepoint_sync_queue').get() as any;
    expect(again.n).toBe(2);
  });

  it('mail naming an unknown document or without a comment shape enqueues nothing', async () => {
    insertCapture();
    const engine = buildEngine();
    await engine.drainNow(); // arm cursor
    insertMail('m2', 'Someone mentioned you in "Completely Unknown Doc".', '2026-08-27T04:00:00Z');
    insertMail('m3', 'Zhuo, Wei shared "HLD Final" with you', '2026-08-27T04:00:01Z');
    await engine.drainNow();
    const queued = storage.getDb().prepare('SELECT COUNT(*) AS n FROM sharepoint_sync_queue').get() as any;
    expect(queued.n).toBe(0);
  });
});
