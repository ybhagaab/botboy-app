import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  boundedDocumentCountLabel,
  boundedDocumentScopeLabel,
  buildDocumentLibraryView,
  buildDocumentReviewModel,
  documentChainExpansionState,
  groupDocumentChains,
  loadedDocumentRevisionLabel,
  shouldCollapseLibraryForReview,
  toggleDocumentFocusState,
  toggleDocumentLibraryState,
  toggleDocumentReviewState,
} from './document-reader.js';

type Summary = {
  artifactId: string;
  title: string;
  state: string;
  profileId: string;
  createdAt: string;
  parentArtifactId?: string | null;
};

const summary = (artifactId: string, title: string, createdAt: string, extras: Partial<Summary> = {}): Summary => ({
  artifactId,
  title,
  state: 'ready_for_review',
  profileId: 'op_roadmap_vision.v1',
  createdAt,
  ...extras,
});

describe('generated-document reading-first view model', () => {
  it('keeps loaded revision chains intact when an older member matches search', () => {
    const items = [
      summary('root', 'Original strategy', '2026-09-01T00:00:00Z'),
      summary('revision', 'Current launch plan', '2026-09-03T00:00:00Z', { parentArtifactId: 'root' }),
      summary('other', 'Unrelated brief', '2026-09-02T00:00:00Z'),
    ];
    const chains = buildDocumentLibraryView(items, { query: 'original strategy', sort: 'recent' });

    expect(chains).toHaveLength(1);
    expect(chains[0].head.artifactId).toBe('revision');
    expect(chains[0].members.map(entry => entry.artifactId)).toEqual(['revision', 'root']);
  });

  it('searches normalized status/profile text and sorts chain heads by recent, title, or status', () => {
    const items = [
      summary('b', 'Zulu brief', '2026-09-03T00:00:00Z', { state: 'draft_review', profileId: 'business_document/adaptive.v1' }),
      summary('a', 'Alpha plan', '2026-09-01T00:00:00Z', { state: 'ready_for_review' }),
      summary('c', 'Middle memo', '2026-09-02T00:00:00Z', { state: 'approved' }),
    ];

    expect(buildDocumentLibraryView(items).map(chain => chain.head.artifactId)).toEqual(['b', 'c', 'a']);
    expect(buildDocumentLibraryView(items, { sort: 'title' }).map(chain => chain.head.artifactId)).toEqual(['a', 'c', 'b']);
    expect(buildDocumentLibraryView(items, { sort: 'status' }).map(chain => chain.head.artifactId)).toEqual(['c', 'b', 'a']);
    expect(buildDocumentLibraryView(items, { query: 'ready for review' }).map(chain => chain.head.artifactId)).toEqual(['a']);
    expect(buildDocumentLibraryView(items, { query: 'ready_for_review' }).map(chain => chain.head.artifactId)).toEqual(['a']);
    expect(buildDocumentLibraryView(items, { query: 'business document' }).map(chain => chain.head.artifactId)).toEqual(['b']);
    expect(buildDocumentLibraryView(items, { query: 'business_document/adaptive.v1' }).map(chain => chain.head.artifactId)).toEqual(['b']);
  });

  it('labels only the lineage present in the bounded loaded page', () => {
    const chains = groupDocumentChains([
      summary('root', 'Root', '2026-09-01T00:00:00Z'),
      summary('middle', 'Middle', '2026-09-02T00:00:00Z', { parentArtifactId: 'root' }),
      summary('latest', 'Latest', '2026-09-03T00:00:00Z', { parentArtifactId: 'middle' }),
      summary('orphan', 'Bounded orphan', '2026-09-04T00:00:00Z', { parentArtifactId: 'outside-page' }),
    ]);

    expect(loadedDocumentRevisionLabel(chains, 'root')).toBe('Version 1 of 3 loaded');
    expect(loadedDocumentRevisionLabel(chains, 'middle')).toBe('Version 2 of 3 loaded');
    expect(loadedDocumentRevisionLabel(chains, 'latest')).toBe('Version 3 of 3 loaded');
    expect(loadedDocumentRevisionLabel(chains, 'orphan', 'outside-page')).toBe('Revision');
    expect(loadedDocumentRevisionLabel([], 'deep-linked-original', null)).toBe('Original');
    expect(loadedDocumentRevisionLabel([], 'deep-linked-revision', 'outside-page')).toBe('Revision');
  });

  it('groups validation and conformance notes by aspect while keeping evidence separate', () => {
    const model = buildDocumentReviewModel({
      citations: [{ id: 'c1', label: 'Owner interview', source: 'email' }],
      validation: {
        findings: [
          { aspect: 'completeness', severity: 'warning', code: 'REQ-1', message: 'Add a metric.' },
          { aspect: 'completeness', severity: 'error', code: 'REQ-2', message: 'Add an owner.' },
          { severity: 'info', code: 'IGNORED', message: 'Not an advisory.' },
        ],
      },
      conformanceReview: {
        status: 'deviations_noted',
        summary: 'Two sections need review.',
        findings: [
          { aspect: 'section_contract', severity: 'deviation', message: 'Decision section is incomplete.' },
          { aspect: 'completeness', severity: 'note', message: 'Scope is otherwise clear.' },
        ],
      },
    });

    expect(model.citations).toHaveLength(1);
    expect(model.noteCount).toBe(4);
    expect(model.groups.map(group => [group.label, group.items.length])).toEqual([
      ['Completeness', 3],
      ['Section contract', 1],
    ]);
    expect(model.groups[0].items.map(item => item.source)).toEqual(['validation', 'validation', 'conformance']);
    expect(model.statusLabel).toBe('Deviations noted');
    expect(model.reviewSummary).toBe('Two sections need review.');
  });

  it('keeps a finding-free conformance summary available to the review surface', () => {
    const model = buildDocumentReviewModel({
      conformanceReview: { status: 'conformant', summary: 'The document follows the guide.', findings: [] },
    });
    expect(model.totalCount).toBe(0);
    expect(model.statusLabel).toBe('Conformant');
    expect(model.reviewSummary).toBe('The document follows the guide.');
  });

  it('uses actual shell width for constrained Review behavior', () => {
    expect(shouldCollapseLibraryForReview(1179)).toBe(true);
    expect(shouldCollapseLibraryForReview(1180)).toBe(false);
    expect(shouldCollapseLibraryForReview(1500)).toBe(false);
    expect(shouldCollapseLibraryForReview(0)).toBe(false);
  });

  it('keeps bounded count and scope copy truthful during direct search updates', () => {
    expect(boundedDocumentCountLabel({ loadedCount: 61 })).toBe('61 loaded');
    expect(boundedDocumentCountLabel({ loadedCount: 61, total: 143 })).toBe('61 of 143');
    expect(boundedDocumentCountLabel({ loadedCount: 61, total: 143, query: 'india', visibleCount: 4 }))
      .toBe('4 shown · 61 of 143');
    expect(boundedDocumentCountLabel({ loadedCount: 61, query: 'india', visibleCount: 4 }))
      .toBe('4 shown · 61 loaded');
    expect(boundedDocumentScopeLabel(61, 100)).toBe('61 loaded · up to 100 recent');
    expect(boundedDocumentScopeLabel(undefined, 100)).toBe('Up to 100 recent');
  });

  it('keeps Review and Focus composable in both orders while restoring only Review-owned Library collapse', () => {
    const base = { libraryOpen: true, reviewOpen: false, focusMode: false, reviewCollapsedLibrary: false };
    const reviewed = toggleDocumentReviewState(base, 900);
    expect(reviewed).toMatchObject({ libraryOpen: false, reviewOpen: true, focusMode: false, reviewCollapsedLibrary: true });

    const focusedWithReview = toggleDocumentFocusState(reviewed);
    expect(focusedWithReview).toMatchObject({ libraryOpen: false, reviewOpen: true, focusMode: true, reviewCollapsedLibrary: true });

    const reviewFromFocus = toggleDocumentReviewState({ ...base, focusMode: true }, 1400);
    expect(reviewFromFocus).toMatchObject({ libraryOpen: true, reviewOpen: true, focusMode: true, reviewCollapsedLibrary: false });

    const closedReviewWhileFocused = toggleDocumentReviewState(focusedWithReview, 900);
    expect(closedReviewWhileFocused).toMatchObject({ libraryOpen: true, reviewOpen: false, focusMode: true, reviewCollapsedLibrary: false });

    const exitedFocusWithReview = toggleDocumentFocusState(focusedWithReview);
    expect(exitedFocusWithReview).toMatchObject({ libraryOpen: false, reviewOpen: true, focusMode: false, reviewCollapsedLibrary: true });
  });

  it('closes Review before reopening Library and routes mobile expansion to the visible list', () => {
    const reviewOwnedCollapse = { libraryOpen: false, reviewOpen: true, focusMode: false, reviewCollapsedLibrary: true };
    const desktop = toggleDocumentLibraryState(reviewOwnedCollapse, { isMobile: false, hasArtifact: true });
    expect(desktop).toEqual({
      state: { libraryOpen: true, reviewOpen: false, focusMode: false, reviewCollapsedLibrary: false },
      navigateToList: false,
    });

    const mobile = toggleDocumentLibraryState(reviewOwnedCollapse, { isMobile: true, hasArtifact: true });
    expect(mobile.state).toMatchObject({ libraryOpen: true, reviewOpen: false, reviewCollapsedLibrary: false });
    expect(mobile.navigateToList).toBe(true);
  });

  it('keeps actions, immutable edit behavior, and exact scroll-key identities in the renderer', () => {
    const source = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
    expect(source).toContain('data-document-search');
    expect(source).toContain('data-document-sort');
    expect(source).toContain('data-action="documents-toggle-review"');
    expect(source).toContain('toggleDocumentReviewState(state.documents, embeddedWidth)');
    expect(source).toContain('toggleDocumentFocusState(state.documents)');
    expect(source).toContain("transition: 'focus'");
    expect(source).toContain('applyDocumentReaderPresentation({');
    expect(source).toContain('syncDocumentReaderPresentation(document, state.documents)');
    expect(source).toContain('renderDocumentAnnotationsRail(artifact, reviewModel, documents.reviewOpen)');
    const reviewHandlerStart = source.indexOf("if (action === 'documents-toggle-review')");
    const previewHandlerStart = source.indexOf("if (action === 'documents-preview-mode')", reviewHandlerStart);
    expect(source.slice(reviewHandlerStart, previewHandlerStart)).not.toContain('renderRoute(');
    expect(source).toContain('toggleDocumentLibraryState(state.documents, { isMobile, hasArtifact: true })');
    expect(source).toContain("go('#/documents')");
    expect(source).toContain('boundedDocumentScopeLabel(items.length, DOCUMENT_LIST_LIMIT)');
    expect(source).toContain('chipTarget.focus({ preventScroll: true })');
    expect(source).toContain('data-action="documents-focus"');
    expect(source).toContain("event.stopImmediatePropagation()");
    expect(source).toContain('data-action="documents-save-revision"');
    expect(source).toContain('data-action="documents-set-project"');
    expect(source).toContain('data-document-project-assignment');
    expect(source).toContain('data-action="documents-publication-toggle"');
    expect(source).toContain('/product-documents/${encodeURIComponent(artifactId)}/publications');
    expect(source).toContain('publicationBusy: new Set()');
    expect(source).toContain('state.documents.publicationBusy.delete(operationKey)');
    expect(source).toContain('refreshDocumentPublicationSurfaces(artifactId, projectId)');
    expect(source).not.toContain('publicationRequestToken');
    const applyPublicationStart = source.indexOf('async function applyDocumentPublication');
    const publicationRendererStart = source.indexOf('function renderDocumentLibraryRows', applyPublicationStart);
    const applyPublicationSource = source.slice(applyPublicationStart, publicationRendererStart);
    expect(applyPublicationSource.indexOf('await refreshDocumentPublicationSurfaces(artifactId, projectId)'))
      .toBeLessThan(applyPublicationSource.indexOf('if (requestError)'));
    expect(applyPublicationSource).toContain('state.documents.publicationBusy.delete(operationKey)');
    expect(source).toContain('documents:publication:${attr(artifact.artifactId)}');
    expect(source).toContain('aria-labelledby="document-publication-summary-label"');
    expect(source).toContain('id="document-publication-dialog"');
    expect(source).toContain('aria-labelledby="document-publication-heading"');
    expect(source).toContain('aria-describedby="document-publication-description"');
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).toContain('data-action="documents-publication-close"');
    expect(source).toContain('syncDocumentPublicationDialog(document, state.documents)');
    expect(source).toContain('aria-pressed="${updateMode ?');
    expect(source).not.toContain('publish_product_document_to_sharepoint');
    expect(source).toContain('Saving never overwrites this version; it creates a new linked one.');
    expect(source).toContain('data-action="documents-delete"');
    expect(source).toContain('window.confirm(`Delete "${title}"?');
    expect(source).toContain('data-scroll-key="documents:list"');
    expect(source).toContain('data-scroll-key="documents:preview:${attr(artifactId)}"');
    expect(source).toContain('data-scroll-key="documents:questions:${attr(artifactId)}"');
    expect(source).toContain('data-scroll-key="documents:annotations:${attr(artifact.artifactId)}"');
    expect(source).not.toContain('documents-fullscreen');
    expect(source).not.toContain('document-fullscreen');
  });

  it('uses immersive Focus, composable mounted Review, compact headers, and mode-specific reading type', () => {
    const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.documents-shell\.document-focus \{[^}]*z-index:120;[^}]*inset:0;[^}]*height:100dvh;/);
    expect(css).not.toContain('.documents-shell.document-focus .document-annotations { display:none!important; }');
    expect(css).not.toContain('.assistant-open .documents-shell.document-focus');
    expect(css).toContain('view-transition-name:botboy-document-reader');
    expect(css).toContain('::view-transition-old(botboy-document-reader)');
    expect(css).toContain('grid-template-columns:minmax(0,1fr) 0');
    expect(css).toContain('grid-template-columns:minmax(0,1fr) var(--document-review-width)');
    expect(css).toMatch(/\.documents-shell \.document-detail-header \{[^}]*padding:10px 16px 8px;/);
    expect(css).toMatch(/\.documents-shell \.document-rendered \{[^}]*width:min\(100%,900px\);[^}]*font-size:15\.5px;/);
    expect(css).toMatch(/\.documents-shell\.document-focus \.document-rendered \{[^}]*width:min\(100%,980px\);[^}]*font-size:17px;/);
    expect(css).toMatch(/\.document-publication-surface \{[^}]*flex:0 0 auto;/);
    expect(css).toContain('grid-template-columns:minmax(0,1fr) 46px');
    expect(css).toContain('.document-chain-history>li::after');
    expect(css).toContain('.document-chain-history>li:has(.document-row.active)::after');
    expect(css).toContain('.document-publication-overlay');
    expect(css).toContain('.document-publication-drawer');
    expect(css).toContain('.document-publication-drawer-header');
    expect(css).toContain('@media(max-width:820px)');
    expect(css).not.toContain('.document-detail-pane:has(.document-technical-details[open]):has(.document-publication-surface.is-open)');
    expect(css).toMatch(/\.document-publication-section-title \{[^}]*display:grid;[^}]*gap:3px;/);
    expect(css).toContain('.document-publication-choice:has(input:checked)');
    expect(css).toContain('.document-publication-overlay::backdrop');
    expect(css).toContain('@media(max-width:560px)');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
  });
});
