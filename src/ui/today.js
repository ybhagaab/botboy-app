function isPending(context, itemId) {
  return context.pending instanceof Set && context.pending.has(itemId);
}

function projectActionKey(section, projectId) {
  return `today-project:${section}:${projectId}`;
}

function focusTabId(section, projectId) {
  return `today-${section}-tab-${projectId}`;
}

/**
 * Pure wheel-boundary decision for Today panes. A non-zero result means the
 * pane cannot consume this vertical gesture and the same delta should be
 * handed to the workspace. Horizontal-dominant gestures always stay native.
 */
export function todayPaneHandoffDelta({ scrollTop, scrollHeight, clientHeight, deltaX, deltaY }) {
  const top = Number(scrollTop);
  const height = Number(scrollHeight);
  const viewport = Number(clientHeight);
  const x = Number(deltaX);
  const y = Number(deltaY);
  if (![top, height, viewport, x, y].every(Number.isFinite) || y === 0 || Math.abs(x) >= Math.abs(y)) return 0;
  const maxScrollTop = Math.max(0, height - viewport);
  const epsilon = 1;
  const canConsume = y < 0 ? top > epsilon : top < maxScrollTop - epsilon;
  return canConsume ? 0 : y;
}

function projectPinControl(itemId, pinned, disabled, context) {
  const { icon, attr } = context;
  const label = pinned ? 'Project pinned' : 'Pin project';
  return `<button class="today-project-pin ${pinned ? 'active' : ''}" type="button" data-action="today-pin" data-item="${attr(itemId)}" data-pinned="${pinned}" aria-pressed="${pinned}" title="${pinned ? 'Unpin project' : 'Pin project to Today'}" aria-label="${pinned ? 'Unpin project' : 'Pin project to Today'}"${disabled}>${icon('pin', 13)} <span>${label}</span></button>`;
}

function compactItemControls(item, context) {
  const { icon, attr } = context;
  const disabled = isPending(context, item.id) ? ' disabled' : '';
  return `<div class="today-focus-line-actions" role="group" aria-label="Item controls">
    <button class="today-control ${item.pinned ? 'active' : ''}" type="button" data-action="today-pin" data-item="${attr(item.id)}" data-pinned="${item.pinned}" aria-pressed="${item.pinned}" title="${item.pinned ? 'Unpin' : 'Pin to the top'}" aria-label="${item.pinned ? 'Unpin item' : 'Pin item to the top'}"${disabled}>${icon('pin', 13)}</button>
    <button class="today-control" type="button" data-action="today-snooze" data-item="${attr(item.id)}" title="Snooze until tomorrow morning" aria-label="Snooze item until tomorrow morning"${disabled}>${icon('clock', 13)}</button>
    <button class="today-control" type="button" data-action="today-dismiss" data-item="${attr(item.id)}" title="Dismiss" aria-label="Dismiss item"${disabled}>${icon('x', 13)}</button>
  </div>`;
}

// Commitments stay verbatim: their text is the stable item identity. The
// status is communicated once — by the check/marker and one quiet metadata
// phrase — instead of the old dot + several pills + four always-visible icons.
function attentionLine(item, context) {
  const { icon, esc, attr } = context;
  const blocker = item.kind === 'blocker';
  const blocked = blocker || item.state === 'blocked';
  const pending = isPending(context, item.id);
  const marker = item.kind === 'task'
    ? `<button class="today-focus-check ${blocked ? 'blocked' : item.state === 'doing' ? 'doing' : ''}" type="button" data-action="today-done" data-item="${attr(item.id)}" title="Mark done in the project brain" aria-label="Mark task done in the project brain"${pending ? ' disabled' : ''}>${icon('check', 11)}</button>`
    : `<span class="today-focus-check blocker" aria-hidden="true">${icon('alert', 10)}</span>`;
  const stateMeta = [];
  if (blocker) stateMeta.push('Blocker');
  else if (item.state === 'blocked') stateMeta.push('Blocked task');
  else if (item.state === 'doing') stateMeta.push('In progress');
  if (/decision or response wording/.test(item.reason || '')) stateMeta.push('Decision / response');
  const pinMeta = item.pinned
    ? `<span class="today-focus-line-pinned">${icon('pin', 10)} Pinned</span>`
    : '';
  const stateText = stateMeta.length ? `<span>${esc(stateMeta.join(' · '))}</span>` : '';
  return `<li class="today-focus-line${item.pinned ? ' pinned' : ''}">
    ${marker}
    <a class="today-focus-line-copy" href="#/projects/${encodeURIComponent(item.projectId)}" title="${attr(item.reason || '')}">
      <span class="today-focus-line-text">${esc(item.title)}</span>
      ${pinMeta || stateText ? `<span class="today-focus-line-meta ${blocked ? 'warn' : item.state === 'doing' ? 'blue' : ''}">${pinMeta}${stateText}</span>` : ''}
    </a>
    ${compactItemControls(item, context)}
  </li>`;
}

