// Tracker — Zoomable Grid UI
// Spatial navigation: grid of node cards → zoom into node → see subnodes + items
// Chat panel independent, never re-renders during navigation

const API = '/api';
const NOISE_KEYWORDS = ['misclassified', 'generic electron', 'noise'];

let state = {
  nodes: [], archivedNodes: [], chatMessages: [],
  navStack: [], // [{id, title}] breadcrumb trail
  currentNode: null, currentItems: [], currentChildren: [],
  currentKnowledge: null, viewMode: 'knowledge', // 'knowledge' or 'items'
  childrenCache: {},
  chatOpen: true, showNoise: false, processing: false,
  searchQuery: '', searchResults: null, searchActive: false,
};

let chatRequestContext = null;
let ambientChatRequestContext = null;

function normalizeChatRequestContext(context) {
  if (context?.mode === 'analytics_dashboard') {
    return {
      mode: 'analytics_dashboard',
      ...(context.intent === 'create' ? { intent: 'create' } : {}),
    };
  }
  if (context?.mode === 'general') return { mode: 'general' };
  return null;
}

function setChatRequestContext(context) {
  chatRequestContext = normalizeChatRequestContext(context);
}

function setAmbientChatRequestContext(context) {
  ambientChatRequestContext = normalizeChatRequestContext(context);
}

function clearChatRequestContext() {
  chatRequestContext = null;
}

function activeChatRequestContext() {
  return chatRequestContext || ambientChatRequestContext;
}

// ── API ──
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

async function loadRoots() { state.nodes = await api('/nodes/roots'); }
async function loadChildren(id) {
  const c = await api(`/nodes/${id}/children`);
  state.childrenCache[id] = c;
  return c;
}
async function loadNodeDetail(id) {
  const d = await api(`/nodes/${id}`);
  state.currentNode = d;
  state.currentItems = d.items || [];
  state.currentChildren = await loadChildren(id);
  // Load knowledge view
  try {
    state.currentKnowledge = await api(`/nodes/${id}/knowledge`);
  } catch { state.currentKnowledge = null; }
}
async function loadChatHistory() {
  state.chatMessages = await api('/chat/history');
  renderChat();
  // A terminal session may already exist (page reload mid-session).
  void checkChatTerminal();
  // Force scroll to bottom on initial load — chat should start at most-recent message,
  // not at the oldest one. renderChat's "nearBottom" check can't tell first-load from idle.
  const el = document.getElementById('chat-messages');
  if (el) {
    // rAF ensures the DOM has laid out heights before we read scrollHeight
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }
}

// ── Search ──
let _searchTimer = null;

function debounceSearch(q) {
  clearTimeout(_searchTimer);
  state.searchQuery = q;
  if (!q.trim()) { state.searchActive = false; state.searchResults = null; render(); return; }
  _searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/search?q=${encodeURIComponent(q.trim())}&limit=80`);
      state.searchResults = data;
      state.searchActive = true;
      render();
    } catch { /* ignore */ }
  }, 300);
}

function clearSearch() {
  state.searchQuery = ''; state.searchActive = false; state.searchResults = null;
  const el = document.getElementById('search-input');
  if (el) el.value = '';
  render();
}

// ── Actions ──
async function createNode(title, desc) { await api('/nodes', { method: 'POST', body: { title, description: desc } }); await loadRoots(); renderGrid(); }
async function archiveNode(id) { await api(`/nodes/${id}/archive`, { method: 'POST' }); goHome(); }
async function deleteNode(id) { if (!confirm('Delete this node and all its items?')) return; await api(`/nodes/${id}`, { method: 'DELETE' }); goHome(); }
async function sendChat(msg) {
  const chatEl = document.getElementById('chat-messages');

  // Append user bubble directly to DOM (no full rebuild — that would wipe frozen assistant bubbles from prior turns)
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-msg user';
  userBubble.innerHTML = renderChatMsgInner({ role: 'user', content: msg });
  chatEl.appendChild(userBubble);
  chatEl.scrollTop = chatEl.scrollHeight;

  // Segment model — data-driven rendering
  const segments = []; // { type: 'thinking'|'tool_call'|'text', ... }
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg assistant streaming-live';
  chatEl.appendChild(msgEl);

  function autoScroll() {
    const isNearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 100;
    if (isNearBottom) chatEl.scrollTop = chatEl.scrollHeight;
  }

  // Render segments to DOM — pure function from data to HTML
  let renderPending = false;
  function scheduleRender() {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        renderSegments();
        autoScroll();
      });
    }
  }

  function renderSegments() {
    msgEl.innerHTML = segments.map(seg => {
      if (seg.type === 'thinking') {
        const cls = seg.complete ? 'collapsed' : '';
        return `<div class="thinking-block ${cls}" onclick="this.classList.toggle('collapsed')">
          <span class="thinking-label">💭 Thinking${seg.complete ? '' : '...'}</span>
          <div class="thinking-content">${escHtml(seg.content)}</div>
        </div>`;
      }
      if (seg.type === 'tool_call') {
        const statusIcon = seg.status === 'done' ? '✓' : seg.status === 'running' ? '⏳' : '...';
        const resultHtml = seg.result ? `<div class="tool-card-result">${escHtml(seg.result.slice(0, 300))}${seg.result.length > 300 ? '...' : ''}</div>` : '';
        const argsHtml = seg.args ? `<pre class="tool-card-args">${escHtml(seg.args)}</pre>` : '';
        return `<div class="tool-card-standalone ${seg.status === 'done' ? 'tool-done' : ''}" onclick="this.classList.toggle('expanded')">
          <div class="tool-card-header">🔧 ${escHtml(seg.name)} ${statusIcon}</div>
          ${argsHtml}${resultHtml}
        </div>`;
      }
      if (seg.type === 'text') {
        return `<div class="content-block">${formatContent(seg.content)}</div>`;
      }
      return '';
    }).join('');
  }

  function formatContent(raw) {
    return formatMarkdownContent(raw);
  }

  // Helper: get or create the last segment of a given type
  function lastSeg(type) { return segments.length > 0 && segments[segments.length - 1].type === type ? segments[segments.length - 1] : null; }

  try {
    const resp = await fetch(`${API}/chat/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, stream: true, ...(activeChatRequestContext() || {}) }),
    });

    if (!resp.ok) {
      // Server returned non-2xx (e.g. 400). Read error body and surface it on the bubble.
      let errText = `HTTP ${resp.status}`;
      try { errText = (await resp.text()).slice(0, 500) || errText; } catch {}
      console.error('[sendChat] HTTP error response:', resp.status, errText);
      segments.push({ type: 'text', content: `❌ Error ${resp.status}: ${errText}` });
      renderSegments();
      msgEl.classList.remove('streaming-live');
      msgEl.classList.add('streaming-frozen');
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === 'thinking') {
            let seg = lastSeg('thinking');
            if (!seg || seg.complete) {
              seg = { type: 'thinking', content: '', complete: false };
              segments.push(seg);
            }
            seg.content += event.text;
            scheduleRender();

          } else if (event.type === 'token') {
            let seg = lastSeg('text');
            if (!seg) {
              seg = { type: 'text', content: '' };
              segments.push(seg);
            } else if (seg._isStatus) {
              // Status text is transient UI, never part of the assistant reply.
              seg.content = '';
              seg._isStatus = false;
            }
            seg.content += event.text;
            scheduleRender();

          } else if (event.type === 'status') {
            // Show as transient text if no real content yet
            let seg = lastSeg('text');
            if (!seg) {
              seg = { type: 'text', content: event.text };
              segments.push(seg);
              seg._isStatus = true;
            } else if (seg._isStatus) {
              seg.content = event.text; // replace status text
            }
            scheduleRender();

          } else if (event.type === 'tool_start') {
            // Close any open thinking block
            const openThink = segments.find(s => s.type === 'thinking' && !s.complete);
            if (openThink) openThink.complete = true;
            // Clear status text
            const statusSeg = segments.find(s => s._isStatus);
            if (statusSeg) { statusSeg.content = ''; statusSeg._isStatus = false; }
            // Interim prose before a tool call stays visible: natural progress
            // narration ("found the CSV, checking the DB now") is useful. The
            // old Goal/Plan boilerplate was fixed at its source (the system
            // prompt), not by deleting the model's words here.

            segments.push({ type: 'tool_call', id: event.index, name: event.name, args: '', status: 'pending', result: null });
            scheduleRender();

          } else if (event.type === 'tool_args') {
            // Append args to the last pending tool_call
            for (let i = segments.length - 1; i >= 0; i--) {
              if (segments[i].type === 'tool_call' && segments[i].status !== 'done') {
                segments[i].args += event.text;
                break;
              }
            }
            scheduleRender();

          } else if (event.type === 'tool') {
            // Mark matching tool as running
            for (let i = segments.length - 1; i >= 0; i--) {
              if (segments[i].type === 'tool_call' && segments[i].name === event.name && segments[i].status !== 'done') {
                segments[i].status = 'running';
                break;
              }
            }
            scheduleRender();

          } else if (event.type === 'tool_result') {
            // Find matching tool and set result
            for (let i = segments.length - 1; i >= 0; i--) {
              if (segments[i].type === 'tool_call' && segments[i].name === event.name && segments[i].status !== 'done') {
                segments[i].status = 'done';
                segments[i].result = event.preview || null;
                break;
              }
            }
            if (event.name === 'create_analytics_dashboard' && /"ok"\s*:\s*true/.test(event.preview || '')) {
              clearChatRequestContext();
            }
            // The agent opened/closed an embedded terminal — sync the dock now
            // so the card appears while the agent is still talking.
            if (event.name === 'open_terminal' || event.name === 'close_terminal') {
              void checkChatTerminal();
            }
            scheduleRender();

          } else if (event.type === 'done') {
            // Close any open thinking
            segments.forEach(s => { if (s.type === 'thinking') s.complete = true; });

            // The terminal message is authoritative. Server-side integrity
            // gates may append a receipt or replace rejected model prose only
            // after streaming has finished, so reconcile the final visible
            // text segment before freezing while preserving thinking/tool cards.
            for (let i = segments.length - 1; i >= 0; i--) {
              if (segments[i]._isStatus) segments.splice(i, 1);
            }
            const authoritativeContent = event.message && typeof event.message.content === 'string'
              ? event.message.content
              : null;
            if (authoritativeContent !== null) {
              let finalTextIndex = -1;
              for (let i = segments.length - 1; i >= 0; i--) {
                if (segments[i].type === 'text') {
                  finalTextIndex = i;
                  break;
                }
              }
              if (finalTextIndex >= 0) {
                segments[finalTextIndex].content = authoritativeContent;
                segments[finalTextIndex]._isStatus = false;
              } else {
                segments.push({ type: 'text', content: authoritativeContent });
              }
            }
            renderSegments();
            // Mark the bubble as FROZEN so the 5s chat poll doesn't wipe the rich segment UI
            msgEl.classList.remove('streaming-live');
            msgEl.classList.add('streaming-frozen');
            if (event.message && event.message.id) msgEl.dataset.msgId = event.message.id;
            state.chatMessages.push(event.message);
            // Link the reply's project mentions now rather than on the next poll.
            linkifyRenderedProjectMentions();

          } else if (event.type === 'retry') {
            // Server is retrying due to a transient network error. Purge tokens/tool_args
            // from the CURRENT (in-progress) iteration so the retry doesn't double-render.
            // We keep completed tool cards (status=done) and their thinking blocks since those
            // are finalized state. The last open 'text' (current iter's content) and any
            // in-flight tool_call with pending args get cleaned.
            for (let k = segments.length - 1; k >= 0; k--) {
              const s = segments[k];
              if (s.type === 'tool_call' && s.status !== 'done') {
                // In-flight tool call got torn down — drop it
                segments.splice(k, 1);
              } else if (s.type === 'text' && !s._isStatus) {
                // Drop the current in-progress text content (will be regenerated)
                segments.splice(k, 1);
              } else if (s.type === 'thinking' && !s.complete) {
                // Drop in-progress thinking (will be regenerated)
                segments.splice(k, 1);
              }
            }
            // Show a subtle retry notice
            segments.push({ type: 'text', content: `↻ ${event.message || 'Retrying...'}`, _isStatus: true });
            renderSegments();

          } else if (event.type === 'error') {
            segments.push({ type: 'text', content: `❌ Error: ${event.error}` });
            renderSegments();
            msgEl.classList.remove('streaming-live');
            msgEl.classList.add('streaming-frozen');
          }
        } catch {}
      }
    }

    // Safety net: if stream ended without a `done` or `error` event (e.g. connection
    // dropped, backend sent malformed SSE, ALB timeout), freeze the bubble anyway
    // so the 5s chat poll doesn't wipe it and so the user can see partial output.
    if (msgEl.classList.contains('streaming-live')) {
      console.warn('[sendChat] Stream ended without done/error event — freezing bubble');
      if (!segments.length || !segments.some(s => s.type === 'text' && s.content.startsWith('❌'))) {
        segments.push({ type: 'text', content: '⚠️ Stream ended unexpectedly (no done event)' });
        renderSegments();
      }
      msgEl.classList.remove('streaming-live');
      msgEl.classList.add('streaming-frozen');
    }
  } catch (e) {
    console.error('[sendChat] fetch/stream exception:', e);
    segments.push({ type: 'text', content: `❌ Error: ${e.message || 'Request failed'}` });
    renderSegments();
    msgEl.classList.remove('streaming-live');
    msgEl.classList.add('streaming-frozen');
  }
}
async function processInbox() {
  state.processing = true; render();
  try {
    await api('/agent/process', { method: 'POST' });
    const poll = setInterval(async () => {
      const s = await api('/agent/status');
      if (!s.active) { clearInterval(poll); state.processing = false; await loadRoots(); render(); }
    }, 2000);
  } catch { state.processing = false; render(); }
}

