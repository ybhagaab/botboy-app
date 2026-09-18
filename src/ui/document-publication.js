const PHASE_COPY = Object.freeze({
  blocked_unassigned: {
    label: 'Publication unavailable',
    summary: 'The document needs an active or paused owning project.',
    button: 'SharePoint',
    tone: 'muted',
  },
  create_configuration_required: {
    label: 'Not published',
    summary: 'Choose an exact SharePoint destination and format.',
    button: 'Publish to SharePoint…',
    tone: 'muted',
  },
  update_ready: {
    label: 'Current version local',
    summary: 'An older version exists on SharePoint and can be updated in place.',
    button: 'Review update…',
    tone: 'accent',
  },
  update_base_selection_required: {
    label: 'Choose a SharePoint copy',
    summary: 'This document has multiple published locations. Select the exact item to update.',
    button: 'Choose location…',
    tone: 'accent',
  },
  pending: {
    label: 'Publication awaiting review',
    summary: 'The intent is staged locally. SharePoint has not been changed.',
    button: 'Review publication',
    tone: 'accent',
  },
  approved: {
    label: 'Approved · write not started',
    summary: 'The exact action is approved. The final SharePoint write is still waiting.',
    button: 'Finish publication',
    tone: 'good',
  },
  in_flight: {
    label: 'Publication phase recorded',
    summary: 'A durable receipt exists; refresh to reconcile its current state.',
    button: 'Review receipt',
    tone: 'accent',
  },
  conflicted: {
    label: 'Publication conflict · no write',
    summary: 'The target changed before the guarded write. Review the conflict before retrying.',
    button: 'Resolve conflict',
    tone: 'warn',
  },
  failed: {
    label: 'Publication needs attention',
    summary: 'The ledger recorded a failure. Review the receipt before taking another action.',
    button: 'Review receipt',
    tone: 'warn',
  },
  complete: {
    label: 'Current on SharePoint',
    summary: 'This immutable version has a verified, capture-linked SharePoint location.',
    button: 'SharePoint locations',
    tone: 'good',
  },
});

export function publicationPresentation(view) {
  const phase = typeof view?.phase === 'string' && PHASE_COPY[view.phase]
    ? view.phase
    : 'create_configuration_required';
  const base = PHASE_COPY[phase];
  const count = Math.max(0, Number(view?.currentLocationCount) || 0);
  if (phase === 'complete' && count > 1) {
    return { ...base, phase, label: `Current at ${count} SharePoint locations` };
  }
  return { ...base, phase };
}

export function publicationEffectLabel(action, { final = false } = {}) {
  if (action === 'update_existing') return final ? 'Update SharePoint version' : 'Stage update for review';
  return final ? 'Create SharePoint copy' : 'Stage new copy for review';
}

export function defaultPublicationDraft(view, destinationDefault) {
  const updateMode = Array.isArray(view?.updateBases) && view.updateBases.length > 0;
  const targetFolder = !updateMode && destinationDefault?.status === 'resolved'
    ? String(destinationDefault.targetFolder || '')
    : '';
  return {
    mode: updateMode ? 'update_existing' : 'create',
    basePublicationId: view?.updateBases?.length === 1 ? view.updateBases[0].publicationId : '',
    format: 'docx',
    destinationMode: 'folder',
    targetFolder,
    serverRelativeUrl: '',
    siteUrl: '',
  };
}

export function publicationStageRequest(view, draft = {}) {
  const mode = draft.mode === 'update_existing' ? 'update_existing' : 'create';
  if (mode === 'update_existing') {
    const basePublicationId = String(draft.basePublicationId || '').trim();
    const candidate = (view?.updateBases || []).find(entry => entry.publicationId === basePublicationId);
    if (!candidate) return { ok: false, error: 'Choose the exact SharePoint copy to update.' };
    return {
      ok: true,
      body: { ownerRequested: true, action: 'update_existing', basePublicationId },
    };
  }

  const format = draft.format === 'md' ? 'md' : 'docx';
  const targetFolder = String(draft.targetFolder || '').trim();
  const serverRelativeUrl = String(draft.serverRelativeUrl || '').trim();
  const siteUrl = String(draft.siteUrl || '').trim();
  if (Boolean(targetFolder) === Boolean(serverRelativeUrl)) {
    return { ok: false, error: 'Enter either a destination folder or a complete file path.' };
  }
  if (serverRelativeUrl && !serverRelativeUrl.toLowerCase().endsWith(`.${format}`)) {
    return { ok: false, error: `The complete file path must end in .${format}.` };
  }
  return {
    ok: true,
    body: {
      ownerRequested: true,
      action: 'create',
      format,
      ...(targetFolder ? { targetFolder } : {}),
      ...(serverRelativeUrl ? { serverRelativeUrl } : {}),
      ...(siteUrl ? { siteUrl } : {}),
    },
  };
}

export function publicationAttemptCanReject(view) {
  return view?.phase === 'pending' || view?.phase === 'conflicted';
}

export function publicationAttemptCanApply(view) {
  if (!view?.attempt?.docKey) return false;
  if (view.phase === 'approved') return true;
  return view.phase === 'failed'
    && view.attempt.publicationStatus === 'upload_failed'
    && view.attempt.pendingStatus === 'approved';
}
