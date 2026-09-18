const RECENT = 'recent';
const TITLE = 'title';
const STATUS = 'status';

function compareDocumentRecent(left, right) {
  return String(right?.createdAt || '').localeCompare(String(left?.createdAt || ''))
    || String(right?.artifactId || '').localeCompare(String(left?.artifactId || ''));
}

function compareRecent(left, right) {
  return compareDocumentRecent(left?.head, right?.head);
}

function compareTitle(left, right) {
  return String(left?.head?.title || '').localeCompare(String(right?.head?.title || ''), undefined, {
    sensitivity: 'base',
    numeric: true,
  }) || compareRecent(left, right);
}

function searchableDocumentText(document) {
  return normalizeSearchText([
    document?.title,
    document?.profileId,
    document?.state,
    document?.artifactId,
    document?.projectId,
    document?.projectTitle,
  ]
    .filter(Boolean)
    .join(' '));
}

function normalizeSearchText(value) {
  return String(value || '').replaceAll('_', ' ').trim().toLocaleLowerCase();
}

/**
 * Reconstruct only the version lineage present in the bounded summary page.
 * A parent outside that page intentionally starts a new visible chain; the UI
 * must call any resulting ordinal a loaded-chain version, never global truth.
 */
export function groupDocumentChains(items = []) {
  const byId = new Map(items.map(entry => [entry.artifactId, entry]));
  const childrenOf = new Map();
  const roots = [];
  for (const entry of items) {
    if (entry.parentArtifactId && byId.has(entry.parentArtifactId)) {
      const siblings = childrenOf.get(entry.parentArtifactId) || [];
      siblings.push(entry);
      childrenOf.set(entry.parentArtifactId, siblings);
    } else {
      roots.push(entry);
    }
  }
  const chains = roots.map(root => {
    const members = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current.artifactId)) continue;
      seen.add(current.artifactId);
      members.push(current);
      for (const child of childrenOf.get(current.artifactId) || []) stack.push(child);
    }
    members.sort(compareDocumentRecent);
    return {
      chainKey: `loaded:${root.artifactId}`,
      root,
      head: members[0],
      older: members.slice(1),
      members,
      hasUnloadedParent: Boolean(root.parentArtifactId && !byId.has(root.parentArtifactId)),
    };
  });
  chains.sort(compareRecent);
  return chains;
}

/** Search and sort complete loaded chains so a matching older revision never
 * detaches from its head. Search scope is the latest bounded summary page. */
export function buildDocumentLibraryView(items = [], { query = '', sort = RECENT } = {}) {
  const normalizedQuery = normalizeSearchText(query);
  const chains = groupDocumentChains(items).filter(chain => !normalizedQuery
    || chain.members.some(document => searchableDocumentText(document).includes(normalizedQuery)));
  if (sort === TITLE) chains.sort(compareTitle);
  else if (sort === STATUS) {
    chains.sort((left, right) => String(left.head.state || '').localeCompare(String(right.head.state || ''), undefined, {
      sensitivity: 'base',
    }) || compareTitle(left, right));
  } else chains.sort(compareRecent);
  return chains;
}

export function documentChainExpansionState(chains = [], selectedArtifactId = '', overrides = new Map()) {
  const selectedChain = selectedArtifactId
    ? chains.find(chain => chain.members.some(member => member.artifactId === selectedArtifactId))
    : null;
  const autoKey = selectedChain?.chainKey || (!selectedArtifactId ? chains[0]?.chainKey : null);
  return new Map(chains.map(chain => [
    chain.chainKey,
    overrides.has(chain.chainKey) ? Boolean(overrides.get(chain.chainKey)) : chain.chainKey === autoKey,
  ]));
}

export function loadedDocumentRevisionLabel(chains, artifactId, parentArtifactId = null) {
  for (const chain of chains || []) {
    const newestFirst = chain.members || [chain.head, ...(chain.older || [])];
    const index = newestFirst.findIndex(entry => entry?.artifactId === artifactId);
    if (index < 0) continue;
    if (newestFirst.length === 1) return newestFirst[0]?.parentArtifactId ? 'Revision' : 'Original';
    return `Version ${newestFirst.length - index} of ${newestFirst.length} loaded`;
  }
  return parentArtifactId ? 'Revision' : 'Original';
}

