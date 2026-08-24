import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor, type ToolExecutor } from './tool-executor.js';

/**
 * search_items must see FULL content, not just title + 500-char summary.
 * Post-mortem 2026-08-03: the agent looped for 15 iterations because the
 * backfilled #unified-metrics-apt-weblab discussion was invisible to the old
 * title/summary LIKE search.
 *
 * Contract under test:
 *   1. FTS5 (work_items_fts title+body) is the primary index
 *   2. raw user text (hyphens/quotes/operators) cannot break MATCH syntax
 *   3. items without an FTS row are still reachable via the LIKE fallback
 *      over title/summary/raw_text
 */

function search(executor: ToolExecutor, query: string) {
  return executor.executeTool({
    id: 't1',
    type: 'function',
    function: { name: 'search_items', arguments: JSON.stringify({ query }) },
  } as any);
}

describe('search_items tool', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let executor: ToolExecutor;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    executor = createToolExecutor(db, createNodeManager(db));

    // FTS-indexed Slack message: the search phrase lives ONLY in the body
    // (full message text), not in title or summary.
    db.prepare(
      `INSERT INTO work_items (id, type, source, title, summary, url, captured_at)
       VALUES ('w_fts', 'slack_message', 'slack', 'Slack #unified-metrics-apt-weblab', 'short preview',
               'https://slack.com/archives/C1/p100', '2026-07-29T09:00:00Z')`,
    ).run();
    db.prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)').run(
      'w_fts',
      'Slack #unified-metrics-apt-weblab',
      'Discussion about weblab APT metrics: how stable is session ID compared to GCID for the dashboard',
    );

    // Legacy item with NO FTS row: match lives only in raw_text.
    db.prepare(
      `INSERT INTO work_items (id, type, source, title, raw_text, captured_at)
       VALUES ('w_legacy', 'website_visit', 'browser', 'some page', 'deep dive into weblab APT allocation', '2026-07-01T09:00:00Z')`,
    ).run();

    // Noise that must not match.
    db.prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at)
       VALUES ('w_noise', 'clipboard_capture', 'clipboard', 'grocery list', '2026-07-02T09:00:00Z')`,
    ).run();
  });

  afterEach(() => {
    storage.close();
  });

  it('finds full-body FTS matches AND tops up with raw_text LIKE matches', async () => {
    const result = await search(executor, 'weblab APT');
    expect(result.isError ?? false).toBe(false);
    const rows = JSON.parse(result.content);
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain('w_fts');    // via FTS body
    expect(ids).toContain('w_legacy'); // via raw_text LIKE top-up
    expect(ids).not.toContain('w_noise');
    // The FTS hit carries a matched-context snippet for the model.
    const ftsRow = rows.find((r: any) => r.id === 'w_fts');
    expect(ftsRow.snippet).toContain('[weblab]');
  });

  it('survives hyphens, quotes and FTS operators in the query', async () => {
    for (const q of ['apt-weblab', 'session "id', 'weblab NEAR/2 metrics', 'a AND b OR (c']) {
      const result = await search(executor, q);
      expect(result.isError ?? false).toBe(false);
      expect(() => JSON.parse(result.content)).not.toThrow();
    }
  });

  it('matches hyphenated channel names token-wise via FTS', async () => {
    const rows = JSON.parse((await search(executor, 'apt-weblab')).content);
    // unicode61 tokenizes 'apt-weblab' as ['apt','weblab'] on both sides,
    // so the channel-titled item is reachable even with the hyphenated form.
    expect(rows.map((r: any) => r.id)).toContain('w_fts');
  });

  it('returns [] for an empty query', async () => {
    const result = await search(executor, '   ');
    expect(JSON.parse(result.content)).toEqual([]);
  });
});
