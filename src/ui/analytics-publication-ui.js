const MAX_PUBLICATION_WIDGETS = 24;

const RETAINED_CONFIRMATION_CODES = new Set([
  'publication_snapshot_drift',
  'publication_not_ready',
  'policy_denied',
]);

/**
 * Project the server-issued receipt for rendering. This function never hashes
 * or reconstructs provenance: every identity remains exactly as supplied by
 * the confirmation response.
 */
export function publicationReceiptView(receipt) {
  const snapshot = receipt?.snapshot;
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.widgets)) return null;
  const widgets = snapshot.widgets
    .filter(widget => widget?.dataRoom)
    .slice(0, MAX_PUBLICATION_WIDGETS)
    .map(widget => ({
      widgetId: String(widget.widgetId || ''),
      datasetId: String(widget.dataRoom.datasetId || ''),
      versionId: String(widget.dataRoom.versionId || ''),
      bindingSha256: String(widget.dataRoom.bindingSha256 || ''),
      controlSha256: String(widget.dataRoom.control?.valuesSha256 || ''),
      querySha256: String(widget.dataRoom.querySha256 || ''),
      semanticReceiptSha256: String(widget.dataRoom.semanticReceiptSha256 || ''),
    }));
  const totalBoundWidgets = snapshot.widgets.filter(widget => widget?.dataRoom).length;
  return {
    snapshotManifestSha256: String(receipt.snapshotManifestSha256 || ''),
    artifactContentSha256: String(receipt.artifactContentSha256 || ''),
    publisherConfigSha256: String(receipt.publisherConfigSha256 || ''),
    dashboardPresentationSha256: String(snapshot.presentationSha256 || ''),
    dashboardResultSha256: String(snapshot.resultSha256 || ''),
    widgets,
    totalBoundWidgets,
    truncated: totalBoundWidgets > widgets.length,
  };
}

export function publicationConfirmationMustReprepare(error) {
  return RETAINED_CONFIRMATION_CODES.has(String(error?.code || ''));
}

export function publicationDriftLabel(scope) {
  const labels = {
    publisher_config: 'Publisher settings',
    dashboard: 'Dashboard presentation',
    widget: 'Widget presentation',
    binding: 'Dataset binding',
    control: 'Dataset controls',
    dataset_head: 'Dataset head',
    dataset_version: 'Dataset version',
    result: 'Displayed result',
    semantic_receipt: 'Semantic receipt',
    artifact: 'Publication artifact',
  };
  return labels[String(scope || '')] || 'Publication snapshot';
}