// ── Navigation ──
async function zoomInto(id, title, skipPush) {
  if (state.currentNode) state.navStack.push({ id: state.currentNode.id, title: state.currentNode.title });
  await loadNodeDetail(id);
  if (!skipPush) history.pushState({ type: 'node', id, title, navStack: [...state.navStack] }, '', `#node/${id}`);
  render();
}

async function goHome(skipPush) {
  state.navStack = [];
  state.currentNode = null;
  state.currentItems = [];
  state.currentChildren = [];
  await loadRoots();
  if (!skipPush) history.pushState({ type: 'home' }, '', '#');
  render();
}

async function goTo(idx, skipPush) {
  const target = state.navStack[idx];
  state.navStack = state.navStack.slice(0, idx);
  await loadNodeDetail(target.id);
  if (!skipPush) history.pushState({ type: 'node', id: target.id, title: target.title, navStack: [...state.navStack] }, '', `#node/${target.id}`);
  render();
}

// Handle browser back/forward (two-finger swipe on Mac)
window.addEventListener('popstate', async (e) => {
  const s = e.state;
  if (!s || s.type === 'home') {
    await goHome(true);
  } else if (s.type === 'node') {
    state.navStack = s.navStack || [];
    await loadNodeDetail(s.id);
    render();
  }
});

// ── Helpers ──

function toggleSummary(itemId) {
  const full = document.getElementById('summary-' + itemId);
  if (!full) return;
  if (full.style.display === 'none') {
    full.style.display = 'block';
  } else {
    full.style.display = 'none';
  }
}

function isNoise(title) { return NOISE_KEYWORDS.some(k => title.toLowerCase().includes(k)); }

function recency(node) {
  // Fake recency based on item count changes — in real app would use timestamps
  if (node.itemCount > 50) return 'hot';
  if (node.itemCount > 20) return 'warm';
  return 'cold';
}

function formatTime(ts) { if (!ts) return ''; return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

function sourceBadge(s) { return `<span class="badge badge-${s}">${s}</span>`; }

// ── Activity Heat Scoring ──

function computeHeat(child) {
  const a = child.activity;
  if (!a || !a.total) return { level: 'cool', label: 'Quiet', score: 0 };
  const recencyHours = a.lastActivity ? (Date.now() - new Date(a.lastActivity).getTime()) / 3600000 : 999;
  // Score: weight recent items heavily
  let score = (a.items24h * 5) + (a.items7d * 1) + (a.activeDays7d * 3);
  // Boost if very recent
  if (recencyHours < 1) score += 20;
  else if (recencyHours < 6) score += 10;
  // Velocity: items per active day
  const velocity = a.activeDays7d > 0 ? a.items7d / a.activeDays7d : 0;
  if (velocity > 30) score += 15;

  if (score >= 100) return { level: 'fire', label: '🔥 On Fire', score };
  if (score >= 40) return { level: 'hot', label: '⚡ Active', score };
  if (score >= 15) return { level: 'warm', label: '● Warm', score };
  return { level: 'cool', label: '○ Quiet', score };
}

function detectUrgency(child) {
  const desc = (child.description || '').toLowerCase();
  const title = (child.title || '').toLowerCase();
  const combined = desc + ' ' + title;
  // Deadline detection
  const deadlinePatterns = [/deadline/i, /due\s+(by|date|on)/i, /\burgent\b/i, /\basap\b/i, /\bblocking\b/i, /\bcritical\b/i, /\bpending\b.*\bdecision\b/i];
  for (const p of deadlinePatterns) {
    if (p.test(combined)) return true;
  }
  if (title.includes('[urgent]') || title.includes('⚠️')) return true;
  return false;
}

function activityBadgeHtml(heat) {
  return `<span class="activity-badge ab-${heat.level}">${heat.label}</span>`;
}

function activityMetaHtml(child) {
  const a = child.activity;
  if (!a) return '';
  const parts = [];
  if (a.items24h > 0) parts.push(`<span class="am-stat">${a.items24h} today</span>`);
  if (a.items7d > 0) parts.push(`<span class="am-stat">${a.items7d} this week</span>`);
  if (a.activeDays7d > 0) parts.push(`<span class="am-stat">${a.activeDays7d}d active</span>`);
  if (a.lastActivity) {
    const hrs = Math.round((Date.now() - new Date(a.lastActivity).getTime()) / 3600000);
    if (hrs < 1) parts.push(`<span class="am-stat">just now</span>`);
    else if (hrs < 24) parts.push(`<span class="am-stat">${hrs}h ago</span>`);
    else parts.push(`<span class="am-stat">${Math.round(hrs/24)}d ago</span>`);
  }
  return parts.length ? `<div class="activity-meta">${parts.join('')}</div>` : '';
}

// ── Render: Breadcrumb ──

function renderBreadcrumb() {
  const el = document.getElementById('breadcrumb');
  if (!state.currentNode) { el.innerHTML = ''; return; }
  let html = `<span class="breadcrumb-item" onclick="goHome()">Home</span>`;
  state.navStack.forEach((n, i) => {
    html += `<span class="breadcrumb-sep">›</span><span class="breadcrumb-item" onclick="goTo(${i})">${n.title}</span>`;
  });
  html += `<span class="breadcrumb-sep">›</span><span class="breadcrumb-current">${state.currentNode.title}</span>`;
  el.innerHTML = html;
}

// ── Render: Grid (home view) ──

function renderGrid() {
  const el = document.getElementById('grid-view');
  const detail = document.getElementById('detail-view');
  // Only toggle elements INSIDE the legacy-browser panel. This function runs
  // from app.js's 3s version poll on every capture, so it must never touch
  // sibling integration panels (slack-sources / local-folders) — doing so
  // slammed the Slack channel picker shut mid-selection (owner report
  // 2026-08-26). Panel exclusivity is owned by dashboard.js
  // showIntegration/closeIntegration.
  el.style.display = 'block';
  detail.style.display = 'none';

  const visible = state.nodes.filter(n => state.showNoise || !isNoise(n.title));
  const sorted = [...visible].sort((a, b) => b.itemCount - a.itemCount);

  if (!sorted.length) { el.innerHTML = '<div class="empty">No nodes yet. Create one to get started.</div>'; return; }

  el.innerHTML = `<div class="grid">${sorted.map(n => {
    const r = recency(n);
    const noise = isNoise(n.title);
    const urgent = detectUrgency(n);
    const hasAction = /action item|action on|owned by|must|constraint/i.test(n.description || '');
    const badges = [];
    if (urgent) badges.push('<span class="nc-badge nc-badge-urgent">🔴 Urgent</span>');
    if (hasAction) badges.push('<span class="nc-badge nc-badge-action">⚡ Action</span>');
    return `<div class="node-card ${noise ? 'noise' : ''} ${urgent ? 'nc-urgent' : ''}" onclick="zoomInto('${n.id}', '${n.title.replace(/'/g, "\\'")}')">
      <div class="pulse-ring pulse-${r}"></div>
      ${badges.length ? `<div class="nc-badges">${badges.join('')}</div>` : ''}
      <div class="node-card-title">${n.title}</div>
      ${n.description ? `<div class="node-card-desc">${n.description}</div>` : '<div class="node-card-desc" style="color:var(--text-ghost)">No description</div>'}
      <div class="node-card-footer">
        <span class="node-card-count">${n.itemCount} items</span>
        ${n.childCount > 0 ? `<span class="node-card-children">${n.childCount} sub-nodes ›</span>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ── Render: Detail (zoomed-in view) ──

// ── Render: Brain briefing (the "catch me up" panel for a project node) ──
function renderBrainBriefing(brain) {
  if (!brain) return '';
  const tasks = Array.isArray(brain.tasks) ? brain.tasks : [];
  const blockers = Array.isArray(brain.blockers) ? brain.blockers.filter(b => b && b.trim()) : [];
  const people = Array.isArray(brain.people) ? brain.people.filter(p => p && p.trim()) : [];
  const log = Array.isArray(brain.activityLog) ? brain.activityLog.filter(l => l && l.trim()) : [];

  // Open (actionable) tasks first: blocked → doing → todo; done excluded from the
  // "next actions" list. Within the panel, ordering already reflects priority.
  const rank = { blocked: 0, doing: 1, todo: 2, done: 3 };
  const openTasks = tasks.filter(t => t.state !== 'done').sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
  const doneCount = tasks.filter(t => t.state === 'done').length;

  const stateIcon = { blocked: '🚫', doing: '🔄', todo: '⬜', done: '✅' };

  const summaryHtml = brain.summary
    ? `<div class="brain-summary">${escHtml(brain.summary)}</div>`
    : '';

  const statusHtml = brain.statusLine
    ? `<div class="brain-status"><span class="brain-status-dot status-${brain.status || 'active'}"></span><span class="brain-status-text">${escHtml(brain.statusLine)}</span></div>`
    : '';

  const attentionHtml = blockers.length
    ? `<div class="brain-section brain-attention">
         <div class="brain-section-title">⚠️ Needs Attention</div>
         <ul class="brain-list">${blockers.map(b => `<li>${escHtml(b)}</li>`).join('')}</ul>
       </div>`
    : '';

  const actionsHtml = openTasks.length
    ? `<div class="brain-section brain-actions">
         <div class="brain-section-title">🎯 Key Next Actions</div>
         <ul class="brain-tasklist">${openTasks.map(t =>
           `<li class="brain-task task-${t.state}">${stateIcon[t.state] || '•'} <span>${escHtml(t.text)}</span></li>`
         ).join('')}</ul>
         ${doneCount ? `<div class="brain-done-note">✅ ${doneCount} completed</div>` : ''}
       </div>`
    : '';

  const peopleHtml = people.length
    ? `<div class="brain-section brain-people">
         <div class="brain-section-title">👥 People</div>
         <div class="brain-chips">${people.map(p => `<span class="brain-chip">${escHtml(p)}</span>`).join('')}</div>
       </div>`
    : '';

  // Recent activity — newest first, capped; expandable if long.
  const recent = [...log].reverse();
  const shown = recent.slice(0, 8);
  const rest = recent.slice(8);
  const activityHtml = shown.length
    ? `<div class="brain-section brain-activity">
         <div class="brain-section-title">🕑 Recent Activity</div>
         <ul class="brain-list brain-activity-list">${shown.map(l => `<li>${escHtml(l)}</li>`).join('')}</ul>
         ${rest.length ? `<details class="brain-activity-more"><summary>Show ${rest.length} earlier</summary><ul class="brain-list">${rest.map(l => `<li>${escHtml(l)}</li>`).join('')}</ul></details>` : ''}
       </div>`
    : '';

  return `<div class="brain-briefing">
    ${statusHtml}
    ${summaryHtml}
    ${attentionHtml}
    ${actionsHtml}
    ${peopleHtml}
    ${activityHtml}
  </div>`;
}

function renderDetail() {
  const el = document.getElementById('detail-view');
  const grid = document.getElementById('grid-view');
  // Same rule as renderGrid: background poll renders must never hide the
  // slack-sources / local-folders overlays. dashboard.js owns panel switching.
  grid.style.display = 'none';
  el.style.display = 'block';

  const n = state.currentNode;
  if (!n) return;

  const children = state.currentChildren || [];
  // Sort: urgent first, then by activity heat score desc
  const sortedChildren = [...children].sort((a, b) => {
    const ua = detectUrgency(a) ? 1 : 0, ub = detectUrgency(b) ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return computeHeat(b).score - computeHeat(a).score;
  });
  const childGrid = sortedChildren.length > 0 ? `
    <div class="detail-subnodes">
      <h3>Sub-nodes · ${sortedChildren.length}</h3>
      <div class="subnode-grid">${sortedChildren.map(c => {
        const heat = computeHeat(c);
        const urgent = detectUrgency(c);
        const urgCls = urgent ? 'urgency-fire' : (heat.level === 'fire' ? 'urgency-fire' : (heat.level === 'hot' ? 'urgency-hot' : ''));
        return `<div class="subnode-card ${urgCls}" onclick="zoomInto('${c.id}', '${c.title.replace(/'/g, "\\'")}')">
          <div class="activity-bar heat-${heat.level}"></div>
          <div class="subnode-title">${c.title}${activityBadgeHtml(heat)}</div>
          <div class="subnode-meta">${c.itemCount} items${c.description ? ' · <span style="color:var(--accent);cursor:pointer" onclick="openSubnodeSummary(\''+c.id+'\')">View summary</span>' : ''}${urgent ? ' · <span class="deadline-chip">⚠ Needs Attention</span>' : ''}</div>
          ${c.description ? `<div class="subnode-desc">${escHtml(c.description.slice(0, 200))}</div>` : ''}
          ${renderSubnodeSummaryChips(c.description)}
          ${activityMetaHtml(c)}
        </div>`;
      }).join('')}
      </div>
    </div>` : '';

  const k = state.currentKnowledge;
  const vm = state.viewMode;

  // View mode tabs
  const tabs = `<div class="view-tabs">
    <button class="view-tab ${vm === 'knowledge' ? 'active' : ''}" onclick="switchView('knowledge')">📖 Knowledge</button>
    <button class="view-tab ${vm === 'items' ? 'active' : ''}" onclick="switchView('items')">📋 All Items (${state.currentItems.length})</button>
  </div>`;

  // Knowledge digest panel
  let digestHtml = '';
  if (vm === 'knowledge' && k && k.digest && k.digest.length > 0) {
    digestHtml = `<div class="knowledge-digest">
      <div class="digest-header">
        <span class="digest-label">📚 ${k.itemsWithContent} of ${k.totalItems} items have captured content</span>
      </div>
      ${k.digest.map(d => `
        <div class="knowledge-card">
          <div class="kc-title">${escHtml(d.title || '(untitled)')}</div>
          <div class="kc-content">${escHtml(d.text)}</div>
          ${d.url ? `<div class="kc-url"><a href="${d.url}" target="_blank">${d.url.slice(0, 80)}${d.url.length > 80 ? '...' : ''}</a></div>` : ''}
          ${d.filePath ? `<div class="kc-url"><a href="#" data-action="reveal" data-path="${escAttr(d.filePath)}">📂 Reveal in Finder</a></div>` : ''}
          <div class="kc-time">${formatTime(d.capturedAt)}</div>
          <button class="ki-promote" onclick="event.stopPropagation();promoteToSubnode('${d.id}', this)">⬆ Make Sub-node</button>
        </div>`).join('')}
    </div>`;
  } else if (vm === 'knowledge') {
    digestHtml = '<div class="empty">No captured content yet for this node. Items will show knowledge as they are enriched.</div>';
  }

  // Full knowledge items view
  let knowledgeItemsHtml = '';
  if (vm === 'knowledge' && k && k.items) {
    const withContent = k.items.filter(i => i.content);
    if (withContent.length > 0) {
      knowledgeItemsHtml = `<div class="knowledge-items">
        <h3 class="section-label">All Captured Content</h3>
        ${withContent.map(item => `
          <div class="knowledge-item" onclick="this.classList.toggle('expanded')">
            <div class="ki-header">
              <span class="ki-title">${escHtml(item.title || '(untitled)')}</span>
              <span class="ki-meta">${item.type.replace(/_/g, ' ')} · ${sourceBadge(item.source)} · ${formatTime(item.capturedAt)}</span>
            </div>
            <div class="ki-preview">${escHtml((item.content || '').slice(0, 150))}${(item.content || '').length > 150 ? '...' : ''}</div>
            <div class="ki-full">${escHtml(item.content || '')}</div>
            ${item.url ? `<div class="ki-url"><a href="${item.url}" target="_blank" onclick="event.stopPropagation()">${item.url.slice(0, 80)}${item.url.length > 80 ? '...' : ''}</a></div>` : ''}
            ${item.metadata && item.metadata.filePath ? `<div class="ki-url"><a href="#" data-action="reveal" data-path="${escAttr(item.metadata.filePath)}" onclick="event.stopPropagation()">📂 Reveal in Finder</a></div>` : ''}
            <button class="ki-promote" id="promote-${item.id}" onclick="event.stopPropagation();promoteToSubnode('${item.id}', this)">⬆ Make Sub-node</button>
          </div>`).join('')}
      </div>`;
    }
  }

  // Items list view (original)
  let itemsHtml = '';
  if (vm === 'items') {
    const items = state.currentItems;
    itemsHtml = items.length > 0 ? `
      <div class="item-count-label">${items.length} items</div>
      ${items.map(item => `
        <div class="work-item">
          <div class="wi-top">
            <span class="type">${item.type.replace(/_/g, ' ')}</span>
            ${sourceBadge(item.source)}
          </div>
          <div class="title">${item.title || '(untitled)'}</div>
          ${item.url ? `<div class="meta"><a href="${item.url}" target="_blank">${item.url.slice(0, 70)}${item.url.length > 70 ? '...' : ''}</a></div>` : ''}
          ${item.metadata && item.metadata.filePath ? `<div class="meta"><a href="#" data-action="reveal" data-path="${escAttr(item.metadata.filePath)}">📂 Reveal in Finder</a></div>` : ''}
          ${item.summary ? `<div class="summary-container"><div class="summary-truncated">${item.summary.slice(0, 250)}</div><button class="expand-summary" onclick="toggleSummary('${item.id}')">Show more</button></div>` : ''}
          <div class="summary-full" id="summary-${item.id}" style="display:none">${escHtml(item.summary || '')}</div>
          <div class="meta">${formatTime(item.capturedAt)}</div>
        </div>`).join('')}` : '<div class="empty">No items in this node</div>';
  }

  el.innerHTML = `
    <div class="detail-header">
      <h2>${n.title}</h2>
      <div class="detail-actions">
        <button class="btn" onclick="archiveNode('${n.id}')">Archive</button>
        <button class="btn btn-danger" onclick="deleteNode('${n.id}')">Delete</button>
      </div>
    </div>
    ${n.brain ? renderBrainBriefing(n.brain) : (n.description ? renderStructuredSummary(n.description, n.title) : '')}
    ${childGrid}
    ${tabs}
    ${digestHtml}
    ${knowledgeItemsHtml}
    ${itemsHtml}`;
}

// ── Chat-embedded terminal dock ─────────────────────────────────────────────
// Rendered when the agent opens an interactive session (open_terminal tool).
// The user types here directly — including PINs and passwords via the secret
// toggle — so credentials never travel through chat messages or the model.
const chatTerm = { session: null, source: null, output: '', secret: false, built: false };

function chatTermStripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\u001b[()][0-9A-B]|\r(?!\n)/g, '');
}

function chatTermStatusLabel(session) {
  if (!session) return '';
  if (session.status === 'running') return 'Running';
  const exit = session.exitCode !== null && session.exitCode !== undefined ? ` (exit ${session.exitCode})` : '';
  return session.status.replace('_', ' ') + exit;
}

function buildChatTerminalDock() {
  const dock = document.getElementById('chat-terminal-dock');
  if (!dock || chatTerm.built) return dock;
  dock.innerHTML = `
    <div class="term-head">
      <span class="term-title" id="chat-term-title"></span>
      <span class="term-status" id="chat-term-status"></span>
      <button type="button" class="term-btn" id="chat-term-stop" title="Stop the command">Stop</button>
      <button type="button" class="term-btn" id="chat-term-dismiss" title="Hide this terminal">✕</button>
    </div>
    <pre class="term-output" id="chat-term-output" tabindex="0"></pre>
    <div class="term-input-row" id="chat-term-input-row">
      <input id="chat-term-input" type="text" autocomplete="off" spellcheck="false"
        placeholder="Type here and press Enter — input goes straight to the terminal">
      <label class="term-secret-toggle" title="Hide typed characters (for PINs and passwords)">
        <input type="checkbox" id="chat-term-secret">🔒
      </label>
    </div>`;
  chatTerm.built = true;

  const input = dock.querySelector('#chat-term-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void sendChatTerminalInput(input.value);
      input.value = '';
    }
  });
  dock.querySelector('#chat-term-secret').addEventListener('change', (e) => {
    chatTerm.secret = e.target.checked;
    input.type = chatTerm.secret ? 'password' : 'text';
    input.focus();
  });
  dock.querySelector('#chat-term-stop').addEventListener('click', () => { void stopChatTerminal(); });
  dock.querySelector('#chat-term-dismiss').addEventListener('click', () => {
    // Dismiss hides the card; a running session keeps running server-side and
    // the card returns on the next open_terminal/close_terminal sync.
    closeChatTerminalStream();
    document.getElementById('chat-terminal-dock').classList.add('hidden');
  });
  return dock;
}

function renderChatTerminalDock() {
  const dock = buildChatTerminalDock();
  if (!dock) return;
  const session = chatTerm.session;
  if (!session) { dock.classList.add('hidden'); return; }
  dock.classList.remove('hidden');
  dock.querySelector('#chat-term-title').textContent = session.title || 'Terminal';
  const statusEl = dock.querySelector('#chat-term-status');
  statusEl.textContent = chatTermStatusLabel(session);
  statusEl.className = `term-status ${session.status === 'running' ? 'is-running' : session.status === 'completed' ? 'is-ok' : 'is-bad'}`;
  const running = session.status === 'running';
  dock.querySelector('#chat-term-stop').classList.toggle('hidden', !running);
  dock.querySelector('#chat-term-input-row').classList.toggle('hidden', !running);
  const pane = dock.querySelector('#chat-term-output');
  pane.textContent = chatTerm.output;
  pane.scrollTop = pane.scrollHeight;
}

function appendChatTerminalOutput(chunk) {
  chatTerm.output = (chatTerm.output + chatTermStripAnsi(chunk)).slice(-100000);
  const pane = document.getElementById('chat-term-output');
  if (pane) {
    pane.textContent = chatTerm.output;
    pane.scrollTop = pane.scrollHeight;
  }
}

function closeChatTerminalStream() {
  if (chatTerm.source) {
    chatTerm.source.close();
    chatTerm.source = null;
  }
}

function attachChatTerminalStream(session) {
  closeChatTerminalStream();
  chatTerm.output = '';
  const source = new EventSource(`${API}/chat/terminal/${encodeURIComponent(session.id)}/stream`);
  chatTerm.source = source;
  source.addEventListener('output', (event) => {
    try { appendChatTerminalOutput(JSON.parse(event.data).chunk); } catch {}
  });
  source.addEventListener('end', (event) => {
    try { chatTerm.session = JSON.parse(event.data).session; } catch {}
    closeChatTerminalStream();
    renderChatTerminalDock();
  });
  source.onerror = () => { /* keep-alive gaps are normal; end closes cleanly */ };
}

async function checkChatTerminal() {
  try {
    const res = await fetch(`${API}/chat/terminal/active`);
    if (!res.ok) return;
    const payload = await res.json();
    const session = payload.session;
    const prevId = chatTerm.session?.id;
    chatTerm.session = session;
    if (session && session.status === 'running' && (prevId !== session.id || !chatTerm.source)) {
      attachChatTerminalStream(session);
    }
    renderChatTerminalDock();
  } catch { /* dashboard may be mid-restart */ }
}

async function sendChatTerminalInput(value) {
  const session = chatTerm.session;
  if (!session || session.status !== 'running') return;
  try {
    await fetch(`${API}/chat/terminal/${encodeURIComponent(session.id)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: `${value}\n` }),
    });
  } catch { /* surfaced by missing echo in the output pane */ }
}

