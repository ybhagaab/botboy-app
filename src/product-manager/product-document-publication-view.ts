import type { PendingEdit, PendingEditStatus } from '../core/pending-edits.js';
import type {
  ProductDocumentPublication,
  ProductDocumentPublicationAction,
  ProductDocumentPublicationService,
  ProductDocumentPublicationStatus,
} from './product-document-publications.js';

export type ProductDocumentPublicationPhase =
  | 'blocked_unassigned'
  | 'create_configuration_required'
  | 'update_ready'
  | 'update_base_selection_required'
  | 'pending'
  | 'approved'
  | 'in_flight'
  | 'conflicted'
  | 'failed'
  | 'complete';

export interface ProductDocumentPublicationLocationView {
  publicationId: string;
  artifactId: string;
  docKey: string;
  serverRelativeUrl: string;
  siteUrl: string | null;
  format: 'md' | 'docx';
  webUrl: string | null;
  remoteItemId: string | null;
  capturedWorkItemId: string;
  completedAt: string;
  containsSelectedArtifact: boolean;
}

export interface ProductDocumentPublicationAttemptView {
  publicationId: string;
  pendingEditId: string;
  intentKey: string | null;
  artifactId: string;
  action: ProductDocumentPublicationAction;
  basePublicationId: string | null;
  format: 'md' | 'docx';
  docKey: string;
  serverRelativeUrl: string;
  siteUrl: string | null;
  publicationStatus: ProductDocumentPublicationStatus;
  pendingStatus: PendingEditStatus | null;
  conflictReason: string | null;
  lastError: string | null;
  expectedRemoteSha256: string | null;
  expectedRemoteItemId: string | null;
  expectedRemoteEtag: string | null;
  expectedRemoteVersion: string | null;
  expectedRemoteModified: string | null;
  expectedRemoteSize: number | null;
  remoteObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
  effectCertainty: 'none' | 'possible_remote_effect' | 'verified_remote_effect';
}

export interface ProductDocumentPublicationView {
  phase: ProductDocumentPublicationPhase;
  selectedArtifactId: string;
  projectId: string | null;
  projectStatus: string | null;
  blockReason: string | null;
  attempt: ProductDocumentPublicationAttemptView | null;
  blockers: ProductDocumentPublicationAttemptView[];
  completedLocations: ProductDocumentPublicationLocationView[];
  updateBases: ProductDocumentPublicationLocationView[];
  currentLocationCount: number;
  historyCount: number;
}

const TERMINAL_HISTORY = new Set<ProductDocumentPublicationStatus>(['rejected', 'superseded', 'complete']);
const IN_FLIGHT = new Set<ProductDocumentPublicationStatus>([
  'exported', 'uploaded_unverified', 'verified', 'capture_queued',
]);
const FAILURES = new Set<ProductDocumentPublicationStatus>([
  'upload_failed', 'verification_failed', 'capture_failed', 'identity_mismatch',
]);

function newestFirst(left: ProductDocumentPublication, right: ProductDocumentPublication): number {
  const leftAt = Date.parse(left.updatedAt || left.createdAt) || 0;
  const rightAt = Date.parse(right.updatedAt || right.createdAt) || 0;
  return rightAt - leftAt || right.publicationId.localeCompare(left.publicationId);
}

function effectCertainty(publication: ProductDocumentPublication): ProductDocumentPublicationAttemptView['effectCertainty'] {
  if (publication.status === 'verified' || publication.status === 'capture_queued'
    || publication.status === 'capture_failed' || publication.status === 'identity_mismatch') {
    return 'verified_remote_effect';
  }
  if (publication.status === 'uploaded_unverified' || publication.status === 'verification_failed'
    || publication.status === 'upload_failed') {
    return 'possible_remote_effect';
  }
  return 'none';
}

function attemptView(publication: ProductDocumentPublication, pending: PendingEdit | null): ProductDocumentPublicationAttemptView {
  return {
    publicationId: publication.publicationId,
    pendingEditId: publication.pendingEditId,
    intentKey: publication.intentKey,
    artifactId: publication.artifactId,
    action: publication.action,
    basePublicationId: publication.basePublicationId,
    format: publication.format,
    docKey: publication.docKey,
    serverRelativeUrl: publication.serverRelativeUrl,
    siteUrl: publication.siteUrl,
    publicationStatus: publication.status,
    pendingStatus: pending?.status ?? null,
    conflictReason: pending?.conflictReason ?? null,
    lastError: publication.lastError,
    expectedRemoteSha256: publication.expectedRemoteSha256,
    expectedRemoteItemId: publication.expectedRemoteItemId,
    expectedRemoteEtag: publication.expectedRemoteEtag,
    expectedRemoteVersion: publication.expectedRemoteVersion,
    expectedRemoteModified: publication.expectedRemoteModified,
    expectedRemoteSize: publication.expectedRemoteSize,
    remoteObservedAt: publication.remoteObservedAt,
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
    effectCertainty: effectCertainty(publication),
  };
}

