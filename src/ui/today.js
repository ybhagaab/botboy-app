function isPending(context, itemId) {
  return context.pending instanceof Set && context.pending.has(itemId);
}

function attentionControls(item, context) {
  const { icon, attr } = context;
  const disabled = isPending(context, item.id) ? ' disabled' : '';
  const markDone = item.kind === 'task'
    ? `<button class="today-control" type="button" data-action="today-done" data-item="${attr(item.id)}" title="Mark done in the project brain" aria-label="Mark task done in the project brain"${disabled}>${icon('check', 14)}</button>`
    : '';
  return `<div class="today-item-actions" role="group" aria-label="Item controls">
    ${markDone}
    <button class="today-control ${item.pinned ? 'active' : ''}" type="button" data-action="today-pin" data-item="${attr(item.id)}" data-pinned="${item.pinned}" aria-pressed="${item.pinned}" title="${item.pinned ? 'Unpin' : 'Pin to the top'}" aria-label="${item.pinned ? 'Unpin item' : 'Pin item to the top'}"${disabled}>${icon('pin', 14)}</button>
    <button class="today-control" type="button" data-action="today-snooze" data-item="${attr(item.id)}" title="Snooze until tomorrow morning" aria-label="Snooze item until tomorrow morning"${disabled}>${icon('clock', 14)}</button>
    <button class="today-control" type="button" data-action="today-dismiss" data-item="${attr(item.id)}" title="Dismiss" aria-label="Dismiss item"${disabled}>${icon('x', 14)}</button>
  </div>`;
}

function attentionRow(item, index, context) {
  const { icon, esc } = context;
  const stateLabel = item.kind === 'project' ? 'Pinned project' : item.state === 'doing' ? 'In progress' : item.state === 'blocked' ? 'Blocked' : 'Open task';
  const tone = item.pinned ? 'accent' : item.state === 'blocked' ? 'warn' : item.state === 'doing' ? 'blue' : '';
  return `<article class="today-item ${item.pinned ? 'pinned' : ''}">
    <span class="today-rank">${String(index + 1).padStart(2, '0')}</span>
    <a class="today-item-copy" href="#/projects/${encodeURIComponent(item.projectId)}">
      <strong>${esc(item.title)}</strong>
      <span class="today-project">${esc(item.projectTitle)}</span>
      <span class="today-reason"><b>Why here</b> ${esc(item.reason)}</span>
    </a>
    <div class="today-item-side"><span class="pill ${tone}">${item.pinned ? `${icon('pin', 11)} ` : ''}${esc(stateLabel)}</span>${attentionControls(item, context)}</div>
  </article>`;
}

function emptySection(iconName, title, copy, context) {
  const { icon, esc } = context;
  return `<div class="empty-state today-empty"><span class="source-icon">${icon(iconName, 18)}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`;
}