async function stopChatTerminal() {
  const session = chatTerm.session;
  if (!session || session.status !== 'running') return;
  try {
    await fetch(`${API}/chat/terminal/${encodeURIComponent(session.id)}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch { /* end event updates the card */ }
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

// Escape values destined for an HTML *attribute* — must escape quotes, and
// must NOT convert \n to <br> (a literal "<br>" inside an attribute would
// double-escape on render). Used for `data-path="…"` on the Reveal-in-Finder
// links so file paths with quotes/spaces don't break the markup.
function escAttr(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Structured Summary Parser ──

function parseSummary(desc) {
  if (!desc) return null;
  const r = { overview: '', blockers: [], outcomes: [], chips: [], kvPairs: [], bullets: [], deadline: null, people: [] };

  // Extract deadline
  const dlMatch = desc.match(/(?:deadline|hard deadline|due)[^.]*?(?:Wednesday|Thursday|Friday|Monday|Tuesday|Saturday|Sunday|today|tomorrow|EOD|end of (?:day|week)|by \w+day)[^.]*/i)
    || desc.match(/(?:Wednesday|Thursday|Friday|Monday|Tuesday) is the (?:hard )?deadline[^.]*/i);
  if (dlMatch) r.deadline = dlMatch[0].trim().replace(/^\.\s*/, '');

  // Extract blockers: patterns like "(1) ...", "blocker:", "Two blockers:"
  const blockerSection = desc.match(/(?:blockers?:?\s*)(\(1\)[^]*?)(?=(?:Coupon|Fallback|Additional|Heightened|Key specs|$))/i);
  if (blockerSection) {
    const bText = blockerSection[1];
    const bItems = bText.split(/\(\d+\)\s*/).filter(s => s.trim());
    bItems.forEach(b => {
      const ownerMatch = b.match(/\(([^)]*(?:driving|owner|lead|responsible)[^)]*)\)/i) || b.match(/\((\w+\s*&\s*\w+\s+driving)\)/i);
      const dashParts = b.split('—').map(s => s.trim());
      r.blockers.push({
        title: dashParts[0] ? dashParts[0].replace(/\.\s*$/, '') : b.slice(0, 60),
        body: dashParts.length > 1 ? dashParts.slice(1).join(' — ').replace(/\.\s*$/, '') : '',
        owner: ownerMatch ? ownerMatch[1] : null
      });
    });
  }

  // Extract outcomes: "Three outcomes possible:", "outcomes:"
  const outcomeMatch = desc.match(/(?:outcomes? possible|possible outcomes?)[^:]*:\s*([^.]*\.)/i);
  if (outcomeMatch) {
    const oText = outcomeMatch[1].replace(/\.\s*$/, '');
    // Split on ", or " first, then on remaining commas
    const parts = oText.split(/,\s*or\s+/i);
    const allParts = [];
    parts.forEach((p, i) => {
      if (i === 0) {
        // First chunk may have comma-separated items
        p.split(/,\s+/).filter(s => s.trim().length > 5).forEach(s => allParts.push(s));
      } else {
        if (p.trim().length > 5) allParts.push(p);
      }
    });
    const labels = ['Best case', 'Good case', 'Worst case'];
    const cls = ['oc-good', 'oc-ok', 'oc-bad'];
    allParts.forEach((p, i) => {
      let text = p.trim().replace(/\)\s*$/, '').replace(/\.\s*$/, '');
      text = text.replace(/\s*\(worst case\s*=?\s*/i, ' — ').replace(/\)$/, '');
      r.outcomes.push({ label: labels[i] || `Option ${i+1}`, text, cls: cls[i] || 'oc-ok' });
    });
  }

  // Extract people
  const personPatterns = desc.matchAll(/(\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*\(([^)]+)\)/g);
  const seenPeople = new Set();
  const skipNames = new Set(['Three','Two','Full','Games','Wednesday','Additional','Coupon','Heightened','Amazon','Seattle','MX','Gold','Gamezop','Monday','Tuesday','Thursday','Friday']);
  for (const m of personPatterns) {
    const name = m[1].trim();
    if (!seenPeople.has(name) && !skipNames.has(name)) {
      seenPeople.add(name);
      r.people.push({ name, role: m[2].trim() });
    }
  }
  // Also catch "Name driving/leading/owner" patterns
  const rolePatterns = desc.matchAll(/\b([A-Z][a-z]+)\s+(?:to |can |needs to |&\s*[A-Z][a-z]+\s+)?(?:driving|leading|help|extend|drafting)/g);
  for (const m of rolePatterns) {
    const name = m[1].trim();
    if (!seenPeople.has(name) && !skipNames.has(name)) {
      seenPeople.add(name);
      r.people.push({ name, role: 'Contributor' });
    }
  }

  // Extract chips: blockers, risks, tech, status, specs
  const chipPatterns = [
    { re: /\b(blocker|blocking)\b/i, text: '🚫 Blocker', cls: 'chip-blocker' },
    { re: /heightened risk[^.]*/i, text: null, cls: 'chip-risk', extract: true },
    { re: /\b(MIB|Ministry)[^.]*/i, text: '⚠️ MIB Regulatory Risk', cls: 'chip-risk' },
    { re: /(\d+%\s*rollout)/i, text: null, cls: 'chip-status', extract: true },
    { re: /v(\d+\.\d+)/g, text: null, cls: 'chip-info', extractAll: true, prefix: 'v' },
    { re: /fallback[^.]*/i, text: '🔄 Fallback Available', cls: 'chip-fallback' },
    { re: /P50\s*[<:]?\s*(\d+\s*ms)/i, text: null, cls: 'chip-spec', prefix: 'P50 ' },
    { re: /P99\s*[<:]?\s*(\d+\s*ms)/i, text: null, cls: 'chip-spec', prefix: 'P99 ' },
    { re: /([\d,]+-[\d,]+\s*QPS)/i, text: null, cls: 'chip-spec', extract: true },
    { re: /(99\.\d+%\s*(?:uptime|availability))/i, text: null, cls: 'chip-spec', extract: true },
    { re: /\b(ECS Fargate|Lambda|EC2|API Gateway|Multi-AZ)\b/i, text: null, cls: 'chip-arch', extract: true },
    { re: /\b(Redis|CloudWatch)\b/i, text: null, cls: 'chip-tech', extract: true },
  ];
  const seenChips = new Set();
  for (const p of chipPatterns) {
    if (p.extractAll) {
      for (const m of desc.matchAll(p.re)) {
        const t = (p.prefix || '') + m[0];
        if (!seenChips.has(t)) { seenChips.add(t); r.chips.push({ text: t, cls: p.cls }); }
      }
    } else {
      const m = desc.match(p.re);
      if (m) {
        const t = p.text || (p.prefix || '') + (p.extract ? m[0] : m[1] || m[0]);
        if (!seenChips.has(t)) { seenChips.add(t); r.chips.push({ text: t.slice(0, 60), cls: p.cls }); }
      }
    }
  }

  // Build overview + remaining bullets
  const sentences = desc.split(/(?<=\.)\s+/).filter(s => s.trim());
  // Overview = first 1-2 sentences (before blockers/details start)
  const overviewEnd = sentences.findIndex(s => /blocker|outcome|coupon|fallback|additional|heightened|key spec/i.test(s));
  const overviewSentences = overviewEnd > 0 ? sentences.slice(0, overviewEnd) : sentences.slice(0, 2);
  r.overview = overviewSentences.join(' ');

  // Remaining sentences as KV pairs or bullets
  const used = new Set([...overviewSentences]);
  if (r.deadline) used.add(r.deadline);
  sentences.forEach(s => {
    if (used.has(s)) return;
    // Skip if already captured in blockers/outcomes
    if (r.blockers.some(b => s.includes(b.title)) || r.outcomes.some(o => s.includes(o.text))) return;
    const kvMatch = s.match(/^([^:]{3,40}):\s+(.+)/);
    if (kvMatch && kvMatch[1].split(' ').length <= 6) {
      r.kvPairs.push({ key: kvMatch[1].trim(), val: kvMatch[2].trim().replace(/\.\s*$/, '') });
    } else if (s.trim().length > 15) {
      r.bullets.push(s.trim());
    }
  });

  return r;
}

function renderStructuredSummary(desc, title) {
  const p = parseSummary(desc);
  if (!p) return '';
  let html = '<div class="summary-panel">';
  html += '<div class="sp-title">📋 Node Summary</div>';

  // Deadline banner
  if (p.deadline) {
    html += `<div class="deadline-banner"><span class="db-icon">⏰</span>${escHtml(p.deadline)}</div>`;
  }

  // Overview
  if (p.overview) {
    html += `<div class="summary-section"><div class="summary-overview">${escHtml(p.overview)}</div></div>`;
  }

  // Chips
  if (p.chips.length) {
    html += `<div class="summary-section"><div class="summary-chips">${p.chips.map(c => `<span class="summary-chip ${c.cls}">${escHtml(c.text)}</span>`).join('')}</div></div>`;
  }

  // People
  if (p.people.length) {
    html += `<div class="summary-section"><div class="ss-label">👤 Key People</div><div class="summary-chips">${p.people.map(pe => `<span class="summary-chip chip-person">${escHtml(pe.name)} · ${escHtml(pe.role)}</span>`).join('')}</div></div>`;
  }

  // Blockers
  if (p.blockers.length) {
    html += `<div class="summary-section"><div class="ss-label">🚫 Blockers</div>${p.blockers.map(b => `<div class="blocker-card"><div class="bc-title">🔴 ${escHtml(b.title)}</div>${b.body ? `<div class="bc-body">${escHtml(b.body)}</div>` : ''}${b.owner ? `<div class="bc-owner">👤 ${escHtml(b.owner)}</div>` : ''}</div>`).join('')}</div>`;
  }

  // Outcomes
  if (p.outcomes.length) {
    html += `<div class="summary-section"><div class="ss-label">🎯 Possible Outcomes</div><div class="outcome-row">${p.outcomes.map(o => `<div class="outcome-card ${o.cls}"><div class="oc-label">${escHtml(o.label)}</div><div class="oc-text">${escHtml(o.text)}</div></div>`).join('')}</div></div>`;
  }

  // KV pairs
  if (p.kvPairs.length) {
    html += `<div class="summary-section"><div class="ss-label">📌 Details</div><div class="summary-kv">${p.kvPairs.map(kv => `<span class="kv-key">${escHtml(kv.key)}</span><span class="kv-val">${escHtml(kv.val)}</span>`).join('')}</div></div>`;
  }

  // Remaining bullets
  if (p.bullets.length) {
    html += `<div class="summary-section"><div class="ss-label">📝 Additional Context</div>${p.bullets.map(b => `<div class="summary-bullet">${escHtml(b)}</div>`).join('')}</div>`;
  }

  html += '</div>';
  return html;
}

function renderSubnodeSummaryChips(desc) {
  if (!desc) return '';
  const p = parseSummary(desc);
  if (!p) return '';
  const chips = p.chips.slice(0, 4);
  if (p.deadline) chips.unshift({ text: '⏰ Deadline', cls: 'chip-deadline' });
  if (p.blockers.length) chips.unshift({ text: `🚫 ${p.blockers.length} Blocker${p.blockers.length > 1 ? 's' : ''}`, cls: 'chip-blocker' });
  if (!chips.length) return '';
  return `<div class="subnode-chips">${chips.slice(0, 5).map(c => `<span class="summary-chip ${c.cls}">${escHtml(c.text)}</span>`).join('')}</div>`;
}

// Subnode summary expand/close
window.openSubnodeSummary = 
function(id) {
  event.stopPropagation();
  const child = state.currentChildren.find(c => c.id === id);
  if (!child || !child.description) return;
  const overlay = document.createElement('div');
  overlay.className = 'subnode-summary-expand';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="subnode-summary-modal">
    <div class="ssm-header"><h3>${escHtml(child.title)}</h3><button class="ssm-close" onclick="this.closest('.subnode-summary-expand').remove()">✕</button></div>
    <div class="ssm-body">${renderStructuredSummary(child.description, child.title)}</div>
  </div>`;
  document.body.appendChild(overlay);
};

window.switchView = 
function(mode) {
  state.viewMode = mode;
  renderDetail();
};

// ── Render: Chat (independent) ──

function renderChat() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  // Runs before the early returns below: on a cold load the transcript is
  // already painted and unchanged, and this is the only pass that can still add
  // project links once the project index has arrived.
  linkifyRenderedProjectMentions();
  // Don't re-render if there's a live streaming message in the DOM
  if (el.querySelector('.streaming-live')) return;

  // Preserve frozen bubbles — completed streaming messages with rich segments (tool cards, thinking, text).
  // We only append NEW messages from state.chatMessages that aren't already rendered.
  const frozenBubbles = Array.from(el.querySelectorAll('.chat-msg.streaming-frozen'));
  if (frozenBubbles.length > 0) {
    // Signature = role:first200charsOfContent — used to skip duplicates when poll returns
    // messages that are already visible in DOM (either as frozen bubbles or as user bubbles
    // that were appended directly during sendChat without a DB id).
    const sig = (role, content) => `${role}:${(content || '').slice(0, 200)}`;
    const existingIds = new Set(
      Array.from(el.querySelectorAll('.chat-msg[data-msg-id]')).map(b => b.dataset.msgId)
    );
    const existingSigs = new Set(
      Array.from(el.querySelectorAll('.chat-msg')).map(b => {
        // Use textContent as a proxy for content comparison — rough but safe for dedup
        const role = b.classList.contains('user') ? 'user' : 'assistant';
        return sig(role, (b.textContent || '').trim());
      })
    );
    const newMessages = state.chatMessages.filter(m => {
      if (m.id && existingIds.has(m.id)) return false;
      if (existingSigs.has(sig(m.role, m.content))) return false;
      return true;
    });
    if (newMessages.length === 0) return;
    for (const m of newMessages) {
      const bubble = document.createElement('div');
      bubble.className = `chat-msg ${m.role}`;
      if (m.id) bubble.dataset.msgId = m.id;
      bubble.innerHTML = renderChatMsgInner(m);
      el.appendChild(bubble);
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) el.scrollTop = el.scrollHeight;
    return;
  }

  // No frozen bubbles — safe to do the full rebuild (cold load / refresh case)
  el.innerHTML = state.chatMessages.map(m => {
    const idAttr = m.id ? ` data-msg-id="${m.id}"` : '';
    return `<div class="chat-msg ${m.role}"${idAttr}>${renderChatMsgInner(m)}</div>`;
  }).join('');
  // Cold load / refresh: always scroll to bottom — newest messages should be visible.
  // Use rAF so DOM layout completes (image dims, thinking block rendering) before we measure scrollHeight.
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
    // Second rAF in case content shifted height after first paint (fonts, embedded blocks)
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  });
}

