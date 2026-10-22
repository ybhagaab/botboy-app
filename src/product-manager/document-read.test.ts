import { describe, expect, it } from 'vitest';
import { DOCUMENT_READ_BUDGET_CHARS, documentVersionOf, productDocumentListForModel, productDocumentReadForModel } from './document-read.js';
import type { ProductDocumentArtifact, ProductDocumentSummary } from './types.js';

/** The list mode of read_product_document over a bounded page of summaries (2026-10-21). */
const summary = (artifactId: string, title: string, createdAt: string, parentArtifactId?: string): ProductDocumentSummary => ({
  artifactId,
  title,
  createdAt,
  state: 'ready_for_review',
  profileId: 'business_document/adaptive.v1',
  profileVersion: '1',
  checkerVersion: 'test',
  contentChars: 100,
  validationStatus: 'pass',
  ...(parentArtifactId ? { parentArtifactId } : {}),
});

describe('productDocumentReadForModel', () => {
  it('keeps the citation list inside its own budget and says how many it left out', () => {
    const citations = Array.from({ length: 50 }, (_, index) => ({ id: `c${index}`, label: `${'Long evidence label '.repeat(14)}${index}`, source: 'email', date: '2026-10-20' }));
    const artifact = {
      artifactId: 'art-cited', title: 'Cited', content: citations.map((citation) => `Claim. [${citation.id}]`).join('\n'),
      profileId: 'business_document/adaptive.v1', maturity: 'working', createdAt: '2026-10-20T06:00:00Z', citations,
    } as unknown as ProductDocumentArtifact;
    const out = productDocumentReadForModel(artifact, []);
    expect(out.length).toBeLessThanOrEqual(DOCUMENT_READ_BUDGET_CHARS);
    const read = JSON.parse(out);
    expect(read.citationCount).toBe(50);
    expect(read.citations.length).toBeLessThan(50);
    expect(JSON.stringify(read.citations).length).toBeLessThanOrEqual(6_000);
    expect(read.citationsOmitted).toBe(50 - read.citations.length);
    expect(read.citations[0]).toEqual({ id: 'c0', label: citations[0].label, source: 'email', date: '2026-10-20' });
  });
});

describe('productDocumentListForModel', () => {
  it('groups a page into chains, newest chain first whatever order the page came in, and counts versions outside the page', () => {
    // Out of date order on purpose: the playback chain is met first but its head is older.
    const page = [
      summary('b1', 'Playback titles', '2026-10-20T07:00:00Z'),
      summary('a1', 'Launch email', '2026-10-20T06:00:00Z'),
      summary('a2', 'Launch email', '2026-10-20T08:00:00Z', 'a1'),
    ];
    const listed = JSON.parse(productDocumentListForModel(page, (id) => (id === 'a2' ? 5 : 1)));
    expect(listed.documents.map((document: any) => [document.newestArtifactId, document.versions])).toEqual([['a2', 5], ['b1', 1]]);
    expect(listed).toMatchObject({ ok: true, mode: 'list', matched: 2, note: expect.stringMatching(/^Documents among the 3 most recently saved versions/) });
    const queried = JSON.parse(productDocumentListForModel(page, () => 1, { query: 'email LAUNCH' }));
    expect(queried.documents.map((document: any) => document.newestArtifactId)).toEqual(['a2']);
  });

  it('numbers versions oldest-first and names the newest from an older one', () => {
    const chain = [summary('v3', 'Doc', '2026-10-20T09:00:00Z', 'v2'), summary('v2', 'Doc', '2026-10-20T08:00:00Z', 'v1'), summary('v1', 'Doc', '2026-10-20T07:00:00Z')];
    expect(documentVersionOf('v3', chain)).toEqual({ number: 3, of: 3, newest: true });
    expect(documentVersionOf('v1', chain)).toEqual({ number: 1, of: 3, newest: false, newestArtifactId: 'v3', newestSavedAt: '2026-10-20T09:00:00Z' });
    expect(documentVersionOf('elsewhere', chain)).toEqual({ number: 1, of: 1, newest: true });
  });
});