function attentionFacts(group, section) {
  const c = group.counts || {};
  const facts = [];
  if (section === 'waiting') {
    if (c.blocked) facts.push(`${c.blocked} blocked ${c.blocked === 1 ? 'task' : 'tasks'}`);
    if (c.blockers) facts.push(`${c.blockers} ${c.blockers === 1 ? 'blocker' : 'blockers'}`);
  } else {
    if (c.open) facts.push(`${c.open} open`);
    if (c.doing) facts.push(`${c.doing} in progress`);
    if (c.blocked) facts.push(`${c.blocked} blocked`);
  }
  if (c.decisions) facts.push(`${c.decisions} ${c.decisions === 1 ? 'decision' : 'decisions'}`);
  if (group.freshEvidenceCount) facts.push(`${group.freshEvidenceCount} new evidence`);
  if (group.staleDays) facts.push(`quiet ${group.staleDays}d`);
  return facts.join(' · ');
}

function focusSelection(items, selectedId, keyOf) {
  return items.find(item => keyOf(item) === selectedId) || items[0] || null;
}

export function nextTodayFocusIndex(key, currentIndex, length) {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(length) || length < 1 || currentIndex < 0 || currentIndex >= length) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % length;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + length) % length;
  return null;
}

function focusBoard(section, items, selectedId, context, renderRail, renderDetail, keyOf) {
  const { esc, attr } = context;
  const selected = focusSelection(items, selectedId, keyOf);
  if (!selected) return '';
  const panelId = `today-${section}-detail`;
  const hasRail = items.length > 1;
  const selectedTabId = focusTabId(section, keyOf(selected));
  const rail = hasRail
    ? `<div class="today-focus-rail" role="tablist" aria-label="${esc(section)} projects">${items.map((item, index) => renderRail(item, index, keyOf(item) === keyOf(selected), panelId)).join('')}</div>`
    : '';
  const panelA11y = hasRail
    ? `role="tabpanel" aria-labelledby="${attr(selectedTabId)}"`
    : `role="region" aria-label="${esc(section)} project details"`;
  return `<section class="today-focus-board${hasRail ? '' : ' single'}" data-section="${attr(section)}">
    ${rail}
    <div class="today-focus-detail" id="${panelId}" ${panelA11y} tabindex="0">${renderDetail(selected)}</div>
  </section>`;
}

function attentionRailItem(group, index, selected, panelId, context, section) {
  const { icon, esc, attr, number } = context;
  const top = group.items?.[0]?.title || group.focus || 'Pinned project';
  const count = Number(group.counts?.total || 0);
  const tone = section === 'waiting' ? 'warn' : group.counts?.doing ? 'blue' : '';
  const pinLabel = group.projectPinned ? 'Project pinned' : group.pinned ? 'Pinned item' : '';
  return `<button class="today-focus-tab ${selected ? 'selected' : ''}${pinLabel ? ' has-pin' : ''}${group.projectPinned ? ' project-pinned' : ''}" id="${attr(focusTabId(section, group.projectId))}" type="button" role="tab" aria-selected="${selected}" aria-controls="${attr(panelId)}" tabindex="${selected ? '0' : '-1'}" data-action="today-focus" data-section="${attr(section)}" data-project="${attr(group.projectId)}">
    <span class="today-focus-tab-rank">${String(group.rank || index + 1).padStart(2, '0')}</span>
    <span class="today-focus-tab-copy"><strong>${esc(group.projectTitle)}</strong><span>${esc(top)}</span></span>
    <span class="today-focus-tab-count ${tone}">${number(count)}</span>
    ${pinLabel ? `<span class="today-focus-tab-pin-state">${icon('pin', 10)} ${esc(pinLabel)}</span>` : ''}
  </button>`;
}