function renderChatMsgInner(m) {
  let raw = m.content || '';
  // Extract <think> content as reasoning
  let reasoning = m._reasoning || m.reasoning || '';
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    reasoning = reasoning || thinkMatch[1].trim();
    raw = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }
  // Also strip orphan </think> tags
  raw = raw.replace(/<\/?think>/g, '').trim();

  const content = formatMarkdownContent(raw);

  const thinkHtml = reasoning ? `<div class="thinking-block collapsed" onclick="this.classList.toggle('collapsed')"><span class="thinking-label">💭 Thinking</span><div class="thinking-content">${reasoning.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</div></div>` : '';
  return `${thinkHtml}<div class="content-block">${content}</div>`;
}

// ── Safe Markdown renderer ──
// Used by live streaming, cold history loads, and polling. Raw HTML is never
// accepted: every user/model fragment is escaped before this renderer emits a
// small, fixed set of semantic tags. That keeps rich chat output useful without
// making assistant messages an HTML/XSS execution surface.
function escapeMarkdownText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeMarkdownHref(value) {
  const href = String(value ?? '').trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (href.startsWith('/api/files/')) return href;
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function markdownAnchor(label, href) {
  const safeHref = safeMarkdownHref(href);
  if (!safeHref) return null;
  return `<a href="${escAttr(safeHref)}" target="_blank" rel="noopener noreferrer">${formatMarkdownInline(label, false)}</a>`;
}

// ── Project deeplinks in assistant messages ──
// BotBoy names projects constantly ("the WebLab rollout is blocked"), and until
// now those names were dead text — the owner had to go find the project in the
// sidebar. Every mention of a known project title or id becomes an in-app link.
// The canonical list comes from the dashboard, so a renamed or archived project
// stops linking on the next refresh instead of pointing at a stale route.
const PROJECT_MENTION_MIN_LENGTH = 5;
const PROJECT_MENTION_MAX_PATTERN_LENGTH = 24000;
let projectMentionCache = { signature: null, matcher: null };

function escapeRegExpLiteral(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A one-word title short enough to double as ordinary prose ("Weblab", "Kiro")
// would linkify half a paragraph, so require either a multi-word title or
// enough length that an accidental match is implausible.
function isLinkableProjectTitle(title) {
  if (title.length < PROJECT_MENTION_MIN_LENGTH) return false;
  return /\s/.test(title) || title.length >= 8;
}

function projectMentionMatcher() {
  const raw = typeof window.botboyProjectLinkIndex === 'function' ? window.botboyProjectLinkIndex() : null;
  const projects = Array.isArray(raw) ? raw : [];
  const signature = projects.map(project => `${project?.id}\u0000${project?.title}`).join('\u0001');
  if (projectMentionCache.signature === signature) return projectMentionCache.matcher;

  const lookup = new Map();
  const phrases = [];
  for (const project of projects) {
    const id = typeof project?.id === 'string' ? project.id.trim() : '';
    if (!id) continue;
    const title = typeof project?.title === 'string' ? project.title.replace(/\s+/g, ' ').trim() : '';
    for (const phrase of [title, id]) {
      const key = phrase.toLowerCase();
      if (!phrase || lookup.has(key)) continue;
      if (phrase === title && !isLinkableProjectTitle(phrase)) continue;
      lookup.set(key, id);
      phrases.push(phrase);
    }
  }

  // Longest first: regex alternation is leftmost-first, so this makes a longer
  // title win over a shorter one contained inside it.
  phrases.sort((a, b) => b.length - a.length);
  const alternation = phrases.map(escapeRegExpLiteral).join('|');
  const matcher = phrases.length && alternation.length <= PROJECT_MENTION_MAX_PATTERN_LENGTH
    ? { pattern: new RegExp(`(^|[^\\w])(${alternation})(?![\\w])`, 'gi'), lookup }
    : null;
  projectMentionCache = { signature, matcher };
  return matcher;
}

function linkifyProjectMentions(text, stash) {
  const matcher = projectMentionMatcher();
  if (!matcher) return text;
  matcher.pattern.lastIndex = 0;
  return text.replace(matcher.pattern, (match, prefix, phrase) => {
    const id = matcher.lookup.get(phrase.toLowerCase());
    if (!id) return match;
    const anchor = `<a class="chat-project-link" href="#/projects/${encodeURIComponent(id)}" title="Open project ${escapeMarkdownText(id)}">${escapeMarkdownText(phrase)}</a>`;
    return `${prefix}${stash(anchor)}`;
  });
}

// A painted bubble is never re-rendered from its Markdown: frozen streaming
// bubbles carry tool cards and thinking blocks that a rebuild would destroy. On
// a cold load the chat history paints before /api/dashboard resolves, so the
// index is still empty and those bubbles would keep dead project names forever.
// Upgrading them in place, by walking their text nodes, is the only pass that
// respects the freeze contract.
let projectMentionDomSignature = null;

function linkifyProjectMentionsInElement(element, matcher) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      // Existing links, code, and collapsed diagnostics stay exactly as they are.
      return node.parentElement?.closest('a, code, pre, .thinking-block, .tool-card-standalone')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node);

  for (const node of targets) {
    const text = node.nodeValue;
    matcher.pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (let match = matcher.pattern.exec(text); match; match = matcher.pattern.exec(text)) {
      const id = matcher.lookup.get(match[2].toLowerCase());
      if (!id) continue;
      const start = match.index + match[1].length;
      if (start > cursor) fragment.append(text.slice(cursor, start));
      const anchor = document.createElement('a');
      anchor.className = 'chat-project-link';
      anchor.href = `#/projects/${encodeURIComponent(id)}`;
      anchor.title = `Open project ${id}`;
      anchor.textContent = match[2];
      fragment.append(anchor);
      cursor = start + match[2].length;
    }
    if (!cursor) continue;
    if (cursor < text.length) fragment.append(text.slice(cursor));
    node.parentNode?.replaceChild(fragment, node);
  }
}

