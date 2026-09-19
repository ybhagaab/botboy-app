// BotBoy production workspace — live Area → Project → Brain → Evidence UI.
// The legacy app.js remains loaded for its proven chat streaming and capture-settings
// workflows; this module owns the new shell, routing, and read-model rendering.

import { nextTodayFocusIndex, renderTodayView, todayPaneHandoffDelta } from './today.js';
import {
  boundedDocumentCountLabel,
  boundedDocumentScopeLabel,
  buildDocumentLibraryView,
  buildDocumentReviewModel,
  documentChainExpansionState,
  loadedDocumentRevisionLabel,
  toggleDocumentFocusState,
  toggleDocumentLibraryState,
  toggleDocumentReviewState,
} from './document-reader.js';
import {
  defaultPublicationDraft,
  publicationAttemptCanApply,
  publicationEffectLabel,
  publicationPresentation,
  publicationStageRequest,
} from './document-publication.js';
import {
  beginProjectArtifactLoad,
  beginUnassignedArtifactLoad,
  completeProjectArtifactLoad,
  completeUnassignedArtifactLoad,
  failProjectArtifactLoad,
  failUnassignedArtifactLoad,
} from './project-artifacts.js';
import {
  applyDocumentReaderPresentation,
  syncDocumentPublicationDialog,
  syncDocumentReaderPresentation,
} from './document-reader-presentation.js';
import {
  beginRouteNavigation,
  enforceRootScrollOrigin,
  parseReloadScrollSnapshot,
  shouldPreserveOuterScroll,
  startOuterScrollRestore,
} from './shell-scroll.js';

const API = '/api';
const DOCUMENT_LIST_LIMIT = 100;
const DOCUMENT_PREVIEW_LIMIT = 200_000;
const DOCUMENT_DETAIL_CACHE_LIMIT = 3;
const LLM_USAGE_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const state = {
  loading: true,
  coreError: '',
  areas: [],
  projects: [],
  projectDetails: new Map(),
  projectErrors: new Map(),
  health: null,
  llmUsage: { data: null, error: '', loading: false, days: 30, timeZone: LLM_USAGE_TIME_ZONE, requestId: 0 },
  today: { data: null, error: '', opening: false, pending: new Set(), focus: null, deferredProject: '' },
  inbox: { count: null, items: [], limit: 100, offset: 0 },
  inboxError: '',
  slack: { configured: null, error: '' },
  folders: { items: null, error: '' },
  graspSync: { status: null, error: '', busy: '' },
  sharepointSync: { status: null, error: '', busy: '', sites: [], libraries: [], pickedSite: '' },
  mcp: {
    servers: null,
    config: null,
    error: '',
    saving: false,
    testing: false,
    restarting: false,
    // Generic managed-profile action state, keyed by profile id.
    profilePending: {},
    profileNotice: {},
    // Add/edit form state for user-added MCP servers.
    serverForm: { saving: false, error: '', config: null, loadingConfig: false, deleting: false },
    // Embedded setup-terminal state: one session at a time.
    terminal: { profileId: '', session: null, output: '', starting: false, sending: false, source: null },
    // Analytics knowledge directory (a2-analytics page card).
    analyticsContext: null,
    analyticsContextPending: false,
  },
  analytics: {
    items: null,
    details: new Map(),
    error: '',
    loading: false,
    refreshing: new Set(),
    cancelling: new Set(),
    scheduling: new Set(),
    linkingProjects: new Set(),
    deleting: new Set(),
    pollTimer: null,
    polling: false,
    announcedRuns: new Set(),
    visualizationViews: new Map(),
  },
  publisher: { config: null, error: '', loading: false, saving: false, preparing: new Set(), pending: new Map(), publishing: new Set(), harmonyProbe: null, probing: false, installingCli: false, provisionPlan: null, provisioning: false, expandedProvider: undefined, mwinitOpening: false },
  channels: { data: null, error: '', loading: false, running: false },
  documents: {
    items: null,
    total: null,
    error: '',
    loading: false,
    refreshing: false,
    details: new Map(),
    detailErrors: new Map(),
    detailLoading: new Set(),
    pendingFocus: null,
    // Library view state survives artifact switches; it applies only to the
    // latest bounded summary page returned by the existing API.
    libraryQuery: '',
    librarySort: 'recent',
    chainExpansionOverrides: new Map(),
    libraryOpen: true,
    reviewCollapsedLibrary: false,
    // Per-selected-artifact view state; reset whenever the selection changes.
    uiArtifactId: '',
    previewMode: 'rendered',
    editing: false,
    editDraft: null,
    answersDraft: '',
    saving: false,
    projectAssigning: false,
    actionError: '',
    publicationOpen: false,
    publicationTrigger: 'summary',
    publicationDraft: null,
    publicationDraftTouched: false,
    publicationDestinationLoading: false,
    publicationBusy: new Set(),
    publicationError: '',
    reviewOpen: false,
    detailsOpen: false,
    focusMode: false,
    embeddedShellWidth: 0,
    questionsOpen: true,
    downloading: null,
    deleting: false,
    // Guided pandoc install (blocked Word/PDF/HTML download):
    // { artifactId, format, state: 'offer'|'installing'|'failed'|'homebrew_missing', error }
    pandocPrompt: null,
  },
  rebuilding: new Set(),
  evidencePending: new Set(),
  discarded: { data: null, error: '' },
  // Document workbench: per-project grouped documents + the reader view.
  projectDocuments: new Map(), // projectId → { documents, error, loading }
  projectArtifacts: new Map(), // projectId → { artifacts, unassigned, error, loading }
  artifactAssignmentPending: new Set(),
  docReader: { key: '', data: null, error: '', loading: false, refreshing: false },
  taskActions: { expandedKey: '', discardArmedKey: '', busyKey: '' },
  route: { view: 'today' },
  projectTab: 'brief',
  evidenceFilter: 'all',
  expandedAreas: new Set(),
  expandedPeople: new Set(),
  showAllAreas: false,
  commandItems: [],
  commandIndex: 0,
  commandTimer: null,
  lastVersion: null,
  lastAnalyticsVersion: null,
  lastDocumentsVersion: null,
  lastBootId: null,
  lastUiVersion: null,
};

const areaColors = ['#9d8cff', '#6faef5', '#56d69a', '#f3ba63', '#ed7fbd', '#f1a34f', '#7ac9c3', '#ae91d1', '#8f929a'];
const icon = (name, size = 17) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const attr = esc;
const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';

function todaySession(data = state.today.data) {
  const since = data?.since;
  const sinceRowId = Number(data?.cursor?.sinceRowId);
  const sinceLabel = data?.sinceLabel;
  if (typeof since !== 'string' || !Number.isSafeInteger(sinceRowId) || sinceRowId < 0) return null;
  if (sinceLabel !== 'last_visit' && sinceLabel !== 'past_24_hours') return null;
  return { since, sinceRowId, sinceLabel };
}

function todayReadPath(data = state.today.data) {
  const session = todaySession(data);
  if (!session) return null;
  const params = new URLSearchParams({
    since: session.since,
    sinceRowId: String(session.sinceRowId),
    sinceLabel: session.sinceLabel,
  });
  return `/today?${params.toString()}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error || body?.message || body?.result?.message || '';
    } catch {}
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function parseRoute() {
  const raw = location.hash || '#/today';
  if (raw.startsWith('#node/')) return { view: 'nodes', nodeId: raw.slice('#node/'.length) };
  const parts = raw.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length || parts[0] === 'today') return { view: 'today' };
  if (parts[0] === 'projects') return { view: 'project', projectId: parts[1] || '' };
  if (parts[0] === 'areas') return { view: 'area', areaId: parts[1] || '' };
  if (parts[0] === 'connections' && parts[1] === 'sql-context') return { view: 'mcp-settings' };
  if (parts[0] === 'connections' && parts[1] === 'mail-calendar-sync') return { view: 'grasp-sync-settings' };
  if (parts[0] === 'connections' && parts[1] === 'document-sync') return { view: 'sharepoint-sync-settings' };
  if (parts[0] === 'connections' && parts[1] === 'add') return { view: 'mcp-add' };
  if (parts[0] === 'connections' && parts[1] && parts[2] === 'edit') return { view: 'mcp-edit', profileId: parts[1] };
  // Every other managed MCP profile uses the generic settings page.
  if (parts[0] === 'connections' && parts[1]) return { view: 'profile-settings', profileId: parts[1] };
  if (parts[0] === 'settings' && parts[1] === 'dashboard-sharing') return { view: 'publisher-settings' };
  if (parts[0] === 'settings' && parts[1] === 'llm-usage') return { view: 'llm-usage-settings' };
  if (parts[0] === 'dashboards') return { view: parts[1] ? 'analytics-dashboard' : 'dashboards', dashboardId: parts[1] || '' };
  if (parts[0] === 'documents') {
    let artifactId = parts[1] || '';
    try { artifactId = decodeURIComponent(artifactId); } catch {}
    return { view: 'documents', artifactId };
  }
  // Workbench reader: #/doc/<base64url(docKey)> — distinct from #/documents
  // (the product-manager writing workspace).
  if (parts[0] === 'doc' && parts[1]) return { view: 'doc-reader', docId: parts[1] };
  if (['inbox', 'channels', 'connections', 'pipeline', 'settings', 'nodes'].includes(parts[0])) return { view: parts[0] };
  return { view: 'not-found' };
}

function go(hash) {
  closeIntegration();
  setMobileSidebarOpen(false);
  if (location.hash === hash) renderRoute({ userAction: true });
  else location.hash = hash;
}

function normalizeAreas(payload) {
  const source = Array.isArray(payload?.areas) ? payload.areas : [];
  return source.map((area, index) => ({
    id: String(area.id),
    title: area.title || 'Untitled area',
    description: area.description || '',
    color: areaColors[index % areaColors.length],
    projects: (Array.isArray(area.projects) ? area.projects : []).map(project => ({
      id: String(project.id), title: project.title || 'Untitled project', status: project.status || 'active',
      oneLiner: project.one_liner || project.oneLiner || '', itemCount: Number(project.itemCount || 0), areaId: String(area.id),
    })),
  }));
}

function normalizeProjects(payload) {
  return (Array.isArray(payload?.projects) ? payload.projects : []).map(project => ({
    id: String(project.id), title: project.title || 'Untitled project', status: project.status || 'active',
    oneLiner: project.oneLiner || project.one_liner || '', updatedAt: project.updatedAt || project.updated_at || '',
    itemCount: Number(project.itemCount || 0),
  }));
}

function projectById(id) {
  return state.projects.find(project => project.id === id)
    || state.areas.flatMap(area => area.projects).find(project => project.id === id)
    || null;
}

function areaForProject(id) {
  return state.areas.find(area => area.projects.some(project => project.id === id)) || null;
}

function activeProjects() {
  return state.projects.filter(project => project.status === 'active');
}

function totalItems() {
  if (!state.health?.itemsByState) return null;
  return Object.values(state.health.itemsByState).reduce((sum, value) => sum + Number(value || 0), 0);
}

function relativeTime(value) {
  if (!value) return 'Unknown';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return String(value);
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(time));
}

function sourceIcon(source, type = '') {
  const value = `${source} ${type}`.toLowerCase();
  if (value.includes('slack')) return 'hash';
  if (value.includes('calendar')) return 'clock';
  if (value.includes('email')) return 'message';
  if (value.includes('browser') || value.includes('web')) return 'globe';
  if (value.includes('clipboard') || value.includes('message')) return 'message';
  return 'file';
}

function projectTone(project, detail) {
  if (detail?.brain?.blockers?.length || detail?.brain?.tasks?.some(task => task.state === 'blocked')) return 'warn';
  if (project?.status === 'paused') return 'warn';
  if (project?.status === 'done') return 'blue';
  if (project?.status === 'archived') return '';
  return 'good';
}

function statusLabel(project) {
  const value = project?.status || 'active';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function loadCore({ quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    state.coreError = '';
    renderRoute();
  }
  const shouldLoadToday = state.route.view === 'today';
  const currentTodayPath = todayReadPath();
  const todayRequest = shouldLoadToday
    ? currentTodayPath
      ? request(currentTodayPath)
      : request('/today/visit', { method: 'POST' })
    : Promise.resolve(null);
  // NOTE: /slack/conversations is deliberately NOT part of the core load. It
  // walks Slack's paginated API server-side (2-6s for hundreds of
  // conversations) and nothing on the dashboard renders it — only the Slack
  // Sources panel needs it, and the panel fetches it on open (post-mortem
  // 2026-08-18: every navigation blanked for the slowest request, which was
  // always this one).
  const [areasResult, projectsResult, todayResult, healthResult, inboxResult, slackConfigResult, foldersResult, mcpResult, graspSyncResult, sharepointSyncResult] = await Promise.allSettled([
    request('/areas'),
    request('/projects'),
    todayRequest,
    request('/pipeline/health'),
    request(`/items/unassigned/summary?limit=${state.inbox.limit}&offset=0`),
    request('/slack/config'),
    request('/local-folders'),
    request('/mcp/profiles'),
    request('/grasp-sync/status'),
    request('/sharepoint-sync/status'),
  ]);

  const criticalErrors = [];
  if (areasResult.status === 'fulfilled') state.areas = normalizeAreas(areasResult.value); else criticalErrors.push(`areas: ${areasResult.reason.message}`);
  if (projectsResult.status === 'fulfilled') {
    state.projects = normalizeProjects(projectsResult.value);
    // Chat history paints before this list arrives on a cold load, so announce
    // the index and let the chat renderer link the project names it already has
    // on screen. Also covers renames and archives on later refreshes.
    window.dispatchEvent(new CustomEvent('botboy:projects-loaded'));
  } else criticalErrors.push(`projects: ${projectsResult.reason.message}`);
  if (shouldLoadToday && todayResult.status === 'fulfilled') {
    state.today.data = todayResult.value;
    state.today.error = '';
  } else if (shouldLoadToday) {
    state.today.error = todayResult.reason.message;
  }
  if (healthResult.status === 'fulfilled') state.health = healthResult.value; else criticalErrors.push(`health: ${healthResult.reason.message}`);
  if (inboxResult.status === 'fulfilled') {
    state.inbox = { ...state.inbox, count: Number(inboxResult.value.count || 0), items: inboxResult.value.items || [], offset: 0 };
    state.inboxError = '';
  } else {
    state.inboxError = inboxResult.reason.message;
  }
  if (slackConfigResult.status === 'fulfilled') state.slack.configured = Array.isArray(slackConfigResult.value.ids) ? slackConfigResult.value.ids : [];
  else state.slack.error = slackConfigResult.reason.message;
  if (foldersResult.status === 'fulfilled') state.folders.items = foldersResult.value.folders || [];
  else state.folders.error = foldersResult.reason.message;
  if (graspSyncResult.status === 'fulfilled') { state.graspSync.status = graspSyncResult.value.status || null; state.graspSync.error = ''; }
  else state.graspSync.error = graspSyncResult.reason.message;
  if (sharepointSyncResult.status === 'fulfilled') { state.sharepointSync.status = sharepointSyncResult.value.status || null; state.sharepointSync.error = ''; }
  else state.sharepointSync.error = sharepointSyncResult.reason.message;
  if (mcpResult.status === 'fulfilled') {
    state.mcp.servers = Array.isArray(mcpResult.value.profiles) ? mcpResult.value.profiles : [];
    state.mcp.profilesError = '';
  } else {
    // Profile-list failures stay on their own channel so the SQL settings
    // page can still load its configuration independently.
    state.mcp.profilesError = mcpResult.reason.message;
  }

  state.loading = false;
  state.coreError = state.areas.length || state.projects.length ? '' : criticalErrors.join('; ');
  if (!state.expandedAreas.size) state.areas.slice(0, 3).forEach(area => state.expandedAreas.add(area.id));
  updateGlobalHealth();
  // Data refreshes must never yank the user's scroll position (owner
  // report 2026-08-26: page "reloads" and jumps to top while reading).
  // First paint has scrollTop 0 anyway. Unlabeled render = background:
  // it also defers the repaint while the owner is typing.
  renderRoute({ preserveScroll: true });
  // Restore any chat draft stashed by the pre-reload handler in pollVersion —
  // an auto-reload must never eat a half-typed message.
  try {
    const savedDraft = sessionStorage.getItem('botboy-reload-draft');
    if (savedDraft !== null) {
      sessionStorage.removeItem('botboy-reload-draft');
      const input = document.getElementById('chatInput');
      if (input && !input.value) input.value = savedDraft;
    }
  } catch {}
}

async function openTodayVisit({ propagate = false } = {}) {
  if (state.today.opening) return;
  state.today.opening = true;
  state.today.data = null;
  state.today.error = '';
  if (state.route.view === 'today') renderRoute({ userAction: true });
  let failure = null;
  try {
    state.today.data = await request('/today/visit', { method: 'POST' });
  } catch (error) {
    state.today.error = error.message;
    failure = error;
  } finally {
    state.today.opening = false;
    if (state.route.view === 'today') renderRoute({ userAction: true });
  }
  if (failure && propagate) throw failure;
  return state.today.data;
}

async function refreshToday({ render = true, propagate = false } = {}) {
  const path = todayReadPath();
  if (!path) return openTodayVisit({ propagate });
  let failure = null;
  try {
    state.today.data = await request(path);
    state.today.error = '';
  } catch (error) {
    state.today.error = error.message;
    failure = error;
  }
  if (render && state.route.view === 'today') renderRoute({ userAction: true });
  if (failure && propagate) throw failure;
  return state.today.data;
}

function tomorrowMorningIso() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

function setTodayControlsDisabled(itemId, disabled) {
  document.querySelectorAll('[data-item]').forEach(control => {
    if (control.dataset.item === itemId) control.disabled = disabled;
  });
}

function todayProjectActionKey(section, projectId) {
  return `today-project:${section}:${projectId}`;
}

function setTodayProjectControlsDisabled(projectId, section, disabled) {
  document.querySelectorAll('[data-action="today-project-snooze"],[data-action="today-project-dismiss"],[data-action="today-project-restore"]').forEach(control => {
    if (control.dataset.project === projectId && control.dataset.section === section) control.disabled = disabled;
  });
}

function todayDeferredProjectIds(data = state.today.data) {
  return [...new Set((data?.deferred || []).map(item => item.projectId).filter(Boolean))];
}

function reconcileTodayDeferredSelection(previousIds) {
  const nextIds = todayDeferredProjectIds();
  const selected = state.today.deferredProject;
  if (!selected || nextIds.includes(selected)) return;
  const previousIndex = Math.max(0, previousIds.indexOf(selected));
  state.today.deferredProject = nextIds[Math.min(previousIndex, Math.max(0, nextIds.length - 1))] || '';
}

function revealTodayDeferredSelection(focus = false, projectId = state.today.deferredProject) {
  requestAnimationFrame(() => {
    const selected = projectId
      ? document.querySelector(`.today-deferred-summary[data-project="${CSS.escape(projectId)}"]`)
      : null;
    const target = selected || document.getElementById('today-set-aside');
    if (focus) target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function revealTodayFocus(section, focus = false) {
  requestAnimationFrame(() => {
    const selected = document.querySelector(`.today-focus-board[data-section="${section}"] .today-focus-tab.selected`);
    if (focus) selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function focusTodayControl(itemId, preferredAction) {
  const controls = [...document.querySelectorAll('[data-item]')];
  const preferred = controls.find(control => control.dataset.item === itemId && control.dataset.action === preferredAction);
  const fallback = controls.find(control => control.dataset.item === itemId);
  (preferred || fallback)?.focus();
}

async function updateTodayItem(itemId, action, expectedVersion) {
  if (!itemId || state.today.pending.has(itemId)) return;
  const deferredProjectsBefore = todayDeferredProjectIds();
  state.today.pending.add(itemId);
  setTodayControlsDisabled(itemId, true);
  let succeeded = false;
  try {
    const session = todaySession();
    if (!session) throw new Error('Today session is stale; refresh the page and try again');
    const body = { action, ...session };
    if (expectedVersion !== undefined) {
      const parsedVersion = Number(expectedVersion);
      if (!Number.isSafeInteger(parsedVersion) || parsedVersion < 0) throw new Error('Change version is invalid; refresh Today');
      body.expectedVersion = parsedVersion;
    }
    if (action === 'snooze') body.snoozedUntil = tomorrowMorningIso();
    await request(`/today/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body });
    await refreshToday({ render: false, propagate: true });
    if (action === 'restore') reconcileTodayDeferredSelection(deferredProjectsBefore);
    succeeded = true;
    const messages = {
      pin: 'Pinned to Today', unpin: 'Removed pin', snooze: 'Snoozed until tomorrow morning',
      dismiss: 'Dismissed from Today', restore: 'Restored to Today',
      mark_done: 'Marked done in the project brain',
    };
    toast(messages[action] || 'Today updated');
  } catch (error) {
    toast(`Could not update Today: ${error.message}`, 'bad');
  } finally {
    state.today.pending.delete(itemId);
    if (state.route.view === 'today') {
      renderRoute({ userAction: true, preserveScroll: true });
      if (succeeded) {
        if (action === 'restore') revealTodayDeferredSelection(true);
        else requestAnimationFrame(() => focusTodayControl(itemId, ['snooze', 'dismiss'].includes(action) ? 'today-restore' : 'today-pin'));
      }
    } else {
      setTodayControlsDisabled(itemId, false);
    }
  }
}

async function updateTodayProject(projectId, section, action) {
  const sectionAction = ['attention', 'waiting'].includes(section) && ['snooze', 'dismiss'].includes(action);
  const deferredRestore = section === 'deferred' && action === 'restore';
  if (!projectId || (!sectionAction && !deferredRestore)) return;
  const deferredProjectsBefore = todayDeferredProjectIds();
  const pendingKey = todayProjectActionKey(section, projectId);
  if (state.today.pending.has(pendingKey)) return;
  state.today.pending.add(pendingKey);
  setTodayProjectControlsDisabled(projectId, section, true);
  let succeeded = false;
  try {
    const session = todaySession();
    if (!session) throw new Error('Today session is stale; refresh the page and try again');
    const body = { section, action, ...session };
    if (action === 'snooze') body.snoozedUntil = tomorrowMorningIso();
    await request(`/today/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body });
    await refreshToday({ render: false, propagate: true });
    if (deferredRestore) reconcileTodayDeferredSelection(deferredProjectsBefore);
    succeeded = true;
    toast(action === 'snooze'
      ? `Snoozed current ${section} items until tomorrow morning`
      : action === 'dismiss'
        ? `Cleared current ${section} items`
        : 'Restored this project’s current Set aside items');
  } catch (error) {
    toast(`Could not update this project: ${error.message}`, 'bad');
  } finally {
    state.today.pending.delete(pendingKey);
    if (state.route.view === 'today') {
      renderRoute({ userAction: true, preserveScroll: true });
      if (succeeded) {
        if (deferredRestore) revealTodayDeferredSelection(true);
        else revealTodayFocus(section, true);
      }
    } else {
      setTodayProjectControlsDisabled(projectId, section, false);
    }
  }
}

function planDay() {
  const data = state.today.data;
  // Grouped per project like the page itself (one project = one entry).
  const actionGroups = (data?.attentionGroups || []).slice(0, 6);
  const waitingGroups = (data?.waitingGroups || []).slice(0, 4);
  const changes = (data?.changes || []).slice(0, 4);
  const lines = ['Today plan'];
  const pushGroup = (group, index) => {
    lines.push(`${index + 1}. ${group.projectTitle}`);
    (group.items || []).forEach(item => lines.push(`    ◦ ${item.title}`));
    if (!(group.items || []).length && group.focus) lines.push(`    ◦ ${group.focus}`);
  };

  if (actionGroups.length) {
    lines.push('', 'Start with:');
    actionGroups.forEach(pushGroup);
  } else {
    lines.push('', 'No explicit action is currently ranked.');
  }
  if (waitingGroups.length) {
    lines.push('', 'Waiting or blocked to review:');
    waitingGroups.forEach(pushGroup);
  }
  if (changes.length) {
    lines.push('', 'Meaningful changes to scan:');
    // item.title is the headline gist; extra lines ride along so the plan
    // reads as sentences, not subjects (TODAY_CHANGES_PLAN.md).
    changes.forEach(item => {
      const extra = Array.isArray(item.items) ? item.items.slice(1) : [];
      lines.push(`• ${item.projectTitle}: ${item.title}`);
      extra.forEach(line => lines.push(`    ◦ ${line.gist}`));
      if (Number(item.hiddenCount) > 0) lines.push(`    ◦ +${item.hiddenCount} more`);
    });
  }
  lines.push('', 'Built locally from the current Today ranking. No tools or workspace actions were run.');

  const messages = document.getElementById('chat-messages');
  if (!messages) {
    toast('Could not display the local plan', 'bad');
    return;
  }
  messages.querySelector('[data-local-today-plan]')?.remove();
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg assistant';
  bubble.dataset.localTodayPlan = 'true';
  const content = document.createElement('div');
  content.className = 'content-block';
  content.textContent = lines.join('\n');
  bubble.appendChild(content);
  messages.appendChild(bubble);
  toggleAssistant(true);
  requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  toast('Local Today plan prepared');
}

async function loadProject(id, { renderAfter = true, force = false } = {}) {
  if (!id || (!force && state.projectDetails.has(id))) return state.projectDetails.get(id);
  // Documents load in parallel so the tab shows its count on first paint
  // (soak find: the count only appeared after clicking the tab).
  void loadProjectDocuments(id);
  try {
    const [detail, crossLinksPayload] = await Promise.all([
      request(`/projects/${encodeURIComponent(id)}`),
      request(`/projects/${encodeURIComponent(id)}/cross-links`).catch(() => null),
    ]);
    detail.crossLinks = Array.isArray(crossLinksPayload?.crossLinks) ? crossLinksPayload.crossLinks : [];
    state.projectDetails.set(id, detail);
    state.projectErrors.delete(id);
    if (renderAfter && state.route.view === 'project' && state.route.projectId === id) renderRoute();
    return detail;
  } catch (error) {
    state.projectErrors.set(id, error.message);
    if (renderAfter) renderRoute();
    return null;
  }
}

function updateGlobalHealth() {
  const dot = document.getElementById('global-health-dot');
  const label = document.getElementById('global-health-label');
  if (!dot || !label) return;
  dot.className = 'status-dot';
  if (!state.health) {
    label.textContent = 'Health unavailable';
    dot.classList.add('warn');
  } else if (Number(state.health.totalFailures || 0) > 0) {
    label.textContent = `${number(state.health.totalFailures)} unresolved failures`;
    dot.classList.add('warn');
  } else {
    label.textContent = 'All systems healthy';
    dot.classList.add('good');
  }
}

function pageHead(eyebrow, title, subtitle, actions = '') {
  return `<header class="page-head"><div><div class="eyebrow"><span class="eyebrow-dot"></span>${esc(eyebrow)}</div><h1 class="page-title">${esc(title)}</h1>${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ''}</div>${actions ? `<div class="head-actions">${actions}</div>` : ''}</header>`;
}

function loadingView() {
  return `<div class="loading-shell" aria-label="Loading workspace"><div class="skeleton" style="width:40%;min-height:42px"></div><div class="grid overview-grid"><div class="skeleton hero"></div><div class="skeleton hero"></div></div><div class="skeleton row"></div><div class="skeleton row"></div></div>`;
}

function errorView(message) {
  return `<section class="card error-state"><span class="source-icon">${icon('alert', 19)}</span><h2>BotBoy could not load this view</h2><p>${esc(message || 'The local API is unavailable.')}</p><button class="button primary" type="button" data-action="retry-core">Try again</button></section>`;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'botboy-sidebar-collapsed';

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  const isCollapsed = Boolean(collapsed);
  document.body.classList.toggle('sidebar-collapsed', isCollapsed);
  const button = document.querySelector('[data-action="toggle-sidebar-collapse"]');
  if (button) {
    const label = isCollapsed ? 'Expand navigation' : 'Collapse navigation';
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }
  if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(isCollapsed));
}

function setMobileSidebarOpen(open) {
  const isOpen = Boolean(open);
  document.body.classList.toggle('sidebar-open', isOpen);
  const button = document.querySelector('[data-action="toggle-sidebar"]');
  if (button) {
    button.setAttribute('aria-expanded', String(isOpen));
    button.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  }
}

function renderSidebar() {
  const route = state.route;
  const inboxCount = state.inbox.count == null ? '—' : state.inbox.count > 9999 ? `${(state.inbox.count / 1000).toFixed(1)}k` : number(state.inbox.count);
  const primary = [
    ['today', 'home', 'Today', '#/today', ''],
    ['inbox', 'inbox', 'Inbox', '#/inbox', inboxCount],
    ['channels', 'hash', 'Channels', '#/channels', ''],
    ['dashboards', 'activity', 'Dashboards', '#/dashboards', state.analytics.items?.length ? String(state.analytics.items.length) : ''],
    ['documents', 'file', 'Documents', '#/documents', state.documents.items?.length ? String(state.documents.items.length) : ''],
    ['connections', 'link', 'Connections', '#/connections', ''],
    ['pipeline', 'activity', 'System health', '#/pipeline', state.health?.totalFailures ? String(state.health.totalFailures) : ''],
    ['settings', 'settings', 'Settings', '#/settings', ''],
  ];
  const visibleAreas = state.showAllAreas ? state.areas : state.areas.slice(0, 5);
  document.getElementById('sidebar-content').innerHTML = `
    <nav class="nav-primary" aria-label="Primary">${primary.map(([view, ico, label, href, count]) => {
      const active = route.view === view
        || (view === 'connections' && ['mcp-settings', 'profile-settings', 'mcp-add', 'mcp-edit'].includes(route.view))
        || (view === 'dashboards' && route.view === 'analytics-dashboard')
        || (view === 'settings' && ['publisher-settings', 'llm-usage-settings'].includes(route.view));
      return `<a class="nav-item ${active ? 'active' : ''}" href="${href}" aria-label="${attr(label)}" title="${attr(label)}" ${active ? 'aria-current="page"' : ''}>${icon(ico)}<span class="nav-text">${esc(label)}</span>${count ? `<span class="nav-count">${esc(count)}</span>` : ''}</a>`;
    }).join('')}</nav>
    <section class="nav-section"><div class="nav-label"><span>Areas & projects</span></div><div class="area-tree">
      ${visibleAreas.map(area => {
        const expanded = state.expandedAreas.has(area.id);
        const activeArea = route.view === 'area' && route.areaId === area.id;
        return `<div class="area-group"><div class="area-row ${expanded ? 'expanded' : ''}"><button class="tree-toggle" type="button" data-action="toggle-area" data-area="${attr(area.id)}" aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${attr(area.title)}">${icon('chevron-right', 14)}</button><a class="area-link ${activeArea ? 'active' : ''}" href="#/areas/${encodeURIComponent(area.id)}"><span class="area-color" style="background:${area.color}"></span><span class="area-name">${esc(area.title)}</span></a><span class="area-count">${number(area.projects.length)}</span></div>${expanded ? `<div class="project-tree">${area.projects.slice(0, 8).map(project => `<a class="project-link ${route.view === 'project' && route.projectId === project.id ? 'active' : ''}" href="#/projects/${encodeURIComponent(project.id)}" title="${attr(project.title)}"><span class="status-dot ${projectTone(project)}"></span><span class="project-title">${esc(project.title)}</span></a>`).join('')}${area.projects.length > 8 ? `<a class="project-link" href="#/areas/${encodeURIComponent(area.id)}"><span class="project-title">${number(area.projects.length - 8)} more projects</span></a>` : ''}</div>` : ''}</div>`;
      }).join('')}
    </div>${state.areas.length > 5 ? `<button class="show-more" type="button" data-action="toggle-all-areas">${state.showAllAreas ? 'Show fewer areas' : `Show ${state.areas.length - 5} more areas`}</button>` : ''}</section>`;
}

// Today focus boards (list-detail): one selected project per section. Only
// owner selections persist; a background render keeps the selection while it
// remains present and falls back to the first ranked project when it leaves.
const TODAY_FOCUS_STORAGE_KEY = 'botboy.today.focus';
function todayFocusState() {
  if (state.today.focus) return state.today.focus;
  let focus = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(TODAY_FOCUS_STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const section of ['attention', 'waiting', 'changes']) {
        if (typeof parsed[section] === 'string') focus[section] = parsed[section];
      }
    }
    // One-time retirement of the superseded accordion state.
    localStorage.removeItem('botboy.today.stacks');
  } catch { /* corrupt/private storage — ranked defaults win */ }
  state.today.focus = focus;
  return focus;
}
function todayFocusId(section, ids) {
  const stored = todayFocusState()[section];
  return ids.includes(stored) ? stored : (ids[0] || '');
}
function setTodayFocus(section, projectId) {
  if (!['attention', 'waiting', 'changes'].includes(section) || !projectId) return;
  const focus = todayFocusState();
  focus[section] = projectId;
  try { localStorage.setItem(TODAY_FOCUS_STORAGE_KEY, JSON.stringify(focus)); } catch { /* private mode */ }
}
function todayFocusContext(data = state.today.data) {
  return {
    attention: todayFocusId('attention', (data?.attentionGroups || []).map(group => group.projectId)),
    waiting: todayFocusId('waiting', (data?.waitingGroups || []).map(group => group.projectId)),
    changes: todayFocusId('changes', (data?.changes || []).map(item => item.projectId)),
  };
}

function renderToday() {
  return renderTodayView({
    data: state.today.data,
    error: state.today.error,
    pending: state.today.pending,
    focus: todayFocusContext(),
    deferredProject: state.today.deferredProject,
    health: state.health,
    inbox: state.inbox,
    pageHead,
    icon,
    esc,
    attr,
    number,
    relativeTime,
    sourceIcon,
  });
}

function renderArea(areaId) {
  if (!areaId) return renderAllAreas();
  const area = state.areas.find(item => item.id === areaId);
  if (!area) return errorView('This area is no longer available.');
  const evidenceCount = area.projects.reduce((sum, project) => sum + project.itemCount, 0);
  const activeCount = area.projects.filter(project => project.status === 'active').length;
  const fallbackHtml = `${pageHead('Area', area.title, area.description || 'A stable domain containing related projects and their evolving source evidence.')}
    <section class="card area-hero"><span class="pill accent"><span class="area-color" style="background:${area.color}"></span> Stable domain</span><p class="page-subtitle">Projects can evolve, merge, or move while this area provides durable context and ownership.</p><div class="area-stats"><div class="area-stat"><strong>${number(activeCount)}</strong><span>Active projects</span></div><div class="area-stat"><strong>${number(evidenceCount)}</strong><span>Evidence items</span></div><div class="area-stat"><strong>${number(area.projects.length - activeCount)}</strong><span>Monitoring or complete</span></div></div></section>
    <div class="section-heading"><div><h2>Projects</h2><p>Current workstreams ordered by the organizer’s latest project order.</p></div></div><section class="grid three-col">${area.projects.map(project => `<a class="card project-card" href="#/projects/${encodeURIComponent(project.id)}"><div><span class="pill ${projectTone(project)}"><span class="status-dot ${projectTone(project)}"></span>${esc(statusLabel(project))}</span></div><h3>${esc(project.title)}</h3><p>${esc(project.oneLiner || 'Open the project brain for its current synthesized context.')}</p><div class="project-card-foot"><span>${number(project.itemCount)} evidence items</span>${icon('arrow-right', 13)}</div></a>`).join('') || `<div class="card empty-state"><h3>No projects in this area</h3></div>`}</section>`;
  return window.BotBoyLayouts?.renderArea({ area, fallbackHtml }) || fallbackHtml;
}

function renderAllAreas() {
  return `${pageHead('Portfolio', 'Areas', 'Stable domains containing active projects and their synthesized context.')}
    <section class="grid three-col">${state.areas.map(area => `<a class="card project-card" href="#/areas/${encodeURIComponent(area.id)}"><div><span class="area-color" style="display:block;background:${area.color};width:12px;height:12px"></span></div><h3>${esc(area.title)}</h3><p>${esc(area.description || `${area.projects.length} related projects`)}</p><div class="project-card-foot"><span>${number(area.projects.length)} projects</span><span>${number(area.projects.reduce((sum, project) => sum + project.itemCount, 0))} evidence items</span></div></a>`).join('')}</section>`;
}

function renderProject(projectId) {
  const project = projectById(projectId);
  if (!project) return errorView('This project is no longer available.');
  const detail = state.projectDetails.get(projectId);
  if (!detail && !state.projectErrors.has(projectId)) {
    void loadProject(projectId);
    return loadingView();
  }
  if (!detail) return errorView(state.projectErrors.get(projectId));
  const brain = detail.brain || {};
  const area = areaForProject(projectId);
  const docsEntry = state.projectDocuments.get(projectId);
  const authoredDocCount = Array.isArray(docsEntry?.authoredDocuments)
    ? buildDocumentLibraryView(docsEntry.authoredDocuments, { sort: 'recent' }).length
    : null;
  const externalDocCount = Array.isArray(docsEntry?.documents) ? docsEntry.documents.length : null;
  const docsCount = authoredDocCount === null && externalDocCount === null
    ? null
    : (authoredDocCount || 0) + (externalDocCount || 0);
  const artifactEntry = state.projectArtifacts.get(projectId);
  const artifactCount = Array.isArray(artifactEntry?.artifacts) ? artifactEntry.artifacts.length : null;
  const tabs = [['brief', 'Brief'], ['tasks', `Tasks ${brain.tasks?.length || 0}`], ['evidence', `Evidence ${project.itemCount}`], ['documents', `Documents${typeof docsCount === 'number' ? ` ${docsCount}` : ''}`], ['timeline', 'Timeline'], ['artifacts', `Artifacts${typeof artifactCount === 'number' ? ` ${artifactCount}` : ''}`]];
  let content = '';
  if (state.projectTab === 'brief') content = renderProjectBrief(project, detail, area);
  if (state.projectTab === 'tasks') content = renderProjectTasks(project, brain);
  if (state.projectTab === 'evidence') content = renderEvidence(project, detail.items || [], detail);
  if (state.projectTab === 'documents') content = renderProjectDocuments(projectId);
  if (state.projectTab === 'timeline') content = renderTimeline(brain.activityLog || []);
  if (state.projectTab === 'artifacts') content = renderProjectArtifacts(projectId);
  const fallbackHtml = `<div class="breadcrumb"><a href="#/today">Workspace</a>${icon('chevron-right', 11)}${area ? `<a href="#/areas/${encodeURIComponent(area.id)}">${esc(area.title)}</a>${icon('chevron-right', 11)}` : ''}<span>Project</span></div><header class="page-head"><div><div class="project-title-row"><h1 class="page-title">${esc(brain.title || project.title)}</h1><span class="pill ${projectTone(project, detail)}"><span class="status-dot ${projectTone(project, detail)}"></span>${esc(statusLabel(project))}</span></div><p class="project-status-line">${esc(brain.statusLine || project.oneLiner || 'No current status line has been synthesized.')}</p><div class="project-meta"><span>${icon('refresh', 13)} Updated ${esc(relativeTime(brain.updated || project.updatedAt))}</span><span>${icon('file', 13)} ${number(project.itemCount)} evidence items</span><span>${icon('shield', 13)} Local workspace</span>${detail.scopeAlertCount ? `<span class="pill warn" title="Evidence flagged by the brain pass because it also anchors another project's scope. Dominant foreign anchors are quarantined from synthesis; the rest are advisory. Review in the Evidence tab.">${icon('alert', 12)} Scope alerts: ${number(detail.scopeAlertCount)}</span>` : ''}</div></div><div class="head-actions"><button class="button" type="button" data-action="rebuild-brain" data-project="${attr(project.id)}" ${state.rebuilding.has(project.id) ? 'disabled' : ''}>${icon('refresh')} ${state.rebuilding.has(project.id) ? 'Rebuilding…' : 'Rebuild from evidence'}</button><button class="button primary" type="button" data-prompt="${attr(projectAskSeed(brain.title || project.title, project.id))}" data-project-context="${attr(project.id)}" data-project-title="${attr(brain.title || project.title)}">${icon('sparkles')} Ask BotBoy</button></div></header><div class="tabs" role="tablist" aria-label="Project sections">${tabs.map(([id, label]) => `<button class="tab ${state.projectTab === id ? 'active' : ''}" type="button" role="tab" aria-selected="${state.projectTab === id}" data-action="project-tab" data-tab="${id}">${esc(label)}</button>`).join('')}</div><div role="tabpanel">${content}</div>`;
  return window.BotBoyLayouts?.renderProject({
    project,
    detail,
    area,
    activeTab: state.projectTab,
    rebuilding: state.rebuilding.has(project.id),
    documentCount: typeof docsCount === 'number' ? docsCount : null,
    artifactCount: typeof artifactCount === 'number' ? artifactCount : null,
    fallbackHtml,
  }) || fallbackHtml;
}

const LEGACY_BRAIN_SUMMARY_LABELS = new Map([
  ['WHAT', 'What'],
  ['SCOPE / COMPONENTS', 'Scope / components'],
  ['METRICS', 'Metrics'],
  ['STATUS', 'Status'],
  ['OWNERSHIP / PEOPLE', 'Ownership / people'],
  ['NEXT ACTIONS', 'Next actions'],
  ['ATTENTION / BLOCKERS', 'Attention / blockers'],
]);

function brainSummaryMarkdown(value) {
  const source = String(value ?? '').trim();
  if (!source || /^\s{0,3}#{1,6}\s+/m.test(source)) return source;

  // Earlier brain summaries used uppercase labels, either inline or separated
  // by blank lines. Upgrade that known shape at display time so existing projects become scannable immediately;
  // the stored evidence-backed text remains unchanged.
  const marker = /(?:^|\s+)(WHAT|SCOPE\s*\/\s*COMPONENTS|METRICS|STATUS|OWNERSHIP\s*\/\s*PEOPLE|NEXT ACTIONS|ATTENTION\s*\/\s*BLOCKERS):\s*/gi;
  const matches = [...source.matchAll(marker)];
  if (matches.length < 2) return source;

  return matches.map((match, index) => {
    const label = match[1].replace(/\s+/g, ' ').toUpperCase();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    let body = source.slice(start, end).trim();
    if (['SCOPE / COMPONENTS', 'METRICS', 'NEXT ACTIONS'].includes(label)
      && (body.startsWith('- ') || /\s+-\s+/.test(body))) {
      body = body
        .replace(/^-\s*/, '')
        .split(/\s+-\s+/)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => `- ${item}`)
        .join('\n');
    }
    return `### ${LEGACY_BRAIN_SUMMARY_LABELS.get(label) || match[1]}\n${body}`;
  }).join('\n\n');
}

function renderBrainSummary(value) {
  const fallback = 'This project brain does not yet contain a summary. Its evidence remains available below.';
  const source = brainSummaryMarkdown(value || fallback);
  if (typeof window.formatMarkdownContent === 'function') {
    // formatMarkdownContent escapes every source fragment before emitting its
    // fixed semantic tag set; Brain.summary never becomes executable HTML.
    return window.formatMarkdownContent(source);
  }
  return `<p>${esc(value || fallback).replace(/\r\n?|\n/g, '<br>')}</p>`;
}

const TASK_STATE_DISPLAY_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 };

// Chronological task display: active states first, newest evidence first
// within each state; undated (legacy) tasks sink below dated ones.
function sortTasksForDisplay(tasks) {
  return [...tasks].sort((a, b) => {
    const stateDelta = (TASK_STATE_DISPLAY_ORDER[a.state] ?? 2) - (TASK_STATE_DISPLAY_ORDER[b.state] ?? 2);
    if (stateDelta !== 0) return stateDelta;
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
}

function taskDateLabel(task) {
  return task.date ? `Evidence from ${task.date}` : 'Brain task';
}

// Brain people entries are free text: real names ("Wenhai Pan"), first names
// ("Shruti"), and groups ("Jagadesh's team"). Initials alone are unreadable, so
// the name is always rendered as text and the disc is decoration only.
const PEOPLE_COLLAPSED_LIMIT = 6;

function personInitials(person) {
  const letters = String(person ?? '')
    .split(/\s+/)
    .map(part => part.replace(/[^\p{L}\p{N}]/gu, '').charAt(0))
    .filter(Boolean);
  return (letters.slice(0, 2).join('') || '?').toUpperCase();
}

function renderPersonChips(people, offset = 0) {
  return people.map((person, index) => `<span class="person-chip" title="${attr(person)}"><span class="avatar" style="background:hsl(${245 + (offset + index) * 31} 37% 46%)" aria-hidden="true">${esc(personInitials(person))}</span><span class="person-name">${esc(person)}</span></span>`).join('');
}

function renderPeopleFactRow(project, people) {
  if (!people.length) return '<div class="fact-row"><span class="fact-label">People</span><span class="fact-value">None recorded</span></div>';
  const expanded = state.expandedPeople.has(project.id);
  const overflow = Math.max(0, people.length - PEOPLE_COLLAPSED_LIMIT);
  const shown = expanded ? people : people.slice(0, PEOPLE_COLLAPSED_LIMIT);
  const toggle = overflow
    ? `<button class="person-chip person-chip-toggle" type="button" data-action="toggle-people" data-project="${attr(project.id)}" aria-expanded="${expanded}">${expanded ? 'Show fewer' : `+${number(overflow)} more`}</button>`
    : '';
  return `<div class="fact-row fact-row-stack"><span class="fact-label">People <span class="fact-count">${number(people.length)}</span></span><div class="people">${renderPersonChips(shown)}${toggle}</div></div>`;
}

// "Ask BotBoy" on a project seeds the composer with that project's name and
// canonical id, caret left at the end. The scope travels in the message the
// owner sends, so nothing is attached invisibly and nothing follows the route:
// what you can read in the input is exactly what BotBoy receives, and you can
// edit or delete it before sending.
const projectAskSeed = (title, id) => `About project ${String(title ?? '').replace(/\s+/g, ' ').trim()} (${id}): `;

// Compact facts rail: one line per fact so the metadata card takes only the
// height it needs, leaving the side column free for related projects.
function renderProjectFactsCard(project, detail, brain, area, people) {
  return `<div class="card facts">
    <div class="fact-row"><span class="fact-label">State</span><span class="pill ${projectTone(project, detail)}">${esc(statusLabel(project))}</span></div>
    <div class="fact-row"><span class="fact-label">Area</span><span class="fact-value">${area ? `<a class="text-link" href="#/areas/${encodeURIComponent(area.id)}">${esc(area.title)} ${icon('arrow-right', 12)}</a>` : 'Unsorted'}</span></div>
    <div class="fact-row"><span class="fact-label">Last change</span><span class="fact-value">${esc(relativeTime(brain.updated || project.updatedAt))}</span></div>
    ${renderPeopleFactRow(project, people)}
  </div>`;
}

// Deterministic sibling links (annotation only). Rendered only when links
// exist; each row navigates to the sibling and carries the strongest reason.
function renderRelatedProjectsCard(project, detail) {
  const related = Array.isArray(detail.relatedProjects) ? detail.relatedProjects : [];
  if (!related.length) return '';
  const rows = related.map(rel => `<div class="related-row">
      <a class="related-link" href="#/projects/${encodeURIComponent(rel.id)}" title="${attr((rel.reasons || []).join(' · '))}">
        <span class="related-title">${esc(rel.title)}</span>
        <span class="related-reason">${esc((rel.reasons && rel.reasons[0]) || 'Scopes touch')}</span>
      </a>
      <button class="related-dismiss" type="button" data-action="dismiss-relation" data-project="${attr(project.id)}" data-other="${attr(rel.id)}" title="Not related — hide this link">${icon('x', 12)}</button>
    </div>`).join('');
  return `<div class="card related-card">
    <div class="related-head">${icon('link', 13)} Related projects</div>
    <p class="related-hint">Distinct projects whose scope touches this one. Updates you expect here may live there.</p>
    ${rows}
  </div>`;
}

function renderProjectBrief(project, detail, area) {
  const brain = detail.brain || {};
  const tasks = sortTasksForDisplay(Array.isArray(brain.tasks) ? brain.tasks.filter(task => task.state !== 'done') : []);
  const blockers = Array.isArray(brain.blockers) ? brain.blockers : [];
  const people = Array.isArray(brain.people) ? brain.people : [];
  return `<section class="grid brain-grid"><article class="card brain-card"><div class="brain-kicker"><strong>${icon('sparkles', 15)} Project brain</strong><span class="pill accent">Synthesized context</span></div><h2>${esc(brain.statusLine || project.oneLiner || project.title)}</h2><div class="brain-summary content-block">${renderBrainSummary(brain.summary)}</div><div class="brain-source">${icon('database', 13)} Synthesized from the project’s connected evidence · source items remain intact</div></article><aside class="side-rail">${renderProjectFactsCard(project, detail, brain, area, people)}${renderRelatedProjectsCard(project, detail)}</aside></section>
    <div class="section-heading"><div><h2>Next actions</h2><p>Explicit open tasks from the project brain, newest evidence first.</p></div></div><section class="grid two-col"><article class="card task-list">${tasks.length ? tasks.slice(0, 8).map(task => projectTaskRow(project, task)).join('') : '<div class="empty-state"><h3>No open actions</h3><p>The current brain has no open task recorded.</p></div>'}</article><article class="card blocker"><div class="eyebrow">${icon(blockers.length ? 'alert' : 'check', 14)} ${blockers.length ? 'Current blockers' : 'Clear path'}</div>${blockers.length ? blockers.map(blocker => `<div><h3>${esc(blocker)}</h3></div>`).join('') : '<h3>No active blocker is recorded.</h3>'}</article></section>
    ${renderAmbientSignals(detail)}
    <div class="section-heading"><div><h2>Recent evidence</h2><p>The source layer underneath this synthesis.</p></div><button class="text-link" type="button" data-action="project-tab" data-tab="evidence">View all ${icon('arrow-right', 13)}</button></div><section class="card evidence-list">${evidenceRows((detail.items || []).slice(0, 5), project)}</section>`;
}

function renderAmbientSignals(detail) {
  const crossLinks = Array.isArray(detail.crossLinks) ? detail.crossLinks : [];
  if (!crossLinks.length) return '';
  return `<div class="section-heading"><div><h2>Ambient signals</h2><p>Related discussion in channels you follow passively. Context only — never treated as project evidence.</p></div></div>
    <section class="card evidence-list">${crossLinks.slice(0, 6).map(link => `<article class="evidence-row"><span class="source-icon">${icon('hash', 15)}</span><div class="evidence-copy"><div class="evidence-title">${esc(link.topic)}</div><p>Recently discussed in #${esc(link.channelName)}.</p><div class="evidence-meta"><span class="pill">ambient</span><span class="pill">${esc(relativeTime(link.createdAt))}</span><a class="text-link" href="#/channels">Open channel digests</a></div></div></article>`).join('')}</section>`;
}

function renderProjectTasks(project, brain) {
  const tasks = sortTasksForDisplay(Array.isArray(brain.tasks) ? brain.tasks : []);
  return `<div class="section-heading" style="margin-top:0"><div><h2>Project actions</h2><p>Tasks are read from the current project brain — active first, newest evidence first. Click a task for actions.</p></div></div><section class="card task-list">${tasks.length ? tasks.map(task => projectTaskRow(project, task)).join('') : '<div class="empty-state"><h3>No tasks recorded</h3><p>BotBoy will show explicit tasks here when the project brain contains them.</p></div>'}</section>`;
}

// ── Clickable task rows (owner feature 2026-08-27): expand for Done/Reopen,
// Discard (two-step arm), and an "Ask BotBoy to help" CTA that seeds the
// chat input with task + project context via the existing data-prompt path.
const taskKeyB64 = text => btoa(unescape(encodeURIComponent(text)));
const taskKeyFromB64 = b64 => decodeURIComponent(escape(atob(b64)));

function projectTaskRow(project, task) {
  const key = `${project.id}::${task.text}`;
  const expanded = state.taskActions.expandedKey === key;
  const busy = state.taskActions.busyKey === key;
  const armed = state.taskActions.discardArmedKey === key;
  const b64 = taskKeyB64(task.text);
  const helpPrompt = `Help me complete this task from project "${project.title}" (${project.id}): "${task.text}". Pull the project brain and related evidence first, lay out the concrete path, then do what you can with your tools — and ask me only for the decisions you can't make yourself.`;
  const actions = expanded ? `<div class="task-actions">${task.state === 'done'
    ? `<button class="button" type="button" data-action="task-set-state" data-project="${attr(project.id)}" data-task-b64="${attr(b64)}" data-state="todo" ${busy ? 'disabled' : ''}>${icon('refresh', 13)} Reopen</button>`
    : `<button class="button" type="button" data-action="task-set-state" data-project="${attr(project.id)}" data-task-b64="${attr(b64)}" data-state="done" ${busy ? 'disabled' : ''}>${icon('check', 13)} Mark done</button>
       <button class="button ${armed ? 'danger' : ''}" type="button" data-action="task-discard" data-project="${attr(project.id)}" data-task-b64="${attr(b64)}" ${busy ? 'disabled' : ''}>${icon('x', 13)} ${armed ? 'Really discard?' : 'Discard'}</button>`}
    <button class="button primary" type="button" data-prompt="${attr(helpPrompt)}">${icon('bot', 13)} Ask BotBoy to help</button>
  </div>` : '';
  return `<div class="task-row ${expanded ? 'expanded' : ''}" data-action="task-toggle" data-task-key="${attr(key)}" role="button" tabindex="0" aria-expanded="${expanded}"><span class="task-state ${task.state === 'done' ? 'done' : ''}">${task.state === 'done' ? icon('check', 12) : ''}</span><span class="task-copy"><strong>${esc(task.text)}</strong><span>${esc(taskDateLabel(task))}</span></span><span class="pill ${task.state === 'blocked' ? 'warn' : task.state === 'done' ? 'good' : task.state === 'doing' ? 'accent' : ''}">${esc(task.state)}</span>${actions}</div>`;
}

async function projectTaskSetState(projectId, taskB64, nextState) {
  const text = taskKeyFromB64(taskB64);
  const key = `${projectId}::${text}`;
  if (state.taskActions.busyKey) return;
  state.taskActions.busyKey = key;
  renderRoute({ preserveScroll: true });
  try {
    const payload = await request(`/projects/${encodeURIComponent(projectId)}/tasks/state`, { method: 'POST', body: { text, state: nextState } });
    toast(payload.message || (nextState === 'done' ? 'Task marked done' : 'Task reopened'), 'good');
    state.taskActions.expandedKey = '';
    state.taskActions.discardArmedKey = '';
    await loadProject(projectId, { renderAfter: false, force: true });
  } catch (error) {
    toast(`Could not update the task: ${error.message}`, 'bad');
  } finally {
    state.taskActions.busyKey = '';
    renderRoute({ preserveScroll: true });
  }
}

async function projectTaskDiscard(projectId, taskB64) {
  const text = taskKeyFromB64(taskB64);
  const key = `${projectId}::${text}`;
  if (state.taskActions.busyKey) return;
  if (state.taskActions.discardArmedKey !== key) {
    // First click arms; the second click within the expanded row confirms.
    state.taskActions.discardArmedKey = key;
    renderRoute({ preserveScroll: true });
    return;
  }
  state.taskActions.busyKey = key;
  renderRoute({ preserveScroll: true });
  try {
    const payload = await request(`/projects/${encodeURIComponent(projectId)}/tasks/remove`, { method: 'POST', body: { text } });
    toast(payload.message || 'Task discarded');
    state.taskActions.expandedKey = '';
    state.taskActions.discardArmedKey = '';
    await loadProject(projectId, { renderAfter: false, force: true });
  } catch (error) {
    toast(`Could not discard the task: ${error.message}`, 'bad');
  } finally {
    state.taskActions.busyKey = '';
    renderRoute({ preserveScroll: true });
  }
}

function evidenceRows(items, project) {
  if (!items.length) return '<div class="empty-state"><h3>No matching evidence</h3><p>The project brain exists, but no evidence rows matched this view.</p></div>';
  return items.map(item => {
    const filePath = item.filePath || item.file_path;
    const rejectControl = project
      ? `<button class="today-control" type="button" data-action="reject-evidence" data-project="${attr(project.id)}" data-item="${attr(item.id)}" title="Reject: remove from this project and never route it back" aria-label="Reject this evidence from the project">${icon('x', 14)}</button><button class="today-control" type="button" data-action="discard-item" data-item="${attr(item.id)}" data-project="${attr(project.id)}" title="Discard: never show this item anywhere" aria-label="Discard this item everywhere">${icon('trash', 14)}</button>`
      : '';
    const scopeAlert = item.scopeAlert && Array.isArray(item.scopeAlert.titles)
      ? (item.scopeAlert.quarantined
        ? `<span class="pill warn" title="This evidence is more strongly anchored to another project (${attr(item.scopeAlert.titles.join(' | '))}). The brain pass quarantined it from synthesis; reject it here or leave it for reference.">${icon('alert', 11)} mixed scope</span>`
        : `<span class="pill" title="This evidence also references another project's scope (${attr(item.scopeAlert.titles.join(' | '))}). It is still synthesized here; review if it feels misplaced.">${icon('alert', 11)} touches other scope</span>`)
      : '';
    // Extraction-tier badge (sharepoint plan §11.5.2: truncation is never
    // silent). Metadata may arrive parsed or as a JSON string depending on
    // the route; both shapes are handled, absence renders nothing.
    let itemMeta = item.metadata;
    if (typeof itemMeta === 'string') { try { itemMeta = JSON.parse(itemMeta); } catch { itemMeta = {}; } }
    const tier = itemMeta?.extractionTier;
    const tierChip = tier === 'truncated'
      ? `<span class="pill" title="Bounded extraction: structure and samples are synced with exact coverage recorded. Ask BotBoy for a deeper read of specific parts.">${icon('alert', 11)} partial content</span>`
      : tier === 'metadata_only'
        ? `<span class="pill" title="Presence only: BotBoy knows this document exists and who changed it, but its content is not synced. Open it in SharePoint for the full document.">${icon('alert', 11)} listed only</span>`
        : '';
    return `<article class="evidence-row"><span class="source-icon">${icon(sourceIcon(item.source, item.type), 15)}</span><div class="evidence-copy"><div class="evidence-title">${esc(item.title || '(untitled evidence)')}</div><p>${esc(item.summary || `${item.type || 'Evidence'} captured from ${item.source || 'an unknown source'}.`)}</p><div class="evidence-meta"><span class="pill">${esc((item.type || 'item').replaceAll('_', ' '))}</span><span class="pill">${esc(item.source || 'unknown')}</span>${tierChip}${scopeAlert}${item.url ? `<a class="text-link" href="${attr(item.url)}" target="_blank" rel="noopener">Open source</a>` : ''}${filePath ? `<a class="text-link" href="#" data-action="reveal" data-path="${attr(filePath)}">Reveal file</a>` : ''}</div></div><div class="today-item-side"><time>${esc(relativeTime(item.capturedAt || item.captured_at))}</time>${rejectControl}</div></article>`;
  }).join('');
}

function rejectedEvidenceSection(project, detail) {
  const rejected = Array.isArray(detail.rejectedItems) ? detail.rejectedItems : [];
  if (!rejected.length) return '';
  return `<div class="section-heading"><div><h2>Rejected evidence</h2><p>Removed by you. These items will never be routed back to this project; restore one to undo.</p></div></div>
    <section class="card evidence-list">${rejected.map(item => `<article class="evidence-row"><span class="source-icon">${icon(sourceIcon(item.source, item.type), 15)}</span><div class="evidence-copy"><div class="evidence-title">${esc(item.title || '(untitled evidence)')}</div><p>${esc(item.summary || 'Rejected evidence item.')}</p><div class="evidence-meta"><span class="pill warn">rejected ${esc(relativeTime(item.rejectedAt))}</span><span class="pill">${esc(item.source || 'unknown')}</span></div></div><div class="today-item-side"><button class="button small" type="button" data-action="restore-evidence" data-project="${attr(project.id)}" data-item="${attr(item.id)}">Restore</button></div></article>`).join('')}</section>`;
}

function renderEvidence(project, items, detail) {
  const filtered = state.evidenceFilter === 'all' ? items : items.filter(item => String(item.source || '').toLowerCase().includes(state.evidenceFilter));
  const sources = [...new Set(items.map(item => String(item.source || '').toLowerCase()).filter(Boolean))].slice(0, 6);
  return `<div class="section-heading" style="margin-top:0"><div><h2>Connected evidence</h2><p>Latest ${number(items.length)} loaded of ${number(project.itemCount)} connected items. Reject anything that does not belong — then rebuild the brain so the synthesis reflects it.</p></div></div><div class="filter-row"><button class="filter-chip ${state.evidenceFilter === 'all' ? 'active' : ''}" type="button" data-action="evidence-filter" data-filter="all">All sources</button>${sources.map(source => `<button class="filter-chip ${state.evidenceFilter === source ? 'active' : ''}" type="button" data-action="evidence-filter" data-filter="${attr(source)}">${esc(source)}</button>`).join('')}</div><section class="card evidence-list">${evidenceRows(filtered, project)}</section>${rejectedEvidenceSection(project, detail || {})}`;
}

// ── Project HTML artifacts: local preview + Harmony attempt composition ─────

async function loadProjectArtifacts(projectId, { force = false } = {}) {
  const existing = state.projectArtifacts.get(projectId);
  if (existing?.loading || (existing?.artifacts && !force)) return;
  state.projectArtifacts.set(projectId, beginProjectArtifactLoad(existing || {}));
  try {
    const payload = await request(`/projects/${encodeURIComponent(projectId)}/artifacts`);
    const current = state.projectArtifacts.get(projectId) || existing || {};
    state.projectArtifacts.set(projectId, completeProjectArtifactLoad(current, payload.artifacts || []));
  } catch (error) {
    const current = state.projectArtifacts.get(projectId) || existing || {};
    state.projectArtifacts.set(projectId, failProjectArtifactLoad(current, String(error?.message || error)));
  }
  if (state.route.view === 'project' && state.route.projectId === projectId && state.projectTab === 'artifacts') {
    renderRoute({ preserveScroll: true });
  }
}

async function loadUnassignedArtifacts(projectId, { force = false } = {}) {
  const existing = state.projectArtifacts.get(projectId);
  if (!existing || existing.unassignedLoading || (existing.unassigned !== null && !force)) return;
  state.projectArtifacts.set(projectId, beginUnassignedArtifactLoad(existing));
  try {
    const payload = await request('/artifacts/unassigned');
    const current = state.projectArtifacts.get(projectId) || existing;
    state.projectArtifacts.set(projectId, completeUnassignedArtifactLoad(current, payload.artifacts || []));
  } catch (error) {
    const current = state.projectArtifacts.get(projectId) || existing;
    state.projectArtifacts.set(projectId, failUnassignedArtifactLoad(current, String(error?.message || error)));
  }
  if (state.route.view === 'project' && state.route.projectId === projectId && state.projectTab === 'artifacts') {
    renderRoute({ preserveScroll: true });
  }
}

function artifactPhaseTone(phase) {
  if (phase === 'published') return 'good';
  if (phase === 'failed_pre_deploy' || phase === 'failed_after_deploy') return 'warn';
  return phase ? 'accent' : '';
}

function renderArtifactAttempt(attempt) {
  return `<li class="project-artifact-attempt"><span class="status-dot ${artifactPhaseTone(attempt.phase)}"></span><span><strong>${esc(documentStateLabel(attempt.phase))}</strong><small>${esc(attempt.publishedAt ? `Published ${relativeTime(attempt.publishedAt)}` : `Started ${relativeTime(attempt.createdAt)}`)} · manifest ${esc(String(attempt.manifestSha256 || '').slice(0, 10))}…</small>${attempt.error ? `<small class="warn">${esc(String(attempt.error).slice(0, 180))}</small>` : ''}</span>${attempt.url ? `<a href="${attr(attempt.url)}" target="_blank" rel="noopener">Open</a>` : ''}</li>`;
}

function renderProjectArtifactCard(artifact, projectId) {
  const local = artifact.local || {};
  const latest = artifact.latestAttempt;
  const live = artifact.latestSuccessful;
  const preview = artifact.screenshot
    ? `<img src="${attr(artifact.screenshot.originalUrl)}" alt="Latest captured preview of ${attr(artifact.fileName)}" loading="lazy">`
    : local.exists
      ? `<iframe src="${attr(local.url)}" title="Preview of ${attr(artifact.fileName)}" sandbox="allow-scripts" loading="lazy" tabindex="-1"></iframe>`
      : `<div class="project-artifact-preview-empty">${icon('file', 26)}<span>Local HTML is unavailable</span></div>`;
  const status = latest
    ? `<span class="pill ${artifactPhaseTone(latest.phase)}">${esc(documentStateLabel(latest.phase))}</span>`
    : '<span class="pill">Local only</span>';
  const attempts = Array.isArray(artifact.attempts) ? artifact.attempts : [];
  const projectOptions = state.projects
    .filter(project => project.status === 'active' || project.status === 'paused')
    .map(project => `<option value="${attr(project.id)}" ${project.id === artifact.projectId ? 'selected' : ''}>${esc(project.title)}</option>`).join('');
  return `<article class="card project-artifact-card" data-artifact-id="${attr(artifact.id)}"><div class="project-artifact-preview">${preview}<span class="project-artifact-format">HTML</span></div><div class="project-artifact-body"><div class="project-artifact-title-row"><div><h3>${esc(artifact.fileName)}</h3><code>${esc(artifact.relativePath)}</code></div>${status}</div><div class="project-artifact-facts"><span>${icon('clock', 11)} ${esc(relativeTime(local.modifiedAt || artifact.updatedAt))}</span>${local.bytes != null ? `<span>${number(local.bytes)} bytes</span>` : ''}${attempts.length ? `<span>${icon('activity', 11)} ${number(attempts.length)} publish attempt${attempts.length === 1 ? '' : 's'}</span>` : ''}</div><div class="project-artifact-actions">${local.exists ? `<a class="button small" href="${attr(local.url)}">${icon('expand', 12)} Open local</a>` : ''}${live?.url ? `<a class="button small primary" href="${attr(live.url)}" target="_blank" rel="noopener">${icon('globe', 12)} Open live</a><button class="button small ghost" type="button" data-action="artifact-copy-link" data-url="${attr(live.url)}">${icon('link', 12)} Copy link</button>` : ''}</div>${attempts.length ? `<details class="project-artifact-history"><summary>Publication history <span>${number(attempts.length)}</span></summary><ol>${attempts.map(renderArtifactAttempt).join('')}</ol></details>` : '<p class="project-artifact-note">Not published to Harmony yet.</p>'}<details class="project-artifact-manage"><summary>Move artifact</summary><div><select data-artifact-project>${projectOptions}</select><button class="button small" type="button" data-action="artifact-assign" data-artifact="${attr(artifact.id)}" data-version="${attr(artifact.version)}">Move</button><button class="button small ghost" type="button" data-action="artifact-unassign" data-artifact="${attr(artifact.id)}" data-version="${attr(artifact.version)}">Unassign</button></div></details>${latest && live && latest.attemptId !== live.attemptId ? `<div class="mcp-alert warn">${icon('alert', 13)}<span>The newest attempt is ${esc(documentStateLabel(latest.phase))}; the live link points to the last fully verified publication.</span></div>` : ''}</div></article>`;
}

function renderProjectArtifacts(projectId) {
  const entry = state.projectArtifacts.get(projectId);
  if (!entry) {
    void loadProjectArtifacts(projectId);
    return '<section class="card"><div class="empty-state"><p>Loading HTML artifacts…</p></div></section>';
  }
  if (entry.loading && !entry.artifacts) return '<section class="card"><div class="empty-state"><p>Loading HTML artifacts…</p></div></section>';
  if (entry.error && !entry.artifacts) return `<section class="card error-state"><h3>Artifacts could not be loaded</h3><p>${esc(entry.error)}</p></section>`;
  const artifacts = entry.artifacts || [];
  const unassigned = entry.unassigned;
  const unassignedItems = unassigned || [];
  const cards = artifacts.length
    ? `<section class="project-artifact-grid">${artifacts.map(artifact => renderProjectArtifactCard(artifact, projectId)).join('')}</section>`
    : `<section class="card"><div class="empty-state"><span class="source-icon">${icon('file', 18)}</span><h3>No attached HTML artifacts</h3><p>HTML created under this project's explicit BotBoy context appears here automatically.</p></div></section>`;
  const attachOpen = entry.attachOpen === true;
  const attachCount = entry.unassignedLoading || unassigned === null ? '…' : number(unassignedItems.length);
  const attachBody = entry.unassignedError
    ? `<div class="mcp-alert warn"><span>${esc(entry.unassignedError)}</span><button class="button small" type="button" data-action="artifact-retry-unassigned" data-project="${attr(projectId)}">Try again</button></div>`
    : entry.unassignedLoading || unassigned === null
    ? '<div class="empty-state"><p>Loading unassigned HTML…</p></div>'
    : unassignedItems.length
      ? `<div class="project-artifact-unassigned">${unassignedItems.map(artifact => `<div><span><strong>${esc(artifact.fileName)}</strong><code>${esc(artifact.relativePath)}</code></span><button class="button small" type="button" data-action="artifact-attach" data-project="${attr(projectId)}" data-artifact="${attr(artifact.id)}" data-version="${attr(artifact.version)}" ${state.artifactAssignmentPending.has(artifact.id) ? 'disabled' : ''}>${state.artifactAssignmentPending.has(artifact.id) ? 'Attaching…' : 'Attach'}</button></div>`).join('')}</div>`
      : '<div class="empty-state"><p>No unassigned HTML files.</p></div>';
  const unassignedBlock = `<details class="card project-artifact-attach" ${attachOpen ? 'open' : ''}><summary><span>${icon('plus', 14)} Attach existing HTML</span><span class="pill">${attachCount}</span></summary>${attachBody}</details>`;
  return `<div class="section-heading" style="margin-top:0"><div><h2>HTML artifacts</h2><p>Local demos and their exact Harmony publication attempts. Creation remains conversational; this tab is the stable discovery space.</p></div><span class="pill accent">${number(artifacts.length)}</span></div>${cards}${unassignedBlock}`;
}

async function assignProjectArtifact(artifactId, projectId, expectedVersion) {
  if (!artifactId || state.artifactAssignmentPending.has(artifactId)) return;
  state.artifactAssignmentPending.add(artifactId);
  if (state.route.view === 'project' && state.projectTab === 'artifacts') renderRoute({ preserveScroll: true, userAction: true });
  try {
    await request(`/artifacts/${encodeURIComponent(artifactId)}/assignment`, {
      method: 'PATCH', body: { projectId, expectedVersion },
    });
    state.projectArtifacts.clear();
    toast(projectId ? 'Artifact attached to project.' : 'Artifact unassigned.');
    if (state.route.view === 'project') await loadProjectArtifacts(state.route.projectId, { force: true });
  } catch (error) {
    toast(`Could not update artifact: ${error.message}`, 'warn');
    if (/HTTP 409|changed/i.test(String(error?.message || error))) {
      const currentProjectId = state.route.view === 'project' ? state.route.projectId : '';
      state.projectArtifacts.delete(currentProjectId);
      if (currentProjectId) await loadProjectArtifacts(currentProjectId, { force: true });
    }
  } finally {
    state.artifactAssignmentPending.delete(artifactId);
    if (state.route.view === 'project' && state.projectTab === 'artifacts') renderRoute({ preserveScroll: true, userAction: true });
  }
}

// ── Document workbench: project Documents tab + reader (#/doc/<id>) ────────
// Boundary: this is the SharePoint evidence world. The #/documents route and
// state.documents belong to the product-manager writing workspace.

// Unicode-safe base64url for docKeys in hashes.
function encodeDocKey(key) {
  return btoa(unescape(encodeURIComponent(String(key)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeDocKey(id) {
  try { return decodeURIComponent(escape(atob(String(id).replace(/-/g, '+').replace(/_/g, '/')))); } catch { return ''; }
}

function tierChip(tier) {
  if (tier === 'truncated') return '<span class="pill warn" title="Bounded extraction — metadata.truncation records what was cut">partial content</span>';
  if (tier === 'metadata_only') return '<span class="pill" title="Presence only — content not synced at this size tier">listed only</span>';
  return '';
}

async function loadProjectDocuments(projectId, { force = false } = {}) {
  const existing = state.projectDocuments.get(projectId);
  if (existing?.loading || (existing?.documents && existing?.authoredDocuments && !force)) return;
  state.projectDocuments.set(projectId, {
    documents: existing?.documents ?? null,
    authoredDocuments: existing?.authoredDocuments ?? null,
    publications: existing?.publications ?? [],
    stagedCreations: existing?.stagedCreations ?? [],
    loading: true,
    error: '',
  });
  try {
    const payload = await request(`/projects/${encodeURIComponent(projectId)}/documents`);
    state.projectDocuments.set(projectId, {
      documents: payload.documents || [],
      authoredDocuments: documentSummariesFromPayload(payload.authoredDocuments || []),
      publications: payload.publications || [],
      stagedCreations: payload.stagedCreations || [],
      loading: false,
      error: '',
    });
  } catch (error) {
    state.projectDocuments.set(projectId, {
      documents: existing?.documents ?? null,
      authoredDocuments: existing?.authoredDocuments ?? null,
      publications: existing?.publications ?? [],
      stagedCreations: existing?.stagedCreations ?? [],
      loading: false,
      error: String(error?.message || error),
    });
  }
  if (state.route.view === 'project' && state.route.projectId === projectId) renderRoute({ preserveScroll: true });
}

function renderProjectDocuments(projectId) {
  const entry = state.projectDocuments.get(projectId);
  if (!entry || (entry.loading && !entry.documents && !entry.authoredDocuments)) {
    if (!entry) void loadProjectDocuments(projectId);
    return '<section class="card"><div class="empty-state"><p>Loading documents…</p></div></section>';
  }
  if (entry.error && !entry.documents && !entry.authoredDocuments) {
    return `<section class="card error-state"><span class="source-icon">${icon('alert', 18)}</span><h3>Documents could not be loaded</h3><p>${esc(entry.error)}</p></section>`;
  }
  const docs = entry.documents || [];
  const owningProject = projectById(projectId);
  const publicationProjectBlocked = Boolean(owningProject && owningProject.status !== 'active' && owningProject.status !== 'paused');
  const publications = entry.publications || [];
  const authoredDocuments = entry.authoredDocuments || [];
  const authoredChains = buildDocumentLibraryView(authoredDocuments, { sort: 'recent' });
  // Staged publications: exact artifact actions that reach SharePoint only
  // after Approve + Sync here. The typed publication action—not origin copy—
  // decides whether Sync creates a copy or versions an existing exact target.
  const creations = entry.stagedCreations || [];
  const creationBlock = creations.length ? `
    <div class="section-heading"><div><h2>Awaiting publication</h2><p>Exact SharePoint create/update actions. Nothing is complete until guarded upload, exact-byte verification, and capture linkage succeed.</p></div><span class="pill blue">${creations.length}</span></div>
    <section class="card pad">${creations.map(creation => {
    const statusTone = { pending: '', approved: 'blue', conflicted: 'warn' }[creation.status] || '';
    const canRender = typeof window.formatMarkdownContent === 'function';
    const isUpdate = creation.publicationAction === 'update_existing';
    const cardBusy = publicationProjectBlocked || publicationOperationBusy(creation.sourceArtifactId, creation.id, creation.docKey);
    const actionLabel = isUpdate ? 'Update existing SharePoint version' : 'Create new SharePoint copy';
    return `<article style="display:flex; flex-direction:column; gap:8px; padding:10px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <strong>${esc(creation.fileName)}</strong>
          <span class="pill ${statusTone}">${esc(creation.status)}</span>
          <span class="pill ${isUpdate ? 'accent' : ''}">${icon(isUpdate ? 'refresh' : 'plus', 10)} ${esc(actionLabel)}</span>
          ${creation.publicationStatus ? `<span class="pill blue">${icon('link', 10)} ${esc(documentStateLabel(creation.publicationStatus))}</span>` : ''}
          ${creation.sourceArtifactId ? `<a href="#/documents/${encodeURIComponent(creation.sourceArtifactId)}" class="document-project-link">Official source</a>` : ''}
          ${creation.originNote ? `<span style="color:var(--muted); font-size:11.5px;">${esc(creation.originNote)}</span>` : ''}
        </div>
        <span style="color:var(--muted); font-size:11px;">→ ${esc(creation.serverRelativeUrl)}</span>
        ${creation.remoteObservedAt ? `<span style="color:var(--muted); font-size:11px;">Approved remote snapshot ${esc(relativeTime(creation.remoteObservedAt))}${creation.expectedRemoteItemId ? ` · item ${esc(creation.expectedRemoteItemId)}` : ''}${creation.expectedRemoteSha256 ? ` · SHA ${esc(String(creation.expectedRemoteSha256).slice(0, 12))}…` : ''}</span>` : ''}
        ${creation.conflictReason ? `<div class="mcp-alert warn">${icon('alert', 13)}<span>${esc(creation.conflictReason)}</span></div>` : ''}
        <details class="document-findings"><summary>Preview draft</summary>
          ${canRender ? `<div class="content-block fpv-md" style="padding:8px 2px;">${window.formatMarkdownContent(creation.createContent || '')}</div>` : `<pre class="fpv-pre">${esc(creation.createContent || '')}</pre>`}
        </details>
        <div style="display:flex; gap:6px;">
          ${creation.status === 'pending' ? `
            <button class="button small primary" type="button" data-action="creation-decide" data-id="${attr(creation.id)}" data-decision="approve" data-project="${attr(projectId)}" data-artifact="${attr(creation.sourceArtifactId || '')}" data-update="${isUpdate ? 'true' : 'false'}" ${cardBusy ? 'disabled' : ''}>Approve</button>
            <button class="button small" type="button" data-action="creation-decide" data-id="${attr(creation.id)}" data-decision="reject" data-project="${attr(projectId)}" data-artifact="${attr(creation.sourceArtifactId || '')}" data-update="${isUpdate ? 'true' : 'false'}" ${cardBusy ? 'disabled' : ''}>Reject</button>` : ''}
          ${creation.status === 'conflicted' ? `
            <button class="button small" type="button" data-action="creation-decide" data-id="${attr(creation.id)}" data-decision="reject" data-project="${attr(projectId)}" data-artifact="${attr(creation.sourceArtifactId || '')}" data-update="${isUpdate ? 'true' : 'false'}" data-conflict="true" ${cardBusy ? 'disabled' : ''}>Dismiss conflict</button>` : ''}
          ${creation.status === 'approved' && (!creation.publicationStatus || creation.publicationStatus === 'approved') ? `
            <button class="button small primary" type="button" data-action="creation-sync" data-dockey="${attr(creation.docKey)}" data-project="${attr(projectId)}" data-artifact="${attr(creation.sourceArtifactId || '')}" data-update="${isUpdate ? 'true' : 'false'}" ${cardBusy ? 'disabled' : ''}>${icon('refresh', 12)} ${isUpdate ? 'Update SharePoint version' : 'Create SharePoint copy'}</button>` : ''}
        </div>
      </article>`;
  }).join('')}</section>` : '';

  const authoredBlock = authoredChains.length ? `
    <div class="section-heading"><div><h2>Authored in BotBoy</h2><p>Canonical project documents and their immutable revision chains. Open a document to review, revise, export, or publish it.</p></div><span class="pill accent">${authoredChains.length}</span></div>
    <section class="card evidence-list project-authored-documents">${authoredChains.map(chain => {
    const document = chain.head;
    const versionCount = chain.members.length;
    const chainArtifactIds = new Set(chain.members.map(version => version.artifactId));
    const chainPublications = publications.filter(publication => chainArtifactIds.has(publication.artifactId));
    const currentPublication = chainPublications.find(publication => publication.artifactId === document.artifactId) || null;
    const completedLocations = chainPublications
      .filter(publication => publication.status === 'complete' && publication.capturedWorkItemId)
      .filter((publication, index, all) => all.findIndex(candidate => candidate.docKey === publication.docKey) === index);
    const olderCompleted = completedLocations.find(publication => publication.artifactId !== document.artifactId) || null;
    const latestPublication = currentPublication || chainPublications[0] || null;
    const publicationTone = currentPublication?.status === 'complete'
      ? 'good'
      : currentPublication?.status === 'verification_failed'
        || currentPublication?.status === 'capture_failed'
        || currentPublication?.status === 'identity_mismatch'
        || currentPublication?.status === 'target_conflict'
          ? 'warn'
          : currentPublication ? 'blue' : olderCompleted ? 'warn' : '';
    const publicationLabel = currentPublication
      ? currentPublication.status === 'complete'
        ? 'Current version published'
        : `Current publication ${documentStateLabel(currentPublication.status)}`
      : olderCompleted
        ? 'Older version published · current version local'
        : latestPublication
          ? `Publication ${documentStateLabel(latestPublication.status)}`
          : '';
    const publishedLocations = completedLocations.map(publication =>
      `<a class="project-publication-link" href="#/doc/${encodeDocKey(publication.docKey)}" title="${attr(publication.serverRelativeUrl)}">${icon('link', 10)} ${publication.artifactId === document.artifactId ? 'Current published copy' : 'Older published copy'}</a>`
    ).join('');
    return `<article class="evidence-row project-authored-row">
      <span class="source-icon project-authored-icon">${icon('file', 16)}</span>
      <a class="today-item-copy" href="#/documents/${encodeURIComponent(document.artifactId)}" style="min-width:0; flex:1;">
        <strong style="font-size:13px;">${esc(document.title)}</strong>
        <span class="evidence-meta" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:3px;">
          <span class="pill accent">BotBoy original</span>
          <span class="pill">${icon('activity', 10)} ${versionCount} loaded version${versionCount === 1 ? '' : 's'}</span>
          <span class="pill ${documentStateTone(document.state)}">${esc(documentStateLabel(document.state))}</span>
          ${publicationLabel ? `<span class="pill ${publicationTone}">${icon('link', 10)} ${esc(publicationLabel)}</span>` : ''}
          ${publishedLocations}
          <span>${esc(documentProfileLabel(document.profileId))}</span>
          <time>${esc(relativeTime(document.createdAt))}</time>
        </span>
      </a>
      <a class="button small" href="#/documents/${encodeURIComponent(document.artifactId)}">Open</a>
    </article>`;
  }).join('')}</section>` : '';

  if (!docs.length && !creations.length && !authoredChains.length) {
    return `<section class="card"><div class="empty-state today-empty"><span class="source-icon">${icon('file', 18)}</span><h3>No project documents yet</h3><p>Authored BotBoy documents and SharePoint references filed to this project appear here.</p></div></section>`;
  }
  if (!docs.length) return `${authoredBlock}${creationBlock}`;
  const rows = docs.map(doc => {
    const readerHref = `#/doc/${encodeDocKey(doc.docKey)}`;
    const ext = String(doc.fileType || '').replace('.', '').toLowerCase() || 'doc';
    const extColor = { docx: '#4a8cd4', xlsx: '#3f9e6a', pptx: '#d47b3f', pdf: '#c95555', md: '#8b7fd4', txt: '#8b8f98', csv: '#3f9e6a' }[ext] || '#8b8f98';
    const unresolved = Math.max(0, (doc.commentCount || 0) - (doc.resolvedCommentCount || 0));
    const commentBits = doc.commentCount
      ? `<span class="pill ${unresolved ? 'warn' : ''}" title="${doc.commentCount} comments, ${unresolved} open">${icon('message', 11)} ${doc.commentCount}${unresolved ? ` · ${unresolved} open` : ''}</span>`
      : '<span class="pill" style="opacity:.55">no comments</span>';
    return `<article class="evidence-row" style="align-items:flex-start; gap:12px;">
      <span style="display:inline-flex; align-items:center; justify-content:center; min-width:42px; padding:4px 7px; margin-top:2px; border-radius:7px; background:${extColor}22; color:${extColor}; font-size:10px; font-weight:750; letter-spacing:.05em; text-transform:uppercase; border:1px solid ${extColor}44;">${esc(ext)}</span>
      <a class="today-item-copy" href="${readerHref}" style="min-width:0; flex:1;">
        <strong style="font-size:13px;">${esc(doc.title || doc.docKey)}</strong>
        ${doc.latestChangeSummary ? `<span class="today-change-summary" style="font-style:italic;">${esc(String(doc.latestChangeSummary).slice(0, 160))}</span>` : ''}
        <span class="evidence-meta" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:3px;">
          ${tierChip(doc.extractionTier)}
          <span class="pill">${icon('activity', 10)} ${doc.revisionCount} rev${doc.revisionCount === 1 ? '' : 's'}</span>
          ${commentBits}
          ${doc.relatedCount ? `<span class="pill" title="${doc.relatedCount} related document(s) in the corpus">${icon('link', 10)} ${doc.relatedCount}</span>` : ''}
          ${doc.sizeBytes ? `<span class="pill" style="opacity:.7">${doc.sizeBytes > 1024 * 1024 ? `${Math.round(doc.sizeBytes / 1024 / 1024)} MB` : `${Math.round(doc.sizeBytes / 1024)} KB`}</span>` : ''}
          <time style="color:var(--muted); font-size:11px;">${esc(relativeTime(doc.lastModified || doc.lastCapturedAt))}</time>
        </span>
      </a>
      <a class="button small" href="${esc(String(doc.webUrl || '#'))}" target="_blank" rel="noopener noreferrer" style="flex:0 0 auto;">SharePoint</a>
    </article>`;
  }).join('');
  return `${authoredBlock}${creationBlock}
    <div class="section-heading"><div><h2>External & reference</h2><p>SharePoint documents routed here independently. Open them for synced content, comments, and remote revision history.</p></div><span class="pill">${docs.length}</span></div>
    <section class="card evidence-list">${rows}</section>`;
}

async function loadDocReader(docKey, { force = false } = {}) {
  if (state.docReader.loading) return;
  if (!force && state.docReader.key === docKey && state.docReader.data) return;
  // Comment filter and assist state survive same-doc reloads (sync/refresh)
  // but reset on a different document. editMode is deliberately DROPPED — a
  // same-doc force reload means content may have changed under the draft;
  // the edit-save baseSha guard makes a stale save fail loud anyway
  // (DOC_EDITOR_UX_PLAN.md second-pass carry policy). The assist proposal's
  // approve payload is content-anchored (editShape from assist time), so
  // carrying it across a reload stays safe — apply-time matching is final.
  const commentFilter = state.docReader.key === docKey ? state.docReader.commentFilter : undefined;
  const assist = state.docReader.key === docKey ? state.docReader.assist : undefined;
  state.docReader = { key: docKey, data: force ? state.docReader.data : null, error: '', loading: true, refreshing: state.docReader.refreshing, commentFilter, assist };
  try {
    const payload = await request(`/documents/view?docKey=${encodeURIComponent(docKey)}`);
    state.docReader = { key: docKey, data: payload, error: '', loading: false, refreshing: false, commentFilter, assist };
  } catch (error) {
    state.docReader = { key: docKey, data: state.docReader.data, error: String(error?.message || error), loading: false, refreshing: false, commentFilter, assist };
  }
  if (state.route.view === 'doc-reader') renderRoute({ preserveScroll: true });
}

// Live sheet reads for .xlsx docs (xlsx-deep-reads X2): chips above the
// content switch between the bounded synced overview and per-sheet live
// tables fetched on demand.
async function loadDocSheet(docKey, sheet) {
  state.docReader.sheetView = { name: sheet, loading: true, data: null, error: '' };
  // Sheet chips are click-only entry points, so both paints are the user's.
  renderRoute({ preserveScroll: true, userAction: true });
  try {
    const payload = await request(`/documents/sheet?docKey=${encodeURIComponent(docKey)}${sheet ? `&sheet=${encodeURIComponent(sheet)}` : ''}`);
    state.docReader.sheetView = { name: sheet, loading: false, data: payload, error: '' };
  } catch (error) {
    state.docReader.sheetView = { name: sheet, loading: false, data: null, error: String(error?.message || error) };
  }
  if (state.route.view === 'doc-reader') renderRoute({ preserveScroll: true, userAction: true });
}

function sheetTableHtml(view) {
  if (view.loading) return `<div class="empty-state today-empty"><p>Reading “${esc(view.name)}” from SharePoint…</p></div>`;
  if (view.error) return `<div class="mcp-alert warn">${icon('alert', 14)}<span>${esc(view.error)}</span></div>`;
  const sheet = view.data?.sheet;
  if (!sheet) return `<div class="empty-state today-empty"><p>No cell data returned.</p></div>`;
  const DISPLAY_CAP = 500;
  const rows = sheet.rows.slice(0, DISPLAY_CAP);
  const notes = [
    `live sheet read — as of ${relativeTime(view.data.asOf)}${view.data.fromCache ? ' (cached for this version)' : ''}`,
    sheet.truncation.rowsCut ? `showing first ${sheet.rows.length} of ${sheet.rowsTotal ?? '?'} rows` : '',
    sheet.rows.length > DISPLAY_CAP ? `rendering first ${DISPLAY_CAP} fetched rows` : '',
    sheet.truncation.sharedStringsBudgetHit ? 'some cells blank: string-table budget' : '',
    sheet.formulaCells ? `${sheet.formulaCells} formula cell(s) show cached values` : '',
  ].filter(Boolean).join(' · ');
  const body = rows.map((row, index) => `<tr>${row.map(cell => index === 0
    ? `<th style="position:sticky; top:0; background:var(--surface-2); text-align:left; padding:5px 9px; border-bottom:1px solid var(--border-strong); font-size:11px;">${esc(cell)}</th>`
    : `<td style="padding:4px 9px; border-bottom:1px solid var(--border); font-size:11.5px; white-space:nowrap;">${esc(cell)}</td>`).join('')}</tr>`).join('');
  return `<div style="display:flex; flex-direction:column; gap:8px;">
    <span style="color:var(--muted); font-size:11px;">${esc(notes)}</span>
    <div data-scroll-key="doc-reader:sheet:${attr(view.name)}" style="overflow:auto; max-height:70vh; border:1px solid var(--border); border-radius:9px;"><table style="border-collapse:collapse; width:max-content; min-width:100%;">${body}</table></div>
  </div>`;
}

function readerCommentThreads(comments) {
  const roots = new Map(); // threadRoot → comments in order
  for (const comment of comments) {
    const list = roots.get(comment.threadRoot);
    if (list) list.push(comment); else roots.set(comment.threadRoot, [comment]);
  }
  // Newest thread activity first.
  return [...roots.values()].sort((a, b) => String(b[b.length - 1].commentedAt).localeCompare(String(a[a.length - 1].commentedAt)));
}

function readerCommentHtml(comment) {
  const who = comment.direction === 'sent' ? `<strong>${esc(comment.author)}</strong> <span class="pill accent">you</span>` : `<strong>${esc(comment.author)}</strong>`;
  // Anchored passage (extracted from the docx comment ranges): quoted, and
  // clickable — jumps to and highlights the passage in the content pane.
  const anchor = comment.anchorText
    ? `<blockquote data-action="doc-comment-jump" data-anchor="${attr(comment.anchorText)}" title="Jump to this passage in the document" style="margin:4px 0; padding:5px 9px; border-left:2px solid var(--accent); border-radius:0 7px 7px 0; background:var(--surface-2); font-size:11px; font-style:italic; cursor:pointer; color:var(--soft);">“${esc(String(comment.anchorText).slice(0, 120))}”</blockquote>`
    : '';
  return `<div class="doc-annotation ${comment.resolved ? 'resolved' : ''} ${comment.parentCommentId ? 'reply' : ''}" style="${comment.parentCommentId ? 'margin-left:18px;' : ''}${comment.deletedFromDoc ? 'opacity:.55;' : ''}">
    <div class="doc-annotation-head">${who}${comment.mentionedMe ? ' <span class="pill warn">mentions you</span>' : ''}${comment.resolved ? ' <span class="pill">resolved</span>' : ''}${comment.deletedFromDoc ? ' <span class="pill" title="This comment no longer exists in the live document — kept as history">removed from doc</span>' : ''}</div>
    ${comment.parentCommentId ? '' : anchor}
    <p class="doc-annotation-summary">${esc(String(comment.text || '').slice(0, 500))}</p>
    <span class="doc-annotation-meta">${esc(relativeTime(comment.commentedAt))}</span>
  </div>`;
}

/** Scroll to and flash the comment's passage inside the reader content. */
function jumpToDocPassage(anchorText) {
  const container = document.querySelector('.document-preview-shell');
  if (!container || !anchorText) return false;
  // Probe ladder: try the fullest passage first, then progressively shorter
  // prefixes — anchors cross block boundaries that render differently, but
  // the passage START is almost always intact in the markdown.
  const squashed = String(anchorText).replace(/…$/, '').replace(/\s+/g, ' ').trim();
  const probes = [squashed.slice(0, 80), squashed.slice(0, 40), squashed.slice(0, 24)].filter(p => p.length >= 12);
  if (!probes.length) return false;
  // Walk text nodes with a squashed-offset map so passages split across
  // inline elements still match.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let joined = '';
  let node;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: joined.length });
    joined += String(node.nodeValue || '').replace(/\s+/g, ' ');
  }
  const haystack = joined.toLowerCase();
  let at = -1;
  for (const probe of probes) {
    at = haystack.indexOf(probe.toLowerCase());
    if (at !== -1) break;
  }
  if (at === -1) return false;
  const hit = [...nodes].reverse().find(entry => entry.start <= at);
  if (!hit) return false;
  const el = hit.node.parentElement;
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = el.style.transition;
  el.style.transition = 'background-color .3s';
  el.style.backgroundColor = 'rgba(157,140,255,.28)';
  setTimeout(() => { el.style.backgroundColor = ''; el.style.transition = prev; }, 2200);
  return true;
}

// Markdown → blank-line blocks, ``` fences respected. DUPLICATE of core
// markdown-anchor.ts › markdownBlocksOf (dashboard.js cannot import core TS;
// the workbench map pairs the implementations). Used for per-block render
// stamping (E3 selection mapping) and range preview splicing.
function mdBlocksUi(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let current = [];
  let inFence = false;
  const flush = () => {
    while (current.length && current[current.length - 1].trim() === '') current.pop();
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') { flush(); continue; }
    current.push(line);
  }
  flush();
  return blocks;
}

// Markdown line → docx paragraph text (strip heading/list/inline markers,
// squash whitespace). DUPLICATE of core markdown-anchor.ts ›
// markdownLineToDocxText — dashboard.js cannot import core TS; the workbench
// map pairs the two implementations as an invariant.
function mdLineToDocxTextUi(line) {
  let text = String(line ?? '');
  text = text.replace(/^\s{0,3}#{1,6}\s+/, '');
  text = text.replace(/^\s{0,3}(?:[-*•]|\d+[.)])\s+/, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/(^|[^\w\\])_([^_]+)_(?=\W|$)/g, '$1$2');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

// Staged-preview content for the reader (E2/E3): the synced extraction with
// pending+approved edits applied. ONE implementation shared by render and
// the selection handler so block indexes always agree.
function docPreviewContent(data) {
  let previewContent = (data && data.content) || '';
  let previewApplied = 0;
  for (const edit of (Array.isArray(data?.pendingEdits) ? data.pendingEdits : [])) {
    if (edit.status !== 'pending' && edit.status !== 'approved') continue;
    if (edit.operation === 'replaceText' && edit.findText && previewContent.includes(edit.findText)) {
      previewContent = previewContent.replace(edit.findText, edit.replaceWith || '');
      previewApplied++;
    } else if (edit.operation === 'appendParagraphs' && Array.isArray(edit.paragraphs) && edit.paragraphs.length) {
      previewContent = `${previewContent}\n\n${edit.paragraphs.join('\n\n')}`;
      previewApplied++;
    } else if (edit.operation === 'replaceParagraphRange' && Array.isArray(edit.paragraphs) && edit.paragraphs.length) {
      const spliced = spliceParagraphRangePreview(previewContent, edit.paragraphs, edit.replaceWith || '');
      if (spliced !== null) { previewContent = spliced; previewApplied++; }
    }
  }
  return { previewContent, previewApplied };
}

// Preview-reflect for replaceParagraphRange: anchors are docx-text form, so
// match against marker-STRIPPED lines; splice the replacement markdown over
// the matched line span. Null = not previewable here (anchor drifted or
// ambiguous) — the old/new blocks in the lane stay authoritative.
function spliceParagraphRangePreview(markdown, anchorParagraphs, replacementMarkdown) {
  const anchors = anchorParagraphs.map(a => String(a).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!anchors.length) return null;
  const lines = String(markdown).split('\n');
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = mdLineToDocxTextUi(lines[i]);
    if (stripped) candidates.push({ lineIdx: i, stripped });
  }
  const hits = [];
  for (let i = 0; i + anchors.length <= candidates.length; i++) {
    if (anchors.every((anchor, k) => candidates[i + k].stripped === anchor)) {
      hits.push({ from: candidates[i].lineIdx, to: candidates[i + anchors.length - 1].lineIdx });
    }
  }
  if (hits.length !== 1) return null;
  const { from, to } = hits[0];
  const replacementLines = replacementMarkdown.trim() ? replacementMarkdown.split('\n') : [];
  const before = lines.slice(0, from);
  let after = lines.slice(to + 1);
  if (replacementLines.length === 0 && after.length && after[0].trim() === '') after = after.slice(1);
  return [...before, ...replacementLines, ...after].join('\n');
}

// Inline proposal card (E3): rendered INSIDE the content flow, after the
// selection's last block. Approve stages pre-approved; Reject is ephemeral.
function assistProposalCardHtml(assist) {
  const rendered = typeof window.formatMarkdownContent === 'function' && assist.replacementMarkdown
    ? `<div class="fpv-md">${window.formatMarkdownContent(assist.replacementMarkdown)}</div>`
    : (assist.replacementMarkdown ? `<pre class="fpv-pre">${esc(assist.replacementMarkdown)}</pre>` : '');
  const body = assist.replacementMarkdown
    ? `<div class="doc-assist-card-body${assist.expanded ? ' expanded' : ''}">${rendered}</div>`
    : `<div class="doc-assist-card-body"><p style="color:var(--muted); margin:4px 0;">BotBoy proposes REMOVING the selected passage.</p></div>`;
  return `<div class="doc-assist-card">
    <div class="doc-assist-card-head">${icon('sparkles', 13)} <strong>BotBoy — proposed replacement</strong><span class="doc-annotation-meta">${esc(String(assist.instruction || '').slice(0, 80))}</span></div>
    ${body}
    <div class="doc-assist-card-actions">
      <button class="button small primary" type="button" data-action="assist-approve">Approve — stage for sync</button>
      <button class="button small" type="button" data-action="assist-reject">Reject</button>
      ${assist.replacementMarkdown && String(assist.replacementMarkdown).split('\n').length > 14 ? `<button class="button small" type="button" data-action="assist-expand">${assist.expanded ? 'Collapse' : 'Expand'}</button>` : ''}
      <span style="font-size:11px; color:var(--muted)">Approving replaces the highlighted passage in the staged copy.</span>
    </div>
  </div>`;
}

// Floating pill + anchored dialog (E3), fixed-positioned from the selection
// rect captured at mouseup. State-driven — survives background repaints.
function assistOverlayHtml(assist) {
  if (!assist || !assist.rect) return '';
  const rect = assist.rect;
  const top = Math.max(8, rect.bottom + 6);
  const left = Math.max(8, Math.min(rect.left, (window.innerWidth || 1200) - 380));
  if (assist.phase === 'pill') {
    return `<button class="doc-assist-pill" type="button" data-action="assist-pill" style="top:${top}px; left:${left}px;">${icon('sparkles', 12)} Ask BotBoy to edit</button>`;
  }
  if (assist.phase === 'dialog' || assist.phase === 'running' || assist.phase === 'error') {
    const running = assist.phase === 'running';
    return `<div class="doc-assist-dialog" style="top:${top}px; left:${left}px;">
      <div class="doc-assist-dialog-head">${icon('sparkles', 13)} <strong>Ask BotBoy to edit</strong><span class="doc-annotation-meta">${assist.blockEnd > assist.blockStart ? `${assist.blockEnd - assist.blockStart + 1} blocks selected` : 'selection'}</span></div>
      <blockquote class="doc-assist-quote">${esc(String(assist.selectedText || '').slice(0, 160))}${String(assist.selectedText || '').length > 160 ? '…' : ''}</blockquote>
      <textarea id="doc-assist-instruction" class="input" rows="3" placeholder="What should BotBoy do with this text? (e.g. make it crisper, expand with rollout details, turn into bullets)" ${running ? 'disabled' : ''}>${esc(assist.instruction || '')}</textarea>
      ${assist.phase === 'error' ? `<div class="mcp-alert warn" style="margin:6px 0;">${icon('alert', 13)}<span>${esc(assist.error || 'something went wrong')}</span></div>` : ''}
      <div class="doc-assist-dialog-actions">
        ${running
          ? `<span class="doc-assist-running">${icon('refresh', 13)} BotBoy is reading the project and drafting… this can take a minute or two.</span>`
          : `<button class="button small primary" type="button" data-action="assist-send">Send to BotBoy</button>`}
        <button class="button small" type="button" data-action="assist-cancel">Cancel</button>
      </div>
    </div>`;
  }
  return '';
}

function pendingEditBlock(edit) {
  const statusTone = { pending: '', approved: 'blue', synced: 'good', conflicted: 'warn', rejected: '' }[edit.status] || '';
  const blockShell = (tone, label, inner) =>
    `<div style="border-left:3px solid ${tone}; padding:6px 10px; margin:6px 0; background:var(--surface-2); border-radius:0 8px 8px 0;"><small style="color:var(--muted)">${label}</small>${inner}</div>`;
  const red = 'var(--red,#e5484d)';
  const green = 'var(--green,#46a758)';
  const isRange = edit.operation === 'replaceParagraphRange';
  const rangeAnchors = isRange ? (edit.paragraphs || []) : [];
  const rangeOld = isRange
    ? blockShell(red, `current paragraph${rangeAnchors.length === 1 ? '' : 's'} (${rangeAnchors.length})`,
        rangeAnchors.slice(0, 2).map(a => `<div>${esc(a)}</div>`).join('')
        + (rangeAnchors.length > 2 ? `<div style="color:var(--muted); font-size:11px;">… ${rangeAnchors.length - 2} more paragraph${rangeAnchors.length - 2 === 1 ? '' : 's'}</div>` : ''))
    : '';
  const rangeNew = isRange
    ? (String(edit.replaceWith || '').trim()
        ? blockShell(green, 'replacement', typeof window.formatMarkdownContent === 'function'
            ? `<div class="fpv-md">${window.formatMarkdownContent(String(edit.replaceWith))}</div>`
            : `<div>${esc(String(edit.replaceWith))}</div>`)
        : blockShell(red, 'removal', `<div style="color:var(--muted)">removes ${rangeAnchors.length} paragraph${rangeAnchors.length === 1 ? '' : 's'} — no replacement</div>`))
    : '';
  const oldBlock = isRange ? rangeOld : edit.operation === 'replaceText'
    ? blockShell(red, 'current text', `<div>${esc(edit.findText || '')}</div>`)
    : '';
  const newBlock = isRange ? rangeNew : edit.operation === 'replaceText'
    ? blockShell(green, 'replacement', `<div>${esc(edit.replaceWith || '')}</div>`)
    : blockShell(green, 'append at end', (edit.paragraphs || []).map(p => `<div>${esc(p)}</div>`).join(''));
  const controls = edit.status === 'pending'
    ? `<div class="today-item-actions"><button class="button small primary" type="button" data-action="doc-edit-decide" data-id="${attr(edit.id)}" data-decision="approve">Approve</button><button class="button small" type="button" data-action="doc-edit-decide" data-id="${attr(edit.id)}" data-decision="reject">Reject</button></div>`
    : edit.status === 'conflicted'
      ? `<div class="today-item-actions"><button class="button small" type="button" data-action="doc-edit-decide" data-id="${attr(edit.id)}" data-decision="reject" title="Acknowledge and move to settled history — the conflict reason is kept">Dismiss</button></div>`
      : '';
  return `<article class="doc-annotation">
    <div class="doc-annotation-head">
      <strong>${edit.kind === 'botboy' ? 'BotBoy proposed' : 'You edited'}</strong>
      <span class="pill ${statusTone}">${esc(edit.status)}</span>
      ${edit.originNote ? `<span class="doc-annotation-meta">${esc(edit.originNote)}</span>` : ''}
    </div>
    ${oldBlock}${newBlock}
    ${edit.conflictReason ? `<p class="doc-annotation-summary" style="color:var(--yellow,#f3ba63)">${esc(edit.conflictReason)}</p>` : ''}
    ${controls}
  </article>`;
}

function pendingEditsSection(data, docKey, syncing) {
  const edits = Array.isArray(data.pendingEdits) ? data.pendingEdits : [];
  const open = edits.filter(edit => edit.status === 'pending' || edit.status === 'approved' || edit.status === 'conflicted');
  const settled = edits.filter(edit => edit.status === 'synced' || edit.status === 'rejected');
  const approvedCount = edits.filter(edit => edit.status === 'approved').length;
  const isDocx = String(data.doc?.fileType || '').toLowerCase() === '.docx';
  if (!isDocx && edits.length === 0) return '';
  const syncButton = approvedCount
    ? `<button class="button primary" type="button" data-action="doc-sync" data-dockey="${attr(docKey)}" ${syncing ? 'disabled' : ''}>${icon('refresh', 14)} ${syncing ? 'Syncing…' : `Sync ${approvedCount} approved change${approvedCount === 1 ? '' : 's'} to SharePoint`}</button>`
    : '';
  // Background lock-retry active: the doc was locked (a teammate's editing
  // session) when Sync ran; the server keeps retrying until it frees up.
  const retryBanner = data.syncRetry?.retrying
    ? `<div class="pill blue" style="margin-bottom:10px; display:inline-flex; align-items:center; gap:6px;">${icon('refresh', 12)} Document locked by an active editing session — auto-retrying sync (attempt ${Number(data.syncRetry.attempts) + 1}, since ${esc(relativeTime(data.syncRetry.startedAt))}). Approved edits publish when it frees up.</div>`
    : '';
  // Propose-a-change form retired (E2/D9): Edit mode and selection-assist
  // replaced it. The lane remains the review/audit surface.
  return `<div class="section-heading"><div><h2>Proposed changes</h2><p>Old vs new, approved by you, applied in one upload. Conflicted edits mean the document moved — the guard working, not a failure.</p></div>${syncButton}</div>
    ${retryBanner}
    <section class="card pad">
      ${open.length ? open.map(pendingEditBlock).join('') : '<p style="margin:2px 0; color:var(--muted); font-size:12px;">No open proposals — press Edit, select text and ask BotBoy, or ask in chat.</p>'}
      ${settled.length ? `<details class="document-findings"><summary>${settled.length} settled (synced or rejected)</summary>${settled.map(pendingEditBlock).join('')}</details>` : ''}
    </section>`;
}

function renderDocReader() {
  const docId = state.route.docId || '';
  const docKey = decodeDocKey(docId);
  if (!docKey) return errorView('This document link is malformed.');
  if (state.docReader.key !== docKey || (!state.docReader.data && !state.docReader.error)) {
    void loadDocReader(docKey);
    return loadingView();
  }
  const { data, error, refreshing } = state.docReader;
  if (!data) return errorView(error || 'This document could not be loaded.');
  const doc = data.doc || {};
  const project = doc.project;
  const editMode = state.docReader.editMode && state.docReader.editMode.active ? state.docReader.editMode : null;
  const canRender = typeof window.formatMarkdownContent === 'function';
  // Preview-reflect (soak find): staged and approved edits apply to the
  // PREVIEW text so the owner sees the document as it would read — the
  // banner keeps it honest that SharePoint does not have them yet. Edits
  // whose passage does not appear in the extracted markdown are simply not
  // previewable here (the old/new blocks below stay authoritative).
  // Shared with the selection mouseup handler (E3): both must see the SAME
  // preview text or block indexes drift.
  const { previewContent, previewApplied } = docPreviewContent(data);
  const previewBanner = previewApplied
    ? `<div class="mcp-alert">${icon('sparkles', 14)}<span>Preview includes ${previewApplied} staged change${previewApplied === 1 ? '' : 's'} not yet on SharePoint — approve and sync below to publish.</span></div>`
    : '';
  // Per-block rendering (E3): each markdown block gets data-md-block="i" so
  // DOM selections map back to source blocks; the assist proposal card
  // renders INLINE after the selection's last block; target blocks carry a
  // state-driven highlight (the browser selection dies on repaints — the
  // class doesn't).
  const assist = state.docReader.assist || null;
  const isDocxFile = String(doc.fileType || '').toLowerCase() === '.docx';
  let contentHtml = previewContent
    ? (canRender
      ? `<div class="content-block fpv-md">${mdBlocksUi(previewContent).map((blockText, i) => {
          const isTarget = assist && Number.isInteger(assist.blockStart) && i >= assist.blockStart && i <= assist.blockEnd;
          let html = `<div class="doc-block${isTarget ? ' doc-assist-target' : ''}" data-md-block="${i}">${window.formatMarkdownContent(blockText)}</div>`;
          if (assist && assist.phase === 'proposal' && i === assist.blockEnd) html += assistProposalCardHtml(assist);
          return html;
        }).join('')}</div>`
      : `<pre class="fpv-pre">${esc(previewContent)}</pre>`)
    : `<div class="empty-state today-empty"><span class="source-icon">${icon('file', 18)}</span><h3>No synced content</h3><p>${doc.extractionTier === 'metadata_only' ? 'This document is presence-only at its size tier — Refresh pulls a fresh snapshot within the same rules, or open it in SharePoint.' : 'Content has not been extracted yet.'}</p></div>`;
  // Edit mode (E2): the content pane becomes an editable draft of the SYNCED
  // extraction. State-driven (D10); the input listener syncs the draft so
  // user-action repaints never lose typed text.
  if (editMode) {
    contentHtml = `<div class="mcp-alert">${icon('sparkles', 14)}<span>You are editing the extracted text. Untouched paragraphs keep their exact Word formatting; edited paragraphs are rewritten with clean formatting. Tables can't be edited yet — table changes are skipped at save.</span></div>
      <textarea id="doc-edit-draft" class="input doc-edit-draft" spellcheck="false">${esc(editMode.draft)}</textarea>
      <div style="display:flex; gap:8px; margin-top:10px; align-items:center; flex-wrap:wrap;">
        <button class="button primary" type="button" data-action="doc-edit-save" data-dockey="${attr(docKey)}" ${editMode.saving ? 'disabled' : ''}>${editMode.saving ? 'Saving…' : 'Save changes'}</button>
        <button class="button" type="button" data-action="doc-edit-cancel" ${editMode.saving ? 'disabled' : ''}>Cancel</button>
        <span style="font-size:11px; color:var(--muted)">Saved changes stage pre-approved — review them below, then Sync.</span>
        ${editMode.error ? `<span style="color:var(--yellow,#f3ba63); font-size:12px;">${esc(editMode.error)}</span>` : ''}
      </div>`;
  }

  // xlsx: sheet chips switch between the bounded synced overview and live
  // per-sheet reads (xlsx-deep-reads X2).
  let sheetChips = '';
  if (String(doc.fileType || '').toLowerCase() === '.xlsx') {
    const sheetView = state.docReader.sheetView;
    const captureSheets = Array.isArray(doc.truncation?.sheets) ? doc.truncation.sheets.map(s => s.name) : [];
    const liveSheets = Array.isArray(sheetView?.data?.sheets) ? sheetView.data.sheets : [];
    const names = [...new Set([...captureSheets, ...liveSheets])];
    const activeSheet = sheetView && (sheetView.loading || sheetView.data?.sheet || sheetView.error) ? sheetView.name : '';
    sheetChips = `<div class="doc-filter-row" style="margin-bottom:10px;">
      <button class="doc-filter-chip ${activeSheet === '' ? 'active' : ''}" type="button" data-action="doc-sheet-overview">Synced overview</button>
      ${names.map(name => `<button class="doc-filter-chip ${activeSheet === name ? 'active' : ''}" type="button" data-action="doc-sheet" data-dockey="${attr(docKey)}" data-sheet="${attr(name)}">${esc(name)}</button>`).join('')}
      ${names.length === 0 ? `<button class="doc-filter-chip" type="button" data-action="doc-sheet" data-dockey="${attr(docKey)}" data-sheet="">${icon('refresh', 11)} List sheets</button>` : ''}
    </div>`;
    if (activeSheet !== '' || sheetView?.loading || sheetView?.error) {
      contentHtml = sheetTableHtml(sheetView);
    } else if (sheetView?.data && !sheetView.data.sheet && liveSheets.length) {
      // Inventory loaded — chips above now list the sheets; keep the overview.
    }
  }
  const tierNote = data.contentTier === 'truncated'
    ? `<div class="mcp-alert warn">${icon('alert', 14)}<span>Bounded extraction — this is a partial view; the truncation record says what was cut. "Open in SharePoint" always has the full document.</span></div>`
    : '';
  // Unaccepted Word suggestions (tracked changes): the converted content
  // shows suggested insertions as if accepted — say so, and attribute them.
  const suggestions = Array.isArray(data.suggestedChanges) ? data.suggestedChanges : [];
  const stagedOpenCount = (data.pendingEdits || []).filter(edit => edit.status === 'pending' || edit.status === 'approved').length;
  const suggestionsBanner = suggestions.length
    ? `<div class="mcp-alert warn">${icon('alert', 14)}<span>This document has ${suggestions.length} unaccepted suggested change${suggestions.length === 1 ? '' : 's'} — the preview below shows suggested text as if it were already accepted. See "Suggested changes" in the rail for who proposed what.</span></div>`
    : '';
  const suggestionsHtml = suggestions.map(change => `
    <article class="activity-row">
      <span class="source-icon">${icon(change.kind === 'deletion' ? 'alert' : 'sparkles', 14)}</span>
      <div class="activity-copy">
        <strong>${esc(change.author)} · ${change.kind === 'deletion' ? 'proposes removing' : 'proposes adding'}${change.date ? ` · ${esc(relativeTime(change.date))}` : ''}</strong>
        <span style="${change.kind === 'deletion' ? 'text-decoration: line-through;' : ''}">${esc(change.text.slice(0, 260))}${change.text.length > 260 ? '…' : ''}</span>
      </div>
    </article>`).join('');
  // Rail organization (UI pass 2026-08-25): threads build from LIVE comments;
  // deleted-but-kept history collapses at the bottom. Open/resolved filter at
  // THREAD level so replies never detach from their root.
  const allComments = data.comments || [];
  const liveComments = allComments.filter(c => !c.deletedFromDoc);
  const deletedComments = allComments.filter(c => c.deletedFromDoc);
  // Related documents (doc-link-graph L2): corpus-internal edges, both
  // directions, each row deep-links into the reader.
  const related = Array.isArray(data.related) ? data.related : [];
  const relatedHtml = related.length ? `<div class="doc-annotation-group"><h3>Related documents <span class="doc-annotation-count">${related.length}</span></h3>${related.map(rel => `
    <a class="doc-annotation" href="#/doc/${encodeDocKey(rel.docKey)}" title="${attr(rel.evidence || '')}" style="text-decoration:none;">
      <div class="doc-annotation-head"><strong>${esc(rel.title)}</strong></div>
      <span class="doc-annotation-meta">${rel.direction === 'outgoing' ? 'this doc links to it' : 'it links to this doc'} · ${esc(rel.kind)}</span>
    </a>`).join('')}</div>` : '';
  const threads = readerCommentThreads(liveComments);
  const isOpenThread = thread => thread.some(c => !c.resolved);
  const openThreads = threads.filter(isOpenThread);
  const resolvedThreads = threads.filter(t => !isOpenThread(t));
  const filter = state.docReader.commentFilter || (openThreads.length ? 'open' : 'all');
  const visibleThreads = filter === 'open' ? openThreads : filter === 'resolved' ? resolvedThreads : threads;
  const filterChip = (id, label, count) =>
    `<button class="doc-filter-chip ${filter === id ? 'active' : ''}" type="button" data-action="doc-comment-filter" data-filter="${id}">${label} <span>${count}</span></button>`;
  const commentFilters = threads.length
    ? `<div class="doc-filter-row">${filterChip('open', 'Open', openThreads.length)}${filterChip('resolved', 'Resolved', resolvedThreads.length)}${filterChip('all', 'All', threads.length)}</div>`
    : '';
  const commentsHtml = visibleThreads.length
    ? visibleThreads.map(thread => `<div class="doc-annotation-group">${thread.map(readerCommentHtml).join('')}</div>`).join('')
    : `<div class="empty-state today-empty"><p>${threads.length ? `No ${filter} threads.` : 'No review comments captured.'}</p></div>`;
  const deletedHtml = deletedComments.length
    ? `<details class="document-findings"><summary>${deletedComments.length} removed from the document (kept as history)</summary>${deletedComments.map(readerCommentHtml).join('')}</details>`
    : '';
  const revisionsHtml = (data.revisions || []).map(rev => `
    <article class="activity-row">
      <span class="source-icon">${icon('activity', 14)}</span>
      <div class="activity-copy"><strong>${esc(relativeTime(rev.capturedAt))}</strong><span>${esc(String(rev.changeSummary || (rev.extractionTier === 'metadata_only' ? 'listed only' : 'captured')).slice(0, 220))}</span></div>
    </article>`).join('');

  return `<div class="breadcrumb"><a href="#/today">Workspace</a>${icon('chevron-right', 11)}${project ? `<a href="#/projects/${encodeURIComponent(project.id)}">${esc(project.title)}</a>${icon('chevron-right', 11)}` : ''}<span>Document</span></div>
    <header class="page-head"><div>
      <h1 class="page-title">${esc(doc.title || docKey)}</h1>
      <div class="project-meta">
        <span>${icon('file', 13)} ${esc(String(doc.fileType || '').replace('.', '') || 'document')}</span>
        ${tierChip(doc.extractionTier)}
        <span>${icon('refresh', 13)} Modified ${esc(relativeTime(doc.lastModified))}</span>
        <span>${icon('activity', 13)} ${data.revisions?.length || 0} revisions · ${liveComments.length} comments (${openThreads.length} open thread${openThreads.length === 1 ? '' : 's'})</span>
        ${suggestions.length ? `<span class="pill warn">${suggestions.length} suggested change${suggestions.length === 1 ? '' : 's'}</span>` : ''}
        ${stagedOpenCount ? `<span class="pill blue">${stagedOpenCount} staged edit${stagedOpenCount === 1 ? '' : 's'}</span>` : ''}
      </div>
    </div><div class="head-actions">
      ${(() => {
        // Edit mode gate (E2/D8): docx, FULL extraction, no open staged edits.
        const isDocxDoc = String(doc.fileType || '').toLowerCase() === '.docx';
        if (!isDocxDoc || !data.content || editMode) return '';
        const reason = data.contentTier !== 'full'
          ? "Refresh first — partial extractions can't be edited safely"
          : stagedOpenCount > 0
            ? 'Resolve staged edits first — approve & sync or reject them'
            : '';
        return `<button class="button" type="button" data-action="doc-edit-enter" ${reason ? `disabled title="${attr(reason)}"` : 'title="Edit the document text; changes stage for sync"'}>${icon('file')} Edit</button>`;
      })()}
      <button class="button" type="button" data-action="doc-refresh" data-dockey="${attr(docKey)}" ${refreshing || editMode ? 'disabled' : ''}>${icon('refresh')} ${refreshing ? 'Refreshing…' : 'Refresh from SharePoint'}</button>
      ${doc.webUrl ? `<a class="button primary" href="${esc(String(doc.webUrl))}" target="_blank" rel="noopener noreferrer">Open in SharePoint</a>` : ''}
    </div></header>
    ${error ? `<div class="mcp-alert warn">${icon('alert', 14)}<span>${esc(error)}</span></div>` : ''}
    ${editMode ? '' : tierNote}
    ${editMode ? '' : suggestionsBanner}
    ${editMode ? '' : previewBanner}
    ${editMode ? '' : pendingEditsSection(data, docKey, state.docReader.syncing === true)}
    ${editMode ? '' : sheetChips}
    <div class="document-annotated with-rail">
      <section class="card pad document-preview-shell" data-scroll-key="doc-reader:preview:${attr(docKey)}">${contentHtml}</section>
      <aside class="document-annotations" data-scroll-key="doc-reader:annotations:${attr(docKey)}">
        ${relatedHtml}
        ${suggestions.length ? `<div class="doc-annotation-group"><h3>Suggested changes <span class="doc-annotation-count">${suggestions.length}</span></h3>${suggestionsHtml}</div>` : ''}
        <div class="doc-annotation-group"><h3>Comments <span class="doc-annotation-count">${liveComments.length}</span></h3>${commentFilters}${commentsHtml}${deletedHtml}</div>
        <div class="doc-annotation-group"><h3>Revisions <span class="doc-annotation-count">${data.revisions?.length || 0}</span></h3>${revisionsHtml || '<div class="empty-state today-empty"><p>No revisions captured.</p></div>'}</div>
      </aside>
    </div>
    ${editMode ? '' : assistOverlayHtml(assist)}`;
}

const ACTIVITY_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})\s+—\s+/;

function renderTimeline(entries) {
  // Chronology: dated entries (evidence capture day, written by the brain
  // pass) sort newest first; legacy undated entries follow in reverse
  // append order, which approximates their age.
  const parsed = entries.map((entry, index) => {
    const match = String(entry).match(ACTIVITY_DATE_PREFIX);
    return { date: match ? match[1] : null, text: String(entry).replace(ACTIVITY_DATE_PREFIX, ''), index };
  });
  const dated = parsed.filter(entry => entry.date).sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index);
  const undated = parsed.filter(entry => !entry.date).reverse();
  const items = [...dated, ...undated];
  return `<div class="section-heading" style="margin-top:0"><div><h2>Project timeline</h2><p>Meaningful activity recorded in the evolving project brain, newest first.</p></div></div><section class="card timeline">${items.length ? items.map((entry, index) => `<article class="timeline-item"><span class="timeline-dot" style="${index > 2 ? 'background:var(--faint);box-shadow:0 0 0 2px var(--border)' : ''}"></span><strong>${esc(entry.text)}</strong><p>${entry.date ? `${esc(entry.date)} · recorded in the project activity log.` : 'Recorded in the project activity log (predates activity dating).'}</p></article>`).join('') : '<div class="empty-state"><h3>No activity log entries</h3><p>The brain has not recorded a meaningful project change yet.</p></div>'}</section>`;
}

function renderInbox() {
  if (state.inboxError) return `${pageHead('Attention queue', 'Inbox', 'Recent evidence that is not yet attached to a project.')} ${errorView(`Inbox summary unavailable: ${state.inboxError}`)}`;
  const items = state.inbox.items || [];
  return `${pageHead('Attention queue', 'Inbox', `${state.inbox.count == null ? 'An unknown number of' : number(state.inbox.count)} captured items are not yet attached to a project. Recent items are shown first.`, `<button class="button primary" type="button" data-action="organize-inbox">${icon('sparkles')} Organize inbox</button>`)}
    <section class="grid three-col" style="margin-bottom:16px"><article class="card insight-card"><span class="insight-icon">${icon('database')}</span><h3>Raw evidence is preserved</h3><p>Organization links an item to context; it does not rewrite or delete the captured source.</p></article><article class="card insight-card"><span class="insight-icon">${icon('branch')}</span><h3>Existing projects come first</h3><p>The organizer checks current areas and projects before proposing new structure.</p></article><article class="card insight-card"><span class="insight-icon">${icon('clock')}</span><h3>Review the recent edge</h3><p>This view intentionally loads a bounded recent page rather than transferring the entire queue.</p></article></section>
    <div class="section-heading"><div><h2>Recent unassigned evidence</h2><p>Showing ${number(items.length)} of ${number(state.inbox.count)} items.</p></div></div><section class="card inbox-list">${items.length ? items.map(item => `<article class="inbox-row"><span class="source-icon">${icon(sourceIcon(item.source, item.type), 15)}</span><div class="evidence-copy"><div class="evidence-title">${esc(item.title || '(untitled evidence)')}</div><p>${esc(item.summary || 'No summary is available for this captured item.')}</p><div class="evidence-meta"><span class="pill">${esc(item.source || 'unknown')}</span><span class="pill">${esc((item.type || 'item').replaceAll('_', ' '))}</span>${item.url ? `<a class="text-link" href="${attr(item.url)}" target="_blank" rel="noopener">Open source</a>` : ''}</div></div><div class="today-item-side"><time>${esc(relativeTime(item.capturedAt || item.captured_at))}</time><button class="today-control" type="button" data-action="discard-item" data-item="${attr(item.id)}" title="Discard: never show this item anywhere" aria-label="Discard this item everywhere">${icon('trash', 14)}</button></div></article>`).join('') : '<div class="empty-state"><h3>Inbox is clear</h3><p>No unassigned evidence was returned.</p></div>'}</section>
    ${discardedSection()}`;
}

function discardedSection() {
  if (!state.discarded.data && !state.discarded.error) {
    void loadDiscarded();
    return '';
  }
  const items = state.discarded.data || [];
  if (!items.length) return '';
  return `<div class="section-heading"><div><h2>Recently discarded</h2><p>Hidden everywhere by you. Restore one to return it exactly where it was.</p></div></div>
    <section class="card inbox-list">${items.slice(0, 20).map(item => `<article class="inbox-row"><span class="source-icon">${icon(sourceIcon(item.source, item.type), 15)}</span><div class="evidence-copy"><div class="evidence-title">${esc(item.title || '(untitled evidence)')}</div><p>${esc(item.summary || 'Discarded item.')}</p><div class="evidence-meta"><span class="pill warn">discarded ${esc(relativeTime(item.discardedAt))}</span><span class="pill">${esc(item.source || 'unknown')}</span></div></div><div class="today-item-side"><button class="button small" type="button" data-action="restore-discard" data-item="${attr(item.id)}">Restore</button></div></article>`).join('')}</section>`;
}

async function loadDiscarded({ force = false } = {}) {
  if (state.discarded.data && !force) return;
  try {
    const payload = await request('/items/discarded?limit=50');
    state.discarded.data = Array.isArray(payload?.items) ? payload.items : [];
    state.discarded.error = '';
  } catch (error) {
    state.discarded.error = error.message;
  }
  if (state.route.view === 'inbox') renderRoute();
}

async function discardItem(itemId, projectId) {
  const key = `discard:${itemId}`;
  if (!itemId || state.evidencePending.has(key)) return;
  state.evidencePending.add(key);
  try {
    await request(`/items/${encodeURIComponent(itemId)}/discard`, { method: 'POST', body: {} });
    if (projectId) {
      const detail = state.projectDetails.get(projectId);
      if (detail) detail.items = (detail.items || []).filter(item => item.id !== itemId);
      const project = projectById(projectId);
      if (project && project.itemCount > 0) project.itemCount -= 1;
    }
    state.inbox.items = (state.inbox.items || []).filter(item => item.id !== itemId);
    if (state.inbox.count != null && state.inbox.count > 0 && !projectId) state.inbox.count -= 1;
    state.discarded.data = null; // refetch lazily
    toast('Discarded — this item will never appear anywhere. Undo from the Inbox page.');
  } catch (error) {
    toast(`Could not discard item: ${error.message}`, 'bad');
  } finally {
    state.evidencePending.delete(key);
    renderRoute({ userAction: true });
  }
}

async function restoreDiscardedItem(itemId) {
  const key = `discard:${itemId}`;
  if (!itemId || state.evidencePending.has(key)) return;
  state.evidencePending.add(key);
  try {
    const result = await request(`/items/${encodeURIComponent(itemId)}/restore-discard`, { method: 'POST', body: {} });
    if (result?.restoredProjectId) state.projectDetails.delete(result.restoredProjectId);
    state.discarded.data = null;
    state.inbox.items = [];
    await loadCore({ quiet: true });
    toast('Restored to exactly where it was');
  } catch (error) {
    toast(`Could not restore item: ${error.message}`, 'bad');
  } finally {
    state.evidencePending.delete(key);
    renderRoute({ userAction: true });
  }
}

async function dismissRelation(projectId, otherId) {
  if (!projectId || !otherId) return;
  try {
    await request(`/projects/${encodeURIComponent(projectId)}/relations/${encodeURIComponent(otherId)}/dismiss`, { method: 'POST', body: {} });
    const detail = state.projectDetails.get(projectId);
    if (detail && Array.isArray(detail.relatedProjects)) {
      detail.relatedProjects = detail.relatedProjects.filter(rel => rel.id !== otherId);
    }
    renderRoute({ userAction: true });
    toast('Marked as not related — the link stays hidden. Ask BotBoy to restore it if needed.');
  } catch (error) {
    toast(`Could not dismiss the link: ${error.message}`, 'bad');
  }
}

async function rejectEvidence(projectId, itemId) {
  const key = `${projectId}:${itemId}`;
  if (!projectId || !itemId || state.evidencePending.has(key)) return;
  state.evidencePending.add(key);
  try {
    await request(`/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(itemId)}/reject`, { method: 'POST', body: {} });
    const detail = state.projectDetails.get(projectId);
    if (detail) {
      const index = (detail.items || []).findIndex(item => item.id === itemId);
      if (index >= 0) {
        const [moved] = detail.items.splice(index, 1);
        detail.rejectedItems = [{ ...moved, rejectedAt: new Date().toISOString() }, ...(detail.rejectedItems || [])];
      }
    }
    const project = projectById(projectId);
    if (project && project.itemCount > 0) project.itemCount -= 1;
    toast('Evidence rejected — it will never route back here. Rebuild from evidence to update the brain.');
  } catch (error) {
    toast(`Could not reject evidence: ${error.message}`, 'bad');
  } finally {
    state.evidencePending.delete(key);
    if (state.route.view === 'project' && state.route.projectId === projectId) renderRoute({ userAction: true });
  }
}

async function restoreEvidence(projectId, itemId) {
  const key = `${projectId}:${itemId}`;
  if (!projectId || !itemId || state.evidencePending.has(key)) return;
  state.evidencePending.add(key);
  try {
    await request(`/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(itemId)}/restore`, { method: 'POST', body: {} });
    state.projectDetails.delete(projectId);
    const project = projectById(projectId);
    if (project) project.itemCount += 1;
    toast('Evidence restored to the project');
  } catch (error) {
    toast(`Could not restore evidence: ${error.message}`, 'bad');
  } finally {
    state.evidencePending.delete(key);
    if (state.route.view === 'project' && state.route.projectId === projectId) renderRoute({ userAction: true });
  }
}

async function rebuildProjectBrain(projectId) {
  if (!projectId || state.rebuilding.has(projectId)) return;
  state.rebuilding.add(projectId);
  renderRoute({ userAction: true });
  try {
    const result = await request('/pipeline/rebuild-brains', { method: 'POST', body: { projectId, ownerRequested: true } });
    if (result?.status === 'rebuilt') toast(`Brain rebuilt from ${number(result.items)} evidence item(s)`);
    else toast('Rebuild skipped — the model may be unavailable or the project has no evidence', 'bad');
    state.projectDetails.delete(projectId);
  } catch (error) {
    toast(`Rebuild failed: ${error.message}`, 'bad');
  } finally {
    state.rebuilding.delete(projectId);
    if (state.route.view === 'project' && state.route.projectId === projectId) renderRoute({ userAction: true });
  }
}

async function loadChannels({ force = false } = {}) {
  if (state.channels.loading || (state.channels.data && !force)) return;
  state.channels.loading = true;
  try {
    const payload = await request('/channels/digests');
    state.channels.data = Array.isArray(payload?.channels) ? payload.channels : [];
    state.channels.error = '';
  } catch (error) {
    state.channels.error = error.message;
  } finally {
    state.channels.loading = false;
    if (state.route.view === 'channels') renderRoute();
  }
}

async function runChannelDigests() {
  if (state.channels.running) return;
  state.channels.running = true;
  renderRoute({ userAction: true });
  try {
    const result = await request('/channels/digests/run', { method: 'POST', body: {} });
    if (result?.status === 'deferred') toast('The model is unavailable — digest run deferred', 'bad');
    else toast(`Digests updated: ${result.digestsWritten} written, ${result.crossLinksCreated} new cross-links`);
    await loadChannels({ force: true });
  } catch (error) {
    toast(`Digest run failed: ${error.message}`, 'bad');
  } finally {
    state.channels.running = false;
    if (state.route.view === 'channels') renderRoute({ userAction: true });
  }
}

async function reviewAmbientProjects() {
  try {
    const dryRun = await request('/pipeline/demote-ambient', { method: 'POST', body: { apply: false } });
    const candidates = Array.isArray(dryRun?.candidates) ? dryRun.candidates : [];
    if (!candidates.length) {
      toast('No ambient-born projects found');
      return;
    }
    const preview = candidates.slice(0, 6).map(candidate => `• ${candidate.title}`).join('\n');
    const confirmed = window.confirm(
      `Archive ${candidates.length} project(s) created entirely from ambient channel messages you never engaged with?\n\n${preview}${candidates.length > 6 ? '\n…and more' : ''}\n\nTheir evidence returns to channel digests. Projects are archived, not deleted, so this is reversible.`,
    );
    if (!confirmed) return;
    const applied = await request('/pipeline/demote-ambient', { method: 'POST', body: { apply: true } });
    toast(`Archived ${applied.archived} project(s); released ${applied.itemsReleased} evidence item(s)`);
    state.projectDetails.clear();
    state.channels.data = null;
    await loadCore({ quiet: true });
    renderRoute({ userAction: true });
  } catch (error) {
    toast(`Ambient cleanup failed: ${error.message}`, 'bad');
  }
}

function channelDigestCard(channel) {
  const digest = channel.digest;
  const topics = Array.isArray(digest?.topics) ? digest.topics : [];
  return `<article class="card connection-card"><div class="connection-head"><span class="source-icon">${icon('hash', 19)}</span><span class="pill"><span class="status-dot"></span>Ambient</span></div>
    <h3>#${esc(channel.channelName)}</h3>
    <p>${digest ? esc(digest.text) : 'No digest yet. Digests are generated periodically, or run one now.'}</p>
    ${topics.length ? `<div class="evidence-meta" style="flex-wrap:wrap;gap:6px">${topics.map(topic => {
      const linked = Array.isArray(topic.projects) && topic.projects.length ? topic.projects[0] : null;
      return linked
        ? `<a class="pill accent" href="#/projects/${encodeURIComponent(linked.id)}" title="Related to ${attr(linked.title)}">${esc(topic.topic)} ${icon('arrow-right', 11)}</a>`
        : `<span class="pill">${esc(topic.topic)}</span>`;
    }).join('')}</div>` : ''}
    <div class="connection-details"><span><span>Messages captured</span><strong>${number(channel.messageCount)}</strong></span><span><span>Digest updated</span><strong>${digest ? esc(relativeTime(digest.updatedAt)) : 'Never'}</strong></span></div></article>`;
}

function renderChannels() {
  if (!state.channels.data && !state.channels.error) {
    void loadChannels();
    return loadingView();
  }
  const head = pageHead(
    'Sources',
    'Channels',
    'Channels you engage with feed your projects. Channels you only follow get a periodic digest instead of manufacturing work.',
    `<button class="button" type="button" data-action="review-ambient">${icon('shield')} Review ambient-born projects</button><button class="button primary" type="button" data-action="run-digests" ${state.channels.running ? 'disabled' : ''}>${icon('refresh')} ${state.channels.running ? 'Generating digests…' : 'Refresh digests'}</button>`,
  );
  if (!state.channels.data) return `${head} ${errorView(state.channels.error)}`;
  const channels = state.channels.data;
  const dms = channels.filter(channel => channel.channelType === 'dm' || channel.channelType === 'group_dm');
  const engaged = channels.filter(channel => channel.tier === 'engaged' && !dms.includes(channel));
  const ambient = channels.filter(channel => channel.tier === 'ambient');
  return `${head}
    <div class="section-heading"><div><h2>Ambient channels</h2><p>Subscribed for awareness. Their messages feed these digests — never your projects or tasks. Topics that anchor to one of your active projects are cross-linked.</p></div></div>
    <section class="grid three-col">${ambient.length ? ambient.map(channelDigestCard).join('') : '<div class="card empty-state"><h3>No ambient channels</h3><p>Every watched channel currently shows recent engagement from you.</p></div>'}</section>
    <div class="section-heading"><div><h2>Engaged channels</h2><p>You are active here (messages, mentions, reactions, threads), so evidence flows directly into project routing.</p></div></div>
    <section class="card">${engaged.length ? engaged.map(channel => `<div class="health-row"><span class="status-dot good"></span><span><strong>#${esc(channel.channelName)}</strong><small>${number(channel.messageCount)} messages captured · last ${esc(relativeTime(channel.lastMessageAt))}</small></span><span class="pill good">Engaged</span></div>`).join('') : '<div class="empty-state"><h3>No engaged channels</h3><p>Channels move here automatically when you post, react, get mentioned, or join a thread.</p></div>'}</section>
    ${dms.length ? `<div class="section-heading"><div><h2>Direct messages</h2><p>DMs are always personal — they route to projects and never appear in digests.</p></div></div><section class="card">${dms.map(channel => `<div class="health-row"><span class="status-dot good"></span><span><strong>${esc(channel.channelName)}</strong><small>${number(channel.messageCount)} messages captured</small></span><span class="pill accent">Personal</span></div>`).join('')}</section>` : ''}`;
}

/**
 * One status model for every managed MCP profile card. New registry profiles
 * appear on the Connections page with no dashboard changes.
 */
function managedProfileCard(profile) {
  const card = profile.guide?.card || {};
  const status = profile.installationState === 'not_installed' ? 'Not installed'
    : profile.needsReview ? 'Needs review'
      : !profile.configured ? 'Needs setup'
        : profile.state === 'running'
          ? profile.compatibilityState === 'incompatible' ? 'Update needed' : 'Connected'
          : profile.state === 'degraded' ? 'Connection issue'
            : profile.enabled ? 'Starting' : 'Ready';
  const tone = profile.needsReview || profile.state === 'failed' || profile.state === 'degraded' || profile.compatibilityState === 'incompatible'
    ? 'warn'
    : profile.state === 'running' && profile.compatibilityState !== 'incompatible' ? 'good' : '';
  const detail = (profile.needsReview && 'BotBoy wrote this configuration. Review it, then press Start.')
    || profile.lastError
    || (profile.installationState === 'not_installed' && card.notInstalledDetail)
    || (profile.configured ? card.readyDetail : card.needsSetupDetail)
    || profile.displayName;
  return {
    icon: profile.id === 'sql-context' ? 'database' : 'link',
    name: profile.displayName,
    status,
    tone,
    detail,
    handling: card.dataHandling || 'Managed MCP connection',
    profileId: profile.id,
  };
}

/** Card status for the Outlook mail & calendar sync on the Connections grid. */
function graspSyncCardModel() {
  const sync = state.graspSync;
  if (sync.error) return { status: 'Unavailable', tone: 'warn', detail: sync.error };
  const status = sync.status;
  if (!status) return { status: 'Checking', tone: '', detail: 'Loading sync status' };
  if (!status.enabled) return { status: 'Paused', tone: 'warn', detail: 'Automatic sync is paused; browser email capture is active again' };
  const run = status.lastRun;
  if (!run) return { status: 'Scheduled', tone: 'good', detail: `First sync runs shortly after start, then every ${status.intervalMinutes} minutes` };
  if (run.status === 'failed') return { status: 'Needs attention', tone: 'warn', detail: String(run.reason || 'The last sync failed') };
  const mails = (run.inbox?.emitted ?? 0) + (run.sent?.emitted ?? 0);
  const events = run.calendar?.emitted ?? 0;
  return {
    status: 'Active',
    tone: 'good',
    detail: `Last sync ${relativeTime(run.at)}: ${number(mails)} emails and ${number(events)} calendar changes ingested`,
  };
}

function renderGraspSyncSettings() {
  const sync = state.graspSync;
  const status = sync.status;
  const card = graspSyncCardModel();
  const run = status?.lastRun;
  const busy = sync.busy;
  const counters = run && run.status !== 'skipped' ? `
    <div class="section-heading"><div><h2>Last sync</h2><p>${esc(run.status === 'failed' ? `Failed ${relativeTime(run.at)} — ${String(run.reason || '')}` : `Completed ${relativeTime(run.at)} in ${((run.durationMs || 0) / 1000).toFixed(1)}s as ${esc(String(run.ownerEmail || ''))}`)}</p></div></div>
    <section class="grid three-col">
      <article class="card pad"><div class="eyebrow">${icon('message', 14)} Inbox</div><h3 class="card-title">${number(run.inbox?.emitted ?? 0)} ingested</h3><p class="page-subtitle">${number(run.inbox?.listed ?? 0)} listed — ${number(run.inbox?.noise ?? 0)} automated noise, ${number(run.inbox?.notAddressed ?? 0)} not addressed to you, ${number(run.inbox?.duplicates ?? 0)} already stored</p></article>
      <article class="card pad"><div class="eyebrow">${icon('message', 14)} Sent</div><h3 class="card-title">${number(run.sent?.emitted ?? 0)} ingested</h3><p class="page-subtitle">Your own sent mail is kept without filters — it carries your commitments</p></article>
      <article class="card pad"><div class="eyebrow">${icon('clock', 14)} Calendar</div><h3 class="card-title">${number(run.calendar?.emitted ?? 0)} changes</h3><p class="page-subtitle">${number(run.calendar?.listed ?? 0)} events in the window, ${number(run.calendar?.unchanged ?? 0)} unchanged since the last sync</p></article>
    </section>` : '';
  return `${pageHead('Connection settings', 'Outlook mail & calendar', 'BotBoy pulls your Microsoft 365 mail and calendar through the GRASP connection on a schedule and folds them into project synthesis.', `<button class="button" type="button" data-action="grasp-sync-run" ${busy ? 'disabled' : ''}>${icon('refresh', 14)} ${busy === 'run' ? 'Syncing…' : 'Sync now'}</button><a class="button" href="#/connections/grasp-m365">${icon('settings', 14)} GRASP connection</a>`)}
    <section class="card pad">
      <div class="connection-head"><span class="source-icon">${icon('clock', 19)}</span><span class="pill ${card.tone}"><span class="status-dot ${card.tone}"></span>${esc(card.status)}</span></div>
      <p>${esc(card.detail)}</p>
      <div class="connection-details">
        <span><span>Cadence</span><strong>Every ${status ? number(status.intervalMinutes) : 30} minutes</strong></span>
        <span><span>Owner identity</span><strong>${esc(status?.ownerEmail || 'Detected on first sync')}</strong></span>
        <span><span>Browser email capture</span><strong>${status?.enabled && status?.mailActive ? 'Suppressed (this sync replaces it)' : 'Active'}</strong></span>
      </div>
      <p class="page-subtitle" style="margin-top:8px">${esc('Read-only: BotBoy never marks mail read, moves, sends, or changes anything in your mailbox or calendar.')}</p>
      <button class="button" type="button" data-action="grasp-sync-toggle" ${busy ? 'disabled' : ''}>${status?.enabled ? 'Pause automatic sync' : 'Resume automatic sync'}</button>
    </section>
    ${counters}
    <div class="section-heading"><div><h2>Filtering rules</h2><p>Inbox mail is kept only when your address is in To or Cc. Automated senders are dropped first; meeting summaries and recaps always pass.</p></div></div>
    <section class="grid two-col">
      <article class="card pad">
        <h3 class="card-title">Owner address</h3>
        <p class="page-subtitle">Auto-detected from your GRASP profile. Override it only if detection picked the wrong account; clear it to re-detect on the next sync.</p>
        <input id="grasp-sync-owner" type="text" placeholder="you@amazon.com" value="${attr(status?.ownerEmail || '')}" style="width:100%">
        <div style="margin-top:8px"><button class="button small" type="button" data-action="grasp-sync-save-owner" ${busy ? 'disabled' : ''}>${busy === 'owner' ? 'Saving…' : 'Save address'}</button></div>
      </article>
      <article class="card pad">
        <h3 class="card-title">Noise senders</h3>
        <p class="page-subtitle">One pattern per line, matched case-insensitively inside the sender address and name. Mail from matching senders is skipped.</p>
        <textarea id="grasp-sync-noise" rows="8" style="width:100%; font-family:var(--mono, monospace); font-size:12px">${esc((status?.noiseSenders || []).join('\n'))}</textarea>
        <div style="margin-top:8px"><button class="button small" type="button" data-action="grasp-sync-save-noise" ${busy ? 'disabled' : ''}>${busy === 'noise' ? 'Saving…' : 'Save noise list'}</button></div>
      </article>
    </section>`;
}

async function refreshGraspSyncStatus() {
  try {
    const payload = await request('/grasp-sync/status');
    state.graspSync.status = payload.status || null;
    state.graspSync.error = '';
  } catch (error) {
    state.graspSync.error = error.message;
  }
}

async function graspSyncAction(kind, work) {
  if (state.graspSync.busy) return;
  state.graspSync.busy = kind;
  renderRoute({ userAction: true });
  try {
    await work();
    state.graspSync.error = '';
  } catch (error) {
    toast(`Sync settings error: ${error.message}`);
  } finally {
    state.graspSync.busy = '';
    renderRoute({ userAction: true });
  }
}

async function sharepointSyncAction(kind, work) {
  if (state.sharepointSync.busy) return;
  state.sharepointSync.busy = kind;
  renderRoute({ userAction: true });
  try {
    await work();
    state.sharepointSync.error = '';
  } catch (error) {
    toast(`Document sync error: ${error.message}`);
  } finally {
    state.sharepointSync.busy = '';
    renderRoute({ userAction: true });
  }
}

/** Card status for the SharePoint document sync on the Connections grid. */
function sharepointSyncCardModel() {
  const sync = state.sharepointSync;
  if (sync.error) return { status: 'Unavailable', tone: 'warn', detail: sync.error };
  const status = sync.status;
  if (!status) return { status: 'Checking', tone: '', detail: 'Loading sync status' };
  if (!status.enabled) return { status: 'Off', tone: '', detail: 'Enable to sync documents from shared-with-me, OneDrive, and team libraries' };
  const surging = (status.sources || []).some(s => s.surgePending);
  if (surging) return { status: 'Needs review', tone: 'warn', detail: 'A source reports a mass change and is paused for your confirmation' };
  const queued = status.queue?.queued ?? 0;
  const failed = status.queue?.failed ?? 0;
  const gatePaused = status.queue?.queued > 0 && status.gates && (!status.gates.backlog || !status.gates.cache);
  const detail = queued > 0
    ? `${number(queued)} document${queued === 1 ? '' : 's'} queued${gatePaused ? ' — drain paused for pipeline headroom' : ''}`
    : `${number((status.sources || []).length)} source${(status.sources || []).length === 1 ? '' : 's'} synced${failed ? `, ${number(failed)} failed` : ''}`;
  return { status: 'Connected', tone: failed ? 'warn' : 'good', detail };
}

const SHAREPOINT_SOURCE_LABELS = { shared_with_me: 'Shared with me', onedrive: 'My OneDrive', library: 'Team library' };
const SHAREPOINT_BASELINE_LABELS = { recent30: 'Recent 30 documents', days90: 'Last 90 days', all: 'Everything' };

function renderSharePointSyncSettings() {
  const sync = state.sharepointSync;
  const status = sync.status;
  const card = sharepointSyncCardModel();
  const busy = sync.busy;
  const sources = status?.sources || [];
  const hasKind = kind => sources.some(s => s.kind === kind);
  const backoffs = Object.entries(status?.backoffs || {});
  const queue = status?.queue || { queued: 0, failed: 0, live: 0, backfill: 0 };

  const sourceRows = sources.map(source => {
    const label = SHAREPOINT_SOURCE_LABELS[source.kind] || source.kind;
    const scope = source.kind === 'library'
      ? `${source.siteUrl || ''}${source.libraryName ? ` › ${source.libraryName}` : ''}${source.folderPath ? ` › ${source.folderPath}` : ''}`
      : SHAREPOINT_BASELINE_LABELS[source.baseline] || source.baseline;
    const surge = source.surgePending
      ? `<div class="page-subtitle" style="color:var(--warn, #b45309)">Mass change detected: ${number(source.surgePending)} documents changed at once. Paused until you confirm.</div>
         <button class="button small" type="button" data-action="sharepoint-surge-confirm" data-id="${attr(source.id)}" ${busy ? 'disabled' : ''}>Resume this source</button>`
      : '';
    return `<article class="card pad">
      <div class="connection-head"><strong>${esc(label)}</strong>${source.paused && !source.surgePending ? '<span class="pill warn">Paused</span>' : ''}</div>
      <p class="page-subtitle">${esc(scope)}</p>
      <p class="page-subtitle">Baseline: ${esc(SHAREPOINT_BASELINE_LABELS[source.baseline] || source.baseline)}${source.baselineDone ? ' (done)' : ' (pending)'} · ${number(source.queued)} queued</p>
      ${surge}
      <div style="margin-top:8px"><button class="button small" type="button" data-action="sharepoint-source-remove" data-id="${attr(source.id)}" ${busy ? 'disabled' : ''}>Remove</button></div>
    </article>`;
  }).join('');

  const siteOptions = (sync.sites || []).map(site => `<option value="${attr(site.Path || '')}">${esc(site.Title || site.Path || '')}</option>`).join('');
  const libraryOptions = (sync.libraries || []).map(lib => `<option value="${attr(lib.Title || '')}">${esc(lib.Title || '')}</option>`).join('');

  return `${pageHead('Connection settings', 'SharePoint documents', 'BotBoy syncs documents from the SharePoint sources you pick — shared with me, OneDrive, team libraries — and folds them into project synthesis. Large files are extracted with explicit coverage notes; anything BotBoy cannot fully read says so.', `<button class="button" type="button" data-action="sharepoint-sync-run" ${busy ? 'disabled' : ''}>${icon('refresh', 14)} ${busy === 'run' ? 'Checking…' : 'Check for changes'}</button><a class="button" href="#/connections/sharepoint">${icon('settings', 14)} SharePoint connection</a>`)}
    <section class="card pad">
      <div class="connection-head"><span class="source-icon">${icon('file', 19)}</span><span class="pill ${card.tone}"><span class="status-dot ${card.tone}"></span>${esc(card.status)}</span></div>
      <p class="page-subtitle">${esc(card.detail)}</p>
      <div class="connection-details">
        <span><span>Queued</span><strong>${number(queue.queued)} (${number(queue.live)} live, ${number(queue.backfill)} backfill)</strong></span>
        <span><span>Failed</span><strong>${number(queue.failed)}</strong></span>
        <span><span>Pipeline gate</span><strong>${status?.gates?.backlog === false ? 'Holding (pipeline busy)' : 'Open'}</strong></span>
        <span><span>Cache gate</span><strong>${status?.gates?.cache === false ? 'Holding (cache full)' : 'Open'}</strong></span>
      </div>
      ${backoffs.length ? `<p class="page-subtitle" style="margin-top:8px">SharePoint asked BotBoy to slow down: ${backoffs.map(([domain, until]) => `${esc(domain)} until ${esc(new Date(until).toLocaleTimeString())}`).join(', ')}.</p>` : ''}
      ${status?.ownerIdentity ? (status.ownerIdentity.known
        ? `<p class="page-subtitle" style="margin-top:8px">Matching you in document comments as <strong>${esc(status.ownerIdentity.displayName || '(no name)')}</strong>${status.ownerIdentity.alias ? ` · <strong>${esc(status.ownerIdentity.alias)}</strong>` : ''} <span style="opacity:.7">(${esc(status.ownerIdentity.nameSource === 'grasp' ? 'detected from mail profile' : status.ownerIdentity.nameSource === 'none' ? 'alias only' : 'configured override')})</span>. Wrong? Set <code>owner_identity.name</code> / <code>owner_identity.alias</code> in settings.</p>`
        : `<p class="page-subtitle" style="margin-top:8px;color:var(--warn, #b45309)">Owner identity unknown — BotBoy cannot tell which comments are yours or mention you until mail sync detects your profile (or you set <code>owner_identity.name</code> / <code>owner_identity.alias</code>).</p>`) : ''}
      <p class="page-subtitle" style="margin-top:8px">Read-only: BotBoy never edits, uploads, or deletes anything in SharePoint. Documents flow through the same local evidence pipeline as every other source.</p>
      <button class="button" type="button" data-action="sharepoint-sync-toggle" ${busy ? 'disabled' : ''}>${status?.enabled ? 'Pause document sync' : 'Enable document sync'}</button>
      ${status?.enabled ? `<button class="button small" type="button" data-action="sharepoint-purge" ${busy ? 'disabled' : ''} style="margin-left:8px">Purge synced data…</button>` : ''}
    </section>
    <div class="section-heading"><div><h2>Sources</h2><p>Nothing syncs unless you pick it. Baseline depth is chosen when a source is added; changes arrive on the half-hour discovery cycle.</p></div></div>
    <section class="grid two-col">
      ${sourceRows || '<article class="card pad"><p class="page-subtitle">No sources yet. Enable sync to start with your shared-with-me documents, or add a source below.</p></article>'}
    </section>
    <div class="section-heading"><div><h2>Add a source</h2></div></div>
    <section class="grid two-col">
      <article class="card pad">
        <h3 class="card-title">Personal</h3>
        <p class="page-subtitle">Documents other people shared with you, and your own OneDrive files.</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          ${hasKind('shared_with_me') ? '' : `<button class="button small" type="button" data-action="sharepoint-add-source" data-kind="shared_with_me" ${busy ? 'disabled' : ''}>Add "Shared with me"</button>`}
          ${hasKind('onedrive') ? '' : `<button class="button small" type="button" data-action="sharepoint-add-source" data-kind="onedrive" ${busy ? 'disabled' : ''}>Add "My OneDrive"</button>`}
          ${hasKind('shared_with_me') && hasKind('onedrive') ? '<p class="page-subtitle">Both personal sources are configured.</p>' : ''}
        </div>
        <p class="page-subtitle" style="margin-top:8px">Baseline for new sources: <select id="sharepoint-baseline"><option value="recent30">Recent 30 documents</option><option value="days90" selected>Last 90 days</option><option value="all">Everything</option></select></p>
      </article>
      <article class="card pad">
        <h3 class="card-title">Team library</h3>
        <p class="page-subtitle">Search for a site, load its libraries, optionally scope to a folder.</p>
        <div style="display:flex; gap:8px; margin-bottom:8px">
          <input id="sharepoint-site-query" type="text" placeholder="Site name (e.g. mx-team)" style="flex:1">
          <button class="button small" type="button" data-action="sharepoint-site-search" ${busy ? 'disabled' : ''}>${busy === 'sites' ? 'Searching…' : 'Search'}</button>
        </div>
        ${sync.sites?.length ? `<div style="display:flex; gap:8px; margin-bottom:8px">
          <select id="sharepoint-site-pick" style="flex:1">${siteOptions}</select>
          <button class="button small" type="button" data-action="sharepoint-load-libraries" ${busy ? 'disabled' : ''}>${busy === 'libraries' ? 'Loading…' : 'Load libraries'}</button>
        </div>` : ''}
        ${sync.libraries?.length ? `<div style="display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap">
          <select id="sharepoint-library-pick" style="flex:1">${libraryOptions}</select>
          <input id="sharepoint-folder-path" type="text" placeholder="Folder (optional)" style="flex:1">
          <button class="button small" type="button" data-action="sharepoint-add-library" ${busy ? 'disabled' : ''}>Add library</button>
        </div>` : ''}
      </article>
    </section>`;
}

function renderConnections() {
  const slackCount = state.slack.configured?.length;
  const folderCount = state.folders.items?.filter(folder => folder.enabled).length;
  const total = totalItems();
  const profiles = Array.isArray(state.mcp.servers) ? state.mcp.servers : [];
  const managedCards = profiles.length
    ? profiles.map(managedProfileCard)
    : [{
      icon: 'database',
      name: 'Managed MCP connections',
      status: state.mcp.profilesError ? 'Unavailable' : 'Checking',
      tone: state.mcp.profilesError ? 'warn' : '',
      detail: state.mcp.profilesError || 'Loading managed connection profiles',
      handling: 'Managed MCP connection',
      profileId: '',
    }];
  const graspSyncCard = graspSyncCardModel();
  const sharepointSyncCard = sharepointSyncCardModel();
  const captureCards = [
    ['message', 'Slack', state.slack.error ? 'Unavailable' : slackCount == null ? 'Checking' : 'Connected', state.slack.error ? 'warn' : 'good', slackCount == null ? 'Configuration unavailable' : `${number(slackCount)} conversations configured`, 'slack'],
    ['folder', 'Local folders', state.folders.error ? 'Unavailable' : folderCount == null ? 'Checking' : 'Connected', state.folders.error ? 'warn' : 'good', folderCount == null ? 'Configuration unavailable' : `${number(folderCount)} enabled folders`, 'folders'],
    ['clock', 'Outlook mail & calendar', graspSyncCard.status, graspSyncCard.tone, graspSyncCard.detail, 'grasp-sync'],
    ['file', 'SharePoint documents', sharepointSyncCard.status, sharepointSyncCard.tone, sharepointSyncCard.detail, 'sharepoint-sync'],
    ['globe', 'Browser capture', 'Available', 'good', total == null ? 'Captured evidence is stored locally' : `${number(total)} total evidence items in the local store`, 'browser'],
  ];
  const connectionsAsk = 'I want to add a new MCP server to BotBoy. I will paste a link to its documentation, npm, or GitHub page. Fetch the link, derive the launch command, arguments, and environment variables, confirm anything ambiguous with me, then add it with mcp_add_custom_server so I can review and start it.';
  return `${pageHead('Sources', 'Connections', 'Manage where evidence and analytical context come from, and verify each local connection.', `<button class="button" type="button" data-prompt="${attr(connectionsAsk)}">${icon('sparkles')} Ask BotBoy to add one</button><a class="button primary" href="#/connections/add">${icon('plus', 14)} Add MCP server</a>`)}
    <section class="grid three-col">${captureCards.map(([ico, name, status, tone, detail, action]) => `<article class="card connection-card"><div class="connection-head"><span class="source-icon">${icon(ico, 19)}</span><span class="pill ${tone}"><span class="status-dot ${tone}"></span>${esc(status)}</span></div><h3>${esc(name)}</h3><p>${esc(detail)}</p><div class="connection-details"><span><span>Data handling</span><strong>Local evidence store</strong></span><span><span>Lifecycle</span><strong>${state.health?.totalFailures ? 'Needs review' : 'Healthy'}</strong></span></div>${action === 'browser' ? `<a class="button small" href="#/pipeline">View capture health ${icon('chevron-right', 12)}</a>` : action === 'grasp-sync' ? `<a class="button small" href="#/connections/mail-calendar-sync">Manage ${icon('chevron-right', 12)}</a>` : action === 'sharepoint-sync' ? `<a class="button small" href="#/connections/document-sync">Manage ${icon('chevron-right', 12)}</a>` : `<button class="button small" type="button" data-action="manage-connection" data-connection="${action}">Manage ${icon('chevron-right', 12)}</button>`}</article>`).join('')}
    ${managedCards.map(card => `<article class="card connection-card"><div class="connection-head"><span class="source-icon">${icon(card.icon, 19)}</span><span class="pill ${card.tone}"><span class="status-dot ${card.tone}"></span>${esc(card.status)}</span></div><h3>${esc(card.name)}</h3><p>${esc(card.detail)}</p><div class="connection-details"><span><span>Data handling</span><strong>${esc(card.handling)}</strong></span><span><span>Lifecycle</span><strong>Managed by BotBoy</strong></span></div>${card.profileId ? `<button class="button small" type="button" data-action="manage-connection" data-connection="managed" data-profile="${attr(card.profileId)}">Manage ${icon('chevron-right', 12)}</button>` : ''}</article>`).join('')}</section>
    <div class="section-heading"><div><h2>Connection principles</h2><p>Captured sources stay durable; external analytical content remains untrusted until BotBoy applies its local policy.</p></div></div><section class="grid three-col"><article class="card pad"><div class="eyebrow">${icon('database', 14)} Preserve</div><h3 class="card-title">Raw content stays intact</h3><p class="page-subtitle">Project brains can evolve while original evidence remains unchanged.</p></article><article class="card pad"><div class="eyebrow">${icon('shield', 14)} Restrict</div><h3 class="card-title">Writes need your explicit request</h3><p class="page-subtitle">BotBoy calls read tools freely and runs mutating operations only when you ask for them in chat.</p></article><article class="card pad"><div class="eyebrow">${icon('link', 14)} Explain</div><h3 class="card-title">Analysis stays traceable</h3><p class="page-subtitle">MCP calls are audited locally without storing credentials or query results in the audit log.</p></article></section>`;
}

function currentProfile(profileId) {
  return state.mcp.servers?.find(server => server.id === profileId) || null;
}

function storeProfile(profile) {
  if (!profile || !profile.id) return;
  const list = [...(state.mcp.servers || [])];
  const index = list.findIndex(server => server.id === profile.id);
  if (index >= 0) list[index] = profile;
  else list.push(profile);
  state.mcp.servers = list;
}

function profilePendingSet(profileId) {
  if (!state.mcp.profilePending[profileId]) state.mcp.profilePending[profileId] = new Set();
  return state.mcp.profilePending[profileId];
}

/**
 * Merge a bare server payload into the stored profile entry. Server payloads
 * carry live state only, so profile-level fields such as the setup guide and
 * installation state must survive the merge.
 */
function mergeServerSnapshot(server) {
  if (!server || !server.id) return;
  const existing = currentProfile(server.id);
  storeProfile(existing ? { ...existing, ...server } : server);
}

async function loadProfile(profileId, { force = false } = {}) {
  const current = currentProfile(profileId);
  const pending = profilePendingSet(profileId);
  if (pending.has('load') || (current && !force)) return current;
  pending.add('load');
  try {
    const payload = await request(`/mcp/profiles/${encodeURIComponent(profileId)}`);
    storeProfile(payload.profile);
    state.mcp.profilesError = '';
    if (state.mcp.profileNotice[profileId]?.action === 'load') state.mcp.profileNotice[profileId] = null;
    return currentProfile(profileId);
  } catch (error) {
    state.mcp.profileNotice[profileId] = {
      action: 'load',
      tone: 'warn',
      message: `Could not load the connection profile: ${error.message}`,
    };
    return null;
  } finally {
    pending.delete('load');
    if (state.route.view === 'profile-settings') renderRoute();
  }
}

function renderProfileSettings(profileId) {
  const profile = currentProfile(profileId);
  const pending = profilePendingSet(profileId);
  if (!profile) {
    if (!pending.has('load') && state.mcp.profileNotice[profileId]?.action !== 'load') {
      void loadProfile(profileId);
    }
    if (pending.has('load')) return loadingView();
    const message = state.mcp.profileNotice[profileId]?.message || state.mcp.profilesError || 'The connection profile is unavailable.';
    return `${pageHead('Connection settings', 'Managed connection', 'BotBoy manages this local MCP connection.', `<a class="button" href="#/connections">Back</a><button class="button" type="button" data-action="profile-action" data-profile="${attr(profileId)}" data-act="check">Check again</button>`)} ${errorView(message)}`;
  }

  const installation = {
    installed: { label: 'Installed', tone: 'good' },
    not_installed: { label: 'Not installed', tone: 'warn' },
    unchecked: { label: 'Not checked', tone: '' },
  }[profile.installationState] || { label: 'Unknown', tone: 'warn' };
  const processState = {
    needs_configuration: { label: 'Needs setup', tone: 'warn' },
    stopped: { label: 'Stopped', tone: '' },
    starting: { label: 'Starting', tone: '' },
    running: { label: 'Running', tone: 'good' },
    degraded: { label: 'Connection issue', tone: 'warn' },
    failed: { label: 'Failed', tone: 'warn' },
  }[profile.state] || { label: 'Unknown', tone: 'warn' };
  const compatibility = {
    unchecked: { label: 'Not tested', tone: '' },
    compatible: { label: 'Compatible', tone: 'good' },
    incompatible: { label: 'Update needed', tone: 'warn' },
  }[profile.compatibilityState] || { label: 'Unknown', tone: 'warn' };
  const guide = profile.guide || {};
  const steps = Array.isArray(guide.steps) ? guide.steps : [];
  const running = ['starting', 'running', 'degraded'].includes(profile.state);
  const busy = pending.size > 0;
  const installed = profile.installationState === 'installed';
  const canSetup = installed && !profile.enabled && !running && !busy;
  const canStart = installed && !profile.enabled && !running && !busy;
  const canTest = profile.state === 'running' && !busy;
  const canStop = (profile.enabled || running) && !busy;
  const requiredTools = Array.isArray(profile.requiredTools) ? profile.requiredTools : [];
  const missingTools = Array.isArray(profile.missingTools) ? profile.missingTools : [];
  const notice = state.mcp.profileNotice[profileId];
  const noticeTone = notice?.tone === 'good' ? 'good' : notice?.tone === 'warn' ? 'warn' : '';
  const pendingLabel = action => pending.has(action);
  const actionButton = (act, label, pendingText, ico, enabled, primary = false) =>
    `<button class="button${primary ? ' primary' : ''}" type="button" data-action="profile-action" data-profile="${attr(profileId)}" data-act="${attr(act)}" ${enabled ? '' : 'disabled'}>${icon(ico)} ${pendingLabel(act) ? pendingText : label}</button>`;

  const nextActions = guide.nextActions || {};
  let nextAction = nextActions.default || 'Follow the setup steps in order.';
  if (profile.needsReview) nextAction = 'Review the configuration BotBoy wrote. Press Start to approve and launch it.';
  else if (!installed) nextAction = nextActions.notInstalled || nextAction;
  else if (profile.state === 'starting') nextAction = nextActions.starting || nextAction;
  else if (profile.state === 'failed' || profile.state === 'degraded') nextAction = nextActions.failed || nextAction;
  else if (profile.state === 'running' && profile.compatibilityState === 'unchecked') nextAction = nextActions.runningUnchecked || nextAction;
  else if (profile.state === 'running' && profile.compatibilityState === 'incompatible') nextAction = nextActions.runningIncompatible || nextAction;
  else if (profile.state === 'running' && profile.compatibilityState === 'compatible') nextAction = nextActions.runningCompatible || nextAction;

  const stepsHtml = steps.map((step, index) => {
    const parts = [`<h3>${number(index + 1)}. ${esc(step.title)}</h3>`, `<p>${esc(step.description)}</p>`];
    if (step.command) parts.push(`<pre><code>${esc(step.command)}</code></pre>`);
    if (step.action) parts.push(actionButton(step.action.id, step.action.label, step.action.pendingLabel, step.action.icon || 'settings', canSetup));
    if (step.lifecycle) {
      parts.push(`<div class="mcp-form-actions">${actionButton('start', 'Start', 'Starting…', 'activity', canStart, true)}${actionButton('test', 'Test', 'Testing…', 'check', canTest)}${actionButton('stop', 'Stop', 'Stopping…', 'close', canStop)}</div>`);
    }
    return `<div class="mcp-section">${parts.join('')}</div>`;
  }).join('');

  const sidePanels = (Array.isArray(guide.sidePanels) ? guide.sidePanels : [])
    .map(panel => `<article class="card pad"><div class="eyebrow">${icon(panel.icon || 'shield', 14)} ${esc(panel.eyebrow)}</div><h3 class="card-title">${esc(panel.title)}</h3><p class="page-subtitle">${esc(panel.body)}</p></article>`)
    .join('');

  const isCustom = profile.custom === true;
  const canDelete = isCustom && !profile.enabled && !running && !busy && !state.mcp.serverForm.deleting;
  const customActions = isCustom
    ? `<a class="button" href="#/connections/${encodeURIComponent(profileId)}/edit">${icon('settings')} Edit</a><button class="button" type="button" data-action="mcp-server-delete" data-profile="${attr(profileId)}" ${canDelete ? '' : 'disabled'}>${icon('close')} ${state.mcp.serverForm.deleting ? 'Deleting…' : 'Delete'}</button>`
    : '';
  const toolsSection = isCustom
    ? `<div class="mcp-section"><h3>Discovered tools</h3><p>Tool names and descriptions come from the server after Start and Test. BotBoy can call read tools freely; tools marked write run only on your explicit request in chat.</p>${(profile.tools || []).length
      ? (profile.tools || []).map(tool => `<div class="health-row"><span class="status-dot ${tool.risk === 'read' ? 'good' : ''}"></span><span><strong>${esc(tool.name)}</strong>${tool.description ? `<small>${esc(tool.description)}</small>` : ''}</span><span class="pill">${esc(tool.risk || 'unknown')}</span></div>`).join('')
      : '<p class="page-subtitle">No tools discovered yet. Start the server, then run Test.</p>'}</div>`
    : '';

  const askPrompt = `Set up the ${profile.displayName} MCP connection for me. Check its current status, run the safe lifecycle steps, and walk me through each setup-terminal command that needs my authentication.`;
  return `<div class="breadcrumb"><a href="#/connections">Connections</a>${icon('chevron-right', 11)}<span>${esc(guide.breadcrumb || profile.displayName)}</span></div>
    ${pageHead('Connection settings', profile.displayName, guide.pageSubtitle || 'BotBoy manages this local MCP connection.', `<a class="button" href="#/connections">Back</a><button class="button" type="button" data-prompt="${attr(askPrompt)}">${icon('sparkles')} Ask BotBoy to set up</button>${customActions}<button class="button" type="button" data-action="profile-action" data-profile="${attr(profileId)}" data-act="check" ${busy ? 'disabled' : ''}>${icon('refresh')} ${pendingLabel('check') ? 'Checking…' : 'Check installation'}</button>`)}
    <section class="grid three-col">
      <article class="card pad"><div class="metric-label">Installation</div><div class="metric-value" style="font-size:24px">${esc(installation.label)}</div><div class="metric-note ${installation.tone}">Local executable</div></article>
      <article class="card pad"><div class="metric-label">Process</div><div class="metric-value" style="font-size:24px">${esc(processState.label)}</div><div class="metric-note ${processState.tone}">Managed by BotBoy</div></article>
      <article class="card pad"><div class="metric-label">Compatibility</div><div class="metric-value" style="font-size:24px">${esc(compatibility.label)}</div><div class="metric-note ${compatibility.tone}">Protocol and tool check only</div></article>
    </section>
    <section class="grid mcp-settings-grid" style="margin-top:16px">
      <article class="card mcp-form">
        <div class="card-header"><div><h2 class="card-title">${esc(guide.setupHeading?.title || 'Local setup')}</h2><div class="card-meta">${esc(guide.setupHeading?.subtitle || 'Run the fixed steps for this connection.')}</div></div><span class="pill ${processState.tone}"><span class="status-dot ${processState.tone}"></span>${esc(processState.label)}</span></div>
        ${profile.needsReview ? `<div class="mcp-alert">${icon('shield', 15)}<span>BotBoy wrote this configuration on your request. Review the command, arguments, and environment below (Edit shows the full definition). Pressing Start approves and launches it.</span></div>` : ''}
        ${profile.lastError ? `<div class="mcp-alert">${icon('alert', 15)}<span>${esc(profile.lastError)}</span></div>` : ''}
        ${notice?.message ? `<div class="mcp-alert ${noticeTone}">${icon(noticeTone === 'good' ? 'check' : 'activity', 15)}<span>${esc(notice.message)}</span></div>` : ''}
        <div class="mcp-form-body">${stepsHtml || `<div class="mcp-section"><h3>Server lifecycle</h3><p>BotBoy manages this connection. Use Start, Test, and Stop.</p><div class="mcp-form-actions">${actionButton('start', 'Start', 'Starting…', 'activity', canStart, true)}${actionButton('test', 'Test', 'Testing…', 'check', canTest)}${actionButton('stop', 'Stop', 'Stopping…', 'close', canStop)}</div></div>`}${renderTerminalPanel(profile, pending)}${toolsSection}</div>
      </article>
      <aside class="mcp-side">
        <article class="card pad"><div class="eyebrow">${icon('chevron-right', 14)} Next safe action</div><h3 class="card-title">Continue in order</h3><p class="page-subtitle">${esc(nextAction)}</p></article>
        ${renderAnalyticsContextCard(profileId)}
        ${sidePanels}
        ${requiredTools.length
    ? `<article class="card pad"><div class="eyebrow">${icon('activity', 14)} Required tools</div><h3 class="card-title">${number(requiredTools.length - missingTools.length)} of ${number(requiredTools.length)} found</h3><p class="page-subtitle">${missingTools.length ? `Missing: ${missingTools.map(name => esc(name)).join(', ')}` : profile.compatibilityState === 'compatible' ? 'All fixed tool names are present.' : 'Start and test the server to check tool names.'}</p>${profile.lastHealthyAt ? `<div class="mcp-fact"><span>Last healthy</span><strong>${esc(relativeTime(profile.lastHealthyAt))}</strong></div>` : ''}</article>`
    : `<article class="card pad"><div class="eyebrow">${icon('activity', 14)} Discovered tools</div><h3 class="card-title">${number((profile.tools || []).length)} available</h3><p class="page-subtitle">${(profile.tools || []).length ? 'Tool names and descriptions are listed on this page for your review.' : 'Start the server, then run Test to discover tools.'}</p>${profile.lastHealthyAt ? `<div class="mcp-fact"><span>Last healthy</span><strong>${esc(relativeTime(profile.lastHealthyAt))}</strong></div>` : ''}</article>`}
      </aside>
    </section>`;
}

/** Analytics knowledge directory card — a2-analytics connection page only.
 * BotBoy loads .md/.txt files from this local directory on demand to ground
 * data questions (generated presets under presets/, user notes at the root). */
function renderAnalyticsContextCard(profileId) {
  if (profileId !== 'a2-analytics') return '';
  const ctx = state.mcp.analyticsContext;
  if (!ctx && !state.mcp.analyticsContextPending) void loadAnalyticsContextConfig();
  return `<article class="card pad"><div class="eyebrow">${icon('file', 14)} Analytics knowledge</div>
    <h3 class="card-title">${ctx ? `${number(ctx.fileCount)} knowledge file${ctx.fileCount === 1 ? '' : 's'}` : 'Loading…'}</h3>
    <p class="page-subtitle">BotBoy grounds data questions in local .md/.txt files from this directory — drop your schema or methodology notes at the root; generated business presets land under presets/. Loaded on demand, one file per task.</p>
    ${ctx ? `<div class="mcp-fact"><span>Directory</span><strong style="word-break:break-all">${esc(ctx.dir)}</strong></div>
    <label class="page-subtitle" for="analytics-context-dir" style="display:block;margin-top:8px">Use a different directory (leave empty for the default)</label>
    <input id="analytics-context-dir" type="text" value="${attr(ctx.configured || '')}" placeholder="${attr(ctx.dir)}" style="width:100%"/>
    <div style="margin-top:8px"><button class="button small" type="button" data-action="analytics-context-save">Save directory</button></div>
    ${renderEtlOnboardingSection(ctx.onboarding)}` : ''}
  </article>`;
}

/** ETL preset generation (etl-analytics A3) — status line + manual trigger.
 * Refresh is manual-only by design; a run in flight polls every 5s. */
function renderEtlOnboardingSection(onboarding) {
  const ob = onboarding || { state: 'idle' };
  let statusLine = 'BotBoy can scan your team\'s Datanet profiles and generate one knowledge preset per business.';
  if (ob.state === 'running') {
    const p = ob.progress || {};
    const bits = [];
    if (p.profilesTotal) bits.push(`${number(p.profilesFetched || 0)}/${number(p.profilesTotal)} profiles`);
    if (p.businessesTotal) bits.push(`${number(p.businessesDone || 0)}/${number(p.businessesTotal)} briefs${p.currentBusiness ? ` — ${esc(p.currentBusiness)}` : ''}`);
    statusLine = `Generating (${esc(ob.phase || 'working')})${bits.length ? ` · ${bits.join(' · ')}` : ''}…`;
  } else if (ob.state === 'failed') {
    statusLine = `Last run failed: ${esc(ob.error || 'unknown error')}${ob.nextAction ? ` ${esc(ob.nextAction)}` : ''}`;
  } else if (ob.lastResult) {
    const r = ob.lastResult;
    statusLine = `Last generated ${esc(String(r.finishedAt || '').slice(0, 10))}: ${number(r.presetsWritten)} preset${r.presetsWritten === 1 ? '' : 's'} from ${number(r.profiles)} profiles${(r.businesses || []).length ? ` (${esc(r.businesses.join(', '))})` : ''}.`;
  }
  return `<div style="margin-top:14px;border-top:1px solid var(--line, #333);padding-top:10px">
    <div class="eyebrow">${icon('sparkles', 14)} Preset generation</div>
    <p class="page-subtitle">${statusLine}</p>
    ${ob.state === 'running' ? '' : `<div style="margin-top:8px;display:flex;gap:8px">
      <button class="button small" type="button" data-action="analytics-context-generate">Generate presets</button>
      ${ob.lastResult ? `<button class="button small ghost" type="button" data-action="analytics-context-regenerate">Regenerate all</button>` : ''}
    </div>`}
  </div>`;
}

let analyticsOnboardingPollTimer = null;
function scheduleAnalyticsOnboardingPoll() {
  clearTimeout(analyticsOnboardingPollTimer);
  const running = state.mcp.analyticsContext?.onboarding?.state === 'running';
  if (!running || state.route.view !== 'profile-settings') return;
  analyticsOnboardingPollTimer = setTimeout(() => void loadAnalyticsContextConfig(), 5000);
}

async function loadAnalyticsContextConfig() {
  state.mcp.analyticsContextPending = true;
  try {
    state.mcp.analyticsContext = await request('/mcp/analytics-context');
  } catch (error) {
    state.mcp.analyticsContext = { dir: '', configured: '', fileCount: 0, error: String(error?.message || error) };
  }
  state.mcp.analyticsContextPending = false;
  if (state.route.view === 'profile-settings') renderRoute({ preserveScroll: true });
  scheduleAnalyticsOnboardingPoll();
}

// ── Embedded setup terminal ──

/** Strip ANSI escape sequences for readable plain-text display. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\u001b[()][0-9A-B]/g, '');
}

function terminalStateFor(profileId) {
  return state.mcp.terminal.profileId === profileId ? state.mcp.terminal : null;
}

function appendTerminalOutput(chunk) {
  const terminal = state.mcp.terminal;
  terminal.output = (terminal.output + stripAnsi(chunk)).slice(-100000);
  const pane = document.getElementById('mcp-terminal-output');
  if (pane) {
    pane.textContent = terminal.output;
    pane.scrollTop = pane.scrollHeight;
  }
}

function closeTerminalStream() {
  const terminal = state.mcp.terminal;
  if (terminal.source) {
    terminal.source.close();
    terminal.source = null;
  }
}

function attachTerminalStream(profileId, session) {
  const terminal = state.mcp.terminal;
  closeTerminalStream();
  const source = new EventSource(`${API}/mcp/profiles/${encodeURIComponent(profileId)}/terminal/${encodeURIComponent(session.id)}/stream`);
  terminal.source = source;
  source.addEventListener('output', event => {
    try { appendTerminalOutput(JSON.parse(event.data).chunk); } catch {}
  });
  source.addEventListener('end', event => {
    try {
      const payload = JSON.parse(event.data);
      terminal.session = payload.session;
    } catch {}
    closeTerminalStream();
    const status = terminal.session?.status;
    if (status === 'completed') toast(`${terminal.session.title} completed`);
    else if (status && status !== 'running') toast(`${terminal.session.title} ${status.replace('_', ' ')}`, status === 'stopped' ? '' : 'bad');
    // Refresh profile state after a finished step (installation may change).
    void loadProfile(profileId, { force: true });
    if (state.route.view === 'profile-settings') renderRoute({ preserveScroll: true });
  });
  source.onerror = () => { /* keep-alive gaps are normal; end event closes cleanly */ };
}

async function startTerminalCommand(profileId, commandId) {
  const terminal = state.mcp.terminal;
  if (terminal.starting || terminal.session?.status === 'running') return;
  terminal.starting = true;
  terminal.profileId = profileId;
  terminal.output = '';
  renderRoute({ preserveScroll: true, userAction: true });
  try {
    const payload = await request(`/mcp/profiles/${encodeURIComponent(profileId)}/terminal`, {
      method: 'POST',
      body: { commandId },
    });
    terminal.session = payload.session;
    attachTerminalStream(profileId, payload.session);
  } catch (error) {
    terminal.session = null;
    toast(`Could not start the command: ${error.message}`, 'bad');
  } finally {
    terminal.starting = false;
    if (state.route.view === 'profile-settings') renderRoute({ preserveScroll: true, userAction: true });
  }
}

async function sendTerminalInput(profileId) {
  const terminal = terminalStateFor(profileId);
  const input = document.getElementById('mcp-terminal-input');
  if (!terminal || !terminal.session || terminal.session.status !== 'running' || !input) return;
  const value = input.value;
  if (!value.trim() && value.length === 0) return;
  if (terminal.sending) return;
  terminal.sending = true;
  try {
    await request(`/mcp/profiles/${encodeURIComponent(profileId)}/terminal/${encodeURIComponent(terminal.session.id)}/input`, {
      method: 'POST',
      body: { data: `${value}\n` },
    });
    input.value = '';
    input.focus();
  } catch (error) {
    toast(`Could not send input: ${error.message}`, 'bad');
  } finally {
    terminal.sending = false;
  }
}

async function stopTerminalCommand(profileId) {
  const terminal = terminalStateFor(profileId);
  if (!terminal || !terminal.session || terminal.session.status !== 'running') return;
  try {
    await request(`/mcp/profiles/${encodeURIComponent(profileId)}/terminal/${encodeURIComponent(terminal.session.id)}/stop`, {
      method: 'POST',
      body: {},
    });
  } catch (error) {
    toast(`Could not stop the command: ${error.message}`, 'bad');
  }
}

function renderTerminalPanel(profile, pending) {
  const commands = Array.isArray(profile.terminalCommands) ? profile.terminalCommands : [];
  if (!commands.length) return '';
  const profileId = profile.id;
  const terminal = terminalStateFor(profileId);
  const session = terminal?.session || null;
  const running = session?.status === 'running';
  const busy = running || state.mcp.terminal.starting || pending.size > 0;
  const serverActive = ['starting', 'running', 'degraded'].includes(profile.state) || profile.enabled;
  const statusLabel = !session ? 'Idle'
    : session.status === 'running' ? `Running: ${session.title}`
      : `${session.title}: ${session.status.replace('_', ' ')}`;
  const statusTone = session?.status === 'running' ? 'good'
    : session?.status === 'completed' ? 'good'
      : session && session.status !== 'stopped' ? 'warn' : '';
  return `<div class="mcp-section"><h3>Setup terminal</h3>
    <p>Run the approved setup commands inside BotBoy. The terminal is interactive: enter your Midway PIN when prompted, touch your security key, and complete browser logins. Only these fixed commands can run.</p>
    <div class="mcp-form-actions">${commands.map(command => {
      const blocked = busy || (command.requiresStopped && serverActive);
      const hint = command.requiresStopped && serverActive ? ' (stop the server first)' : '';
      return `<button class="button small" type="button" data-action="terminal-run" data-profile="${attr(profileId)}" data-command="${attr(command.id)}" ${blocked ? 'disabled' : ''} title="${attr(command.description + hint)}">${icon('chevron-right', 12)} ${esc(command.title)}</button>`;
    }).join('')}</div>
    <div class="mcp-terminal">
      <div class="mcp-terminal-head"><span class="pill ${statusTone}"><span class="status-dot ${statusTone}"></span>${esc(statusLabel)}</span>${running ? `<button class="button small" type="button" data-action="terminal-stop" data-profile="${attr(profileId)}">${icon('close', 12)} Stop</button>` : ''}</div>
      <pre id="mcp-terminal-output" class="mcp-terminal-output" aria-live="polite" aria-label="Setup terminal output">${esc(terminal?.output || 'No command is running. Select a setup command above.')}</pre>
      <div class="mcp-terminal-input-row">
        <input id="mcp-terminal-input" type="password" autocomplete="off" placeholder="${running ? 'Type input (PIN entries stay masked) and press Enter' : 'Start a command to enable input'}" ${running ? '' : 'disabled'} data-terminal-input="${attr(profileId)}">
        <button class="button small" type="button" data-action="terminal-send" data-profile="${attr(profileId)}" ${running ? '' : 'disabled'}>Send</button>
      </div>
    </div>
  </div>`;
}

async function runProfileAction(profileId, action) {
  const profile = currentProfile(profileId);
  const copy = profile?.guide?.actionCopy?.[action] || {
    pending: `Running ${action}…`,
    success: `The ${action} action completed.`,
    failure: `Could not complete the ${action} action`,
  };
  const pending = profilePendingSet(profileId);
  if (pending.size > 0) return;

  pending.add(action);
  state.mcp.profileNotice[profileId] = { action, tone: '', message: copy.pending };
  renderRoute({ userAction: true });
  try {
    const payload = await request(`/mcp/profiles/${encodeURIComponent(profileId)}/actions/${encodeURIComponent(action)}`, { method: 'POST', body: {} });
    storeProfile(payload.profile);
    const message = typeof payload.result?.message === 'string' ? payload.result.message : copy.success;
    state.mcp.profileNotice[profileId] = { action, tone: 'good', message };
    toast(message);
  } catch (error) {
    const refreshed = await loadProfile(profileId, { force: true });
    const message = action === 'test' && refreshed?.compatibilityState === 'incompatible' && copy.incompatible
      ? copy.incompatible
      : `${copy.failure}: ${error.message}`;
    state.mcp.profileNotice[profileId] = { action, tone: 'warn', message };
    toast(message, 'bad');
  } finally {
    pending.delete(action);
    if (state.route.view === 'profile-settings') renderRoute({ userAction: true });
  }
}

async function loadCustomServerConfig(profileId) {
  if (state.mcp.serverForm.loadingConfig) return;
  state.mcp.serverForm.loadingConfig = true;
  state.mcp.serverForm.error = '';
  try {
    const payload = await request(`/mcp/servers/${encodeURIComponent(profileId)}/config`);
    state.mcp.serverForm.config = payload.config;
  } catch (error) {
    state.mcp.serverForm.error = error.message;
  } finally {
    state.mcp.serverForm.loadingConfig = false;
    if (state.route.view === 'mcp-edit') renderRoute();
  }
}

function collectMcpServerForm() {
  const form = document.getElementById('mcp-server-form');
  if (!form) throw new Error('The server form is unavailable');
  const value = name => (form.elements[name]?.value ?? '').trim();
  const name = value('name');
  const command = value('command');
  const args = (form.elements.args?.value ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const env = {};
  const envLines = (form.elements.env?.value ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of envLines) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Environment lines use NAME=value. Fix: "${line.slice(0, 60)}"`);
    env[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return { name, command, args, env };
}

/** Add and edit page for user-added MCP servers. */
function renderMcpServerForm({ editing = false, profileId = '' } = {}) {
  let config = { name: '', command: '', args: [], env: {} };
  if (editing) {
    const loaded = state.mcp.serverForm.config;
    if (!loaded || loaded.id !== profileId) {
      if (!state.mcp.serverForm.loadingConfig && !state.mcp.serverForm.error) {
        state.mcp.serverForm.config = null;
        void loadCustomServerConfig(profileId);
      }
      if (state.mcp.serverForm.loadingConfig || !state.mcp.serverForm.error) return loadingView();
      return `${pageHead('Connection settings', 'Edit MCP server', 'Update the local server definition.')} ${errorView(state.mcp.serverForm.error)}`;
    }
    config = loaded;
  }
  const saving = state.mcp.serverForm.saving;
  const envText = Object.entries(config.env || {}).map(([key, value]) => `${key}=${value}`).join('\n');
  const title = editing ? `Edit ${config.name || 'MCP server'}` : 'Add MCP server';
  const backHref = editing ? `#/connections/${encodeURIComponent(profileId)}` : '#/connections';
  const formAsk = editing
    ? `Help me fix the configuration of my MCP server "${config.name || profileId}" in BotBoy. Read its current definition with mcp_get_custom_server_config, check its status and last error, and propose a corrected definition with mcp_update_custom_server after confirming with me.`
    : 'I want to add a new MCP server to BotBoy. I will paste a link to its documentation, npm, or GitHub page. Fetch the link, derive the launch command, arguments, and environment variables, confirm anything ambiguous with me, then add it with mcp_add_custom_server so I can review and start it.';
  return `<div class="breadcrumb"><a href="#/connections">Connections</a>${icon('chevron-right', 11)}<span>${esc(editing ? 'Edit server' : 'Add server')}</span></div>
    ${pageHead('Connection settings', title, 'BotBoy starts the command directly without a shell and supervises the process. Reads run freely; writes need your explicit request in chat.', `<a class="button" href="${attr(backHref)}">Back</a><button class="button" type="button" data-prompt="${attr(formAsk)}">${icon('sparkles')} Ask BotBoy to do it</button>`)}
    <section class="grid mcp-settings-grid">
      <form id="mcp-server-form" class="card mcp-form" onsubmit="return false">
        <div class="card-header"><div><h2 class="card-title">${esc(editing ? 'Server definition' : 'New server definition')}</h2><div class="card-meta">Only you can add servers, and only from this machine.</div></div></div>
        ${state.mcp.serverForm.error ? `<div class="mcp-alert">${icon('alert', 15)}<span>${esc(state.mcp.serverForm.error)}</span></div>` : ''}
        <div class="mcp-form-body">
          <label class="mcp-field"><span>Display name</span><input name="name" type="text" value="${attr(config.name)}" placeholder="Design Atlas" required></label>
          <div class="mcp-section"><h3>Launch command</h3><p>Give one executable name from PATH or one absolute path. Put every flag on its own arguments line.</p>
            <label class="mcp-field"><span>Command</span><input name="command" type="text" value="${attr(config.command)}" placeholder="uvx" required></label>
            <label class="mcp-field"><span>Arguments (one per line)</span><textarea name="args" rows="4" placeholder="my-mcp-server@latest">${esc((config.args || []).join('\n'))}</textarea></label>
          </div>
          <div class="mcp-section"><h3>Environment variables</h3><p>One NAME=value per line. Values stay in the local database, so prefer short-lived credentials.</p>
            <label class="mcp-field"><span>Variables</span><textarea name="env" rows="4" placeholder="FASTMCP_LOG_LEVEL=ERROR">${esc(envText)}</textarea></label>
          </div>
          <div class="mcp-form-actions">
            <button class="button primary" type="button" data-action="mcp-server-save" data-mode="${editing ? 'edit' : 'add'}" data-profile="${attr(profileId)}" ${saving ? 'disabled' : ''}>${icon('check')} ${saving ? 'Saving…' : editing ? 'Save changes' : 'Add server'}</button>
          </div>
        </div>
      </form>
      <aside class="mcp-side">
        <article class="card pad"><div class="eyebrow">${icon('shield', 14)} Agent boundary</div><h3 class="card-title">Reads are free, writes need your request</h3><p class="page-subtitle">BotBoy can call this server's read tools whenever they help. Tools that change data run only when you explicitly ask in chat, and every call is audited.</p></article>
        <article class="card pad"><div class="eyebrow">${icon('activity', 14)} Lifecycle</div><h3 class="card-title">Managed by BotBoy</h3><p class="page-subtitle">After you add the server, use Start, Test, and Stop on its connection page. Health checks and restarts are automatic while it stays enabled.</p></article>
      </aside>
    </section>`;
}

async function saveMcpServer(mode, profileId) {
  if (state.mcp.serverForm.saving) return;
  let payload;
  try {
    payload = collectMcpServerForm();
  } catch (error) {
    state.mcp.serverForm.error = error.message;
    toast(error.message, 'bad');
    renderRoute({ userAction: true });
    return;
  }
  state.mcp.serverForm.saving = true;
  state.mcp.serverForm.error = '';
  renderRoute({ userAction: true });
  try {
    const response = mode === 'edit'
      ? await request(`/mcp/servers/${encodeURIComponent(profileId)}/config`, { method: 'PUT', body: payload })
      : await request('/mcp/servers', { method: 'POST', body: payload });
    storeProfile(response.profile);
    state.mcp.serverForm.config = null;
    toast(mode === 'edit' ? 'Server definition saved' : `${payload.name} added`);
    go(`#/connections/${response.profile.id}`);
  } catch (error) {
    state.mcp.serverForm.error = error.message;
    toast(`Could not save the server: ${error.message}`, 'bad');
  } finally {
    state.mcp.serverForm.saving = false;
    if (state.route.view === 'mcp-add' || state.route.view === 'mcp-edit') renderRoute({ userAction: true });
  }
}

async function deleteMcpServer(profileId) {
  if (state.mcp.serverForm.deleting) return;
  const profile = currentProfile(profileId);
  const label = profile?.displayName || 'this MCP server';
  if (!window.confirm(`Delete ${label}? The definition and its local call audit are removed. This cannot be undone.`)) return;
  state.mcp.serverForm.deleting = true;
  try {
    await request(`/mcp/servers/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
    state.mcp.servers = (state.mcp.servers || []).filter(server => server.id !== profileId);
    toast(`${label} deleted`);
    go('#/connections');
  } catch (error) {
    toast(`Could not delete the server: ${error.message}`, 'bad');
  } finally {
    state.mcp.serverForm.deleting = false;
  }
}

async function loadMcpConfig({ force = false } = {}) {
  if (state.mcp.loading || (state.mcp.config && !force)) return;
  state.mcp.loading = true;
  try {
    const payload = await request('/mcp/sql-context/config');
    state.mcp.config = payload.config;
    mergeServerSnapshot(payload.server);
    state.mcp.configError = '';
  } catch (error) {
    state.mcp.configError = error.message;
  } finally {
    state.mcp.loading = false;
    if (state.route.view === 'mcp-settings') renderRoute();
  }
}

function currentMcpServer() {
  return state.mcp.servers?.find(server => server.id === 'sql-context') || null;
}

function mcpField(name, label, value, options = {}) {
  const type = options.type || 'text';
  const attrs = [
    `name="${attr(name)}"`, `type="${attr(type)}"`, `value="${attr(value || '')}"`,
    options.placeholder ? `placeholder="${attr(options.placeholder)}"` : '',
    options.autocomplete ? `autocomplete="${attr(options.autocomplete)}"` : '',
    options.required ? 'required' : '',
    options.min ? `min="${attr(options.min)}"` : '',
    options.max ? `max="${attr(options.max)}"` : '',
  ].filter(Boolean).join(' ');
  return `<label class="mcp-field"><span>${esc(label)}</span><input ${attrs}>${options.help ? `<small>${esc(options.help)}</small>` : ''}</label>`;
}

function renderMcpSettings() {
  if (!state.mcp.config && !state.mcp.configError) {
    void loadMcpConfig();
    return loadingView();
  }
  if (!state.mcp.config) {
    return `${pageHead('Connection settings', 'SQL analytics', 'A managed, read-only Redshift connection.')} ${errorView(state.mcp.configError)}`;
  }
  const config = state.mcp.config;
  const server = currentMcpServer();
  const stateLabel = !config.configured ? 'Needs setup'
    : server?.state === 'running' ? 'Connected'
      : server?.state === 'degraded' ? 'Connection issue'
        : config.enabled ? 'Starting' : 'Disabled';
  const stateTone = server?.state === 'running' ? 'good'
    : server?.state === 'degraded' || server?.state === 'failed' ? 'warn' : '';
  const contextPlaceholder = config.contextSource === 's3' ? 's3://bucket/schema-contexts/'
    : config.contextSource === 'url' ? 'https://docs.example.com/analytics.md'
      : config.contextSource === 'directory' ? '/Users/you/schema-contexts'
        : config.contextSource === 'file' ? '/Users/you/schema-context.md' : '';
  const contextLabel = config.contextSource === 'none' ? 'No schema source selected' : 'Schema context location';
  const canTest = config.enabled && config.configured && !state.mcp.testing;

  return `<div class="breadcrumb"><a href="#/connections">Connections</a>${icon('chevron-right', 11)}<span>SQL analytics</span></div>
    ${pageHead('Connection settings', 'SQL analytics', 'Connect BotBoy to Redshift for governed business analysis, schema presets, and scheduled dashboards.', `<a class="button" href="#/connections">Back</a><button class="button" type="button" data-prompt="${attr('Help me configure the SQL / Redshift analytics connection in BotBoy. Check its status with mcp_status, explain what is missing or failing, and guide me through the connection form fields. Do not guess credentials.')}">${icon('sparkles')} Ask BotBoy</button><button class="button" type="button" data-action="mcp-restart" ${!config.enabled || state.mcp.restarting ? 'disabled' : ''}>${icon('refresh')} ${state.mcp.restarting ? 'Restarting…' : 'Restart'}</button><button class="button primary" type="button" data-action="mcp-test" ${canTest ? '' : 'disabled'}>${icon('activity')} ${state.mcp.testing ? 'Testing…' : 'Test connection'}</button>`)}
    <section class="grid mcp-settings-grid">
      <form id="mcp-config-form" class="card mcp-form">
        <div class="card-header"><div><h2 class="card-title">Redshift connection</h2><div class="card-meta">Only connection choices are configurable; BotBoy manages the MCP process.</div></div><span class="pill ${stateTone}"><span class="status-dot ${stateTone}"></span>${esc(stateLabel)}</span></div>
        ${server?.lastError ? `<div class="mcp-alert">${icon('alert', 15)}<span>${esc(server.lastError)}</span></div>` : ''}
        <div class="mcp-form-body">
          <label class="mcp-toggle-row"><span><strong>Enable SQL analytics</strong><small>Start and supervise the connection automatically with BotBoy.</small></span><input name="enabled" type="checkbox" ${config.enabled ? 'checked' : ''}></label>
          <div class="mcp-section"><h3>Authentication</h3><p>IAM is recommended because credentials are temporary and no database password is stored.</p>
            <label class="mcp-field"><span>Authentication method</span><select name="authMethod" id="mcp-auth-method"><option value="iam" ${config.authMethod === 'iam' ? 'selected' : ''}>AWS IAM (recommended)</option><option value="secrets_manager" ${config.authMethod === 'secrets_manager' ? 'selected' : ''}>AWS Secrets Manager</option><option value="direct" ${config.authMethod === 'direct' ? 'selected' : ''}>Database username and password</option></select></label>
            <div class="mcp-field-grid" data-auth-only="direct,iam">
              ${mcpField('host', 'Redshift host', config.host, { placeholder: 'cluster.region.redshift.amazonaws.com' })}
              ${mcpField('port', 'Port', String(config.port), { type: 'number', min: '1', max: '65535' })}
              ${mcpField('database', 'Database', config.database, { placeholder: 'analytics' })}
              ${mcpField('username', 'Database user', config.username, { placeholder: 'botboy_readonly', autocomplete: 'username' })}
            </div>
            <div class="mcp-field-grid" data-auth-only="iam">
              ${mcpField('clusterId', 'Redshift cluster identifier', config.clusterId, { placeholder: 'analytics-cluster' })}
            </div>
            <div class="mcp-field-grid" data-auth-only="secrets_manager">
              ${mcpField('secretId', 'Secrets Manager secret name or ARN', config.secretId, { placeholder: 'analytics/redshift/readonly' })}
            </div>
            <div class="mcp-field-grid" data-auth-only="iam,secrets_manager">
              ${mcpField('awsRegion', 'AWS region', config.awsRegion, { placeholder: 'us-east-1' })}
              ${mcpField('awsProfile', 'AWS profile (optional)', config.awsProfile, { placeholder: 'ReadOnly' })}
            </div>
            <div data-auth-only="direct">
              <div class="mcp-field-grid">
                ${mcpField('password', config.passwordConfigured ? 'Replace stored password' : 'Database password', '', { type: 'password', autocomplete: 'new-password', help: config.passwordConfigured ? 'A password is already stored in macOS Keychain. Leave blank to keep it.' : 'Stored in macOS Keychain, never in BotBoy’s database.' })}
              </div>
              ${config.passwordConfigured ? '<label class="mcp-check"><input name="clearPassword" type="checkbox"> Remove the password currently stored in Keychain</label>' : ''}
            </div>
          </div>
          <div class="mcp-section"><h3>Transport security</h3><p>Certificate and hostname verification is the safe default for production Redshift endpoints.</p>
            <label class="mcp-field"><span>TLS mode</span><select name="sslMode"><option value="verify-full" ${config.sslMode === 'verify-full' ? 'selected' : ''}>Verify certificate and hostname (recommended)</option><option value="verify-ca" ${config.sslMode === 'verify-ca' ? 'selected' : ''}>Verify certificate authority</option><option value="require" ${config.sslMode === 'require' ? 'selected' : ''}>Encrypt without certificate verification</option><option value="disable" ${config.sslMode === 'disable' ? 'selected' : ''}>Disable TLS (local tunnel only)</option></select></label>
            <details class="mcp-advanced"><summary>Custom certificate files</summary><div class="mcp-field-grid">${mcpField('sslCaPath', 'CA certificate path', config.sslCaPath, { placeholder: '/path/to/ca.pem' })}${mcpField('sslCertPath', 'Client certificate path', config.sslCertPath, { placeholder: '/path/to/client.pem' })}${mcpField('sslKeyPath', 'Client key path', config.sslKeyPath, { placeholder: '/path/to/client.key' })}</div></details>
          </div>
          <div class="mcp-section"><h3>Schema knowledge</h3><p>Optional presets teach BotBoy required filters, business definitions, joins, and trusted query patterns.</p>
            <label class="mcp-field"><span>Preset source</span><select name="contextSource" id="mcp-context-source"><option value="none" ${config.contextSource === 'none' ? 'selected' : ''}>None</option><option value="directory" ${config.contextSource === 'directory' ? 'selected' : ''}>Local directory</option><option value="file" ${config.contextSource === 'file' ? 'selected' : ''}>Local file</option><option value="s3" ${config.contextSource === 's3' ? 'selected' : ''}>S3 prefix</option><option value="url" ${config.contextSource === 'url' ? 'selected' : ''}>HTTPS URL</option></select></label>
            <label class="mcp-field" id="mcp-context-value-wrap"><span id="mcp-context-value-label">${esc(contextLabel)}</span><input name="contextValue" value="${attr(config.contextValue)}" placeholder="${attr(contextPlaceholder)}"><small>Markdown and JSON presets are loaded by the managed connection.</small></label>
          </div>
        </div>
        <div class="mcp-form-actions"><span>${config.passwordConfigured ? `${icon('shield', 14)} Password protected by Keychain` : `${icon('shield', 14)} No password stored in BotBoy`}</span><button class="button primary" type="submit" ${state.mcp.saving ? 'disabled' : ''}>${state.mcp.saving ? 'Saving…' : 'Save connection'}</button></div>
      </form>
      <aside class="mcp-side">
        <article class="card pad"><div class="eyebrow">${icon('shield', 14)} Query policy</div><h3 class="card-title">Read-only by construction</h3><p class="page-subtitle">BotBoy accepts SELECT, WITH, EXPLAIN, and SHOW. It rejects writes, DDL, grants, transactions, multi-statements, and unsafe database functions before calling the MCP.</p></article>
        <article class="card pad"><div class="eyebrow">${icon('activity', 14)} Managed availability</div><h3 class="card-title">Lifecycle stays inside BotBoy</h3><p class="page-subtitle">Health checks, reconnects, process restarts, and discovered tools are maintained automatically. You configure the data source—not the server runtime.</p>${server?.lastHealthyAt ? `<div class="mcp-fact"><span>Last healthy</span><strong>${esc(relativeTime(server.lastHealthyAt))}</strong></div>` : ''}${server?.restartCount ? `<div class="mcp-fact"><span>Automatic restarts</span><strong>${number(server.restartCount)}</strong></div>` : ''}</article>
        <article class="card pad"><div class="eyebrow">${icon('database', 14)} Least privilege</div><h3 class="card-title">Use a dedicated read-only role</h3><p class="page-subtitle">Application policy is defense in depth. The Redshift user or IAM role should only have SELECT and the minimum schema/context permissions it needs.</p></article>
      </aside>
    </section>`;
}

function updateMcpFormVisibility() {
  const form = document.getElementById('mcp-config-form');
  if (!form) return;
  const auth = form.elements.authMethod?.value;
  form.querySelectorAll('[data-auth-only]').forEach(element => {
    element.hidden = !String(element.dataset.authOnly || '').split(',').includes(auth);
  });
  const source = form.elements.contextSource?.value;
  const wrap = document.getElementById('mcp-context-value-wrap');
  if (wrap) wrap.hidden = source === 'none';
  const label = document.getElementById('mcp-context-value-label');
  const input = form.elements.contextValue;
  const sourceDetails = {
    directory: ['Schema context directory', '/Users/you/schema-contexts'],
    file: ['Schema context file', '/Users/you/schema-context.md'],
    s3: ['Schema context S3 prefix', 's3://bucket/schema-contexts/'],
    url: ['Schema context HTTPS URL', 'https://docs.example.com/analytics.md'],
  };
  if (sourceDetails[source]) {
    if (label) label.textContent = sourceDetails[source][0];
    if (input) input.placeholder = sourceDetails[source][1];
  }
}

function collectMcpConfig() {
  const form = document.getElementById('mcp-config-form');
  if (!form) throw new Error('Connection form is unavailable');
  const value = name => form.elements[name]?.value ?? '';
  const payload = {
    enabled: Boolean(form.elements.enabled?.checked),
    authMethod: value('authMethod'),
    host: value('host'),
    port: Number(value('port') || 5439),
    database: value('database'),
    username: value('username'),
    clusterId: value('clusterId'),
    secretId: value('secretId'),
    awsRegion: value('awsRegion'),
    awsProfile: value('awsProfile'),
    sslMode: value('sslMode'),
    sslCaPath: value('sslCaPath'),
    sslCertPath: value('sslCertPath'),
    sslKeyPath: value('sslKeyPath'),
    contextSource: value('contextSource'),
    contextValue: value('contextValue'),
    clearPassword: Boolean(form.elements.clearPassword?.checked),
  };
  const password = value('password');
  if (password) payload.password = password;
  return payload;
}

async function saveMcpConfig() {
  if (state.mcp.saving) return;
  state.mcp.saving = true;
  try {
    const payload = await request('/mcp/sql-context/config', { method: 'PUT', body: collectMcpConfig() });
    state.mcp.config = payload.config;
    mergeServerSnapshot(payload.server);
    state.mcp.configError = '';
    toast(payload.config.enabled ? 'SQL analytics saved and managed connection started' : 'SQL analytics settings saved');
  } catch (error) {
    toast(`Could not save SQL connection: ${error.message}`, 'bad');
  } finally {
    state.mcp.saving = false;
    if (state.route.view === 'mcp-settings') renderRoute({ userAction: true });
  }
}

async function testMcpConnection() {
  if (state.mcp.testing) return;
  state.mcp.testing = true;
  renderRoute({ userAction: true });
  try {
    const payload = await request('/mcp/sql-context/test', { method: 'POST', body: {} });
    mergeServerSnapshot(payload.server);
    toast(payload.result?.text?.startsWith('Connected') ? 'Redshift connection is healthy' : 'Connection check completed');
  } catch (error) {
    await loadMcpConfig({ force: true });
    toast(`Connection test failed: ${error.message}`, 'bad');
  } finally {
    state.mcp.testing = false;
    if (state.route.view === 'mcp-settings') renderRoute({ userAction: true });
  }
}

async function restartMcpConnection() {
  if (state.mcp.restarting) return;
  state.mcp.restarting = true;
  renderRoute({ userAction: true });
  try {
    const payload = await request('/mcp/servers/sql-context/restart', { method: 'POST', body: {} });
    mergeServerSnapshot(payload.server);
    toast('Managed SQL connection restarted');
  } catch (error) {
    toast(`Could not restart connection: ${error.message}`, 'bad');
  } finally {
    state.mcp.restarting = false;
    if (state.route.view === 'mcp-settings') renderRoute({ userAction: true });
  }
}

// ── Local LLM generation usage (route-entry/manual refresh only) ──
async function loadLlmUsage({ force = false } = {}) {
  if (state.llmUsage.data?.requestedDays === state.llmUsage.days && !force && !state.llmUsage.error) return;
  const requestId = ++state.llmUsage.requestId;
  const requestedDays = state.llmUsage.days;
  state.llmUsage.loading = true;
  try {
    const params = new URLSearchParams({
      days: String(requestedDays),
      timeZone: state.llmUsage.timeZone,
    });
    const payload = await request(`/llm-usage/daily?${params.toString()}`);
    if (requestId !== state.llmUsage.requestId) return;
    state.llmUsage.data = payload;
    state.llmUsage.error = '';
  } catch (error) {
    if (requestId !== state.llmUsage.requestId) return;
    state.llmUsage.error = error.message;
  } finally {
    if (requestId !== state.llmUsage.requestId) return;
    state.llmUsage.loading = false;
    if (state.route.view === 'llm-usage-settings') renderRoute();
  }
}

// ── Explicitly confirmed S3/CloudFront snapshot publishing ──
async function loadPublisherConfig({ force = false } = {}) {
  if (state.publisher.loading || (state.publisher.config && !force)) return;
  state.publisher.loading = true;
  try {
    const payload = await request('/analytics/publisher');
    state.publisher.config = payload.publisher;
    state.publisher.error = '';
  } catch (error) {
    state.publisher.error = error.message;
  } finally {
    state.publisher.loading = false;
    if (['publisher-settings', 'analytics-dashboard'].includes(state.route.view)) renderRoute();
  }
}

async function loadHarmonyProbe({ force = false } = {}) {
  if (state.publisher.probing || (state.publisher.harmonyProbe && !force)) return;
  state.publisher.probing = true;
  if (force) renderRoute();
  try {
    const payload = await request('/analytics/publisher/harmony/probe');
    state.publisher.harmonyProbe = payload.probe;
  } catch (error) {
    state.publisher.harmonyProbe = { cliPresent: false, bindleConfigured: false, midwayLive: true, ready: false, nextAction: 'install-cli', detail: `Could not check the Harmony CLI: ${error.message}` };
  } finally {
    state.publisher.probing = false;
    if (state.route.view === 'publisher-settings') renderRoute();
  }
}

async function openHarmonyMwinitTerminal() {
  if (state.publisher.mwinitOpening) return;
  state.publisher.mwinitOpening = true;
  renderRoute({ userAction: true });
  try {
    const result = await request('/analytics/publisher/harmony/mwinit', { method: 'POST', body: {} });
    if (result.alreadyLive) {
      toast('Midway session is already live');
      void loadHarmonyProbe({ force: true });
    } else {
      toast('Terminal opened in chat — enter your PIN and touch your security key, then re-check');
    }
  } catch (error) {
    toast(`Could not open the terminal: ${error.message}`, 'bad');
  } finally {
    state.publisher.mwinitOpening = false;
    if (state.route.view === 'publisher-settings') renderRoute({ userAction: true });
  }
}

async function installHarmonyCliAction() {
  if (state.publisher.installingCli) return;
  state.publisher.installingCli = true;
  renderRoute({ userAction: true });
  try {
    const result = await request('/analytics/publisher/harmony/install-cli', { method: 'POST', body: {} });
    state.publisher.harmonyProbe = result.probe || state.publisher.harmonyProbe;
    toast(result.detail || 'Harmony CLI installed', result.ok ? undefined : 'bad');
  } catch (error) {
    toast(`Install failed: ${error.message}`, 'bad');
    void loadHarmonyProbe({ force: true });
  } finally {
    state.publisher.installingCli = false;
    if (state.route.view === 'publisher-settings') renderRoute();
  }
}

async function showHarmonyProvisionPlan() {
  try {
    const payload = await request('/analytics/publisher/harmony/provision-plan');
    state.publisher.provisionPlan = payload.plan;
  } catch (error) {
    toast(`Could not build the setup plan: ${error.message}`, 'bad');
  }
  if (state.route.view === 'publisher-settings') renderRoute({ userAction: true });
}

async function confirmHarmonyProvision() {
  if (state.publisher.provisioning) return;
  state.publisher.provisioning = true;
  renderRoute({ userAction: true });
  try {
    const result = await request('/analytics/publisher/harmony/provision', { method: 'POST', body: { confirmed: true } });
    state.publisher.config = result.publisher;
    state.publisher.provisionPlan = null;
    toast(result.detail || 'Team and bindle ready');
  } catch (error) {
    toast(`Setup failed: ${error.message}`, 'bad');
  } finally {
    state.publisher.provisioning = false;
    if (state.route.view === 'publisher-settings') renderRoute({ userAction: true });
  }
}

function renderPublisherSettings() {
  if (!state.publisher.config && !state.publisher.error) {
    void loadPublisherConfig();
    return loadingView();
  }
  const config = state.publisher.config;
  if (!config) return `${pageHead('Settings', 'Dashboard sharing', 'Configure a confirmation-gated snapshot publisher.')} ${errorView(state.publisher.error)}`;
  const provider = id => (config.providers || []).find(p => p.id === id) || { enabled: false, configured: false };
  const pill = p => `<span class="pill ${p.enabled && p.configured ? 'good' : ''}">${p.enabled && p.configured ? 'Active' : p.configured ? 'Paused' : 'Needs setup'}</span>`;
  const harmony = provider('harmony');
  const s3 = provider('s3-cloudfront');
  const saving = state.publisher.saving;

  const probe = state.publisher.harmonyProbe;
  if (!probe && !state.publisher.probing) void loadHarmonyProbe();
  const installing = state.publisher.installingCli;
  const cliStep = !probe
    ? `<p class="card-meta">Checking for the Harmony CLI…</p>`
    : probe.cliPresent
      ? `<p>${icon('check', 14)} CLI ready${probe.cliVersion ? ` — <code>${esc(probe.cliVersion)}</code>` : ''}</p>`
      : `<button class="button primary" type="button" data-action="harmony-install-cli" ${installing ? 'disabled' : ''}>${installing ? 'Installing… (takes a minute)' : 'Install Harmony CLI'}</button><small class="card-meta">Not installed yet (normal on first setup). One click runs <code>toolbox install harmonycli</code>.</small>`;
  const visibility = config.harmony?.visibility || 'everyone';

  // Accordion: one provider open at a time — the active one, else Harmony (the recommended default).
  const expanded = state.publisher.expandedProvider !== undefined
    ? state.publisher.expandedProvider
    : (config.id || 'harmony');
  const shell = (id, title, meta, pillHtml, inner, { form = true } = {}) => {
    const open = expanded === id;
    const tag = form ? 'form' : 'article';
    return `<${tag} class="card mcp-form publisher-card${open ? '' : ' publisher-collapsed'}"${form ? ` data-publisher-provider="${id}"` : ''}><div class="card-header publisher-card-toggle" data-action="publisher-toggle" data-provider="${id}" role="button" aria-expanded="${open}"><div><h2 class="card-title">${title}</h2><div class="card-meta">${meta}</div></div><div class="publisher-head-right">${pillHtml}<span class="publisher-chevron">${icon('chevron-right', 13)}</span></div></div>${inner}</${tag}>`;
  };

  const harmonyMeta = harmony.configured
    ? `Amazon internal · ${esc(config.harmony?.stage || 'beta')} · ${visibility === 'everyone' ? 'everyone at Amazon' : 'only me'}`
    : 'Amazon internal · interactive · recommended';
  const midwayHint = probe && probe.cliPresent && probe.midwayLive === false
    ? `<div class="mcp-alert">${icon('alert', 15)}<span>The Harmony CLI's Midway session is missing or expired (your browser's Midway is separate). </span><button class="button" type="button" data-action="harmony-mwinit" ${state.publisher.mwinitOpening ? 'disabled' : ''}>${state.publisher.mwinitOpening ? 'Opening terminal…' : 'Sign in (mwinit) in BotBoy terminal'}</button></div>`
    : '';
  const harmonyBody = `${harmony.lastError ? `<div class="mcp-alert">${icon('alert', 15)}<span>${esc(harmony.lastError)}</span></div>` : ''}${midwayHint}<div class="mcp-form-body"><label class="mcp-toggle-row"><span><strong>Use Harmony for dashboard sharing</strong><small>Publishes run <code>harmony app deploy</code> and apply your audience choice. Every publish keeps the expiring confirmation.</small></span><input name="enabled" type="checkbox" ${harmony.enabled ? 'checked' : ''}></label><div class="mcp-section"><h3>Step 1 · CLI</h3>${cliStep}</div><div class="mcp-section"><h3>Step 2 · Team bindle</h3>${state.publisher.provisionPlan ? `<div class="mcp-alert" style="border-color:rgba(157,140,255,.35)">${icon('shield', 15)}<span><strong>Review before creating:</strong> ${esc(state.publisher.provisionPlan.summary)}</span></div><div class="publisher-inline-actions"><button class="button primary" type="button" data-action="harmony-provision-confirm" ${state.publisher.provisioning ? 'disabled' : ''}>${state.publisher.provisioning ? 'Creating…' : 'Create these for me'}</button><button class="button" type="button" data-action="harmony-provision-cancel" ${state.publisher.provisioning ? 'disabled' : ''}>Cancel</button></div>` : `<button class="button" type="button" data-action="harmony-provision-plan">Set up automatically</button><small class="card-meta">BotBoy creates a personal team + team bindle for you (you confirm the exact names first). Personal bindles are rejected by Harmony; the bindle binds permanently at first publish.</small>`}${mcpField('bindleId', 'Team bindle ID', config.harmony?.bindleId || '', { placeholder: 'amzn1.bindle.resource.…', help: 'Or paste one from bindles.amazon.com (a Software Application bindle of a team you belong to).' })}</div><div class="mcp-section"><h3>Step 3 · Target</h3><div class="mcp-field-grid"><label class="mcp-field"><span>Stage</span><select name="stage">${['beta', 'gamma', 'prod'].map(stage => `<option value="${stage}" ${config.harmony?.stage === stage ? 'selected' : ''}>${stage}</option>`).join('')}</select><small>Start with beta. Prod = permanent URL; deploys run in a BotBoy-managed terminal.</small></label><label class="mcp-field"><span>Who can view</span><select name="visibility"><option value="everyone" ${visibility === 'everyone' ? 'selected' : ''}>Everyone at Amazon (Midway)</option><option value="private" ${visibility === 'private' ? 'selected' : ''}>Only me</option></select><small>App-wide, re-applied on every publish. Never publish Critical/Restricted data. "Only me" caveat: the classic console path bypasses it until the subdomain redirect is on.</small></label></div><small class="card-meta">App name is fixed: <code>${esc(config.harmony?.appName || '')}</code>; dashboards live under <code>/d/&lt;id&gt;/</code>.</small></div></div><div class="mcp-form-actions"><span>${icon('shield', 14)} Deploys use your local Midway session (mwinit)</span><button class="button primary" type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save Harmony'}</button></div>`;

  const s3Body = `${s3.lastError ? `<div class="mcp-alert">${icon('alert', 15)}<span>${esc(s3.lastError)}</span></div>` : ''}<div class="mcp-form-body"><label class="mcp-toggle-row"><span><strong>Use S3 + CloudFront for dashboard sharing</strong><small>Your admin provisions bucket + CDN; BotBoy only ever does one PutObject per confirmed publish.</small></span><input name="enabled" type="checkbox" ${s3.enabled ? 'checked' : ''}></label><div class="mcp-section"><h3>Destination</h3><div class="mcp-field-grid">${mcpField('bucket', 'S3 bucket', config.s3?.bucket || '', { placeholder: 'company-dashboard-snapshots' })}${mcpField('prefix', 'Object prefix', config.s3?.prefix || '', { placeholder: 'botboy-dashboards' })}${mcpField('region', 'AWS region', config.s3?.region || '', { placeholder: 'us-east-1' })}${mcpField('awsProfile', 'Least-privilege AWS profile', config.s3?.awsProfile || '', { placeholder: 'BotBoyDashboardPublisher', help: 'A profile allowed to PutObject only under this prefix — never AdministratorAccess.' })}</div>${mcpField('cloudFrontBaseUrl', 'CloudFront base URL', config.s3?.cloudFrontBaseUrl || '', { placeholder: 'https://dashboards.example.com', help: 'An existing distribution whose private origin reads this bucket/prefix.' })}</div><div class="mcp-section"><h3>Safety boundary</h3><div class="publisher-safety-list"><span>${icon('check', 14)} One PutObject per confirmation</span><span>${icon('check', 14)} Never touches ACLs, policies, or CDN config</span><span>${icon('check', 14)} No SQL or credentials in output</span><span>${icon('check', 14)} Local dashboard remains canonical</span></div></div></div><div class="mcp-form-actions"><span>${icon('shield', 14)} Treat the destination as production</span><button class="button primary" type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save S3'}</button></div>`;

  const sftpBody = `<div class="mcp-form-body"><p class="page-subtitle">Push the dashboard bundle to any static host you already pay for (SFTP/FTPS). Viewing is whatever your host serves — often public. Not configurable yet.</p></div>`;

  return `<div class="breadcrumb"><a href="#/settings">Settings</a>${icon('chevron-right', 11)}<span>Dashboard sharing</span></div>${pageHead('Publishing settings', 'Dashboard sharing', 'Pick where BotBoy publishes shared dashboards. One provider is active at a time; every publish keeps the two-step confirmation.', '<a class="button" href="#/settings">Back</a>')}<section class="publisher-provider-stack">${shell('harmony', 'Amazon Harmony', harmonyMeta, pill(harmony), harmonyBody)}${shell('s3-cloudfront', 'S3 + CloudFront', s3.configured ? `Enterprise bucket + CDN · ${esc(config.s3?.bucket || '')}` : 'Enterprise bucket + CDN · single-file snapshot (legacy)', pill(s3), s3Body)}${shell('sftp', 'SFTP / static host', 'Individuals & simple teams · low security', '<span class="pill">Coming later</span>', sftpBody, { form: false })}</section>`;
}

async function savePublisherConfig(form) {
  if (!form || state.publisher.saving) return;
  const provider = form.dataset.publisherProvider || 's3-cloudfront';
  const payload = provider === 'harmony'
    ? {
        provider,
        enabled: Boolean(form.elements.enabled?.checked),
        bindleId: form.elements.bindleId?.value,
        stage: form.elements.stage?.value,
        visibility: form.elements.visibility?.value,
      }
    : {
        provider,
        enabled: Boolean(form.elements.enabled?.checked),
        bucket: form.elements.bucket?.value,
        prefix: form.elements.prefix?.value,
        region: form.elements.region?.value,
        awsProfile: form.elements.awsProfile?.value,
        cloudFrontBaseUrl: form.elements.cloudFrontBaseUrl?.value,
      };
  state.publisher.saving = true;
  renderRoute({ userAction: true });
  try {
    const response = await request('/analytics/publisher', { method: 'PUT', body: payload });
    state.publisher.config = response.publisher;
    state.publisher.error = '';
    toast(response.publisher.enabled ? 'Dashboard publisher configured; uploads still require confirmation' : 'Dashboard publisher settings saved and publishing paused');
  } catch (error) {
    toast(`Could not save publisher: ${error.message}`, 'bad');
  } finally {
    state.publisher.saving = false;
    if (state.route.view === 'publisher-settings') renderRoute({ userAction: true });
  }
}

async function prepareDashboardShare(id) {
  if (!id || state.publisher.preparing.has(id)) return;
  const config = state.publisher.config;
  if (!config?.enabled || !config?.configured) {
    go('#/settings/dashboard-sharing');
    return;
  }
  state.publisher.preparing.add(id);
  renderRoute({ userAction: true });
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}/share-request`, { method: 'POST', body: {} });
    state.publisher.pending.set(id, payload.shareRequest);
    toast('Review the exact upload destination before confirming');
  } catch (error) {
    toast(`Could not prepare snapshot: ${error.message}`, 'bad');
  } finally {
    state.publisher.preparing.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute({ userAction: true });
  }
}

function cancelDashboardShare(id) {
  state.publisher.pending.delete(id);
  renderRoute({ userAction: true });
}

async function publishDashboardShare(id) {
  const pending = state.publisher.pending.get(id);
  if (!pending || state.publisher.publishing.has(id)) return;
  state.publisher.publishing.add(id);
  renderRoute({ userAction: true });
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: { confirmed: true, confirmationToken: pending.confirmationToken },
    });
    const dashboard = state.analytics.details.get(id);
    if (dashboard) dashboard.latestPublication = payload.publication;
    state.publisher.pending.delete(id);
    await loadPublisherConfig({ force: true });
    toast('Dashboard snapshot published');
  } catch (error) {
    state.publisher.pending.delete(id);
    await loadPublisherConfig({ force: true });
    toast(`Snapshot was not published: ${error.message}`, 'bad');
  } finally {
    state.publisher.publishing.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute({ userAction: true });
  }
}

function renderShareConfirmation(dashboard) {
  const pending = state.publisher.pending.get(dashboard.id);
  if (!pending) return '';
  const publishing = state.publisher.publishing.has(dashboard.id);
  const activeRun = analyticsActiveRun(dashboard);
  const blocked = publishing || Boolean(activeRun);
  return `<section class="card share-confirmation" role="alert"><div class="share-warning-icon">${icon('alert', 22)}</div><div class="share-confirmation-copy"><div class="eyebrow">Production AWS write</div><h2>Confirm this exact snapshot upload</h2><p>${esc(pending.warning)}</p><dl><div><dt>Destination</dt><dd>${esc(pending.destination)}</dd></div><div><dt>Content SHA-256</dt><dd><code>${esc(pending.contentSha256)}</code></dd></div><div><dt>Confirmation expires</dt><dd>${esc(new Date(pending.expiresAt).toLocaleString())}</dd></div></dl><p class="share-fixed-note">${activeRun ? 'Wait for the active refresh to finish before uploading this snapshot.' : 'This fixed copy will not update when the local dashboard refreshes. BotBoy will not change any AWS safety or access settings.'}</p><div class="share-confirmation-actions"><button class="button" type="button" data-action="share-cancel" data-dashboard="${attr(dashboard.id)}" ${publishing ? 'disabled' : ''}>Cancel</button><button class="button primary" type="button" data-action="share-confirm" data-dashboard="${attr(dashboard.id)}" ${blocked ? 'disabled' : ''}>${icon('globe')} ${publishing ? 'Uploading snapshot…' : activeRun ? 'Refresh in progress' : 'Confirm and upload snapshot'}</button></div></div></section>`;
}

// ── Analytical dashboards ──
async function loadAnalyticsDashboards({ force = false } = {}) {
  if (state.analytics.loading || (state.analytics.items && !force)) return;
  state.analytics.loading = true;
  try {
    const payload = await request('/analytics/dashboards');
    state.analytics.items = Array.isArray(payload.dashboards) ? payload.dashboards : [];
    state.analytics.error = '';
  } catch (error) {
    state.analytics.error = error.message;
  } finally {
    state.analytics.loading = false;
    if (['dashboards', 'analytics-dashboard'].includes(state.route.view)) renderRoute();
  }
}

async function loadAnalyticsDashboard(id, { force = false, preserveScroll = false } = {}) {
  if (!id || state.analytics.loading || (state.analytics.details.has(id) && !force)) return;
  state.analytics.loading = true;
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}`);
    state.analytics.details.set(id, payload.dashboard);
    updateAnalyticsSummary(payload.dashboard);
    state.analytics.error = '';
  } catch (error) {
    state.analytics.error = error.message;
  } finally {
    state.analytics.loading = false;
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) {
      renderRoute({ preserveScroll });
    }
  }
}

function analyticsActiveRun(dashboard) {
  return (dashboard?.recentRuns || []).find(run => run.status === 'queued' || run.status === 'running') || null;
}

function updateAnalyticsSummary(dashboard) {
  if (!dashboard || !Array.isArray(state.analytics.items)) return;
  state.analytics.items = state.analytics.items.map(summary => summary.id === dashboard.id ? {
    ...summary,
    title: dashboard.title,
    description: dashboard.description,
    theme: dashboard.theme,
    status: dashboard.status,
    widgetCount: dashboard.widgetCount,
    projectCount: dashboard.projectCount,
    lastError: dashboard.lastError,
    lastRefreshedAt: dashboard.lastRefreshedAt,
    updatedAt: dashboard.updatedAt,
  } : summary);
}

function analyticsCurrentWidget(dashboard, run) {
  if (!run?.currentWidgetId) return null;
  return (dashboard?.widgets || []).find(widget => widget.id === run.currentWidgetId) || null;
}

function renderAnalyticsProgress(dashboard, run) {
  if (!run) return '';
  const completed = Number(run.widgetsCompleted || 0);
  const total = Number(run.widgetCount || 0);
  const percent = total ? Math.max(0, Math.min(100, completed / total * 100)) : 0;
  const runningTitles = (run.runningWidgetIds || [])
    .map(id => (dashboard.widgets || []).find(widget => widget.id === id)?.title)
    .filter(Boolean);
  const current = analyticsCurrentWidget(dashboard, run);
  const runningLabel = runningTitles.length > 1
    ? `Running ${runningTitles.length} queries in parallel — ${runningTitles.slice(0, 2).join(', ')}${runningTitles.length > 2 ? ` +${runningTitles.length - 2} more` : ''}`
    : runningTitles.length === 1
      ? `Running ${runningTitles[0]}`
      : current
        ? `Running ${current.title}`
        : 'Finishing durable refresh state';
  const detail = run.cancelRequested
    ? runningTitles.length || current
      ? `Stopping — ${runningTitles.length > 1 ? `${runningTitles.length} running queries` : 'the running query'} will finish (they cannot be aborted); nothing new starts`
      : 'Stopping — no further widgets will run'
    : run.status === 'queued'
      ? run.error
        ? `Waiting for a data lane — ${run.error}`
        : 'Waiting for the background analytics worker'
      : runningLabel;
  const heading = run.cancelRequested ? 'Refresh stopping' : run.status === 'queued' ? 'Refresh queued' : 'Refresh running';
  return `<section class="analytics-run-progress" aria-live="polite"><div><span class="status-dot accent"></span><span><strong>${heading}</strong><small>${esc(detail)}</small></span><b>${number(completed)} / ${number(total)}</b></div><div class="analytics-progress-track" aria-label="${attr(`${completed} of ${total} widgets completed`)}"><i style="width:${percent.toFixed(2)}%"></i></div></section>`;
}

function syncAnalyticsPolling() {
  const dashboard = state.route.view === 'analytics-dashboard'
    ? state.analytics.details.get(state.route.dashboardId)
    : null;
  const active = analyticsActiveRun(dashboard);
  if (!active) {
    if (state.analytics.pollTimer) clearTimeout(state.analytics.pollTimer);
    state.analytics.pollTimer = null;
    return;
  }
  if (state.analytics.pollTimer || state.analytics.polling) return;
  state.analytics.pollTimer = setTimeout(() => {
    state.analytics.pollTimer = null;
    void pollActiveAnalyticsDashboard();
  }, 3_000);
}

async function pollActiveAnalyticsDashboard() {
  const id = state.route.view === 'analytics-dashboard' ? state.route.dashboardId : '';
  const previous = state.analytics.details.get(id);
  const previousRun = analyticsActiveRun(previous);
  if (!id || !previousRun) return syncAnalyticsPolling();
  if (document.hidden) return syncAnalyticsPolling();

  state.analytics.polling = true;
  try {
    const runPayload = await request(`/analytics/runs/${encodeURIComponent(previousRun.id)}`);
    const persistedRun = runPayload.run;
    const progressChanged = Number(persistedRun.widgetsCompleted || 0) !== Number(previousRun.widgetsCompleted || 0)
      || Boolean(persistedRun.cancelRequested) !== Boolean(previousRun.cancelRequested);
    const terminal = persistedRun.status === 'completed' || persistedRun.status === 'failed' || persistedRun.status === 'cancelled';
    let dashboard;
    if (progressChanged || terminal) {
      const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}`);
      dashboard = payload.dashboard;
    } else {
      const recentRuns = (previous.recentRuns || []).map(run => run.id === persistedRun.id ? persistedRun : run);
      dashboard = { ...previous, recentRuns };
    }
    state.analytics.details.set(id, dashboard);
    updateAnalyticsSummary(dashboard);
    state.analytics.error = '';
    const active = analyticsActiveRun(dashboard);
    if (!active && terminal && !state.analytics.announcedRuns.has(persistedRun.id)) {
      state.analytics.announcedRuns.add(persistedRun.id);
      if (persistedRun.status === 'completed') {
        toast(`Dashboard refresh completed: ${number(persistedRun.widgetsSucceeded)} widgets updated`, 'good');
      } else if (persistedRun.status === 'cancelled') {
        toast(`Refresh stopped: ${number(persistedRun.widgetsSucceeded)} of ${number(persistedRun.widgetCount)} widgets updated before the stop`);
      } else {
        const failed = Math.max(0, Number(persistedRun.widgetCount || 0) - Number(persistedRun.widgetsSucceeded || 0));
        toast(`Dashboard refresh finished with ${number(failed)} widget error${failed === 1 ? '' : 's'}`, 'bad');
      }
    }
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) {
      renderRoute({ preserveScroll: true });
    }
  } catch {
    // A transient poll failure must not discard the persisted dashboard already
    // on screen. The next active-only poll will retry.
  } finally {
    state.analytics.polling = false;
    syncAnalyticsPolling();
  }
}

function analyticsStatusTone(status) {
  if (status === 'ready') return 'good';
  if (status === 'degraded') return 'warn';
  if (status === 'refreshing') return 'accent';
  return '';
}

function analyticsCell(value) {
  if (value == null) return '<td class="analytics-cell-null"><span class="analytics-null">null</span></td>';
  if (typeof value === 'number') return `<td class="analytics-cell-number"><span class="analytics-number">${esc(value.toLocaleString())}</span></td>`;
  return `<td>${esc(String(value))}</td>`;
}

function analyticsColumnIndex(result, configured, fallback) {
  const columns = Array.isArray(result?.columns) ? result.columns : [];
  const selected = configured && columns.indexOf(String(configured));
  return Number.isInteger(selected) && selected >= 0 ? selected : Math.min(fallback, Math.max(columns.length - 1, 0));
}

function renderAnalyticsMetric(widget, result) {
  const valueIndex = analyticsColumnIndex(result, widget.config?.valueColumn, 0);
  const value = result.rows?.[0]?.[valueIndex];
  const prefix = String(widget.config?.prefix ?? '');
  const suffix = String(widget.config?.suffix ?? '');
  let rendered = value == null ? '—' : String(value);
  if (typeof value === 'number') {
    const precision = Math.max(0, Math.min(8, Number(widget.config?.precision ?? 0)));
    rendered = value.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision });
  }
  // Digit-aware sizing keeps short and long values on a shared visual
  // weight — "35" must not dwarf "97,855,892" (owner report: giant,
  // non-uniform numerals).
  const size = rendered.length <= 5 ? 'xl' : rendered.length <= 10 ? 'lg' : rendered.length <= 14 ? 'md' : 'sm';
  return `<div class="analytics-metric-value analytics-metric-${size}"><span>${esc(prefix)}</span>${esc(rendered)}<span>${esc(suffix)}</span></div><div class="analytics-metric-foot">Refreshed ${esc(relativeTime(result.refreshedAt))}</div>`;
}

/**
 * Grid packer: every row of the 12-column widget grid must land exactly on
 * 12 (owner report: ragged rows with huge dead zones). Natural spans —
 * metric 4, chart/text 6, table 12 — then each row's leftover columns are
 * spread across that row's widgets, right side first.
 */
function analyticsWidgetSpans(widgets) {
  const natural = kind => kind === 'metric' ? 4 : kind === 'table' ? 12 : 6;
  const spans = new Map();
  let row = [];
  let used = 0;
  const closeRow = () => {
    if (!row.length) { used = 0; return; }
    const extra = 12 - used;
    const base = Math.floor(extra / row.length);
    let remainder = extra % row.length;
    for (let i = row.length - 1; i >= 0; i--) {
      spans.set(row[i], spans.get(row[i]) + base + (remainder > 0 ? 1 : 0));
      if (remainder > 0) remainder--;
    }
    row = [];
    used = 0;
  };
  for (const widget of widgets) {
    const span = natural(widget.kind);
    if (used + span > 12) closeRow();
    row.push(widget.id);
    spans.set(widget.id, span);
    used += span;
    if (used === 12) { row = []; used = 0; }
  }
  if (row.length) closeRow();
  return spans;
}

/**
 * Text widgets get real typography instead of a <br>-joined wall: short
 * ALL-CAPS-ish or colon-terminated lines become subheads, bullet lines
 * become lists, blank lines split paragraphs. Content stays escaped —
 * query results are untrusted.
 */
function renderAnalyticsText(raw) {
  const lines = String(raw ?? '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) { blocks.push(`<p>${paragraph.map(esc).join('<br>')}</p>`); paragraph = []; }
  };
  const flushList = () => {
    if (list?.length) blocks.push(`<ul>${list.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushList(); flushParagraph(); continue; }
    const bullet = trimmed.match(/^[-•·*]\s+(.*)$/);
    if (bullet) { flushParagraph(); (list ??= []).push(bullet[1]); continue; }
    flushList();
    const letters = trimmed.replace(/[^A-Za-z]/g, '');
    const capsy = letters.length >= 3 && letters === letters.toUpperCase();
    if (trimmed.length <= 72 && (capsy || /:$/.test(trimmed))) {
      flushParagraph();
      blocks.push(`<h3>${esc(trimmed.replace(/:$/, ''))}</h3>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushList();
  flushParagraph();
  return blocks.join('') || '<p>—</p>';
}

function renderAnalyticsTable(result) {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (!columns.length) return `<pre class="analytics-raw">${esc(result.rawPreview || 'The query returned no tabular data.')}</pre>`;
  // Numeric columns (any numeric cell) right-align header and body together.
  const numericColumn = columns.map((_, index) => rows.some(row => typeof row?.[index] === 'number'));
  return `<div class="analytics-table-wrap"><table class="analytics-table"><thead><tr>${columns.map((column, index) => `<th${numericColumn[index] ? ' class="analytics-cell-number"' : ''}>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map((_, index) => analyticsCell(row[index])).join('')}</tr>`).join('')}</tbody></table></div>${result.rowCount > rows.length ? `<div class="analytics-truncated">Showing ${number(rows.length)} of ${number(result.rowCount)} rows returned by the connector.</div>` : ''}`;
}

function analyticsSeries(widget, result) {
  const labelIndex = analyticsColumnIndex(result, widget.config?.labelColumn ?? widget.config?.xColumn, 0);
  const valueIndex = analyticsColumnIndex(result, widget.config?.valueColumn ?? widget.config?.yColumn, 1);
  return (result.rows || []).slice(0, 24).map(row => ({ label: String(row[labelIndex] ?? ''), value: Number(row[valueIndex]) })).filter(point => Number.isFinite(point.value));
}

function renderAnalyticsBars(widget, result) {
  const series = analyticsSeries(widget, result);
  if (!series.length) return '<div class="analytics-empty">No numeric series could be rendered. Check the widget column mapping.</div>';
  const max = Math.max(...series.map(point => Math.abs(point.value)), 1);
  return `<div class="analytics-bars">${series.map(point => `<div class="analytics-bar-row"><span title="${attr(point.label)}">${esc(point.label)}</span><div><i style="width:${Math.max(2, Math.abs(point.value) / max * 100).toFixed(2)}%"></i></div><strong>${esc(point.value.toLocaleString())}</strong></div>`).join('')}</div>`;
}

function renderAnalyticsLine(widget, result) {
  const series = analyticsSeries(widget, result);
  if (series.length < 2) return renderAnalyticsBars(widget, result);
  const width = 720;
  const height = 210;
  const inset = 16;
  const values = series.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = series.map((point, index) => {
    const x = inset + index * (width - inset * 2) / Math.max(series.length - 1, 1);
    const y = height - inset - ((point.value - min) / range) * (height - inset * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const first = series[0];
  const last = series[series.length - 1];
  // Data labels are often raw timestamps — legend shows a compact date.
  const shortLabel = raw => {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  return `<div class="analytics-line-chart"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Line chart for ${attr(widget.title)}"><defs><linearGradient id="line-fill-${attr(widget.id)}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><polyline class="analytics-line-shadow" points="${points}"/><polyline class="analytics-line-path" points="${points}"/></svg><div class="analytics-line-legend"><span>${esc(shortLabel(first.label))} · <strong>${esc(first.value.toLocaleString())}</strong></span><span>${esc(shortLabel(last.label))} · <strong>${esc(last.value.toLocaleString())}</strong></span></div></div>`;
}

function analyticsVisualizationRows(result) {
  const columns = Array.isArray(result?.columns) ? result.columns.map(String) : [];
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row?.[index] ?? null])));
}

function analyticsVegaConfig(specConfig) {
  const styles = getComputedStyle(document.documentElement);
  const v = name => styles.getPropertyValue(name).trim();
  const authored = specConfig && typeof specConfig === 'object' && !Array.isArray(specConfig) ? specConfig : {};
  const authoredSection = key => authored[key] && typeof authored[key] === 'object' && !Array.isArray(authored[key]) ? authored[key] : {};
  const font = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const theme = {
    background: 'transparent',
    font,
    view: { stroke: 'transparent' },
    // App palette so authored charts match the shell in both themes.
    range: {
      category: [v('--accent'), v('--blue'), v('--green'), v('--yellow'), v('--red'), v('--accent-strong'), v('--soft')].filter(Boolean),
      heatmap: { scheme: 'purples' },
    },
    axis: {
      labelColor: v('--muted'),
      titleColor: v('--soft'),
      domainColor: v('--border-strong'),
      gridColor: v('--border'),
      tickColor: v('--border-strong'),
      labelFont: font,
      titleFont: font,
      labelFontSize: 11,
      titleFontSize: 11,
      titleFontWeight: 600,
      gridDash: [2, 3],
    },
    legend: {
      labelColor: v('--muted'),
      titleColor: v('--soft'),
      labelFont: font,
      titleFont: font,
      labelFontSize: 11,
      titleFontSize: 11,
    },
    title: {
      color: v('--text'),
      subtitleColor: v('--muted'),
      font,
      fontSize: 13,
      fontWeight: 650,
    },
    line: { strokeWidth: 2.5 },
    bar: { cornerRadiusEnd: 3 },
    point: { filled: true, size: 55 },
  };
  return {
    ...theme,
    ...authored,
    view: { ...theme.view, ...authoredSection('view') },
    range: { ...theme.range, ...authoredSection('range') },
    axis: { ...theme.axis, ...authoredSection('axis') },
    legend: { ...theme.legend, ...authoredSection('legend') },
    title: { ...theme.title, ...authoredSection('title') },
    line: { ...theme.line, ...authoredSection('line') },
    bar: { ...theme.bar, ...authoredSection('bar') },
    point: { ...theme.point, ...authoredSection('point') },
  };
}

let analyticsVisualizationEpoch = 0;

function destroyAnalyticsVisualizations() {
  analyticsVisualizationEpoch++;
  for (const view of state.analytics.visualizationViews.values()) {
    try { view.finalize(); } catch {}
  }
  state.analytics.visualizationViews.clear();
}

function analyticsVisualizationPlotWidth(container) {
  const measured = Math.floor(container.getBoundingClientRect().width || container.parentElement?.getBoundingClientRect().width || 0);
  // Vega width is the inner plotting width; reserve room for axes while keeping
  // composed views readable even when the assistant panel narrows the page.
  return Math.max(720, measured - 96);
}

function materializeAnalyticsContainerWidths(value, plotWidth) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(entry => materializeAnalyticsContainerWidths(entry, plotWidth));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'width' && entry === 'container') value[key] = plotWidth;
    else materializeAnalyticsContainerWidths(entry, plotWidth);
  }
}

async function hydrateAnalyticsVisualizations(dashboardId, expectedEpoch) {
  if (expectedEpoch !== analyticsVisualizationEpoch || state.route.view !== 'analytics-dashboard') return;
  const dashboard = state.analytics.details.get(dashboardId);
  if (!dashboard) return;
  const widgets = new Map((dashboard.widgets || []).map(widget => [widget.id, widget]));
  const containers = [...document.querySelectorAll('[data-analytics-visualization]')];

  for (const container of containers) {
    if (expectedEpoch !== analyticsVisualizationEpoch || !container.isConnected) return;
    const widget = widgets.get(container.dataset.analyticsVisualization);
    if (!widget?.result || !widget.config?.spec) continue;
    try {
      if (typeof window.vegaEmbed !== 'function') throw new Error('The local Vega runtime did not load. Rebuild the UI assets and restart BotBoy.');
      const spec = JSON.parse(JSON.stringify(widget.config.spec));
      spec.data = { values: analyticsVisualizationRows(widget.result) };
      spec.config = analyticsVegaConfig(spec.config);
      if ((spec.mark || spec.layer) && spec.width == null) spec.width = 'container';
      if ((spec.mark || spec.layer) && spec.height == null) spec.height = 320;
      const hasVegaView = spec.mark || spec.layer || spec.concat || spec.vconcat || spec.hconcat || spec.repeat || spec.facet;
      const plotWidth = analyticsVisualizationPlotWidth(container);
      // Container sizing inside concat/facet specs can resolve to the Vega 300px
      // fallback before the embed wrapper is laid out. Compile from the real
      // card width so the plot itself is large, not a stretched tiny SVG.
      materializeAnalyticsContainerWidths(spec, plotWidth);
      if (hasVegaView) spec.autosize = { type: 'pad', contains: 'padding', resize: false };
      container.replaceChildren();
      const embedded = await window.vegaEmbed(container, spec, {
        actions: false,
        renderer: 'svg',
        tooltip: true,
      });
      if (expectedEpoch !== analyticsVisualizationEpoch || !container.isConnected) {
        try { embedded.view.finalize(); } catch {}
        continue;
      }
      state.analytics.visualizationViews.set(widget.id, embedded.view);
    } catch (error) {
      if (expectedEpoch !== analyticsVisualizationEpoch || !container.isConnected) continue;
      container.classList.add('analytics-vega-error');
      const message = document.createElement('span');
      message.textContent = `Visualization could not render: ${error?.message || error}`;
      container.replaceChildren(message);
    }
  }
}

function renderAnalyticsWidget(widget, currentWidgetId = '', span = 0) {
  const result = widget.result;
  const running = widget.id === currentWidgetId;
  const chip = running
    ? '<span class="analytics-chip accent"><span class="status-dot accent"></span>running</span>'
    : widget.lastError
      ? `<span class="analytics-chip warn" title="${attr(widget.lastError)}"><span class="status-dot warn"></span>${result ? 'stale' : 'error'}</span>`
      : result
        ? `<span class="analytics-chip good" title="Refreshed ${attr(relativeTime(result.refreshedAt))}"><span class="status-dot good"></span>fresh</span>`
        : '<span class="analytics-chip"><span class="status-dot"></span>not run</span>';
  let body = '<div class="analytics-empty">Run a refresh to load this widget.</div>';
  if (result) {
    if (widget.kind === 'metric') body = renderAnalyticsMetric(widget, result);
    if (widget.kind === 'table') body = renderAnalyticsTable(result);
    if (widget.kind === 'bar') body = renderAnalyticsBars(widget, result);
    if (widget.kind === 'line') body = renderAnalyticsLine(widget, result);
    if (widget.kind === 'visualization') body = `<div class="analytics-vega" data-scroll-key="analytics:vega:${attr(widget.id)}" data-analytics-visualization="${attr(widget.id)}" role="img" aria-label="${attr(widget.title)}"><span>Preparing interactive visualization…</span></div>`;
    if (widget.kind === 'text') body = `<div class="analytics-text">${renderAnalyticsText(result.rows?.[0]?.[0] ?? widget.config?.text ?? '')}</div>`;
  }
  const spanClass = span ? ` analytics-span-${span}` : '';
  const wideMetric = widget.kind === 'metric' && span >= 8 ? ' analytics-metric-wide' : '';
  // Text widgets have no query — a provenance strip under a guide is noise.
  // Data lane (etl-analytics A4): absent on pre-A4 results = managed SQL.
  const laneLabel = result?.lane === 'etl' ? 'via Datanet ETL' : '';
  const provenance = widget.kind === 'text' && !widget.sql ? '' : `<details class="analytics-provenance"><summary>${icon('database', 12)}<span>Query & provenance</span><b>${esc([String(result?.trust || 'not refreshed').replaceAll('_', ' ').toLowerCase(), laneLabel].filter(Boolean).join(' · '))}</b></summary>${laneLabel ? `<div><span>Data lane</span><strong>Datanet ETL (SQL warehouse connection was down)</strong></div>` : ''}${widget.preset ? `<div><span>Schema preset</span><strong>${esc(widget.preset)}</strong></div>` : ''}${widget.sql ? `<pre>${esc(widget.sql)}</pre>` : ''}</details>`;
  return `<article class="card analytics-widget analytics-${attr(widget.kind)}${spanClass}${wideMetric}"><div class="analytics-widget-head"><div><div class="eyebrow">${esc(widget.kind)}</div><h2>${esc(widget.title)}</h2>${widget.subtitle ? `<p>${esc(widget.subtitle)}</p>` : ''}</div>${chip}</div>${widget.lastError ? `<div class="analytics-widget-error">${icon('alert', 13)}<span>${esc(widget.lastError)}</span>${result ? '<small>last good result shown</small>' : ''}</div>` : ''}<div class="analytics-widget-body">${body}</div>${provenance}</article>`;
}

function renderAnalyticsList() {
  if (!state.analytics.items && !state.analytics.error) {
    void loadAnalyticsDashboards();
    return loadingView();
  }
  const actions = `<button class="button primary" type="button" data-action="analytics-ask-create" data-chat-mode="analytics_dashboard" data-chat-intent="create" data-prompt="Help me build an analytical dashboard from my available business and schema knowledge. Inspect the available data first, recommend a useful schema-grounded dashboard, and ask only one targeted business question if a decision is genuinely ambiguous.">${icon('plus')} Build with BotBoy</button>`;
  const head = pageHead('Analytics', 'Dashboards', 'Durable, locally canonical views refreshed through BotBoy’s managed read-only SQL connection.', actions);
  if (state.analytics.error && !state.analytics.items) return `${head}${errorView(state.analytics.error)}`;
  const dashboards = state.analytics.items || [];
  return `${head}<section class="analytics-list-grid">${dashboards.map(dashboard => `<a class="card analytics-dashboard-card" href="#/dashboards/${encodeURIComponent(dashboard.id)}"><div class="analytics-card-top"><span class="source-icon">${icon('activity', 19)}</span><span class="pill ${analyticsStatusTone(dashboard.status)}"><span class="status-dot ${analyticsStatusTone(dashboard.status)}"></span>${esc(dashboard.status)}</span></div><h2>${esc(dashboard.title)}</h2><p>${esc(dashboard.description || 'An analytical dashboard managed by BotBoy.')}</p><div class="analytics-card-stats"><span><strong>${number(dashboard.widgetCount)}</strong> widgets</span><span><strong>${number(dashboard.projectCount)}</strong> projects</span></div><div class="analytics-card-foot"><span>${dashboard.lastRefreshedAt ? `Refreshed ${esc(relativeTime(dashboard.lastRefreshedAt))}` : 'Not refreshed yet'}</span>${icon('arrow-right', 14)}</div></a>`).join('') || `<article class="card empty-state analytics-list-empty"><span class="source-icon">${icon('activity', 19)}</span><h3>No dashboards yet</h3><p>Ask BotBoy to turn a business question into a governed dashboard with metrics, tables, and charts.</p><button class="button primary" type="button" data-action="analytics-ask-create" data-chat-mode="analytics_dashboard" data-chat-intent="create" data-prompt="Help me build my first analytical dashboard from my available business and schema knowledge. Inspect the available data first, recommend a useful schema-grounded dashboard, and ask only one targeted business question if a decision is genuinely ambiguous.">${icon('sparkles')} Design a dashboard</button></article>`}</section>`;
}

function renderAnalyticsRuns(dashboard) {
  const runs = dashboard.recentRuns || [];
  return `<article class="card analytics-runs"><div class="card-header"><div><h2 class="card-title">Refresh history</h2><div class="card-meta">Persisted local execution record</div></div></div>${runs.map(run => {
    const active = run.status === 'queued' || run.status === 'running';
    const tone = run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : run.status === 'cancelled' ? 'warn' : 'accent';
    const timestamp = run.startedAt || run.queuedAt;
    const progress = active
      ? `${number(run.widgetsCompleted)} of ${number(run.widgetCount)} processed · ${number(run.widgetsSucceeded)} succeeded`
      : `${number(run.widgetsSucceeded)} of ${number(run.widgetCount)} succeeded`;
    return `<div class="health-row"><span class="status-dot ${tone}"></span><span><strong>${esc(run.trigger)} refresh</strong><small>${progress} · ${esc(relativeTime(timestamp))}</small></span><span class="pill ${tone}">${esc(run.status)}</span></div>`;
  }).join('') || '<div class="empty-state"><p>No refresh runs recorded.</p></div>'}</article>`;
}

function renderAnalyticsSchedule(dashboard) {
  const schedule = dashboard.schedule;
  const timezone = schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const localTime = schedule?.localTime || '08:00';
  const saving = state.analytics.scheduling.has(dashboard.id);
  return `<article class="card analytics-schedule-card"><div class="card-header"><div><h2 class="card-title">Daily refresh</h2><div class="card-meta">Durable schedule · survives restarts</div></div><span class="pill ${schedule?.enabled ? 'good' : ''}">${schedule?.enabled ? 'Enabled' : 'Paused'}</span></div><form class="analytics-schedule-form" data-dashboard="${attr(dashboard.id)}"><label class="mcp-toggle-row"><span><strong>Run automatically</strong><small>Execute every widget through the managed read-only connector.</small></span><input name="enabled" type="checkbox" ${schedule?.enabled ? 'checked' : ''}></label><div class="mcp-field-grid"><label class="mcp-field"><span>Local time</span><input name="localTime" type="time" value="${attr(localTime)}" required></label><label class="mcp-field"><span>Timezone</span><input name="timezone" value="${attr(timezone)}" placeholder="America/Los_Angeles" required></label></div>${schedule ? `<div class="analytics-schedule-facts"><span><small>Next run</small><strong>${esc(new Date(schedule.nextRunAt).toLocaleString())}</strong></span><span><small>Last run</small><strong>${schedule.lastRunAt ? esc(relativeTime(schedule.lastRunAt)) : 'Never'}</strong></span><span><small>Consecutive failures</small><strong>${number(schedule.consecutiveFailures)}</strong></span></div>${schedule.lastError ? `<div class="analytics-widget-error">${icon('alert', 14)}<span>${esc(schedule.lastError)}</span></div>` : ''}` : '<p class="analytics-schedule-note">No schedule is stored until you save this form.</p>'}<div class="analytics-schedule-actions"><span>${icon('shield', 13)} Queries remain read only</span><button class="button primary" type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save schedule'}</button></div></form></article>`;
}

function renderAnalyticsManagement(dashboard) {
  const selected = new Set(Array.isArray(dashboard.projectIds) ? dashboard.projectIds : []);
  const projectsById = new Map();
  for (const project of [...state.projects, ...state.areas.flatMap(area => area.projects)]) {
    if (project?.id && !projectsById.has(project.id)) projectsById.set(project.id, project);
  }
  for (const projectId of selected) {
    if (!projectsById.has(projectId)) projectsById.set(projectId, { id: projectId, title: projectId, status: 'unknown' });
  }
  const projects = [...projectsById.values()].sort((left, right) => left.title.localeCompare(right.title));
  const saving = state.analytics.linkingProjects.has(dashboard.id);
  const deleting = state.analytics.deleting.has(dashboard.id);
  const activeRun = analyticsActiveRun(dashboard);
  const publishing = state.publisher.publishing.has(dashboard.id) || dashboard.latestPublication?.status === 'publishing';
  const linked = [...selected].map(projectId => projectsById.get(projectId)).filter(Boolean);
  const linkedSummary = linked.length
    ? linked.map(project => `<a class="pill analytics-linked-project" href="#/projects/${encodeURIComponent(project.id)}">${icon('branch', 12)} ${esc(project.title)}</a>`).join('')
    : '<span class="analytics-no-projects">No projects linked. This dashboard currently exists only in the Analytics workspace.</span>';
  const choices = projects.map(project => {
    const area = areaForProject(project.id);
    const context = area?.title || (project.status === 'active' ? 'Active project' : project.status || 'Project');
    return `<label class="analytics-project-option"><input type="checkbox" name="projectIds" value="${attr(project.id)}" ${selected.has(project.id) ? 'checked' : ''}><span><strong>${esc(project.title)}</strong><small>${esc(context)}</small></span></label>`;
  }).join('') || '<div class="analytics-no-projects">No projects are available to link.</div>';
  const deleteBlocked = deleting || Boolean(activeRun) || publishing;
  const deleteReason = activeRun
    ? `Wait for refresh ${activeRun.id} to finish before deleting.`
    : publishing
      ? 'Wait for the snapshot publication to finish before deleting.'
      : 'Deletes the local definition, widgets, refresh history, schedule, and project links. Published remote snapshots are not removed.';
  return `<article class="card analytics-management-card"><div class="card-header"><div><h2 class="card-title">Dashboard management</h2><div class="card-meta">Project context and local lifecycle</div></div><span class="pill">${number(selected.size)} linked</span></div><form class="analytics-project-form" data-dashboard="${attr(dashboard.id)}"><div class="analytics-linked-summary">${linkedSummary}</div><fieldset ${saving || deleting ? 'disabled' : ''}><legend>Linked projects</legend><p>Linking adds project context and navigation; it does not copy SQL results into project evidence.</p><label class="analytics-project-search-label"><span class="visually-hidden">Filter projects</span><input class="analytics-project-search" type="search" placeholder="Filter projects by name or area…" autocomplete="off"></label><div class="analytics-project-options">${choices}</div></fieldset><div class="analytics-management-actions"><span>${icon('branch', 13)} Choose any relevant projects, then save the complete linkage set.</span><button class="button" type="submit" ${saving || deleting ? 'disabled' : ''}>${saving ? 'Saving links…' : 'Save project links'}</button></div></form><div class="analytics-delete-zone"><div><strong>Delete local dashboard</strong><span>${esc(deleteReason)}</span></div><button class="button danger" type="button" data-action="analytics-delete" data-dashboard="${attr(dashboard.id)}" ${deleteBlocked ? 'disabled' : ''}>${icon('trash', 15)} ${deleting ? 'Deleting…' : 'Delete dashboard…'}</button></div></article>`;
}

function renderAnalyticsDashboard(id) {
  const dashboard = state.analytics.details.get(id);
  if (!dashboard && !state.analytics.error) {
    void loadAnalyticsDashboard(id);
    return loadingView();
  }
  if (!dashboard) return errorView(state.analytics.error || 'Dashboard not found.');
  if (!state.publisher.config && !state.publisher.loading && !state.publisher.error) void loadPublisherConfig();
  const activeRun = analyticsActiveRun(dashboard);
  const refreshing = state.analytics.refreshing.has(id) || Boolean(activeRun);
  const preparing = state.publisher.preparing.has(id);
  const publisherReady = state.publisher.config?.enabled && state.publisher.config?.configured;
  const tone = analyticsStatusTone(dashboard.status);
  const shareAction = publisherReady
    ? `<button class="button" type="button" data-action="share-prepare" data-dashboard="${attr(id)}" ${preparing || refreshing ? 'disabled' : ''}>${icon('globe')} ${preparing ? 'Preparing…' : 'Share snapshot'}</button>`
    : `<a class="button" href="#/settings/dashboard-sharing">${icon('globe')} Configure sharing</a>`;
  const publishedAction = dashboard.latestPublication?.status === 'published' && dashboard.latestPublication?.url
    ? `<a class="button" href="${attr(dashboard.latestPublication.url)}" target="_blank" rel="noopener noreferrer">${icon('link')} Open shared copy</a>`
    : '';
  const refreshLabel = activeRun?.status === 'queued'
    ? 'Queued…'
    : activeRun?.status === 'running'
      ? 'Refreshing…'
      : state.analytics.refreshing.has(id)
        ? 'Queueing…'
        : 'Refresh data';
  const stopping = Boolean(activeRun?.cancelRequested) || state.analytics.cancelling.has(id);
  const stopAction = activeRun
    ? `<button class="button" type="button" data-action="analytics-cancel-refresh" data-dashboard="${attr(id)}" ${stopping ? 'disabled' : ''} title="${attr(activeRun.status === 'running' ? 'Stops the refresh — queries already running finish, no new ones start; an in-flight warehouse query cannot be aborted' : 'Cancels the queued refresh before it starts')}">${icon('x', 14)} ${stopping ? 'Stopping…' : 'Stop refresh'}</button>`
    : '';
  const actions = `<a class="button" href="#/dashboards">${icon('chevron-right')} All dashboards</a>${publishedAction}${shareAction}${stopAction}<button class="button primary" type="button" data-action="analytics-refresh" data-dashboard="${attr(id)}" ${refreshing ? 'disabled' : ''}>${icon('refresh')} ${refreshLabel}</button>`;
  const schedule = dashboard.schedule;
  return `<header class="analytics-dashboard-head"><div class="analytics-dashboard-utility"><div class="breadcrumb"><a href="#/dashboards">Dashboards</a>${icon('chevron-right', 11)}<span>${esc(dashboard.title)}</span></div><div class="head-actions">${actions}</div></div><div class="analytics-dashboard-heading"><div class="eyebrow"><span class="eyebrow-dot"></span>Analytical dashboard</div><h1 class="page-title">${esc(dashboard.title)}</h1>${dashboard.description ? `<p class="page-subtitle">${esc(dashboard.description)}</p>` : ''}</div></header><div class="analytics-dashboard-meta"><span class="pill ${tone}"><span class="status-dot ${tone}"></span>${esc(dashboard.status)}</span><span>${icon('clock', 13)} ${dashboard.lastRefreshedAt ? `Refreshed ${esc(relativeTime(dashboard.lastRefreshedAt))}` : 'Not refreshed yet'}</span><span>${icon('database', 13)} Managed SQL · read only</span>${schedule ? `<span>${icon('refresh', 13)} ${schedule.enabled ? `Daily at ${esc(schedule.localTime)} ${esc(schedule.timezone)}` : 'Schedule paused'}</span>` : ''}${dashboard.latestPublication?.status === 'published' ? `<span>${icon('globe', 13)} Snapshot published ${esc(relativeTime(dashboard.latestPublication.publishedAt))}</span>` : ''}</div>${renderAnalyticsProgress(dashboard, activeRun)}${dashboard.lastError ? `<div class="analytics-dashboard-alert">${icon('alert', 15)}<span>${esc(dashboard.lastError)}</span></div>` : ''}${renderShareConfirmation(dashboard)}<section class="analytics-widget-grid">${(spans => dashboard.widgets.map(widget => renderAnalyticsWidget(widget, activeRun?.currentWidgetId, spans.get(widget.id))).join(''))(analyticsWidgetSpans(dashboard.widgets))}</section><section class="analytics-detail-grid">${renderAnalyticsRuns(dashboard)}${renderAnalyticsSchedule(dashboard)}${renderAnalyticsManagement(dashboard)}<article class="card pad analytics-governance"><div class="eyebrow">${icon('shield', 14)} Guardrails</div><h2 class="card-title">Local definition, governed refresh</h2><p>Queries are validated when saved and immediately before every run. Results are external untrusted data, escaped before rendering, and never authorize project or task changes.</p><div class="mcp-fact"><span>Canonical copy</span><strong>BotBoy SQLite</strong></div><div class="mcp-fact"><span>Database access</span><strong>Read only</strong></div><div class="mcp-fact"><span>Shared copies</span><strong>Explicit confirmation only</strong></div></article></section>`;
}

async function saveAnalyticsSchedule(form) {
  const id = form?.dataset?.dashboard;
  if (!id || state.analytics.scheduling.has(id)) return;
  const scheduleInput = {
    enabled: Boolean(form.elements.enabled?.checked),
    localTime: form.elements.localTime?.value,
    timezone: form.elements.timezone?.value,
  };
  state.analytics.scheduling.add(id);
  renderRoute({ userAction: true });
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}/schedule`, {
      method: 'PUT',
      body: scheduleInput,
    });
    state.analytics.details.set(id, payload.dashboard);
    toast(payload.schedule.enabled ? 'Daily dashboard refresh scheduled' : 'Dashboard schedule paused');
  } catch (error) {
    toast(`Could not save schedule: ${error.message}`, 'bad');
  } finally {
    state.analytics.scheduling.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute({ userAction: true });
  }
}

async function saveAnalyticsProjectLinks(form) {
  const id = form?.dataset?.dashboard;
  if (!id || state.analytics.linkingProjects.has(id)) return;
  const projectIds = new FormData(form).getAll('projectIds').map(value => String(value));
  state.analytics.linkingProjects.add(id);
  renderRoute({ userAction: true });
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { projectIds },
    });
    state.analytics.details.set(id, payload.dashboard);
    updateAnalyticsSummary(payload.dashboard);
    toast(projectIds.length ? `Linked dashboard to ${number(projectIds.length)} project${projectIds.length === 1 ? '' : 's'}` : 'Removed all dashboard project links');
  } catch (error) {
    toast(`Could not save project links: ${error.message}`, 'bad');
  } finally {
    state.analytics.linkingProjects.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute({ userAction: true });
  }
}

async function deleteAnalyticsDashboard(id) {
  const dashboard = state.analytics.details.get(id);
  if (!id || !dashboard || state.analytics.deleting.has(id) || analyticsActiveRun(dashboard)) return;
  const remoteWarning = dashboard.latestPublication?.status === 'published'
    ? '\n\nIts already-published remote snapshot will remain at the external destination.'
    : '';
  const confirmed = window.confirm(`Permanently delete "${dashboard.title}" and all of its local widgets, refresh history, schedule, and project links?\n\nThis cannot be undone.${remoteWarning}`);
  if (!confirmed) return;
  state.analytics.deleting.add(id);
  renderRoute({ userAction: true });
  try {
    await request(`/analytics/dashboards/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.analytics.details.delete(id);
    if (Array.isArray(state.analytics.items)) {
      state.analytics.items = state.analytics.items.filter(item => item.id !== id);
    }
    state.publisher.pending.delete(id);
    go('#/dashboards');
    toast(`Deleted dashboard: ${dashboard.title}`);
  } catch (error) {
    toast(`Could not delete dashboard: ${error.message}`, 'bad');
  } finally {
    state.analytics.deleting.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute({ userAction: true });
  }
}

async function refreshAnalyticsDashboard(id) {
  const current = state.analytics.details.get(id);
  if (!id || state.analytics.refreshing.has(id) || analyticsActiveRun(current)) return;
  state.analytics.refreshing.add(id);
  renderRoute({ userAction: true });
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: {} });
    state.analytics.details.set(id, payload.dashboard);
    updateAnalyticsSummary(payload.dashboard);
    const run = payload.run;
    toast(run?.status === 'running' ? 'A dashboard refresh is already running' : 'Dashboard refresh queued');
  } catch (error) {
    await loadAnalyticsDashboard(id, { force: true });
    toast(`Could not queue dashboard refresh: ${error.message}`, 'bad');
  } finally {
    state.analytics.refreshing.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute({ userAction: true });
  }
}

async function cancelAnalyticsRefresh(id) {
  const current = state.analytics.details.get(id);
  const active = analyticsActiveRun(current);
  if (!id || !active || active.cancelRequested || state.analytics.cancelling.has(id)) return;
  state.analytics.cancelling.add(id);
  renderRoute({ userAction: true });
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}/refresh/cancel`, { method: 'POST', body: {} });
    if (payload.dashboard) {
      state.analytics.details.set(id, payload.dashboard);
      updateAnalyticsSummary(payload.dashboard);
    }
    if (payload.result === 'cancelled') {
      if (payload.run) state.analytics.announcedRuns.add(payload.run.id);
      toast('Dashboard refresh stopped');
    } else if (payload.result === 'stopping') {
      toast('Stopping — queries already running will finish (they cannot be aborted); nothing new starts');
    } else {
      toast('The refresh already finished');
    }
  } catch (error) {
    toast(`Could not stop the refresh: ${error.message}`, 'bad');
  } finally {
    state.analytics.cancelling.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute({ userAction: true });
  }
}

function normalizeDocumentSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const artifactId = String(raw.artifactId ?? raw.id ?? '').trim();
  if (!artifactId) return null;
  const rawContentChars = raw.contentChars ?? raw.contentLength ?? raw.characterCount
    ?? (typeof raw.content === 'string' ? raw.content.length : null);
  const parsedContentChars = Number(rawContentChars);
  return {
    artifactId,
    projectId: typeof raw.projectId === 'string' && raw.projectId.trim() ? raw.projectId.trim() : null,
    projectTitle: typeof raw.projectTitle === 'string' && raw.projectTitle.trim() ? raw.projectTitle.trim() : '',
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled document',
    state: typeof raw.state === 'string' && raw.state ? raw.state : 'unknown',
    profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    contentChars: Number.isFinite(parsedContentChars) && parsedContentChars >= 0 ? Math.trunc(parsedContentChars) : null,
    parentArtifactId: typeof raw.parentArtifactId === 'string' && raw.parentArtifactId ? raw.parentArtifactId : null,
    revisionOrigin: raw.revisionOrigin === 'owner_edit' || raw.revisionOrigin === 'generated' || raw.revisionOrigin === 'chat_authored'
      ? raw.revisionOrigin
      : null,
  };
}

function documentSummariesFromPayload(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.artifacts)
      ? payload.artifacts
      : Array.isArray(payload?.documents)
        ? payload.documents
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
  return source.map(normalizeDocumentSummary).filter(Boolean);
}

function documentArtifactFromPayload(payload, expectedArtifactId) {
  const raw = payload?.artifact ?? payload?.document ?? payload;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The document API returned an invalid detail response.');
  }
  const artifactId = String(raw.artifactId ?? raw.id ?? expectedArtifactId ?? '').trim();
  if (!artifactId) throw new Error('The document API response did not include an artifact ID.');
  if (expectedArtifactId && artifactId !== expectedArtifactId) {
    throw new Error('The document API returned a different artifact than the one requested.');
  }
  return {
    ...raw,
    artifactId,
    publications: Array.isArray(payload?.publications) ? payload.publications : [],
    publicationState: payload?.publicationState && typeof payload.publicationState === 'object'
      ? payload.publicationState
      : null,
    publicationDestinationDefault: payload?.publicationDestinationDefault && typeof payload.publicationDestinationDefault === 'object'
      ? payload.publicationDestinationDefault
      : null,
    projectId: typeof raw.projectId === 'string' && raw.projectId.trim() ? raw.projectId.trim() : null,
    projectTitle: typeof raw.projectTitle === 'string' && raw.projectTitle.trim() ? raw.projectTitle.trim() : '',
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled document',
    state: typeof raw.state === 'string' && raw.state ? raw.state : 'unknown',
    profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

function documentStateLabel(value) {
  const normalized = String(value || 'unknown').replaceAll('_', ' ').trim().toLowerCase();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Unknown';
}

function documentProfileLabel(value) {
  const leaf = String(value || 'Unknown profile').split('/').pop().replace(/\.v\d+(?:\.\d+)*$/i, '').replaceAll('_', ' ').trim();
  return leaf.replace(/\b(op|prd|mvp|api|ux|ui)\b/gi, token => token.toUpperCase()) || 'Unknown profile';
}

function documentStateTone(value) {
  const normalized = String(value || '').toLowerCase();
  if (['ready', 'approved', 'published', 'complete', 'completed'].includes(normalized)) return 'good';
  if (normalized.includes('blocked') || normalized.includes('failed') || normalized.includes('error')) return 'warn';
  if (normalized.includes('draft') || normalized.includes('review')) return 'accent';
  return '';
}

function documentNotFound(message) {
  return /^HTTP 404(?:\b|\s|—|-)/.test(String(message || ''));
}

function rememberDocumentEntry(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > DOCUMENT_DETAIL_CACHE_LIMIT) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function queueDocumentRouteFocus(previousRoute, nextRoute) {
  if (nextRoute.view !== 'documents') {
    state.documents.pendingFocus = null;
    state.documents.reviewOpen = false;
    state.documents.publicationOpen = false;
    state.documents.publicationTrigger = 'summary';
    state.documents.publicationError = '';
    state.documents.detailsOpen = false;
    state.documents.focusMode = false;
    if (state.documents.reviewCollapsedLibrary) state.documents.libraryOpen = true;
    state.documents.reviewCollapsedLibrary = false;
    return;
  }
  if (nextRoute.artifactId && (previousRoute.view !== 'documents' || previousRoute.artifactId !== nextRoute.artifactId)) {
    state.documents.pendingFocus = { target: 'detail', artifactId: nextRoute.artifactId };
  } else if (!nextRoute.artifactId && previousRoute.view === 'documents' && previousRoute.artifactId) {
    state.documents.pendingFocus = { target: 'list', artifactId: previousRoute.artifactId };
  }
}

function restoreDocumentRouteFocus() {
  const pending = state.documents.pendingFocus;
  if (!pending) return;

  if (pending.target === 'focus-content') {
    document.querySelector('[data-document-preview], [data-document-editor]')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'focus-control') {
    document.querySelector('[data-action="documents-focus"]')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'library-control') {
    document.querySelector('.document-title-library-toggle')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'library-search') {
    document.querySelector('[data-document-search]')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'library-sort') {
    document.querySelector('[data-document-sort]')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'publication-control') {
    const origin = ['status', 'toolbar', 'summary'].includes(pending.origin) ? pending.origin : 'summary';
    document.querySelector(`[data-publication-trigger="${origin}"]`)
      ?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'publication') {
    document.querySelector('.document-publication-heading')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'review-control') {
    document.querySelector('[data-action="documents-toggle-review"]')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  if (pending.target === 'review') {
    document.querySelector('.document-review-heading')?.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }

  const mobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches;
  if (!mobile) {
    state.documents.pendingFocus = null;
    return;
  }

  if (pending.target === 'detail') {
    const target = document.querySelector('.document-back');
    target?.focus({ preventScroll: true });
    if (!state.documents.detailLoading.has(pending.artifactId)) state.documents.pendingFocus = null;
    return;
  }

  const target = Array.from(document.querySelectorAll('.document-row'))
    .find(row => row.dataset.artifact === pending.artifactId);
  if (target) {
    target.focus({ preventScroll: true });
    state.documents.pendingFocus = null;
    return;
  }
  document.querySelector('.document-list-pane')?.focus({ preventScroll: true });
  if (!state.documents.loading) state.documents.pendingFocus = null;
}

function currentEmbeddedDocumentShellWidth() {
  const shell = document.querySelector('.documents-shell');
  if (!shell) return state.documents.embeddedShellWidth || 0;
  if (!shell.classList.contains('document-focus')) {
    const width = shell.getBoundingClientRect().width;
    if (width > 0) state.documents.embeddedShellWidth = width;
  }
  return state.documents.embeddedShellWidth
    || document.querySelector('.main-content')?.getBoundingClientRect().width
    || shell.getBoundingClientRect().width;
}

function closeDocumentPublicationDrawer({ returnFocus = true } = {}) {
  if (!state.documents.publicationOpen) return false;
  const artifactId = state.route.view === 'documents' ? state.route.artifactId || '' : '';
  const origin = ['status', 'toolbar', 'summary'].includes(state.documents.publicationTrigger)
    ? state.documents.publicationTrigger
    : 'summary';
  state.documents.publicationOpen = false;
  state.documents.pendingFocus = returnFocus && artifactId
    ? { target: 'publication-control', origin, artifactId }
    : null;
  renderRoute({ preserveScroll: true, userAction: true });
  return true;
}

function updateDocumentReaderPresentation({ transition = 'local', focusTarget = '' } = {}) {
  state.documents.pendingFocus = null;
  const result = applyDocumentReaderPresentation({
    documentRef: document,
    state: state.documents,
    transition,
    focusTarget,
  });
  const settle = () => {
    enforceShellRootScroll();
    if (!state.documents.focusMode) currentEmbeddedDocumentShellWidth();
    syncDocumentPublicationDialog(document, state.documents);
  };
  if (result?.finished) Promise.resolve(result.finished).catch(() => undefined).then(settle);
  else requestAnimationFrame(settle);
  return result;
}

async function loadDocuments({ force = false, renderAfter = true } = {}) {
  const documents = state.documents;
  if (documents.loading || (!force && documents.items !== null)) return documents.items;
  documents.loading = true;
  if (!force) documents.error = '';
  if (renderAfter && state.route.view === 'documents') renderRoute({ preserveScroll: true });
  try {
    const payload = await request(`/product-documents?limit=${DOCUMENT_LIST_LIMIT}`);
    const summaries = documentSummariesFromPayload(payload);
    documents.items = summaries.map(document => ({
      ...document,
      projectTitle: document.projectId ? (projectById(document.projectId)?.title || document.projectTitle || '') : '',
    }));
    const parsedTotal = Number(payload?.total ?? payload?.count);
    documents.total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? Math.trunc(parsedTotal) : null;
    documents.error = '';
  } catch (error) {
    documents.error = error.message;
  } finally {
    documents.loading = false;
    if (renderAfter && state.route.view === 'documents') renderRoute({ preserveScroll: true });
  }
  return documents.items;
}

async function loadDocument(artifactId, { force = false, renderAfter = true } = {}) {
  const documents = state.documents;
  if (!artifactId || documents.detailLoading.has(artifactId) || (!force && documents.details.has(artifactId))) {
    return documents.details.get(artifactId) || null;
  }
  documents.detailLoading.add(artifactId);
  if (!force) documents.detailErrors.delete(artifactId);
  if (renderAfter && state.route.view === 'documents' && state.route.artifactId === artifactId) {
    renderRoute({ preserveScroll: true });
  }
  try {
    const payload = await request(`/product-documents/${encodeURIComponent(artifactId)}`);
    const artifact = documentArtifactFromPayload(payload, artifactId);
    rememberDocumentEntry(documents.details, artifactId, artifact);
    documents.detailErrors.delete(artifactId);
  } catch (error) {
    rememberDocumentEntry(documents.detailErrors, artifactId, error.message);
    if (documentNotFound(error.message)) documents.details.delete(artifactId);
  } finally {
    documents.detailLoading.delete(artifactId);
    if (renderAfter && state.route.view === 'documents' && state.route.artifactId === artifactId) {
      renderRoute({ preserveScroll: true });
    }
  }
  return documents.details.get(artifactId) || null;
}

async function resolvePublicationDestinationDefault(artifactId) {
  const documents = state.documents;
  const artifact = documents.details.get(artifactId);
  if (!artifact || documents.publicationDestinationLoading
    || artifact.publicationDestinationDefault?.status === 'resolved'
    || artifact.publicationDestinationDefault?.status === 'ambiguous') return;
  documents.publicationDestinationLoading = true;
  try {
    const payload = await request(`/product-documents/${encodeURIComponent(artifactId)}/publication-destination-default`);
    const destinationDefault = payload?.publicationDestinationDefault;
    if (!destinationDefault || documents.details.get(artifactId) !== artifact) return;
    artifact.publicationDestinationDefault = destinationDefault;
    const draft = documents.publicationDraft;
    if (!documents.publicationDraftTouched && draft?.mode === 'create'
      && !draft.targetFolder && !draft.serverRelativeUrl && !draft.siteUrl
      && destinationDefault.status === 'resolved' && destinationDefault.targetFolder) {
      documents.publicationDraft = { ...draft, targetFolder: destinationDefault.targetFolder };
    }
  } catch {
    // The field remains editable; discovery failure must never block publication.
  } finally {
    documents.publicationDestinationLoading = false;
    if (state.route.view === 'documents' && state.route.artifactId === artifactId && documents.publicationOpen) {
      renderRoute({ preserveScroll: true });
    }
  }
}

async function refreshDocuments() {
  if (state.documents.refreshing) return;
  const artifactId = state.route.view === 'documents' ? state.route.artifactId : '';
  state.documents.refreshing = true;
  if (state.route.view === 'documents') renderRoute({ preserveScroll: true, userAction: true });
  try {
    await Promise.all([
      loadDocuments({ force: true, renderAfter: false }),
      artifactId ? loadDocument(artifactId, { force: true, renderAfter: false }) : Promise.resolve(),
    ]);
  } finally {
    state.documents.refreshing = false;
    if (state.route.view === 'documents') renderRoute({ preserveScroll: true, userAction: true });
  }
}

function publicationOperationBusy(...identities) {
  const values = identities.filter(Boolean).map(String);
  return [...state.documents.publicationBusy].some(key => values.some(value => key.includes(value)));
}

function publicationRouteRelevant(artifactId, projectId) {
  return (state.route.view === 'documents' && state.route.artifactId === artifactId)
    || (state.route.view === 'project' && state.route.projectId === projectId);
}

async function waitForPublicationSurfaceLoads(artifactId, projectId) {
  while ((artifactId && state.documents.detailLoading.has(artifactId))
    || (projectId && state.projectDocuments.get(projectId)?.loading)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function refreshDocumentPublicationSurfaces(artifactId, projectId) {
  await waitForPublicationSurfaceLoads(artifactId, projectId);
  const refreshArtifact = artifactId && (state.documents.details.has(artifactId)
    || (state.route.view === 'documents' && state.route.artifactId === artifactId));
  await Promise.all([
    refreshArtifact ? loadDocument(artifactId, { force: true, renderAfter: false }) : Promise.resolve(),
    projectId ? loadProjectDocuments(projectId, { force: true }) : Promise.resolve(),
  ]);
  if (state.route.view === 'documents' || state.route.view === 'project') {
    renderRoute({ preserveScroll: true, userAction: true });
  }
}

async function stageDocumentPublication(artifactId, { basePublicationId = '' } = {}) {
  const artifact = state.documents.details.get(artifactId);
  const view = artifact?.publicationState;
  const operationKey = `stage:${artifactId}`;
  if (!artifact || !view || state.documents.publicationBusy.has(operationKey)) return;
  const draft = {
    ...(state.documents.publicationDraft || defaultPublicationDraft(view, artifact?.publicationDestinationDefault)),
    ...(basePublicationId ? { mode: 'update_existing', basePublicationId } : {}),
  };
  const requestShape = publicationStageRequest(view, draft);
  if (!requestShape.ok) {
    state.documents.publicationError = requestShape.error;
    state.documents.publicationOpen = true;
    renderRoute({ preserveScroll: true, userAction: true });
    return;
  }
  state.documents.publicationBusy.add(operationKey);
  state.documents.publicationError = '';
  state.documents.publicationOpen = true;
  if (state.route.view === 'documents') renderRoute({ preserveScroll: true, userAction: true });
  try {
    const payload = await request(`/product-documents/${encodeURIComponent(artifactId)}/publications`, {
      method: 'POST',
      body: requestShape.body,
    });
    if (payload.publicationState && state.documents.details.get(artifactId) === artifact) {
      artifact.publicationState = payload.publicationState;
    }
    await refreshDocumentPublicationSurfaces(artifactId, artifact.projectId);
    if (state.route.view === 'documents' && state.route.artifactId === artifactId) {
      const replaced = payload.result?.replacesPublicationIds?.length || 0;
      toast(payload.result?.idempotent
        ? 'This exact publication was already staged; no duplicate was created.'
        : `Publication staged for review${replaced ? `; ${replaced} obsolete attempt${replaced === 1 ? '' : 's'} superseded` : ''}.`);
      if (state.documents.publicationOpen) {
        state.documents.pendingFocus = { target: 'publication', artifactId };
      }
    }
  } catch (error) {
    if (state.route.view === 'documents' && state.route.artifactId === artifactId) {
      state.documents.publicationError = String(error?.message || error);
    }
  } finally {
    state.documents.publicationBusy.delete(operationKey);
    if (state.route.view === 'documents' || state.route.view === 'project') {
      renderRoute({ preserveScroll: true, userAction: true });
    }
  }
}

async function decideDocumentPublication({ artifactId, pendingEditId, decision, projectId = '', isUpdate = false, isConflict = false }) {
  const operationKey = `decision:${pendingEditId}:${artifactId}`;
  if (!pendingEditId || state.documents.publicationBusy.has(operationKey)) return;
  state.documents.publicationBusy.add(operationKey);
  if (state.route.view === 'documents' && state.route.artifactId === artifactId) state.documents.publicationError = '';
  if (state.route.view === 'documents' || state.route.view === 'project') renderRoute({ preserveScroll: true, userAction: true });
  try {
    const result = await request(`/documents/pending-edits/${encodeURIComponent(pendingEditId)}/${decision}`, { method: 'POST', body: {} });
    await refreshDocumentPublicationSurfaces(artifactId, projectId);
    if (publicationRouteRelevant(artifactId, projectId)) {
      if (decision === 'approve') {
        const snapshot = result.remoteSnapshot;
        toast(isUpdate
          ? `Update approved against item ${snapshot?.itemId || 'the current SharePoint version'} — the write has not started.`
          : 'New SharePoint copy approved — the write has not started.');
      } else {
        toast(isConflict ? 'Publication conflict dismissed.' : 'Publication request rejected.');
      }
    }
    if (state.route.view === 'documents' && state.route.artifactId === artifactId) {
      if (state.documents.publicationOpen) {
        state.documents.pendingFocus = { target: decision === 'approve' ? 'publication' : 'publication-control', artifactId };
      }
    }
  } catch (error) {
    const message = String(error?.message || error);
    if (state.route.view === 'documents' && state.route.artifactId === artifactId) state.documents.publicationError = message;
    if (publicationRouteRelevant(artifactId, projectId)) toast(`Could not ${decision}: ${message}`, 'warn');
  } finally {
    state.documents.publicationBusy.delete(operationKey);
    if (state.route.view === 'documents' || state.route.view === 'project') renderRoute({ preserveScroll: true, userAction: true });
  }
}

async function applyDocumentPublication({ artifactId, docKey, projectId = '', isUpdate = false }) {
  const operationKey = `sync:${docKey}:${artifactId}`;
  if (!docKey || state.documents.publicationBusy.has(operationKey)) return;
  state.documents.publicationBusy.add(operationKey);
  if (state.route.view === 'documents' && state.route.artifactId === artifactId) state.documents.publicationError = '';
  if (state.route.view === 'documents' || state.route.view === 'project') renderRoute({ preserveScroll: true, userAction: true });
  let result = null;
  let requestError = null;
  try {
    result = await request('/documents/sync', { method: 'POST', body: { docKey } });
  } catch (error) {
    requestError = error;
  } finally {
    // The server may persist upload/verification/capture failure before
    // returning HTTP 502. Always queue a post-mutation refresh behind any
    // pre-existing entity load before clearing the action's busy ownership.
    try {
      await refreshDocumentPublicationSurfaces(artifactId, projectId);
    } finally {
      state.documents.publicationBusy.delete(operationKey);
    }
  }

  const relevant = publicationRouteRelevant(artifactId, projectId);
  if (requestError) {
    const message = String(requestError?.message || requestError);
    if (state.route.view === 'documents' && state.route.artifactId === artifactId) state.documents.publicationError = message;
    if (relevant) toast(`${isUpdate ? 'Update' : 'Create'} failed: ${message}`, 'warn');
  } else if (result?.retrying) {
    if (relevant) toast(result.note || 'The file is locked; BotBoy will retry the approved write automatically.');
  } else if (result?.verifiedOnReadBack && (result.uploaded || result.alreadyCurrent)) {
    if (relevant) toast(isUpdate
      ? `SharePoint version ${result.alreadyCurrent ? 'was already current' : 'updated'} — exact bytes and item verified.`
      : 'SharePoint copy created and verified.');
  } else {
    const message = result?.results?.[0]?.reason || 'The publication did not complete; review its receipt.';
    if (state.route.view === 'documents' && state.route.artifactId === artifactId) state.documents.publicationError = message;
    if (relevant) toast(message, 'warn');
  }
  if (state.route.view === 'documents' || state.route.view === 'project') {
    renderRoute({ preserveScroll: true, userAction: true });
  }
}

function renderDocumentLibraryRows(selectedArtifactId) {
  const documents = state.documents;
  const items = documents.items;
  if (items === null && documents.loading) {
    return `<div class="document-list-loading" aria-label="Loading documents"><div class="skeleton row"></div><div class="skeleton row"></div><div class="skeleton row"></div><div class="skeleton row"></div></div>`;
  }
  if (items === null) {
    return `<div class="document-pane-state"><span class="source-icon">${icon('alert', 19)}</span><h2>Documents are unavailable</h2><p>${esc(documents.error || 'The document list could not be loaded.')}</p><button class="button" type="button" data-action="documents-retry-list">Try again</button></div>`;
  }
  if (!items.length) {
    return `<div class="document-pane-state"><span class="source-icon">${icon('file', 19)}</span><h2>No documents yet</h2><p>Generated product documents will appear here when they are available.</p><button class="button" type="button" data-action="documents-refresh">Refresh</button></div>`;
  }

  const chains = buildDocumentLibraryView(items, {
    query: documents.libraryQuery,
    sort: documents.librarySort,
  });
  const expansion = documentChainExpansionState(
    chains,
    selectedArtifactId,
    documents.chainExpansionOverrides,
  );
  const documentRow = (document, { versionNote = '', historical = false } = {}) => {
    const active = selectedArtifactId === document.artifactId;
    const origin = document.revisionOrigin === 'owner_edit' ? 'Owner edit' : '';
    const project = document.projectId ? projectById(document.projectId) : null;
    const projectLabel = project?.title || document.projectTitle || (document.projectId ? `Project ${document.projectId}` : 'Unassigned');
    const meta = [projectLabel, documentProfileLabel(document.profileId), origin, versionNote].filter(Boolean).join(' · ');
    return `<a class="document-row ${active ? 'active' : ''} ${historical ? 'document-row-version' : ''}" href="#/documents/${encodeURIComponent(document.artifactId)}" data-artifact="${attr(document.artifactId)}" ${active ? 'aria-current="page"' : ''}><span class="source-icon">${icon('file', 16)}</span><span class="document-row-copy"><strong>${esc(document.title)}</strong><span>${esc(meta)}</span></span><span class="document-row-side"><span class="document-state-dot ${documentStateTone(document.state)}" aria-hidden="true"></span><span class="document-row-state">${esc(documentStateLabel(document.state))}</span><time>${esc(relativeTime(document.createdAt))}</time></span></a>`;
  };
  const rows = chains.map(chain => {
    const versions = chain.older.length + 1;
    const expanded = expansion.get(chain.chainKey) === true;
    const historyId = `document-chain-history-${chain.chainKey.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const selectedHistorical = chain.older.some(entry => entry.artifactId === selectedArtifactId);
    const head = documentRow(chain.head, {
      versionNote: versions > 1 ? `Latest loaded · ${number(versions)} versions` : 'Latest loaded',
    });
    const history = chain.older.map((entry, index) => `<li>${documentRow(entry, {
      versionNote: `Version ${versions - index - 1} of ${versions} loaded`, historical: true,
    })}</li>`).join('');
    const toggle = versions > 1
      ? `<button class="document-chain-toggle" type="button" data-action="documents-toggle-chain" data-chain-key="${attr(chain.chainKey)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${attr(historyId)}" aria-label="${expanded ? 'Hide' : 'Show'} ${number(versions - 1)} earlier loaded version${versions === 2 ? '' : 's'} of ${attr(chain.head.title)}">${icon('chevron-down', 13)}<span>${number(versions - 1)}</span></button>`
      : '';
    const boundary = chain.hasUnloadedParent ? '<span class="document-chain-boundary">Earlier versions not loaded</span>' : '';
    return `<li class="document-chain ${expanded ? 'is-expanded' : 'is-collapsed'} ${selectedHistorical ? 'contains-selection' : ''}" data-chain-key="${attr(chain.chainKey)}"><div class="document-chain-head">${head}${toggle}${selectedHistorical ? `<span class="document-chain-selected-hidden" ${expanded ? 'hidden' : ''}>Viewing earlier version</span>` : ''}</div>${history ? `<ol id="${attr(historyId)}" class="document-chain-history" aria-label="Earlier loaded versions of ${attr(chain.head.title)}" ${expanded ? '' : 'hidden'}>${history}</ol>` : ''}${boundary}</li>`;
  }).join('');
  const empty = `<div class="document-pane-state document-library-empty"><span class="source-icon">${icon('search', 18)}</span><h2>No loaded documents match</h2><p>Search covers this bounded set: ${esc(boundedDocumentScopeLabel(items.length, DOCUMENT_LIST_LIMIT))}. Try another title, profile, status, or artifact ID.</p><button class="button small" type="button" data-action="documents-clear-search">Clear search</button></div>`;
  return rows ? `<ol class="document-chain-list">${rows}</ol>` : empty;
}

function updateDocumentLibraryResults() {
  const results = document.getElementById('document-library');
  if (!results || state.route.view !== 'documents') return;
  results.innerHTML = renderDocumentLibraryRows(state.route.artifactId || '');
  const visible = buildDocumentLibraryView(state.documents.items || [], {
    query: state.documents.libraryQuery,
    sort: state.documents.librarySort,
  }).reduce((sum, chain) => sum + chain.members.length, 0);
  const count = document.getElementById('document-library-count');
  if (count) count.textContent = boundedDocumentCountLabel({
    loadedCount: (state.documents.items || []).length,
    total: state.documents.total,
    query: state.documents.libraryQuery,
    visibleCount: visible,
  });
}

function renderDocumentListPane(selectedArtifactId) {
  const documents = state.documents;
  const items = documents.items;
  const visible = buildDocumentLibraryView(items || [], {
    query: documents.libraryQuery,
    sort: documents.librarySort,
  }).reduce((sum, chain) => sum + chain.members.length, 0);
  const countLabel = boundedDocumentCountLabel({
    loadedCount: items?.length,
    total: documents.total,
    query: documents.libraryQuery,
    visibleCount: visible,
  });
  const controls = items?.length ? `<div class="document-library-controls"><label class="document-library-search">${icon('search', 13)}<span class="visually-hidden">Search loaded documents</span><input type="search" data-document-search value="${attr(documents.libraryQuery)}" placeholder="Search latest ${number(DOCUMENT_LIST_LIMIT)}" autocomplete="off"></label><label class="document-library-sort"><span class="visually-hidden">Sort loaded documents</span><select data-document-sort><option value="recent" ${documents.librarySort === 'recent' ? 'selected' : ''}>Recent</option><option value="title" ${documents.librarySort === 'title' ? 'selected' : ''}>Title</option><option value="status" ${documents.librarySort === 'status' ? 'selected' : ''}>Status</option></select></label></div>` : '';

  const canCollapse = Boolean(selectedArtifactId);
  return `<aside class="card document-list-pane ${documents.libraryOpen ? '' : 'is-collapsed'}" aria-label="Generated documents" tabindex="-1"><div id="document-library-content" class="document-library-content"><header class="document-pane-header"><div class="document-pane-title"><h2>Generated documents</h2><p>${esc(boundedDocumentScopeLabel(items?.length, DOCUMENT_LIST_LIMIT))}</p></div><span id="document-library-count" class="pill">${esc(countLabel)}</span></header>${controls}${items && documents.error ? `<div class="document-inline-error" role="status">${icon('alert', 14)}<span>Refresh failed: ${esc(documents.error)}</span></div>` : ''}<div class="document-library-results" data-document-library-results><nav id="document-library" class="document-list" data-scroll-key="documents:list" aria-label="Documents">${renderDocumentLibraryRows(selectedArtifactId)}</nav></div></div></aside>`;
}

function renderDocumentPublicationPanel(artifact, view, documents) {
  if (!view) return '';
  const presentation = publicationPresentation(view);
  const open = documents.publicationOpen;
  const triggerOrigin = ['status', 'toolbar', 'summary'].includes(documents.publicationTrigger)
    ? documents.publicationTrigger
    : 'summary';
  const attempt = view.attempt || null;
  const busy = publicationOperationBusy(artifact.artifactId, attempt?.pendingEditId, attempt?.docKey);
  const draft = documents.publicationDraft || defaultPublicationDraft(view, artifact?.publicationDestinationDefault);
  const locations = Array.isArray(view.completedLocations) ? view.completedLocations : [];
  const updateBases = Array.isArray(view.updateBases) ? view.updateBases : [];
  const toneClass = presentation.tone ? ` ${presentation.tone}` : '';
  const pathLine = value => `<code class="document-publication-path">${esc(value || 'Unknown target')}</code>`;
  const locationRows = locations.length
    ? `<div class="document-publication-locations">${locations.map(location => `<div class="document-publication-location"><span class="document-publication-location-icon">${icon(location.containsSelectedArtifact ? 'check' : 'link', 14)}</span><span><strong>${location.containsSelectedArtifact ? 'Current version' : 'Older version'}</strong>${pathLine(location.serverRelativeUrl)}<small>${String(location.format || '').toUpperCase()}${location.remoteItemId ? ` · item ${esc(location.remoteItemId)}` : ''}</small></span>${location.webUrl ? `<a class="button small ghost" href="${attr(location.webUrl)}" target="_blank" rel="noopener">Open</a>` : ''}</div>`).join('')}</div>`
    : '';

  let body = '';
  if (attempt) {
    const isUpdate = attempt.action === 'update_existing';
    const statusCopy = documentStateLabel(attempt.publicationStatus);
    const snapshot = attempt.remoteObservedAt
      ? `<div class="document-publication-snapshot"><span><strong>Approved remote snapshot</strong><small>${esc(relativeTime(attempt.remoteObservedAt))}</small></span>${attempt.expectedRemoteItemId ? `<span><strong>Item</strong><code>${esc(attempt.expectedRemoteItemId)}</code></span>` : ''}${attempt.expectedRemoteSha256 ? `<span><strong>SHA-256</strong><code>${esc(String(attempt.expectedRemoteSha256).slice(0, 12))}…</code></span>` : ''}${attempt.expectedRemoteModified ? `<span><strong>Modified</strong><time>${esc(String(attempt.expectedRemoteModified))}</time></span>` : ''}</div>`
      : '';
    const error = view.phase === 'blocked_unassigned'
      ? view.blockReason
      : attempt.conflictReason || attempt.lastError || documents.publicationError;
    const effectNote = attempt.effectCertainty === 'none'
      ? 'No SharePoint write has occurred for this attempt.'
      : attempt.effectCertainty === 'verified_remote_effect'
        ? 'A remote effect was verified; do not create another attempt until this receipt is reconciled.'
        : 'A remote write may have occurred; review the receipt before taking another action.';
    let actions = '';
    if (view.phase === 'blocked_unassigned') {
      actions = '';
    } else if (view.phase === 'pending') {
      actions = `<button class="button primary" type="button" data-action="documents-publication-decide" data-id="${attr(attempt.pendingEditId)}" data-decision="approve" ${busy ? 'disabled' : ''}>${busy ? 'Checking SharePoint…' : 'Approve'}</button><button class="button ghost" type="button" data-action="documents-publication-decide" data-id="${attr(attempt.pendingEditId)}" data-decision="reject" ${busy ? 'disabled' : ''}>Reject</button>`;
    } else if (publicationAttemptCanApply(view)) {
      actions = `<button class="button primary" type="button" data-action="documents-publication-sync" data-dockey="${attr(attempt.docKey)}" ${busy ? 'disabled' : ''}>${busy ? 'Writing and verifying…' : esc(publicationEffectLabel(attempt.action, { final: true }))}</button>`;
    } else if (view.phase === 'conflicted') {
      actions = `<button class="button ghost" type="button" data-action="documents-publication-decide" data-id="${attr(attempt.pendingEditId)}" data-decision="reject" ${busy ? 'disabled' : ''}>Dismiss conflict</button>${isUpdate ? `<button class="button" type="button" data-action="documents-publication-retry" data-base="${attr(attempt.basePublicationId || '')}" ${busy ? 'disabled' : ''}>Prepare update again</button>` : ''}`;
    } else {
      actions = `<button class="button ghost" type="button" data-action="documents-publication-refresh" ${busy ? 'disabled' : ''}>Refresh status</button>`;
    }
    body = `<div class="document-publication-attempt"><div class="document-publication-effect"><span class="pill${toneClass}">${esc(statusCopy)}</span><strong>${isUpdate ? 'Update existing SharePoint version' : 'Create new SharePoint copy'}</strong>${pathLine(attempt.serverRelativeUrl)}<small>Official artifact ${esc(String(attempt.artifactId).slice(0, 12))}… · ${String(attempt.format || '').toUpperCase()}</small></div>${snapshot}${error ? `<div class="document-publication-alert" role="alert">${icon('alert', 14)}<span>${esc(error)}</span></div>` : ''}<p class="document-publication-certainty">${esc(effectNote)}</p><div class="document-publication-actions">${actions}</div></div>`;
  } else if (view.phase === 'blocked_unassigned') {
    body = `<div class="document-publication-empty">${icon('folder', 20)}<div><strong>Publication unavailable</strong><p>${esc(view.blockReason || 'Assign this document chain to an active or paused project before publishing it.')}</p></div></div>`;
  } else {
    const updateMode = draft.mode === 'update_existing' && updateBases.length > 0;
    const modeChoice = updateBases.length
      ? `<div class="document-publication-mode" role="group" aria-label="Publication type"><button class="button small ${updateMode ? 'active' : ''}" type="button" data-action="documents-publication-mode" data-mode="update_existing" aria-pressed="${updateMode ? 'true' : 'false'}">Update existing</button><button class="button small ${updateMode ? '' : 'active'}" type="button" data-action="documents-publication-mode" data-mode="create" aria-pressed="${updateMode ? 'false' : 'true'}">Create another copy</button></div>`
      : '';
    const updateForm = `<fieldset class="document-publication-fieldset"><legend>Choose the SharePoint file to update</legend>${updateBases.map((location, index) => `<label class="document-publication-choice"><input type="radio" name="document-publication-base" value="${attr(location.publicationId)}" data-publication-base ${draft.basePublicationId === location.publicationId || (!draft.basePublicationId && updateBases.length === 1 && index === 0) ? 'checked' : ''}><span><strong>${esc(location.serverRelativeUrl.split('/').pop() || 'SharePoint document')}</strong>${pathLine(location.serverRelativeUrl)}<small>${String(location.format || '').toUpperCase()} · contains an older artifact</small></span></label>`).join('')}</fieldset><div class="document-publication-actions"><button class="button primary" type="button" data-action="documents-publication-stage" ${busy ? 'disabled' : ''}>${busy ? 'Staging…' : 'Stage update for review'}</button></div>`;
    const createForm = `<div class="document-publication-form"><div class="document-publication-section-title"><strong>${locations.length ? 'Create another physical copy' : 'Create a SharePoint copy'}</strong><small>${locations.length ? 'This is a separate file and does not replace the verified location above.' : 'Choose the exact destination before staging it for review.'}</small></div><div class="document-publication-form-grid"><label><span>Format</span><select data-publication-format><option value="docx" ${draft.format === 'docx' ? 'selected' : ''}>Word (.docx)</option><option value="md" ${draft.format === 'md' ? 'selected' : ''}>Markdown (.md)</option></select></label><label><span>Destination kind</span><select data-publication-destination-mode><option value="folder" ${draft.destinationMode !== 'path' ? 'selected' : ''}>Folder (use document title)</option><option value="path" ${draft.destinationMode === 'path' ? 'selected' : ''}>Complete file path</option></select></label><label class="wide"><span>${draft.destinationMode === 'path' ? 'Complete server-relative file path' : 'SharePoint folder path'}</span><input type="text" data-publication-destination value="${attr(draft.destinationMode === 'path' ? draft.serverRelativeUrl : draft.targetFolder)}" placeholder="${draft.destinationMode === 'path' ? '/personal/you/Documents/Strategy.docx' : '/personal/you/Documents'}" autocomplete="off"><small>${draft.destinationMode === 'path' ? `Must end in .${draft.format === 'md' ? 'md' : 'docx'}.` : 'BotBoy uses this immutable document title as the filename.'}</small></label><label class="wide"><span>Team site URL <em>optional</em></span><input type="url" data-publication-site value="${attr(draft.siteUrl || '')}" placeholder="https://amazon.sharepoint.com/sites/team" autocomplete="off"><small>Leave blank for your OneDrive.</small></label></div><div class="document-publication-actions"><button class="button primary" type="button" data-action="documents-publication-stage" ${busy ? 'disabled' : ''}>${busy ? 'Staging…' : 'Stage new copy for review'}</button></div></div>`;
    body = `${locationRows}${modeChoice}${updateMode ? updateForm : createForm}${documents.publicationError ? `<div class="document-publication-alert" role="alert">${icon('alert', 14)}<span>${esc(documents.publicationError)}</span></div>` : ''}`;
  }

  const blockers = Array.isArray(view.blockers) ? view.blockers : [];
  if (blockers.length > 1) {
    body = `<div class="document-publication-alert" role="alert">${icon('alert', 14)}<span><strong>${number(blockers.length)} unresolved publication receipts</strong><br>${blockers.map(entry => `${documentStateLabel(entry.publicationStatus)} · ${entry.serverRelativeUrl}`).map(esc).join('<br>')}</span></div>${body}`;
  }

  return `<section class="document-publication-surface${toneClass} ${open ? 'is-open' : ''}" aria-labelledby="document-publication-summary-label" ${busy ? 'aria-busy="true"' : ''}><header class="document-publication-summary"><span class="document-publication-summary-icon">${icon(view.phase === 'complete' ? 'check' : view.phase === 'conflicted' || view.phase === 'failed' ? 'alert' : 'link', 15)}</span><span><strong id="document-publication-summary-label">${esc(presentation.label)}</strong><small>${esc(presentation.summary)}</small></span><button class="button small ghost ${open && triggerOrigin === 'summary' ? 'is-publication-origin' : ''}" type="button" data-action="documents-publication-toggle" data-publication-trigger="summary" aria-haspopup="dialog" aria-controls="document-publication-dialog" aria-expanded="${open ? 'true' : 'false'}">${esc(presentation.button)}</button></header></section><dialog id="document-publication-dialog" class="document-publication-overlay" aria-labelledby="document-publication-heading" aria-describedby="document-publication-description" ${busy ? 'aria-busy="true"' : ''}><section class="document-publication-drawer"><header class="document-publication-drawer-header"><div><h3 id="document-publication-heading" class="document-publication-heading" tabindex="-1">SharePoint publication</h3><p id="document-publication-description" class="document-publication-intro">Reviewing or staging here does not write SharePoint. The final physical-effect button remains separate.</p></div><button class="icon-button document-publication-drawer-close" type="button" data-action="documents-publication-close" aria-label="Close SharePoint publication">${icon('x', 15)}</button></header><div id="document-publication-panel" class="document-publication-panel" data-scroll-key="documents:publication:${attr(artifact.artifactId)}">${body}</div><span class="visually-hidden" aria-live="polite">${busy ? 'Publication action in progress' : ''}</span></section></dialog>`;
}

function renderDocumentDetailPane(artifactId) {
  const documents = state.documents;
  if (!artifactId) {
    return `<article class="card document-detail-pane document-detail-empty"><div class="document-pane-state"><span class="source-icon">${icon('file', 20)}</span><h2>Select a document</h2><p>Choose a generated document to inspect its metadata and plain-text content.</p></div></article>`;
  }

  const artifact = documents.details.get(artifactId);
  const detailError = documents.detailErrors.get(artifactId) || '';
  const loading = documents.detailLoading.has(artifactId);
  const back = `<a class="button small document-back" href="#/documents">${icon('chevron-right', 12)} Back to documents</a>`;

  if (!artifact && loading) {
    return `<article class="card document-detail-pane"><div class="document-detail-toolbar">${back}</div><div class="document-detail-loading" aria-label="Loading document"><div class="skeleton" style="min-height:74px"></div><div class="skeleton" style="min-height:360px"></div></div></article>`;
  }

  if (!artifact) {
    const missing = documentNotFound(detailError);
    return `<article class="card document-detail-pane"><div class="document-detail-toolbar">${back}</div><div class="document-pane-state"><span class="source-icon">${icon(missing ? 'file' : 'alert', 19)}</span><h2>${missing ? 'Document not found' : 'Document could not be loaded'}</h2><p>${missing ? 'This document may have been removed or the link may be out of date.' : esc(detailError || 'The document detail is unavailable.')}</p>${missing ? '<a class="button" href="#/documents">Return to documents</a>' : `<button class="button" type="button" data-action="documents-retry-detail" data-artifact="${attr(artifactId)}">Try again</button>`}</div></article>`;
  }

  const content = typeof artifact.content === 'string' ? artifact.content : '';
  const truncated = content.length > DOCUMENT_PREVIEW_LIMIT;
  const stateTone = documentStateTone(artifact.state);
  const profileVersion = artifact.profileVersion ? `v${artifact.profileVersion}` : '';
  const editing = documents.editing;
  const mode = editing ? 'edit' : (documents.previewMode === 'plain' ? 'plain' : 'rendered');
  const canRender = typeof window.formatMarkdownContent === 'function';
  const loadedChains = buildDocumentLibraryView(documents.items || [], { sort: 'recent' });
  const revisionLabel = loadedDocumentRevisionLabel(loadedChains, artifactId, artifact.parentArtifactId);
  const reviewModel = buildDocumentReviewModel(artifact);

  const openQuestions = Array.isArray(artifact.openQuestions) ? artifact.openQuestions.filter(entry => typeof entry === 'string' && entry.trim()) : [];
  // Collapsible panel with capped internal scrolling: answering questions
  // must never steal the whole pane from the document preview below it.
  const questionsBlock = openQuestions.length && !editing
    ? `<details class="document-questions" data-document-questions ${documents.questionsOpen ? 'open' : ''}><summary>${icon('sparkles', 14)} <strong>${number(openQuestions.length)} open question${openQuestions.length === 1 ? '' : 's'} to answer</strong><span>Answer below and BotBoy will create an improved version.</span><span class="document-questions-chevron">${icon('chevron-down', 13)}</span></summary><div class="document-questions-body"><ol data-scroll-key="documents:questions:${attr(artifactId)}">${openQuestions.slice(0, 10).map(question => `<li>${esc(question)}</li>`).join('')}</ol><textarea class="document-answers-input" data-document-answers rows="3" placeholder="Type your answers here (any format — reference the questions by number if useful)">${esc(documents.answersDraft || '')}</textarea><div class="document-questions-actions"><button class="button" type="button" data-action="documents-send-answers" data-artifact="${attr(artifactId)}" ${documents.saving ? 'disabled' : ''}>${icon('sparkles', 13)} Send answers to BotBoy</button><span>Sends your answers to chat; a new version is generated from them.</span></div></div></details>`
    : '';

  const parentLine = artifact.parentArtifactId
    ? `<span>Parent <a href="#/documents/${encodeURIComponent(artifact.parentArtifactId)}"><code>${esc(String(artifact.parentArtifactId).slice(0, 12))}</code></a>${artifact.revisionOrigin === 'owner_edit' ? ' · Owner edit' : ''}</span>`
    : '<span>Original artifact</span>';

  const modeButtons = editing ? '' : `<div class="document-mode-group" role="group" aria-label="Preview mode"><button class="button small ${mode === 'rendered' ? 'active' : ''}" type="button" data-action="documents-preview-mode" data-mode="rendered" ${canRender ? '' : 'disabled title="Renderer unavailable"'}>Rendered</button><button class="button small ${mode === 'plain' ? 'active' : ''}" type="button" data-action="documents-preview-mode" data-mode="plain">Plain text</button></div>`;
  const editButton = editing ? '' : `<button class="button small" type="button" data-action="documents-edit" data-artifact="${attr(artifactId)}">${icon('plus', 13)} Edit</button>`;

  const downloadFormats = [
    { format: 'markdown', label: 'Markdown', hint: '.md' },
    { format: 'html', label: 'HTML', hint: '.html' },
    { format: 'docx', label: 'Word', hint: '.docx' },
    { format: 'pdf', label: 'PDF', hint: '.pdf' },
  ];
  const downloadMenu = editing ? '' : `<details class="document-download-menu" data-document-download-menu><summary class="button small" aria-haspopup="menu" ${documents.downloading ? 'aria-disabled="true"' : ''}>${icon('download', 13)} ${documents.downloading ? `Preparing ${esc(documents.downloading)}…` : 'Download'}</summary><div class="document-download-list" role="menu">${downloadFormats.map(entry => `<button type="button" role="menuitem" data-action="documents-download" data-artifact="${attr(artifactId)}" data-format="${entry.format}" ${documents.downloading ? 'disabled' : ''}><span>${entry.label}</span><span>${entry.hint}</span></button>`).join('')}</div></details>`;
  const publicationView = artifact.publicationState && typeof artifact.publicationState === 'object'
    ? artifact.publicationState
    : null;
  const publicationCopy = publicationPresentation(publicationView);
  const publishButton = editing || !publicationView
    ? ''
    : `<button class="button small document-publication-toggle ${documents.publicationOpen ? 'active' : ''} ${documents.publicationOpen && documents.publicationTrigger === 'toolbar' ? 'is-publication-origin' : ''}" type="button" data-action="documents-publication-toggle" data-publication-trigger="toolbar" aria-haspopup="dialog" aria-expanded="${documents.publicationOpen ? 'true' : 'false'}" aria-controls="document-publication-dialog">${icon('link', 13)} ${esc(publicationCopy.button)}</button>`;
  const reviewAvailable = Boolean(reviewModel.totalCount || reviewModel.statusLabel || reviewModel.reviewSummary);
  const reviewButton = !editing && reviewAvailable
    ? `<button class="button small document-review-toggle ${documents.reviewOpen ? 'active' : ''}" type="button" data-action="documents-toggle-review" aria-expanded="${documents.reviewOpen ? 'true' : 'false'}" aria-controls="document-review-rail" aria-label="${documents.reviewOpen ? 'Close review notes' : 'Open review notes'}">${icon('sparkles', 13)} <span data-document-review-label>${reviewModel.noteCount ? 'Review notes' : 'Evidence'}</span><span class="document-review-button-count">${number(reviewModel.noteCount || reviewModel.citations.length)}</span></button>`
    : '';
  const focusButton = `<button class="button small document-focus-toggle ${documents.focusMode ? 'active' : ''}" type="button" data-action="documents-focus" aria-pressed="${documents.focusMode ? 'true' : 'false'}" aria-keyshortcuts="Escape" aria-label="${documents.focusMode ? 'Exit Focus' : 'Enter Focus'}" title="${documents.focusMode ? 'Exit Focus (Esc)' : 'Open immersive Focus'}">${icon(documents.focusMode ? 'x' : 'expand', 13)} <span data-document-focus-label>${documents.focusMode ? 'Exit Focus' : 'Focus'}</span><kbd data-document-focus-hint ${documents.focusMode ? '' : 'hidden'}>Esc</kbd></button>`;
  const overflowMenu = editing ? '' : `<details class="document-overflow-menu"><summary class="button small" aria-haspopup="menu">More ${icon('chevron-down', 11)}</summary><div class="document-overflow-list" role="menu"><button type="button" role="menuitem" data-action="documents-retry-detail" data-artifact="${attr(artifactId)}" ${loading ? 'disabled' : ''}>${icon('refresh', 13)}<span>${loading ? 'Refreshing…' : 'Refresh document'}</span></button><div class="document-menu-separator" role="separator"></div><button class="document-menu-danger" type="button" role="menuitem" data-action="documents-delete" data-artifact="${attr(artifactId)}" ${documents.deleting ? 'disabled' : ''}>${icon('trash', 13)}<span>${documents.deleting ? 'Deleting…' : 'Delete this version'}</span></button></div></details>`;

  const annotationsRail = !editing && reviewAvailable
    ? renderDocumentAnnotationsRail(artifact, reviewModel, documents.reviewOpen)
    : '';
  const previewBody = editing
    ? `<textarea class="document-editor" data-document-editor aria-label="Edit document content" spellcheck="true">${esc(documents.editDraft ?? content)}</textarea><div class="document-editor-actions"><button class="button" type="button" data-action="documents-save-revision" data-artifact="${attr(artifactId)}" ${documents.saving ? 'disabled' : ''}>${documents.saving ? 'Saving…' : 'Save as new version'}</button><button class="button ghost" type="button" data-action="documents-cancel-edit" ${documents.saving ? 'disabled' : ''}>Cancel</button><span>Saving never overwrites this version; it creates a new linked one.</span></div>`
    : mode === 'rendered' && canRender
      ? `<div class="document-annotated ${annotationsRail ? 'with-rail' : ''}"><div class="document-rendered" data-document-preview tabindex="0" aria-label="Rendered preview of ${attr(artifact.title)}"></div>${annotationsRail}</div>`
      : `<div class="document-annotated ${annotationsRail ? 'with-rail' : ''}"><pre class="document-preview" data-document-preview tabindex="0" aria-label="Plain-text preview of ${attr(artifact.title)}"></pre>${annotationsRail}</div>`;

  const footerNote = editing
    ? `${icon('shield', 13)} Edits persist as a new immutable version`
    : mode === 'rendered' && canRender
      ? `${icon('shield', 13)} Escape-first Markdown rendering`
      : `${icon('shield', 13)} Plain-text view`;
  const project = artifact.projectId ? projectById(artifact.projectId) : null;
  const projectFact = artifact.projectId
    ? `<a class="document-project-link" href="#/projects/${encodeURIComponent(artifact.projectId)}" title="Open owning project">${icon('folder', 11)} ${esc(project?.title || artifact.projectTitle || artifact.projectId)}</a>`
    : `<span class="document-project-unassigned">${icon('folder', 11)} Unassigned</span>`;
  const publicationFact = publicationView
    ? `<button class="document-publication-fact ${publicationCopy.tone} ${documents.publicationOpen && documents.publicationTrigger === 'status' ? 'is-publication-origin' : ''}" type="button" data-action="documents-publication-toggle" data-publication-trigger="status" aria-haspopup="dialog" aria-controls="document-publication-dialog" aria-expanded="${documents.publicationOpen ? 'true' : 'false'}">${icon('link', 11)} ${esc(publicationCopy.label)}</button>`
    : '';
  const projectChoices = [...new Map([
    ...state.projects,
    ...state.areas.flatMap(area => area.projects || []),
  ].filter(candidate => candidate.status === 'active' || candidate.status === 'paused')
    .map(candidate => [candidate.id, candidate])).values()]
    .sort((left, right) => String(left.title).localeCompare(String(right.title), undefined, { sensitivity: 'base' }));
  const projectAssignmentControl = `<span class="document-project-assignment"><strong>Owning project</strong><span><select data-document-project-assignment aria-label="Owning project for this document chain" ${documents.projectAssigning ? 'disabled' : ''}><option value="" ${artifact.projectId ? '' : 'selected'}>Unassigned</option>${projectChoices.map(candidate => `<option value="${attr(candidate.id)}" ${candidate.id === artifact.projectId ? 'selected' : ''}>${esc(candidate.title)}${candidate.status === 'paused' ? ' · Paused' : ''}</option>`).join('')}</select><button class="button small" type="button" data-action="documents-set-project" data-artifact="${attr(artifactId)}" ${documents.projectAssigning ? 'disabled' : ''}>${documents.projectAssigning ? 'Updating…' : 'Update chain'}</button></span><small>Applies to every version in this immutable chain. No title or citation inference is used.</small></span>`;
  const profileFact = [documentProfileLabel(artifact.profileId), profileVersion].filter(Boolean).join(' · ');
  const exactCreatedAt = artifact.createdAt ? new Date(artifact.createdAt).toLocaleString() : 'Unknown';
  const detailsPanel = `<details class="document-technical-details" data-document-details ${documents.detailsOpen ? 'open' : ''}><summary>Details ${icon('chevron-down', 11)}</summary><div><span><strong>Artifact ID</strong><code>${esc(artifact.artifactId)}</code></span><span><strong>Profile</strong>${esc(artifact.profileId || 'Unknown')}${profileVersion ? ` · ${esc(profileVersion)}` : ''}</span><span><strong>Created</strong>${esc(exactCreatedAt)}</span>${artifact.model ? `<span><strong>Model</strong>${esc(artifact.model)}</span>` : ''}${artifact.checkerVersion ? `<span><strong>Checker</strong>${esc(artifact.checkerVersion)}</span>` : ''}${parentLine}${projectAssignmentControl}</div></details>`;

  const libraryTitleButton = `<button class="icon-button document-title-library-toggle" type="button" data-action="documents-toggle-library" aria-expanded="${documents.libraryOpen ? 'true' : 'false'}" aria-controls="document-library-content" aria-label="${documents.libraryOpen ? 'Hide generated documents' : 'Show generated documents'}" title="${documents.libraryOpen ? 'Hide generated documents' : 'Show generated documents'}">${icon(documents.libraryOpen ? 'panel-collapse' : 'panel-expand', 18)}</button>`;
  const publicationPanel = !editing && publicationView
    ? renderDocumentPublicationPanel(artifact, publicationView, documents)
    : '';
  return `<article class="card document-detail-pane"><header class="document-detail-header"><div class="document-title-block"><div class="document-title-row">${libraryTitleButton}<h2 id="document-detail-title">${esc(artifact.title)}</h2><span class="pill ${stateTone}"><span class="visually-hidden">Document status: </span>${esc(documentStateLabel(artifact.state))}</span></div><div class="document-primary-facts"><span>${projectFact}</span>${publicationFact ? `<span>${publicationFact}</span>` : ''}<span>${esc(profileFact)}</span><span>${esc(revisionLabel)}</span><span>Created ${esc(relativeTime(artifact.createdAt))}</span><span>${number(content.length)} characters</span>${detailsPanel}</div></div></header><div class="document-detail-toolbar">${back}${modeButtons}${editButton}<div class="document-toolbar-spacer"></div><div class="document-toolbar-actions">${reviewButton}${publishButton}${downloadMenu}${focusButton}${overflowMenu}</div></div>${publicationPanel}${detailError ? `<div class="document-inline-error" role="status">${icon('alert', 14)}<span>Latest refresh failed: ${esc(detailError)}</span></div>` : ''}${documents.actionError ? `<div class="document-inline-error" role="alert">${icon('alert', 14)}<span>${esc(documents.actionError)}</span></div>` : ''}${documents.pandocPrompt ? renderPandocInstallCard(documents.pandocPrompt) : ''}<div class="document-preview-shell" data-scroll-key="documents:preview:${attr(artifactId)}">${questionsBlock}${truncated && !editing ? `<div class="document-truncation-notice" role="status">${icon('alert', 14)}<span>Preview truncated: showing the first ${number(DOCUMENT_PREVIEW_LIMIT)} of ${number(content.length)} characters.</span></div>` : ''}${content || editing ? '' : `<div class="document-content-empty ${questionsBlock ? 'inline' : ''}">This document has no preview content.</div>`}${previewBody}</div><footer class="document-detail-footer"><span>${footerNote}</span><span>${editing ? `${number((documents.editDraft ?? content).length)} characters in editor` : `${number(Math.min(content.length, DOCUMENT_PREVIEW_LIMIT))} characters displayed`}</span></footer></article>`;
}

function renderDocuments() {
  const documents = state.documents;
  const artifactId = state.route.artifactId || '';
  if (documents.uiArtifactId !== artifactId) {
    // Library preferences survive selection. Artifact-specific surfaces do not:
    // a different document must never inherit edit, review, details, or Focus.
    if (documents.reviewCollapsedLibrary) documents.libraryOpen = true;
    documents.reviewCollapsedLibrary = false;
    documents.uiArtifactId = artifactId;
    documents.previewMode = 'rendered';
    documents.editing = false;
    documents.editDraft = null;
    documents.answersDraft = '';
    documents.saving = false;
    documents.actionError = '';
    documents.publicationOpen = false;
    documents.publicationTrigger = 'summary';
    documents.publicationDraft = null;
    documents.publicationDraftTouched = false;
    documents.publicationDestinationLoading = false;
    documents.publicationError = '';
    documents.reviewOpen = false;
    documents.detailsOpen = false;
    documents.focusMode = false;
    if (!artifactId) documents.libraryOpen = true;
    documents.questionsOpen = true;
    documents.downloading = null;
    documents.deleting = false;
    // Keep an in-flight install alive across artifact switches — the retry
    // targets the artifact that started it; only clear a resting card.
    if (documents.pandocPrompt && documents.pandocPrompt.state !== 'installing') documents.pandocPrompt = null;
  }
  if (documents.items === null && !documents.loading && !documents.error) void loadDocuments();
  if (artifactId && !documents.details.has(artifactId) && !documents.detailLoading.has(artifactId) && !documents.detailErrors.has(artifactId)) {
    void loadDocument(artifactId);
  }
  const loadedCount = documents.items?.length;
  const subtitle = Number.isFinite(loadedCount)
    ? `${number(loadedCount)} recent generated document${loadedCount === 1 ? '' : 's'}; search and sort cover this bounded loaded set.`
    : 'Read and review BotBoy-authored documents from a bounded loaded set.';
  const refreshLabel = documents.refreshing ? 'Refreshing…' : 'Refresh';
  const actions = `<button class="button" type="button" data-action="documents-refresh" ${documents.refreshing ? 'disabled' : ''}>${icon('refresh')} ${refreshLabel}</button>`;
  const shellClasses = [
    'documents-shell',
    artifactId ? 'has-selection' : '',
    documents.libraryOpen ? 'library-open' : 'library-collapsed',
    documents.reviewOpen ? 'review-open' : '',
    documents.focusMode && artifactId ? 'document-focus' : '',
  ].filter(Boolean).join(' ');
  return `${pageHead('Writing workspace', 'Documents', subtitle, actions)}<section class="${shellClasses}">${renderDocumentListPane(artifactId)}${renderDocumentDetailPane(artifactId)}</section>`;
}

/**
 * On-demand review surface: evidence plus advisory validation/conformance
 * notes. The model is normalized once and grouped by aspect; none of these
 * notes gate reading, editing, export, or immutable revision creation.
 */
function renderDocumentAnnotationsRail(artifact, model = buildDocumentReviewModel(artifact), open = false) {
  if (!model.totalCount && !model.statusLabel && !model.reviewSummary) return '';

  const citeCards = model.citations.map((cite, index) => {
    const meta = [cite.source, cite.date ? String(cite.date).slice(0, 10) : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="doc-annotation doc-annotation-cite" data-annotation-cite="${attr(cite.id)}" title="Show this citation in the document"><span class="doc-annotation-head"><sup class="doc-cite static">${index + 1}</sup><strong>${esc(cite.label)}</strong></span>${meta ? `<span class="doc-annotation-meta">${esc(meta)}</span>` : ''}${cite.quote ? `<blockquote>${esc(cite.quote)}</blockquote>` : ''}${cite.url ? `<span class="doc-annotation-meta doc-annotation-url">${esc(cite.url)}</span>` : cite.workItemId ? `<span class="doc-annotation-meta">Captured evidence <code>${esc(String(cite.workItemId).slice(0, 12))}</code></span>` : ''}</button>`;
  }).join('');

  const groupedNotes = model.groups.map(group => `<section class="doc-annotation-group"><h3>${esc(group.label)} <span class="doc-annotation-count">${number(group.items.length)}</span></h3>${group.items.map(finding => `<div class="doc-annotation doc-annotation-review ${finding.severity === 'deviation' ? 'deviation' : ''}"><span class="doc-annotation-head"><span class="doc-annotation-dot"></span><strong>${finding.code ? `<code>${esc(finding.code)}</code>` : esc(group.label)}</strong><span class="doc-annotation-sev">${finding.severity === 'deviation' ? 'deviation' : 'note'}</span></span><span class="doc-annotation-message">${esc(finding.message)}</span><span class="doc-annotation-meta">${finding.source === 'validation' ? 'Validation advisory' : 'Conformance review'}</span></div>`).join('')}</section>`).join('');

  return `<aside id="document-review-rail" class="document-annotations" data-scroll-key="documents:annotations:${attr(artifact.artifactId)}" aria-label="Document review" aria-hidden="${open ? 'false' : 'true'}" ${open ? '' : 'inert'}><header class="document-review-heading" tabindex="-1"><div><span class="eyebrow">${icon('sparkles', 12)} Review</span><strong>${model.noteCount ? `${number(model.noteCount)} informational note${model.noteCount === 1 ? '' : 's'}` : 'Evidence sources'}</strong></div><button class="icon-button" type="button" data-action="documents-toggle-review" aria-label="Close review">${icon('x', 14)}</button></header><p class="document-review-guidance">Review notes inform your judgment; they do not block this document.</p>${model.statusLabel || model.reviewSummary ? `<div class="document-review-summary">${model.statusLabel ? `<span class="pill ${model.statusTone}">${esc(model.statusLabel)}</span>` : ''}${model.reviewSummary ? `<p>${esc(model.reviewSummary)}</p>` : ''}</div>` : ''}${groupedNotes}${model.hiddenNoteCount ? `<p class="document-review-more">${number(model.hiddenNoteCount)} additional notes are not shown in this bounded review rail.</p>` : ''}${model.citations.length ? `<section class="doc-annotation-group"><h3>${icon('link', 12)} Evidence <span class="doc-annotation-count">${model.citations.length}</span></h3>${citeCards}</section>` : ''}</aside>`;
}

/**
 * Replace inline [cN] markers with clickable superscript citation chips.
 * Operates on the ALREADY-ESCAPED rendered DOM (text nodes only, skipping
 * code/pre/links), so hostile content cannot smuggle markup through markers.
 */
function annotateDocumentCitations(preview, citations) {
  if (!citations.length) return;
  const ordinal = new Map(citations.map((cite, index) => [cite.id, index + 1]));
  const pattern = /\[([A-Za-z0-9_-]{1,20})\]/g;
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest('pre, code, a')
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  });
  const targets = [];
  while (walker.nextNode()) {
    pattern.lastIndex = 0;
    if (pattern.test(walker.currentNode.nodeValue || '')) targets.push(walker.currentNode);
  }
  for (const node of targets) {
    const text = node.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let last = 0;
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const number = ordinal.get(match[1]);
      if (number === undefined) continue; // unknown marker stays literal via the tail slice
      fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      const chip = document.createElement('sup');
      chip.className = 'doc-cite';
      chip.dataset.citeId = match[1];
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.setAttribute('aria-label', `Evidence citation ${number}`);
      chip.textContent = String(number);
      fragment.appendChild(chip);
      last = match.index + match[0].length;
    }
    if (last === 0) continue;
    fragment.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(fragment, node);
  }
}

function closeDocCitePopover() {
  document.querySelector('.doc-cite-popover')?.remove();
  document.querySelectorAll('.doc-cite.active, .doc-annotation.active').forEach(el => el.classList.remove('active'));
}

function showDocCitePopover(chip) {
  closeDocCitePopover();
  const artifact = state.documents.details.get(state.route.artifactId);
  const cite = (Array.isArray(artifact?.citations) ? artifact.citations : []).find(entry => entry.id === chip.dataset.citeId);
  if (!cite) return;
  chip.classList.add('active');
  const meta = [cite.source, cite.date ? String(cite.date).slice(0, 10) : ''].filter(Boolean).join(' · ');
  const popover = document.createElement('div');
  popover.className = 'doc-cite-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Evidence citation');
  popover.innerHTML = `<strong>${esc(cite.label)}</strong>
    ${meta ? `<span class="doc-annotation-meta">${esc(meta)}</span>` : ''}
    ${cite.quote ? `<blockquote>${esc(cite.quote)}</blockquote>` : ''}
    ${cite.url
      ? `<a href="${attr(cite.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
      : cite.workItemId
        ? `<span class="doc-annotation-meta">Captured evidence <code>${esc(cite.workItemId)}</code></span>`
        : ''}`;
  const shell = chip.closest('.document-preview-shell') || document.body;
  shell.appendChild(popover);
  const chipRect = chip.getBoundingClientRect();
  const shellRect = shell.getBoundingClientRect();
  popover.style.top = `${chipRect.bottom - shellRect.top + 6}px`;
  popover.style.left = `${Math.max(8, Math.min(chipRect.left - shellRect.left - 20, shell.clientWidth - 336))}px`;
  document.querySelector(`[data-annotation-cite="${CSS.escape(chip.dataset.citeId)}"]`)?.classList.add('active');
}

// Citation chips + rail cards: delegated interactions (registered once).
document.addEventListener('click', (event) => {
  const chip = event.target.closest?.('.doc-cite:not(.static)');
  if (chip) {
    event.preventDefault();
    showDocCitePopover(chip);
    return;
  }
  const card = event.target.closest?.('[data-annotation-cite]');
  if (card) {
    const chipTarget = document.querySelector(`.document-rendered .doc-cite[data-cite-id="${CSS.escape(card.dataset.annotationCite)}"]`);
    if (chipTarget) {
      chipTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
      chipTarget.focus({ preventScroll: true });
      chipTarget.classList.add('flash');
      setTimeout(() => chipTarget.classList.remove('flash'), 1600);
    }
    return;
  }
  if (!event.target.closest?.('.doc-cite-popover')) closeDocCitePopover();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDocCitePopover();
  if ((event.key === 'Enter' || event.key === ' ') && event.target?.classList?.contains('doc-cite') && !event.target.classList.contains('static')) {
    event.preventDefault();
    showDocCitePopover(event.target);
  }
});

function hydrateDocumentPreview() {
  const preview = document.querySelector('[data-document-preview]');
  if (!preview || state.route.view !== 'documents' || !state.route.artifactId) return;
  const artifact = state.documents.details.get(state.route.artifactId);
  const content = (typeof artifact?.content === 'string' ? artifact.content : '').slice(0, DOCUMENT_PREVIEW_LIMIT);
  if (preview.classList.contains('document-rendered') && typeof window.formatMarkdownContent === 'function') {
    // The shared chat formatter escapes ALL text before emitting tags, so
    // hostile document content renders literally inside the rich preview.
    preview.innerHTML = window.formatMarkdownContent(content);
    annotateDocumentCitations(preview, Array.isArray(artifact?.citations) ? artifact.citations : []);
  } else {
    preview.textContent = content;
  }
}

async function saveDocumentRevision(artifactId) {
  const documents = state.documents;
  const draft = (documents.editDraft ?? '').trim();
  if (!artifactId || !draft) {
    documents.actionError = 'The edited document cannot be empty.';
    renderRoute({ preserveScroll: true, userAction: true });
    return;
  }
  documents.saving = true;
  documents.actionError = '';
  renderRoute({ preserveScroll: true, userAction: true });
  try {
    const payload = await request(`/product-documents/${encodeURIComponent(artifactId)}/revision`, {
      method: 'POST',
      body: JSON.stringify({ content: documents.editDraft ?? '' }),
    });
    const revised = documentArtifactFromPayload(payload);
    rememberDocumentEntry(documents.details, revised.artifactId, revised);
    documents.editing = false;
    documents.editDraft = null;
    documents.saving = false;
    void loadDocuments({ force: true });
    go(`#/documents/${encodeURIComponent(revised.artifactId)}`);
  } catch (error) {
    documents.saving = false;
    documents.actionError = `Saving the new version failed: ${error?.message || 'unknown error'}`;
    renderRoute({ preserveScroll: true, userAction: true });
  }
}

async function assignDocumentProject(artifactId) {
  const documents = state.documents;
  const artifact = documents.details.get(artifactId);
  const select = document.querySelector('[data-document-project-assignment]');
  if (!artifact || !select || documents.projectAssigning) return;
  const nextProjectId = String(select.value || '').trim();
  const previousProjectId = artifact.projectId || '';
  if (nextProjectId === previousProjectId) {
    toast('Project assignment is already current');
    return;
  }
  documents.projectAssigning = true;
  documents.actionError = '';
  renderRoute({ preserveScroll: true, userAction: true });
  try {
    await request(`/product-documents/${encodeURIComponent(artifactId)}/project`, {
      method: 'PUT',
      body: JSON.stringify(nextProjectId ? { projectId: nextProjectId } : { unassigned: true }),
    });
    documents.details.delete(artifactId);
    await Promise.all([
      loadDocuments({ force: true, renderAfter: false }),
      loadDocument(artifactId, { force: true, renderAfter: false }),
      previousProjectId ? loadProjectDocuments(previousProjectId, { force: true }) : Promise.resolve(),
      nextProjectId ? loadProjectDocuments(nextProjectId, { force: true }) : Promise.resolve(),
    ]);
    toast(nextProjectId
      ? `Filed the full document chain under ${projectById(nextProjectId)?.title || nextProjectId}`
      : 'Moved the full document chain to Unassigned');
  } catch (error) {
    documents.actionError = `Project assignment failed: ${error?.message || 'unknown error'}`;
  } finally {
    documents.projectAssigning = false;
    if (state.route.view === 'documents') renderRoute({ preserveScroll: true, userAction: true });
  }
}

function sendDocumentAnswers(artifactId) {
  const documents = state.documents;
  const artifact = documents.details.get(artifactId);
  const answers = (documents.answersDraft || '').trim();
  if (!artifact || !answers) {
    documents.actionError = 'Type your answers before sending them to BotBoy.';
    renderRoute({ preserveScroll: true, userAction: true });
    return;
  }
  const questions = (Array.isArray(artifact.openQuestions) ? artifact.openQuestions : [])
    .filter(entry => typeof entry === 'string' && entry.trim())
    .slice(0, 10);
  const message = [
    `Create a new complete version of the document titled "${artifact.title}" (artifact ${artifact.artifactId}), incorporating my answers to its open questions.`,
    questions.length ? `Open questions:\n${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}` : '',
    `My answers:\n${answers}`,
  ].filter(Boolean).join('\n\n');
  const input = document.getElementById('chatInput');
  if (!input || typeof window.submitChat !== 'function') {
    documents.actionError = 'The chat panel is unavailable in this session.';
    renderRoute({ preserveScroll: true, userAction: true });
    return;
  }
  documents.answersDraft = '';
  documents.actionError = '';
  input.value = message;
  if (document.getElementById('chat-panel')?.classList.contains('hidden')) window.toggleChat?.();
  void window.submitChat();
  renderRoute({ preserveScroll: true, userAction: true });
}

async function downloadDocument(artifactId, format) {
  const documents = state.documents;
  if (!artifactId || documents.downloading) return;
  documents.downloading = format;
  documents.actionError = '';
  renderRoute({ preserveScroll: true, userAction: true });
  try {
    // The server runs the local conversion tool (pandoc/weasyprint) and
    // streams the file back; the browser then saves it like any download.
    const response = await fetch(`${API}/product-documents/${encodeURIComponent(artifactId)}/export?format=${encodeURIComponent(format)}`);
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (payload?.code === 'pandoc_missing') {
        // Not a dead end: offer the guided install right where the click
        // happened. The card owns the rest of the flow (install → retry).
        documents.pandocPrompt = { artifactId, format, state: 'offer', error: '' };
        return;
      }
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    // A successful conversion clears any resting install card.
    if (documents.pandocPrompt && documents.pandocPrompt.state !== 'installing') documents.pandocPrompt = null;
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1]
      || `document.${format === 'markdown' ? 'md' : format}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    documents.actionError = `Download failed: ${error?.message || 'unknown error'}`;
  } finally {
    documents.downloading = null;
    renderRoute({ preserveScroll: true, userAction: true });
  }
}

// ── Guided pandoc install (owner request 2026-08-28) ──
// A blocked Word/PDF/HTML download offers a one-click Homebrew install that
// runs in BotBoy's chat terminal dock: output streams live, and if brew asks
// anything the user types straight into the PTY (the secret toggle hides
// passwords). When the session completes, the download that started the flow
// retries automatically. The server owns the command; this code only clicks.

const PANDOC_FORMAT_LABELS = { docx: 'Word', pdf: 'PDF', html: 'HTML', markdown: 'Markdown' };

async function startPandocInstall() {
  const prompt = state.documents.pandocPrompt;
  if (!prompt || prompt.state === 'installing') return;
  prompt.state = 'installing';
  prompt.error = '';
  renderRoute({ preserveScroll: true, userAction: true });
  try {
    const res = await fetch(`${API}/product-documents/export-tools/install`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const payload = await res.json().catch(() => ({}));
    if (res.ok && payload.alreadyInstalled) {
      // Installed outside BotBoy in the meantime — just finish the download.
      const { artifactId, format } = prompt;
      state.documents.pandocPrompt = null;
      renderRoute({ preserveScroll: true, userAction: true });
      void downloadDocument(artifactId, format);
      return;
    }
    if (!res.ok) {
      prompt.state = payload?.code === 'homebrew_missing' ? 'homebrew_missing' : 'failed';
      prompt.error = payload?.error || `HTTP ${res.status}`;
      renderRoute({ preserveScroll: true, userAction: true });
      return;
    }
    // Surface the terminal immediately (the version poll would also catch it
    // within a few seconds and auto-open the panel once per session).
    if (document.getElementById('chat-panel')?.classList.contains('hidden')) window.toggleChat?.();
    window.checkChatTerminal?.();
    watchPandocInstall(payload.session?.id);
    renderRoute({ preserveScroll: true, userAction: true });
  } catch (error) {
    prompt.state = 'failed';
    prompt.error = error?.message || 'unknown error';
    renderRoute({ preserveScroll: true, userAction: true });
  }
}

function watchPandocInstall(sessionId) {
  const timer = setInterval(async () => {
    const prompt = state.documents.pandocPrompt;
    if (!prompt || prompt.state !== 'installing') { clearInterval(timer); return; }
    try {
      const res = await fetch(`${API}/chat/terminal/active`);
      if (!res.ok) return;
      const session = (await res.json())?.session;
      if (!session || (sessionId && session.id !== sessionId)) return;
      if (session.status === 'running') return;
      clearInterval(timer);
      if (session.status === 'completed') {
        // Clean exit — pick the download back up where the user left it. If
        // pandoc is somehow still missing, downloadDocument brings the offer
        // card straight back (no silent loop).
        const { artifactId, format } = prompt;
        state.documents.pandocPrompt = null;
        renderRoute({ preserveScroll: true, userAction: true });
        void downloadDocument(artifactId, format);
      } else {
        prompt.state = 'failed';
        prompt.error = 'The install did not finish — the terminal output in the BotBoy panel has the details.';
        renderRoute({ preserveScroll: true, userAction: true });
      }
    } catch { /* transient poll failure — next tick retries */ }
  }, 2000);
}

function renderPandocInstallCard(prompt) {
  const formatLabel = PANDOC_FORMAT_LABELS[prompt.format] || prompt.format;
  if (prompt.state === 'installing') {
    return `<div class="pandoc-install-card" role="status">${icon('activity', 14)}<div><strong>Installing pandoc…</strong><span>Watch the terminal in the BotBoy panel — if it asks anything, type right into it. Your ${esc(formatLabel)} download starts automatically when it finishes.</span></div></div>`;
  }
  if (prompt.state === 'homebrew_missing') {
    return `<div class="pandoc-install-card is-warn" role="alert">${icon('alert', 14)}<div><strong>Homebrew isn't installed on this Mac</strong><span>Install it from <a href="https://brew.sh" target="_blank" rel="noreferrer">brew.sh</a> first, then run <code>brew install pandoc</code> in your terminal — or ask BotBoy in chat to walk you through it.</span><span class="pandoc-actions"><button class="button small" type="button" data-action="documents-pandoc-copy">Copy command</button><button class="button small" type="button" data-action="documents-pandoc-dismiss">Dismiss</button></span></div></div>`;
  }
  if (prompt.state === 'failed') {
    return `<div class="pandoc-install-card is-warn" role="alert">${icon('alert', 14)}<div><strong>The pandoc install didn't finish</strong><span>${esc(prompt.error || '')}</span><span class="pandoc-actions"><button class="button small primary" type="button" data-action="documents-pandoc-install">Try again</button><button class="button small" type="button" data-action="documents-pandoc-copy">Copy command</button><button class="button small" type="button" data-action="documents-pandoc-dismiss">Dismiss</button></span></div></div>`;
  }
  return `<div class="pandoc-install-card" role="alert">${icon('download', 14)}<div><strong>One-time setup for ${esc(formatLabel)} downloads</strong><span>BotBoy converts documents locally with pandoc, which isn't installed yet. Install it with Homebrew (about a minute)? The install runs in a terminal inside BotBoy — output streams live, and if it asks anything you type right into it. Markdown downloads already work without it.</span><span class="pandoc-actions"><button class="button small primary" type="button" data-action="documents-pandoc-install">Install pandoc</button><button class="button small" type="button" data-action="documents-pandoc-copy">Copy command instead</button><button class="button small" type="button" data-action="documents-pandoc-dismiss">Not now</button></span></div></div>`;
}

async function deleteDocument(artifactId) {
  const documents = state.documents;
  if (!artifactId || documents.deleting) return;
  const artifact = documents.details.get(artifactId);
  const title = artifact?.title || 'this document';
  const confirmed = window.confirm(`Delete "${title}"?\n\nThis permanently removes this version. Other versions of the document are kept and stay linked.`);
  if (!confirmed) return;
  documents.deleting = true;
  documents.actionError = '';
  renderRoute({ preserveScroll: true, userAction: true });
  try {
    await request(`/product-documents/${encodeURIComponent(artifactId)}`, { method: 'DELETE' });
    documents.deleting = false;
    documents.details.delete(artifactId);
    documents.detailErrors.delete(artifactId);
    if (Array.isArray(documents.items)) {
      documents.items = documents.items.filter(entry => entry.artifactId !== artifactId);
    }
    void loadDocuments({ force: true, renderAfter: true });
    go('#/documents');
  } catch (error) {
    documents.deleting = false;
    documents.actionError = `Deleting failed: ${error?.message || 'unknown error'}`;
    renderRoute({ preserveScroll: true, userAction: true });
  }
}

function renderPipeline() {
  const health = state.health;
  if (!health) return errorView('Pipeline health is unavailable.');
  const total = totalItems();
  const runs = Array.isArray(health.lastRuns) ? health.lastRuns : [];
  return `${pageHead('System state', 'Pipeline health', 'A read-only operational view of capture, organization, and synthesis.', `<button class="button" type="button" data-action="refresh-core">${icon('refresh')} Refresh</button>`)}
    <section class="card pipeline-flow"><div class="pipeline-stage"><span class="source-icon">${icon('inbox')}</span><strong>Capture</strong><span>Source evidence</span></div><span class="flow-line"></span><div class="pipeline-stage"><span class="source-icon">${icon('file')}</span><strong>Extract</strong><span>Lossless content</span></div><span class="flow-line"></span><div class="pipeline-stage"><span class="source-icon">${icon('branch')}</span><strong>Organize</strong><span>Areas and projects</span></div><span class="flow-line"></span><div class="pipeline-stage"><span class="source-icon">${icon('sparkles')}</span><strong>Synthesize</strong><span>Project brains</span></div></section>
    <section class="grid four-col" style="margin-top:16px"><article class="card pad"><div class="metric-label">Items stored</div><div class="metric-value">${number(total)}</div><div class="metric-note good">Evidence database available</div></article><article class="card pad"><div class="metric-label">Unassigned</div><div class="metric-value">${number(state.inbox.count)}</div><div class="metric-note warn">Available for organization</div></article><article class="card pad"><div class="metric-label">Projects</div><div class="metric-value">${number(health.projectCount ?? state.projects.length)}</div><div class="metric-note good">${number(state.areas.length)} areas</div></article><article class="card pad"><div class="metric-label">Open failures</div><div class="metric-value">${number(health.totalFailures)}</div><div class="metric-note ${health.totalFailures ? 'warn' : 'good'}">${health.totalFailures ? `${number(health.retryableFailures)} retryable` : 'All clear'}</div></article></section>
    <section class="grid two-col" style="margin-top:16px"><article class="card"><div class="card-header"><h2 class="card-title">Processing state</h2><span class="pill ${health.totalFailures ? 'warn' : 'good'}">${health.totalFailures ? 'Attention' : 'Operational'}</span></div>${Object.entries(health.itemsByState || {}).map(([key, value]) => `<div class="health-row"><span class="status-dot good"></span><span><strong>${esc(key.replaceAll('_', ' '))}</strong><small>Recorded work-item state</small></span><strong>${number(value)}</strong></div>`).join('') || '<div class="empty-state">No processing-state rows.</div>'}</article><article class="card"><div class="card-header"><h2 class="card-title">Recent pipeline runs</h2><span class="card-meta">Latest ${number(runs.length)}</span></div>${runs.slice(0, 8).map(run => `<div class="health-row"><span class="status-dot ${run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}"></span><span><strong>${esc(run.pass || 'Pipeline pass')}</strong><small>${number(run.items_in)} in · ${number(run.items_out)} out</small></span><strong>${esc(run.status || 'unknown')}</strong></div>`).join('') || '<div class="empty-state">No recent pipeline runs.</div>'}</article></section>`;
}

function llmUsageToken(value) {
  return value === null || value === undefined
    ? '<span class="analytics-null" title="Provider did not report this detail">—</span>'
    : number(value);
}

function llmUsageModelLabel(model) {
  const raw = String(model || 'Unknown model');
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function llmUsageMetric(models, field) {
  const values = models.map(model => model?.[field]).filter(value => typeof value === 'number' && Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function llmUsageDateKey(date, timeZone) {
  const values = new Map(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function renderLlmUsageSettings() {
  if (!state.llmUsage.data && !state.llmUsage.error && !state.llmUsage.loading) void loadLlmUsage();
  if (!state.llmUsage.data && state.llmUsage.loading) return loadingView();

  const data = state.llmUsage.data;
  const actions = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${[30, 90, 365].map(days => `<button class="button small ${state.llmUsage.days === days ? '' : 'ghost'}" type="button" data-action="llm-usage-range" data-days="${days}">${days}d</button>`).join('')}<button class="button small" type="button" data-action="llm-usage-refresh">${icon('refresh', 14)} Refresh</button></div>`;
  if (!data) {
    return `${pageHead('Settings', 'LLM generation usage', 'Provider-reported usage from this BotBoy installation.', actions)}<section class="card pad"><div class="error-state">${esc(state.llmUsage.error || 'Usage is unavailable.')}<br><button class="button small" type="button" data-action="llm-usage-refresh">Try again</button></div></section>`;
  }

  const todayKey = llmUsageDateKey(new Date(), data.timeZone || state.llmUsage.timeZone);
  const todayModels = data.days?.find(day => day.date === todayKey)?.models || [];
  const todayAttempts = todayModels.reduce((sum, model) => sum + Number(model.attempts || 0), 0);
  const coverage = data.coverage || {};
  const runningAttempts = Number(coverage.runningAttempts || 0);
  const terminalAttempts = Math.max(0, Number(coverage.attempts || 0) - runningAttempts);
  const coverageIssues = Number(coverage.unknownAttempts || 0)
    + Number(coverage.interruptedAttempts || 0)
    + Number(coverage.unrecordedAttemptsSinceBoot || 0)
    + Number(coverage.unattributedAttempts || 0);
  const rows = (data.days || []).flatMap(day => (day.models || []).map(model => ({ day: day.date, ...model })));
  const rangeBusy = state.llmUsage.loading ? `<span class="pill">Refreshing ${number(state.llmUsage.days)}d…</span>` : '';
  const staleNotice = state.llmUsage.error
    ? `<section class="card pad" style="margin-top:16px;border-color:var(--yellow)"><div class="metric-note warn"><strong>Refresh failed.</strong> ${esc(state.llmUsage.error)} Showing the last successful ${number(data.requestedDays)}-day result; the selected ${number(state.llmUsage.days)}-day range has not loaded.</div></section>`
    : '';
  const warning = coverageIssues > 0
    ? `<section class="card pad" style="margin-top:16px;border-color:var(--yellow)"><div class="metric-note warn"><strong>Coverage is incomplete.</strong> ${number(coverage.unknownAttempts || 0)} attempt(s) lack provider usage, ${number(coverage.interruptedAttempts || 0)} were interrupted, ${number(coverage.unattributedAttempts || 0)} are unattributed, and ${number(coverage.unrecordedAttemptsSinceBoot || 0)} recorder persistence gap(s) occurred this boot. Known token totals below remain exact.${runningAttempts > 0 ? ` ${number(runningAttempts)} additional model attempt(s) are in progress and will join totals when terminal.` : ''}</div></section>`
    : runningAttempts > 0
      ? `<section class="card pad" style="margin-top:16px"><div class="metric-note"><strong>Terminal coverage is complete.</strong> ${number(terminalAttempts)} terminal attempt(s) are exact and ${number(runningAttempts)} model attempt(s) are currently in progress; in-flight rows join totals only when they finish.</div></section>`
      : `<section class="card pad" style="margin-top:16px"><div class="metric-note good"><strong>Complete provider coverage for this range.</strong> All ${number(terminalAttempts)} terminal attempt(s) have explicit workload and no recorder gaps.</div></section>`;

  return `${pageHead('Settings', 'LLM generation usage', `Local provider-reported attempts · loaded ${number(data.requestedDays)} days · ${esc(data.timeZone)} · raw history retained indefinitely`, actions)}
    <section class="grid four-col"><article class="card pad"><div class="metric-label">Today total</div><div class="metric-value">${todayAttempts === 0 ? '0' : llmUsageToken(llmUsageMetric(todayModels, 'totalTokens'))}</div><div class="metric-note">Provider total tokens</div></article><article class="card pad"><div class="metric-label">Today input</div><div class="metric-value">${todayAttempts === 0 ? '0' : llmUsageToken(llmUsageMetric(todayModels, 'inputTokens'))}</div><div class="metric-note">Prompt/input tokens</div></article><article class="card pad"><div class="metric-label">Today output</div><div class="metric-value">${todayAttempts === 0 ? '0' : llmUsageToken(llmUsageMetric(todayModels, 'outputTokens'))}</div><div class="metric-note">Includes reasoning when provider totals do</div></article><article class="card pad"><div class="metric-label">Today calls</div><div class="metric-value">${number(todayAttempts)}</div><div class="metric-note">Interactive + background + system</div></article></section>
    ${staleNotice}${warning}
    <section class="card" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">Daily usage by model</h2><div class="card-meta">Cache and reasoning are provider detail subsets; they are not added to Total.</div></div>${rangeBusy}</div>${rows.length ? `<div class="analytics-table-wrap" data-scroll-key="settings:llm-usage:daily"><table class="analytics-table"><thead><tr><th>Day</th><th>Model</th><th class="analytics-number">Input</th><th class="analytics-number">Output</th><th class="analytics-number">Cache read</th><th class="analytics-number">Cache write</th><th class="analytics-number">Reasoning</th><th class="analytics-number">Total</th><th class="analytics-number">Calls</th><th>Workloads</th><th class="analytics-number">Unknown</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.day)}</td><td title="${attr(row.model)}"><strong>${esc(llmUsageModelLabel(row.model))}</strong></td><td class="analytics-number">${llmUsageToken(row.inputTokens)}</td><td class="analytics-number">${llmUsageToken(row.outputTokens)}</td><td class="analytics-number">${llmUsageToken(row.cacheReadTokens)}</td><td class="analytics-number">${llmUsageToken(row.cacheWriteTokens)}</td><td class="analytics-number">${llmUsageToken(row.reasoningTokens)}</td><td class="analytics-number"><strong>${llmUsageToken(row.totalTokens)}</strong></td><td class="analytics-number">${number(row.attempts)}</td><td><span class="card-meta">I ${number(row.interactiveAttempts)} · B ${number(row.backgroundAttempts)} · S ${number(row.systemAttempts)}</span></td><td class="analytics-number">${number(row.unknownAttempts)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">Usage tracking starts after this BotBoy update. Make a chat request or let a background pass run, then refresh.</div>'}</section>`;
}

function renderSettings() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return `${pageHead('Workspace', 'Settings', 'Appearance, diagnostics, and compatibility tools for the local dashboard.')}
    <section class="grid settings-layout"><nav class="card settings-nav"><button class="button ghost" type="button">${icon('settings')} General</button><a class="button ghost" href="#/settings/dashboard-sharing">${icon('globe')} Dashboard sharing</a><a class="button ghost" href="#/settings/llm-usage">${icon('activity')} LLM generation usage</a><button class="button ghost" type="button" data-action="open-nodes">${icon('branch')} Legacy nodes</button><button class="button ghost" type="button" data-action="open-logs">${icon('activity')} Diagnostics</button></nav><article class="card settings-panel"><div class="card-header" style="padding:0 0 16px"><div><h2 class="card-title">General</h2><div class="card-meta">Workspace appearance and behavior</div></div></div><div class="setting-row"><span class="setting-copy"><strong>Dark appearance</strong><span>Switch between BotBoy’s dark and light palettes.</span></span><button class="toggle ${dark ? 'on' : ''}" type="button" data-action="toggle-theme" aria-label="Toggle dark appearance"></button></div><div class="setting-row"><span class="setting-copy"><strong>Contextual assistant</strong><span>The assistant opens when needed instead of permanently consuming workspace width.</span></span><span class="pill accent">Enabled</span></div><div class="setting-row"><span class="setting-copy"><strong>Legacy node browser</strong><span>Available during migration for depth-four nodes and manual node actions.</span></span><button class="button small" type="button" data-action="open-nodes">Open</button></div><div class="setting-row"><span class="setting-copy"><strong>Agent and app logs</strong><span>Open the existing local diagnostics viewer.</span></span><button class="button small" type="button" data-action="open-logs">View logs</button></div></article></section>`;
}

// Repaints rebuild #app-view from scratch, which destroys any text the
// owner is mid-typing — MCP config fields, doc-reader propose forms,
// filter boxes (owner report 2026-08-26: "text disappears if I don't save
// before the next flicker"). In-progress input is detected two ways: a
// focused text control inside the routed view, or a field whose value
// differs from its rendered default (typed, then blurred without saving).
// Checkboxes/radios are exempt from the dirty check — toggles apply
// immediately and a lingering mismatch would suppress refreshes forever.
function hasUnsavedUserInput() {
  const view = document.getElementById('app-view');
  if (!view || view.style.display === 'none') return false;
  const active = document.activeElement;
  if (active && view.contains(active)
    && active.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]')) return true;
  for (const el of view.querySelectorAll('input, textarea')) {
    // Dirty-scan only textual controls: for types like time/number the
    // browser-sanitized .value can diverge from the raw defaultValue without
    // any user action, which would suppress refreshes forever. Non-textual
    // controls are still protected by the focus check above while in use.
    if (el.tagName === 'INPUT' && !['text', 'search', 'url', 'email', 'password', 'tel'].includes(el.type)) continue;
    if (el.value !== el.defaultValue) return true;
  }
  return false;
}

// Routed views now contain persistent descendant scrollers (document readers,
// Today focus panes, and Vega canvases) in addition to #workspace. A wholesale
// #app-view repaint destroys those elements, so preserve their keyed top/left
// offsets across same-route background renders. Keys are opt-in and semantic;
// true navigation deliberately does not restore another route's position.
let routeRenderGeneration = 0;
let routeNavigationEpoch = 0;
let pendingReloadOuterScroll = null;
let pendingReloadKeyedScroll = null;

function enforceShellRootScroll() {
  return enforceRootScrollOrigin({
    scrollingElement: document.scrollingElement,
    scrollWindow: window,
  });
}

function captureKeyedScrollPositions(root = document.getElementById('app-view')) {
  if (!root) return [];
  return Array.from(root.querySelectorAll('[data-scroll-key]'))
    .map(element => ({
      key: String(element.dataset.scrollKey || ''),
      top: element.scrollTop,
      left: element.scrollLeft,
    }))
    .filter(entry => entry.key && (entry.top || entry.left));
}

function restoreKeyedScrollPositions(snapshot, routeKey, generation, retryMs = 2500, onComplete) {
  if (!snapshot.length) { onComplete?.(); return; }
  const pending = new Map(snapshot.map(entry => [entry.key, { ...entry, topDone: entry.top === 0, leftDone: entry.left === 0 }]));
  const startedAt = Date.now();
  const attempt = () => {
    if (generation !== routeRenderGeneration) return;
    if (JSON.stringify(state.route ?? {}) !== routeKey) { onComplete?.(); return; }
    const elements = new Map(Array.from(document.querySelectorAll('#app-view [data-scroll-key]'))
      .map(element => [String(element.dataset.scrollKey || ''), element]));
    const expired = Date.now() - startedAt >= retryMs;
    for (const [key, entry] of pending) {
      const element = elements.get(key);
      if (!element) {
        if (expired) pending.delete(key);
        continue;
      }
      if (!entry.topDone) {
        const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
        if (element.scrollTop !== 0) {
          entry.topDone = true; // owner moved before delayed content became tall
        } else if (maximum >= entry.top || expired) {
          element.scrollTop = Math.min(entry.top, maximum);
          entry.topDone = true;
        }
      }
      if (!entry.leftDone) {
        const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
        if (element.scrollLeft !== 0) {
          entry.leftDone = true; // owner moved before delayed content became wide
        } else if (maximum >= entry.left || expired) {
          element.scrollLeft = Math.min(entry.left, maximum);
          entry.leftDone = true;
        }
      }
      if (entry.topDone && entry.leftDone) pending.delete(key);
    }
    if (pending.size && !expired) setTimeout(attempt, 100);
    else onComplete?.();
  };
  requestAnimationFrame(attempt);
}

// INVERTED DEFAULT (2026-08-26): every render is treated as background
// unless the call site declares `userAction: true`. Background renders
// yield to in-progress typing; user-action renders always paint. A
// mislabeled new call site therefore fails LOUD (a button that seems dead
// while a field is dirty) instead of QUIET (destroyed input). When adding
// a render call inside a user event handler or its async tail, pass
// `userAction: true`; timers, polls, SSE handlers, and fetch-completion
// loaders pass nothing.
function renderRoute({ preserveScroll = false, userAction = false } = {}) {
  // The browser may restore window/document scroll independently of our
  // routed scroller. Normalize it before measuring or painting shell content.
  enforceShellRootScroll();
  const workspace = document.getElementById('workspace');
  const previousScrollTop = workspace?.scrollTop || 0;
  const previousNestedScroll = captureKeyedScrollPositions();
  const previousRouteKey = JSON.stringify(state.route ?? {});
  state.route = parseRoute();
  const routeChanged = JSON.stringify(state.route) !== previousRouteKey;
  if (routeChanged && state.route.view === 'llm-usage-settings') void loadLlmUsage({ force: true });
  // Claim outer-scroll ownership before ANY renderer/loader early return.
  // A true navigation always starts clean and permanently cancels a delayed
  // hard-reload restore, even if the owner later returns to the same hash.
  routeNavigationEpoch = beginRouteNavigation({
    routeChanged,
    navigationEpoch: routeNavigationEpoch,
    workspace,
    cancelPendingRestore: () => {
      pendingReloadOuterScroll?.cancel?.();
      pendingReloadOuterScroll = null;
    },
  });
  // Non-user repaints yield to the owner's in-progress typing: state is
  // already fresh in memory, and the next user-driven render (save, action,
  // navigation) paints it. Real navigation always renders.
  if (!userAction && !routeChanged && hasUnsavedUserInput()) return;
  const renderGeneration = ++routeRenderGeneration;
  // The Slack channel picker and Local-folders panels are OVERLAYS shown
  // imperatively (showIntegration), invisible to the router. A background
  // re-render (version-bump poll) must not slam them shut mid-selection
  // (owner report 2026-08-26: "the channel selection page reloads and I'm
  // back at the top" — every capture closed the overlay). Real navigation
  // (routeChanged) still closes them.
  const overlayOpen = !routeChanged && ['slack-sources', 'local-folders'].some(id => {
    const panel = document.getElementById(id);
    return panel && panel.style.display === 'block';
  });
  const analyticsRoute = state.route.view === 'dashboards' || state.route.view === 'analytics-dashboard';
  window.setAmbientChatContext?.(analyticsRoute ? { mode: 'analytics_dashboard' } : null);
  syncAnalyticsPolling();
  renderSidebar();
  if (!overlayOpen) closeIntegration({ keepLegacy: state.route.view === 'nodes' });
  updateMobileNav();
  updateAssistantContext();
  const view = document.getElementById('app-view');
  destroyAnalyticsVisualizations();
  const visualizationEpoch = analyticsVisualizationEpoch;
  if (state.route.view === 'nodes') {
    showIntegration('nodes', state.route.nodeId);
    return;
  }
  if (state.loading && state.route.view !== 'documents') {
    view.innerHTML = loadingView();
    return;
  }
  if (state.coreError && state.route.view !== 'documents') {
    view.innerHTML = errorView(state.coreError);
    return;
  }
  let html = '';
  if (state.route.view === 'today') html = renderToday();
  if (state.route.view === 'area') html = renderArea(state.route.areaId);
  if (state.route.view === 'project') html = renderProject(state.route.projectId);
  if (state.route.view === 'inbox') html = renderInbox();
  if (state.route.view === 'channels') html = renderChannels();
  if (state.route.view === 'connections') html = renderConnections();
  if (state.route.view === 'mcp-settings') html = renderMcpSettings();
  if (state.route.view === 'grasp-sync-settings') html = renderGraspSyncSettings();
  if (state.route.view === 'sharepoint-sync-settings') html = renderSharePointSyncSettings();
  if (state.route.view === 'doc-reader') html = renderDocReader();
  if (state.route.view === 'mcp-add') html = renderMcpServerForm();
  if (state.route.view === 'mcp-edit') html = renderMcpServerForm({ editing: true, profileId: state.route.profileId });
  if (state.route.view === 'profile-settings') html = renderProfileSettings(state.route.profileId);
  if (state.route.view === 'dashboards') html = renderAnalyticsList();
  if (state.route.view === 'analytics-dashboard') html = renderAnalyticsDashboard(state.route.dashboardId);
  if (state.route.view === 'documents') html = renderDocuments();
  if (state.route.view === 'pipeline') html = renderPipeline();
  if (state.route.view === 'settings') html = renderSettings();
  if (state.route.view === 'publisher-settings') html = renderPublisherSettings();
  if (state.route.view === 'llm-usage-settings') html = renderLlmUsageSettings();
  if (state.route.view === 'not-found') html = errorView('This workspace route does not exist. Use the navigation to open a known view.');
  view.innerHTML = html;
  if (state.route.view === 'documents') {
    hydrateDocumentPreview();
    syncDocumentReaderPresentation(document, state.documents);
    syncDocumentPublicationDialog(document, state.documents);
    restoreDocumentRouteFocus();
  }
  if (state.route.view === 'analytics-dashboard') {
    requestAnimationFrame(() => void hydrateAnalyticsVisualizations(state.route.dashboardId, visualizationEpoch));
  }
  if (state.route.view === 'mcp-settings') requestAnimationFrame(updateMcpFormVisibility);
  // Scroll ownership: only USER-INITIATED renders may reset to top (real
  // navigation). Background renders — polls, loader completions, SSE — always
  // restore the previous position, whether or not preserveScroll was threaded
  // through. Found live 2026-08-26: on project pages every capture cleared the
  // detail cache, and the re-fetch completion render (bare renderRoute()) was
  // yanking the owner to the top even though the poll render preserved scroll.
  const keepScroll = shouldPreserveOuterScroll({
    routeChanged,
    preserveScroll,
    overlayOpen,
    userAction,
  });
  if (workspace) workspace.scrollTop = keepScroll ? previousScrollTop : 0;
  if (keepScroll && !routeChanged) {
    restoreKeyedScrollPositions(previousNestedScroll, previousRouteKey, renderGeneration,
      state.route.view === 'analytics-dashboard' ? 5000 : 2500);
  }
  const reloadSnapshot = pendingReloadKeyedScroll;
  if (reloadSnapshot) {
    if (reloadSnapshot.hash !== location.hash || reloadSnapshot.expiresAt <= Date.now()) {
      pendingReloadKeyedScroll = null;
    } else {
      restoreKeyedScrollPositions(
        reloadSnapshot.positions,
        JSON.stringify(state.route ?? {}),
        renderGeneration,
        reloadSnapshot.expiresAt - Date.now(),
        () => { if (pendingReloadKeyedScroll === reloadSnapshot) pendingReloadKeyedScroll = null; },
      );
    }
  }
  // Focus/hydration/browser-history work can land after this synchronous
  // render. Reassert that only #workspace—not the document root—may scroll.
  requestAnimationFrame(enforceShellRootScroll);
}

function closeIntegration({ keepLegacy = false } = {}) {
  document.querySelectorAll('.integration-panel').forEach(panel => {
    if (!(keepLegacy && panel.id === 'legacy-browser')) panel.style.display = 'none';
  });
  if (!keepLegacy) document.getElementById('app-view').style.display = '';
}

function showIntegration(kind, nodeId = '') {
  document.getElementById('app-view').style.display = 'none';
  document.querySelectorAll('.integration-panel').forEach(panel => { panel.style.display = 'none'; });
  const id = kind === 'slack' ? 'slack-sources' : kind === 'folders' ? 'local-folders' : 'legacy-browser';
  const panel = document.getElementById(id);
  if (panel) panel.style.display = 'block';
  if (kind === 'slack') void window.loadSlackSources?.();
  if (kind === 'folders') void window.loadLocalFolders?.();
  if (kind === 'nodes' && nodeId) setTimeout(() => window.zoomInto?.(nodeId, '', true), 0);
}

function toggleAssistant(force) {
  const panel = document.getElementById('chat-panel');
  const open = force ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  panel.setAttribute('aria-hidden', String(!open));
  document.body.classList.toggle('assistant-open', open);
  document.querySelectorAll('[data-action="toggle-assistant"]').forEach(button => button.setAttribute('aria-expanded', String(open)));
  if (open) setTimeout(() => document.getElementById('chatInput')?.focus(), 220);
  else window.clearChatContext?.();
}

function updateAssistantContext() {
  let label = 'Workspace context';
  if (state.route.view === 'project') label = projectById(state.route.projectId)?.title || 'Project context';
  else if (state.route.view === 'area') label = state.areas.find(area => area.id === state.route.areaId)?.title || 'Area context';
  else if (state.route.view !== 'today') label = `${state.route.view.charAt(0).toUpperCase()}${state.route.view.slice(1)} context`;
  const element = document.getElementById('assistant-context');
  if (element) element.textContent = label;
}

function updateMobileNav() {
  document.querySelectorAll('[data-mobile-view]').forEach(link => {
    const key = link.dataset.mobileView;
    const active = key === state.route.view || (key === 'area' && ['area', 'project'].includes(state.route.view));
    link.classList.toggle('active', active);
  });
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('botboy-theme', next);
  document.querySelectorAll('[data-action="toggle-theme"] use').forEach(use => use.setAttribute('href', next === 'dark' ? '#i-sun' : '#i-moon'));
  if (state.route.view === 'settings' || state.route.view === 'analytics-dashboard') {
    renderRoute({ preserveScroll: state.route.view === 'analytics-dashboard', userAction: true });
  }
}

function toast(message, tone = 'good') {
  const element = document.createElement('div');
  element.className = 'toast';
  element.innerHTML = `${icon(tone === 'bad' ? 'alert' : 'check', 15)}<span></span>`;
  element.querySelector('span').textContent = message;
  document.getElementById('toast-region').appendChild(element);
  setTimeout(() => element.remove(), 3400);
}

function baseCommandItems() {
  const nav = [
    ['Go to Today', 'Workspace overview', 'home', '#/today'],
    ['Open Inbox', `${state.inbox.count == null ? 'Unassigned' : number(state.inbox.count)} evidence items`, 'inbox', '#/inbox'],
    ['Open Documents', `${state.documents.items?.length ?? 'Generated'} product documents`, 'file', '#/documents'],
    ['View Connections', 'Slack, folders, and browser capture', 'link', '#/connections'],
    ['View Pipeline Health', `${number(state.health?.totalFailures)} unresolved failures`, 'activity', '#/pipeline'],
    ['Open Settings', 'Appearance and diagnostics', 'settings', '#/settings'],
  ].map(([title, meta, ico, route]) => ({ title, meta, icon: ico, route, kind: 'Navigation' }));
  const projects = state.projects.slice(0, 30).map(project => ({ title: project.title, meta: areaForProject(project.id)?.title || 'Unsorted project', icon: 'branch', route: `#/projects/${project.id}`, kind: 'Projects' }));
  const actions = [
    { title: 'Ask BotBoy', meta: 'Open the contextual assistant', icon: 'bot', action: 'assistant', kind: 'Actions' },
    { title: 'Open legacy nodes', meta: 'Compatibility hierarchy and manual node tools', icon: 'branch', route: '#/nodes', kind: 'Actions' },
    { title: 'Switch appearance', meta: 'Toggle dark or light theme', icon: 'sun', action: 'theme', kind: 'Actions' },
  ];
  return [...nav, ...projects, ...actions];
}

async function updateCommandResults(query = '') {
  const normalized = query.trim().toLowerCase();
  let items = baseCommandItems().filter(item => !normalized || `${item.title} ${item.meta}`.toLowerCase().includes(normalized));
  if (normalized.length >= 2) {
    try {
      const result = await request(`/search?q=${encodeURIComponent(query.trim())}&limit=12`);
      // Synced documents route to the STAGED reader (#/doc/…), grouped under
      // their own label; runCommand prefers route over url, so these never
      // pop an external tab (owner report 2026-08-27).
      const evidenceItems = (result.results || []).map(entry => (entry.item?.artifactId
        ? {
            title: entry.item?.title || '(untitled authored document)',
            meta: `Authored in BotBoy${entry.node?.title ? ` · ${entry.node.title}` : ''}${entry.snippet ? ` — ${entry.snippet}` : ''}`,
            icon: 'file', route: `#/documents/${encodeURIComponent(entry.item.artifactId)}`, kind: 'Documents',
          }
        : entry.item?.docKey
          ? {
              title: entry.item?.title || '(untitled document)',
              meta: `Synced SharePoint copy${entry.item?.collapsedCount ? ` · ${entry.item.collapsedCount} more capture${entry.item.collapsedCount === 1 ? '' : 's'} collapsed` : ''}${entry.snippet ? ` — ${entry.snippet}` : ''}`,
              icon: 'file', route: `#/doc/${encodeDocKey(entry.item.docKey)}`, kind: 'Documents',
            }
          : {
            title: entry.item?.title || '(untitled evidence)', meta: entry.snippet || entry.item?.summary || 'Evidence',
            icon: sourceIcon(entry.item?.source, entry.item?.type), url: entry.item?.url || '', nodeId: entry.node?.id || '', kind: 'Evidence',
          }));
      items = [...items.slice(0, 12), ...evidenceItems];
    } catch {}
  }
  state.commandItems = items.slice(0, 20);
  state.commandIndex = Math.min(state.commandIndex, Math.max(0, state.commandItems.length - 1));
  renderCommandResults();
}

function renderCommandResults() {
  const groups = [...new Set(state.commandItems.map(item => item.kind))];
  document.getElementById('command-results').innerHTML = state.commandItems.length ? groups.map(group => `<div class="command-group-label">${esc(group)}</div>${state.commandItems.map((item, index) => item.kind === group ? `<button class="command-result ${index === state.commandIndex ? 'selected' : ''}" type="button" data-command-index="${index}"><span class="source-icon">${icon(item.icon, 15)}</span><span><strong>${esc(item.title)}</strong><span>${esc(item.meta)}</span></span><small>${item.route || item.url || item.nodeId ? 'Open' : 'Run'}</small></button>` : '').join('')}`).join('') : '<div class="command-empty">No matching projects, evidence, or commands.</div>';
}

function openCommand() {
  if (state.documents.publicationOpen) closeDocumentPublicationDrawer({ returnFocus: false });
  const dialog = document.getElementById('command-dialog');
  const input = document.getElementById('command-input');
  input.value = '';
  state.commandIndex = 0;
  void updateCommandResults('');
  if (!dialog.open) dialog.showModal();
  setTimeout(() => input.focus(), 20);
}

function runCommand(index) {
  const item = state.commandItems[index];
  if (!item) return;
  document.getElementById('command-dialog').close();
  if (item.route) return go(item.route);
  if (item.url) return window.open(item.url, '_blank', 'noopener');
  if (item.nodeId) return go(`#/nodes/${item.nodeId}`);
  if (item.action === 'assistant') toggleAssistant(true);
  if (item.action === 'theme') toggleTheme();
}

async function organizeInbox() {
  const button = document.querySelector('[data-action="organize-inbox"]');
  if (button) button.disabled = true;
  toast('Inbox organization started. BotBoy will refresh when processing completes.');
  try {
    await window.processInbox?.();
    await loadCore({ quiet: true });
  } catch (error) {
    toast(`Could not organize inbox: ${error.message}`, 'bad');
  } finally {
    if (button) button.disabled = false;
  }
}

function handleTodayPaneWheel(event) {
  if (event.ctrlKey || event.shiftKey) return;
  const pane = event.target?.closest?.('.today-focus-rail, .today-focus-detail');
  if (!pane) return;
  const handoff = todayPaneHandoffDelta({
    scrollTop: pane.scrollTop,
    scrollHeight: pane.scrollHeight,
    clientHeight: pane.clientHeight,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
  });
  if (handoff === 0) return;

  // A nested scroller gets first refusal. This matters for future detail
  // controls: reaching the pane boundary must not steal a gesture while an
  // inner auto/scroll region still has room in that direction.
  let current = event.target instanceof Element ? event.target : null;
  while (current && current !== pane) {
    const overflowY = getComputedStyle(current).overflowY;
    if (/^(auto|scroll|overlay)$/.test(overflowY)) {
      const nestedHandoff = todayPaneHandoffDelta({
        scrollTop: current.scrollTop,
        scrollHeight: current.scrollHeight,
        clientHeight: current.clientHeight,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
      if (nestedHandoff === 0) return;
    }
    current = current.parentElement;
  }

  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  const workspaceHandoff = todayPaneHandoffDelta({
    scrollTop: workspace.scrollTop,
    scrollHeight: workspace.scrollHeight,
    clientHeight: workspace.clientHeight,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
  });
  if (workspaceHandoff !== 0) return; // The page is also at its boundary.
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? workspace.clientHeight
      : 1;
  event.preventDefault();
  workspace.scrollBy({ top: handoff * scale, left: 0, behavior: 'auto' });
}

function bindEvents() {
  // Delegated + non-passive by design: native pane scrolling remains untouched
  // until a vertical gesture reaches a pane boundary, then the same delta is
  // explicitly handed to the workspace instead of trapping page movement.
  document.addEventListener('wheel', handleTodayPaneWheel, { passive: false });
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target?.dataset?.terminalInput) {
      event.preventDefault();
      void sendTerminalInput(event.target.dataset.terminalInput);
    }
  });
  // Keyboard access for task rows (role=button): Enter/Space toggles.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest?.('[data-action="task-toggle"]');
    if (!row || event.target !== row) return;
    event.preventDefault();
    row.click();
  });
  // Roving focus for the focus-board tablists. Both axes work so the same
  // controls remain keyboard-complete when the narrow layout turns horizontal.
  document.addEventListener('keydown', event => {
    const current = event.target.closest?.('.today-focus-tab[role="tab"]');
    const rail = current?.closest('.today-focus-rail[role="tablist"]');
    if (!current || !rail) return;
    const tabs = [...rail.querySelectorAll('.today-focus-tab[role="tab"]')];
    const nextIndex = nextTodayFocusIndex(event.key, tabs.indexOf(current), tabs.length);
    if (nextIndex === null) return;
    event.preventDefault();
    tabs[nextIndex]?.click();
  });
  document.addEventListener('click', event => {
    if (event.target?.matches?.('#document-publication-dialog')) {
      closeDocumentPublicationDrawer();
      return;
    }
    const command = event.target.closest('[data-command-index]');
    if (command) return runCommand(Number(command.dataset.commandIndex));
    const prompt = event.target.closest('[data-prompt]');
    if (prompt) {
      const projectId = prompt.dataset.projectContext || '';
      const projectTitle = prompt.dataset.projectTitle || '';
      const explicitContext = prompt.dataset.chatMode
        ? { mode: prompt.dataset.chatMode, intent: prompt.dataset.chatIntent }
        : {};
      window.setChatContext?.(projectId && projectTitle
        ? { ...explicitContext, projectId, projectTitle }
        : Object.keys(explicitContext).length ? explicitContext : null);
      toggleAssistant(true);
      const input = document.getElementById('chatInput');
      input.value = prompt.dataset.prompt;
      input.focus();
      // Caret at the end: a seed that scopes the question (project name and id)
      // is meant to be continued, not replaced.
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    // Close any open document download menu when the click lands outside it.
    document.querySelectorAll('[data-document-download-menu][open]').forEach(menu => {
      if (!menu.contains(event.target)) menu.removeAttribute('open');
    });
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (['reveal'].includes(action)) return; // handled by app.js's file interceptor
    if (action === 'toggle-sidebar') setMobileSidebarOpen(!document.body.classList.contains('sidebar-open'));
    if (action === 'close-sidebar') setMobileSidebarOpen(false);
    if (action === 'toggle-sidebar-collapse') setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    if (action === 'toggle-assistant') toggleAssistant();
    if (action === 'close-assistant') toggleAssistant(false);
    if (action === 'toggle-theme') toggleTheme();
    if (action === 'open-command') openCommand();
    if (action === 'close-command') document.getElementById('command-dialog').close();
    if (action === 'plan-day') planDay();
    if (action === 'today-refresh') void refreshToday();
    // Overview tiles: jump to the matching section (long attention lists made
    // Meaningful changes a deep scroll — owner ask 2026-09-05). Pinned items
    // lead the attention section, so the Pinned tile shares its anchor.
    if (action === 'today-jump') {
      document.getElementById(target.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (action === 'today-focus') {
      setTodayFocus(target.dataset.section, target.dataset.project);
      renderRoute({ userAction: true, preserveScroll: true });
      revealTodayFocus(target.dataset.section, true);
    }
    if (action === 'today-deferred-focus') {
      const projectId = target.dataset.project;
      state.today.deferredProject = state.today.deferredProject === projectId ? '' : projectId;
      renderRoute({ userAction: true, preserveScroll: true });
      revealTodayDeferredSelection(true, projectId);
    }
    if (action === 'today-project-snooze') void updateTodayProject(target.dataset.project, target.dataset.section, 'snooze');
    if (action === 'today-project-dismiss') void updateTodayProject(target.dataset.project, target.dataset.section, 'dismiss');
    if (action === 'today-project-restore') void updateTodayProject(target.dataset.project, target.dataset.section, 'restore');
    if (action === 'today-pin') void updateTodayItem(target.dataset.item, target.dataset.pinned === 'true' ? 'unpin' : 'pin', target.dataset.version);
    if (action === 'today-done') void updateTodayItem(target.dataset.item, 'mark_done', target.dataset.version);
    if (action === 'today-snooze') void updateTodayItem(target.dataset.item, 'snooze', target.dataset.version);
    if (action === 'today-dismiss') void updateTodayItem(target.dataset.item, 'dismiss', target.dataset.version);
    if (action === 'today-restore') void updateTodayItem(target.dataset.item, 'restore', target.dataset.version);
    if (action === 'toggle-area') {
      const id = target.dataset.area;
      state.expandedAreas.has(id) ? state.expandedAreas.delete(id) : state.expandedAreas.add(id);
      renderSidebar();
    }
    if (action === 'toggle-all-areas') { state.showAllAreas = !state.showAllAreas; renderSidebar(); }
    if (action === 'toggle-people') {
      const id = target.dataset.project;
      state.expandedPeople.has(id) ? state.expandedPeople.delete(id) : state.expandedPeople.add(id);
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'project-tab') {
      state.projectTab = target.dataset.tab;
      if (state.projectTab === 'documents' && state.route.view === 'project') void loadProjectDocuments(state.route.projectId);
      if (state.projectTab === 'artifacts' && state.route.view === 'project') void loadProjectArtifacts(state.route.projectId, { force: true });
      renderRoute({ userAction: true });
    }
    if (action === 'artifact-attach') {
      void assignProjectArtifact(target.dataset.artifact, target.dataset.project, Number(target.dataset.version));
    }
    if (action === 'artifact-assign') {
      const projectId = target.closest('.project-artifact-card')?.querySelector('[data-artifact-project]')?.value || '';
      if (projectId) void assignProjectArtifact(target.dataset.artifact, projectId, Number(target.dataset.version));
    }
    if (action === 'artifact-unassign') {
      void assignProjectArtifact(target.dataset.artifact, null, Number(target.dataset.version));
    }
    if (action === 'artifact-copy-link') {
      void navigator.clipboard?.writeText(target.dataset.url || '').then(() => toast('Artifact link copied.'));
    }
    if (action === 'artifact-retry-unassigned') {
      void loadUnassignedArtifacts(target.dataset.project || state.route.projectId, { force: true });
    }
    if (action === 'doc-comment-jump') {
      const found = jumpToDocPassage(target.dataset.anchor || '');
      if (!found) toast('Passage not found in the current preview (the document may have changed)', 'warn');
    }
    if (action === 'assist-pill') {
      const assist = state.docReader.assist;
      if (assist && assist.phase === 'pill') {
        assist.phase = 'dialog';
        renderRoute({ preserveScroll: true, userAction: true });
        setTimeout(() => document.getElementById('doc-assist-instruction')?.focus(), 30);
      }
    }
    if (action === 'assist-cancel') {
      state.docReader.assist = null;
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'assist-expand') {
      const assist = state.docReader.assist;
      if (assist) { assist.expanded = !assist.expanded; renderRoute({ preserveScroll: true, userAction: true }); }
    }
    if (action === 'assist-send') {
      const assist = state.docReader.assist;
      const docKey = state.docReader.key;
      if (assist && assist.phase === 'dialog' && docKey) {
        assist.instruction = document.getElementById('doc-assist-instruction')?.value ?? assist.instruction ?? '';
        if (!assist.instruction.trim()) { toast('Tell BotBoy what to do with the selection first', 'warn'); return; }
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        assist.phase = 'running';
        assist.error = '';
        assist.nonce = nonce;
        renderRoute({ preserveScroll: true, userAction: true });
        void (async () => {
          try {
            const result = await request('/documents/assist-edit', { method: 'POST', body: {
              docKey, selectedText: assist.selectedText, blockTexts: assist.blockTexts, instruction: assist.instruction,
            } });
            const current = state.docReader.assist;
            if (!current || current.nonce !== nonce) return; // cancelled/superseded — discard
            current.phase = 'proposal';
            current.replacementMarkdown = String(result.replacementMarkdown ?? '');
            current.editShape = result.editShape || null;
            current.expanded = false;
          } catch (error) {
            const current = state.docReader.assist;
            if (!current || current.nonce !== nonce) return;
            current.phase = 'error';
            current.error = String(error?.message || error);
          }
          renderRoute({ preserveScroll: true });
        })();
      }
    }
    if (action === 'assist-approve') {
      const assist = state.docReader.assist;
      const docKey = state.docReader.key;
      const doc = state.docReader.data?.doc;
      if (assist && assist.phase === 'proposal' && assist.editShape && docKey && doc && !assist.approving) {
        assist.approving = true;
        renderRoute({ preserveScroll: true, userAction: true });
        void (async () => {
          try {
            await request('/documents/pending-edits', { method: 'POST', body: {
              docKey, serverRelativeUrl: doc.serverRelativeUrl, siteUrl: doc.siteUrl || undefined,
              kind: 'botboy', preApproved: true,
              originNote: String(assist.instruction || 'BotBoy selection edit').slice(0, 300),
              ...assist.editShape,
            } });
            state.docReader.assist = null;
            toast('Approved — the staged copy shows the new text. Press Sync to publish.');
            await loadDocReader(docKey, { force: true });
          } catch (error) {
            const current = state.docReader.assist;
            if (current) { current.approving = false; current.phase = 'error'; current.error = String(error?.message || error); }
            renderRoute({ preserveScroll: true, userAction: true });
          }
        })();
      }
    }
    if (action === 'assist-reject') {
      state.docReader.assist = null;
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'doc-edit-enter') {
      const data = state.docReader.data;
      if (data && typeof data.contentSha256 === 'string' && data.contentSha256) {
        state.docReader.assist = null; // hygiene (E3): entering edit mode discards transient assist state
        state.docReader.editMode = { active: true, draft: data.content || '', baseSha: data.contentSha256, saving: false, error: '' };
        renderRoute({ userAction: true });
      } else {
        toast('The document is still loading — try again in a moment', 'warn');
      }
    }
    if (action === 'doc-edit-cancel') {
      state.docReader.editMode = null;
      renderRoute({ userAction: true });
    }
    if (action === 'doc-edit-save') {
      const docKey = target.dataset.dockey || '';
      const em = state.docReader.editMode;
      if (docKey && em && !em.saving) {
        em.draft = document.getElementById('doc-edit-draft')?.value ?? em.draft;
        em.saving = true;
        em.error = '';
        renderRoute({ preserveScroll: true, userAction: true });
        void (async () => {
          try {
            const result = await request('/documents/edit-save', { method: 'POST', body: { docKey, draft: em.draft, baseSha: em.baseSha } });
            const staged = (result.staged || []).length;
            const skipped = (result.unsupported || []).length;
            state.docReader.editMode = null;
            toast(staged
              ? `Saved — ${staged} change${staged === 1 ? '' : 's'} staged pre-approved. Review below, then Sync.${skipped ? ` (${skipped} table change${skipped === 1 ? '' : 's'} skipped.)` : ''}`
              : (skipped ? "Only table changes detected — tables can't be edited yet" : 'No changes to save'), staged ? undefined : 'warn');
            await loadDocReader(docKey, { force: true });
          } catch (error) {
            const current = state.docReader.editMode;
            if (current) {
              current.saving = false;
              current.error = String(error?.message || error);
            }
            renderRoute({ preserveScroll: true, userAction: true });
          }
        })();
      }
    }
    if (action === 'doc-edit-decide') {
      const id = target.dataset.id || '';
      const decision = target.dataset.decision || '';
      const docKey = state.docReader.key;
      if (id && decision) {
        void (async () => {
          try {
            await request(`/documents/pending-edits/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: {} });
            await loadDocReader(docKey, { force: true });
          } catch (error) {
            toast(String(error?.message || error), 'warn');
          }
        })();
      }
    }
    if (action === 'doc-sync') {
      const docKey = target.dataset.dockey || '';
      if (docKey && !state.docReader.syncing) {
        state.docReader.syncing = true;
        renderRoute({ preserveScroll: true, userAction: true });
        void (async () => {
          try {
            const result = await request('/documents/sync', { method: 'POST', body: { docKey } });
            if (result.retrying) {
              // 202: someone (a teammate's Word/browser session) holds the
              // SharePoint editing lock — the server retries in background.
              toast(result.note || 'Document is locked — BotBoy will retry automatically and publish when it frees up.');
            } else {
              const synced = (result.results || []).filter(r => r.applied).length;
              const conflicted = (result.results || []).length - synced;
              toast(result.uploaded
                ? `Synced ${synced} change${synced === 1 ? '' : 's'} to SharePoint${conflicted ? `; ${conflicted} conflicted` : ''}${result.verifiedOnReadBack ? ' (verified)' : ''}`
                : 'Nothing uploaded — all approved edits conflicted with the current document', result.uploaded ? undefined : 'warn');
            }
          } catch (error) {
            toast(`Sync failed: ${String(error?.message || error)}`, 'warn');
          } finally {
            state.docReader.syncing = false;
            await loadDocReader(docKey, { force: true });
          }
        })();
      }
    }
    if (action === 'creation-decide') {
      void decideDocumentPublication({
        artifactId: target.dataset.artifact || '',
        pendingEditId: target.dataset.id || '',
        decision: target.dataset.decision === 'approve' ? 'approve' : 'reject',
        projectId: target.dataset.project || '',
        isUpdate: target.dataset.update === 'true',
        isConflict: target.dataset.conflict === 'true',
      });
    }
    if (action === 'creation-sync') {
      void applyDocumentPublication({
        artifactId: target.dataset.artifact || '',
        docKey: target.dataset.dockey || '',
        projectId: target.dataset.project || '',
        isUpdate: target.dataset.update === 'true',
      });
    }
    if (action === 'doc-comment-filter') {
      state.docReader.commentFilter = target.dataset.filter || 'open';
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'doc-sheet') {
      const docKey = target.dataset.dockey || '';
      if (docKey && !state.docReader.sheetView?.loading) void loadDocSheet(docKey, target.dataset.sheet || '');
    }
    if (action === 'doc-sheet-overview') {
      state.docReader.sheetView = state.docReader.sheetView?.data?.sheets
        ? { name: '', loading: false, data: { sheets: state.docReader.sheetView.data.sheets }, error: '' }
        : undefined;
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'doc-refresh') {
      const docKey = target.dataset.dockey || '';
      if (docKey && !state.docReader.refreshing) {
        // Hygiene (E3): a refresh discards transient assist phases; a
        // reviewed proposal survives (its approve payload is content-anchored).
        if (state.docReader.assist && state.docReader.assist.phase !== 'proposal') state.docReader.assist = null;
        state.docReader.refreshing = true;
        renderRoute({ preserveScroll: true, userAction: true });
        void (async () => {
          try {
            await request('/documents/refresh', { method: 'POST', body: { docKey } });
            toast('Document refreshed from SharePoint');
          } catch (error) {
            toast(`Refresh failed: ${String(error?.message || error)}`, 'warn');
          } finally {
            state.docReader.refreshing = false;
            await loadDocReader(docKey, { force: true });
          }
        })();
      }
    }
    if (action === 'evidence-filter') { state.evidenceFilter = target.dataset.filter; renderRoute({ userAction: true }); }
    if (action === 'run-digests') void runChannelDigests();
    if (action === 'review-ambient') void reviewAmbientProjects();
    if (action === 'reject-evidence') void rejectEvidence(target.dataset.project, target.dataset.item);
    if (action === 'restore-evidence') void restoreEvidence(target.dataset.project, target.dataset.item);
    if (action === 'rebuild-brain') void rebuildProjectBrain(target.dataset.project);
    if (action === 'dismiss-relation') void dismissRelation(target.dataset.project, target.dataset.other);
    if (action === 'discard-item') void discardItem(target.dataset.item, target.dataset.project);
    if (action === 'restore-discard') void restoreDiscardedItem(target.dataset.item);
    if (action === 'llm-usage-refresh') {
      void loadLlmUsage({ force: true });
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'llm-usage-range') {
      const days = Number(target.dataset.days);
      if ([30, 90, 365].includes(days) && days !== state.llmUsage.days) {
        state.llmUsage.days = days;
        void loadLlmUsage({ force: true });
        renderRoute({ preserveScroll: true, userAction: true });
      }
    }
    if (action === 'retry-core' || action === 'refresh-core') void loadCore();
    if (action === 'documents-refresh') void refreshDocuments();
    if (action === 'documents-retry-list') void loadDocuments({ force: true });
    if (action === 'documents-retry-detail') void loadDocument(target.dataset.artifact, { force: true });
    if (action === 'documents-toggle-chain') {
      const key = target.dataset.chainKey || '';
      const chains = buildDocumentLibraryView(state.documents.items || [], {
        query: state.documents.libraryQuery,
        sort: state.documents.librarySort,
      });
      const current = documentChainExpansionState(chains, state.route.artifactId || '', state.documents.chainExpansionOverrides).get(key) === true;
      const automatic = documentChainExpansionState(chains, state.route.artifactId || '', new Map()).get(key) === true;
      const next = !current;
      if (next === automatic) state.documents.chainExpansionOverrides.delete(key);
      else state.documents.chainExpansionOverrides.set(key, next);
      const chain = target.closest('.document-chain');
      const history = chain?.querySelector('.document-chain-history');
      target.setAttribute('aria-expanded', String(next));
      target.querySelector('svg')?.style.setProperty('transform', next ? 'rotate(180deg)' : '');
      if (history) history.hidden = !next;
      chain?.classList.toggle('is-expanded', next);
      chain?.classList.toggle('is-collapsed', !next);
      const selectedNote = chain?.querySelector('.document-chain-selected-hidden');
      if (selectedNote) selectedNote.hidden = next;
      return;
    }
    if (action === 'documents-clear-search') {
      state.documents.libraryQuery = '';
      state.documents.pendingFocus = { target: 'library-search', artifactId: state.route.artifactId || '' };
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'documents-publication-toggle') {
      if (state.documents.publicationOpen) {
        closeDocumentPublicationDrawer();
        return;
      }
      const artifactId = state.route.artifactId || '';
      const artifact = state.documents.details.get(artifactId);
      const view = artifact?.publicationState;
      const origin = ['status', 'toolbar', 'summary'].includes(target.dataset.publicationTrigger)
        ? target.dataset.publicationTrigger
        : 'summary';
      state.documents.publicationTrigger = origin;
      state.documents.publicationOpen = true;
      if (view && !state.documents.publicationDraft) {
        state.documents.publicationDraft = defaultPublicationDraft(view, artifact?.publicationDestinationDefault);
      }
      void resolvePublicationDestinationDefault(artifactId);
      state.documents.pendingFocus = { target: 'publication', artifactId };
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'documents-publication-close') {
      closeDocumentPublicationDrawer();
      return;
    }
    if (action === 'documents-publication-mode') {
      const artifact = state.documents.details.get(state.route.artifactId || '');
      const view = artifact?.publicationState;
      const draft = { ...(state.documents.publicationDraft || defaultPublicationDraft(view, artifact?.publicationDestinationDefault)) };
      draft.mode = target.dataset.mode === 'update_existing' ? 'update_existing' : 'create';
      if (draft.mode === 'update_existing' && !draft.basePublicationId && view?.updateBases?.length === 1) {
        draft.basePublicationId = view.updateBases[0].publicationId;
      }
      state.documents.publicationDraft = draft;
      state.documents.publicationError = '';
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'documents-publication-stage') {
      void stageDocumentPublication(state.route.artifactId || '');
    }
    if (action === 'documents-publication-retry') {
      const artifact = state.documents.details.get(state.route.artifactId || '');
      const view = artifact?.publicationState;
      state.documents.publicationDraft = {
        ...(state.documents.publicationDraft || defaultPublicationDraft(view, artifact?.publicationDestinationDefault)),
        mode: 'update_existing',
        basePublicationId: target.dataset.base || '',
      };
      void stageDocumentPublication(state.route.artifactId || '', { basePublicationId: target.dataset.base || '' });
    }
    if (action === 'documents-publication-decide') {
      const artifactId = state.route.artifactId || '';
      const artifact = state.documents.details.get(artifactId);
      const attempt = artifact?.publicationState?.attempt;
      void decideDocumentPublication({
        artifactId,
        pendingEditId: target.dataset.id || attempt?.pendingEditId || '',
        decision: target.dataset.decision === 'approve' ? 'approve' : 'reject',
        projectId: artifact?.projectId || '',
        isUpdate: attempt?.action === 'update_existing',
        isConflict: artifact?.publicationState?.phase === 'conflicted',
      });
    }
    if (action === 'documents-publication-sync') {
      const artifactId = state.route.artifactId || '';
      const artifact = state.documents.details.get(artifactId);
      const attempt = artifact?.publicationState?.attempt;
      void applyDocumentPublication({
        artifactId,
        docKey: target.dataset.dockey || attempt?.docKey || '',
        projectId: artifact?.projectId || '',
        isUpdate: attempt?.action === 'update_existing',
      });
    }
    if (action === 'documents-publication-refresh') {
      const artifactId = state.route.artifactId || '';
      void loadDocument(artifactId, { force: true });
    }
    if (action === 'documents-toggle-library') {
      if (!state.route.artifactId) return;
      const isMobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches;
      const result = toggleDocumentLibraryState(state.documents, { isMobile, hasArtifact: true });
      Object.assign(state.documents, result.state);
      if (result.navigateToList) {
        go('#/documents');
        return;
      }
      updateDocumentReaderPresentation({ transition: 'library', focusTarget: 'library-control' });
    }
    if (action === 'documents-toggle-review') {
      const embeddedWidth = currentEmbeddedDocumentShellWidth();
      const next = toggleDocumentReviewState(state.documents, embeddedWidth);
      Object.assign(state.documents, next);
      updateDocumentReaderPresentation({
        focusTarget: next.reviewOpen ? 'review' : 'review-control',
      });
    }
    if (action === 'documents-focus') {
      if (!state.documents.focusMode) currentEmbeddedDocumentShellWidth();
      const next = toggleDocumentFocusState(state.documents);
      Object.assign(state.documents, next);
      updateDocumentReaderPresentation({
        transition: 'focus',
        focusTarget: next.focusMode ? 'focus-content' : 'focus-control',
      });
    }
    if (action === 'documents-preview-mode') {
      state.documents.previewMode = target.dataset.mode === 'plain' ? 'plain' : 'rendered';
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'documents-edit') {
      const artifact = state.documents.details.get(target.dataset.artifact);
      state.documents.editing = true;
      state.documents.editDraft = typeof artifact?.content === 'string' ? artifact.content : '';
      state.documents.actionError = '';
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'documents-cancel-edit') {
      state.documents.editing = false;
      state.documents.editDraft = null;
      state.documents.actionError = '';
      renderRoute({ preserveScroll: true, userAction: true });
    }
    if (action === 'documents-save-revision') void saveDocumentRevision(target.dataset.artifact);
    if (action === 'documents-set-project') void assignDocumentProject(target.dataset.artifact);
    if (action === 'documents-send-answers') sendDocumentAnswers(target.dataset.artifact);
    if (action === 'documents-download') void downloadDocument(target.dataset.artifact, target.dataset.format);
    if (action === 'documents-pandoc-install') void startPandocInstall();
    if (action === 'documents-pandoc-dismiss') { state.documents.pandocPrompt = null; renderRoute({ preserveScroll: true, userAction: true }); }
    if (action === 'documents-pandoc-copy') {
      void navigator.clipboard?.writeText('brew install pandoc').then(() => {
        target.textContent = 'Copied';
        setTimeout(() => { target.textContent = 'Copy command'; }, 1600);
      });
    }
    if (action === 'documents-delete') void deleteDocument(target.dataset.artifact);
    if (action === 'manage-connection') {
      if (target.dataset.connection === 'managed' && target.dataset.profile) go(`#/connections/${target.dataset.profile}`);
      else if (target.dataset.connection === 'mcp') go('#/connections/sql-context');
      else showIntegration(target.dataset.connection);
    }
    if (action === 'grasp-sync-run') {
      void graspSyncAction('run', async () => {
        const payload = await request('/grasp-sync/run', { method: 'POST', body: {} });
        if (payload.status) state.graspSync.status = payload.status;
        const result = payload.result || {};
        if (result.status === 'completed') toast('Sync completed');
        else toast(`Sync ${result.status || 'failed'}${result.reason ? `: ${result.reason}` : ''}`, 'bad');
        await refreshGraspSyncStatus();
      });
    }
    if (action === 'analytics-context-save') {
      const dir = document.getElementById('analytics-context-dir')?.value ?? '';
      void (async () => {
        try {
          const saved = await request('/mcp/analytics-context', { method: 'POST', body: { dir } });
          // The config write response has no onboarding block — keep the one we have.
          state.mcp.analyticsContext = { ...saved, onboarding: state.mcp.analyticsContext?.onboarding ?? null };
          toast('Analytics knowledge directory saved');
        } catch (error) {
          toast(error?.message || 'Could not save the analytics knowledge directory', 'bad');
        }
        if (state.route.view === 'profile-settings') renderRoute({ preserveScroll: true });
      })();
    }
    if (action === 'analytics-context-generate' || action === 'analytics-context-regenerate') {
      const regenerate = action === 'analytics-context-regenerate';
      void (async () => {
        try {
          const payload = await request('/mcp/analytics-context/generate', { method: 'POST', body: { regenerate } });
          if (state.mcp.analyticsContext) state.mcp.analyticsContext.onboarding = payload.onboarding;
          toast(regenerate ? 'Regenerating all presets — this runs for a while' : 'Preset generation started — this runs for a while');
        } catch (error) {
          toast(error?.message || 'Could not start preset generation', 'bad');
        }
        if (state.route.view === 'profile-settings') renderRoute({ preserveScroll: true });
        scheduleAnalyticsOnboardingPoll();
      })();
    }
    if (action === 'grasp-sync-toggle') {
      void graspSyncAction('toggle', async () => {
        const next = !(state.graspSync.status?.enabled ?? true);
        const payload = await request('/grasp-sync/config', { method: 'PUT', body: { enabled: next } });
        state.graspSync.status = payload.status;
        toast(next ? 'Automatic sync resumed' : 'Automatic sync paused — browser email capture is active again');
      });
    }
    if (action === 'grasp-sync-save-owner') {
      void graspSyncAction('owner', async () => {
        const value = document.getElementById('grasp-sync-owner')?.value ?? '';
        const payload = await request('/grasp-sync/config', { method: 'PUT', body: { ownerEmail: value.trim() } });
        state.graspSync.status = payload.status;
        toast(value.trim() ? 'Owner address saved' : 'Owner address cleared — re-detected on the next sync');
      });
    }
    if (action === 'sharepoint-sync-run') {
      void sharepointSyncAction('run', async () => {
        const payload = await request('/sharepoint-sync/run', { method: 'POST', body: {} });
        state.sharepointSync.status = payload.status || state.sharepointSync.status;
        const totals = Object.values(payload.result?.perSource || {}).reduce((acc, c) => acc + (c.enqueued || 0), 0);
        toast(payload.result?.status === 'skipped'
          ? `Sync skipped: ${payload.result?.reason || 'not ready'}`
          : `Discovery complete — ${totals} document${totals === 1 ? '' : 's'} queued`);
      });
    }
    if (action === 'sharepoint-sync-toggle') {
      void sharepointSyncAction('toggle', async () => {
        const next = !(state.sharepointSync.status?.enabled ?? false);
        const payload = await request('/sharepoint-sync/config', { method: 'PUT', body: { enabled: next } });
        state.sharepointSync.status = payload.status || state.sharepointSync.status;
      });
    }
    if (action === 'sharepoint-source-remove') {
      const id = target.dataset.id;
      void sharepointSyncAction('remove', async () => {
        const remaining = (state.sharepointSync.status?.sources || []).filter(s => s.id !== id)
          .map(({ id: _id, queued: _q, surgePending: _s, ...rest }) => rest);
        const payload = await request('/sharepoint-sync/config', { method: 'PUT', body: { sources: remaining } });
        state.sharepointSync.status = payload.status || state.sharepointSync.status;
      });
    }
    if (action === 'sharepoint-add-source') {
      const kind = target.dataset.kind;
      void sharepointSyncAction('add', async () => {
        const baseline = document.getElementById('sharepoint-baseline')?.value || 'days90';
        const current = (state.sharepointSync.status?.sources || []).map(({ id: _id, queued: _q, surgePending: _s, ...rest }) => rest);
        const payload = await request('/sharepoint-sync/config', { method: 'PUT', body: { sources: [...current, { kind, baseline }] } });
        state.sharepointSync.status = payload.status || state.sharepointSync.status;
      });
    }
    if (action === 'sharepoint-surge-confirm') {
      const id = target.dataset.id;
      void sharepointSyncAction('surge', async () => {
        const payload = await request('/sharepoint-sync/confirm-surge', { method: 'POST', body: { sourceId: id } });
        state.sharepointSync.status = payload.status || state.sharepointSync.status;
      });
    }
    if (action === 'sharepoint-purge') {
      if (!window.confirm('Remove ALL synced SharePoint documents from BotBoy? This deletes their evidence items, search entries, and cached files. Documents in SharePoint itself are untouched.')) return;
      void sharepointSyncAction('purge', async () => {
        const payload = await request('/sharepoint-sync/purge', { method: 'POST', body: {} });
        state.sharepointSync.status = payload.status || state.sharepointSync.status;
        toast(`Purged ${payload.result?.items ?? 0} synced documents`);
      });
    }
    if (action === 'sharepoint-site-search') {
      void sharepointSyncAction('sites', async () => {
        const query = document.getElementById('sharepoint-site-query')?.value?.trim() || '';
        const payload = await request(`/sharepoint/sites?query=${encodeURIComponent(query)}`);
        state.sharepointSync.sites = Array.isArray(payload.sites) ? payload.sites : [];
        state.sharepointSync.libraries = [];
        if (!state.sharepointSync.sites.length) toast('No sites matched — try a different name');
      });
    }
    if (action === 'sharepoint-load-libraries') {
      void sharepointSyncAction('libraries', async () => {
        const siteUrl = document.getElementById('sharepoint-site-pick')?.value || '';
        state.sharepointSync.pickedSite = siteUrl;
        const payload = await request(`/sharepoint/libraries?siteUrl=${encodeURIComponent(siteUrl)}`);
        state.sharepointSync.libraries = Array.isArray(payload.libraries) ? payload.libraries : [];
        if (!state.sharepointSync.libraries.length) toast('No document libraries found on that site');
      });
    }
    if (action === 'sharepoint-add-library') {
      void sharepointSyncAction('add', async () => {
        const libraryName = document.getElementById('sharepoint-library-pick')?.value || '';
        const folderPath = document.getElementById('sharepoint-folder-path')?.value?.trim() || '';
        const baseline = document.getElementById('sharepoint-baseline')?.value || 'days90';
        const siteUrl = state.sharepointSync.pickedSite;
        const current = (state.sharepointSync.status?.sources || []).map(({ id: _id, queued: _q, surgePending: _s, ...rest }) => rest);
        const source = { kind: 'library', siteUrl, libraryName, baseline, ...(folderPath ? { folderPath } : {}) };
        const payload = await request('/sharepoint-sync/config', { method: 'PUT', body: { sources: [...current, source] } });
        state.sharepointSync.status = payload.status || state.sharepointSync.status;
        state.sharepointSync.libraries = [];
        state.sharepointSync.sites = [];
        toast(`Added library "${libraryName}"`);
      });
    }
    if (action === 'grasp-sync-save-noise') {
      void graspSyncAction('noise', async () => {
        const raw = document.getElementById('grasp-sync-noise')?.value ?? '';
        const noiseSenders = raw.split('\n').map(line => line.trim()).filter(Boolean);
        const payload = await request('/grasp-sync/config', { method: 'PUT', body: { noiseSenders } });
        state.graspSync.status = payload.status;
        toast('Noise sender list saved');
      });
    }
    if (action === 'mcp-test') void testMcpConnection();
    if (action === 'mcp-restart') void restartMcpConnection();
    if (action === 'profile-action' && target.dataset.profile && target.dataset.act) {
      void runProfileAction(target.dataset.profile, target.dataset.act);
    }
    if (action === 'mcp-server-save') void saveMcpServer(target.dataset.mode, target.dataset.profile || '');
    if (action === 'mcp-server-delete' && target.dataset.profile) void deleteMcpServer(target.dataset.profile);
    if (action === 'terminal-run' && target.dataset.profile && target.dataset.command) {
      void startTerminalCommand(target.dataset.profile, target.dataset.command);
    }
    if (action === 'terminal-send' && target.dataset.profile) void sendTerminalInput(target.dataset.profile);
    if (action === 'terminal-stop' && target.dataset.profile) void stopTerminalCommand(target.dataset.profile);
    if (action === 'task-toggle') {
      const key = target.dataset.taskKey || '';
      state.taskActions.expandedKey = state.taskActions.expandedKey === key ? '' : key;
      state.taskActions.discardArmedKey = '';
      renderRoute({ preserveScroll: true });
    }
    if (action === 'task-set-state') void projectTaskSetState(target.dataset.project, target.dataset.taskB64, target.dataset.state);
    if (action === 'task-discard') void projectTaskDiscard(target.dataset.project, target.dataset.taskB64);
    if (action === 'analytics-refresh') void refreshAnalyticsDashboard(target.dataset.dashboard);
    if (action === 'analytics-cancel-refresh') void cancelAnalyticsRefresh(target.dataset.dashboard);
    if (action === 'analytics-delete') void deleteAnalyticsDashboard(target.dataset.dashboard);
    if (action === 'share-prepare') void prepareDashboardShare(target.dataset.dashboard);
    if (action === 'publisher-toggle') {
      const id = target.dataset.provider;
      const current = state.publisher.expandedProvider !== undefined
        ? state.publisher.expandedProvider
        : (state.publisher.config?.id || 'harmony');
      state.publisher.expandedProvider = current === id ? null : id;
      renderRoute({ userAction: true });
    }
    if (action === 'harmony-install-cli') void installHarmonyCliAction();
    if (action === 'harmony-mwinit') void openHarmonyMwinitTerminal();
    if (action === 'harmony-provision-plan') void showHarmonyProvisionPlan();
    if (action === 'harmony-provision-confirm') void confirmHarmonyProvision();
    if (action === 'harmony-provision-cancel') { state.publisher.provisionPlan = null; renderRoute({ userAction: true }); }
    if (action === 'share-cancel') cancelDashboardShare(target.dataset.dashboard);
    if (action === 'share-confirm') void publishDashboardShare(target.dataset.dashboard);
    if (action === 'close-integration') go(state.route.view === 'nodes' ? '#/settings' : '#/connections');
    if (action === 'organize-inbox') void organizeInbox();
    if (action === 'open-nodes') go('#/nodes');
    if (action === 'open-logs') window.toggleLogViewer?.();
  });

  document.addEventListener('submit', event => {
    if (event.target?.matches('.analytics-project-form')) {
      event.preventDefault();
      void saveAnalyticsProjectLinks(event.target);
      return;
    }
    if (event.target?.matches('.analytics-schedule-form')) {
      event.preventDefault();
      void saveAnalyticsSchedule(event.target);
      return;
    }
    if (event.target?.dataset?.publisherProvider) {
      event.preventDefault();
      void savePublisherConfig(event.target);
      return;
    }
    if (event.target?.id === 'mcp-config-form') {
      event.preventDefault();
      void saveMcpConfig();
    }
  });
  // 'toggle' does not bubble, so persist the open-questions panel state from
  // the capture phase; re-renders then keep the user's choice.
  document.addEventListener('toggle', event => {
    if (event.target?.matches?.('.project-artifact-attach')) {
      if (state.route.view !== 'project') return;
      const entry = state.projectArtifacts.get(state.route.projectId);
      if (!entry) return;
      entry.attachOpen = event.target.open;
      if (event.target.open && entry.unassigned === null && !entry.unassignedLoading) {
        void loadUnassignedArtifacts(state.route.projectId);
      }
      return;
    }
    if (event.target?.matches?.('[data-document-questions]')) {
      state.documents.questionsOpen = event.target.open;
      return;
    }
    if (event.target?.matches?.('[data-document-details]')) {
      state.documents.detailsOpen = event.target.open;
    }
  }, true);

  document.addEventListener('cancel', event => {
    if (!event.target?.matches?.('#document-publication-dialog')) return;
    event.preventDefault();
    closeDocumentPublicationDrawer();
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.documents.publicationOpen && state.route.view === 'documents') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDocumentPublicationDrawer();
      return;
    }
    if (event.key === 'Escape' && state.documents.focusMode && state.route.view === 'documents') {
      event.preventDefault();
      event.stopImmediatePropagation();
      Object.assign(state.documents, toggleDocumentFocusState(state.documents));
      updateDocumentReaderPresentation({ transition: 'focus', focusTarget: 'focus-control' });
    }
  });

  document.addEventListener('input', event => {
    if (event.target?.matches?.('[data-document-search]')) {
      state.documents.libraryQuery = event.target.value;
      // This field is a synchronized view filter, not unsaved authored text.
      // Keep defaultValue aligned so background freshness is not frozen.
      event.target.defaultValue = event.target.value;
      updateDocumentLibraryResults();
      return;
    }
    if (event.target?.id === 'doc-edit-draft' && state.docReader.editMode) {
      state.docReader.editMode.draft = event.target.value;
      return;
    }
    if (event.target?.id === 'doc-assist-instruction' && state.docReader.assist) {
      state.docReader.assist.instruction = event.target.value;
      return;
    }
    if (event.target?.matches('[data-document-editor]')) {
      state.documents.editDraft = event.target.value;
      return;
    }
    if (event.target?.matches('[data-document-answers]')) {
      state.documents.answersDraft = event.target.value;
      return;
    }
    if (event.target?.matches('[data-publication-destination], [data-publication-site]')) {
      const artifact = state.documents.details.get(state.route.artifactId || '');
      const draft = { ...(state.documents.publicationDraft || defaultPublicationDraft(artifact?.publicationState, artifact?.publicationDestinationDefault)) };
      if (event.target.matches('[data-publication-site]')) draft.siteUrl = event.target.value;
      else if (draft.destinationMode === 'path') draft.serverRelativeUrl = event.target.value;
      else draft.targetFolder = event.target.value;
      state.documents.publicationDraft = draft;
      state.documents.publicationDraftTouched = true;
      event.target.defaultValue = event.target.value;
      return;
    }
    if (!event.target?.matches('.analytics-project-search')) return;
    const query = event.target.value.trim().toLowerCase();
    const form = event.target.closest('.analytics-project-form');
    form?.querySelectorAll('.analytics-project-option').forEach(option => {
      option.hidden = Boolean(query) && !(option.textContent || '').toLowerCase().includes(query);
    });
  });

  document.addEventListener('change', event => {
    if (event.target?.matches?.('[data-publication-format], [data-publication-destination-mode], [data-publication-base]')) {
      const artifact = state.documents.details.get(state.route.artifactId || '');
      const draft = { ...(state.documents.publicationDraft || defaultPublicationDraft(artifact?.publicationState, artifact?.publicationDestinationDefault)) };
      if (event.target.matches('[data-publication-format]')) draft.format = event.target.value === 'md' ? 'md' : 'docx';
      if (event.target.matches('[data-publication-destination-mode]')) {
        draft.destinationMode = event.target.value === 'path' ? 'path' : 'folder';
        if (draft.destinationMode === 'path') draft.targetFolder = '';
        else draft.serverRelativeUrl = '';
      }
      if (event.target.matches('[data-publication-base]')) {
        draft.basePublicationId = event.target.value;
        draft.mode = 'update_existing';
      }
      state.documents.publicationDraft = draft;
      state.documents.publicationDraftTouched = true;
      state.documents.publicationError = '';
      renderRoute({ preserveScroll: true, userAction: true });
      return;
    }
    if (!event.target?.matches?.('[data-document-sort]')) return;
    const value = event.target.value;
    state.documents.librarySort = value === 'title' || value === 'status' ? value : 'recent';
    state.documents.pendingFocus = { target: 'library-sort', artifactId: state.route.artifactId || '' };
    renderRoute({ preserveScroll: true, userAction: true });
  });
  // Selection → Ask BotBoy (E3): mouseup inside the reader content captures
  // the selection as block indexes + texts (preview-space; the server
  // re-anchors against the synced base). Only null/pill phases react —
  // dialog, running, and proposal persist until resolved.
  document.addEventListener('mouseup', event => {
    if (state.route.view !== 'doc-reader' || state.docReader.editMode) return;
    const phase = state.docReader.assist?.phase;
    if (phase && phase !== 'pill') return;
    if (event.target?.closest?.('.doc-assist-pill, .doc-assist-dialog, .doc-assist-card')) return;
    setTimeout(() => {
      if (state.route.view !== 'doc-reader' || state.docReader.editMode) return;
      const current = state.docReader.assist?.phase;
      if (current && current !== 'pill') return;
      const clearPill = () => {
        if (state.docReader.assist) { state.docReader.assist = null; renderRoute({ preserveScroll: true, userAction: true }); }
      };
      const sel = window.getSelection();
      const shell = document.querySelector('.document-preview-shell');
      if (!sel || sel.isCollapsed || !shell || sel.rangeCount === 0) return clearPill();
      const text = String(sel.toString() || '').trim();
      if (!text) return clearPill();
      const range = sel.getRangeAt(0);
      const blockOf = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('[data-md-block]');
      const startBlock = blockOf(range.startContainer);
      const endBlock = blockOf(range.endContainer);
      if (!startBlock || !endBlock || !shell.contains(startBlock) || !shell.contains(endBlock)) return clearPill();
      const blockStart = Number(startBlock.dataset.mdBlock);
      const blockEnd = Number(endBlock.dataset.mdBlock);
      if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd) || blockEnd < blockStart) return clearPill();
      const blocks = mdBlocksUi(docPreviewContent(state.docReader.data).previewContent);
      const blockTexts = blocks.slice(blockStart, blockEnd + 1);
      if (!blockTexts.length) return clearPill();
      const rect = range.getBoundingClientRect();
      state.docReader.assist = {
        phase: 'pill',
        blockStart,
        blockEnd,
        selectedText: text,
        blockTexts,
        rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
        instruction: state.docReader.assist?.instruction || '',
      };
      renderRoute({ preserveScroll: true, userAction: true });
    }, 0);
  });
  document.addEventListener('change', event => {
    if (event.target?.id === 'mcp-auth-method' || event.target?.id === 'mcp-context-source') {
      updateMcpFormVisibility();
    }
  });

  document.getElementById('chatInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      window.submitChat?.();
    }
  });
  // Mobile: the bottom nav stays visible under the chat panel (2026-08-28),
  // so a route tap while the panel covers the workspace would change the page
  // invisibly behind it — close the panel so the navigation is seen. The
  // BotBoy button in the nav keeps its own toggle behavior.
  document.querySelector('.mobile-nav')?.addEventListener('click', event => {
    if (!event.target.closest('a[href]')) return;
    if (window.matchMedia('(max-width:820px)').matches && document.body.classList.contains('assistant-open')) toggleAssistant(false);
  });
  document.getElementById('command-input').addEventListener('input', event => {
    clearTimeout(state.commandTimer);
    state.commandIndex = 0;
    state.commandTimer = setTimeout(() => void updateCommandResults(event.target.value), 180);
  });
  document.getElementById('command-input').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); state.commandIndex = Math.min(state.commandItems.length - 1, state.commandIndex + 1); renderCommandResults(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); state.commandIndex = Math.max(0, state.commandIndex - 1); renderCommandResults(); }
    if (event.key === 'Enter') { event.preventDefault(); runCommand(state.commandIndex); }
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommand(); }
    if (event.key === 'Escape' && !document.getElementById('command-dialog').open && !document.getElementById('chat-panel').classList.contains('hidden')) toggleAssistant(false);
  });
}

// Last moment the owner touched the page (pointer/keys/scroll). The reload
// branch below defers while this is fresh — a self-reload must never yank
// the page mid-read or mid-scroll (owner report 2026-09-03: reader flow
// jumped to top; the post-reload scroll restore yields the moment the owner
// scrolls, so a reload landing DURING reading loses the place by design of
// the yield). Deferral is safe: trackers revert, the next 5s poll retries,
// and the reload lands at the first quiet moment.
let lastUserActivityAt = 0;
for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
  window.addEventListener(evt, () => { lastUserActivityAt = Date.now(); }, { passive: true, capture: true });
}
window.addEventListener('resize', () => {
  if (state.documents.publicationOpen && state.route.view === 'documents') {
    syncDocumentPublicationDialog(document, state.documents);
  }
}, { passive: true });
const USER_QUIET_MS = 12000;

async function pollVersion() {
  try {
    const payload = await request('/dashboard/version');
    const previousVersion = state.lastVersion;
    const previousAnalyticsVersion = state.lastAnalyticsVersion;
    const previousDocumentsVersion = state.lastDocumentsVersion;
    const previousBootId = state.lastBootId;
    const previousUiVersion = state.lastUiVersion;
    state.lastVersion = payload.version;
    state.lastAnalyticsVersion = payload.analyticsVersion ?? '0';
    state.lastDocumentsVersion = payload.documentsVersion ?? '0';
    state.lastBootId = payload.bootId ?? null;
    state.lastUiVersion = payload.uiVersion ?? null;

    // Reload the tab when the code it runs is stale. Two triggers:
    //  - bootId change: the server restarted (possibly with new UI code).
    //  - uiVersion change: UI assets on disk changed WITHOUT a restart —
    //    BotBoy edits + rebuilds while the server keeps running, and
    //    express.static serves the new files immediately, but this tab keeps
    //    executing old JavaScript forever. Incident 2026-09-03: a correct
    //    chart fix read as two "failed" verification rounds because the
    //    verifying tab never re-fetched.
    // Stash the scroll position so the reload lands the owner back where
    // they were (owner report 2026-08-26: "the page randomly refreshes and
    // I lose my place"), and stash any half-typed chat draft the same way.
    const bootChanged = previousBootId && payload.bootId && payload.bootId !== previousBootId;
    const uiChanged = previousUiVersion && payload.uiVersion && payload.uiVersion !== previousUiVersion;
    if (bootChanged || uiChanged) {
      const streamLive = document.querySelector('#chat-messages .streaming-live');
      const ownerBusy = Date.now() - lastUserActivityAt < USER_QUIET_MS;
      if (streamLive || ownerBusy) {
        // Defer: a reload now would kill a live SSE consumer mid-turn
        // (streamLive) or yank the page out from under active reading/
        // typing/scrolling (ownerBusy). Revert the trackers so the next
        // poll (5s) re-detects the change; the reload lands at the first
        // quiet moment.
        state.lastBootId = previousBootId;
        state.lastUiVersion = previousUiVersion;
      } else {
        try {
          sessionStorage.setItem('botboy-reload-scroll', JSON.stringify({
            hash: location.hash,
            top: document.getElementById('workspace')?.scrollTop || 0,
          }));
        } catch {}
        try {
          const positions = captureKeyedScrollPositions();
          if (positions.length) sessionStorage.setItem('botboy-reload-keyed-scroll', JSON.stringify({ hash: location.hash, positions }));
          else sessionStorage.removeItem('botboy-reload-keyed-scroll');
        } catch {}
        try {
          const draft = document.getElementById('chatInput')?.value || '';
          if (draft.trim()) sessionStorage.setItem('botboy-reload-draft', draft);
        } catch {}
        location.reload();
        return;
      }
    }

    if (previousVersion !== null && payload.version !== previousVersion) {
      // Project details are cached separately from the core read models.
      // Drop them before rendering a capture/assignment revision so the
      // active project fetches its newly connected evidence as well.
      // STALE-WHILE-REVALIDATE for the project ON SCREEN: a bare clear made
      // the poll render paint a loading skeleton, and the collapsed height
      // clamped workspace.scrollTop to 0 in the browser itself — no scroll
      // logic can undo that (owner report 2026-08-26: project page "jumps to
      // top randomly without any click"). Keep the stale detail painted,
      // then refetch and swap in place: both paints are full-height, so the
      // background-render scroll preservation actually holds.
      const activeProjectId = state.route.view === 'project' ? state.route.projectId : '';
      const staleDetail = activeProjectId ? state.projectDetails.get(activeProjectId) : undefined;
      const staleDocs = activeProjectId ? state.projectDocuments.get(activeProjectId) : undefined;
      state.projectDetails.clear();
      state.projectDocuments.clear();
      state.projectErrors.clear();
      if (staleDetail) state.projectDetails.set(activeProjectId, staleDetail);
      if (staleDocs) state.projectDocuments.set(activeProjectId, staleDocs);
      await loadCore({ quiet: true });
      // Refetch WITHOUT deleting first — the stale detail stays painted for
      // the whole fetch, so no render (this one or a racing poll tick) can
      // ever see a missing detail and collapse the view.
      if (staleDetail) void loadProject(activeProjectId, { force: true });
      if (staleDocs) void loadProjectDocuments(activeProjectId, { force: true });
    }

    if (previousDocumentsVersion !== null && state.lastDocumentsVersion !== previousDocumentsVersion) {
      if (state.documents.loading || state.documents.refreshing) {
        // A request that started before the durable version changed can return
        // the old bounded page. Re-arm this comparison so the next poll
        // performs one conclusive fetch after the in-flight request settles.
        state.lastDocumentsVersion = previousDocumentsVersion;
      } else if (state.route.view === 'documents') {
        await loadDocuments({ force: true, renderAfter: false });
        if (state.documents.error) {
          // Structured retry: keep the old tracker until a later poll proves
          // that the newly-versioned library was loaded successfully.
          state.lastDocumentsVersion = previousDocumentsVersion;
        }
        if (state.route.view === 'documents') renderRoute({ preserveScroll: true });
      } else {
        // Do not fetch resident context for a hidden surface. Invalidate the
        // bounded page now; the Documents route will retrieve it on demand.
        state.documents.items = null;
        state.documents.total = null;
        state.documents.error = '';
      }
    }

    if (previousAnalyticsVersion !== null && state.lastAnalyticsVersion !== previousAnalyticsVersion) {
      if (state.route.view === 'analytics-dashboard') {
        const id = state.route.dashboardId;
        const cached = state.analytics.details.get(id);
        if (!analyticsActiveRun(cached)) {
          await loadAnalyticsDashboard(id, { force: true, preserveScroll: true });
        }
      } else if (state.route.view === 'dashboards') {
        await loadAnalyticsDashboards({ force: true });
      } else {
        state.analytics.items = null;
        state.analytics.details.clear();
      }
    }
  } catch {}
}

function initialize() {
  // The root document is fixed shell chrome; browser history must not restore
  // it independently of #workspace. The scroll listener catches late native
  // restoration (including after pageshow) without touching nested scrollers.
  try { history.scrollRestoration = 'manual'; } catch {}
  window.addEventListener('scroll', enforceShellRootScroll, { passive: true });
  window.addEventListener('pageshow', enforceShellRootScroll);
  enforceShellRootScroll();
  const theme = localStorage.getItem('botboy-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true', { persist: false });
  setMobileSidebarOpen(false);
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/today');
  state.route = parseRoute();
  try {
    const raw = sessionStorage.getItem('botboy-reload-keyed-scroll');
    sessionStorage.removeItem('botboy-reload-keyed-scroll');
    const parsed = raw ? JSON.parse(raw) : null;
    const positions = Array.isArray(parsed?.positions)
      ? parsed.positions.slice(0, 100).map(entry => ({
          key: String(entry?.key || '').slice(0, 240),
          top: Math.max(0, Number(entry?.top) || 0),
          left: Math.max(0, Number(entry?.left) || 0),
        })).filter(entry => entry.key && (entry.top || entry.left))
      : [];
    if (parsed?.hash === location.hash && positions.length) {
      pendingReloadKeyedScroll = { hash: location.hash, positions, expiresAt: Date.now() + 8000 };
    }
  } catch {}
  queueDocumentRouteFocus({ view: '' }, state.route);
  bindEvents();
  window.addEventListener('botboy:page-layout-ready', event => {
    const { scopeType, scopeId } = event.detail || {};
    const isCurrentArea = scopeType === 'area' && state.route.view === 'area' && state.route.areaId === scopeId;
    const isCurrentProject = scopeType === 'project' && state.route.view === 'project' && state.route.projectId === scopeId;
    if (isCurrentArea || isCurrentProject) renderRoute({ preserveScroll: true });
  });
  window.addEventListener('botboy:project-artifact-changed', () => {
    state.projectArtifacts.clear();
    if (state.route.view === 'project' && state.projectTab === 'artifacts') {
      void loadProjectArtifacts(state.route.projectId, { force: true });
    }
  });
  // Replace the legacy fixed-rail toggle with the new contextual drawer behavior.
  window.toggleChat = () => toggleAssistant();
  window.addEventListener('hashchange', () => {
    setMobileSidebarOpen(false);
    const previousRoute = state.route;
    const previousView = previousRoute.view;
    const nextRoute = parseRoute();
    queueDocumentRouteFocus(previousRoute, nextRoute);
    state.projectTab = 'brief';
    state.evidenceFilter = 'all';
    if (nextRoute.view === 'today' && previousView !== 'today') {
      state.today.data = null;
      state.today.error = '';
      renderRoute({ userAction: true });
      void openTodayVisit();
      return;
    }
    renderRoute({ userAction: true });
  });
  renderRoute();
  // Install the one-shot hard-reload scroll owner synchronously, before core
  // hydration yields to the event loop. A route change can now cancel this
  // delayed writer even if the owner navigates away and back while loadCore
  // is still pending. The restore itself waits until the page is tall enough.
  let savedScroll = null;
  try { savedScroll = sessionStorage.getItem('botboy-reload-scroll'); } catch {}
  if (savedScroll !== null) {
    try { sessionStorage.removeItem('botboy-reload-scroll'); } catch {}
    const snapshot = parseReloadScrollSnapshot(savedScroll, location.hash);
    if (snapshot) {
      pendingReloadOuterScroll?.cancel?.();
      const restoreOwner = { cancel: null };
      pendingReloadOuterScroll = restoreOwner;
      restoreOwner.cancel = startOuterScrollRestore({
        snapshot,
        navigationEpoch: routeNavigationEpoch,
        getNavigationEpoch: () => routeNavigationEpoch,
        getHash: () => location.hash,
        getScroller: () => document.getElementById('workspace'),
        onFinish: () => {
          if (pendingReloadOuterScroll === restoreOwner) pendingReloadOuterScroll = null;
        },
      });
    }
  }
  void loadCore();
  setInterval(() => { if (!document.hidden) void pollVersion(); }, 5000);
}

window.BotBoyDashboard = { refresh: () => loadCore(), go };
// Chat deeplinks: the message renderer in app.js turns project titles and ids
// BotBoy mentions into links back into the dashboard. It reads the canonical
// list from here so the two can never drift out of sync.
window.botboyProjectLinkIndex = () => state.projects.map(project => ({ id: project.id, title: project.title }));
initialize();