function attentionDetail(group, context, section) {
  const { icon, esc, attr } = context;
  const items = Array.isArray(group.items) ? group.items : [];
  const projectDisabled = isPending(context, group.projectControlId) ? ' disabled' : '';
  const bulkDisabled = items.length === 0 || isPending(context, projectActionKey(section, group.projectId)) ? ' disabled' : '';
  const facts = attentionFacts(group, section);
  const sectionLabel = section === 'waiting' ? 'waiting items' : 'attention items';
  const eyebrow = section === 'waiting' ? `Waiting ${String(group.rank).padStart(2, '0')}` : `Priority ${String(group.rank).padStart(2, '0')}`;
  return `<header class="today-focus-detail-head">
      <span class="today-focus-detail-eyebrow">${esc(eyebrow)}</span>
      <div class="today-focus-detail-actions">
        ${items.length ? `<div class="today-focus-bulk-actions" role="group" aria-label="Current ${esc(sectionLabel)} controls">
          <button class="today-focus-bulk" type="button" data-action="today-project-snooze" data-section="${attr(section)}" data-project="${attr(group.projectId)}" title="Snooze all current ${attr(sectionLabel)} until tomorrow morning"${bulkDisabled}>${icon('clock', 12)} Snooze</button>
          <button class="today-focus-bulk danger" type="button" data-action="today-project-dismiss" data-section="${attr(section)}" data-project="${attr(group.projectId)}" title="Clear all current ${attr(sectionLabel)}"${bulkDisabled}>${icon('x', 12)} Clear current</button>
        </div>` : ''}
        ${projectPinControl(group.projectControlId, group.projectPinned, projectDisabled, context)}
        <a class="today-focus-open" href="#/projects/${encodeURIComponent(group.projectId)}">Open project ${icon('arrow-right', 12)}</a>
      </div>
      <h3 class="today-focus-detail-title"><a href="#/projects/${encodeURIComponent(group.projectId)}">${esc(group.projectTitle)}</a></h3>
      ${facts ? `<p class="today-focus-detail-facts">${esc(facts)}</p>` : ''}
    </header>
    ${items.length ? `<ol class="today-focus-lines">${items.map(item => attentionLine(item, context)).join('')}</ol>` : `<p class="today-focus-empty">${esc(group.focus || 'Pinned project')}</p>`}`;
}

function attentionFocusBoard(groups, selectedId, context, section) {
  return focusBoard(
    section,
    groups,
    selectedId,
    context,
    (group, index, selected, panelId) => attentionRailItem(group, index, selected, panelId, context, section),
    group => attentionDetail(group, context, section),
    group => group.projectId,
  );
}

function emptySection(iconName, title, copy, context) {
  const { icon, esc } = context;
  return `<div class="empty-state today-empty"><span class="source-icon">${icon(iconName, 18)}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`;
}

// Absolute timestamp for hover — relative time is the scanning default, the
// exact moment stays one hover away (activity-feed convention).
function absoluteTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(time));
}

// One evidence line: [kind icon] sentence / meta · time. The sentence is the
// item's gist; 'model' gists carry the sparkle so machine text is labeled as
// such, verbatim/excerpt lines are the source's own words (already quoted).
function changeEvidenceLine(line, item, context) {
  const { icon, esc, attr, relativeTime, sourceIcon } = context;
  const glyph = line.icon || sourceIcon(line.source, line.type);
  const machine = line.gistKind === 'model'
    ? `<span class="today-gist-glyph" title="Summarized by BotBoy from the source text" aria-label="Summarized by BotBoy">${icon('sparkles', 11)}</span>`
    : '';
  const open = line.url
    ? `<a class="today-evidence-open" href="${attr(line.url)}" target="_blank" rel="noopener noreferrer" title="Open the source" aria-label="Open the source in a new tab">${icon('globe', 12)}</a>`
    : '';
  return `<li class="today-evidence">
    <span class="today-evidence-icon" aria-hidden="true">${icon(glyph, 14)}</span>
    <a class="today-evidence-copy" href="#/projects/${encodeURIComponent(item.projectId)}">
      <span class="today-gist">${machine}${esc(line.gist)}</span>
      <span class="today-evidence-meta">${esc(line.meta)}</span>
    </a>
    <span class="today-evidence-side">${open}<time datetime="${attr(line.capturedAt)}" title="${attr(absoluteTime(line.capturedAt))}">${esc(relativeTime(line.capturedAt))}</time></span>
  </li>`;
}