// The dashboard owns the project list and announces it once loaded. Listening
// beats polling: the chat poll only re-renders when a new message id appears, so
// a quiet transcript would otherwise never pick up the index.
window.addEventListener('botboy:projects-loaded', () => linkifyRenderedProjectMentions());

function linkifyRenderedProjectMentions() {
  const root = document.getElementById('chat-messages');
  if (!root) return;
  const matcher = projectMentionMatcher();
  if (!matcher) return;
  // Each bubble is scanned once. A changed index (projects loaded, renamed, or
  // archived) clears the marks so the whole transcript is re-examined.
  if (projectMentionDomSignature !== projectMentionCache.signature) {
    projectMentionDomSignature = projectMentionCache.signature;
    root.querySelectorAll('[data-project-links]').forEach(bubble => bubble.removeAttribute('data-project-links'));
  }
  for (const bubble of root.querySelectorAll('.chat-msg:not(.streaming-live):not([data-project-links])')) {
    bubble.dataset.projectLinks = '1';
    linkifyProjectMentionsInElement(bubble, matcher);
  }
}

function formatMarkdownInline(raw, allowLinks = true) {
  const tokens = [];
  const stash = html => {
    const index = tokens.push(html) - 1;
    return `\uE000${index}\uE001`;
  };
  let text = String(raw ?? '').replace(/[\uE000\uE001]/g, '�');

  if (allowLinks) {
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const anchor = markdownAnchor(label, href);
      return anchor ? stash(anchor) : match;
    });
  }

  // Protect code spans before applying emphasis or automatic links.
  text = text.replace(/`([^`\n]+)`/g, (_match, code) =>
    stash(`<code>${escapeMarkdownText(code)}</code>`));

  if (allowLinks) {
    text = text.replace(/https?:\/\/[^\s<>()\[\]]+/gi, match => {
      let url = match;
      let trailing = '';
      while (/[.,;:!?]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      const anchor = markdownAnchor(url, url);
      return anchor ? `${stash(anchor)}${trailing}` : match;
    });

    text = text.replace(/(?:~\/\.personal-productivity-tracker\/files\/|\/api\/files\/)([^\s<>"'()\]]+)/g, (match, relativePath) => {
      const href = match.startsWith('/api/files/') ? match : `/api/files/${relativePath}`;
      const anchor = markdownAnchor(match, href);
      return anchor ? stash(anchor) : match;
    });

    // Runs last so an explicit markdown link, URL, or code span that happens to
    // contain a project name is already stashed and stays untouched.
    text = linkifyProjectMentions(text, stash);
  }

  text = text.replace(/\/tmp\/[^\s<>"']+\.\w+/g, match =>
    stash(`<span class="md-file-path">${escapeMarkdownText(match)}</span>`));

  // Markdown has no standard underline token. Support ++underlined++ as a
  // deliberately narrow extension rather than accepting raw HTML.
  text = escapeMarkdownText(text)
    .replace(/\+\+([^+\n]+)\+\+/g, '<u>$1</u>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  return text.replace(/\uE000(\d+)\uE001/g, (_match, index) => tokens[Number(index)] || '');
}

function splitMarkdownTableRow(line) {
  let source = String(line ?? '').trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);

  const cells = [];
  let cell = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\' && source[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (source[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += source[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function markdownTableDelimiter(line) {
  const cells = splitMarkdownTableRow(line);
  if (cells.length < 2) return null;
  const compact = cells.map(cell => cell.replace(/\s/g, ''));
  if (!compact.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return compact.map(cell => cell.startsWith(':') && cell.endsWith(':')
    ? 'center'
    : cell.endsWith(':') ? 'right' : 'left');
}

function isMarkdownTable(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes('|')) return false;
  const headers = splitMarkdownTableRow(lines[index]);
  const alignment = markdownTableDelimiter(lines[index + 1]);
  return headers.length >= 2 && alignment?.length === headers.length;
}

function isMarkdownRule(line) {
  return /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isMarkdownBlockStart(lines, index) {
  const line = lines[index] || '';
  return /^\s{0,3}(?:```|~~~)/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || isMarkdownRule(line)
    || /^\s{0,3}[-+*•]\s+/.test(line)
    || /^\s{0,3}\d+[.)]\s+/.test(line)
    || /^\s{0,3}>\s?/.test(line)
    || isMarkdownTable(lines, index);
}

