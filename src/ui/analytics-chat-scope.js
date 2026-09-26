const DASHBOARD_ID_RE = /^dash_[A-Za-z0-9_-]{1,96}$/;
const WIDGET_ID_RE = /^widget_[A-Za-z0-9_-]{1,96}$/;

export function normalizeAnalyticsRouteScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind !== 'analytics_dashboard' || !DASHBOARD_ID_RE.test(String(value.dashboardId || ''))) return null;
  if (!Array.isArray(value.selectedWidgetIds) || value.selectedWidgetIds.length > 2) return null;
  const selectedWidgetIds = value.selectedWidgetIds.map(id => String(id || ''));
  if (new Set(selectedWidgetIds).size !== selectedWidgetIds.length || selectedWidgetIds.some(id => !WIDGET_ID_RE.test(id))) return null;
  return {
    kind: 'analytics_dashboard',
    dashboardId: String(value.dashboardId),
    selectedWidgetIds,
  };
}

export function normalizeChatRequestContext(context) {
  const projectId = typeof context?.projectId === 'string' && /^proj_[A-Za-z0-9_-]+$/.test(context.projectId)
    ? context.projectId
    : '';
  const projectTitle = projectId && typeof context?.projectTitle === 'string'
    ? context.projectTitle.replace(/\s+/g, ' ').trim().slice(0, 200)
    : '';
  const projectContext = projectId && projectTitle ? { projectId, projectTitle } : {};
  if (context?.mode === 'analytics_dashboard') {
    const routeScope = normalizeAnalyticsRouteScope(context.routeScope);
    return {
      mode: 'analytics_dashboard',
      ...(context.intent === 'create' ? { intent: 'create' } : {}),
      ...(routeScope ? { routeScope } : {}),
      ...projectContext,
    };
  }
  if (context?.mode === 'general') return { mode: 'general', ...projectContext };
  return projectId ? projectContext : null;
}

export function mergeChatRequestContexts(ambient, explicit, message = '') {
  let merged;
  if (explicit?.mode === 'general') {
    merged = { ...explicit };
  } else {
    merged = { ...(ambient || {}), ...(explicit || {}) };
  }
  if (!Object.keys(merged).length) return null;
  if (merged.mode === 'analytics_dashboard') delete merged.modeHint;
  if (merged.intent === 'create') {
    delete merged.routeScope;
    delete merged.modeHint;
  }
  if (merged.projectId) {
    const expectedSeed = `About project ${String(merged.projectTitle || '').replace(/\s+/g, ' ').trim()} (${merged.projectId}):`;
    if (!String(message).startsWith(expectedSeed)) {
      delete merged.projectId;
      delete merged.projectTitle;
    }
  }
  return Object.keys(merged).length ? merged : null;
}

export function createChatRequestId(cryptoLike = globalThis.crypto) {
  if (typeof cryptoLike?.randomUUID === 'function') return cryptoLike.randomUUID();
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

export function reconcileAnalyticsChatSelection(selected, availableWidgetIds) {
  const available = new Set((Array.isArray(availableWidgetIds) ? availableWidgetIds : [])
    .map(id => String(id || ''))
    .filter(id => WIDGET_ID_RE.test(id)));
  const result = [];
  for (const rawId of Array.isArray(selected) ? selected : []) {
    const id = String(rawId || '');
    if (!available.has(id) || result.includes(id)) continue;
    result.push(id);
    if (result.length === 2) break;
  }
  return result;
}

export function toggleAnalyticsChatSelection(selected, widgetId, availableWidgetIds) {
  const current = reconcileAnalyticsChatSelection(selected, availableWidgetIds);
  const id = String(widgetId || '');
  if (!WIDGET_ID_RE.test(id) || !(Array.isArray(availableWidgetIds) && availableWidgetIds.includes(id))) {
    return { selectedWidgetIds: current, changed: false, reason: 'stale' };
  }
  if (current.includes(id)) {
    return { selectedWidgetIds: current.filter(currentId => currentId !== id), changed: true };
  }
  if (current.length >= 2) {
    return { selectedWidgetIds: current, changed: false, reason: 'limit' };
  }
  return { selectedWidgetIds: [...current, id], changed: true };
}

const PENDING_CHAT_REQUEST_KEY = 'botboy.chat.pending-request.v1';
const PENDING_CHAT_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000;

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stableJsonValue(child)]));
  }
  return value;
}

export function chatRequestReplayKey(message, context, attachmentIds = []) {
  const value = JSON.stringify(stableJsonValue({
    version: 1,
    message: String(message || '').replace(/\r\n?/g, '\n').trim(),
    context: context || {},
    attachmentIds: Array.isArray(attachmentIds) ? [...attachmentIds] : [],
  }));
  // Store/compare the complete canonical payload. A short checksum is not an
  // equality proof and can strand a lost-response retry behind an ID conflict.
  return `v2:${value}`;
}

export function acquireChatRequestId({ storage = globalThis.sessionStorage, replayKey, cryptoLike = globalThis.crypto, now = Date.now() }) {
  try {
    const current = JSON.parse(storage?.getItem?.(PENDING_CHAT_REQUEST_KEY) || 'null');
    if (current && current.replayKey === replayKey
      && typeof current.requestId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(current.requestId)
      && Number.isFinite(current.createdAt)
      && now - current.createdAt >= 0
      && now - current.createdAt <= PENDING_CHAT_REQUEST_MAX_AGE_MS) {
      return current.requestId;
    }
  } catch {}
  const requestId = createChatRequestId(cryptoLike);
  try {
    storage?.setItem?.(PENDING_CHAT_REQUEST_KEY, JSON.stringify({ replayKey, requestId, createdAt: now }));
  } catch {}
  return requestId;
}

export function completeChatRequestId(requestId, storage = globalThis.sessionStorage) {
  try {
    const current = JSON.parse(storage?.getItem?.(PENDING_CHAT_REQUEST_KEY) || 'null');
    if (current?.requestId === requestId) storage.removeItem(PENDING_CHAT_REQUEST_KEY);
  } catch {}
}