function normalizeAspect(value, fallback) {
  const text = String(value || fallback || 'other').replaceAll('_', ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Other';
}

function addGroup(groups, item) {
  const key = item.aspect.toLocaleLowerCase();
  const group = groups.get(key) || { label: item.aspect, items: [] };
  group.items.push(item);
  groups.set(key, group);
}

/** Normalize all review material once. Validation and conformance notes are
 * grouped by aspect; evidence remains a separate source list. */
export function buildDocumentReviewModel(artifact = {}) {
  const citations = (Array.isArray(artifact.citations) ? artifact.citations : [])
    .filter(cite => cite && typeof cite.id === 'string' && typeof cite.label === 'string');
  const validationFindings = (Array.isArray(artifact.validation?.findings) ? artifact.validation.findings : [])
    .filter(entry => entry && ['warning', 'error', 'block'].includes(entry.severity));
  const review = artifact.conformanceReview && typeof artifact.conformanceReview === 'object'
    ? artifact.conformanceReview
    : null;
  const conformanceFindings = Array.isArray(review?.findings) ? review.findings : [];
  const groups = new Map();

  for (const finding of validationFindings.slice(0, 25)) {
    addGroup(groups, {
      source: 'validation',
      aspect: normalizeAspect(finding.aspect || finding.category, 'Validation'),
      severity: finding.severity === 'error' || finding.severity === 'block' ? 'deviation' : 'note',
      code: String(finding.code || 'FINDING'),
      message: String(finding.message || ''),
    });
  }
  for (const finding of conformanceFindings.slice(0, 20)) {
    addGroup(groups, {
      source: 'conformance',
      aspect: normalizeAspect(finding.aspect, 'Conformance'),
      severity: finding.severity === 'deviation' ? 'deviation' : 'note',
      code: '',
      message: String(finding.message || ''),
    });
  }

  const statusLabel = {
    conformant: 'Conformant',
    corrected: 'Auto-corrected',
    deviations_noted: 'Deviations noted',
    unavailable: 'Not run',
  }[review?.status] || '';

  return {
    citations,
    groups: Array.from(groups.values()),
    noteCount: validationFindings.length + conformanceFindings.length,
    renderedNoteCount: Math.min(validationFindings.length, 25) + Math.min(conformanceFindings.length, 20),
    hiddenNoteCount: Math.max(0, validationFindings.length - 25) + Math.max(0, conformanceFindings.length - 20),
    totalCount: citations.length + validationFindings.length + conformanceFindings.length,
    reviewSummary: typeof review?.summary === 'string' ? review.summary : '',
    statusLabel,
    statusTone: review?.status === 'conformant' || review?.status === 'corrected'
      ? 'good'
      : review?.status === 'deviations_noted' ? 'warn' : '',
  };
}

/** Actual shell width wins over viewport width because sidebar/chat presets
 * change the usable reading surface independently of window dimensions. */
export function shouldCollapseLibraryForReview(shellWidth, minimumComfortableWidth = 1180) {
  const width = Number(shellWidth);
  return Number.isFinite(width) && width > 0 && width < minimumComfortableWidth;
}

export function boundedDocumentCountLabel({ loadedCount, total = null, query = '', visibleCount = 0 } = {}) {
  const loaded = Number(loadedCount);
  if (!Number.isFinite(loaded) || loaded < 0) return '—';
  const parsedTotal = Number(total);
  const boundedTotal = Number.isFinite(parsedTotal) && parsedTotal > loaded ? parsedTotal : null;
  const loadedLabel = boundedTotal ? `${loaded.toLocaleString()} of ${boundedTotal.toLocaleString()}` : `${loaded.toLocaleString()} loaded`;
  return String(query || '').trim()
    ? `${Math.max(0, Number(visibleCount) || 0).toLocaleString()} shown · ${loadedLabel}`
    : loadedLabel;
}

export function boundedDocumentScopeLabel(loadedCount, limit) {
  const loaded = Number(loadedCount);
  const boundedLimit = Math.max(1, Number(limit) || 1);
  return Number.isFinite(loaded) && loaded >= 0
    ? `${loaded.toLocaleString()} loaded · up to ${boundedLimit.toLocaleString()} recent`
    : `Up to ${boundedLimit.toLocaleString()} recent`;
}

/** Review and Focus are composable per-artifact presentation state. Review
 * may own a responsive Library collapse, but neither mode closes the other. */
export function toggleDocumentReviewState(current, embeddedShellWidth) {
  const next = { ...current };
  const opening = !Boolean(current.reviewOpen);
  next.reviewOpen = opening;
  if (opening) {
    if (current.libraryOpen && shouldCollapseLibraryForReview(embeddedShellWidth)) {
      next.libraryOpen = false;
      next.reviewCollapsedLibrary = true;
    }
  } else if (current.reviewCollapsedLibrary) {
    next.libraryOpen = true;
    next.reviewCollapsedLibrary = false;
  }
  return next;
}

export function toggleDocumentFocusState(current) {
  return { ...current, focusMode: !Boolean(current.focusMode) };
}

/** Library opening cannot coexist with a Review-owned collapse. On mobile the
 * selected-detail route hides the library pane by contract, so opening Library
 * means navigating back to the visible list route instead of repainting a
 * hidden control. */
export function toggleDocumentLibraryState(current, { isMobile = false, hasArtifact = true } = {}) {
  if (!hasArtifact) return { state: { ...current, libraryOpen: true }, navigateToList: false };
  const opening = !Boolean(current.libraryOpen);
  const next = { ...current, libraryOpen: opening };
  if (opening && current.reviewOpen) {
    next.reviewOpen = false;
    next.reviewCollapsedLibrary = false;
  }
  if (isMobile && opening) {
    next.libraryOpen = true;
    return { state: next, navigateToList: true };
  }
  return { state: next, navigateToList: false };
}