function formatMarkdownContent(raw) {
  const source = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!source) return '';

  const lines = source.split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^\s{0,3}(```|~~~)\s*([\w-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const language = (fence[2] || '').replace(/[^\w-]/g, '');
      const code = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        code.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      const languageClass = language ? ` class="language-${language}"` : '';
      blocks.push(`<pre><code${languageClass}>${escapeMarkdownText(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${formatMarkdownInline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    if (isMarkdownRule(line)) {
      blocks.push('<hr>');
      index++;
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const headers = splitMarkdownTableRow(lines[index]);
      const alignment = markdownTableDelimiter(lines[index + 1]);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = splitMarkdownTableRow(lines[index]);
        if (cells.length < 2) break;
        rows.push(Array.from({ length: headers.length }, (_unused, cellIndex) => cells[cellIndex] || ''));
        index++;
      }
      const headerHtml = headers.map((cell, cellIndex) =>
        `<th scope="col" class="md-align-${alignment[cellIndex]}">${formatMarkdownInline(cell)}</th>`).join('');
      const bodyHtml = rows.map(row => `<tr>${row.map((cell, cellIndex) =>
        `<td class="md-align-${alignment[cellIndex]}">${formatMarkdownInline(cell)}</td>`).join('')}</tr>`).join('');
      blocks.push(`<div class="md-table-wrap" role="region" aria-label="Scrollable table" tabindex="0"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }

    const unordered = line.match(/^\s{0,3}[-+*•]\s+(.+)$/);
    if (unordered) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s{0,3}[-+*•]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${formatMarkdownInline(item[1])}</li>`);
        index++;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s{0,3}\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${formatMarkdownInline(item[1])}</li>`);
        index++;
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      const quotedLines = [];
      while (index < lines.length) {
        const quoted = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!quoted) break;
        quotedLines.push(formatMarkdownInline(quoted[1]));
        index++;
      }
      blocks.push(`<blockquote>${quotedLines.join('<br>')}</blockquote>`);
      continue;
    }

    const paragraph = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index++;
    }
    blocks.push(`<p>${paragraph.map(part => formatMarkdownInline(part)).join('<br>')}</p>`);
  }

  return blocks.join('');
}

// ── Render: Search Results ──

function renderSearchResults() {
  const el = document.getElementById('grid-view');
  const detail = document.getElementById('detail-view');
  el.style.display = 'block';
  detail.style.display = 'none';

  const data = state.searchResults;
  if (!data || !data.results.length) {
    el.innerHTML = `<div class="empty">No results for "${escHtml(data?.query || '')}"</div>`;
    return;
  }

  const q = (data.query || '').toLowerCase();
  
  function highlight(text) {
    if (!text || !q) return escHtml(text);
    const safe = escHtml(text);
    const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return safe.replace(re, '<mark style="background:#7c3aed44;color:var(--accent);border-radius:2px;padding:0 2px">$1</mark>');
  }

  el.innerHTML = `
    <div style="margin-bottom:16px;font-size:13px;color:var(--text-muted)">
      ${data.totalResults} result${data.totalResults !== 1 ? 's' : ''} for "<span style="color:var(--accent)">${escHtml(data.query)}</span>"
    </div>
    ${data.results.map(r => `
      <div class="knowledge-item" onclick="this.classList.toggle('expanded')" style="margin-bottom:8px">
        <div class="ki-header">
          <span class="ki-title">${highlight(r.item.title || '(untitled)')}</span>
          <span class="ki-meta">${r.item.type.replace(/_/g, ' ')} · ${sourceBadge(r.item.source)} · ${formatTime(r.item.capturedAt)}</span>
        </div>
        <div class="ki-preview">${highlight(r.snippet)}</div>
        <div class="ki-full">${highlight(r.item.summary || '')}</div>
        ${r.item.url ? `<div class="ki-url"><a href="${r.item.url}" target="_blank" onclick="event.stopPropagation()">${r.item.url.slice(0, 80)}${r.item.url.length > 80 ? '...' : ''}</a></div>` : ''}
        ${r.item.metadata && r.item.metadata.filePath ? `<div class="ki-url"><a href="#" data-action="reveal" data-path="${escAttr(r.item.metadata.filePath)}" onclick="event.stopPropagation()">📂 Reveal in Finder</a></div>` : ''}
        ${r.node ? `<div style="margin-top:6px"><span onclick="event.stopPropagation();clearSearch();zoomInto('${r.node.id}','${(r.node.title||'').replace(/'/g,"\\'")}')" style="font-size:11px;color:var(--accent);cursor:pointer;background:var(--accent-bg);padding:2px 8px;border-radius:99px">📁 ${escHtml(r.node.title)}</span></div>` : ''}
      </div>`).join('')}`;
}

// ── Master render ──

function render() {
  renderBreadcrumb();
  if (state.searchActive) renderSearchResults();
  else if (state.currentNode) renderDetail();
  else renderGrid();
}

// ── Global handlers ──
window.zoomInto = zoomInto;
window.goHome = goHome;
window.goTo = goTo;
window.setChatContext = setChatRequestContext;
window.setAmbientChatContext = setAmbientChatRequestContext;
window.clearChatContext = clearChatRequestContext;
window.debounceSearch = debounceSearch;
window.clearSearch = clearSearch;
window.toggleChat = () => { state.chatOpen = !state.chatOpen; document.getElementById('chat-panel').classList.toggle('hidden', !state.chatOpen); };
window.toggleNoise = () => {
  state.showNoise = !state.showNoise;
  document.getElementById('noise-toggle').textContent = state.showNoise ? '👁 Hide noise' : '👁 Show noise';
  render();
};
window.showNewNodeModal = () => document.getElementById('modal-overlay').classList.add('show');
window.hideModal = () => { document.getElementById('modal-overlay').classList.remove('show'); };
window.submitNewNode = async () => {
  const t = document.getElementById('newNodeTitle')?.value?.trim();
  if (!t) return;
  const d = document.getElementById('newNodeDesc')?.value?.trim();
  await createNode(t, d);
  document.getElementById('newNodeTitle').value = '';
  document.getElementById('newNodeDesc').value = '';
  hideModal();
};
window.submitChat = async () => { const el = document.getElementById('chatInput'); const msg = el?.value?.trim(); if (!msg) return; el.value = ''; await sendChat(msg); };
// Shared escape-first Markdown renderer, exposed for the Documents view
// (dashboard.js). All text is escaped before any tags are produced, so
// rendering hostile document content cannot inject markup.
window.formatMarkdownContent = formatMarkdownContent;
window.archiveNode = archiveNode;
window.deleteNode = deleteNode;
window.processInbox = processInbox;

window.promoteToSubnode = async function(itemId, btn) {
  if (!state.currentNode) return;
  btn.classList.add('promoting');
  btn.textContent = '⏳ Creating...';
  try {
    const result = await api(`/nodes/${state.currentNode.id}/promote-item`, {
      method: 'POST', body: { workItemId: itemId }
    });
    btn.classList.remove('promoting');
    btn.classList.add('done');
    btn.textContent = `✓ Created — ${result.totalItems} items found`;
    // Reload the detail view to show the new subnode
    await loadNodeDetail(state.currentNode.id);
    render();
  } catch (err) {
    btn.classList.remove('promoting');
    btn.textContent = '✗ Failed — retry';
    console.error('Promote failed:', err);
  }
};

// ── Slack Sources panel ──
// Module-scoped state for the panel: the user's pending selection (mutated as
// checkboxes toggle, NOT cleared on save failure) and the last-fetched list.
let slackSelectedIds = new Set();
let slackConversations = [];

const SLACK_TYPE_LABEL = {
  public_channel: '# public',
  private_channel: '🔒 private',
  dm: '✉️ dm',
  group_dm: '👥 group dm',
};

function showSlackStatus(text) {
  const el = document.getElementById('slack-sources-status');
  const err = document.getElementById('slack-sources-error');
  if (err) { err.hidden = true; err.textContent = ''; }
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}

async function showSlackError(prefix, res) {
  const el = document.getElementById('slack-sources-error');
  const status = document.getElementById('slack-sources-status');
  if (status) { status.hidden = true; status.textContent = ''; }
  if (!el) return;
  let bodyErr = '';
  try {
    const body = await res.clone().json();
    if (body && typeof body.error === 'string') bodyErr = body.error;
  } catch { /* non-JSON body — ignore */ }
  const reason = res.statusText || '';
  const detail = bodyErr ? ` — ${bodyErr}` : '';
  el.textContent = `${prefix}: HTTP ${res.status} ${reason}${detail}`.trim();
  el.hidden = false;
}

let slackSourcesFilter = '';
const SLACK_TYPE_ORDER = ['public_channel', 'private_channel', 'group_dm', 'dm'];
const SLACK_GROUP_HEADING = {
  public_channel: 'Public channels',
  private_channel: 'Private channels',
  group_dm: 'Group DMs',
  dm: 'Direct messages',
};

function renderSlackSourcesList() {
  const list = document.getElementById('slack-sources-list');
  if (!list) return;
  if (!slackConversations.length) {
    list.innerHTML = '<div class="empty" style="padding:24px">No conversations available. Invite the bot to a channel or start a DM with it, then reload.</div>';
    return;
  }
  // Search + grouped alphabetical order: with many hundreds of conversations
  // (826 at last count), a flat unsorted list made channels unfindable.
  const needle = slackSourcesFilter.trim().toLowerCase();
  const visible = needle
    ? slackConversations.filter(c => (c.name || '').toLowerCase().includes(needle))
    : slackConversations;
  if (!visible.length) {
    list.innerHTML = `<div class="empty" style="padding:24px">No conversation name matches "${escHtml(slackSourcesFilter)}". Only conversations you are a member of appear here — join the channel in Slack, then reopen this panel.</div>`;
    return;
  }
  const groups = SLACK_TYPE_ORDER
    .map(type => ({
      type,
      items: visible
        .filter(c => c.type === type)
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    }))
    .filter(group => group.items.length > 0);
  list.innerHTML = groups.map(group => {
    const rows = group.items.map(c => {
      const checked = slackSelectedIds.has(c.id) ? 'checked' : '';
      const typeLabel = SLACK_TYPE_LABEL[c.type] || c.type;
      return `<label class="work-item" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:0">
        <input type="checkbox" data-id="${escHtml(c.id)}" ${checked} style="width:16px;height:16px;accent-color:var(--accent-strong);cursor:pointer">
        <span class="title" style="flex:1;color:var(--text)">${escHtml(c.name || '(unnamed)')}</span>
        <span class="type" style="color:var(--text-muted)">${escHtml(typeLabel)}</span>
      </label>`;
    }).join('');
    return `<div class="eyebrow" style="margin:14px 0 6px">${escHtml(SLACK_GROUP_HEADING[group.type] || group.type)} (${group.items.length})</div>${rows}`;
  }).join('');
  // Bind toggle handlers — mutate the local Set so saveSlackSources sends current selection.
  list.querySelectorAll('input[type="checkbox"][data-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.getAttribute('data-id');
      if (!id) return;
      if (cb.checked) slackSelectedIds.add(id);
      else slackSelectedIds.delete(id);
    });
  });
}

let slackFilterBound = false;

function bindSlackSourcesFilter() {
  if (slackFilterBound) return;
  const input = document.getElementById('slack-sources-filter');
  if (!input) return;
  slackFilterBound = true;
  input.addEventListener('input', () => {
    slackSourcesFilter = input.value || '';
    renderSlackSourcesList();
  });
}

// ── Slack user-token onboarding (teammates paste their xoxp here) ──

let slackTokenBound = false;

async function refreshSlackTokenStatus() {
  const line = document.getElementById('slack-token-status-line');
  if (!line) return;
  try {
    const res = await fetch('/api/slack/token/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    if (!status.configured) {
      line.textContent = 'No token saved yet — Slack capture is disabled until one is added.';
    } else if (status.restartPending) {
      line.textContent = `Token ${status.tokenMasked} saved. Restart BotBoy to start capturing with it.`;
    } else {
      const mode = status.captureMode === 'socket' ? 'live socket capture' : status.captureMode === 'poll' ? 'polling capture (checks every ~90s)' : 'capture disabled';
      line.textContent = `Token ${status.tokenMasked} active — ${mode}.`;
    }
  } catch (e) {
    line.textContent = `Could not read token status: ${e.message || 'error'}`;
  }
}

function bindSlackTokenCard() {
  if (slackTokenBound) return;
  const button = document.getElementById('slack-token-save');
  const input = document.getElementById('slack-token-input');
  if (!button || !input) return;
  slackTokenBound = true;
  button.addEventListener('click', async () => {
    const result = document.getElementById('slack-token-result');
    const token = (input.value || '').trim();
    if (!token) return;
    button.disabled = true;
    button.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/slack/token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      input.value = '';
      if (result) {
        result.hidden = false;
        result.textContent = `Verified as ${body.identity?.user || 'unknown user'} in ${body.identity?.team || 'workspace'} and saved (${body.tokenMasked}).${body.restartRequired ? ' Restart BotBoy to apply — quit and reopen BotBoy.app, or rerun ./start.sh.' : ''}`;
      }
      await refreshSlackTokenStatus();
    } catch (e) {
      if (result) {
        result.hidden = false;
        result.textContent = `Not saved: ${e.message || 'verification failed'}`;
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Verify & save';
    }
  });
}

async function loadSlackSources() {
  bindSlackSourcesFilter();
  bindSlackTokenCard();
  void refreshSlackTokenStatus();
  // Clear banners before a fresh load.
  const status = document.getElementById('slack-sources-status');
  const err = document.getElementById('slack-sources-error');
  if (status) { status.hidden = true; status.textContent = ''; }
  if (err) { err.hidden = true; err.textContent = ''; }

  // Instant paint: conversations from the previous open render immediately
  // while a fresh list loads in the background. A cold open shows an honest
  // loading message instead of a blank panel — the server walks Slack's
  // paginated API, which takes seconds for hundreds of conversations.
  const list = document.getElementById('slack-sources-list');
  if (slackConversations.length) {
    renderSlackSourcesList();
    showSlackStatus('Refreshing the conversation list from Slack…');
  } else if (list) {
    list.innerHTML = '<div class="empty" style="padding:24px">Loading your Slack conversations… This reads the full list from Slack and can take a few seconds on first open.</div>';
  }

  let convosRes, cfgRes;
  try {
    [convosRes, cfgRes] = await Promise.all([
      fetch('/api/slack/conversations'),
      fetch('/api/slack/config'),
    ]);
  } catch (e) {
    if (err) {
      err.textContent = `Failed to load Slack sources: ${e.message || 'network error'}`;
      err.hidden = false;
    }
    return;
  }
  if (!convosRes.ok) return showSlackError('Failed to load Slack conversations', convosRes);
  if (!cfgRes.ok) return showSlackError('Failed to load Slack config', cfgRes);
  const { conversations } = await convosRes.json();
  const { ids } = await cfgRes.json();
  slackConversations = Array.isArray(conversations) ? conversations : [];
  slackSelectedIds = new Set(Array.isArray(ids) ? ids : []);
  if (status) { status.hidden = true; status.textContent = ''; }
  renderSlackSourcesList();
}

async function saveSlackSources() {
  const status = document.getElementById('slack-sources-status');
  const err = document.getElementById('slack-sources-error');
  if (status) { status.hidden = true; status.textContent = ''; }
  if (err) { err.hidden = true; err.textContent = ''; }
  let res;
  try {
    res = await fetch('/api/slack/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...slackSelectedIds] }),
    });
  } catch (e) {
    if (err) {
      err.textContent = `Failed to save Slack sources: ${e.message || 'network error'}`;
      err.hidden = false;
    }
    return;
  }
  if (!res.ok) {
    // IMPORTANT: do not mutate slackSelectedIds — pending toggles are preserved (Req 7.6).
    return showSlackError('Failed to save Slack sources', res);
  }
  showSlackStatus('Saved. Capture rules updated immediately.');
}

window.loadSlackSources = loadSlackSources;
window.saveSlackSources = saveSlackSources;

// Toggle to show the Slack Sources panel and hide the other views. Reused by
// the topbar 🔌 Slack button. Refreshes data every time so the user always
// sees the current config + available conversations.
async function showSlackSources() {
  const grid = document.getElementById('grid-view');
  const detail = document.getElementById('detail-view');
  const panel = document.getElementById('slack-sources');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'none';
  if (panel) panel.style.display = 'block';
  await loadSlackSources();
}
window.showSlackSources = showSlackSources;

// ── Local Folders panel ──
//
// Implementation notes for task 8.2:
//
//   - **Item-count badge**: we derive the count client-side from the existing
//     `/api/search?q=…` endpoint (no new server route). The search endpoint
//     already returns `item.metadata` is *not* available there, so instead
//     we hit `/api/local-folders/:id/stats` if the server exposes it, and
//     fall back to "—" otherwise. Currently the server does NOT expose a
//     stats endpoint (task 5.x scope did not include one), so we render a
//     dash for the count to avoid a noisy 404 on every panel load. A future
//     task can add the stats endpoint without changing this UI code.
//
//   - **Backfill SSE over POST**: `EventSource` does not support POST
//     natively, so we use `fetch('/api/local-folders/:id/backfill', { method:
//     'POST' })` and read the response body as a stream. The reader is
//     parked in `lfBackfillReaders` so `cancelBackfill` can cancel the
//     reader in addition to hitting `DELETE …/backfill` on the server.

let lfFolders = [];
let lfBackfillReaders = new Map(); // folderId → ReadableStreamDefaultReader
let lfBackfillState = new Map();   // folderId → { processed, total, phase }