// Changed-project card: the project is the HEADER (Gestalt common region —
// answers "which project" structurally), evidence lines nest under it, and
// the pin/snooze/dismiss controls stay at card level because they act on the
// project's change, not on one line. Plan: TODAY_CHANGES_PLAN.md §8.
function changeRailItem(item, index, selected, panelId, context) {
  const { icon, esc, attr, number, relativeTime } = context;
  const top = item.items?.[0]?.gist || item.title || 'New project evidence';
  return `<button class="today-focus-tab ${selected ? 'selected' : ''}${item.pinned ? ' has-pin project-pinned' : ''}" id="${attr(focusTabId('changes', item.projectId))}" type="button" role="tab" aria-selected="${selected}" aria-controls="${attr(panelId)}" tabindex="${selected ? '0' : '-1'}" data-action="today-focus" data-section="changes" data-project="${attr(item.projectId)}">
    <span class="today-focus-tab-pulse" aria-hidden="true"></span>
    <span class="today-focus-tab-copy"><strong>${esc(item.projectTitle)}</strong><span>${esc(top)}</span></span>
    <span class="today-focus-tab-count blue">${number(item.count)}</span>
    <span class="today-focus-tab-trailing">${item.pinned ? `<span class="today-focus-tab-pin-state">${icon('pin', 10)} Project pinned</span>` : ''}<time>${esc(relativeTime(item.capturedAt))}</time></span>
  </button>`;
}

function changeDetail(item, context) {
  const { icon, esc, attr, number, relativeTime } = context;
  const changeDisabled = isPending(context, item.id) ? ' disabled' : '';
  const projectDisabled = isPending(context, item.projectControlId) ? ' disabled' : '';
  const changeVersion = Number.isSafeInteger(Number(item.version)) ? ` data-version="${attr(item.version)}"` : '';
  const lines = Array.isArray(item.items) && item.items.length
    ? item.items
    : [{ gist: item.title, meta: item.summary, gistKind: 'excerpt', source: item.source, type: item.type, capturedAt: item.capturedAt }];
  const hidden = Number(item.hiddenCount) > 0
    ? `<a class="today-focus-more" href="#/projects/${encodeURIComponent(item.projectId)}">View ${number(item.hiddenCount)} more changes ${icon('arrow-right', 12)}</a>`
    : '';
  return `<header class="today-focus-detail-head">
      <span class="today-focus-detail-eyebrow">${number(item.count)} new · latest ${esc(relativeTime(item.capturedAt))}</span>
      <div class="today-focus-detail-actions">
        ${projectPinControl(item.projectControlId, item.pinned, projectDisabled, context)}
        <button class="today-control" type="button" data-action="today-snooze" data-item="${attr(item.id)}"${changeVersion} title="Snooze this change until tomorrow" aria-label="Snooze this change until tomorrow"${changeDisabled}>${icon('clock', 14)}</button>
        <button class="today-control" type="button" data-action="today-dismiss" data-item="${attr(item.id)}"${changeVersion} title="Dismiss this change" aria-label="Dismiss this change"${changeDisabled}>${icon('x', 14)}</button>
        <a class="today-focus-open" href="#/projects/${encodeURIComponent(item.projectId)}">Open project ${icon('arrow-right', 12)}</a>
      </div>
      <h3 class="today-focus-detail-title"><a href="#/projects/${encodeURIComponent(item.projectId)}">${esc(item.projectTitle)}</a></h3>
      <p class="today-focus-detail-facts">What changed in this project since this Today window opened.</p>
    </header>
    <ul class="today-focus-evidence">${lines.map(line => changeEvidenceLine(line, item, context)).join('')}</ul>
    ${hidden}`;
}

function changeFocusBoard(changes, selectedId, context) {
  return focusBoard(
    'changes',
    changes,
    selectedId,
    context,
    (item, index, selected, panelId) => changeRailItem(item, index, selected, panelId, context),
    item => changeDetail(item, context),
    item => item.projectId,
  );
}