function phaseForAttempt(publication: ProductDocumentPublication, pending: PendingEdit | null): ProductDocumentPublicationPhase {
  if (publication.status === 'target_conflict') return 'conflicted';
  if (FAILURES.has(publication.status)) return 'failed';
  if (pending?.status === 'conflicted') return 'conflicted';
  if (publication.status === 'staged' && pending?.status === 'pending') return 'pending';
  if (publication.status === 'approved' && pending?.status === 'approved') return 'approved';
  if (IN_FLIGHT.has(publication.status)) return 'in_flight';
  return 'failed';
}

interface ArtifactPublicationIdentity {
  artifactId: string;
  projectId?: string;
  projectStatus?: string | null;
}

function attemptPriority(publication: ProductDocumentPublication, selectedArtifactId: string): number {
  const certainty = effectCertainty(publication);
  if (certainty === 'verified_remote_effect') return 600;
  if (certainty === 'possible_remote_effect') return 500;
  if (IN_FLIGHT.has(publication.status)) return 450;
  if (publication.status === 'approved') return 400;
  if (FAILURES.has(publication.status)) return 350;
  if (publication.artifactId === selectedArtifactId && publication.status === 'target_conflict') return 250;
  if (publication.artifactId === selectedArtifactId && publication.status === 'staged') return 200;
  return -1;
}

/**
 * Project one owner-action state from append-only publication history.
 * Raw history remains available separately; this projection never deletes or
 * rewrites receipts and never guesses a physical location from title text.
 */
export function buildProductDocumentPublicationView(
  artifact: ArtifactPublicationIdentity,
  publications: ProductDocumentPublication[],
  findPendingEdit: (pendingEditId: string) => PendingEdit | null,
): ProductDocumentPublicationView {
  const ordered = [...publications].sort(newestFirst);
  const locationByDocKey = new Map<string, ProductDocumentPublicationLocationView>();
  for (const publication of ordered) {
    if (publication.status !== 'complete' || !publication.capturedWorkItemId || locationByDocKey.has(publication.docKey)) continue;
    locationByDocKey.set(publication.docKey, {
      publicationId: publication.publicationId,
      artifactId: publication.artifactId,
      docKey: publication.docKey,
      serverRelativeUrl: publication.serverRelativeUrl,
      siteUrl: publication.siteUrl,
      format: publication.format,
      webUrl: publication.webUrl,
      remoteItemId: publication.remoteItemId,
      capturedWorkItemId: publication.capturedWorkItemId,
      completedAt: publication.capturedAt ?? publication.updatedAt,
      containsSelectedArtifact: publication.artifactId === artifact.artifactId,
    });
  }
  const completedLocations = [...locationByDocKey.values()];
  const updateBases = completedLocations.filter(location => !location.containsSelectedArtifact);
  const currentLocationCount = completedLocations.length - updateBases.length;

  // Rank every durable nonterminal chain attempt. Effect-bearing,
  // ambiguous, in-flight, and approved receipts outrank newer local stages;
  // safe older staged/conflict rows are omitted because stage() may supersede
  // them atomically for the selected source.
  const blockers = ordered
    .filter(publication => !TERMINAL_HISTORY.has(publication.status))
    .map(publication => ({
      publication,
      pending: findPendingEdit(publication.pendingEditId),
      priority: attemptPriority(publication, artifact.artifactId),
    }))
    .filter(entry => entry.priority >= 0)
    .sort((left, right) => right.priority - left.priority || newestFirst(left.publication, right.publication))
    .map(entry => attemptView(entry.publication, entry.pending));
  const attempt = blockers[0] ?? null;
  const attemptPublication = attempt ? ordered.find(publication => publication.publicationId === attempt.publicationId) ?? null : null;
  const attemptPending = attemptPublication ? findPendingEdit(attemptPublication.pendingEditId) : null;

  const projectStatus = artifact.projectStatus ?? null;
  const projectBlocked = !artifact.projectId
    || (projectStatus !== null && projectStatus !== 'active' && projectStatus !== 'paused');
  const blockReason = !artifact.projectId
    ? 'Assign this document chain to a project before publishing it.'
    : projectBlocked
      ? `The owning project is ${projectStatus || 'missing'} and cannot start a new publication.`
      : null;

  let phase: ProductDocumentPublicationPhase;
  if (projectBlocked) phase = 'blocked_unassigned';
  else if (attemptPublication) phase = phaseForAttempt(attemptPublication, attemptPending);
  else if (currentLocationCount > 0) phase = 'complete';
  else if (updateBases.length === 1) phase = 'update_ready';
  else if (updateBases.length > 1) phase = 'update_base_selection_required';
  else phase = 'create_configuration_required';

  return {
    phase,
    selectedArtifactId: artifact.artifactId,
    projectId: artifact.projectId ?? null,
    projectStatus,
    blockReason,
    attempt,
    blockers,
    completedLocations,
    updateBases,
    currentLocationCount,
    historyCount: publications.length,
  };
}

export function buildProductDocumentPublicationViewFromService(
  artifact: ArtifactPublicationIdentity,
  service: ProductDocumentPublicationService,
): ProductDocumentPublicationView {
  return buildProductDocumentPublicationView(
    artifact,
    service.listByChain(artifact.artifactId),
    pendingEditId => service.findPendingEdit(pendingEditId),
  );
}