function changeRow(item, context) {
  const { icon, esc, attr, relativeTime, sourceIcon } = context;
  const changeDisabled = isPending(context, item.id) ? ' disabled' : '';
  const projectDisabled = isPending(context, item.projectControlId) ? ' disabled' : '';
  const changeVersion = Number.isSafeInteger(Number(item.version)) ? ` data-version="${attr(item.version)}"` : '';
  return `<article class="today-change-row">
    <span class="source-icon">${icon(sourceIcon(item.source, item.type), 15)}</span>
    <a class="today-item-copy" href="#/projects/${encodeURIComponent(item.projectId)}">
      <strong>${esc(item.title)}</strong>
      <span class="today-project">${esc(item.projectTitle)}</span>
      ${item.summary ? `<span class="today-change-summary">${esc(item.summary)}</span>` : ''}
      <span class="today-reason"><b>Why here</b> ${esc(item.reason)}</span>
    </a>
    <div class="today-change-meta"><span class="pill blue">${item.count} new</span><time>${esc(relativeTime(item.capturedAt))}</time></div>
    <div class="today-item-actions" role="group" aria-label="Change controls">
      <button class="today-control ${item.pinned ? 'active' : ''}" type="button" data-action="today-pin" data-item="${attr(item.projectControlId)}" data-pinned="${item.pinned}" aria-pressed="${item.pinned}" title="${item.pinned ? 'Unpin project' : 'Pin project to Today'}" aria-label="${item.pinned ? 'Unpin project' : 'Pin project to Today'}"${projectDisabled}>${icon('pin', 14)}</button>
      <button class="today-control" type="button" data-action="today-snooze" data-item="${attr(item.id)}"${changeVersion} title="Snooze this change until tomorrow" aria-label="Snooze this change until tomorrow"${changeDisabled}>${icon('clock', 14)}</button>
      <button class="today-control" type="button" data-action="today-dismiss" data-item="${attr(item.id)}"${changeVersion} title="Dismiss this change" aria-label="Dismiss this change"${changeDisabled}>${icon('x', 14)}</button>
    </div>
  </article>`;
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

function deferredRow(item, context) {
  const { icon, esc, attr } = context;
  const disabled = isPending(context, item.id) ? ' disabled' : '';
  const changeVersion = item.kind === 'change' && Number.isSafeInteger(Number(item.version))
    ? ` data-version="${attr(item.version)}"`
    : '';
  return `<article class="deferred-row">
    <span class="source-icon">${icon(item.kind === 'change' ? 'activity' : item.kind === 'blocker' ? 'alert' : 'clock', 15)}</span>
    <a class="today-item-copy" href="#/projects/${encodeURIComponent(item.projectId)}"><strong>${esc(item.title)}</strong><span class="today-project">${esc(item.projectTitle)}</span><span class="today-reason">${esc(item.deferredReason)}</span></a>
    <button class="button small" type="button" data-action="today-restore" data-item="${attr(item.id)}"${changeVersion}${disabled}>Restore</button>
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

export function renderTodayView(context) {
  const { data, error, health, inbox, pageHead, icon, esc, number, relativeTime } = context;
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  if (!data) {
    return `${pageHead(date, 'Today', 'Explicit work, blockers, and meaningful changes—not background write recency.', `<button class="button" type="button" data-action="today-refresh">${icon('refresh')} Retry</button>`)}<section class="card error-state"><span class="source-icon">${icon(error ? 'alert' : 'clock', 19)}</span><h2>${error ? 'Today could not be ranked' : 'Ranking your current work'}</h2><p>${esc(error || 'BotBoy is reading the active project brains and evidence changes.')}</p></section>`;
  }

  const summary = data.summary || {};
  const attention = Array.isArray(data.attention) ? data.attention : [];
  const waiting = Array.isArray(data.waiting) ? data.waiting : [];
  const awaitingReply = Array.isArray(data.awaitingReply) ? data.awaitingReply : [];
  const changes = Array.isArray(data.changes) ? data.changes : [];
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const deferred = Array.isArray(data.deferred) ? data.deferred : [];
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
    ? `${lead.title} — ${lead.reason}`
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
      <article class="card metrics-card"><div class="metric"><div class="metric-label">${icon('check', 14)} Needs attention</div><div class="metric-value">${number(summary.attentionCount)}</div><div class="metric-note good">${number(explicitActions)} tasks · ${number(pinnedProjects)} pinned projects</div></div><div class="metric"><div class="metric-label">${icon('alert', 14)} Waiting / blocked</div><div class="metric-value">${number(summary.waitingCount)}</div><div class="metric-note warn">Ownership not inferred</div></div><div class="metric"><div class="metric-label">${icon('activity', 14)} Meaningful changes</div><div class="metric-value">${number(summary.changeCount)}</div><div class="metric-note">${esc(changeWindow)}</div></div><div class="metric"><div class="metric-label">${icon('pin', 14)} Pinned</div><div class="metric-value">${number(summary.pinnedCount)}</div><div class="metric-note">All current pins stay visible</div></div></article>
    </section>

    ${awaitingReply.length ? `<div class="section-heading"><div><h2>Awaiting your reply</h2><p>Document comment threads where the latest word is someone else's. Replying (via chat or SharePoint) clears them on the next sync.</p></div><span class="pill warn">${number(summary.awaitingReplyCount || awaitingReply.length)} thread${(summary.awaitingReplyCount || awaitingReply.length) === 1 ? '' : 's'}</span></div>
    <section class="card today-list">${awaitingReply.map(item => awaitingReplyRow(item, context)).join('')}</section>` : ''}

    <div class="section-heading"><div><h2>Needs your attention</h2><p>Pinned items first, then task state and decision/response language; substantive evidence only breaks ties.</p></div><span class="pill accent">${esc(countLabel(summary.attentionShown, summary.attentionCount, number, 'eligible'))}</span></div>
    <section class="card today-list">${attention.length ? attention.map((item, index) => attentionRow(item, index, context)).join('') : emptySection('check', 'Nothing explicitly actionable', 'Projects with generic active status or no next action are intentionally excluded.', context)}</section>

    <div class="section-heading"><div><h2>Waiting / blocked</h2><p>Recorded blocked tasks and blockers. BotBoy does not guess who owns the next move.</p></div><span class="pill warn">${esc(countLabel(summary.waitingShown, summary.waitingCount, number, 'recorded'))}</span></div>
    <section class="card today-list">${waiting.length ? waiting.map((item, index) => attentionRow(item, index, context)).join('') : emptySection('check', 'No blocked work recorded', 'No active project brain currently contains a blocked task or blocker.', context)}</section>

    <div class="section-heading"><div><h2>Meaningful changes</h2><p>${esc(changeWindow)}. Passive app activity, noise, incomplete captures, and lightweight browsing are excluded.</p></div><span class="pill blue">${esc(countLabel(summary.changesShown, summary.changeCount, number, 'changed projects'))}</span></div>
    <section class="card today-changes">${changes.length ? changes.map(item => changeRow(item, context)).join('') : emptySection('activity', 'No substantive evidence changes', 'There is no qualifying new project evidence in this visit window.', context)}</section>

    ${deferred.length ? `<div class="section-heading"><div><h2>Set aside</h2><p>Snoozed and dismissed items remain recoverable here.</p></div><span class="pill">${esc(countLabel(summary.deferredShown, summary.deferredCount, number, 'deferred'))}</span></div><section class="card deferred-list">${deferred.map(item => deferredRow(item, context)).join('')}</section>` : ''}

    <div class="section-heading"><div><h2>Recently synthesized</h2><p>Active project brains ordered by synthesis time. This is activity, not priority.</p></div></div>
    <section class="card activity-list">${recent.length ? recent.map(project => recentRow(project, context)).join('') : emptySection('sparkles', 'No active project brains', 'Recent synthesis appears after active project brains are available.', context)}</section>

    <section class="system-strip" aria-label="System health"><span>${icon('activity', 14)} System</span><a href="#/inbox"><strong>${unassigned == null ? '—' : number(unassigned)}</strong> unassigned evidence</a><a href="#/pipeline" class="${unresolvedFailures ? 'warn' : ''}"><strong>${number(unresolvedFailures)}</strong> unresolved failures</a><a href="#/pipeline" class="${incomplete ? 'warn' : ''}"><strong>${number(incomplete)}</strong> incomplete captures</a><span class="system-strip-note">Operational backlog is kept separate from daily priority.</span></section>`;
}
