/**
 * SharePoint background sync — user-selected document sources → evidence.
 *
 * Two-stage engine (sharepoint-docs-brain R4; docs/maps/sharepoint.md):
 *
 *   DISCOVERY (every 30 min, single-flight with runNow): list each configured
 *   source through the managed SharePoint MCP (read tools only), validate
 *   every entry, change-detect against `sharepoint_seen` (modified + size),
 *   and UPSERT changed documents into the durable `sharepoint_sync_queue`.
 *   Discovery never downloads.
 *
 *   DRAIN (every 20 s): acquire up to 2 queue entries per tick — live before
 *   backfill, newest first — behind backpressure gates: pipeline backlog
 *   (captured + extracted-unrouted < 50; the LLM routing stage, not the
 *   network, is the true bottleneck), cache/disk headroom, per-domain
 *   throttle backoff, and profile readiness. There is NO fixed total: any
 *   corpus size converges, and the queue survives restarts.
 *
 * Size tiers (R5): inline reads for docx/text/loop; cache download + pipeline
 * extractor for binaries ≤ 25 MB; the parser's large-file lane (self-parsed
 * here in the drain, binary deleted immediately) for 25–150 MB; presence
 * evidence only above 150 MB. Truncation is first-class: every item carries
 * metadata.extractionTier, and partial coverage is never silent (plan §11.5.2).
 *
 * This module never calls a write-classified or blocked MCP tool.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpManager } from '../core/mcp-types.js';
import type { RawWorkItem } from '../core/types.js';
import { getSetting, setSetting } from '../core/storage.js';
import { diffDocumentTexts } from '../core/document-diff.js';
import { readZipEntry, extractCommentAnchors, extractTrackedChanges, DOCUMENT_XML_ENTRY } from '../core/docx-body-editor.js';
import { suggestionSettingKey, docKeyForPath, buildCorpusLinkIndex, extractDocumentLinks, replaceOutgoingLinks } from '../core/document-corpus.js';
import type { ContentStore, ContentRowColumns } from '../core/content-store.js';

const PROFILE_ID = 'sharepoint';

const KEYS = {
  enabled: 'sharepoint_sync.enabled',
  sources: 'sharepoint_sync.sources',
  lastRun: 'sharepoint_sync.last_run',
  backoffPrefix: 'sharepoint_sync.backoff.',
  surgePrefix: 'sharepoint_sync.surge.',
  /** Optional override; falls back to grasp_sync.owner_name / owner_email. */
  ownerName: 'sharepoint_sync.owner_name',
} as const;

// ── Size tiers and pacing (spec design constants) ──────────────────────────
const FULL_PARSE_MAX = 25 * 1024 * 1024;
const LARGE_LANE_MAX = 150 * 1024 * 1024;
const SURGE_THRESHOLD = 500;
const BACKLOG_HIGH_WATER = 50;
const CACHE_CAP_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 8 * 60_000;
const MAX_ATTEMPTS = 5;
const DOWNLOAD_TIMEOUT_MS = 600_000;

// .docx moved inline→binary 2026-08-26 (owner report: tables rendered as
// paragraph streams). The MCP's inline markdown conversion flattens Word
// tables to one line per cell; the binary lane hands the file to the
// extractor, whose native document.xml walker keeps tables (markdown pipe
// rows) and heading structure. Over-fullParseMax docx still degrades to
// presence (the large lane has no docx parser — unchanged behavior).
const INLINE_EXTS = new Set(['.md', '.txt', '.csv']);
const LOOP_EXTS = new Set(['.loop', '.fluid']);
const BINARY_EXTS = new Set(['.xlsx', '.pptx', '.pdf', '.docx']);

export interface SharePointSource {
  id: string;
  kind: 'shared_with_me' | 'onedrive' | 'library';
  siteUrl?: string;
  libraryName?: string;
  folderPath?: string;
  baseline: 'recent30' | 'days90' | 'all';
  baselineDone?: boolean;
  paused?: boolean;
  addedAt: string;
}

export interface SharePointSyncConfig {
  discoveryIntervalMs?: number; // default 30 min
  initialDelayMs?: number; // default 120 s
  drainIntervalMs?: number; // default 20 s
  drainBatch?: number; // default 2
  listPageSize?: number; // default 200 (tool max varies)
  maxListCallsPerDiscovery?: number; // safety valve, default 40
  backlogHighWater?: number; // default 50
  surgeThreshold?: number; // default 500
  cacheDir?: string;
  cacheCapBytes?: number;
  /** The server's cookie-jar directory (stale-auth self-heal target). */
  authJarDir?: string;
  /** Size-tier thresholds — injectable so tier-crossing tests avoid
   * hundred-MB fixtures. Defaults: 25 MB full-parse, 150 MB large lane. */
  fullParseMaxBytes?: number;
  largeLaneMaxBytes?: number;
  nowMs?: () => number; // injectable clock (tests)
}

interface QueuePayload {
  docKey: string;
  name: string;
  serverRelativeUrl: string;
  siteUrl?: string;
  webUrl: string;
  domain: string;
  modified: string; // ISO
  size: number;
  fileType: string; // extension with dot
  author?: string;
  lastModifiedBy?: string;
  sourceKind: SharePointSource['kind'];
  /** List-item id from sharepoint_list_files (absent for shared-with-me);
   * enables Details-pane comments via sharepoint_list_item_comments. */
  itemId?: number;
  /** Library title for item-comment calls (list_files sources only). */
  libraryName?: string;
}

interface DiscoveryCounters {
  listed: number;
  invalid: number;
  skippedType: number;
  unchanged: number;
  enqueued: number;
  listCalls: number;
}

export interface SharePointSyncResult {
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
  perSource: Record<string, DiscoveryCounters>;
  durationMs: number;
}

export interface SharePointSyncStatusView {
  enabled: boolean;
  discovering: boolean;
  draining: boolean;
  queue: { queued: number; failed: number; live: number; backfill: number };
  sources: Array<SharePointSource & { queued: number; surgePending?: number }>;
  gates: { backlog: boolean; cache: boolean; connection: boolean };
  backoffs: Record<string, string>; // domain → until ISO
  lastRun: Record<string, unknown> | null;
}

/** Structural forward-declaration of the parser's large lane (task 5 lands
 * the implementation; a stub-free parser simply routes large files to the
 * metadata-only tier, so this module ships and tests independently). */
export interface LargeLaneParser {
  parseLargeAsync?(filePath: string): Promise<{
    text: string;
    truncation: Record<string, unknown>;
  }>;
}

