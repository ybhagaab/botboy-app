import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor, type ToolExecutor } from './tool-executor.js';
import { createContentStore, refToColumns, type ContentStore } from './content-store.js';
import { createPendingEdit, decidePendingEdit } from './pending-edits.js';
import { setSetting } from './storage.js';
import { suggestionSettingKey } from './document-corpus.js';

/**
 * Chat document-corpus tools (workbench soak find 2026-08-25): the model
 * had NO read path into the synced document corpus, browsed SharePoint raw,
 * found the wrong file, and declared a fully-synced document missing. These
 * tools make the corpus the model's first stop: list_documents discovers,
 * read_document returns content + comments + STAGED pending edits.
 */

describe('tool-executor document corpus tools', () => {
  let storage: StorageLayer;
  let executor: ToolExecutor;
  let dir: string;
  let cs: ContentStore;

  const HLD_KEY = 'amazon.sharepoint.com/sites/t/Shared Documents/AMXP/HLD Final.docx';
  const NOTES_KEY = 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/notes.md';

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-doc-tools-'));
    cs = createContentStore(storage.getDb(), { contentDir: dir });
    executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { contentStore: cs });
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function insertCapture(id: string, docKey: string, title: string, capturedAt: string, opts: { content?: string; tier?: string; serverRelativeUrl?: string; siteUrl?: string } = {}) {
    const cols = refToColumns(cs.put(id, opts.content ?? ''));
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, project_id, metadata,
                              raw_text, content_storage, content_path, content_sha256, content_bytes)
      VALUES (?, 'document_capture', 'sharepoint', ?, ?, ?, 'routed', 'p1', ?, ?, ?, ?, ?, ?)
    `).run(
      id, title, `https://x/${id}`, capturedAt,
      JSON.stringify({
        docKey,
        webUrl: `https://x/${id}`,
        serverRelativeUrl: opts.serverRelativeUrl ?? '/sites/t/Shared Documents/AMXP/HLD Final.docx',
        ...(opts.siteUrl ? { siteUrl: opts.siteUrl } : {}),
        fileType: title.endsWith('.md') ? '.md' : '.docx',
        extractionTier: opts.tier ?? 'full',
        sizeBytes: '2048',
        lastModified: capturedAt,
      }),
      cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
    );
  }

  function insertComment(id: string, docKey: string, text: string, opts: { resolved?: boolean; anchor?: string } = {}) {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, project_id, metadata, raw_text)
      VALUES (?, 'document_comment', 'sharepoint', 'Comment', ?, '2026-08-24T10:00:00Z', 'routed', 'p1', ?, ?)
    `).run(
      id, `https://x/c#${id}`,
      JSON.stringify({
        docKey, commentId: id, threadRoot: id, author: 'Ng, Hui Jun', direction: 'received',
        resolved: opts.resolved ? 'true' : 'false',
        commentedAt: '2026-08-24T10:00:00Z',
        ...(opts.anchor ? { anchorText: opts.anchor } : {}),
      }),
      text,
    );
  }

  async function run(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await executor.executeTool({
      id: 't1', type: 'function', function: { name, arguments: JSON.stringify(args) },
    });
    return result.content;
  }

  it('list_documents discovers by title fragment and returns the full addressing + staged-edit count', async () => {
    insertCapture('c1', HLD_KEY, 'HLD Final.docx', '2026-08-20T10:00:00Z', { content: 'Appendix C: IFS design.', siteUrl: 'https://amazon.sharepoint.com/sites/t' });
    insertCapture('c2', HLD_KEY, 'HLD Final.docx', '2026-08-21T10:00:00Z', { content: 'Appendix C: IFS design, revised.', siteUrl: 'https://amazon.sharepoint.com/sites/t' });
    insertCapture('c3', NOTES_KEY, 'notes.md', '2026-08-19T10:00:00Z', { content: 'notes', serverRelativeUrl: '/personal/u_amazon_com/Documents/notes.md' });
    insertComment('m1', HLD_KEY, 'Can we clarify the rollout?');
    insertComment('m2', HLD_KEY, 'Resolved earlier.', { resolved: true });
    createPendingEdit(storage.getDb(), {
      docKey: HLD_KEY, serverRelativeUrl: '/sites/t/Shared Documents/AMXP/HLD Final.docx',
      kind: 'botboy', operation: 'replaceText',
      findText: 'Appendix C: IFS design, revised.', replaceWith: 'Appendix C: IFS design, final.',
    });

    const out = await run('list_documents', { query: 'hld' });
    const parsed = JSON.parse(out);
    expect(parsed.documents).toHaveLength(1);
    const doc = parsed.documents[0];
    expect(doc.docKey).toBe(HLD_KEY);
    expect(doc.revisions).toBe(2);
    expect(doc.comments).toBe('2 (1 open)');
    expect(doc.stagedEdits).toBe(1);
    expect(doc.serverRelativeUrl).toBe('/sites/t/Shared Documents/AMXP/HLD Final.docx');
    expect(doc.siteUrl).toBe('https://amazon.sharepoint.com/sites/t');
    expect(doc.readerLink).toBe(`#/doc/${Buffer.from(HLD_KEY, 'utf8').toString('base64url')}`);

    // Unfiltered list shows the whole corpus.
    const all = JSON.parse(await run('list_documents', {}));
    expect(all.documents).toHaveLength(2);
  });

  it('list_documents guides instead of "not found" when a query misses', async () => {
    insertCapture('c1', HLD_KEY, 'HLD Final.docx', '2026-08-20T10:00:00Z', { content: 'x' });
    const out = await run('list_documents', { query: 'workshop deck' });
    expect(out).toMatch(/No synced documents match/);
    expect(out).toMatch(/without a query/);
  });

  it('sharepoint_create_document stages by default (gate, project check, collision redirect); nothing touches MCP', async () => {
    storage.getDb().prepare("INSERT INTO projects (id, title, status, brain_path) VALUES ('p1', 'Catalog', 'active', '/tmp/p1-brain.md')").run();
    const args = {
      targetFolder: '/personal/u_amazon_com/Documents/BotBoyTests',
      title: 'Rollout Plan', format: 'md', projectId: 'p1',
      content: '# Rollout Plan\n\nPhase one covers the EU storefront migration in detail.',
    };
    // Gate first.
    expect(await run('sharepoint_create_document', args)).toMatch(/ownerRequested must be true/);
    // Unknown project.
    expect(await run('sharepoint_create_document', { ...args, projectId: 'nope', ownerRequested: true })).toMatch(/unknown project/);

    const staged = JSON.parse(await run('sharepoint_create_document', { ...args, ownerRequested: true }));
    expect(staged.status).toBe('staged');
    expect(staged.docKey).toContain('/personal/u_amazon_com/Documents/BotBoyTests/Rollout Plan.md');
    expect(staged.approveAt).toBe('#/projects/p1');
    const rows = storage.getDb().prepare("SELECT status, project_id AS pid FROM document_pending_edits WHERE operation='createDocument'").all() as any[];
    expect(rows).toEqual([{ status: 'pending', pid: 'p1' }]);

    // Collision with an existing corpus doc redirects to the reader.
    insertCapture('c9', staged.docKey, 'Rollout Plan.md', '2026-08-26T10:00:00Z', { content: 'existing', serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/Rollout Plan.md' });
    const collided = JSON.parse(await run('sharepoint_create_document', { ...args, title: 'Rollout Plan', ownerRequested: true }));
    expect(collided.status).toBe('exists');
    expect(collided.readerLink).toContain('#/doc/');
  });

  it('read_document surfaces unaccepted suggestions with the content-honesty note; list_documents counts them', async () => {
    insertCapture('c1', HLD_KEY, 'HLD Final.docx', '2026-08-20T10:00:00Z', { content: 'Tenet #2: We keep components independently deployable.' });
    setSetting(storage.getDb(), suggestionSettingKey(HLD_KEY), {
      docKey: HLD_KEY,
      changes: [{ kind: 'insertion', author: 'Ng, Hui Jun', date: '2026-08-25T08:50:00.000Z', text: 'We keep components independently deployable.' }],
      updatedAt: '2026-08-25T09:00:00.000Z',
    });

    const out = JSON.parse(await run('read_document', { docKey: HLD_KEY }));
    expect(out.suggestedChanges).toHaveLength(1);
    expect(out.suggestedChanges[0].author).toBe('Ng, Hui Jun');
    expect(out.suggestedChangesNote).toMatch(/PROPOSED by their author/);

    const listed = JSON.parse(await run('list_documents', { query: 'hld' }));
    expect(listed.documents[0].unacceptedSuggestions).toBe(1);
  });

  it('read_document returns newest content with as-of, threaded comments, and staged edits', async () => {
    insertCapture('c1', HLD_KEY, 'HLD Final.docx', '2026-08-20T10:00:00Z', { content: 'Old body.' });
    insertCapture('c2', HLD_KEY, 'HLD Final.docx', '2026-08-21T10:00:00Z', { content: 'Appendix C: IFS integration flow.' });
    insertComment('m1', HLD_KEY, 'Needs a diagram here.', { anchor: 'IFS integration flow' });
    const edit = createPendingEdit(storage.getDb(), {
      docKey: HLD_KEY, serverRelativeUrl: '/sites/t/Shared Documents/AMXP/HLD Final.docx',
      kind: 'botboy', operation: 'appendParagraphs', paragraphs: ['Appendix C addendum.'],
    });
    decidePendingEdit(storage.getDb(), edit.id, 'approved');

    const out = JSON.parse(await run('read_document', { docKey: HLD_KEY }));
    expect(out.doc.serverRelativeUrl).toBe('/sites/t/Shared Documents/AMXP/HLD Final.docx');
    expect(out.content).toBe('Appendix C: IFS integration flow.');
    expect(out.contentAsOf).toMatch(/2026-08-21T10:00:00Z/);
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0].anchor).toBe('IFS integration flow');
    expect(out.pendingEdits).toHaveLength(1);
    expect(out.pendingEdits[0].status).toBe('approved');
    expect(out.pendingEditsNote).toMatch(/STAGED/);

    // part narrows the payload.
    const editsOnly = JSON.parse(await run('read_document', { docKey: HLD_KEY, part: 'pending_edits' }));
    expect(editsOnly.content).toBeUndefined();
    expect(editsOnly.pendingEdits).toHaveLength(1);
  });

  it('read_document truncates long content at maxChars with an honest marker', async () => {
    insertCapture('c1', HLD_KEY, 'HLD Final.docx', '2026-08-20T10:00:00Z', { content: 'A'.repeat(30_000) });
    const out = JSON.parse(await run('read_document', { docKey: HLD_KEY, maxChars: 2_000 }));
    expect(out.content).toMatch(/truncated at 2000 of 30000 chars/);
    expect(out.content.length).toBeLessThan(2_200);
  });

  it('read_document on an unknown docKey points to list_documents rather than declaring the doc missing', async () => {
    const out = await run('read_document', { docKey: 'nope' });
    expect(out).toMatch(/list_documents/);
    expect(out).toMatch(/do not conclude/);
  });
});
