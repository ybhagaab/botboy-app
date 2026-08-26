import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from './storage.js';
import {
  buildCorpusLinkIndex,
  extractDocumentLinks,
  replaceOutgoingLinks,
  getRelatedDocuments,
  linkCountsByDocKey,
} from './document-corpus.js';

/**
 * Cross-document link graph (doc-link-graph L1): deterministic extraction
 * (URL zoo + title floor), atomic outgoing replace with first_seen survival,
 * direction-union reads filtered to the live corpus.
 */
describe('document link graph', () => {
  let storage: StorageLayer;
  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());

  const HLD = 'amazon.sharepoint.com/sites/t/Shared Documents/AMXP/MX Unification High Level Design.docx';
  const WORKSHOP = 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/MX_PV_Catalog_Unification_Workshop.docx';
  const NOTES = 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/notes.md';

  function insertDoc(id: string, docKey: string, title: string, opts: { serverRelativeUrl?: string; webUrl?: string } = {}) {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata)
      VALUES (?, 'document_capture', 'sharepoint', ?, ?, '2026-08-26T09:00:00Z', 'routed', ?)
    `).run(id, title, `https://x/${id}`, JSON.stringify({
      docKey,
      serverRelativeUrl: opts.serverRelativeUrl ?? `/${docKey.split('/').slice(1).join('/')}`,
      ...(opts.webUrl ? { webUrl: opts.webUrl } : {}),
    }));
  }

  it('extracts hyperlink edges from path-form, encoded, query-stringed, and sourcedoc-GUID URLs; skips external links and self-links', () => {
    const db = storage.getDb();
    insertDoc('d1', HLD, 'MX Unification High Level Design.docx', {
      serverRelativeUrl: '/sites/t/Shared Documents/AMXP/MX Unification High Level Design.docx',
      webUrl: 'https://amazon.sharepoint.com/sites/t/_layouts/15/Doc.aspx?sourcedoc=%7BFF75812F-D7E3-4491-92F9-8C93E532B272%7D&file=x.docx',
    });
    insertDoc('d2', WORKSHOP, 'MX_PV_Catalog_Unification_Workshop.docx', {
      serverRelativeUrl: '/personal/u_amazon_com/Documents/MX_PV_Catalog_Unification_Workshop.docx',
    });
    const index = buildCorpusLinkIndex(db);

    const content = [
      // Path-form, percent-encoded, with a query string:
      'See https://amazon-my.sharepoint.com/personal/u_amazon_com/Documents/MX_PV_Catalog_Unification_Workshop.docx?web=1 for the workshop outcomes.',
      // GUID form pointing at the HLD (should be skipped as SELF when extracting from HLD):
      'Reference: https://amazon.sharepoint.com/sites/t/_layouts/15/Doc.aspx?sourcedoc={FF75812F-D7E3-4491-92F9-8C93E532B272}&action=default',
      // External link — never stored:
      'Background at https://en.wikipedia.org/wiki/Strangler_fig_pattern here.',
    ].join('\n');
    const links = extractDocumentLinks(content, HLD, index);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ toDocKey: WORKSHOP, kind: 'hyperlink' });
    expect(links[0].evidence).toContain('workshop outcomes');

    // From the WORKSHOP's perspective the GUID form resolves to the HLD.
    const fromWorkshop = extractDocumentLinks(content, WORKSHOP, index);
    expect(fromWorkshop.find(l => l.kind === 'hyperlink' && l.toDocKey === HLD)).toBeTruthy();
  });

  it('title references need >=12 chars; short titles never spray edges', () => {
    const db = storage.getDb();
    insertDoc('d1', HLD, 'MX Unification High Level Design.docx');
    insertDoc('d3', NOTES, 'notes.md');
    const index = buildCorpusLinkIndex(db);
    const content = 'As covered in the MX Unification High Level Design, our notes say the rollout holds.';
    const links = extractDocumentLinks(content, WORKSHOP, index);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ toDocKey: HLD, kind: 'reference' });
    // "notes" (5 chars after extension strip) never became an edge.
    expect(links.find(l => l.toDocKey === NOTES)).toBeUndefined();
  });

  it('replaceOutgoingLinks is atomic per source: removed edges vanish, first_seen survives re-scan', () => {
    const db = storage.getDb();
    replaceOutgoingLinks(db, HLD, [
      { toDocKey: WORKSHOP, kind: 'hyperlink', evidence: 'see the workshop' },
      { toDocKey: NOTES, kind: 'reference', evidence: 'per the notes doc' },
    ], '2026-08-26T10:00:00Z');
    replaceOutgoingLinks(db, HLD, [
      { toDocKey: WORKSHOP, kind: 'hyperlink', evidence: 'see the UPDATED workshop' },
    ], '2026-08-26T11:00:00Z');
    const rows = db.prepare('SELECT * FROM document_links WHERE from_doc_key = ?').all(HLD) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence).toContain('UPDATED');
    expect(rows[0].first_seen).toBe('2026-08-26T10:00:00Z'); // survived the re-scan
    expect(rows[0].last_seen).toBe('2026-08-26T11:00:00Z');
  });

  it('getRelatedDocuments unions both directions and filters targets missing from the corpus', () => {
    const db = storage.getDb();
    insertDoc('d1', HLD, 'MX Unification High Level Design.docx');
    insertDoc('d2', WORKSHOP, 'MX_PV_Catalog_Unification_Workshop.docx');
    // HLD → WORKSHOP stored; plus an edge to a doc that left the corpus.
    replaceOutgoingLinks(db, HLD, [
      { toDocKey: WORKSHOP, kind: 'hyperlink', evidence: 'see the workshop' },
      { toDocKey: 'gone/doc.docx', kind: 'reference', evidence: 'mentions a purged doc' },
    ]);
    const fromHld = getRelatedDocuments(db, HLD);
    expect(fromHld).toHaveLength(1);
    expect(fromHld[0]).toMatchObject({ docKey: WORKSHOP, direction: 'outgoing', kind: 'hyperlink' });
    const fromWorkshop = getRelatedDocuments(db, WORKSHOP);
    expect(fromWorkshop).toHaveLength(1);
    expect(fromWorkshop[0]).toMatchObject({ docKey: HLD, direction: 'incoming' });
    expect(fromWorkshop[0].title).toContain('High Level Design');

    const counts = linkCountsByDocKey(db);
    expect(counts.get(HLD)).toBe(2); // outgoing edges count even when a target left
    expect(counts.get(WORKSHOP)).toBe(1);
  });
});