// Unicode-safe base64url — MUST match dashboard.js › encodeDocKey (the
// reader route decodes with the same alphabet).
function docKeyToReaderHash(docKey) {
  if (!docKey) return '';
  try {
    return `#/doc/${btoa(unescape(encodeURIComponent(String(docKey)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  } catch { return ''; }
}

function awaitingReplyRow(item, context) {
  const { icon, esc, relativeTime } = context;
  const projectLink = item.projectId
    ? `<a class="today-project" href="#/projects/${encodeURIComponent(item.projectId)}">${esc(item.projectTitle || 'project')}</a>`
    : '';
  // Two explicit destinations (owner ask 2026-08-25): the staged doc inside
  // BotBoy (reader — shows thread, anchors, staged edits) and the live doc
  // on SharePoint. Row click goes in-app; SharePoint is the escape hatch.
  const readerHash = docKeyToReaderHash(item.docKey);
  const copyBody = `
      <strong>${esc(item.author)} on ${esc(item.docTitle)}</strong>
      ${item.snippet ? `<span class="today-change-summary">${esc(item.snippet)}</span>` : ''}
      <span class="today-reason"><b>Why here</b> latest comment in a thread you're part of — no reply from you yet</span>`;
  return `<article class="today-item awaiting-reply-row">
    <span class="source-icon">${icon('message', 15)}</span>
    ${readerHash
      ? `<a class="today-item-copy" href="${esc(readerHash)}">${copyBody}</a>`
      : `<a class="today-item-copy" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${copyBody}</a>`}
    <div class="today-item-side">
      <div class="today-change-meta">${projectLink}<span class="pill">${item.threadSize} in thread</span><time>${esc(relativeTime(item.commentedAt))}</time></div>
      <div class="awaiting-reply-actions">
        ${readerHash ? `<a class="button small" href="${esc(readerHash)}">${icon('file', 12)} Open in BotBoy</a>` : ''}
        ${item.url ? `<a class="button small ghost" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${icon('globe', 12)} SharePoint</a>` : ''}
      </div>
    </div>
  </article>`;
}

export function groupTodayDeferredItems(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const existing = groups.get(item.projectId) || {
      projectId: item.projectId,
      projectTitle: item.projectTitle,
      items: [],
    };
    existing.items.push(item);
    groups.set(item.projectId, existing);
  }
  return [...groups.values()].map(group => {
    const newest = group.items.reduce((latest, item) => {
      if (!latest) return item;
      return Date.parse(item.preferenceUpdatedAt) > Date.parse(latest.preferenceUpdatedAt) ? item : latest;
    }, null);
    return {
      ...group,
      count: group.items.length,
      snoozedCount: group.items.filter(item => item.snoozedUntil && !item.dismissedAt).length,
      dismissedCount: group.items.filter(item => item.dismissedAt).length,
      newest,
      newestState: newest?.dismissedAt ? 'Dismissed' : newest?.snoozedUntil ? 'Snoozed' : 'Set aside',
    };
  });
}

function deferredRow(item, context, groupPending = false) {
  const { icon, esc, attr } = context;
  const disabled = isPending(context, item.id) || groupPending ? ' disabled' : '';
  const changeVersion = item.kind === 'change' && Number.isSafeInteger(Number(item.version))
    ? ` data-version="${attr(item.version)}"`
    : '';
  return `<article class="deferred-row${item.pinned ? ' pinned' : ''}">
    <span class="source-icon">${icon(item.kind === 'change' ? 'activity' : item.kind === 'blocker' ? 'alert' : 'clock', 13)}</span>
    <a class="today-item-copy" href="#/projects/${encodeURIComponent(item.projectId)}"><strong>${esc(item.title)}</strong><span class="today-reason">${esc(item.deferredReason)}${item.pinned ? ' · Pinned' : ''}</span></a>
    <button class="button small" type="button" data-action="today-restore" data-item="${attr(item.id)}"${changeVersion}${disabled}>Restore</button>
  </article>`;
}