function showLfStatus(text) {
  const el = document.getElementById('local-folders-status');
  const err = document.getElementById('local-folders-error');
  if (err) { err.hidden = true; err.textContent = ''; }
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}

async function showLfError(prefix, res) {
  const el = document.getElementById('local-folders-error');
  const status = document.getElementById('local-folders-status');
  if (status) { status.hidden = true; status.textContent = ''; }
  if (!el) return;
  let bodyErr = '';
  try {
    const body = await res.clone().json();
    if (body && typeof body.error === 'string') bodyErr = body.error;
  } catch { /* non-JSON body — ignore */ }
  const reason = res.statusText || '';
  const detail = bodyErr ? ` — ${bodyErr}` : '';
  el.textContent = `${prefix}: HTTP ${res.status} ${reason}${detail}`.trim();
  el.hidden = false;
}

function clearLfBanners() {
  const status = document.getElementById('local-folders-status');
  const err = document.getElementById('local-folders-error');
  if (status) { status.hidden = true; status.textContent = ''; }
  if (err) { err.hidden = true; err.textContent = ''; }
}

function renderLocalFoldersList() {
  const list = document.getElementById('local-folders-list');
  if (!list) return;
  if (!lfFolders.length) {
    list.innerHTML = '<div class="empty" style="padding:24px">No folders yet. Click "+ Add folder" to register one.</div>';
    return;
  }
  list.innerHTML = lfFolders.map(f => {
    const id = f.id;
    const enabled = !!f.enabled;
    const recursive = !!f.recursive;
    const bf = lfBackfillState.get(id);
    let progressHtml = '';
    if (bf) {
      if (bf.phase === 'started' || bf.phase === 'progress') {
        const pct = bf.total ? Math.round(((bf.processed || 0) / bf.total) * 100) : 0;
        progressHtml = `<span class="type" style="color:var(--accent)">⏳ ${bf.processed || 0}/${bf.total || 0} (${pct}%)</span>`;
      } else if (bf.phase === 'done') {
        progressHtml = `<span class="type" style="color:var(--green)">✓ ${bf.processed} files</span>`;
      } else if (bf.phase === 'aborted') {
        progressHtml = `<span class="type" style="color:var(--text-muted)">⊘ aborted at ${bf.processed || 0}</span>`;
      } else if (bf.phase === 'error') {
        progressHtml = `<span class="type" style="color:var(--red)">✗ ${escHtml(bf.error || 'error')}</span>`;
      }
    }
    const running = bf && (bf.phase === 'started' || bf.phase === 'progress');
    const backfillBtn = running
      ? `<button class="btn" type="button" data-action="cancel-backfill" data-id="${id}">Cancel backfill</button>`
      : `<button class="btn" type="button" data-action="start-backfill" data-id="${id}">Backfill now</button>`;
    return `<div class="work-item" data-folder-id="${id}" style="display:flex;align-items:center;gap:10px;margin-bottom:0">
      <div style="flex:1;min-width:0">
        <div class="title" style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(f.path)}</div>
        <div class="meta">
          <span class="type">— items</span>
          · <span class="type">${recursive ? 'recursive' : 'non-recursive'}</span>
          · <span class="type">${enabled ? 'enabled' : 'disabled'}</span>
          ${progressHtml ? ' · ' + progressHtml : ''}
        </div>
      </div>
      ${backfillBtn}
      <button class="btn" type="button" data-action="toggle-enabled" data-id="${id}">${enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-danger" type="button" data-action="remove" data-id="${id}">Delete</button>
    </div>`;
  }).join('');

  // Bind row-level actions (delegated within the list).
  list.querySelectorAll('button[data-action]').forEach(btn => {
    const action = btn.getAttribute('data-action');
    const id = Number(btn.getAttribute('data-id'));
    if (!Number.isFinite(id)) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (action === 'start-backfill') startBackfill(id);
      else if (action === 'cancel-backfill') cancelBackfill(id);
      else if (action === 'toggle-enabled') {
        const folder = lfFolders.find(x => x.id === id);
        if (folder) updateLocalFolder(id, { enabled: !folder.enabled });
      } else if (action === 'remove') {
        removeLocalFolder(id);
      }
    });
  });
}

async function loadLocalFolders() {
  clearLfBanners();
  let res;
  try {
    res = await fetch('/api/local-folders');
  } catch (e) {
    const err = document.getElementById('local-folders-error');
    if (err) {
      err.textContent = `Failed to load local folders: ${e.message || 'network error'}`;
      err.hidden = false;
    }
    return;
  }
  if (!res.ok) return showLfError('Failed to load local folders', res);
  const body = await res.json();
  lfFolders = Array.isArray(body.folders) ? body.folders : [];
  renderLocalFoldersList();
}

async function addLocalFolder() {
  const pathInput = document.getElementById('lf-path-input');
  const recInput = document.getElementById('lf-recursive-input');
  if (!pathInput) return;
  const path = (pathInput.value || '').trim();
  const recursive = !!(recInput && recInput.checked);
  if (!path) {
    const err = document.getElementById('local-folders-error');
    if (err) { err.textContent = 'Path is required.'; err.hidden = false; }
    return;
  }
  clearLfBanners();
  let res;
  try {
    res = await fetch('/api/local-folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, recursive }),
    });
  } catch (e) {
    const err = document.getElementById('local-folders-error');
    if (err) {
      err.textContent = `Failed to add folder: ${e.message || 'network error'}`;
      err.hidden = false;
    }
    return;
  }
  if (!res.ok) {
    // Preserve form input — Req 6.4
    return showLfError('Failed to add folder', res);
  }
  // Success — clear input, hide form, reload list.
  pathInput.value = '';
  if (recInput) recInput.checked = true;
  const form = document.getElementById('local-folders-add-form');
  if (form) form.hidden = true;
  showLfStatus('Folder added. Capture rules updated immediately.');
  await loadLocalFolders();
}

