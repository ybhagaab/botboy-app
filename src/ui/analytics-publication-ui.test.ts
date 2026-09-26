import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  publicationConfirmationMustReprepare,
  publicationDriftLabel,
  publicationReceiptView,
} from './analytics-publication-ui.js';

function boundWidget(index: number) {
  return {
    widgetId: `widget_${index}`,
    position: index,
    widgetRevision: 1,
    bindingGeneration: 1,
    presentationSha256: '1'.repeat(64),
    resultSha256: '2'.repeat(64),
    dataRoom: {
      datasetId: `ds_${index}`,
      versionId: `dsv_${index}`,
      bindingSha256: `${index % 10}`.repeat(64),
      querySha256: '4'.repeat(64),
      semanticReceiptSha256: '5'.repeat(64),
      control: { valuesSha256: '6'.repeat(64) },
    },
  };
}

function receipt(widgetCount = 1) {
  return {
    snapshotManifestSha256: 'a'.repeat(64),
    artifactContentSha256: 'b'.repeat(64),
    publisherConfigSha256: 'c'.repeat(64),
    snapshot: {
      version: 1,
      presentationSha256: 'd'.repeat(64),
      resultSha256: 'e'.repeat(64),
      widgets: Array.from({ length: widgetCount }, (_, index) => boundWidget(index)),
    },
  };
}

describe('analytics publication UI projection', () => {
  it('passes through server receipt identities without recomputing them', () => {
    const source = receipt();
    const view = publicationReceiptView(source);
    expect(view).toEqual({
      snapshotManifestSha256: source.snapshotManifestSha256,
      artifactContentSha256: source.artifactContentSha256,
      publisherConfigSha256: source.publisherConfigSha256,
      dashboardPresentationSha256: source.snapshot.presentationSha256,
      dashboardResultSha256: source.snapshot.resultSha256,
      totalBoundWidgets: 1,
      truncated: false,
      widgets: [{
        widgetId: 'widget_0',
        datasetId: 'ds_0',
        versionId: 'dsv_0',
        bindingSha256: '0'.repeat(64),
        controlSha256: '6'.repeat(64),
        querySha256: '4'.repeat(64),
        semanticReceiptSha256: '5'.repeat(64),
      }],
    });
  });

  it('bounds the visible provenance list and excludes unbound widgets', () => {
    const source = receipt(30);
    source.snapshot.widgets.push({ widgetId: 'legacy', position: 31 } as any);
    const view = publicationReceiptView(source)!;
    expect(view.widgets).toHaveLength(24);
    expect(view.totalBoundWidgets).toBe(30);
    expect(view.truncated).toBe(true);
    expect(view.widgets.some(widget => widget.widgetId === 'legacy')).toBe(false);
  });

  it('retains only drift/readiness/policy confirmations for explicit re-prepare', () => {
    for (const code of ['publication_snapshot_drift', 'publication_not_ready', 'policy_denied']) {
      expect(publicationConfirmationMustReprepare({ code })).toBe(true);
    }
    for (const code of ['publication_provider_failed', 'invalid_confirmation', 'not_found', '']) {
      expect(publicationConfirmationMustReprepare({ code })).toBe(false);
    }
    expect(publicationDriftLabel('dataset_version')).toBe('Dataset version');
    expect(publicationDriftLabel('unknown')).toBe('Publication snapshot');
  });

  it('rejects missing or unsupported receipt versions', () => {
    expect(publicationReceiptView(null)).toBeNull();
    expect(publicationReceiptView({ snapshot: { version: 2, widgets: [] } })).toBeNull();
  });

  it('keeps receipt, drift, repaint, focus, and no-new-scroller seams in the existing dashboard flow', () => {
    const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
    expect(dashboard).toContain('confirmErrors: new Map()');
    expect(dashboard).toContain('publicationReceiptView(pending.receipt)');
    expect(dashboard).toContain("const retained = publicationConfirmationMustReprepare(error)");
    expect(dashboard).toContain('state.publisher.confirmErrors.set(id');
    expect(dashboard).toContain('Prepare updated snapshot');
    expect(dashboard).toContain('Prepared snapshot is stale');
    expect(dashboard).toContain('External publication');
    for (const label of [
      'Snapshot manifest SHA-256', 'Artifact content SHA-256', 'Publisher config SHA-256',
      'Binding SHA-256', 'Control values SHA-256', 'Semantic receipt SHA-256',
    ]) expect(dashboard).toContain(label);
    expect(dashboard).toContain('renderRoute({ userAction: true, preserveScroll: true })');
    expect(dashboard).toContain('restoreDashboardShareFocus();');
    expect(dashboard).toContain('renderLatestDashboardPublication(dashboard)');
    expect(dashboard).toContain('latestSuccessfulPublication');
    expect(dashboard).toContain('Remote effect incomplete or unverified');
    expect(dashboard).toContain("await loadAnalyticsDashboard(id, { force: true, preserveScroll: true })");
    expect(dashboard).toContain("focus({ preventScroll: true })");
    expect(dashboard).toContain("preparing || publishing || refreshing ? 'disabled' : ''");
    expect(css).toContain('.share-provenance-row');
    expect(css).toContain('.share-attempt');
    expect(css).toContain('.share-confirmation dl,.share-attempt .share-receipt-summary');
    expect(css).toContain('.share-attempt-actions .button{width:100%;max-width:100%;white-space:normal}');
    expect(css).not.toMatch(/\.share-provenance\s*\{[^}]*overflow[^}]*\}/);
    expect(dashboard).not.toContain('share-confirmation-modal');
  });
});