function deferredGroup(group, selected, context) {
  const { icon, esc, attr, number, relativeTime } = context;
  const panelId = `today-deferred-${group.projectId}`;
  const pendingKey = projectActionKey('deferred', group.projectId);
  const pending = isPending(context, pendingKey);
  const breakdown = [
    group.snoozedCount ? `${number(group.snoozedCount)} snoozed` : '',
    group.dismissedCount ? `${number(group.dismissedCount)} dismissed` : '',
  ].filter(Boolean).join(' · ') || 'recoverable';
  const newest = group.newest
    ? `${group.newestState} ${relativeTime(group.newest.preferenceUpdatedAt)}`
    : 'Set aside';
  return `<article class="today-deferred-project${selected ? ' selected' : ''}">
    <button class="today-deferred-summary" type="button" data-action="today-deferred-focus" data-project="${attr(group.projectId)}" aria-expanded="${selected}" aria-controls="${attr(panelId)}">
      <span class="source-icon">${icon('folder', 14)}</span>
      <span class="today-deferred-copy"><strong>${esc(group.projectTitle)}</strong><span>${esc(`${breakdown} · newest: ${newest}`)}</span></span>
      <span class="today-deferred-count">${number(group.count)}</span>
      <span class="today-deferred-chevron" aria-hidden="true">${icon('chevron-right', 12)}</span>
    </button>
    ${selected ? `<div class="today-deferred-body" id="${attr(panelId)}">
      <div class="today-deferred-toolbar"><span>Current recoverable items in this project</span><button class="button small" type="button" data-action="today-project-restore" data-section="deferred" data-project="${attr(group.projectId)}" title="Restore all current Set aside items in this project"${pending ? ' disabled' : ''}>${icon('refresh', 12)} Restore project</button></div>
      <div class="today-deferred-items">${group.items.map(item => deferredRow(item, context, pending)).join('')}</div>
    </div>` : ''}
  </article>`;
}

function recentRow(project, context) {
  const { icon, esc, attr, number, relativeTime } = context;
  const disabled = isPending(context, project.controlId) ? ' disabled' : '';
  return `<article class="activity-row today-activity-row">
    <span class="source-icon">${icon('sparkles', 15)}</span>
    <a class="activity-copy" href="#/projects/${encodeURIComponent(project.id)}"><strong>${esc(project.title)}</strong><span>${esc(project.oneLiner)}</span></a>
    <span class="recent-meta"><time>${esc(relativeTime(project.updatedAt))}</time><small>${number(project.itemCount)} evidence</small></span>
    <button class="today-control ${project.pinned ? 'active' : ''}" type="button" data-action="today-pin" data-item="${attr(project.controlId)}" data-pinned="${project.pinned}" aria-pressed="${project.pinned}" title="${project.pinned ? 'Unpin project' : 'Pin project to Today'}" aria-label="${project.pinned ? 'Unpin project' : 'Pin project to Today'}"${disabled}>${icon('pin', 14)}</button>
  </article>`;
}

function countLabel(shown, total, number, noun) {
  return Number(total) > Number(shown) ? `Showing ${number(shown)} of ${number(total)} ${noun}` : `${number(total)} ${noun}`;
}

// "12 of 26 tasks · 6 of 9 projects" — the section pill counts BOTH units now
// that cards are per project.
function groupCountLabel(summary, number, noun, keys) {
  const [shown, total, projShown, projTotal] = keys.map(key => Number(summary[key] || 0));
  const items = total > shown ? `${number(shown)} of ${number(total)} ${noun}` : `${number(total)} ${noun}`;
  const projects = projTotal > projShown ? `${number(projShown)} of ${number(projTotal)} projects` : `${number(projTotal)} ${projTotal === 1 ? 'project' : 'projects'}`;
  return `${items} · ${projects}`;
}

