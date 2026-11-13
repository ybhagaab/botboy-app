/**
 * Where a publication lands, in the owner's words (owner report 2026-11-13: with Google Drive connected and Amazon Employee off,
 * the reader still said SharePoint). An attempt names its own destination, published copies name theirs, and a document not yet
 * published names the one destination it can go to; with both offered (or a mix of copies) the words are neutral.
 *   available: { sharepoint, drive } — SharePoint while Amazon Employee is on, Drive while it is connected with publishing.
 */
export const SHAREPOINT = 'SharePoint';
export const GOOGLE_DRIVE = 'Google Drive';
export function publicationPlace(view, available = { sharepoint: true, drive: false }) {
  const attempt = view?.attempt;
  if (attempt) return attempt.destination ? GOOGLE_DRIVE : SHAREPOINT;
  const locations = Array.isArray(view?.completedLocations) ? view.completedLocations : [];
  if (locations.length) {
    const drive = locations.filter(location => location?.destination).length;
    if (drive === locations.length) return GOOGLE_DRIVE;
    if (drive === 0) return SHAREPOINT;
    return null;
  }
  const sharepoint = available?.sharepoint !== false;
  const drive = available?.drive === true;
  if (drive && !sharepoint) return GOOGLE_DRIVE;
  if (drive && sharepoint) return null;
  return SHAREPOINT;
}
/** The place of one published copy. */
export const locationPlace = (location) => (location?.destination ? GOOGLE_DRIVE : SHAREPOINT);

const PHASE_COPY = Object.freeze({
  blocked_unassigned: (place) => ({
    label: 'Publication unavailable',
    summary: 'The document needs an active or paused owning project.',
    button: place || 'Publish',
    tone: 'muted',
  }),
  create_configuration_required: (place) => ({
    label: 'Not published',
    summary: place === GOOGLE_DRIVE ? 'Choose a Google Drive folder and how to store it.'
      : place ? 'Choose an exact SharePoint destination and format.'
        : 'Choose SharePoint or Google Drive, then the exact destination.',
    button: place ? `Publish to ${place}…` : 'Publish…',
    tone: 'muted',
  }),
  update_ready: (place) => ({
    label: 'Current version local',
    summary: place ? `An older version exists on ${place} and can be updated in place.` : 'An older version is published and can be updated in place.',
    button: 'Review update…',
    tone: 'accent',
  }),
  update_base_selection_required: (place) => ({
    label: place ? `Choose a ${place} copy` : 'Choose a published copy',
    summary: 'This document has multiple published locations. Select the exact item to update.',
    button: 'Choose location…',
    tone: 'accent',
  }),
  pending: (place) => ({
    label: 'Publication awaiting review',
    summary: `The intent is staged locally. ${place || 'Nothing outside BotBoy'} has not been changed.`,
    button: 'Review publication',
    tone: 'accent',
  }),
  approved: (place) => ({
    label: 'Approved · write not started',
    summary: `The exact action is approved. The final ${place ? `${place} ` : ''}write is still waiting.`,
    button: 'Finish publication',
    tone: 'good',
  }),
  in_flight: () => ({
    label: 'Publication phase recorded',
    summary: 'A durable receipt exists; refresh to reconcile its current state.',
    button: 'Review receipt',
    tone: 'accent',
  }),
  conflicted: () => ({
    label: 'Publication conflict · no write',
    summary: 'The target changed before the guarded write. Review the conflict before retrying.',
    button: 'Resolve conflict',
    tone: 'warn',
  }),
  failed: () => ({
    label: 'Publication needs attention',
    summary: 'The ledger recorded a failure. Review the receipt before taking another action.',
    button: 'Review receipt',
    tone: 'warn',
  }),
  complete: (place) => ({
    label: place ? `Current on ${place}` : 'Published',
    summary: `This immutable version has a verified, capture-linked ${place ? `${place} ` : ''}location.`,
    button: place ? `${place} locations` : 'Published locations',
    tone: 'good',
  }),
});

/** The view's words. `place` (publicationPlace) says where it lands; left out, it is read from the view as SharePoint-only. */
export function publicationPresentation(view, options = {}) {
  const phase = typeof view?.phase === 'string' && PHASE_COPY[view.phase]
    ? view.phase
    : 'create_configuration_required';
  const place = Object.prototype.hasOwnProperty.call(options, 'place') ? options.place : publicationPlace(view);
  const base = PHASE_COPY[phase](place);
  const count = Math.max(0, Number(view?.currentLocationCount) || 0);
  if (phase === 'complete' && count > 1) {
    return { ...base, phase, label: place ? `Current at ${count} ${place} locations` : `Current at ${count} locations` };
  }
  return { ...base, phase };
}

/** The button that stages (or, `final`, performs) the action, named for where it lands. */
export function publicationEffectLabel(action, { final = false, place = SHAREPOINT } = {}) {
  if (action === 'update_existing') {
    if (!final) return 'Stage update for review';
    return place === GOOGLE_DRIVE ? 'Update Google Drive file' : place ? `Update ${place} version` : 'Update published version';
  }
  if (!final) return 'Stage new copy for review';
  return place ? `Create ${place} copy` : 'Create the copy';
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

export function publicationStageRequest(view, draft = {}, driveChoices = []) {
  const mode = draft.mode === 'update_existing' ? 'update_existing' : 'create';
  // Google Drive destination (A7): account + folder from the chosen candidate.
  if (mode === 'create' && draft.provider === 'gdrive') {
    const choice = driveChoices[Number(draft.driveChoice || 0)];
    if (!choice) return { ok: false, error: 'Choose a Google Drive destination.' };
    return {
      ok: true,
      body: {
        ownerRequested: true,
        action: 'create',
        format: 'docx',
        destination: { provider: 'gdrive', accountId: choice.accountId, folderId: choice.folderId, storedAs: draft.storedAs === 'google_doc' ? 'google_doc' : 'docx' },
      },
    };
  }
  if (mode === 'update_existing') {
    const basePublicationId = String(draft.basePublicationId || '').trim();
    const candidate = (view?.updateBases || []).find(entry => entry.publicationId === basePublicationId);
    if (!candidate) return { ok: false, error: `Choose the exact ${locationPlace((view?.updateBases || [])[0])} copy to update.` };
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
