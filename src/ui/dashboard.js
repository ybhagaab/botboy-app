// BotBoy production workspace — live Area → Project → Brain → Evidence UI.
// The legacy app.js remains loaded for its proven chat streaming and capture-settings
// workflows; this module owns the new shell, routing, and read-model rendering.

import { renderTodayView } from './today.js';

const API = '/api';
const DOCUMENT_LIST_LIMIT = 100;
const DOCUMENT_PREVIEW_LIMIT = 200_000;
const DOCUMENT_DETAIL_CACHE_LIMIT = 3;

const state = {
  loading: true,
  coreError: '',
  areas: [],
  projects: [],
  projectDetails: new Map(),
  projectErrors: new Map(),
  health: null,
  today: { data: null, error: '', opening: false, pending: new Set() },
  inbox: { count: null, items: [], limit: 100, offset: 0 },
  inboxError: '',
  slack: { configured: null, error: '' },
  folders: { items: null, error: '' },
  graspSync: { status: null, error: '', busy: '' },
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
  },
  analytics: {
    items: null,
    details: new Map(),
    error: '',
    loading: false,
    refreshing: new Set(),
    scheduling: new Set(),
    linkingProjects: new Set(),
    deleting: new Set(),
    pollTimer: null,
    polling: false,
    announcedRuns: new Set(),
    visualizationViews: new Map(),
  },
  publisher: { config: null, error: '', loading: false, saving: false, preparing: new Set(), pending: new Map(), publishing: new Set() },
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
    // Per-selected-artifact view state; reset whenever the selection changes.
    uiArtifactId: '',
    previewMode: 'rendered',
    editing: false,
    editDraft: null,
    answersDraft: '',
    saving: false,
    actionError: '',
    fullscreen: false,
    questionsOpen: true,
    downloading: null,
    deleting: false,
  },
  rebuilding: new Set(),
  evidencePending: new Set(),
  discarded: { data: null, error: '' },
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
  lastBootId: null,
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
  if (parts[0] === 'connections' && parts[1] === 'add') return { view: 'mcp-add' };
  if (parts[0] === 'connections' && parts[1] && parts[2] === 'edit') return { view: 'mcp-edit', profileId: parts[1] };
  // Every other managed MCP profile uses the generic settings page.
  if (parts[0] === 'connections' && parts[1]) return { view: 'profile-settings', profileId: parts[1] };
  if (parts[0] === 'settings' && parts[1] === 'dashboard-sharing') return { view: 'publisher-settings' };
  if (parts[0] === 'dashboards') return { view: parts[1] ? 'analytics-dashboard' : 'dashboards', dashboardId: parts[1] || '' };
  if (parts[0] === 'documents') {
    let artifactId = parts[1] || '';
    try { artifactId = decodeURIComponent(artifactId); } catch {}
    return { view: 'documents', artifactId };
  }
  if (['inbox', 'channels', 'connections', 'pipeline', 'settings', 'nodes'].includes(parts[0])) return { view: parts[0] };
  return { view: 'not-found' };
}