async function updateLocalFolder(id, patch) {
  clearLfBanners();
  let res;
  try {
    res = await fetch(`/api/local-folders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    const err = document.getElementById('local-folders-error');
    if (err) {
      err.textContent = `Failed to update folder: ${e.message || 'network error'}`;
      err.hidden = false;
    }
    return;
  }
  if (!res.ok) return showLfError('Failed to update folder', res);
  showLfStatus('Saved. Capture rules updated immediately.');
  await loadLocalFolders();
}

async function removeLocalFolder(id) {
  if (!confirm('Stop watching this folder? Items already ingested are kept.')) return;
  clearLfBanners();
  let res;
  try {
    res = await fetch(`/api/local-folders/${id}`, { method: 'DELETE' });
  } catch (e) {
    const err = document.getElementById('local-folders-error');
    if (err) {
      err.textContent = `Failed to delete folder: ${e.message || 'network error'}`;
      err.hidden = false;
    }
    return;
  }
  if (!res.ok) return showLfError('Failed to delete folder', res);
  // Drop any backfill state for the deleted folder.
  const reader = lfBackfillReaders.get(id);
  if (reader) { try { reader.cancel(); } catch {} lfBackfillReaders.delete(id); }
  lfBackfillState.delete(id);
  showLfStatus('Folder removed.');
  await loadLocalFolders();
}

// Manually parse the SSE stream from a fetch POST. The wire format is the
// standard `event: <name>\ndata: <json>\n\n` blocks; we accumulate bytes in
// a buffer, split on blank lines, and feed each block through a small
// parser that updates `lfBackfillState` and re-renders the row.
async function startBackfill(id) {
  // If a previous reader is still parked, cancel it first.
  const prior = lfBackfillReaders.get(id);
  if (prior) { try { prior.cancel(); } catch {} }
  lfBackfillState.set(id, { phase: 'started', processed: 0, total: 0 });
  renderLocalFoldersList();

  let resp;
  try {
    resp = await fetch(`/api/local-folders/${id}/backfill`, {
      method: 'POST',
      headers: { 'Accept': 'text/event-stream' },
    });
  } catch (e) {
    lfBackfillState.set(id, { phase: 'error', error: e.message || 'network error' });
    renderLocalFoldersList();
    return;
  }
  if (!resp.ok || !resp.body) {
    let errText = `HTTP ${resp.status}`;
    try { errText = (await resp.text()).slice(0, 300) || errText; } catch {}
    lfBackfillState.set(id, { phase: 'error', error: errText });
    renderLocalFoldersList();
    return;
  }

  const reader = resp.body.getReader();
  lfBackfillReaders.set(id, reader);
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split into SSE blocks separated by blank lines.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let evtName = 'message';
        let dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) evtName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        let payload = {};
        try { payload = dataStr ? JSON.parse(dataStr) : {}; } catch {}
        lfBackfillState.set(id, { phase: evtName, ...payload });
        renderLocalFoldersList();
        if (evtName === 'done' || evtName === 'aborted' || evtName === 'error') {
          // Stream is finished — let the reader drain and exit.
        }
      }
    }
  } catch (e) {
    // Reader was cancelled or the stream errored; reflect in state if we
    // didn't already see a terminal phase.
    const cur = lfBackfillState.get(id);
    if (!cur || (cur.phase !== 'done' && cur.phase !== 'aborted' && cur.phase !== 'error')) {
      lfBackfillState.set(id, { phase: 'error', error: e.message || 'stream error' });
      renderLocalFoldersList();
    }
  } finally {
    lfBackfillReaders.delete(id);
  }
}

async function cancelBackfill(id) {
  // Hit the DELETE endpoint so the server aborts the in-flight backfill
  // (idempotent — 204 even if nothing is running).
  try {
    await fetch(`/api/local-folders/${id}/backfill`, { method: 'DELETE' });
  } catch {
    // Network errors here aren't fatal — we still cancel the local reader
    // below so the UI doesn't appear stuck.
  }
  const reader = lfBackfillReaders.get(id);
  if (reader) { try { reader.cancel(); } catch {} lfBackfillReaders.delete(id); }
  // Don't overwrite the state if the server already streamed an `aborted`
  // event before we got here.
  const cur = lfBackfillState.get(id);
  if (!cur || (cur.phase !== 'done' && cur.phase !== 'aborted' && cur.phase !== 'error')) {
    lfBackfillState.set(id, { phase: 'aborted', processed: cur?.processed || 0 });
    renderLocalFoldersList();
  }
}

async function showLocalFolders() {
  const grid = document.getElementById('grid-view');
  const detail = document.getElementById('detail-view');
  const slackPanel = document.getElementById('slack-sources');
  const lfPanel = document.getElementById('local-folders');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'none';
  if (slackPanel) slackPanel.style.display = 'none';
  if (lfPanel) lfPanel.style.display = 'block';
  await loadLocalFolders();
}

window.loadLocalFolders = loadLocalFolders;
window.addLocalFolder = addLocalFolder;
window.updateLocalFolder = updateLocalFolder;
window.removeLocalFolder = removeLocalFolder;
window.startBackfill = startBackfill;
window.cancelBackfill = cancelBackfill;
window.showLocalFolders = showLocalFolders;

// ── In-app file preview ──
//
// Agent-generated artifacts live under ~/.personal-productivity-tracker/files/
// and are served raw at /api/files/<rel>. Clicking such a link in chat used to
// open the raw bytes in a new tab; previewFile() renders them in an in-app
// overlay instead, by extension:
//
//   .md         → formatMarkdownContent (same renderer chat bubbles use)
//   .csv/.tsv   → quoted-field-aware parse → <table>
//   .json       → pretty-printed <pre> (falls back to raw on parse failure)
//   .html/.htm  → sandboxed <iframe src> (allow-scripts only — NO
//                 allow-same-origin, so artifact scripts cannot touch the
//                 app origin, its localStorage, or its API; "Open in tab"
//                 is the full-fidelity escape hatch)
//   images      → <img>
//   everything else → escaped <pre>
//
// Text fetches are capped at 500 KB and tables at 1000 rows with a visible
// truncation notice; "Open in tab" always shows the complete file.

const FPV_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const FPV_TEXT_CAP = 500 * 1024;
const FPV_ROW_CAP = 1000;

// Quoted-field-aware delimited-text parser (CSV/TSV). Handles quoted fields
// containing delimiters/newlines and "" escapes. Stops early past the row cap
// (+1 so the truncation notice knows there was more).
function parseDelimitedRows(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length > FPV_ROW_CAP) return rows;
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function fpvTableHtml(rows) {
  if (rows.length === 0) return '<div class="fpv-note">Empty file</div>';
  const truncated = rows.length > FPV_ROW_CAP;
  const shown = truncated ? rows.slice(0, FPV_ROW_CAP) : rows;
  const [head, ...body] = shown;
  const th = head.map(c => `<th>${escHtml(c)}</th>`).join('');
  const trs = body.map(r => `<tr>${r.map(c => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('');
  const note = truncated ? `<div class="fpv-note">Showing first ${FPV_ROW_CAP} rows — use “Open in tab” for the full file.</div>` : '';
  return `<div class="fpv-table-wrap"><table class="fpv-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>${note}`;
}

/**
 * Normalize a candidate file href to its /api/files/<rel> form. The model
 * regularly writes ABSOLUTE links (http://localhost:7778/api/files/x.md) in
 * chat — those must preview in-app exactly like relative ones (soak find,
 * 2026-08-25: absolute links escaped to browser tabs). Non-file and
 * cross-origin URLs return null.
 */
function normalizeApiFilesHref(href) {
  if (typeof href !== 'string' || !href) return null;
  if (href.startsWith('/api/files/')) return href;
  try {
    const url = new URL(href, location.origin);
    if (url.origin === location.origin && url.pathname.startsWith('/api/files/')) {
      return url.pathname + url.search;
    }
  } catch { /* not a URL */ }
  return null;
}

window.previewFile = async (rawHref) => {
  const href = normalizeApiFilesHref(rawHref);
  if (!href) return;
  // One preview at a time — replace any open overlay instead of stacking.
  document.querySelectorAll('.file-preview-expand').forEach(el => el.remove());
  const rel = href.slice('/api/files/'.length);
  let displayName = rel;
  try { displayName = decodeURIComponent(rel); } catch {}
  const ext = (displayName.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

  const overlay = document.createElement('div');
  overlay.className = 'file-preview-expand';
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', onKey);

  overlay.innerHTML = `<div class="file-preview-modal" role="dialog" aria-label="File preview: ${escAttr(displayName)}">
    <div class="fpv-header">
      <span class="fpv-name" title="${escAttr(displayName)}">📄 ${escHtml(displayName)}</span>
      <div class="fpv-actions">
        <a class="fpv-btn" href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">Open in tab</a>
        <button class="fpv-btn" data-fpv-reveal type="button">Reveal in Finder</button>
        <button class="fpv-close" data-fpv-close type="button" aria-label="Close preview">✕</button>
      </div>
    </div>
    <div class="fpv-body"><div class="fpv-note">Loading…</div></div>
  </div>`;
  overlay.querySelector('[data-fpv-close]').onclick = close;
  overlay.querySelector('[data-fpv-reveal]').onclick = () => {
    const abs = `~/.personal-productivity-tracker/files/${displayName}`;
    fetch(`/api/files/reveal?path=${encodeURIComponent(abs)}`).catch(() => {});
  };
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.fpv-body');

  // Types the browser renders natively — embed by URL, no fetch needed.
  if (FPV_IMAGE_EXTS.has(ext)) {
    body.innerHTML = `<img class="fpv-img" src="${escAttr(href)}" alt="${escAttr(displayName)}">`;
    return;
  }
  if (ext === 'html' || ext === 'htm') {
    body.innerHTML = `<iframe class="fpv-frame" src="${escAttr(href)}" sandbox="allow-scripts" title="${escAttr(displayName)}"></iframe>`;
    return;
  }

  // Text-ish types — fetch and render.
  let text;
  try {
    const res = await fetch(href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    body.innerHTML = `<div class="fpv-error">Could not load file (${escHtml(String(err && err.message || err))}). Try “Open in tab”.</div>`;
    return;
  }
  const tooBig = text.length > FPV_TEXT_CAP;
  if (tooBig) text = text.slice(0, FPV_TEXT_CAP);
  const capNote = tooBig ? '<div class="fpv-note">Preview truncated at 500 KB — use “Open in tab” for the full file.</div>' : '';

  if (ext === 'md' || ext === 'markdown') {
    body.innerHTML = `<div class="content-block fpv-md">${formatMarkdownContent(text)}</div>${capNote}`;
  } else if (ext === 'csv' || ext === 'tsv') {
    body.innerHTML = fpvTableHtml(parseDelimitedRows(text, ext === 'tsv' ? '\t' : ',')) + capNote;
  } else if (ext === 'json') {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    body.innerHTML = `<pre class="fpv-pre">${escHtml(pretty)}</pre>${capNote}`;
  } else {
    body.innerHTML = `<pre class="fpv-pre">${escHtml(text)}</pre>${capNote}`;
  }
};

// ── file:// link click interceptor ──
//
// Browsers block `file://` navigation from `http://` origins, and even when
// they didn't, we want to defer to the OS (Finder/Preview/etc.) via the
// `/api/files/open` shim. A single delegated listener handles both:
//
//   - Anchors with `data-action="reveal"` route through `/api/files/reveal`
//     (the path comes from the anchor's `data-path` attribute, which is
//     rendered with `escAttr` so quoted/UTF-8/space-bearing paths survive).
//   - Anchors whose `href` starts with `file://` route through
//     `/api/files/open`.
document.addEventListener('click', (e) => {
  // Reveal-in-Finder anchors take priority — they share the `<a>` shape but
  // carry an explicit data-action attribute.
  const revealAnchor = e.target.closest && e.target.closest('a[data-action="reveal"]');
  if (revealAnchor) {
    e.preventDefault();
    const path = revealAnchor.getAttribute('data-path') || '';
    if (path) {
      fetch(`/api/files/reveal?path=${encodeURIComponent(path)}`).catch(() => {});
    }
    return;
  }
  // File hrefs — open the in-app preview overlay instead of a raw new tab.
  // Matches RELATIVE (/api/files/x) and ABSOLUTE same-origin
  // (http://localhost:7778/api/files/x) links: the model writes both forms
  // in chat. The open/reveal action shims share the prefix but are not
  // files. Only the header actions ("Open in tab") pass through untouched:
  // file links INSIDE a previewed document re-preview in place.
  const anyAnchor = e.target.closest && e.target.closest('a[href]');
  const normalizedHref = anyAnchor ? normalizeApiFilesHref(anyAnchor.getAttribute('href') || '') : null;
  if (anyAnchor && normalizedHref && !anyAnchor.closest('.fpv-actions')) {
    const slug = normalizedHref.slice('/api/files/'.length);
    if (slug && slug !== 'open' && slug !== 'reveal' && !slug.startsWith('open?') && !slug.startsWith('reveal?')) {
      e.preventDefault();
      window.previewFile(normalizedHref);
      return;
    }
  }
  // file:// hrefs — strip the scheme, decode, and POST through the shim.
  const fileAnchor = e.target.closest && e.target.closest('a[href^="file://"]');
  if (fileAnchor) {
    e.preventDefault();
    const href = fileAnchor.getAttribute('href') || '';
    let path = href.slice('file://'.length);
    try { path = decodeURIComponent(path); } catch {}
    if (path) {
      fetch(`/api/files/open?path=${encodeURIComponent(path)}`).catch(() => {});
    }
  }
});

// ── Init ──
(async () => {
  // Bind the Slack save button once at boot. Uses the module-scoped selectedIds
  // Set so the click handler always sees the latest pending selection.
  const slackSaveBtn = document.getElementById('slack-sources-save');
  if (slackSaveBtn) slackSaveBtn.addEventListener('click', () => { saveSlackSources(); });

  // Local Folders panel: bind the "+ Add folder" button (toggles the form),
  // the "Add" submit button, and the "Cancel" button. Bound once at boot
  // so we don't double-wire on subsequent panel opens.
  const lfAddBtn = document.getElementById('local-folders-add-btn');
  const lfForm = document.getElementById('local-folders-add-form');
  const lfSubmitBtn = document.getElementById('lf-submit-add');
  const lfCancelBtn = document.getElementById('lf-cancel-add');
  const lfPathInput = document.getElementById('lf-path-input');
  if (lfAddBtn && lfForm) {
    lfAddBtn.addEventListener('click', () => {
      lfForm.hidden = false;
      if (lfPathInput) lfPathInput.focus();
    });
  }
  if (lfSubmitBtn) lfSubmitBtn.addEventListener('click', () => { addLocalFolder(); });
  if (lfCancelBtn && lfForm) {
    lfCancelBtn.addEventListener('click', () => {
      lfForm.hidden = true;
      clearLfBanners();
    });
  }
  if (lfPathInput) {
    lfPathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addLocalFolder(); }
    });
  }

  await Promise.all([
    loadRoots(),
    loadChatHistory(),
    loadSlackSources(),
  ]);
  render();

  // Poll for updates
  let lastVersion = 0;
  let lastTermFingerprint = '';
  let lastAutoOpenedTerminalId = '';
  setInterval(async () => {
    try {
      const { version, terminal } = await api('/dashboard/version');
      // Terminal sessions can be opened from any tab or by the agent loop —
      // sync the chat dock whenever the server-side session id/status moves.
      const fingerprint = terminal ? `${terminal.id}:${terminal.status}` : '';
      if (fingerprint !== lastTermFingerprint) {
        lastTermFingerprint = fingerprint;
        void checkChatTerminal();
        // A running session this tab has not seen yet means the server side
        // (agent turn or the Midway sentinel) needs the owner at the terminal
        // card — surface the assistant panel once per session so it is not
        // missed. Track the id so re-closing the panel is respected.
        if (terminal && terminal.status === 'running' && terminal.id !== lastAutoOpenedTerminalId) {
          lastAutoOpenedTerminalId = terminal.id;
          const panel = document.getElementById('chat-panel');
          if (panel?.classList.contains('hidden')) window.toggleChat?.();
        }
      }
      if (version !== lastVersion) {
        lastVersion = version;
        await loadRoots();
        if (state.currentNode) await loadNodeDetail(state.currentNode.id);
        // Same rule as dashboard.js hasUnsavedUserInput: a background render
        // rebuilds grid/detail innerHTML and would destroy text the owner is
        // typing inside the legacy panel. State is fresh; the next
        // user-driven render paints it.
        const legacy = document.getElementById('legacy-browser');
        const active = document.activeElement;
        const typingInLegacy = legacy && active && legacy.contains(active)
          && active.matches('input, textarea, select, [contenteditable="true"]');
        if (!typingInLegacy) render();
      }
    } catch {}
  }, 3000);

  // Chat poll — detect new messages from DB
  setInterval(async () => {
    const chatEl = document.getElementById('chat-messages');
    if (chatEl && chatEl.querySelector('.streaming-live')) return;
    const msgs = await api('/chat/history');
    const lastNew = msgs.length > 0 ? msgs[msgs.length - 1].id : null;
    const lastCur = state.chatMessages.length > 0 ? state.chatMessages[state.chatMessages.length - 1].id : null;
    if (lastNew !== lastCur) { state.chatMessages = msgs; renderChat(); }
  }, 5000);
})();

// ── Log Viewer (appended) ──
let logViewerOpen = false;
async function toggleLogViewer() {
  logViewerOpen = !logViewerOpen;
  const panel = document.getElementById('log-viewer-panel');
  if (!panel) {
    const chatPanel = document.getElementById('chat-panel');
    if (!chatPanel) return;
    const div = document.createElement('div');
    div.id = 'log-viewer-panel';
    div.style.cssText = 'position:fixed;bottom:0;right:0;width:500px;height:300px;background:#111;border:1px solid #333;border-radius:8px 8px 0 0;z-index:1000;display:flex;flex-direction:column;font-family:monospace;font-size:11px;';
    div.innerHTML = `<div style="padding:6px 12px;background:#1a1a1a;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center">
      <span style="color:#888">📋 Agent Logs</span>
      <div><button onclick="switchLogTab('agent')" id="log-tab-agent" style="background:#333;color:#e0e0e0;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;margin-right:4px;font-size:11px">Agent</button><button onclick="switchLogTab('app')" id="log-tab-app" style="background:#222;color:#888;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px">App</button><button onclick="toggleLogViewer()" style="background:none;border:none;color:#888;cursor:pointer;margin-left:8px">✕</button></div>
    </div><pre id="log-content" style="flex:1;overflow-y:auto;padding:8px;color:#8f8;margin:0;white-space:pre-wrap;word-break:break-all"></pre>`;
    document.body.appendChild(div);
    refreshLogs('agent');
    setInterval(() => { if (logViewerOpen) refreshLogs(currentLogTab); }, 3000);
  } else {
    panel.style.display = logViewerOpen ? 'flex' : 'none';
  }
}
let currentLogTab = 'agent';
window.switchLogTab = 
function(tab) {
  currentLogTab = tab;
  document.getElementById('log-tab-agent').style.background = tab === 'agent' ? '#333' : '#222';
  document.getElementById('log-tab-agent').style.color = tab === 'agent' ? '#e0e0e0' : '#888';
  document.getElementById('log-tab-app').style.background = tab === 'app' ? '#333' : '#222';
  document.getElementById('log-tab-app').style.color = tab === 'app' ? '#e0e0e0' : '#888';
  refreshLogs(tab);
};

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); }
async function refreshLogs(tab) {
  try {
    const data = await (await fetch(`/api/logs/${tab}`)).json();
    const el = document.getElementById('log-content');
    if (el) {
      const cleaned = (data.lines || []).map(stripAnsi).filter(l => l.trim());
      el.textContent = cleaned.length > 0 ? cleaned.join('\n') : '(no logs yet)';
      el.scrollTop = el.scrollHeight;
    }
  } catch (e) { const el = document.getElementById('log-content'); if (el) el.textContent = 'Error loading logs: ' + e.message; }
}
window.toggleLogViewer = toggleLogViewer;

// Diagnostics remain available from the redesigned Settings view. Only append
// the legacy topbar button when a compatibility host explicitly opts in.
setTimeout(() => {
  const topbar = document.querySelector('[data-legacy-log-target]');
  if (topbar && !document.getElementById('log-btn')) {
    const btn = document.createElement('button');
    btn.id = 'log-btn';
    btn.className = 'btn';
    btn.textContent = '📋 Logs';
    btn.onclick = toggleLogViewer;
    btn.style.marginLeft = '8px';
    topbar.appendChild(btn);
  }
}, 1000);