export interface SharePointSync {
  start(): void;
  stop(): void;
  runNow(): Promise<SharePointSyncResult>;
  drainNow(): Promise<number>;
  isRunning(): boolean;
  getStatus(): SharePointSyncStatusView;
  updateConfig(input: { enabled?: boolean; sources?: unknown }): SharePointSyncStatusView;
  confirmSurge(sourceId: string): SharePointSyncStatusView;
  /** Remove all SharePoint-sourced data: items, FTS, content files, queue, seen, cache. */
  purge(): { items: number; cacheFiles: number };
  /** Queue an on-demand live re-fetch of one document (reader Refresh,
   * workbench R2.3). Enqueues content (+comments for docx) at live priority;
   * the caller drives drainNow. */
  refreshDocument(docKey: string): { queued: boolean; reason?: string };
  /** Queue a document the corpus does not know yet, by path (authoring
   * bridge ingestion). The caller drives drainNow. */
  enqueueByPath(serverRelativeUrl: string, opts?: { siteUrl?: string; sizeBytes?: number }): { queued: boolean; docKey: string; reason?: string };
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function extOf(name: string): string {
  return path.extname(name || '').toLowerCase();
}

function compactStamp(iso: string): string {
  return iso.replace(/[-:TZ.]/g, '').slice(0, 14);
}

function parseToolJson<T>(text: string, tool: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${tool} returned non-JSON output (${text.slice(0, 120)})`);
  }
}

function isThrottleError(message: string): boolean {
  return /\b429\b|throttl|too many requests/i.test(message);
}

/**
 * Server v1.18 auth bug (diagnosed live 2026-08-24): an EXPIRED cookie jar in
 * ~/.amazon-sharepoint-mcp makes every call fail with "Silent authorize did
 * not return a code" (AADSTS50058) — the server loops on silent sign-in and
 * never falls back to its own automatic Midway SAML bootstrap. With the jar
 * REMOVED, the very next call bootstraps headlessly from the Midway cookie
 * and succeeds. Deleting stale jars is therefore safe and self-healing.
 */
function isStaleAuthJarError(message: string): boolean {
  return /silent authorize did not return a code/i.test(message);
}

export function createSharePointSync(deps: {
  db: Database.Database;
  mcpManager: McpManager;
  documentParser?: LargeLaneParser;
  /** Content reads for revision diff stamping (signals R2). Absent → sweep
   * disabled. Tests build a real store over their temp dirs. */
  contentStore?: Pick<ContentStore, 'refFromRow' | 'get'>;
  emit: (item: RawWorkItem) => void;
  config?: SharePointSyncConfig;
}): SharePointSync {
  const { db, mcpManager, emit } = deps;
  const parser = deps.documentParser;
  const contentStore = deps.contentStore;
  const cfg = deps.config ?? {};
  const now = cfg.nowMs ?? Date.now;
  const discoveryIntervalMs = cfg.discoveryIntervalMs ?? 30 * 60_000;
  const initialDelayMs = cfg.initialDelayMs ?? 120_000;
  const drainIntervalMs = cfg.drainIntervalMs ?? 20_000;
  const drainBatch = cfg.drainBatch ?? 2;
  const listPageSize = cfg.listPageSize ?? 200;
  const maxListCalls = cfg.maxListCallsPerDiscovery ?? 40;
  const backlogHighWater = cfg.backlogHighWater ?? BACKLOG_HIGH_WATER;
  const surgeThreshold = cfg.surgeThreshold ?? SURGE_THRESHOLD;
  const cacheDir = cfg.cacheDir ?? path.join(os.homedir(), '.personal-productivity-tracker', 'sharepoint-cache');
  const cacheCap = cfg.cacheCapBytes ?? CACHE_CAP_BYTES;
  const authJarDir = cfg.authJarDir ?? path.join(os.homedir(), '.amazon-sharepoint-mcp');
  const fullParseMax = cfg.fullParseMaxBytes ?? FULL_PARSE_MAX;
  const largeLaneMax = cfg.largeLaneMaxBytes ?? LARGE_LANE_MAX;

  let discovering = false;
  let draining = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLoggedError = '';

  // ── Owned tables (additive; module-owned per the feature map) ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sharepoint_sync_queue (
      doc_key TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'content' CHECK(kind IN ('content','comments')),
      priority TEXT NOT NULL CHECK(priority IN ('live','backfill')),
      payload_json TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_sp_queue_pick
      ON sharepoint_sync_queue(state, priority, discovered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sp_queue_source ON sharepoint_sync_queue(source_id);
    CREATE TABLE IF NOT EXISTS sharepoint_seen (
      doc_key TEXT PRIMARY KEY,
      modified TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Phase 2 migration: instances created before the comments lane lack the
  // kind column (CREATE TABLE IF NOT EXISTS never alters existing tables).
  {
    const cols = db.prepare("SELECT name FROM pragma_table_info('sharepoint_sync_queue')").all() as { name: string }[];
    if (!cols.some(c => c.name === 'kind')) {
      db.exec("ALTER TABLE sharepoint_sync_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'content'");
    }
  }

  // ── Settings-backed source list ───────────────────────────────────────────
  function getSources(): SharePointSource[] {
    const raw = getSetting<SharePointSource[]>(db, KEYS.sources);
    return Array.isArray(raw) ? raw : [];
  }

  function saveSources(sources: SharePointSource[]): void {
    setSetting(db, KEYS.sources, sources);
  }

  function sourceId(input: { kind: string; siteUrl?: string; libraryName?: string; folderPath?: string }): string {
    return sha1([input.kind, input.siteUrl ?? '', input.libraryName ?? '', input.folderPath ?? ''].join('|')).slice(0, 12);
  }

  function validateSource(raw: unknown): SharePointSource {
    if (!raw || typeof raw !== 'object') throw new Error('source must be an object');
    const record = raw as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== 'shared_with_me' && kind !== 'onedrive' && kind !== 'library') {
      throw new Error(`source kind '${String(kind)}' is not supported`);
    }
    const baseline = record.baseline ?? 'days90';
    if (baseline !== 'recent30' && baseline !== 'days90' && baseline !== 'all') {
      throw new Error(`baseline '${String(baseline)}' is not supported`);
    }
    const source: SharePointSource = {
      id: '',
      kind,
      baseline,
      baselineDone: record.baselineDone === true,
      paused: record.paused === true,
      addedAt: typeof record.addedAt === 'string' ? record.addedAt : new Date(now()).toISOString(),
    };
    if (kind === 'library') {
      const siteUrl = String(record.siteUrl ?? '');
      let host = '';
      try { host = new URL(siteUrl).hostname; } catch { /* rejected below */ }
      if (!siteUrl.startsWith('https://') || !host.endsWith('.sharepoint.com')) {
        throw new Error('library source needs an https siteUrl on a *.sharepoint.com domain');
      }
      const libraryName = String(record.libraryName ?? '').trim();
      if (!libraryName) throw new Error('library source needs a libraryName (library TITLE)');
      source.siteUrl = siteUrl;
      source.libraryName = libraryName;
      const folderPath = typeof record.folderPath === 'string' ? record.folderPath.trim() : '';
      if (folderPath) {
        if (folderPath.includes('..') || folderPath.startsWith('/')) throw new Error('folderPath must be a relative path');
        source.folderPath = folderPath;
      }
    }
    source.id = sourceId(source);
    return source;
  }

  // ── Profile readiness ─────────────────────────────────────────────────────
  async function connectionReady(): Promise<{ ok: boolean; reason?: string }> {
    if (getSetting<boolean>(db, KEYS.enabled) !== true) return { ok: false, reason: 'sync disabled' };
    const profile = await mcpManager.getProfile(PROFILE_ID);
    if (!profile) return { ok: false, reason: 'profile missing' };
    if (!profile.enabled || profile.state !== 'running') return { ok: false, reason: `profile ${profile.state}` };
    if (profile.compatibilityState !== 'compatible') return { ok: false, reason: `profile ${profile.compatibilityState}` };
    return { ok: true };
  }

  async function call<T>(tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    const result = await mcpManager.callTool(PROFILE_ID, tool, args, { source: 'api', timeoutMs });
    if (result.isError) throw new Error(`${tool} failed: ${result.text.slice(0, 300)}`);
    return parseToolJson<T>(result.text, tool);
  }

  /** Inline reads return raw content text, not JSON. */
  async function callText(tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<string> {
    const result = await mcpManager.callTool(PROFILE_ID, tool, args, { source: 'api', timeoutMs });
    if (result.isError) throw new Error(`${tool} failed: ${result.text.slice(0, 300)}`);
    return result.text;
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  interface ListedDoc {
    name: string;
    serverRelativeUrl: string;
    siteUrl?: string;
    webUrl: string;
    modified: string;
    size: number;
    author?: string;
    lastModifiedBy?: string;
    itemId?: number;
  }

  function normalizeEntry(source: SharePointSource, entry: Record<string, unknown>, counters: DiscoveryCounters): ListedDoc | null {
    const isFolder = entry.IsFolder === true;
    const isDocument = entry.IsDocument === undefined || String(entry.IsDocument) === 'true';
    if (isFolder || !isDocument) return null;
    const name = String(entry.Title ?? entry.Name ?? '').trim();
    const serverRelativeUrl = String(entry.Path ?? '').trim();
    const webUrl = String(entry.WebUrl ?? '').trim();
    const modifiedRaw = String(entry.LastModifiedTime ?? entry.Modified ?? '').trim();
    const size = Number(entry.Size ?? 0);
    let host = '';
    try { host = new URL(webUrl).hostname; } catch { /* invalid */ }
    const modifiedMs = Date.parse(modifiedRaw);
    if (!name || !serverRelativeUrl.startsWith('/') || !webUrl.startsWith('https://')
      || !host.endsWith('.sharepoint.com') || !Number.isFinite(modifiedMs)
      || !Number.isFinite(size) || size < 0) {
      counters.invalid++;
      return null;
    }
    const siteUrl = typeof entry.SiteUrl === 'string' && entry.SiteUrl ? entry.SiteUrl : source.siteUrl;
    const itemId = Number(entry.Id);
    return {
      name,
      serverRelativeUrl,
      siteUrl,
      webUrl,
      modified: new Date(modifiedMs).toISOString(),
      size,
      author: typeof entry.Author === 'string' ? entry.Author : undefined,
      lastModifiedBy: typeof entry.LastModifiedBy === 'string' ? entry.LastModifiedBy : undefined,
      ...(Number.isInteger(itemId) && itemId > 0 ? { itemId } : {}),
    };
  }

  async function listSource(source: SharePointSource, counters: DiscoveryCounters, budget: { calls: number }): Promise<ListedDoc[]> {
    const docs: ListedDoc[] = [];
    if (source.kind === 'shared_with_me') {
      budget.calls++;
      counters.listCalls++;
      const resp = await call<{ results?: Record<string, unknown>[] }>(
        'sharepoint_list_shared_with_me', { rowLimit: 500 }, 120_000,
      );
      for (const entry of resp.results ?? []) {
        counters.listed++;
        const doc = normalizeEntry(source, entry, counters);
        if (doc) docs.push(doc);
      }
      return docs;
    }
    // onedrive / library: paginated sharepoint_list_files
    let skipToken: string | undefined;
    do {
      if (budget.calls >= maxListCalls) break;
      budget.calls++;
      counters.listCalls++;
      const args: Record<string, unknown> = {
        libraryName: source.kind === 'onedrive' ? 'Documents' : source.libraryName,
        top: listPageSize,
        includeWebUrls: true,
        ...(source.kind === 'library' ? { siteUrl: source.siteUrl, personal: false } : {}),
        ...(source.folderPath ? { folderPath: source.folderPath } : {}),
        ...(skipToken ? { skipToken } : {}),
      };
      const resp = await call<{ files?: Record<string, unknown>[]; nextToken?: string }>(
        'sharepoint_list_files', args, 120_000,
      );
      for (const entry of resp.files ?? []) {
        counters.listed++;
        const doc = normalizeEntry(source, entry, counters);
        if (doc) docs.push(doc);
      }
      skipToken = typeof resp.nextToken === 'string' && resp.nextToken ? resp.nextToken : undefined;
    } while (skipToken);
    return docs;
  }

  /**
   * Baseline split for a source's FIRST discovery: `included` documents are
   * enqueued; `excluded` ones are recorded in seen-state AS-IS (seen without
   * sync) so they enqueue only when they LATER change. Without that record,
   * the second discovery would find them absent from seen-state and leak the
   * entire pre-baseline corpus in as "changed" (caught in live validation,
   * 2026-08-24: a 90-day baseline of 91 docs grew to 156 queued on the next
   * cycle). An old document that someone edits tomorrow still syncs — it
   * genuinely changed; one that never changes never syncs.
   */
  function applyBaseline(source: SharePointSource, docs: ListedDoc[]): { included: ListedDoc[]; excluded: ListedDoc[] } {
    if (source.baselineDone) return { included: docs, excluded: [] };
    const sorted = [...docs].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    if (source.baseline === 'recent30') return { included: sorted.slice(0, 30), excluded: sorted.slice(30) };
    if (source.baseline === 'days90') {
      const floor = now() - 90 * 86_400_000;
      return {
        included: sorted.filter(doc => Date.parse(doc.modified) >= floor),
        excluded: sorted.filter(doc => Date.parse(doc.modified) < floor),
      };
    }
    return { included: sorted, excluded: [] };
  }

  const upsertQueue = db.prepare(`
    INSERT INTO sharepoint_sync_queue
      (doc_key, source_id, kind, priority, payload_json, discovered_at, attempts, last_error, state)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 'queued')
    ON CONFLICT(doc_key) DO UPDATE SET
      source_id = excluded.source_id,
      priority = excluded.priority,
      payload_json = excluded.payload_json,
      discovered_at = excluded.discovered_at,
      attempts = 0, last_error = NULL, state = 'queued'
  `);

  async function runDiscovery(): Promise<SharePointSyncResult> {
    const startedAt = now();
    const result: SharePointSyncResult = { status: 'completed', perSource: {}, durationMs: 0 };
    const ready = await connectionReady();
    if (!ready.ok) {
      result.status = 'skipped';
      result.reason = ready.reason;
      result.durationMs = now() - startedAt;
      return result;
    }

    const budget = { calls: 0 };
    const sources = getSources();
    let sourcesDirty = false;

    for (const source of sources) {
      if (source.paused) continue;
      const counters: DiscoveryCounters = { listed: 0, invalid: 0, skippedType: 0, unchanged: 0, enqueued: 0, listCalls: 0 };
      result.perSource[source.id] = counters;
      try {
        const listed = await listSource(source, counters, budget);
        const { included: scoped, excluded: baselineExcluded } = applyBaseline(source, listed);
        const isBaseline = !source.baselineDone;
        const seenStmt = db.prepare('SELECT modified, size FROM sharepoint_seen WHERE doc_key = ?');
        const queuedStmt = db.prepare("SELECT payload_json FROM sharepoint_sync_queue WHERE doc_key = ? AND state = 'queued'");
        let changedCount = 0;
        const toEnqueue: QueuePayload[] = [];

        for (const doc of scoped) {
          const ext = extOf(doc.name) || extOf(doc.serverRelativeUrl);
          if (!INLINE_EXTS.has(ext) && !LOOP_EXTS.has(ext) && !BINARY_EXTS.has(ext)) {
            counters.skippedType++;
            continue;
          }
          const domain = new URL(doc.webUrl).hostname;
          const docKey = `${domain}${doc.serverRelativeUrl}`;
          const seen = seenStmt.get(docKey) as { modified: string; size: number } | undefined;
          if (seen && seen.modified === doc.modified && seen.size === doc.size) {
            counters.unchanged++;
            continue;
          }
          // Already queued at the same version → leave the row alone. Without
          // this, every discovery re-UPSERTed still-queued docs (observed
          // live 2026-08-24: 73 backfill rows promoted to live), refreshing
          // discovered_at, resetting attempts (defeating the attempts cap),
          // and promoting backfill priority. A genuinely NEWER version still
          // falls through to the UPSERT, which is exactly right.
          const queuedRow = queuedStmt.get(docKey) as { payload_json: string } | undefined;
          if (queuedRow) {
            try {
              const queued = JSON.parse(queuedRow.payload_json) as { modified?: string; size?: number };
              if (queued.modified === doc.modified && queued.size === doc.size) {
                counters.unchanged++;
                continue;
              }
            } catch { /* unparseable payload — let the UPSERT repair it */ }
          }
          changedCount++;
          toEnqueue.push({
            docKey,
            name: doc.name,
            serverRelativeUrl: doc.serverRelativeUrl,
            siteUrl: doc.siteUrl,
            webUrl: doc.webUrl,
            domain,
            modified: doc.modified,
            size: doc.size,
            fileType: ext,
            author: doc.author,
            lastModifiedBy: doc.lastModifiedBy,
            sourceKind: source.kind,
            ...(doc.itemId !== undefined ? { itemId: doc.itemId } : {}),
            ...(source.kind === 'onedrive'
              ? { libraryName: 'Documents' }
              : source.kind === 'library' && source.libraryName
                ? { libraryName: source.libraryName }
                : {}),
          });
        }

        // Surge guard: an unexpected mass-change (library reorg, bulk re-share)
        // pauses the source pending one-click confirmation. Baselines are
        // exempt — their size was an explicit user choice.
        if (!isBaseline && changedCount > surgeThreshold) {
          source.paused = true;
          sourcesDirty = true;
          setSetting(db, `${KEYS.surgePrefix}${source.id}`, changedCount);
          console.warn(`[SharePointSync] surge: source ${source.id} reports ${changedCount} changed documents — paused pending confirmation`);
          continue;
        }

        const markSeen = db.prepare(`
          INSERT INTO sharepoint_seen (doc_key, modified, size, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(doc_key) DO NOTHING
        `);
        const tx = db.transaction(() => {
          for (const payload of toEnqueue) {
            const priority = isBaseline ? 'backfill' : 'live';
            const json = JSON.stringify(payload);
            const ts = new Date(now()).toISOString();
            upsertQueue.run(payload.docKey, source.id, 'content', priority, json, ts);
            counters.enqueued++;
            // A changed document that can carry comments gets a paired
            // comments entry. Not counted in enqueued/changedCount: the surge
            // guard and reporting stay in units of documents, not fetches.
            if (payload.fileType === '.docx' || payload.itemId !== undefined) {
              upsertQueue.run(`${payload.docKey}#comments`, source.id, 'comments', priority, json, ts);
            }
          }
          // Baseline-excluded documents: seen without sync (see applyBaseline).
          for (const doc of baselineExcluded) {
            const ext = extOf(doc.name) || extOf(doc.serverRelativeUrl);
            if (!INLINE_EXTS.has(ext) && !LOOP_EXTS.has(ext) && !BINARY_EXTS.has(ext)) continue;
            const domain = new URL(doc.webUrl).hostname;
            markSeen.run(`${domain}${doc.serverRelativeUrl}`, doc.modified, doc.size, new Date(now()).toISOString());
          }
        });
        tx();

        if (isBaseline) {
          source.baselineDone = true;
          sourcesDirty = true;
        }
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        result.status = 'failed';
        result.reason = message.slice(0, 300);
        if (isThrottleError(message)) recordThrottle('discovery');
        if (isStaleAuthJarError(message)) healStaleAuthJars();
        break; // one failing source ends the cycle; seen state untouched, next run retries
      }
    }

    if (sourcesDirty) saveSources(sources);
    result.durationMs = now() - startedAt;
    setSetting(db, KEYS.lastRun, {
      at: new Date(now()).toISOString(),
      status: result.status,
      reason: result.reason ?? null,
      perSource: result.perSource,
      durationMs: result.durationMs,
    });
    if (result.status === 'failed') {
      if (result.reason !== lastLoggedError) {
        console.warn(`[SharePointSync] discovery failed: ${result.reason}`);
        lastLoggedError = result.reason ?? '';
      }
    } else {
      lastLoggedError = '';
      const totals = Object.values(result.perSource).reduce(
        (acc, c) => ({ listed: acc.listed + c.listed, enqueued: acc.enqueued + c.enqueued, unchanged: acc.unchanged + c.unchanged }),
        { listed: 0, enqueued: 0, unchanged: 0 },
      );
      if (totals.listed > 0 || totals.enqueued > 0) {
        console.log(`[SharePointSync] discovery ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s — ${totals.listed} listed → ${totals.enqueued} enqueued (${totals.unchanged} unchanged)`);
      }
    }
    return result;
  }

  // ── Stale-auth self-heal (see isStaleAuthJarError) ────────────────────────
  // At most once per 10 minutes: delete the server's cookie jars AND restart
  // the managed server. Both halves are required (verified live 2026-08-24):
  // the jars block the on-disk bootstrap, and the running child additionally
  // caches the stale auth state in memory — a fresh process with no jar
  // re-bootstraps headlessly from the Midway cookie and succeeds. Nothing
  // sensitive is lost; the jars are derived session state.
  let lastJarHealAt = 0;
  function healStaleAuthJars(): void {
    if (now() - lastJarHealAt < 10 * 60_000) return;
    lastJarHealAt = now();
    let removed = 0;
    try {
      for (const name of fs.readdirSync(authJarDir)) {
        if (/^cookies-.*\.json$/.test(name)) {
          try { fs.unlinkSync(path.join(authJarDir, name)); removed++; } catch { /* best effort */ }
        }
      }
    } catch { /* dir absent — nothing to heal */ }
    console.warn(`[SharePointSync] auth self-heal: removed ${removed} stale cookie jar(s); restarting the server to drop its in-memory auth state`);
    void mcpManager.restart(PROFILE_ID).catch((error) => {
      console.warn(`[SharePointSync] auth self-heal restart failed: ${(error as Error)?.message ?? error}`);
    });
  }

  // ── Throttle backoff (per domain; 'discovery' is a pseudo-domain) ────────
  function backoffKey(domain: string): string {
    return `${KEYS.backoffPrefix}${domain}`;
  }

  function recordThrottle(domain: string): void {
    const state = getSetting<{ until: number; level: number }>(db, backoffKey(domain));
    const level = Math.min((state?.level ?? 0) + 1, 5);
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (level - 1), BACKOFF_MAX_MS);
    setSetting(db, backoffKey(domain), { until: now() + wait, level });
  }

  function clearThrottle(domain: string): void {
    const state = getSetting<{ until: number; level: number }>(db, backoffKey(domain));
    if (state) setSetting(db, backoffKey(domain), { until: 0, level: 0 });
  }

  function throttledUntil(domain: string): number {
    const state = getSetting<{ until: number; level: number }>(db, backoffKey(domain));
    return state?.until ?? 0;
  }

  // ── Backpressure gates ────────────────────────────────────────────────────
  function backlogGateGreen(): boolean {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM work_items WHERE process_state IN ('captured','extracted') AND project_id IS NULL",
    ).get() as { c: number };
    return row.c < backlogHighWater;
  }

  function cacheGateGreen(): boolean {
    if (listCacheFiles().reduce((acc, f) => acc + f.size, 0) > cacheCap) return false;
    try {
      const stats = fs.statfsSync(os.homedir());
      return stats.bavail * stats.bsize > MIN_FREE_DISK_BYTES;
    } catch {
      return true; // statfs unavailable — do not wedge the drain on a metric
    }
  }

  /** Two-level walk of the module-owned cache layout: cacheDir/<hash>/<file>. */
  function listCacheFiles(): Array<{ full: string; mtime: number; size: number }> {
    const files: Array<{ full: string; mtime: number; size: number }> = [];
    let dirs: fs.Dirent[] = [];
    try { dirs = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { return files; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const sub = path.join(cacheDir, dir.name);
      let names: string[] = [];
      try { names = fs.readdirSync(sub); } catch { continue; }
      for (const name of names) {
        const full = path.join(sub, name);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile()) files.push({ full, mtime: stat.mtimeMs, size: stat.size });
        } catch { /* raced */ }
      }
    }
    return files;
  }

  // ── Drain ─────────────────────────────────────────────────────────────────
  // Over-fetch beyond the per-tick batch so rows held back by a paused
  // source or an active domain backoff cannot starve everything behind them.
  const pickQueue = db.prepare(`
    SELECT doc_key AS docKey, source_id AS sourceId, kind, priority, payload_json AS payloadJson, attempts
    FROM sharepoint_sync_queue
    WHERE state = 'queued'
    ORDER BY CASE priority WHEN 'live' THEN 0 ELSE 1 END, discovered_at DESC
    LIMIT ?
  `);

  async function drainOnce(): Promise<number> {
    if (draining) return 0;
    draining = true;
    let processed = 0;
    try {
      // Revision diff stamping is pure-local work (no MCP) — it runs every
      // tick, before any connection/gate checks, so "what changed" lands
      // even while SharePoint itself is unreachable.
      try { linkSweep(); } catch (error) {
        console.warn(`[SharePointSync] link sweep failed: ${(error as Error).message}`);
      }
      try { stampRevisionDiffs(); } catch (error) {
        console.warn(`[SharePointSync] revision diff sweep failed: ${(error as Error).message}`);
      }
      const ready = await connectionReady();
      if (!ready.ok) return 0;
      if (!backlogGateGreen() || !cacheGateGreen()) return 0;

      const rows = pickQueue.all(drainBatch * 10) as Array<{ docKey: string; sourceId: string; kind: 'content' | 'comments'; priority: string; payloadJson: string; attempts: number }>;
      if (rows.length === 0) return 0;

      const sources = new Map(getSources().map(s => [s.id, s]));
      let largeLaneUsed = false;
      let attempted = 0;

      for (const row of rows) {
        if (attempted >= drainBatch) break;
        // Source removed or paused since discovery → drop / hold the entry.
        const source = sources.get(row.sourceId);
        if (!source) {
          db.prepare('DELETE FROM sharepoint_sync_queue WHERE doc_key = ?').run(row.docKey);
          continue;
        }
        if (source.paused) continue;

        let payload: QueuePayload;
        try {
          payload = JSON.parse(row.payloadJson) as QueuePayload;
        } catch {
          db.prepare("UPDATE sharepoint_sync_queue SET state = 'failed', last_error = 'unparseable payload' WHERE doc_key = ?").run(row.docKey);
          continue;
        }

        if (throttledUntil(payload.domain) > now()) continue;
        // One large-lane acquisition per tick keeps long downloads from
        // monopolizing the serialized MCP call queue. Comments fetches are
        // small (one MCP call, JSON out) and never occupy the large lane.
        const isLarge = row.kind === 'content' && payload.size > fullParseMax;
        if (isLarge && largeLaneUsed) continue;

        attempted++;
        try {
          if (row.kind === 'comments') await acquireComments(payload);
          else await acquireOne(payload);
          if (isLarge) largeLaneUsed = true;
          db.transaction(() => {
            // Comments rows never touch sharepoint_seen: per-comment state is
            // the durable work_items URL check, and writing seen here could
            // mark a doc version seen before its content row has processed.
            if (row.kind !== 'comments') {
              db.prepare(`
                INSERT INTO sharepoint_seen (doc_key, modified, size, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(doc_key) DO UPDATE SET modified = excluded.modified, size = excluded.size, updated_at = excluded.updated_at
              `).run(payload.docKey, payload.modified, payload.size, new Date(now()).toISOString());
            }
            db.prepare('DELETE FROM sharepoint_sync_queue WHERE doc_key = ?').run(row.docKey);
          })();
          clearThrottle(payload.domain);
          processed++;
        } catch (error) {
          const message = ((error as Error).message ?? String(error)).slice(0, 500);
          if (isThrottleError(message)) recordThrottle(payload.domain);
          if (isStaleAuthJarError(message)) healStaleAuthJars();
          const attempts = row.attempts + 1;
          db.prepare(`
            UPDATE sharepoint_sync_queue
            SET attempts = ?, last_error = ?, state = CASE WHEN ? >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END
            WHERE doc_key = ?
          `).run(attempts, message, attempts, row.docKey);
        }
      }
      sweepCache();
      return processed;
    } finally {
      draining = false;
    }
  }

  /** Route one queue payload through its size/type tier and emit the item. */
  async function acquireOne(payload: QueuePayload): Promise<void> {
    const ext = payload.fileType;
    const isFresh = !db.prepare('SELECT 1 FROM sharepoint_seen WHERE doc_key = ?').get(payload.docKey);
    const url = isFresh ? payload.webUrl : `${payload.webUrl}#rev=${compactStamp(payload.modified)}`;

    // Tier: metadata-only presence evidence. Inline-type files (docx/text/
    // loop) have no large lane — over the full-parse cap they degrade to
    // presence rather than pulling tens of MB of text through stdio.
    if (payload.size > largeLaneMax || ((INLINE_EXTS.has(ext) || LOOP_EXTS.has(ext) || ext === '.docx') && payload.size > fullParseMax)) {
      emitItem(payload, url, {
        content: `Large document (${Math.round(payload.size / 1024 / 1024)} MB) — content not synced. `
          + `Author: ${payload.author ?? 'unknown'}; last modified by ${payload.lastModifiedBy ?? 'unknown'} on ${payload.modified.slice(0, 10)}. Open in SharePoint to view.`,
        tier: 'metadata_only',
      });
      return;
    }

    // Tier: inline text reads (docx→markdown, plain text, loop).
    if (INLINE_EXTS.has(ext) || LOOP_EXTS.has(ext)) {
      const text = LOOP_EXTS.has(ext)
        ? await callText('sharepoint_read_loop', { loopUrl: payload.webUrl }, 120_000)
        : await callText('sharepoint_read_file', {
            serverRelativeUrl: payload.serverRelativeUrl,
            ...(payload.siteUrl ? { siteUrl: payload.siteUrl } : {}),
            inline: true,
            ...(ext === '.docx' ? { format: 'markdown', stripImages: true } : {}),
          }, 180_000);
      const content = text.trim();
      if (!content) throw new Error('inline read returned empty content');
      emitItem(payload, url, { content, tier: 'full' });
      return;
    }

    // Binary tiers: download to cache with torn-file protection.
    const dir = path.join(cacheDir, sha1(payload.docKey).slice(0, 16));
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, path.basename(payload.serverRelativeUrl));
    const partPath = `${finalPath}.part`;
    try { fs.unlinkSync(partPath); } catch { /* none */ }

    await callText('sharepoint_read_file', {
      serverRelativeUrl: payload.serverRelativeUrl,
      ...(payload.siteUrl ? { siteUrl: payload.siteUrl } : {}),
      savePath: partPath,
    }, DOWNLOAD_TIMEOUT_MS);

    const stat = fs.statSync(partPath);
    // Torn-download protection: an empty file is always a failure.
    if (stat.size === 0) {
      try { fs.unlinkSync(partPath); } catch { /* best effort */ }
      throw new Error(`download size mismatch (0 != ${payload.size}) — empty download`);
    }
    // SharePoint listings sometimes report stale or plain wrong sizes
    // (observed live: xlsx listed 43970 vs actual 44540; pptx listed 95402
    // vs actual 220141275). The downloaded bytes are ground truth — accept
    // the actual size, and RE-TIER when the correction crosses a size tier
    // (signals spec R1; previously these dead-lettered after 5 attempts).
    if (payload.size > 0 && stat.size !== payload.size) {
      console.warn(`[SharePointSync] listing size stale for ${payload.docKey}: listed ${payload.size}, actual ${stat.size} — using actual`);
      payload.size = stat.size; // seen/emit metadata record the corrected size
      if (stat.size > largeLaneMax) {
        // Way over the large lane: never hand this to the extractor or the
        // bounded parser — degrade to presence evidence like any oversize doc.
        try { fs.unlinkSync(partPath); } catch { /* best effort */ }
        emitItem(payload, url, {
          content: `Large document (${Math.round(stat.size / 1024 / 1024)} MB — listing reported a wrong size) — content not synced. `
            + `Author: ${payload.author ?? 'unknown'}; last modified by ${payload.lastModifiedBy ?? 'unknown'} on ${payload.modified.slice(0, 10)}. Open in SharePoint to view.`,
          tier: 'metadata_only',
        });
        return;
      }
    }
    fs.renameSync(partPath, finalPath);

    if (payload.size <= fullParseMax) {
      // Pipeline extractor parses it; the cache sweep evicts after extraction.
      emitItem(payload, url, { filePath: finalPath, tier: 'full' });
      return;
    }

    // Large lane: self-parse in the drain (bounded by design), then delete
    // the binary immediately — no extraction race, nothing squats in cache.
    if (!parser?.parseLargeAsync) {
      try { fs.unlinkSync(finalPath); } catch { /* best effort */ }
      emitItem(payload, url, {
        content: `Large document (${Math.round(payload.size / 1024 / 1024)} MB) — bounded extraction unavailable in this build. `
          + `Author: ${payload.author ?? 'unknown'}; last modified ${payload.modified.slice(0, 10)}. Open in SharePoint to view.`,
        tier: 'metadata_only',
      });
      return;
    }
    try {
      const parsed = await parser.parseLargeAsync(finalPath);
      emitItem(payload, url, { content: parsed.text, tier: 'truncated', truncation: parsed.truncation });
    } finally {
      try { fs.unlinkSync(finalPath); } catch { /* best effort */ }
    }
  }

  function emitItem(
    payload: QueuePayload,
    url: string,
    body: { content?: string; filePath?: string; tier: 'full' | 'truncated' | 'metadata_only'; truncation?: Record<string, unknown> },
  ): void {
    const metadata: Record<string, string> = {
      docKey: payload.docKey,
      serverRelativeUrl: payload.serverRelativeUrl,
      webUrl: payload.webUrl,
      fileType: payload.fileType,
      sizeBytes: String(payload.size),
      lastModified: payload.modified,
      sharePointSource: payload.sourceKind,
      extractionTier: body.tier,
    };
    if (payload.siteUrl) metadata.siteUrl = payload.siteUrl;
    if (payload.author) metadata.author = payload.author;
    if (payload.lastModifiedBy) metadata.lastModifiedBy = payload.lastModifiedBy;
    if (body.filePath) metadata.filePath = body.filePath;
    if (body.truncation) metadata.truncation = JSON.stringify(body.truncation);

    emit({
      type: 'document_capture',
      source: 'sharepoint',
      sourceApp: 'SharePoint',
      url,
      title: payload.name,
      content: body.content ?? '',
      metadata,
      capturedAt: new Date(now()),
    });
  }

  // ── Comments lane (phase 2) ───────────────────────────────────────────────

  interface NormalizedComment {
    id: string;
    author: string;
    date?: string; // ISO when parseable
    text: string;
    resolved: boolean;
    parentId?: string;
  }

  /** Owner identity for direction/mention checks. Explicit sharepoint_sync
   * override wins; otherwise the GRASP-detected identity. Owner unknown →
   * matcher matches nothing (fail-quiet, spec R3.3). */
  function buildOwnerMatcher(): { isOwner(author: string): boolean; mentionsOwner(text: string): boolean } {
    const name = (getSetting<string>(db, KEYS.ownerName) ?? getSetting<string>(db, 'grasp_sync.owner_name') ?? '').trim();
    const email = (getSetting<string>(db, 'grasp_sync.owner_email') ?? '').trim().toLowerCase();
    const localPart = email.includes('@') ? email.split('@')[0] : '';

    const normalize = (value: string): string[] =>
      value.toLowerCase().replace(/[.,;:'"()]/g, ' ').split(/\s+/).filter(Boolean);
    const nameTokens = normalize(name).sort();

    // Word-boundary phrase variants for mention detection: "Last, First",
    // "First Last", "Last First" all reduce to token sequences; single-token
    // names and the email local part are matched as standalone words.
    const parts = normalize(name);
    const phrases = new Set<string>();
    if (parts.length >= 2) {
      phrases.add(parts.join(' '));
      phrases.add([...parts].reverse().join(' '));
    } else if (parts.length === 1) {
      phrases.add(parts[0]);
    }
    if (localPart) phrases.add(localPart);

    return {
      isOwner(author: string): boolean {
        if (nameTokens.length === 0 && !localPart) return false;
        const authorTokens = normalize(author).sort();
        if (nameTokens.length > 0 && authorTokens.length > 0
          && nameTokens.length === authorTokens.length
          && nameTokens.every((t, i) => t === authorTokens[i])) return true;
        return localPart !== '' && authorTokens.length === 1 && authorTokens[0] === localPart;
      },
      mentionsOwner(text: string): boolean {
        if (phrases.size === 0) return false;
        const haystack = ` ${text.toLowerCase().replace(/[.,;:'"()@]/g, ' ').replace(/\s+/g, ' ')} `;
        for (const phrase of phrases) {
          if (haystack.includes(` ${phrase} `)) return true;
        }
        return false;
      },
    };
  }

  /** Defensive parse of a comments payload: accepts a flat array (probed
   * docx shape: {id, author, initials, date, text, done?, parentId?}) or an
   * object wrapping one under comments/value/items. Unknown fields ignored;
   * entries without id+text are dropped. */
  function normalizeComments(raw: unknown): NormalizedComment[] {
    let list: unknown[] = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === 'object') {
      const record = raw as Record<string, unknown>;
      for (const key of ['comments', 'value', 'items']) {
        if (Array.isArray(record[key])) { list = record[key] as unknown[]; break; }
      }
    }
    const out: NormalizedComment[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = rec.id ?? rec.Id ?? rec.replyId;
      const text = rec.text ?? rec.content ?? rec.Text;
      if (id === undefined || id === null || typeof text !== 'string' || text.trim() === '') continue;
      const authorRaw = rec.author ?? rec.Author;
      const author = typeof authorRaw === 'string'
        ? authorRaw
        : authorRaw && typeof authorRaw === 'object' && typeof (authorRaw as Record<string, unknown>).name === 'string'
          ? String((authorRaw as Record<string, unknown>).name)
          : 'unknown';
      const dateRaw = rec.date ?? rec.createdDate ?? rec.CreatedDate;
      // Word's undated comments carry a 1900-01-01 placeholder — treat any
      // pre-epoch stamp as "no date" so capture time is used instead.
      const parsedDate = typeof dateRaw === 'string' && !Number.isNaN(Date.parse(dateRaw)) && Date.parse(dateRaw) >= 0
        ? new Date(dateRaw).toISOString() : undefined;
      const parentRaw = rec.parentId ?? rec.ParentId ?? rec.replyTo;
      out.push({
        id: String(id),
        author,
        date: parsedDate,
        text: text.trim(),
        resolved: rec.done === true || rec.isResolved === true,
        parentId: parentRaw === undefined || parentRaw === null || String(parentRaw) === '' ? undefined : String(parentRaw),
      });
    }
    return out;
  }

  /**
   * Durable comment identity across Word's id renumbering (soak find
   * 2026-08-25: co-authoring renumbers comment ids — the same comment came
   * back as id 8, then 17, and the URL-based dedup emitted it again).
   * Author + timestamp survive renumbering; when the docx carries no date,
   * fall back to the normalized text.
   */
  /**
   * Word renumbers comment IDS on co-authoring saves and RE-STAMPS DATES on
   * edits (observed live: one comment as ids 22→28→32 with three different
   * timestamps, and dated↔undated flips). So identity gets two forms:
   *   date form — author + timestamp (1900-01-01 placeholders excluded);
   *   text form — author + normalized text, trusted only when the text is
   *   substantial (≥20 chars): short notes like "Done." legitimately repeat.
   * A stored row matching EITHER form of a live comment is the same comment.
   */
  const TEXT_FP_MIN_CHARS = 20;
  function commentFingerprints(author: string, date: string | undefined, text: string): { dateFp?: string; textFp?: string; groupKey: string } {
    const parsed = date ? Date.parse(date) : NaN;
    const usableDate = Number.isFinite(parsed) && parsed >= 0;
    const normText = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    const dateFp = usableDate ? `${author}\u0000d\u0000${date}` : undefined;
    const textFp = normText.length >= TEXT_FP_MIN_CHARS ? `${author}\u0000t\u0000${normText}` : undefined;
    // Sweep grouping: substantial text is the strongest renumber-stable key;
    // short texts group by date (or the short text when no date exists).
    const groupKey = textFp ?? dateFp ?? `${author}\u0000t\u0000${normText}`;
    return { dateFp, textFp, groupKey };
  }

  /**
   * One-time-per-boot hygiene sweep: rows that are the SAME comment under
   * renumbered ids collapse to the earliest capture (original evidence),
   * merging anchorText when only a duplicate carried it. Uses the full
   * deletion recipe (fts + node links + ocr + todos). Idempotent.
   */
  function sweepDuplicateComments(): void {
    const rows = db.prepare(`
      SELECT id, url, captured_at AS capturedAt, metadata, COALESCE(raw_text, '') AS text
      FROM work_items WHERE source = 'sharepoint' AND type = 'document_comment'
    `).all() as Array<{ id: string; url: string | null; capturedAt: string; metadata: string | null; text: string }>;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(row.metadata ?? '{}'); } catch { continue; }
      const docKey = String(meta.docKey ?? '');
      if (!docKey) continue;
      const fragment = String(row.url ?? '').includes('#itemcomment') ? '#itemcomment=' : '#comment=';
      const { groupKey } = commentFingerprints(
        String(meta.author ?? 'unknown'),
        typeof meta.commentedAt === 'string' ? meta.commentedAt : undefined,
        row.text,
      );
      const key = `${docKey}\u0000${fragment}\u0000${groupKey}`;
      const list = groups.get(key);
      if (list) list.push(row); else groups.set(key, [row]);
    }
    // Pre-epoch commentedAt stamps (Word's 1900-01-01 placeholder) read as
    // "126 years ago" and break thread ordering — drop the key so readers
    // fall back to capture time.
    const badDates = rows.filter(row => {
      try {
        const at = (JSON.parse(row.metadata ?? '{}') as Record<string, unknown>).commentedAt;
        if (typeof at !== 'string' || at === '') return false;
        const parsed = Date.parse(at);
        return !Number.isFinite(parsed) || parsed < 0;
      } catch { return false; }
    });

    let removed = 0;
    const tx = db.transaction(() => {
      for (const row of badDates) {
        db.prepare("UPDATE work_items SET metadata = json_remove(metadata, '$.commentedAt') WHERE id = ?").run(row.id);
      }
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
        const survivor = list[0];
        const dupes = list.slice(1);
        const anchor = dupes
          .map(d => { try { return String((JSON.parse(d.metadata ?? '{}') as Record<string, unknown>).anchorText ?? ''); } catch { return ''; } })
          .find(a => a !== '');
        if (anchor) {
          db.prepare(`
            UPDATE work_items SET metadata = json_set(COALESCE(metadata, '{}'), '$.anchorText', ?)
            WHERE id = ? AND json_extract(metadata, '$.anchorText') IS NULL
          `).run(anchor, survivor.id);
        }
        for (const dupe of dupes) {
          db.prepare('DELETE FROM work_items_fts WHERE item_id = ?').run(dupe.id);
          db.prepare('DELETE FROM node_work_items WHERE work_item_id = ?').run(dupe.id);
          db.prepare('DELETE FROM item_ocr_lines WHERE item_id = ?').run(dupe.id);
          db.prepare('DELETE FROM agent_todos WHERE work_item_id = ?').run(dupe.id);
          db.prepare('DELETE FROM work_items WHERE id = ?').run(dupe.id);
          removed++;
        }
      }
    });
    tx();
    if (removed > 0) console.log(`[SharePointSync] comment dedup sweep removed ${removed} renumbered-id duplicate row(s)`);
    if (badDates.length > 0) console.log(`[SharePointSync] comment sweep cleared ${badDates.length} placeholder (pre-epoch) comment date(s)`);
  }
  sweepDuplicateComments();

  /** Walk the parentId chain to the thread root (cycle-safe). */
  function threadRootOf(comment: NormalizedComment, byId: Map<string, NormalizedComment>): string {
    let current = comment;
    const visited = new Set<string>([current.id]);
    while (current.parentId !== undefined) {
      const parent = byId.get(current.parentId);
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      current = parent;
    }
    return current.id;
  }

  /** Fetch review comments for a queued document and emit one work item per
   * comment not already in the evidence store (durable URL check — no time
   * window). Resolved comments emit too: they are evidence of decisions. */
  async function acquireComments(payload: QueuePayload): Promise<void> {
    // Two independent id spaces on the same document URL, kept apart by the
    // URL fragment: Word review comments (#comment=) and Details-pane item
    // comments (#itemcomment=).
    const groups: Array<{ comments: NormalizedComment[]; fragment: string }> = [];

    let commentAnchors = new Map<string, string>();
    if (payload.fileType === '.docx') {
      const text = await callText('sharepoint_read_docx_comments', {
        serverRelativeUrl: payload.serverRelativeUrl,
        ...(payload.siteUrl ? { siteUrl: payload.siteUrl } : {}),
      }, 60_000);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error('docx comments response was not JSON'); }
      const docxComments = normalizeComments(parsed);
      groups.push({ comments: docxComments, fragment: '#comment=' });

      // Anchor + tracked-change enrichment (workbench soak finds): comment
      // passages live in the docx body as commentRangeStart/End markers, and
      // UNACCEPTED suggestions live there as w:ins/w:del (converters render
      // suggested text as if final — the honest record is here). One bounded
      // download per comments fetch recovers both; every failure degrades to
      // anchorless comments (enrichment, never a fetch failure).
      if (payload.size > 0 && payload.size <= fullParseMax) {
        const anchorStaging = path.join(cacheDir, 'anchors', `${sha1(payload.docKey).slice(0, 12)}.docx`);
        try {
          fs.mkdirSync(path.dirname(anchorStaging), { recursive: true });
          await callText('sharepoint_read_file', {
            serverRelativeUrl: payload.serverRelativeUrl,
            ...(payload.siteUrl ? { siteUrl: payload.siteUrl } : {}),
            savePath: anchorStaging,
          }, DOWNLOAD_TIMEOUT_MS);
          const xml = await readZipEntry(anchorStaging, DOCUMENT_XML_ENTRY);
          commentAnchors = extractCommentAnchors(xml);
          // Suggestions are CURRENT doc state (not per-revision), so they
          // live in a docKey-scoped setting the corpus reads. Zero live
          // suggestions clear prior state (accepted/rejected since).
          const tracked = extractTrackedChanges(xml);
          const hadState = getSetting(db, suggestionSettingKey(payload.docKey)) !== null;
          if (tracked.length > 0 || hadState) {
            setSetting(db, suggestionSettingKey(payload.docKey), {
              docKey: payload.docKey,
              changes: tracked.slice(0, 40),
              updatedAt: new Date(now()).toISOString(),
            });
            if (tracked.length > 0) console.log(`[SharePointSync] ${tracked.length} unaccepted suggested change(s) recorded for ${payload.docKey}`);
          }
        } catch (error) {
          console.warn(`[SharePointSync] comment anchor extraction skipped for ${payload.docKey}: ${(error as Error).message}`);
        } finally {
          try { fs.unlinkSync(anchorStaging); } catch { /* best effort */ }
        }
      }
    }

    // Details-pane item comments need the list-item Id that only
    // sharepoint_list_files results carry; shared-with-me entries skip this.
    if (payload.itemId !== undefined && payload.libraryName) {
      try {
        const text = await callText('sharepoint_list_item_comments', {
          listTitle: payload.libraryName,
          itemId: payload.itemId,
          ...(payload.sourceKind === 'library'
            ? { siteUrl: payload.siteUrl, personal: false }
            : {}),
        }, 60_000);
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = []; }
        groups.push({ comments: normalizeComments(parsed), fragment: '#itemcomment=' });
      } catch (error) {
        // Item comments are best-effort when the docx thread already
        // succeeded; a docx-less item payload propagates the failure.
        if (payload.fileType !== '.docx') throw error;
        console.warn(`[SharePointSync] item comments fetch failed for ${payload.docKey}: ${(error as Error).message}`);
      }
    }

    if (groups.every(g => g.comments.length === 0)) return;

    // Anchor backfill: comments dedupe durably and never re-emit, so newly
    // extracted anchors are also stamped onto EXISTING rows that lack one
    // (metadata enrichment — captured content untouched).
    if (commentAnchors.size > 0) {
      const backfill = db.prepare(`
        UPDATE work_items SET metadata = json_set(COALESCE(metadata, '{}'), '$.anchorText', ?)
        WHERE url = ? AND json_extract(metadata, '$.anchorText') IS NULL
      `);
      for (const { comments, fragment } of groups) {
        if (fragment !== '#comment=') continue;
        const byId = new Map(comments.map(c => [c.id, c]));
        for (const comment of comments) {
          const anchor = commentAnchors.get(comment.id) ?? commentAnchors.get(threadRootOf(comment, byId));
          if (anchor) backfill.run(anchor, `${payload.webUrl}${fragment}${comment.id}`);
        }
      }
    }

    const matcher = buildOwnerMatcher();
    const existsStmt = db.prepare('SELECT 1 FROM work_items WHERE url = ?');
    const parentProjectStmt = db.prepare(`
      SELECT project_id AS projectId FROM work_items
      WHERE json_extract(metadata, '$.docKey') = ? AND project_id IS NOT NULL AND type = 'document_capture'
      ORDER BY captured_at DESC LIMIT 1
    `);
    const parentProject = parentProjectStmt.get(payload.docKey) as { projectId: string } | undefined;

    // Renumber guard (soak find 2026-08-25): Word renumbers comment ids under
    // co-authoring, so a changed URL does NOT mean a new comment. Rows whose
    // fingerprint (author + timestamp) matches a live comment are REMAPPED to
    // the live ids in place — url, commentId, threadRoot, parentCommentId —
    // keeping reply targets and reader deep-links valid. Captured content is
    // never rewritten.
    const storedRows = db.prepare(`
      SELECT id, url, metadata, COALESCE(raw_text, '') AS text
      FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_comment'
        AND json_extract(metadata, '$.docKey') = ?
    `).all(payload.docKey) as Array<{ id: string; url: string | null; metadata: string | null; text: string }>;
    interface StoredEntry { id: string; keys: string[]; fragment: string; normText: string; wasDeleted: boolean; consumed: boolean }
    const storedByKey = new Map<string, StoredEntry>();
    const storedByUrl = new Map<string, StoredEntry>();
    const storedEntries: StoredEntry[] = [];
    for (const stored of storedRows) {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(stored.metadata ?? '{}'); } catch { continue; }
      // '#itemcomment' (no '=') also matches tombstoned '#itemcomment~deleted=' urls.
      const fragment = String(stored.url ?? '').includes('#itemcomment') ? '#itemcomment=' : '#comment=';
      const { dateFp, textFp } = commentFingerprints(
        String(meta.author ?? 'unknown'),
        typeof meta.commentedAt === 'string' ? meta.commentedAt : undefined,
        stored.text,
      );
      const entry: StoredEntry = {
        id: stored.id,
        keys: [],
        fragment,
        normText: stored.text.replace(/\s+/g, ' ').trim().slice(0, 200),
        wasDeleted: meta.deletedFromDoc === 'true',
        consumed: false,
      };
      storedEntries.push(entry);
      for (const fp of [textFp, dateFp]) {
        if (!fp) continue;
        const key = `${fragment}\u0000${fp}`;
        entry.keys.push(key);
        // Collisions (two rows sharing a date-fp) keep the first row; the
        // text form still reaches the second one.
        if (!storedByKey.has(key)) storedByKey.set(key, entry);
      }
      if (stored.url) storedByUrl.set(stored.url, entry);
    }
    const consumeEntry = (entry: StoredEntry): void => {
      entry.consumed = true;
      for (const key of entry.keys) {
        if (storedByKey.get(key) === entry) storedByKey.delete(key);
      }
    };
    // A comment DELETED from the doc keeps its row (decision history, like
    // resolved) but is flagged so counts/awaiting ignore it — and so a later
    // comment REUSING its Word id is not mistaken for it (the ghost squat
    // that swallowed a live reply, soak find 2026-08-25).
    const stampDeletedStmt = db.prepare(`
      UPDATE work_items SET metadata = json_set(COALESCE(metadata, '{}'), '$.deletedFromDoc', 'true') WHERE id = ?
    `);
    const clearDeletedStmt = db.prepare(`
      UPDATE work_items SET metadata = json_remove(metadata, '$.deletedFromDoc') WHERE id = ?
    `);
    const relocateGhostStmt = db.prepare('UPDATE work_items SET url = ? WHERE id = ?');
    const remapStmt = db.prepare(`
      UPDATE work_items
      SET url = ?,
          metadata = json_set(COALESCE(metadata, '{}'), '$.commentId', ?, '$.threadRoot', ?, '$.resolved', ?)
      WHERE id = ?
    `);
    const remapParentStmt = db.prepare(`
      UPDATE work_items SET metadata = json_set(COALESCE(metadata, '{}'), '$.parentCommentId', ?) WHERE id = ?
    `);
    // Word re-stamps dates on edited comments; the live stamp wins so
    // thread ordering (awaiting-reply) follows what reviewers see in Word.
    const remapDateStmt = db.prepare(`
      UPDATE work_items SET metadata = json_set(COALESCE(metadata, '{}'), '$.commentedAt', ?) WHERE id = ?
    `);
    // Live state for URL-STABLE comments. Dedup rightly skips re-emitting a
    // comment whose id never changed — but its MUTABLE state (resolution
    // toggles, thread root) still moves in Word, and the plain `continue`
    // was silently dropping it: the owner resolved a thread online, pressed
    // Refresh, and the awaiting-reply row survived because the stored row
    // kept resolved='' forever (owner report 2026-08-26). Every fetch now
    // re-stamps the live state on the matched row.
    const syncStateByUrlStmt = db.prepare(`
      UPDATE work_items
      SET metadata = json_set(COALESCE(metadata, '{}'), '$.resolved', ?, '$.threadRoot', ?)
      WHERE url = ? AND source = 'sharepoint' AND type = 'document_comment'
    `);
    const remapDateByUrlStmt = db.prepare(`
      UPDATE work_items SET metadata = json_set(COALESCE(metadata, '{}'), '$.commentedAt', ?)
      WHERE url = ? AND source = 'sharepoint' AND type = 'document_comment'
    `);

    for (const { comments, fragment } of groups) {
      const byId = new Map(comments.map(c => [c.id, c]));
      for (const comment of comments) {
        const url = `${payload.webUrl}${fragment}${comment.id}`;
        const quoteForFp = comment.parentId !== undefined && byId.get(comment.parentId)
          ? `↪ replying to ${byId.get(comment.parentId)!.author}: "${byId.get(comment.parentId)!.text.slice(0, 120)}${byId.get(comment.parentId)!.text.length > 120 ? '…' : ''}"\n\n`
          : '';
        const liveContent = `${quoteForFp}${comment.text}`;
        const { dateFp, textFp } = commentFingerprints(comment.author, comment.date, liveContent);
        const liveKeys = [textFp, dateFp].filter((fp): fp is string => !!fp).map(fp => `${fragment}\u0000${fp}`);

        const atUrl = storedByUrl.get(url);
        if (existsStmt.get(url)) {
          // A row already holds this URL — but Word REUSES ids of deleted
          // comments, so verify it is actually THIS comment. Identity match
          // = shared fingerprint (or equal normalized text when neither side
          // has a usable fingerprint).
          const sameComment = atUrl !== undefined && (
            atUrl.keys.some(key => liveKeys.includes(key))
            || (atUrl.keys.length === 0 && liveKeys.length === 0
                && atUrl.normText === liveContent.replace(/\s+/g, ' ').trim().slice(0, 200))
          );
          if (sameComment || atUrl === undefined) {
            // Same id still live — consume its fingerprints so a same-second
            // sibling cannot be mistaken for a renumbered copy of it. A
            // previously-deleted comment that reappeared is live again.
            if (atUrl) {
              consumeEntry(atUrl);
              if (atUrl.wasDeleted) clearDeletedStmt.run(atUrl.id);
            }
            // Dedup skips the EMIT, never the state: resolution and date
            // re-stamps land on unchanged ids too.
            syncStateByUrlStmt.run(comment.resolved ? 'true' : 'false', threadRootOf(comment, byId), url);
            if (comment.date) remapDateByUrlStmt.run(comment.date, url);
            continue; // durable dedup (spec R2.1)
          }
          // GHOST SQUAT (soak find 2026-08-25): the row at this URL is a
          // DIFFERENT comment — deleted from the doc, its id since reused.
          // Relocate it to a tombstone URL (unique forever), flag it, and
          // fall through so the live comment can remap or emit.
          consumeEntry(atUrl);
          relocateGhostStmt.run(`${payload.webUrl}${fragment.replace('=', '~deleted=')}${atUrl.id}`, atUrl.id);
          stampDeletedStmt.run(atUrl.id);
          console.log(`[SharePointSync] comment id ${comment.id} was reused — prior comment tombstoned (${atUrl.id.slice(0, 8)}) for ${payload.docKey}`);
        }

        // Same comment under a renumbered id (or a re-stamped date — Word
        // does both) → remap the stored row, no emit. Text form outranks
        // date form: substantial identical text is the stronger identity.
        const stored = (textFp ? storedByKey.get(`${fragment}\u0000${textFp}`) : undefined)
          ?? (dateFp ? storedByKey.get(`${fragment}\u0000${dateFp}`) : undefined);
        if (stored) {
          consumeEntry(stored); // one stored row maps to one live comment
          remapStmt.run(url, comment.id, threadRootOf(comment, byId), comment.resolved ? 'true' : 'false', stored.id);
          if (comment.parentId !== undefined) remapParentStmt.run(comment.parentId, stored.id);
          if (comment.date) remapDateStmt.run(comment.date, stored.id);
          if (stored.wasDeleted) clearDeletedStmt.run(stored.id);
          continue;
        }

        const parent = comment.parentId !== undefined ? byId.get(comment.parentId) : undefined;
        const quote = parent
          ? `↪ replying to ${parent.author}: "${parent.text.slice(0, 120)}${parent.text.length > 120 ? '…' : ''}"\n\n`
          : '';

        const metadata: Record<string, string> = {
          docKey: payload.docKey,
          serverRelativeUrl: payload.serverRelativeUrl,
          webUrl: payload.webUrl,
          docTitle: payload.name,
          commentId: comment.id,
          threadRoot: threadRootOf(comment, byId),
          author: comment.author,
          mentionedMe: matcher.mentionsOwner(comment.text) ? 'true' : 'false',
          direction: matcher.isOwner(comment.author) ? 'sent' : 'received',
          sharePointSource: payload.sourceKind,
        };
        if (payload.siteUrl) metadata.siteUrl = payload.siteUrl;
        if (comment.parentId !== undefined) metadata.parentCommentId = comment.parentId;
        if (comment.date) metadata.commentedAt = comment.date;
        if (comment.resolved) metadata.resolved = 'true';
        if (parentProject) metadata.parentProjectId = parentProject.projectId;
        // Word review comments only (the #comment= group); replies share the
        // root's range, so fall back up the thread for the passage.
        if (fragment === '#comment=') {
          const anchor = commentAnchors.get(comment.id)
            ?? commentAnchors.get(threadRootOf(comment, byId));
          if (anchor) metadata.anchorText = anchor;
        }

        emit({
          type: 'document_comment',
          source: 'sharepoint',
          sourceApp: 'SharePoint',
          url,
          title: `Comment by ${comment.author} on ${payload.name}`,
          content: `${quote}${comment.text}`,
          metadata,
          capturedAt: comment.date ? new Date(comment.date) : new Date(now()),
        });
      }
    }

    // Stored comments the live thread no longer contains were DELETED from
    // the document — flag them (counts/awaiting skip flagged rows; the
    // reader shows them struck as history). Only fragments actually fetched
    // this pass can prove absence.
    const fetchedFragments = new Set(groups.map(g => g.fragment));
    let stampedDeleted = 0;
    for (const entry of storedEntries) {
      if (entry.consumed || entry.wasDeleted || !fetchedFragments.has(entry.fragment)) continue;
      stampDeletedStmt.run(entry.id);
      stampedDeleted++;
    }
    if (stampedDeleted > 0) {
      console.log(`[SharePointSync] flagged ${stampedDeleted} comment(s) deleted from ${payload.docKey}`);
    }
  }

  // ── Revision diff stamping (signals R2) ───────────────────────────────────
  // Each `#rev=` capture gets a compact "what changed" summary computed
  // against the newest PRIOR content-bearing capture of the same document.
  // Metadata enrichment only: captured content is never rewritten. Bounded
  // per tick; rows that cannot be diffed are stamped with the reason so the
  // sweep never revisits them.
  const REVISION_SWEEP_BATCH = 5;

  function readItemContent(row: ContentRowColumns): string | null {
    if (!contentStore) return null;
    try {
      const ref = contentStore.refFromRow(row);
      if (!ref) return null;
      return contentStore.get(ref);
    } catch {
      return null; // integrity failure — skip quietly, evidence stays intact
    }
  }

  // ── Cross-document link graph (doc-link-graph L1) ─────────────────────────
  // Deterministic edge extraction from stored content — pure-local, bounded
  // per tick, dirty-checked via a per-doc settings stamp so clean docs cost
  // nothing. Same discipline as stampRevisionDiffs.
  const LINK_SWEEP_BATCH = 5;
  const linkSweepKey = (docKey: string) => `link_sweep.${sha1(docKey).slice(0, 16)}`;

  function linkSweep(): void {
    if (!contentStore) return;
    // Newest CONTENT-BEARING capture per docKey (raw_text or stored content).
    const heads = db.prepare(`
      SELECT docKey, id, capturedAt, raw_text, content_storage, content_path, content_sha256, content_bytes FROM (
        SELECT json_extract(metadata, '$.docKey') AS docKey, id, captured_at AS capturedAt,
               raw_text, content_storage, content_path, content_sha256, content_bytes,
               ROW_NUMBER() OVER (PARTITION BY json_extract(metadata, '$.docKey') ORDER BY captured_at DESC) AS rn
        FROM work_items
        WHERE source = 'sharepoint' AND type = 'document_capture'
          AND process_state != 'captured'
          AND json_extract(metadata, '$.docKey') IS NOT NULL
          AND json_extract(metadata, '$.extractionTier') != 'metadata_only'
      ) WHERE rn = 1
    `).all() as Array<ContentRowColumns & { docKey: string; id: string; capturedAt: string }>;

    const dirty = heads.filter(head => {
      const swept = getSetting<string>(db, linkSweepKey(head.docKey));
      return !swept || swept < head.capturedAt;
    }).slice(0, LINK_SWEEP_BATCH);
    if (dirty.length === 0) return;

    const index = buildCorpusLinkIndex(db);
    let edges = 0;
    for (const head of dirty) {
      const content = readItemContent(head);
      if (content && content.trim() !== '') {
        const links = extractDocumentLinks(content, head.docKey, index);
        replaceOutgoingLinks(db, head.docKey, links, new Date(now()).toISOString());
        edges += links.length;
      }
      setSetting(db, linkSweepKey(head.docKey), head.capturedAt);
    }
    if (edges > 0) console.log(`[SharePointSync] link sweep: ${dirty.length} doc(s) scanned, ${edges} edge(s) current`);
  }

  function stampRevisionDiffs(): void {
    if (!contentStore) return;
    const candidates = db.prepare(`
      SELECT id, url, summary, metadata, captured_at AS capturedAt,
             raw_text, content_storage, content_path, content_sha256, content_bytes,
             json_extract(metadata, '$.docKey') AS docKey,
             json_extract(metadata, '$.extractionTier') AS tier
      FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_capture'
        AND url LIKE '%#rev=%'
        AND process_state != 'captured'
        AND json_extract(metadata, '$.changeSummary') IS NULL
      ORDER BY captured_at ASC
      LIMIT ${REVISION_SWEEP_BATCH}
    `).all() as Array<ContentRowColumns & { id: string; docKey: string | null; tier: string | null; capturedAt: string; summary: string | null; url: string }>;
    if (candidates.length === 0) return;

    const priorStmt = db.prepare(`
      SELECT id, raw_text, content_storage, content_path, content_sha256, content_bytes,
             json_extract(metadata, '$.extractionTier') AS tier
      FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_capture'
        AND json_extract(metadata, '$.docKey') = ?
        AND captured_at < ? AND id != ?
        AND process_state != 'captured'
      ORDER BY captured_at DESC
      LIMIT 1
    `);
    const stamp = db.prepare(`
      UPDATE work_items
      SET metadata = json_set(COALESCE(metadata, '{}'), '$.changeSummary', ?, '$.changedSections', json(?)),
          summary = CASE WHEN summary IS NULL OR summary = '' THEN ? ELSE summary END
      WHERE id = ?
    `);

    for (const row of candidates) {
      let summaryText = '';
      let sections: string[] = [];
      if (!row.docKey) {
        summaryText = 'diff unavailable (no document key)';
      } else if (row.tier === 'metadata_only') {
        summaryText = 'document changed (content not synced at this size tier)';
      } else {
        const prior = priorStmt.get(row.docKey, row.capturedAt, row.id) as (ContentRowColumns & { tier: string | null }) | undefined;
        if (!prior) {
          summaryText = 'first captured revision';
        } else if (prior.tier === 'metadata_only') {
          summaryText = 'document changed (previous revision had no synced content to compare)';
        } else {
          const before = readItemContent(prior);
          const after = readItemContent(row);
          if (before === null || after === null) {
            summaryText = 'diff unavailable (content unreadable)';
          } else {
            const diff = diffDocumentTexts(before, after);
            if (!diff) {
              summaryText = 'no text changes detected (formatting or comments only)';
            } else {
              summaryText = `Changed — ${diff.summary}`;
              sections = diff.changedSections;
            }
          }
        }
      }
      stamp.run(summaryText, JSON.stringify(sections), summaryText, row.id);
    }
    console.log(`[SharePointSync] revision diffs stamped: ${candidates.length}`);
  }

  // ── Cache sweep: state-aware + LRU cap ────────────────────────────────────
  // Rules (spec R5.6): a file still referenced by a work item awaiting
  // extraction (process_state='captured') is NEVER deleted; stale .part
  // files (torn downloads > 1 h old) always are; everything else is LRU
  // material, deleted oldest-first only under cap pressure so recent
  // binaries stay available for re-extraction and revision diffs.
  function sweepCache(): void {
    const files = listCacheFiles();
    const awaitingExtraction = db.prepare(
      "SELECT 1 FROM work_items WHERE process_state = 'captured' AND json_extract(metadata, '$.filePath') = ? LIMIT 1",
    );
    let total = files.reduce((acc, f) => acc + f.size, 0);
    for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
      if (file.full.endsWith('.part')) {
        if (now() - file.mtime > 60 * 60_000) {
          try { fs.unlinkSync(file.full); total -= file.size; } catch { /* best effort */ }
        }
        continue;
      }
      if (total <= cacheCap) break;
      if (awaitingExtraction.get(file.full)) continue;
      try { fs.unlinkSync(file.full); total -= file.size; } catch { /* best effort */ }
    }
  }

  // ── Purge ─────────────────────────────────────────────────────────────────
  function purge(): { items: number; cacheFiles: number } {
    const rows = db.prepare("SELECT id, content_path FROM work_items WHERE source = 'sharepoint'").all() as Array<{ id: string; content_path: string | null }>;
    // foreign_keys is ON: cascade FKs (project events, rejections, discards)
    // clean up automatically; the three non-cascade referencers must go first.
    const tx = db.transaction(() => {
      for (const row of rows) {
        db.prepare('DELETE FROM work_items_fts WHERE item_id = ?').run(row.id);
        db.prepare('DELETE FROM node_work_items WHERE work_item_id = ?').run(row.id);
        db.prepare('DELETE FROM item_ocr_lines WHERE item_id = ?').run(row.id);
        db.prepare('DELETE FROM agent_todos WHERE work_item_id = ?').run(row.id);
        db.prepare('DELETE FROM work_items WHERE id = ?').run(row.id);
      }
      db.prepare('DELETE FROM sharepoint_sync_queue').run();
      db.prepare('DELETE FROM sharepoint_seen').run();
    });
    tx();
    for (const row of rows) {
      if (row.content_path) { try { fs.unlinkSync(row.content_path); } catch { /* inline or gone */ } }
    }
    let cacheFiles = 0;
    try {
      cacheFiles = fs.readdirSync(cacheDir, { recursive: true }).length;
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch { /* absent */ }
    // Purge also resets baselines: with seen-state gone, a kept baselineDone
    // flag would make the next discovery re-sync the ENTIRE corpus as live
    // (observed 2026-08-24: 171 live entries post-purge). Re-enabling after a
    // purge re-applies each source's chosen baseline depth instead.
    const sources = getSources();
    if (sources.length > 0) {
      for (const source of sources) source.baselineDone = false;
      saveSources(sources);
    }
    return { items: rows.length, cacheFiles };
  }

  // ── Status / config ───────────────────────────────────────────────────────
  function getStatus(): SharePointSyncStatusView {
    // Queued counts stay in units of documents (paired comments fetches are
    // an internal companion of their content row), but failures of EITHER
    // kind stay visible (spec R1.4).
    const queueRows = db.prepare(
      "SELECT state, priority, kind, source_id AS sourceId, COUNT(*) AS c FROM sharepoint_sync_queue GROUP BY state, priority, kind, source_id",
    ).all() as Array<{ state: string; priority: string; kind: string; sourceId: string; c: number }>;
    const queue = { queued: 0, failed: 0, live: 0, backfill: 0 };
    const perSource = new Map<string, number>();
    for (const row of queueRows) {
      if (row.state === 'failed') queue.failed += row.c;
      else if (row.kind === 'content') {
        queue.queued += row.c;
        if (row.priority === 'live') queue.live += row.c; else queue.backfill += row.c;
        perSource.set(row.sourceId, (perSource.get(row.sourceId) ?? 0) + row.c);
      }
    }
    const backoffs: Record<string, string> = {};
    // Surface only currently-active backoffs (settings keyed per domain).
    for (const row of db.prepare("SELECT key, value FROM app_settings WHERE key LIKE ?").all(`${KEYS.backoffPrefix}%`) as Array<{ key: string; value: string }>) {
      try {
        const parsed = JSON.parse(row.value) as { until?: number };
        if ((parsed.until ?? 0) > now()) backoffs[row.key.slice(KEYS.backoffPrefix.length)] = new Date(parsed.until!).toISOString();
      } catch { /* ignore */ }
    }
    return {
      enabled: getSetting<boolean>(db, KEYS.enabled) === true,
      discovering,
      draining,
      queue,
      sources: getSources().map(source => ({
        ...source,
        queued: perSource.get(source.id) ?? 0,
        surgePending: getSetting<number>(db, `${KEYS.surgePrefix}${source.id}`) ?? undefined,
      })),
      gates: { backlog: backlogGateGreen(), cache: cacheGateGreen(), connection: getSetting<boolean>(db, KEYS.enabled) === true },
      backoffs,
      lastRun: getSetting<Record<string, unknown>>(db, KEYS.lastRun) ?? null,
    };
  }

  function updateConfig(input: { enabled?: boolean; sources?: unknown }): SharePointSyncStatusView {
    if (input.sources !== undefined) {
      if (!Array.isArray(input.sources)) throw new Error('sources must be an array');
      if (input.sources.length > 20) throw new Error('at most 20 sources are supported');
      const previous = new Map(getSources().map(s => [s.id, s]));
      const next: SharePointSource[] = [];
      const seenIds = new Set<string>();
      for (const raw of input.sources) {
        const source = validateSource(raw);
        if (seenIds.has(source.id)) continue;
        seenIds.add(source.id);
        const existing = previous.get(source.id);
        if (existing) {
          // Preserve lifecycle flags across saves; baseline depth is fixed at add time.
          source.baselineDone = existing.baselineDone;
          source.paused = existing.paused;
          source.baseline = existing.baseline;
          source.addedAt = existing.addedAt;
        }
        next.push(source);
      }
      // Removed sources: their queue entries and surge flags go in the same transaction.
      const removed = [...previous.keys()].filter(id => !seenIds.has(id));
      const tx = db.transaction(() => {
        for (const id of removed) {
          db.prepare('DELETE FROM sharepoint_sync_queue WHERE source_id = ?').run(id);
        }
      });
      tx();
      for (const id of removed) setSetting(db, `${KEYS.surgePrefix}${id}`, null);
      saveSources(next);
    }
    if (input.enabled !== undefined) {
      setSetting(db, KEYS.enabled, input.enabled === true);
      // R3.2: first-ever enable with no configuration seeds shared-with-me ON.
      if (input.enabled === true && getSources().length === 0 && input.sources === undefined) {
        const seed = validateSource({ kind: 'shared_with_me', baseline: 'days90' });
        saveSources([seed]);
      }
    }
    return getStatus();
  }

  /**
   * Enqueue a document by PATH — for documents the corpus does not know yet
   * (authoring bridge: BotBoy just created the file; `refreshDocument`
   * requires an existing capture and cannot serve this). Synthesizes the
   * payload the drain needs; docKey derivation matches discovery's.
   */
  function enqueueByPath(serverRelativeUrl: string, opts: { siteUrl?: string; sizeBytes?: number } = {}): { queued: boolean; docKey: string; reason?: string } {
    const docKey = docKeyForPath(db, serverRelativeUrl, opts.siteUrl);
    const host = docKey.split('/')[0];
    const sources = getSources();
    const source = (opts.siteUrl ? sources.find(s => s.kind === 'library') : sources.find(s => s.kind === 'onedrive'))
      ?? sources[0];
    if (!source) return { queued: false, docKey, reason: 'no configured sources' };
    const payload: QueuePayload = {
      docKey,
      name: path.basename(serverRelativeUrl),
      serverRelativeUrl,
      ...(opts.siteUrl ? { siteUrl: opts.siteUrl } : {}),
      webUrl: `https://${host}${encodeURI(serverRelativeUrl)}`,
      domain: host,
      modified: new Date(now()).toISOString(),
      size: Number(opts.sizeBytes ?? 0) || 0,
      fileType: path.extname(serverRelativeUrl).toLowerCase(),
      sourceKind: source.kind,
      libraryName: 'Documents',
    };
    const json = JSON.stringify(payload);
    const ts = new Date(now()).toISOString();
    db.transaction(() => {
      upsertQueue.run(payload.docKey, source.id, 'content', 'live', json, ts);
      if (payload.fileType === '.docx') {
        upsertQueue.run(`${payload.docKey}#comments`, source.id, 'comments', 'live', json, ts);
      }
    })();
    return { queued: true, docKey };
  }

  function refreshDocument(docKey: string): { queued: boolean; reason?: string } {
    const row = db.prepare(`
      SELECT title, metadata FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_capture'
        AND json_extract(metadata, '$.docKey') = ?
      ORDER BY captured_at DESC LIMIT 1
    `).get(docKey) as { title: string | null; metadata: string | null } | undefined;
    if (!row) return { queued: false, reason: 'unknown document' };
    let m: Record<string, unknown> = {};
    try { m = JSON.parse(row.metadata ?? '{}'); } catch { return { queued: false, reason: 'unreadable document metadata' }; }
    const serverRelativeUrl = String(m.serverRelativeUrl ?? '');
    const webUrl = String(m.webUrl ?? '');
    if (!serverRelativeUrl || !webUrl) return { queued: false, reason: 'document metadata lacks a fetch path' };
    const sources = getSources();
    const source = sources.find(s => s.kind === String(m.sharePointSource ?? '')) ?? sources[0];
    if (!source) return { queued: false, reason: 'no configured sources' };

    const payload: QueuePayload = {
      docKey,
      name: String(m.docTitle ?? row.title ?? path.basename(serverRelativeUrl)),
      serverRelativeUrl,
      ...(typeof m.siteUrl === 'string' && m.siteUrl ? { siteUrl: m.siteUrl } : {}),
      webUrl,
      domain: new URL(webUrl).hostname,
      // Fresh stamp: the resulting capture lands as a new #rev= revision.
      modified: new Date(now()).toISOString(),
      size: Number(m.sizeBytes ?? 0) || 0,
      fileType: String(m.fileType ?? path.extname(serverRelativeUrl).toLowerCase()),
      sourceKind: source.kind,
    };
    const json = JSON.stringify(payload);
    const ts = new Date(now()).toISOString();
    db.transaction(() => {
      upsertQueue.run(payload.docKey, source.id, 'content', 'live', json, ts);
      if (payload.fileType === '.docx') {
        upsertQueue.run(`${payload.docKey}#comments`, source.id, 'comments', 'live', json, ts);
      }
    })();
    return { queued: true };
  }

  function confirmSurge(sourceId: string): SharePointSyncStatusView {
    const sources = getSources();
    const source = sources.find(s => s.id === sourceId);
    if (!source) throw new Error(`unknown source '${sourceId}'`);
    source.paused = false;
    saveSources(sources);
    setSetting(db, `${KEYS.surgePrefix}${sourceId}`, null);
    return getStatus();
  }

  async function guardedDiscovery(): Promise<SharePointSyncResult> {
    if (discovering) {
      return { status: 'skipped', reason: 'discovery already running', perSource: {}, durationMs: 0 };
    }
    discovering = true;
    try { return await runDiscovery(); } finally { discovering = false; }
  }

  return {
    start(): void {
      if (timers.length || initialTimer) return;
      initialTimer = setTimeout(() => { void guardedDiscovery().catch(() => {}); }, initialDelayMs);
      timers.push(setInterval(() => { void guardedDiscovery().catch(() => {}); }, discoveryIntervalMs));
      timers.push(setInterval(() => { void drainOnce().catch(() => {}); }, drainIntervalMs));
    },
    stop(): void {
      if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
    runNow: guardedDiscovery,
    drainNow: drainOnce,
    isRunning: () => discovering || draining,
    getStatus,
    updateConfig,
    confirmSurge,
    refreshDocument,
    enqueueByPath,
    purge,
  };
}