function go(hash) {
  closeIntegration();
  setMobileSidebarOpen(false);
  if (location.hash === hash) renderRoute();
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
  const [areasResult, projectsResult, todayResult, healthResult, inboxResult, slackConfigResult, foldersResult, mcpResult, graspSyncResult] = await Promise.allSettled([
    request('/areas'),
    request('/projects'),
    todayRequest,
    request('/pipeline/health'),
    request(`/items/unassigned/summary?limit=${state.inbox.limit}&offset=0`),
    request('/slack/config'),
    request('/local-folders'),
    request('/mcp/profiles'),
    request('/grasp-sync/status'),
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
  renderRoute();
}

async function openTodayVisit({ propagate = false } = {}) {
  if (state.today.opening) return;
  state.today.opening = true;
  state.today.data = null;
  state.today.error = '';
  if (state.route.view === 'today') renderRoute();
  let failure = null;
  try {
    state.today.data = await request('/today/visit', { method: 'POST' });
  } catch (error) {
    state.today.error = error.message;
    failure = error;
  } finally {
    state.today.opening = false;
    if (state.route.view === 'today') renderRoute();
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
  if (render && state.route.view === 'today') renderRoute();
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

function focusTodayControl(itemId, preferredAction) {
  const controls = [...document.querySelectorAll('[data-item]')];
  const preferred = controls.find(control => control.dataset.item === itemId && control.dataset.action === preferredAction);
  const fallback = controls.find(control => control.dataset.item === itemId);
  (preferred || fallback)?.focus();
}

async function updateTodayItem(itemId, action, expectedVersion) {
  if (!itemId || state.today.pending.has(itemId)) return;
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
      renderRoute();
      if (succeeded) requestAnimationFrame(() => focusTodayControl(itemId, ['snooze', 'dismiss'].includes(action) ? 'today-restore' : 'today-pin'));
    } else {
      setTodayControlsDisabled(itemId, false);
    }
  }
}

function planDay() {
  const data = state.today.data;
  const actions = (data?.attention || []).slice(0, 8);
  const waiting = (data?.waiting || []).slice(0, 5);
  const changes = (data?.changes || []).slice(0, 4);
  const lines = ['Today plan'];

  if (actions.length) {
    lines.push('', 'Start with:');
    actions.forEach((item, index) => lines.push(`${index + 1}. ${item.title} — ${item.projectTitle}`));
  } else {
    lines.push('', 'No explicit action is currently ranked.');
  }
  if (waiting.length) {
    lines.push('', 'Waiting or blocked to review:');
    waiting.forEach(item => lines.push(`• ${item.title} — ${item.projectTitle}`));
  }
  if (changes.length) {
    lines.push('', 'Meaningful changes to scan:');
    changes.forEach(item => lines.push(`• ${item.projectTitle}: ${item.title}`));
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

async function loadProject(id, { renderAfter = true } = {}) {
  if (!id || state.projectDetails.has(id)) return state.projectDetails.get(id);
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
        || (view === 'settings' && route.view === 'publisher-settings');
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

function renderToday() {
  return renderTodayView({
    data: state.today.data,
    error: state.today.error,
    pending: state.today.pending,
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
  const tabs = [['brief', 'Brief'], ['tasks', `Tasks ${brain.tasks?.length || 0}`], ['evidence', `Evidence ${project.itemCount}`], ['timeline', 'Timeline']];
  let content = '';
  if (state.projectTab === 'brief') content = renderProjectBrief(project, detail, area);
  if (state.projectTab === 'tasks') content = renderProjectTasks(brain);
  if (state.projectTab === 'evidence') content = renderEvidence(project, detail.items || [], detail);
  if (state.projectTab === 'timeline') content = renderTimeline(brain.activityLog || []);
  const fallbackHtml = `<div class="breadcrumb"><a href="#/today">Workspace</a>${icon('chevron-right', 11)}${area ? `<a href="#/areas/${encodeURIComponent(area.id)}">${esc(area.title)}</a>${icon('chevron-right', 11)}` : ''}<span>Project</span></div><header class="page-head"><div><div class="project-title-row"><h1 class="page-title">${esc(brain.title || project.title)}</h1><span class="pill ${projectTone(project, detail)}"><span class="status-dot ${projectTone(project, detail)}"></span>${esc(statusLabel(project))}</span></div><p class="project-status-line">${esc(brain.statusLine || project.oneLiner || 'No current status line has been synthesized.')}</p><div class="project-meta"><span>${icon('refresh', 13)} Updated ${esc(relativeTime(brain.updated || project.updatedAt))}</span><span>${icon('file', 13)} ${number(project.itemCount)} evidence items</span><span>${icon('shield', 13)} Local workspace</span>${detail.scopeAlertCount ? `<span class="pill warn" title="Evidence flagged by the brain pass because it also anchors another project's scope. Dominant foreign anchors are quarantined from synthesis; the rest are advisory. Review in the Evidence tab.">${icon('alert', 12)} Scope alerts: ${number(detail.scopeAlertCount)}</span>` : ''}</div></div><div class="head-actions"><button class="button" type="button" data-action="rebuild-brain" data-project="${attr(project.id)}" ${state.rebuilding.has(project.id) ? 'disabled' : ''}>${icon('refresh')} ${state.rebuilding.has(project.id) ? 'Rebuilding…' : 'Rebuild from evidence'}</button><button class="button primary" type="button" data-prompt="${attr(projectAskSeed(brain.title || project.title, project.id))}">${icon('sparkles')} Ask BotBoy</button></div></header><div class="tabs" role="tablist" aria-label="Project sections">${tabs.map(([id, label]) => `<button class="tab ${state.projectTab === id ? 'active' : ''}" type="button" role="tab" aria-selected="${state.projectTab === id}" data-action="project-tab" data-tab="${id}">${esc(label)}</button>`).join('')}</div><div role="tabpanel">${content}</div>`;
  return window.BotBoyLayouts?.renderProject({
    project,
    detail,
    area,
    activeTab: state.projectTab,
    rebuilding: state.rebuilding.has(project.id),
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
    <div class="section-heading"><div><h2>Next actions</h2><p>Explicit open tasks from the project brain, newest evidence first.</p></div></div><section class="grid two-col"><article class="card task-list">${tasks.length ? tasks.slice(0, 8).map(task => `<div class="task-row"><span class="task-state ${task.state === 'done' ? 'done' : ''}">${task.state === 'done' ? icon('check', 12) : ''}</span><span class="task-copy"><strong>${esc(task.text)}</strong><span>${esc(taskDateLabel(task))}</span></span><span class="pill ${task.state === 'blocked' ? 'warn' : ''}">${esc(task.state)}</span></div>`).join('') : '<div class="empty-state"><h3>No open actions</h3><p>The current brain has no open task recorded.</p></div>'}</article><article class="card blocker"><div class="eyebrow">${icon(blockers.length ? 'alert' : 'check', 14)} ${blockers.length ? 'Current blockers' : 'Clear path'}</div>${blockers.length ? blockers.map(blocker => `<div><h3>${esc(blocker)}</h3></div>`).join('') : '<h3>No active blocker is recorded.</h3>'}</article></section>
    ${renderAmbientSignals(detail)}
    <div class="section-heading"><div><h2>Recent evidence</h2><p>The source layer underneath this synthesis.</p></div><button class="text-link" type="button" data-action="project-tab" data-tab="evidence">View all ${icon('arrow-right', 13)}</button></div><section class="card evidence-list">${evidenceRows((detail.items || []).slice(0, 5), project)}</section>`;
}

function renderAmbientSignals(detail) {
  const crossLinks = Array.isArray(detail.crossLinks) ? detail.crossLinks : [];
  if (!crossLinks.length) return '';
  return `<div class="section-heading"><div><h2>Ambient signals</h2><p>Related discussion in channels you follow passively. Context only — never treated as project evidence.</p></div></div>
    <section class="card evidence-list">${crossLinks.slice(0, 6).map(link => `<article class="evidence-row"><span class="source-icon">${icon('hash', 15)}</span><div class="evidence-copy"><div class="evidence-title">${esc(link.topic)}</div><p>Recently discussed in #${esc(link.channelName)}.</p><div class="evidence-meta"><span class="pill">ambient</span><span class="pill">${esc(relativeTime(link.createdAt))}</span><a class="text-link" href="#/channels">Open channel digests</a></div></div></article>`).join('')}</section>`;
}

function renderProjectTasks(brain) {
  const tasks = sortTasksForDisplay(Array.isArray(brain.tasks) ? brain.tasks : []);
  return `<div class="section-heading" style="margin-top:0"><div><h2>Project actions</h2><p>Tasks are read from the current project brain — active first, newest evidence first.</p></div></div><section class="card task-list">${tasks.length ? tasks.map(task => `<div class="task-row"><span class="task-state ${task.state === 'done' ? 'done' : ''}">${task.state === 'done' ? icon('check', 12) : ''}</span><span class="task-copy"><strong>${esc(task.text)}</strong><span>${esc(taskDateLabel(task))}</span></span><span class="pill ${task.state === 'blocked' ? 'warn' : task.state === 'done' ? 'good' : task.state === 'doing' ? 'accent' : ''}">${esc(task.state)}</span></div>`).join('') : '<div class="empty-state"><h3>No tasks recorded</h3><p>BotBoy will show explicit tasks here when the project brain contains them.</p></div>'}</section>`;
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
    return `<article class="evidence-row"><span class="source-icon">${icon(sourceIcon(item.source, item.type), 15)}</span><div class="evidence-copy"><div class="evidence-title">${esc(item.title || '(untitled evidence)')}</div><p>${esc(item.summary || `${item.type || 'Evidence'} captured from ${item.source || 'an unknown source'}.`)}</p><div class="evidence-meta"><span class="pill">${esc((item.type || 'item').replaceAll('_', ' '))}</span><span class="pill">${esc(item.source || 'unknown')}</span>${scopeAlert}${item.url ? `<a class="text-link" href="${attr(item.url)}" target="_blank" rel="noopener">Open source</a>` : ''}${filePath ? `<a class="text-link" href="#" data-action="reveal" data-path="${attr(filePath)}">Reveal file</a>` : ''}</div></div><div class="today-item-side"><time>${esc(relativeTime(item.capturedAt || item.captured_at))}</time>${rejectControl}</div></article>`;
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
    renderRoute();
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
    renderRoute();
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
    renderRoute();
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
    if (state.route.view === 'project' && state.route.projectId === projectId) renderRoute();
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
    if (state.route.view === 'project' && state.route.projectId === projectId) renderRoute();
  }
}

async function rebuildProjectBrain(projectId) {
  if (!projectId || state.rebuilding.has(projectId)) return;
  state.rebuilding.add(projectId);
  renderRoute();
  try {
    const result = await request('/pipeline/rebuild-brains', { method: 'POST', body: { projectId } });
    if (result?.status === 'rebuilt') toast(`Brain rebuilt from ${number(result.items)} evidence item(s)`);
    else toast('Rebuild skipped — the model may be unavailable or the project has no evidence', 'bad');
    state.projectDetails.delete(projectId);
  } catch (error) {
    toast(`Rebuild failed: ${error.message}`, 'bad');
  } finally {
    state.rebuilding.delete(projectId);
    if (state.route.view === 'project' && state.route.projectId === projectId) renderRoute();
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
  renderRoute();
  try {
    const result = await request('/channels/digests/run', { method: 'POST', body: {} });
    if (result?.status === 'deferred') toast('The model is unavailable — digest run deferred', 'bad');
    else toast(`Digests updated: ${result.digestsWritten} written, ${result.crossLinksCreated} new cross-links`);
    await loadChannels({ force: true });
  } catch (error) {
    toast(`Digest run failed: ${error.message}`, 'bad');
  } finally {
    state.channels.running = false;
    if (state.route.view === 'channels') renderRoute();
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
    renderRoute();
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
  renderRoute();
  try {
    await work();
    state.graspSync.error = '';
  } catch (error) {
    toast(`Sync settings error: ${error.message}`);
  } finally {
    state.graspSync.busy = '';
    renderRoute();
  }
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
  const captureCards = [
    ['message', 'Slack', state.slack.error ? 'Unavailable' : slackCount == null ? 'Checking' : 'Connected', state.slack.error ? 'warn' : 'good', slackCount == null ? 'Configuration unavailable' : `${number(slackCount)} conversations configured`, 'slack'],
    ['folder', 'Local folders', state.folders.error ? 'Unavailable' : folderCount == null ? 'Checking' : 'Connected', state.folders.error ? 'warn' : 'good', folderCount == null ? 'Configuration unavailable' : `${number(folderCount)} enabled folders`, 'folders'],
    ['clock', 'Outlook mail & calendar', graspSyncCard.status, graspSyncCard.tone, graspSyncCard.detail, 'grasp-sync'],
    ['globe', 'Browser capture', 'Available', 'good', total == null ? 'Captured evidence is stored locally' : `${number(total)} total evidence items in the local store`, 'browser'],
  ];
  const connectionsAsk = 'I want to add a new MCP server to BotBoy. I will paste a link to its documentation, npm, or GitHub page. Fetch the link, derive the launch command, arguments, and environment variables, confirm anything ambiguous with me, then add it with mcp_add_custom_server so I can review and start it.';
  return `${pageHead('Sources', 'Connections', 'Manage where evidence and analytical context come from, and verify each local connection.', `<button class="button" type="button" data-prompt="${attr(connectionsAsk)}">${icon('sparkles')} Ask BotBoy to add one</button><a class="button primary" href="#/connections/add">${icon('plus', 14)} Add MCP server</a>`)}
    <section class="grid three-col">${captureCards.map(([ico, name, status, tone, detail, action]) => `<article class="card connection-card"><div class="connection-head"><span class="source-icon">${icon(ico, 19)}</span><span class="pill ${tone}"><span class="status-dot ${tone}"></span>${esc(status)}</span></div><h3>${esc(name)}</h3><p>${esc(detail)}</p><div class="connection-details"><span><span>Data handling</span><strong>Local evidence store</strong></span><span><span>Lifecycle</span><strong>${state.health?.totalFailures ? 'Needs review' : 'Healthy'}</strong></span></div>${action === 'browser' ? `<a class="button small" href="#/pipeline">View capture health ${icon('chevron-right', 12)}</a>` : action === 'grasp-sync' ? `<a class="button small" href="#/connections/mail-calendar-sync">Manage ${icon('chevron-right', 12)}</a>` : `<button class="button small" type="button" data-action="manage-connection" data-connection="${action}">Manage ${icon('chevron-right', 12)}</button>`}</article>`).join('')}
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
        ${sidePanels}
        ${requiredTools.length
    ? `<article class="card pad"><div class="eyebrow">${icon('activity', 14)} Required tools</div><h3 class="card-title">${number(requiredTools.length - missingTools.length)} of ${number(requiredTools.length)} found</h3><p class="page-subtitle">${missingTools.length ? `Missing: ${missingTools.map(name => esc(name)).join(', ')}` : profile.compatibilityState === 'compatible' ? 'All fixed tool names are present.' : 'Start and test the server to check tool names.'}</p>${profile.lastHealthyAt ? `<div class="mcp-fact"><span>Last healthy</span><strong>${esc(relativeTime(profile.lastHealthyAt))}</strong></div>` : ''}</article>`
    : `<article class="card pad"><div class="eyebrow">${icon('activity', 14)} Discovered tools</div><h3 class="card-title">${number((profile.tools || []).length)} available</h3><p class="page-subtitle">${(profile.tools || []).length ? 'Tool names and descriptions are listed on this page for your review.' : 'Start the server, then run Test to discover tools.'}</p>${profile.lastHealthyAt ? `<div class="mcp-fact"><span>Last healthy</span><strong>${esc(relativeTime(profile.lastHealthyAt))}</strong></div>` : ''}</article>`}
      </aside>
    </section>`;
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
  renderRoute({ preserveScroll: true });
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
    if (state.route.view === 'profile-settings') renderRoute({ preserveScroll: true });
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
  renderRoute();
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
    if (state.route.view === 'profile-settings') renderRoute();
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
    renderRoute();
    return;
  }
  state.mcp.serverForm.saving = true;
  state.mcp.serverForm.error = '';
  renderRoute();
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
    if (state.route.view === 'mcp-add' || state.route.view === 'mcp-edit') renderRoute();
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
    if (state.route.view === 'mcp-settings') renderRoute();
  }
}

async function testMcpConnection() {
  if (state.mcp.testing) return;
  state.mcp.testing = true;
  renderRoute();
  try {
    const payload = await request('/mcp/sql-context/test', { method: 'POST', body: {} });
    mergeServerSnapshot(payload.server);
    toast(payload.result?.text?.startsWith('Connected') ? 'Redshift connection is healthy' : 'Connection check completed');
  } catch (error) {
    await loadMcpConfig({ force: true });
    toast(`Connection test failed: ${error.message}`, 'bad');
  } finally {
    state.mcp.testing = false;
    if (state.route.view === 'mcp-settings') renderRoute();
  }
}

async function restartMcpConnection() {
  if (state.mcp.restarting) return;
  state.mcp.restarting = true;
  renderRoute();
  try {
    const payload = await request('/mcp/servers/sql-context/restart', { method: 'POST', body: {} });
    mergeServerSnapshot(payload.server);
    toast('Managed SQL connection restarted');
  } catch (error) {
    toast(`Could not restart connection: ${error.message}`, 'bad');
  } finally {
    state.mcp.restarting = false;
    if (state.route.view === 'mcp-settings') renderRoute();
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

function renderPublisherSettings() {
  if (!state.publisher.config && !state.publisher.error) {
    void loadPublisherConfig();
    return loadingView();
  }
  const config = state.publisher.config;
  if (!config) return `${pageHead('Settings', 'Dashboard sharing', 'Configure a confirmation-gated snapshot publisher.')} ${errorView(state.publisher.error)}`;
  return `<div class="breadcrumb"><a href="#/settings">Settings</a>${icon('chevron-right', 11)}<span>Dashboard sharing</span></div>${pageHead('Publishing settings', 'Dashboard sharing', 'Publish fixed dashboard copies through an existing private S3 origin and CloudFront distribution.', '<a class="button" href="#/settings">Back</a>')}<section class="grid publisher-settings-grid"><form id="publisher-config-form" class="card mcp-form"><div class="card-header"><div><h2 class="card-title">S3 + CloudFront</h2><div class="card-meta">Configuration only · no upload occurs when saving</div></div><span class="pill ${config.enabled && config.configured ? 'good' : ''}">${config.enabled && config.configured ? 'Ready' : config.configured ? 'Paused' : 'Needs setup'}</span></div>${config.lastError ? `<div class="mcp-alert">${icon('alert', 15)}<span>${esc(config.lastError)}</span></div>` : ''}<div class="mcp-form-body"><label class="mcp-toggle-row"><span><strong>Enable snapshot publishing</strong><small>Every upload still requires a separate, expiring confirmation.</small></span><input name="enabled" type="checkbox" ${config.enabled ? 'checked' : ''}></label><div class="mcp-section"><h3>Destination</h3><p>BotBoy uploads one unique HTML object and never modifies S3 or CloudFront configuration.</p><div class="mcp-field-grid">${mcpField('bucket', 'S3 bucket', config.bucket, { placeholder: 'company-dashboard-snapshots' })}${mcpField('prefix', 'Object prefix', config.prefix, { placeholder: 'botboy-dashboards' })}${mcpField('region', 'AWS region', config.region, { placeholder: 'us-east-1' })}${mcpField('awsProfile', 'Least-privilege AWS profile', config.awsProfile, { placeholder: 'BotBoyDashboardPublisher', help: 'Use a dedicated profile allowed to PutObject only under this prefix. Do not use AdministratorAccess.' })}</div>${mcpField('cloudFrontBaseUrl', 'CloudFront base URL', config.cloudFrontBaseUrl, { placeholder: 'https://dashboards.example.com', help: 'Use an existing distribution whose private origin can read the configured S3 prefix.' })}</div><div class="mcp-section"><h3>Safety boundary</h3><p>This publisher never changes ACLs, bucket policies, public-access blocks, distribution settings, deletion protection, versioning, or retention. Those controls remain externally managed.</p><div class="publisher-safety-list"><span>${icon('check', 14)} One PutObject per confirmation</span><span>${icon('check', 14)} Unique immutable snapshot key</span><span>${icon('check', 14)} No SQL or credentials in output</span><span>${icon('check', 14)} Local dashboard remains canonical</span></div></div></div><div class="mcp-form-actions"><span>${icon('shield', 14)} Treat the destination as production</span><button class="button primary" type="submit" ${state.publisher.saving ? 'disabled' : ''}>${state.publisher.saving ? 'Saving…' : 'Save publisher'}</button></div></form><aside class="mcp-side"><article class="card pad"><div class="eyebrow">${icon('shield', 14)} Credential scope</div><h3 class="card-title">Dedicated PutObject role</h3><p class="page-subtitle">The configured profile should only write to the chosen bucket prefix. CloudFront origin access should remain separate.</p></article><article class="card pad"><div class="eyebrow">${icon('file', 14)} Snapshot model</div><h3 class="card-title">A copy, never the source</h3><p class="page-subtitle">Published HTML contains current rendered values only. It has no scripts, live query access, project IDs, credentials, or SQL text.</p></article><article class="card pad"><div class="eyebrow">${icon('alert', 14)} Explicit impact</div><h3 class="card-title">Confirmation happens last</h3><p class="page-subtitle">The dashboard page shows the exact S3 destination, profile, content hash, and exposure warning before enabling upload.</p></article></aside></section>`;
}

async function savePublisherConfig() {
  const form = document.getElementById('publisher-config-form');
  if (!form || state.publisher.saving) return;
  const payload = {
    enabled: Boolean(form.elements.enabled?.checked),
    bucket: form.elements.bucket?.value,
    prefix: form.elements.prefix?.value,
    region: form.elements.region?.value,
    awsProfile: form.elements.awsProfile?.value,
    cloudFrontBaseUrl: form.elements.cloudFrontBaseUrl?.value,
  };
  state.publisher.saving = true;
  renderRoute();
  try {
    const response = await request('/analytics/publisher', { method: 'PUT', body: payload });
    state.publisher.config = response.publisher;
    state.publisher.error = '';
    toast(response.publisher.enabled ? 'Dashboard publisher configured; uploads still require confirmation' : 'Dashboard publisher settings saved and publishing paused');
  } catch (error) {
    toast(`Could not save publisher: ${error.message}`, 'bad');
  } finally {
    state.publisher.saving = false;
    if (state.route.view === 'publisher-settings') renderRoute();
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
  renderRoute();
  try {
    const payload = await request(`/analytics/dashboards/${encodeURIComponent(id)}/share-request`, { method: 'POST', body: {} });
    state.publisher.pending.set(id, payload.shareRequest);
    toast('Review the exact upload destination before confirming');
  } catch (error) {
    toast(`Could not prepare snapshot: ${error.message}`, 'bad');
  } finally {
    state.publisher.preparing.delete(id);
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute();
  }
}

function cancelDashboardShare(id) {
  state.publisher.pending.delete(id);
  renderRoute();
}

async function publishDashboardShare(id) {
  const pending = state.publisher.pending.get(id);
  if (!pending || state.publisher.publishing.has(id)) return;
  state.publisher.publishing.add(id);
  renderRoute();
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
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute();
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
  const current = analyticsCurrentWidget(dashboard, run);
  const detail = run.status === 'queued'
    ? 'Waiting for the background analytics worker'
    : current
      ? `Running ${current.title}`
      : 'Finishing durable refresh state';
  return `<section class="analytics-run-progress" aria-live="polite"><div><span class="status-dot accent"></span><span><strong>${run.status === 'queued' ? 'Refresh queued' : 'Refresh running'}</strong><small>${esc(detail)}</small></span><b>${number(completed)} / ${number(total)}</b></div><div class="analytics-progress-track" aria-label="${attr(`${completed} of ${total} widgets completed`)}"><i style="width:${percent.toFixed(2)}%"></i></div></section>`;
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
    const progressChanged = Number(persistedRun.widgetsCompleted || 0) !== Number(previousRun.widgetsCompleted || 0);
    const terminal = persistedRun.status === 'completed' || persistedRun.status === 'failed';
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
  if (value == null) return '<span class="analytics-null">null</span>';
  if (typeof value === 'number') return `<span class="analytics-number">${esc(value.toLocaleString())}</span>`;
  return esc(String(value));
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
  return `<div class="analytics-metric-value"><span>${esc(prefix)}</span>${esc(rendered)}<span>${esc(suffix)}</span></div><div class="analytics-metric-foot">${number(result.rowCount)} source row${result.rowCount === 1 ? '' : 's'} · refreshed ${esc(relativeTime(result.refreshedAt))}</div>`;
}

function renderAnalyticsTable(result) {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (!columns.length) return `<pre class="analytics-raw">${esc(result.rawPreview || 'The query returned no tabular data.')}</pre>`;
  return `<div class="analytics-table-wrap"><table class="analytics-table"><thead><tr>${columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map((_, index) => `<td>${analyticsCell(row[index])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${result.rowCount > rows.length ? `<div class="analytics-truncated">Showing ${number(rows.length)} of ${number(result.rowCount)} rows returned by the connector.</div>` : ''}`;
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
  return `<div class="analytics-line"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Line chart for ${attr(widget.title)}"><defs><linearGradient id="line-fill-${attr(widget.id)}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><polyline class="analytics-line-shadow" points="${points}"/><polyline class="analytics-line-path" points="${points}"/></svg><div class="analytics-line-legend"><span>${esc(first.label)} · <strong>${esc(first.value.toLocaleString())}</strong></span><span>${esc(last.label)} · <strong>${esc(last.value.toLocaleString())}</strong></span></div></div>`;
}

function analyticsVisualizationRows(result) {
  const columns = Array.isArray(result?.columns) ? result.columns.map(String) : [];
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row?.[index] ?? null])));
}

function analyticsVegaConfig(specConfig) {
  const styles = getComputedStyle(document.documentElement);
  const authored = specConfig && typeof specConfig === 'object' && !Array.isArray(specConfig) ? specConfig : {};
  const authoredSection = key => authored[key] && typeof authored[key] === 'object' && !Array.isArray(authored[key]) ? authored[key] : {};
  const theme = {
    background: 'transparent',
    view: { stroke: 'transparent' },
    axis: {
      labelColor: styles.getPropertyValue('--muted').trim(),
      titleColor: styles.getPropertyValue('--soft').trim(),
      domainColor: styles.getPropertyValue('--border-strong').trim(),
      gridColor: styles.getPropertyValue('--border').trim(),
      tickColor: styles.getPropertyValue('--border-strong').trim(),
    },
    legend: {
      labelColor: styles.getPropertyValue('--muted').trim(),
      titleColor: styles.getPropertyValue('--soft').trim(),
    },
    title: {
      color: styles.getPropertyValue('--text').trim(),
      subtitleColor: styles.getPropertyValue('--muted').trim(),
    },
  };
  return {
    ...theme,
    ...authored,
    view: { ...theme.view, ...authoredSection('view') },
    axis: { ...theme.axis, ...authoredSection('axis') },
    legend: { ...theme.legend, ...authoredSection('legend') },
    title: { ...theme.title, ...authoredSection('title') },
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
      if ((spec.mark || spec.layer) && spec.autosize == null) {
        spec.autosize = { type: 'fit', contains: 'padding', resize: true };
      }
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

function renderAnalyticsWidget(widget, currentWidgetId = '') {
  const result = widget.result;
  const tone = widget.id === currentWidgetId ? 'accent' : widget.lastError ? 'warn' : result ? 'good' : '';
  let body = '<div class="analytics-empty">Run a refresh to load this widget.</div>';
  if (result) {
    if (widget.kind === 'metric') body = renderAnalyticsMetric(widget, result);
    if (widget.kind === 'table') body = renderAnalyticsTable(result);
    if (widget.kind === 'bar') body = renderAnalyticsBars(widget, result);
    if (widget.kind === 'line') body = renderAnalyticsLine(widget, result);
    if (widget.kind === 'visualization') body = `<div class="analytics-vega" data-analytics-visualization="${attr(widget.id)}" role="img" aria-label="${attr(widget.title)}"><span>Preparing interactive visualization…</span></div>`;
    if (widget.kind === 'text') body = `<div class="analytics-text">${esc(String(result.rows?.[0]?.[0] ?? widget.config?.text ?? '')).replaceAll('\n', '<br>')}</div>`;
  }
  return `<article class="card analytics-widget analytics-${attr(widget.kind)}"><div class="analytics-widget-head"><div><div class="eyebrow">${esc(widget.kind)}</div><h2>${esc(widget.title)}</h2>${widget.subtitle ? `<p>${esc(widget.subtitle)}</p>` : ''}</div><span class="status-dot ${tone}"></span></div>${widget.lastError ? `<div class="analytics-widget-error">${icon('alert', 14)}<span>${esc(widget.lastError)}</span>${result ? '<small>Showing the last successful result.</small>' : ''}</div>` : ''}<div class="analytics-widget-body">${body}</div><details class="analytics-provenance"><summary>${icon('database', 13)} Query & provenance</summary><div><span>Trust</span><strong>${esc(result?.trust || 'not refreshed')}</strong></div>${widget.preset ? `<div><span>Schema preset</span><strong>${esc(widget.preset)}</strong></div>` : ''}${widget.sql ? `<pre>${esc(widget.sql)}</pre>` : '<div><span>Source</span><strong>Local static text</strong></div>'}</details></article>`;
}

function renderAnalyticsList() {
  if (!state.analytics.items && !state.analytics.error) {
    void loadAnalyticsDashboards();
    return loadingView();
  }
  const actions = `<button class="button primary" type="button" data-action="analytics-ask-create" data-chat-mode="analytics_dashboard" data-chat-intent="create" data-prompt="Help me build an analytical dashboard from my connected schema knowledge. Inspect the available data first, recommend a useful schema-grounded dashboard, and ask only one targeted business question if a decision is genuinely ambiguous.">${icon('plus')} Build with BotBoy</button>`;
  const head = pageHead('Analytics', 'Dashboards', 'Durable, locally canonical views refreshed through BotBoy’s managed read-only SQL connection.', actions);
  if (state.analytics.error && !state.analytics.items) return `${head}${errorView(state.analytics.error)}`;
  const dashboards = state.analytics.items || [];
  return `${head}<section class="analytics-list-grid">${dashboards.map(dashboard => `<a class="card analytics-dashboard-card" href="#/dashboards/${encodeURIComponent(dashboard.id)}"><div class="analytics-card-top"><span class="source-icon">${icon('activity', 19)}</span><span class="pill ${analyticsStatusTone(dashboard.status)}"><span class="status-dot ${analyticsStatusTone(dashboard.status)}"></span>${esc(dashboard.status)}</span></div><h2>${esc(dashboard.title)}</h2><p>${esc(dashboard.description || 'An analytical dashboard managed by BotBoy.')}</p><div class="analytics-card-stats"><span><strong>${number(dashboard.widgetCount)}</strong> widgets</span><span><strong>${number(dashboard.projectCount)}</strong> projects</span></div><div class="analytics-card-foot"><span>${dashboard.lastRefreshedAt ? `Refreshed ${esc(relativeTime(dashboard.lastRefreshedAt))}` : 'Not refreshed yet'}</span>${icon('arrow-right', 14)}</div></a>`).join('') || `<article class="card empty-state analytics-list-empty"><span class="source-icon">${icon('activity', 19)}</span><h3>No dashboards yet</h3><p>Ask BotBoy to turn a business question into a governed dashboard with metrics, tables, and charts.</p><button class="button primary" type="button" data-action="analytics-ask-create" data-chat-mode="analytics_dashboard" data-chat-intent="create" data-prompt="Help me build my first analytical dashboard from my connected schema knowledge. Inspect the available data first, recommend a useful schema-grounded dashboard, and ask only one targeted business question if a decision is genuinely ambiguous.">${icon('sparkles')} Design a dashboard</button></article>`}</section>`;
}

function renderAnalyticsRuns(dashboard) {
  const runs = dashboard.recentRuns || [];
  return `<article class="card analytics-runs"><div class="card-header"><div><h2 class="card-title">Refresh history</h2><div class="card-meta">Persisted local execution record</div></div></div>${runs.map(run => {
    const active = run.status === 'queued' || run.status === 'running';
    const tone = run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'accent';
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
  const actions = `<a class="button" href="#/dashboards">${icon('chevron-right')} All dashboards</a>${publishedAction}${shareAction}<button class="button primary" type="button" data-action="analytics-refresh" data-dashboard="${attr(id)}" ${refreshing ? 'disabled' : ''}>${icon('refresh')} ${refreshLabel}</button>`;
  const schedule = dashboard.schedule;
  return `<div class="breadcrumb"><a href="#/dashboards">Dashboards</a>${icon('chevron-right', 11)}<span>${esc(dashboard.title)}</span></div>${pageHead('Analytical dashboard', dashboard.title, dashboard.description, actions)}<div class="analytics-dashboard-meta"><span class="pill ${tone}"><span class="status-dot ${tone}"></span>${esc(dashboard.status)}</span><span>${icon('clock', 13)} ${dashboard.lastRefreshedAt ? `Refreshed ${esc(relativeTime(dashboard.lastRefreshedAt))}` : 'Not refreshed yet'}</span><span>${icon('database', 13)} Managed SQL · read only</span>${schedule ? `<span>${icon('refresh', 13)} ${schedule.enabled ? `Daily at ${esc(schedule.localTime)} ${esc(schedule.timezone)}` : 'Schedule paused'}</span>` : ''}${dashboard.latestPublication?.status === 'published' ? `<span>${icon('globe', 13)} Snapshot published ${esc(relativeTime(dashboard.latestPublication.publishedAt))}</span>` : ''}</div>${renderAnalyticsProgress(dashboard, activeRun)}${dashboard.lastError ? `<div class="analytics-dashboard-alert">${icon('alert', 15)}<span>${esc(dashboard.lastError)}</span></div>` : ''}${renderShareConfirmation(dashboard)}<section class="analytics-widget-grid">${dashboard.widgets.map(widget => renderAnalyticsWidget(widget, activeRun?.currentWidgetId)).join('')}</section><section class="analytics-detail-grid">${renderAnalyticsRuns(dashboard)}${renderAnalyticsSchedule(dashboard)}${renderAnalyticsManagement(dashboard)}<article class="card pad analytics-governance"><div class="eyebrow">${icon('shield', 14)} Guardrails</div><h2 class="card-title">Local definition, governed refresh</h2><p>Queries are validated when saved and immediately before every run. Results are external untrusted data, escaped before rendering, and never authorize project or task changes.</p><div class="mcp-fact"><span>Canonical copy</span><strong>BotBoy SQLite</strong></div><div class="mcp-fact"><span>Database access</span><strong>Read only</strong></div><div class="mcp-fact"><span>Shared copies</span><strong>Explicit confirmation only</strong></div></article></section>`;
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
  renderRoute();
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
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute();
  }
}

async function saveAnalyticsProjectLinks(form) {
  const id = form?.dataset?.dashboard;
  if (!id || state.analytics.linkingProjects.has(id)) return;
  const projectIds = new FormData(form).getAll('projectIds').map(value => String(value));
  state.analytics.linkingProjects.add(id);
  renderRoute();
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
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute();
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
  renderRoute();
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
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute();
  }
}

async function refreshAnalyticsDashboard(id) {
  const current = state.analytics.details.get(id);
  if (!id || state.analytics.refreshing.has(id) || analyticsActiveRun(current)) return;
  state.analytics.refreshing.add(id);
  renderRoute();
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
    if (state.route.view === 'analytics-dashboard' && state.route.dashboardId === id) renderRoute();
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
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled document',
    state: typeof raw.state === 'string' && raw.state ? raw.state : 'unknown',
    profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    contentChars: Number.isFinite(parsedContentChars) && parsedContentChars >= 0 ? Math.trunc(parsedContentChars) : null,
    parentArtifactId: typeof raw.parentArtifactId === 'string' && raw.parentArtifactId ? raw.parentArtifactId : null,
    revisionOrigin: raw.revisionOrigin === 'owner_edit' || raw.revisionOrigin === 'generated' ? raw.revisionOrigin : null,
  };
}

/**
 * Group summaries into version chains via parent linkage. Each chain shows
 * its newest version as the primary row; older versions render as indented
 * history rows so iterations of one document no longer read as unrelated
 * artifacts. Artifacts without a resolvable parent start their own chain.
 */
function groupDocumentChains(items) {
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
      if (seen.has(current.artifactId)) continue;
      seen.add(current.artifactId);
      members.push(current);
      for (const child of childrenOf.get(current.artifactId) || []) stack.push(child);
    }
    members.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { head: members[0], older: members.slice(1) };
  });
  chains.sort((a, b) => String(b.head.createdAt).localeCompare(String(a.head.createdAt)));
  return chains;
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
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled document',
    state: typeof raw.state === 'string' && raw.state ? raw.state : 'unknown',
    profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

function documentStateLabel(value) {
  const normalized = String(value || 'unknown').replaceAll('_', ' ').trim();
  return normalized.replace(/\b\w/g, character => character.toUpperCase());
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

async function loadDocuments({ force = false, renderAfter = true } = {}) {
  const documents = state.documents;
  if (documents.loading || (!force && documents.items !== null)) return documents.items;
  documents.loading = true;
  if (!force) documents.error = '';
  if (renderAfter && state.route.view === 'documents') renderRoute({ preserveScroll: true });
  try {
    const payload = await request(`/product-documents?limit=${DOCUMENT_LIST_LIMIT}`);
    documents.items = documentSummariesFromPayload(payload);
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

async function refreshDocuments() {
  if (state.documents.refreshing) return;
  const artifactId = state.route.view === 'documents' ? state.route.artifactId : '';
  state.documents.refreshing = true;
  if (state.route.view === 'documents') renderRoute({ preserveScroll: true });
  try {
    await Promise.all([
      loadDocuments({ force: true, renderAfter: false }),
      artifactId ? loadDocument(artifactId, { force: true, renderAfter: false }) : Promise.resolve(),
    ]);
  } finally {
    state.documents.refreshing = false;
    if (state.route.view === 'documents') renderRoute({ preserveScroll: true });
  }
}

function renderDocumentListPane(selectedArtifactId) {
  const documents = state.documents;
  const items = documents.items;
  const countLabel = items
    ? documents.total !== null && documents.total > items.length
      ? `${number(items.length)} of ${number(documents.total)}`
      : number(items.length)
    : '—';
  let body = '';

  if (items === null && documents.loading) {
    body = `<div class="document-list-loading" aria-label="Loading documents"><div class="skeleton row"></div><div class="skeleton row"></div><div class="skeleton row"></div><div class="skeleton row"></div></div>`;
  } else if (items === null) {
    body = `<div class="document-pane-state"><span class="source-icon">${icon('alert', 19)}</span><h2>Documents are unavailable</h2><p>${esc(documents.error || 'The document list could not be loaded.')}</p><button class="button" type="button" data-action="documents-retry-list">Try again</button></div>`;
  } else if (!items.length) {
    body = `<div class="document-pane-state"><span class="source-icon">${icon('file', 19)}</span><h2>No documents yet</h2><p>Generated product documents will appear here when they are available.</p><button class="button" type="button" data-action="documents-refresh">Refresh</button></div>`;
  } else {
    const documentRow = (document, { versionNote = '', historical = false } = {}) => {
      const active = selectedArtifactId === document.artifactId;
      const size = document.contentChars === null ? 'Size unavailable' : `${number(document.contentChars)} characters`;
      const origin = document.revisionOrigin === 'owner_edit' ? ' · Owner edit' : '';
      return `<a class="document-row ${active ? 'active' : ''} ${historical ? 'document-row-version' : ''}" href="#/documents/${encodeURIComponent(document.artifactId)}" data-artifact="${attr(document.artifactId)}" ${active ? 'aria-current="page"' : ''}><span class="source-icon">${icon('file', 16)}</span><span class="document-row-copy"><strong>${esc(document.title)}</strong><span>${esc(document.profileId || 'Unknown profile')} · ${esc(size)}${esc(origin)}${versionNote ? ` · ${esc(versionNote)}` : ''}</span></span><span class="document-row-side"><span class="pill ${documentStateTone(document.state)}">${esc(documentStateLabel(document.state))}</span><time>${esc(relativeTime(document.createdAt))}</time></span></a>`;
    };
    body = `<nav class="document-list" aria-label="Documents">${groupDocumentChains(items).map(chain => {
      const versions = chain.older.length + 1;
      const head = documentRow(chain.head, { versionNote: versions > 1 ? `${number(versions)} versions` : '' });
      const history = chain.older
        .map((entry, index) => documentRow(entry, { versionNote: `v${versions - index - 1}`, historical: true }))
        .join('');
      return head + history;
    }).join('')}</nav>`;
  }

  return `<aside class="card document-list-pane" aria-label="Generated documents" tabindex="-1"><header class="document-pane-header"><div><h2>Generated documents</h2><p>Latest ${number(DOCUMENT_LIST_LIMIT)} maximum</p></div><span class="pill">${esc(countLabel)}</span></header>${items && documents.error ? `<div class="document-inline-error" role="status">${icon('alert', 14)}<span>Refresh failed: ${esc(documents.error)}</span></div>` : ''}${body}</aside>`;
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
  const profileVersion = artifact.profileVersion ? ` · v${artifact.profileVersion}` : '';
  const extraMetadata = [
    artifact.model ? `Model ${artifact.model}` : '',
    artifact.checkerVersion ? `Checker ${artifact.checkerVersion}` : '',
  ].filter(Boolean);
  const editing = documents.editing;
  const mode = editing ? 'edit' : (documents.previewMode === 'plain' ? 'plain' : 'rendered');
  const canRender = typeof window.formatMarkdownContent === 'function';

  // Validation advisories live OUTSIDE the document content: they inform the
  // owner which statements lack traced support or profile completeness, but
  // they never gate the document itself.
  const findings = Array.isArray(artifact.validation?.findings) ? artifact.validation.findings : [];
  const advisories = findings.filter(entry => entry && (entry.severity === 'warning' || entry.severity === 'error' || entry.severity === 'block'));
  const advisoriesBlock = advisories.length
    ? `<details class="document-findings"><summary>${icon('alert', 14)} ${number(advisories.length)} validation advisor${advisories.length === 1 ? 'y' : 'ies'} — informational, they do not block this document</summary><ul>${advisories.slice(0, 25).map(entry => `<li><code>${esc(String(entry.code || 'FINDING'))}</code> ${esc(String(entry.message || ''))}</li>`).join('')}${advisories.length > 25 ? `<li>…and ${number(advisories.length - 25)} more.</li>` : ''}</ul></details>`
    : '';

  const openQuestions = Array.isArray(artifact.openQuestions) ? artifact.openQuestions.filter(entry => typeof entry === 'string' && entry.trim()) : [];
  // Collapsible panel with capped internal scrolling: answering questions
  // must never steal the whole pane from the document preview below it.
  const questionsBlock = openQuestions.length && !editing
    ? `<details class="document-questions" data-document-questions ${documents.questionsOpen ? 'open' : ''}><summary>${icon('sparkles', 14)} <strong>${number(openQuestions.length)} open question${openQuestions.length === 1 ? '' : 's'} to answer</strong><span>Answer below and BotBoy will create an improved version.</span><span class="document-questions-chevron">${icon('chevron-down', 13)}</span></summary><div class="document-questions-body"><ol>${openQuestions.slice(0, 10).map(question => `<li>${esc(question)}</li>`).join('')}</ol><textarea class="document-answers-input" data-document-answers rows="3" placeholder="Type your answers here (any format — reference the questions by number if useful)">${esc(documents.answersDraft || '')}</textarea><div class="document-questions-actions"><button class="button" type="button" data-action="documents-send-answers" data-artifact="${attr(artifactId)}" ${documents.saving ? 'disabled' : ''}>${icon('sparkles', 13)} Send answers to BotBoy</button><span>Sends your answers to chat; a new version is generated from them.</span></div></div></details>`
    : '';

  const parentLine = artifact.parentArtifactId
    ? `<p class="document-parent-line">Revision of <a href="#/documents/${encodeURIComponent(artifact.parentArtifactId)}"><code>${esc(String(artifact.parentArtifactId).slice(0, 8))}</code></a>${artifact.revisionOrigin === 'owner_edit' ? ' · <span class="pill accent">Owner edit</span>' : ''}</p>`
    : '';

  const modeButtons = editing ? '' : `<div class="document-mode-group" role="group" aria-label="Preview mode"><button class="button small ${mode === 'rendered' ? 'active' : ''}" type="button" data-action="documents-preview-mode" data-mode="rendered" ${canRender ? '' : 'disabled title="Renderer unavailable"'}>Rendered</button><button class="button small ${mode === 'plain' ? 'active' : ''}" type="button" data-action="documents-preview-mode" data-mode="plain">Plain text</button><button class="button small" type="button" data-action="documents-edit" data-artifact="${attr(artifactId)}">${icon('plus', 13)} Edit</button></div>`;

  const downloadFormats = [
    { format: 'markdown', label: 'Markdown', hint: '.md' },
    { format: 'html', label: 'HTML', hint: '.html' },
    { format: 'docx', label: 'Word', hint: '.docx' },
    { format: 'pdf', label: 'PDF', hint: '.pdf' },
  ];
  const downloadMenu = editing ? '' : `<details class="document-download-menu" data-document-download-menu><summary class="button small" aria-haspopup="menu" ${documents.downloading ? 'aria-disabled="true"' : ''}>${icon('download', 13)} ${documents.downloading ? `Preparing ${esc(documents.downloading)}…` : 'Download'}</summary><div class="document-download-list" role="menu">${downloadFormats.map(entry => `<button type="button" role="menuitem" data-action="documents-download" data-artifact="${attr(artifactId)}" data-format="${entry.format}" ${documents.downloading ? 'disabled' : ''}><span>${entry.label}</span><span>${entry.hint}</span></button>`).join('')}</div></details>`;
  const deleteButton = editing ? '' : `<button class="button small document-delete" type="button" data-action="documents-delete" data-artifact="${attr(artifactId)}" ${documents.deleting ? 'disabled' : ''}>${icon('trash', 13)} ${documents.deleting ? 'Deleting…' : 'Delete'}</button>`;
  const fullscreenButton = `<button class="button small" type="button" data-action="documents-fullscreen" aria-pressed="${documents.fullscreen ? 'true' : 'false'}" title="${documents.fullscreen ? 'Exit full screen (Esc)' : 'Expand the preview to full screen'}">${icon(documents.fullscreen ? 'x' : 'expand', 13)} ${documents.fullscreen ? 'Exit full screen' : 'Expand'}</button>`;

  const annotationsRail = editing ? '' : renderDocumentAnnotationsRail(artifact);
  const previewBody = editing
    ? `<textarea class="document-editor" data-document-editor aria-label="Edit document content" spellcheck="true">${esc(documents.editDraft ?? content)}</textarea><div class="document-editor-actions"><button class="button" type="button" data-action="documents-save-revision" data-artifact="${attr(artifactId)}" ${documents.saving ? 'disabled' : ''}>${documents.saving ? 'Saving…' : 'Save as new version'}</button><button class="button ghost" type="button" data-action="documents-cancel-edit" ${documents.saving ? 'disabled' : ''}>Cancel</button><span>Saving never overwrites this version; it creates a new linked one.</span></div>`
    : mode === 'rendered' && canRender
      ? `<div class="document-annotated ${annotationsRail ? 'with-rail' : ''}"><div class="document-rendered" data-document-preview tabindex="0" aria-label="Rendered preview of ${attr(artifact.title)}"></div>${annotationsRail}</div>`
      : `<div class="document-annotated ${annotationsRail ? 'with-rail' : ''}"><pre class="document-preview" data-document-preview tabindex="0" aria-label="Plain-text preview of ${attr(artifact.title)}"></pre>${annotationsRail}</div>`;

  const footerNote = editing
    ? `${icon('shield', 13)} Edits persist as a new immutable version`
    : mode === 'rendered' && canRender
      ? `${icon('shield', 13)} Markdown rendered with escape-first formatting`
      : `${icon('shield', 13)} Content is rendered as plain text only`;

  return `<article class="card document-detail-pane"><div class="document-detail-toolbar">${back}<span class="pill ${stateTone}">${esc(documentStateLabel(artifact.state))}</span>${modeButtons}<div class="document-toolbar-actions">${downloadMenu}${deleteButton}${fullscreenButton}</div></div><header class="document-detail-header"><div><div class="eyebrow">${icon('file', 14)} Product document</div><h2>${esc(artifact.title)}</h2><p><code>${esc(artifact.artifactId)}</code></p>${parentLine}</div><button class="button small" type="button" data-action="documents-retry-detail" data-artifact="${attr(artifactId)}" ${loading ? 'disabled' : ''}>${icon('refresh', 13)} ${loading ? 'Refreshing…' : 'Refresh document'}</button></header><div class="document-detail-meta"><span>${esc(`${artifact.profileId || 'Unknown profile'}${profileVersion}`)}</span><span>Created ${esc(relativeTime(artifact.createdAt))}</span>${extraMetadata.map(value => `<span>${esc(value)}</span>`).join('')}</div>${detailError ? `<div class="document-inline-error" role="status">${icon('alert', 14)}<span>Latest refresh failed: ${esc(detailError)}</span></div>` : ''}${documents.actionError ? `<div class="document-inline-error" role="alert">${icon('alert', 14)}<span>${esc(documents.actionError)}</span></div>` : ''}${advisoriesBlock}<div class="document-preview-shell">${questionsBlock}${truncated && !editing ? `<div class="document-truncation-notice" role="status">${icon('alert', 14)}<span>Preview truncated: showing the first ${number(DOCUMENT_PREVIEW_LIMIT)} of ${number(content.length)} characters.</span></div>` : ''}${content || editing ? '' : `<div class="document-content-empty ${questionsBlock ? 'inline' : ''}">This document has no preview content.</div>`}${previewBody}</div><footer class="document-detail-footer"><span>${footerNote}</span><span>${editing ? `${number((documents.editDraft ?? content).length)} characters in editor` : `${number(Math.min(content.length, DOCUMENT_PREVIEW_LIMIT))} characters displayed`}</span></footer></article>`;
}

function renderDocuments() {
  const documents = state.documents;
  const artifactId = state.route.artifactId || '';
  if (documents.uiArtifactId !== artifactId) {
    // Selection changed: reset per-document view state so edits/answers never
    // leak between artifacts.
    documents.uiArtifactId = artifactId;
    documents.previewMode = 'rendered';
    documents.editing = false;
    documents.editDraft = null;
    documents.answersDraft = '';
    documents.saving = false;
    documents.actionError = '';
    documents.questionsOpen = true;
    documents.downloading = null;
    documents.deleting = false;
    if (!artifactId) documents.fullscreen = false;
  }
  if (documents.items === null && !documents.loading && !documents.error) void loadDocuments();
  if (artifactId && !documents.details.has(artifactId) && !documents.detailLoading.has(artifactId) && !documents.detailErrors.has(artifactId)) {
    void loadDocument(artifactId);
  }
  const subtitle = documents.items
    ? `${number(documents.items.length)} recent generated document${documents.items.length === 1 ? '' : 's'}, loaded from a bounded list.`
    : 'Review generated product documents without interpreting their content as HTML or Markdown.';
  const refreshLabel = documents.refreshing ? 'Refreshing…' : 'Refresh';
  const actions = `<button class="button" type="button" data-action="documents-refresh" ${documents.refreshing ? 'disabled' : ''}>${icon('refresh')} ${refreshLabel}</button>`;
  const fullscreen = documents.fullscreen && artifactId;
  return `${pageHead('Writing workspace', 'Documents', subtitle, actions)}<section class="documents-shell ${artifactId ? 'has-selection' : ''} ${fullscreen ? 'document-fullscreen' : ''}">${renderDocumentListPane(artifactId)}${renderDocumentDetailPane(artifactId)}</section>`;
}

/**
 * Annotations rail: evidence citations + conformance review rendered as
 * comment cards beside (wide) or below (narrow) the document preview.
 * Citations link to inline [cN] chips; review cards surface the max-reasoning
 * conformance verdict that previously lived only in the artifact JSON.
 */
function renderDocumentAnnotationsRail(artifact) {
  const citations = Array.isArray(artifact.citations)
    ? artifact.citations.filter(cite => cite && typeof cite.id === 'string' && typeof cite.label === 'string')
    : [];
  const review = artifact.conformanceReview && typeof artifact.conformanceReview === 'object'
    ? artifact.conformanceReview
    : null;
  if (!citations.length && !review) return '';

  const citeCards = citations.map((cite, index) => {
    const meta = [cite.source, cite.date ? String(cite.date).slice(0, 10) : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="doc-annotation doc-annotation-cite" data-annotation-cite="${attr(cite.id)}" title="Show this citation in the document">
      <span class="doc-annotation-head"><sup class="doc-cite static">${index + 1}</sup><strong>${esc(cite.label)}</strong></span>
      ${meta ? `<span class="doc-annotation-meta">${esc(meta)}</span>` : ''}
      ${cite.quote ? `<blockquote>${esc(cite.quote)}</blockquote>` : ''}
      ${cite.url
        ? `<span class="doc-annotation-meta doc-annotation-url">${esc(cite.url)}</span>`
        : cite.workItemId
          ? `<span class="doc-annotation-meta">Captured evidence <code>${esc(String(cite.workItemId).slice(0, 12))}</code></span>`
          : ''}
    </button>`;
  }).join('');

  const reviewFindings = Array.isArray(review?.findings) ? review.findings : [];
  const statusLabel = { conformant: 'Conformant', corrected: 'Auto-corrected', deviations_noted: 'Deviations noted', unavailable: 'Not run' }[review?.status] || 'Not run';
  const statusTone = review?.status === 'conformant' || review?.status === 'corrected'
    ? 'good'
    : review?.status === 'deviations_noted' ? 'warn' : '';
  const reviewCards = reviewFindings.slice(0, 20).map(finding => `<div class="doc-annotation doc-annotation-review ${finding.severity === 'deviation' ? 'deviation' : ''}">
    <span class="doc-annotation-head"><span class="doc-annotation-dot"></span><strong>${esc(String(finding.aspect || 'other').replaceAll('_', ' '))}</strong><span class="doc-annotation-sev">${finding.severity === 'deviation' ? 'deviation' : 'note'}</span></span>
    <span class="doc-annotation-message">${esc(String(finding.message || ''))}</span>
  </div>`).join('');

  return `<aside class="document-annotations" aria-label="Document annotations">
    ${citations.length ? `<div class="doc-annotation-group"><h3>${icon('link', 12)} Evidence <span class="doc-annotation-count">${citations.length}</span></h3>${citeCards}</div>` : ''}
    ${review ? `<div class="doc-annotation-group"><h3>${icon('sparkles', 12)} Conformance review <span class="pill ${statusTone}">${esc(statusLabel)}</span></h3>${review.summary ? `<p class="doc-annotation-summary">${esc(String(review.summary))}</p>` : ''}${reviewCards}</div>` : ''}
  </aside>`;
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
    renderRoute({ preserveScroll: true });
    return;
  }
  documents.saving = true;
  documents.actionError = '';
  renderRoute({ preserveScroll: true });
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
    renderRoute({ preserveScroll: true });
  }
}

function sendDocumentAnswers(artifactId) {
  const documents = state.documents;
  const artifact = documents.details.get(artifactId);
  const answers = (documents.answersDraft || '').trim();
  if (!artifact || !answers) {
    documents.actionError = 'Type your answers before sending them to BotBoy.';
    renderRoute({ preserveScroll: true });
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
    renderRoute({ preserveScroll: true });
    return;
  }
  documents.answersDraft = '';
  documents.actionError = '';
  input.value = message;
  if (document.getElementById('chat-panel')?.classList.contains('hidden')) window.toggleChat?.();
  void window.submitChat();
  renderRoute({ preserveScroll: true });
}

async function downloadDocument(artifactId, format) {
  const documents = state.documents;
  if (!artifactId || documents.downloading) return;
  documents.downloading = format;
  documents.actionError = '';
  renderRoute({ preserveScroll: true });
  try {
    // The server runs the local conversion tool (pandoc/weasyprint) and
    // streams the file back; the browser then saves it like any download.
    const response = await fetch(`${API}/product-documents/${encodeURIComponent(artifactId)}/export?format=${encodeURIComponent(format)}`);
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json())?.error || ''; } catch {}
      throw new Error(detail || `HTTP ${response.status}`);
    }
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
    renderRoute({ preserveScroll: true });
  }
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
  renderRoute({ preserveScroll: true });
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
    renderRoute({ preserveScroll: true });
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

function renderSettings() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return `${pageHead('Workspace', 'Settings', 'Appearance, diagnostics, and compatibility tools for the local dashboard.')}
    <section class="grid settings-layout"><nav class="card settings-nav"><button class="button ghost" type="button">${icon('settings')} General</button><a class="button ghost" href="#/settings/dashboard-sharing">${icon('globe')} Dashboard sharing</a><button class="button ghost" type="button" data-action="open-nodes">${icon('branch')} Legacy nodes</button><button class="button ghost" type="button" data-action="open-logs">${icon('activity')} Diagnostics</button></nav><article class="card settings-panel"><div class="card-header" style="padding:0 0 16px"><div><h2 class="card-title">General</h2><div class="card-meta">Workspace appearance and behavior</div></div></div><div class="setting-row"><span class="setting-copy"><strong>Dark appearance</strong><span>Switch between BotBoy’s dark and light palettes.</span></span><button class="toggle ${dark ? 'on' : ''}" type="button" data-action="toggle-theme" aria-label="Toggle dark appearance"></button></div><div class="setting-row"><span class="setting-copy"><strong>Contextual assistant</strong><span>The assistant opens when needed instead of permanently consuming workspace width.</span></span><span class="pill accent">Enabled</span></div><div class="setting-row"><span class="setting-copy"><strong>Legacy node browser</strong><span>Available during migration for depth-four nodes and manual node actions.</span></span><button class="button small" type="button" data-action="open-nodes">Open</button></div><div class="setting-row"><span class="setting-copy"><strong>Agent and app logs</strong><span>Open the existing local diagnostics viewer.</span></span><button class="button small" type="button" data-action="open-logs">View logs</button></div></article></section>`;
}

function renderRoute({ preserveScroll = false } = {}) {
  const workspace = document.getElementById('workspace');
  const previousScrollTop = workspace?.scrollTop || 0;
  state.route = parseRoute();
  const analyticsRoute = state.route.view === 'dashboards' || state.route.view === 'analytics-dashboard';
  window.setAmbientChatContext?.(analyticsRoute ? { mode: 'analytics_dashboard' } : null);
  syncAnalyticsPolling();
  renderSidebar();
  closeIntegration({ keepLegacy: state.route.view === 'nodes' });
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
  if (state.route.view === 'mcp-add') html = renderMcpServerForm();
  if (state.route.view === 'mcp-edit') html = renderMcpServerForm({ editing: true, profileId: state.route.profileId });
  if (state.route.view === 'profile-settings') html = renderProfileSettings(state.route.profileId);
  if (state.route.view === 'dashboards') html = renderAnalyticsList();
  if (state.route.view === 'analytics-dashboard') html = renderAnalyticsDashboard(state.route.dashboardId);
  if (state.route.view === 'documents') html = renderDocuments();
  if (state.route.view === 'pipeline') html = renderPipeline();
  if (state.route.view === 'settings') html = renderSettings();
  if (state.route.view === 'publisher-settings') html = renderPublisherSettings();
  if (state.route.view === 'not-found') html = errorView('This workspace route does not exist. Use the navigation to open a known view.');
  view.innerHTML = html;
  if (state.route.view === 'documents') {
    hydrateDocumentPreview();
    restoreDocumentRouteFocus();
  }
  if (state.route.view === 'analytics-dashboard') {
    requestAnimationFrame(() => void hydrateAnalyticsVisualizations(state.route.dashboardId, visualizationEpoch));
  }
  if (state.route.view === 'mcp-settings') requestAnimationFrame(updateMcpFormVisibility);
  if (workspace) workspace.scrollTop = preserveScroll ? previousScrollTop : 0;
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
    renderRoute({ preserveScroll: state.route.view === 'analytics-dashboard' });
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
      const evidenceItems = (result.results || []).map(entry => ({
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

function bindEvents() {
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target?.dataset?.terminalInput) {
      event.preventDefault();
      void sendTerminalInput(event.target.dataset.terminalInput);
    }
  });
  document.addEventListener('click', event => {
    const command = event.target.closest('[data-command-index]');
    if (command) return runCommand(Number(command.dataset.commandIndex));
    const prompt = event.target.closest('[data-prompt]');
    if (prompt) {
      window.setChatContext?.(prompt.dataset.chatMode
        ? { mode: prompt.dataset.chatMode, intent: prompt.dataset.chatIntent }
        : null);
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
      renderRoute({ preserveScroll: true });
    }
    if (action === 'project-tab') { state.projectTab = target.dataset.tab; renderRoute(); }
    if (action === 'evidence-filter') { state.evidenceFilter = target.dataset.filter; renderRoute(); }
    if (action === 'run-digests') void runChannelDigests();
    if (action === 'review-ambient') void reviewAmbientProjects();
    if (action === 'reject-evidence') void rejectEvidence(target.dataset.project, target.dataset.item);
    if (action === 'restore-evidence') void restoreEvidence(target.dataset.project, target.dataset.item);
    if (action === 'rebuild-brain') void rebuildProjectBrain(target.dataset.project);
    if (action === 'dismiss-relation') void dismissRelation(target.dataset.project, target.dataset.other);
    if (action === 'discard-item') void discardItem(target.dataset.item, target.dataset.project);
    if (action === 'restore-discard') void restoreDiscardedItem(target.dataset.item);
    if (action === 'retry-core' || action === 'refresh-core') void loadCore();
    if (action === 'documents-refresh') void refreshDocuments();
    if (action === 'documents-retry-list') void loadDocuments({ force: true });
    if (action === 'documents-retry-detail') void loadDocument(target.dataset.artifact, { force: true });
    if (action === 'documents-preview-mode') {
      state.documents.previewMode = target.dataset.mode === 'plain' ? 'plain' : 'rendered';
      renderRoute({ preserveScroll: true });
    }
    if (action === 'documents-edit') {
      const artifact = state.documents.details.get(target.dataset.artifact);
      state.documents.editing = true;
      state.documents.editDraft = typeof artifact?.content === 'string' ? artifact.content : '';
      state.documents.actionError = '';
      renderRoute({ preserveScroll: true });
    }
    if (action === 'documents-cancel-edit') {
      state.documents.editing = false;
      state.documents.editDraft = null;
      state.documents.actionError = '';
      renderRoute({ preserveScroll: true });
    }
    if (action === 'documents-save-revision') void saveDocumentRevision(target.dataset.artifact);
    if (action === 'documents-send-answers') sendDocumentAnswers(target.dataset.artifact);
    if (action === 'documents-download') void downloadDocument(target.dataset.artifact, target.dataset.format);
    if (action === 'documents-delete') void deleteDocument(target.dataset.artifact);
    if (action === 'documents-fullscreen') {
      state.documents.fullscreen = !state.documents.fullscreen;
      renderRoute({ preserveScroll: true });
    }
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
    if (action === 'analytics-refresh') void refreshAnalyticsDashboard(target.dataset.dashboard);
    if (action === 'analytics-delete') void deleteAnalyticsDashboard(target.dataset.dashboard);
    if (action === 'share-prepare') void prepareDashboardShare(target.dataset.dashboard);
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
    if (event.target?.id === 'publisher-config-form') {
      event.preventDefault();
      void savePublisherConfig();
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
    if (event.target?.matches?.('[data-document-questions]')) {
      state.documents.questionsOpen = event.target.open;
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.documents.fullscreen && state.route.view === 'documents') {
      state.documents.fullscreen = false;
      renderRoute({ preserveScroll: true });
    }
  });

  document.addEventListener('input', event => {
    if (event.target?.matches('[data-document-editor]')) {
      state.documents.editDraft = event.target.value;
      return;
    }
    if (event.target?.matches('[data-document-answers]')) {
      state.documents.answersDraft = event.target.value;
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

async function pollVersion() {
  try {
    const payload = await request('/dashboard/version');
    const previousVersion = state.lastVersion;
    const previousAnalyticsVersion = state.lastAnalyticsVersion;
    const previousBootId = state.lastBootId;
    state.lastVersion = payload.version;
    state.lastAnalyticsVersion = payload.analyticsVersion ?? '0';
    state.lastBootId = payload.bootId ?? null;

    // Server restarted (possibly with new UI code): a stale tab must not keep
    // running old JavaScript against the new server. Reload once, hard.
    if (previousBootId && payload.bootId && payload.bootId !== previousBootId) {
      location.reload();
      return;
    }

    if (previousVersion !== null && payload.version !== previousVersion) {
      // Project details are cached separately from the core read models.
      // Drop them before rendering a capture/assignment revision so the
      // active project fetches its newly connected evidence as well.
      state.projectDetails.clear();
      state.projectErrors.clear();
      await loadCore({ quiet: true });
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
  const theme = localStorage.getItem('botboy-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true', { persist: false });
  setMobileSidebarOpen(false);
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/today');
  state.route = parseRoute();
  queueDocumentRouteFocus({ view: '' }, state.route);
  bindEvents();
  window.addEventListener('botboy:page-layout-ready', event => {
    const { scopeType, scopeId } = event.detail || {};
    const isCurrentArea = scopeType === 'area' && state.route.view === 'area' && state.route.areaId === scopeId;
    const isCurrentProject = scopeType === 'project' && state.route.view === 'project' && state.route.projectId === scopeId;
    if (isCurrentArea || isCurrentProject) renderRoute({ preserveScroll: true });
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
      renderRoute();
      void openTodayVisit();
      return;
    }
    renderRoute();
  });
  renderRoute();
  void loadCore();
  setInterval(() => { if (!document.hidden) void pollVersion(); }, 5000);
}

window.BotBoyDashboard = { refresh: () => loadCore(), go };
// Chat deeplinks: the message renderer in app.js turns project titles and ids
// BotBoy mentions into links back into the dashboard. It reads the canonical
// list from here so the two can never drift out of sync.
window.botboyProjectLinkIndex = () => state.projects.map(project => ({ id: project.id, title: project.title }));
initialize();