export function renderTodayView(context) {
  const { data, error, health, inbox, pageHead, icon, esc, number, relativeTime } = context;
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  if (!data) {
    return `${pageHead(date, 'Today', 'Explicit work, blockers, and meaningful changes—not background write recency.', `<button class="button" type="button" data-action="today-refresh">${icon('refresh')} Retry</button>`)}<section class="card error-state"><span class="source-icon">${icon(error ? 'alert' : 'clock', 19)}</span><h2>${error ? 'Today could not be ranked' : 'Ranking your current work'}</h2><p>${esc(error || 'BotBoy is reading the active project brains and evidence changes.')}</p></section>`;
  }

  const summary = data.summary || {};
  const attention = Array.isArray(data.attention) ? data.attention : [];
  const waiting = Array.isArray(data.waiting) ? data.waiting : [];
  const attentionGroups = Array.isArray(data.attentionGroups) ? data.attentionGroups : [];
  const waitingGroups = Array.isArray(data.waitingGroups) ? data.waitingGroups : [];
  const awaitingReply = Array.isArray(data.awaitingReply) ? data.awaitingReply : [];
  const changes = Array.isArray(data.changes) ? data.changes : [];
  const focus = context.focus || {};
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const deferred = Array.isArray(data.deferred) ? data.deferred : [];
  const deferredGroups = groupTodayDeferredItems(deferred);
  const lead = attention[0];
  const explicitActions = Number(summary.explicitActionCount || 0);
  const pinnedProjects = Number(summary.pinnedProjectCount || 0);
  const headline = explicitActions
    ? `${number(explicitActions)} explicit ${explicitActions === 1 ? 'action needs' : 'actions need'} your attention.`
    : pinnedProjects
      ? `${number(pinnedProjects)} pinned ${pinnedProjects === 1 ? 'project is' : 'projects are'} being held in view.`
      : waiting.length
        ? 'No open action outranks the work that is currently blocked.'
        : 'No explicit action needs your attention right now.';
  const description = lead
    ? `Start with ${lead.projectTitle}: ${lead.title}`
    : waiting[0]
      ? `${number(summary.waitingCount)} blocked or waiting ${Number(summary.waitingCount) === 1 ? 'item is' : 'items are'} recorded for review.`
      : 'BotBoy found no eligible commitment, blocker, or pinned project. Recent synthesis remains available below.';
  const changeWindow = data.sinceLabel === 'last_visit' ? `Since your last visit · ${relativeTime(data.since)}` : 'First visit window · past 24 hours';
  const unresolvedFailures = Number(health?.totalFailures || 0);
  const incomplete = Number(health?.incompleteItems || 0);
  const unassigned = inbox?.count == null ? null : Number(inbox.count);

  return `${pageHead(date, 'Good morning', 'Your explicit actions first, blocked work second, and meaningful evidence changes after that.', `<button class="button" type="button" data-action="open-command">${icon('search')} Find anything</button><button class="button primary" type="button" data-action="plan-day">${icon('sparkles')} Plan my day</button>`)}
    <section class="grid overview-grid" aria-label="Daily overview">
      <article class="card briefing-card"><div class="briefing-label">${icon('sparkles')} BotBoy attention brief</div><h2>${esc(headline)}</h2><p>${esc(description)}</p><div class="briefing-actions">${lead ? `<a class="button primary" href="#/projects/${encodeURIComponent(lead.projectId)}">Open first action ${icon('arrow-right', 14)}</a>` : ''}<button class="button" type="button" data-action="plan-day">Show local plan</button></div><div class="briefing-foot">${icon('shield', 12)} Ranked from explicit tasks, task state, decision language, and your pins</div></article>
      <article class="card metrics-card"><button class="metric" type="button" data-action="today-jump" data-target="today-attention" aria-label="Jump to the Needs your attention section"><div class="metric-label">${icon('check', 14)} Needs attention</div><div class="metric-value">${number(summary.attentionCount)}</div><div class="metric-note good">${number(explicitActions)} tasks across ${number(summary.attentionProjects || 0)} ${Number(summary.attentionProjects) === 1 ? 'project' : 'projects'}${pinnedProjects ? ` · ${number(pinnedProjects)} pinned` : ''}</div></button><button class="metric" type="button" data-action="today-jump" data-target="today-waiting" aria-label="Jump to the Waiting / blocked section"><div class="metric-label">${icon('alert', 14)} Waiting / blocked</div><div class="metric-value">${number(summary.waitingCount)}</div><div class="metric-note warn">across ${number(summary.waitingProjects || 0)} ${Number(summary.waitingProjects) === 1 ? 'project' : 'projects'} · ownership not inferred</div></button><button class="metric" type="button" data-action="today-jump" data-target="today-changes" aria-label="Jump to the Meaningful changes section"><div class="metric-label">${icon('activity', 14)} Meaningful changes</div><div class="metric-value">${number(summary.changeCount)}</div><div class="metric-note">${esc(changeWindow)}</div></button><button class="metric" type="button" data-action="today-jump" data-target="today-attention" aria-label="Jump to pinned items — they lead the Needs your attention section"><div class="metric-label">${icon('pin', 14)} Pinned</div><div class="metric-value">${number(summary.pinnedCount)}</div><div class="metric-note">All current pins stay visible</div></button></article>
    </section>

    ${awaitingReply.length ? `<div class="section-heading"><div><h2>Awaiting your reply</h2><p>Document comment threads where the latest word is someone else's. Replying (via chat or SharePoint) clears them on the next sync.</p></div><span class="pill warn">${number(summary.awaitingReplyCount || awaitingReply.length)} thread${(summary.awaitingReplyCount || awaitingReply.length) === 1 ? '' : 's'}</span></div>
    <section class="card today-list">${awaitingReply.map(item => awaitingReplyRow(item, context)).join('')}</section>` : ''}

    <div class="section-heading" id="today-attention"><div><h2>Needs your attention</h2><p>Projects ranked by explicit commitment state and decision language. Select a project to work every current action.</p></div><span class="today-section-count">${esc(groupCountLabel(summary, number, 'tasks', ['attentionShown', 'attentionCount', 'attentionProjectsShown', 'attentionProjects']))}</span></div>
    ${attentionGroups.length ? attentionFocusBoard(attentionGroups, focus.attention, context, 'attention') : `<section class="card today-list">${emptySection('check', 'Nothing explicitly actionable', 'Projects with generic active status or no next action are intentionally excluded.', context)}</section>`}

    <div class="section-heading" id="today-waiting"><div><h2>Waiting / blocked</h2><p>Recorded blockers by project. Select one to review the dependency and the next move.</p></div><span class="today-section-count warn">${esc(groupCountLabel(summary, number, 'blocked items', ['waitingShown', 'waitingCount', 'waitingProjectsShown', 'waitingProjects']))}</span></div>
    ${waitingGroups.length ? attentionFocusBoard(waitingGroups, focus.waiting, context, 'waiting') : `<section class="card today-list">${emptySection('check', 'No blocked work recorded', 'No active project brain currently contains a blocked task or blocker.', context)}</section>`}

    <div class="section-heading" id="today-changes"><div><h2>Meaningful changes</h2><p>${esc(changeWindow)}. Select a project to read what actually moved.</p></div><span class="today-section-count blue">${esc(countLabel(summary.changesShown, summary.changeCount, number, 'changed projects'))}</span></div>
    ${changes.length ? changeFocusBoard(changes, focus.changes, context) : `<section class="card today-list">${emptySection('activity', 'No substantive evidence changes', 'There is no qualifying new project evidence in this visit window.', context)}</section>`}

    ${deferred.length ? `<div class="section-heading" id="today-set-aside" tabindex="-1"><div><h2>Set aside</h2><p>Compact recovery groups for snoozed and dismissed work. Expand a project to restore individual items or its current group.</p></div><span class="pill">${esc(countLabel(summary.deferredShown, summary.deferredCount, number, 'items'))} · ${number(deferredGroups.length)} ${deferredGroups.length === 1 ? 'project' : 'projects'}</span></div><section class="card deferred-list">${deferredGroups.map(group => deferredGroup(group, context.deferredProject === group.projectId, context)).join('')}</section>` : ''}

    <div class="section-heading"><div><h2>Recently synthesized</h2><p>Active project brains ordered by synthesis time. This is activity, not priority.</p></div></div>
    <section class="card activity-list">${recent.length ? recent.map(project => recentRow(project, context)).join('') : emptySection('sparkles', 'No active project brains', 'Recent synthesis appears after active project brains are available.', context)}</section>

    <section class="system-strip" aria-label="System health"><span>${icon('activity', 14)} System</span><a href="#/inbox"><strong>${unassigned == null ? '—' : number(unassigned)}</strong> unassigned evidence</a><a href="#/pipeline" class="${unresolvedFailures ? 'warn' : ''}"><strong>${number(unresolvedFailures)}</strong> unresolved failures</a><a href="#/pipeline" class="${incomplete ? 'warn' : ''}"><strong>${number(incomplete)}</strong> incomplete captures</a><span class="system-strip-note">Operational backlog is kept separate from daily priority.</span></section>`;
}
