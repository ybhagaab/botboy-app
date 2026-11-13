/**
 * Chat notices in the panel (MIDWAY_NOTICES_PLAN.md §6, docs/maps/chat-notices.md).
 *
 * BotBoy's own status rows (a sign-in problem, a connection not responding, a terminal that ended, a part of the app that did
 * not start, a dashboard refresh that failed, a turn that failed or stopped) are drawn as one small line each: a status dot, a
 * few words, labels, the time and a chevron. The next step, the details and the timeline open on a click. Consecutive notices
 * about one thing fold into one line; a problem that was fixed later reads as fixed and loses its button.
 *
 * Rows written since the notices carry `notice` (src/core/chat-notices.ts). Older rows and the chat route's fixed failure and
 * stop texts are recognised here by their exact shapes (legacyNotice), so nothing is guessed from free text. Everything is
 * escaped here; Markdown details go through app.js's safe renderer (deps.markdown).
 */
(function () {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const STATES = new Set(['open', 'resolved', 'info']);
  const SEVERITIES = new Set(['error', 'warning', 'info', 'success']);
  const IN_APP_ROUTE = /^#\/[A-Za-z0-9._~%=?&:+\/-]{1,200}$/;
  const CARD_MARKER = /\[\[[a-z-]+:[^\]]+\]\]/;
  const deps = { apiBase: '/api', markdown: null, afterReauth: null };
  /** Groups the owner opened, by the group's first row id; kept across repaints. */
  const expanded = new Set();
  /** The rows of each group drawn in the main transcript, so a group can take a new row or be marked fixed in place. */
  const drawn = new Map();
  /** What pressing Re-authenticate did, shown under its notice for a few minutes (it survives a repaint). */
  const actionNotes = new Map();
  const ACTION_NOTE_MS = 5 * 60_000;

  const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();

  /** A structured notice from the server, checked again here (the panel trusts no row). */
  function clean(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = oneLine(raw.title, 80);
    if (!title || !STATES.has(raw.state) || !SEVERITIES.has(raw.severity)) return null;
    const labels = Array.isArray(raw.labels) ? [...new Set(raw.labels.map(label => oneLine(label, 40)).filter(Boolean))].slice(0, 6) : [];
    let action = null;
    if (raw.action && typeof raw.action === 'object') {
      const label = oneLine(raw.action.label, 32);
      if (label && raw.action.kind === 'midway_reauth') action = { kind: 'midway_reauth', label };
      else if (label && raw.action.kind === 'open_route' && IN_APP_ROUTE.test(String(raw.action.route || ''))) action = { kind: 'open_route', label, route: String(raw.action.route) };
    }
    const topic = typeof raw.topic === 'string' && raw.topic ? raw.topic.slice(0, 40) : 'notice';
    return {
      key: typeof raw.key === 'string' && raw.key ? raw.key.slice(0, 120) : topic,
      topic,
      state: raw.state,
      severity: raw.severity,
      title,
      labels,
      next: oneLine(raw.next, 240),
      detail: typeof raw.detail === 'string' ? raw.detail.slice(0, 8000) : '',
      detailMarkdown: raw.detailMarkdown === true,
      action,
    };
  }

  const CONNECTIONS = [[/GRASP|Microsoft 365|Outlook/, 'GRASP'], [/Slack/, 'Slack'], [/SharePoint/, 'SharePoint'], [/Datanet/, 'Datanet']];
  const connectionsIn = (text) => CONNECTIONS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
  /** A short label for a failure reason: the HTTP status, a timeout, or the network. */
  function reasonLabel(reason) {
    const status = /\b(?:HTTP|status)\s*(\d{3})\b/i.exec(reason);
    if (status) return `HTTP ${status[1]}`;
    if (/timed? ?out|timeout/i.test(reason)) return 'Timed out';
    if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(reason)) return 'Network';
    return '';
  }
  /** The fixed closing sentences of chat.ts's turn-failure texts, and what each one asks of the owner. */
  const TURN_TAILS = [
    ['Any file edits or runs I completed before the failure are still in place. Please resend your message to continue.', 'Resend your message to continue.'],
    ['Any file edits or runs I completed are in place, and the work carries on as a job by itself.', 'The work carries on as a job by itself.'],
    ['Work completed before the failure is in place, and the job tries again by itself.', 'The job tries again by itself.'],
    ['Work completed before the failure is in place.', 'Work done before the failure is kept.'],
  ];
  /** chat.ts's fixed stop and pause texts (and the older wording of the first). */
  const STOPS = [
    [/^⏹\uFE0F?\s*Stopped at your request\./, 'Stopped', 'Work done so far is kept. Tell me when to continue.'],
    [/^⏹\uFE0F?\s*Stopped because the AI model was changed in Settings\./, 'Stopped: AI model changed', 'Send your message again to continue on the new model.'],
    [/^⏹\uFE0F?\s*Stopped: you ended this job\./, 'Job stopped', 'Work already done is kept.'],
    [/^⏸\uFE0F?\s*Paused: you paused this job\./, 'Job paused', 'Resume it from the job menu, or reply here.'],
    [/^↻ Paused this automatic continuation because you sent a message\./, 'Automatic turn paused', 'The job continues from your message.'],
  ];
  const notice = (fields) => ({ labels: [], next: '', detail: '', detailMarkdown: false, action: null, ...fields });

  /**
   * Rows from before the notices, and the chat route's fixed texts, by their exact shapes. A row that holds a card marker is
   * never a notice (the card must stay); a long Markdown reply is never mistaken for one.
   */
  function legacyNotice(content) {
    let text = String(content || '').trim();
    if (!text) return null;
    const dashboard = /^🔎 \*\*Dashboard refresh diagnostics\*\* — "([^"\n]{1,160})": (\d+) widget\(s\) still failed after the cross-lane retry\.([\s\S]*)$/.exec(text);
    if (dashboard) {
      const count = Number(dashboard[2]);
      return notice({
        key: `dashboard:${dashboard[1]}`, topic: 'dashboard-refresh', state: 'open', severity: 'error', title: 'Dashboard refresh failed',
        labels: [dashboard[1], `${count} widget${count === 1 ? '' : 's'}`], detail: dashboard[3].trim(), detailMarkdown: true,
      });
    }
    if (CARD_MARKER.test(text) || text.length > 1500) return null;
    let note = '';
    const noted = /^(↻ Continued automatically[^\n]*)\n\n([\s\S]+)$/.exec(text);
    if (noted) { note = noted[1]; text = noted[2].trim(); }
    const turn = /^⚠\uFE0F?\s*This (automatic )?turn failed before I could finish: ([\s\S]+)$/.exec(text);
    if (turn) {
      let reason = turn[2];
      let next = 'Resend your message to continue.';
      for (const [tail, ask] of TURN_TAILS) {
        if (reason.endsWith(tail)) { reason = reason.slice(0, -tail.length).replace(/\.\s*$/, '').trim(); next = ask; break; }
      }
      const label = reasonLabel(reason);
      return notice({
        key: 'turn-failed', topic: 'turn', state: 'info', severity: 'error', title: turn[1] ? 'Automatic turn failed' : 'This turn failed',
        labels: label ? [label] : [], next, detail: [note, reason].filter(Boolean).join('\n'),
      });
    }
    if (/^⏳ The AI provider asked BotBoy to slow down\./.test(text)) {
      return notice({ key: 'provider', topic: 'turn', state: 'info', severity: 'info', title: 'AI provider busy', next: 'This work waits its turn and carries on by itself.', detail: note });
    }
    // chat.ts › the network wait of a job turn (owner approval 2026-10-29): the job waits and tries again by itself.
    const unreachable = /^⏳ BotBoy couldn't reach the AI model \(([\s\S]*)\)\. This work waits and carries on by itself when the connection is back; nothing done so far is lost\.$/.exec(text);
    if (unreachable) {
      const label = reasonLabel(unreachable[1]);
      return notice({
        key: 'provider', topic: 'turn', state: 'info', severity: 'warning', title: 'AI model unreachable', labels: label ? [label] : [],
        next: 'This work waits and carries on by itself when the connection is back.', detail: [note, unreachable[1]].filter(Boolean).join('\n'),
      });
    }
    const limited = /^⏳ The AI provider is limiting requests right now \(([\s\S]*)\)\. Please send your message again in a minute\.$/.exec(text);
    if (limited) {
      return notice({ key: 'provider', topic: 'turn', state: 'info', severity: 'warning', title: 'AI provider limiting requests', next: 'Send your message again in a minute.', detail: [note, limited[1]].filter(Boolean).join('\n') });
    }
    if (text.length <= 300) {
      for (const [pattern, title, next] of STOPS) {
        if (pattern.test(text)) return notice({ key: 'stop', topic: 'turn', state: 'info', severity: 'info', title, next, detail: note });
      }
    }
    const terminal = /^🖥\uFE0F?\s*Terminal update: “([^”\n]{1,160})” ended with status \*\*([a-z_]+)\*\*(?: \(exit code (-?\d+)\))?\. Ask me to check the result if you want it verified\.$/.exec(text);
    if (terminal) {
      const [, title, status, code] = terminal;
      const ok = status === 'completed' && (code === undefined || code === '0');
      const outcome = status === 'completed' ? (ok ? 'Done' : `Exit ${code}`)
        : status === 'timed_out' ? 'Timed out' : status === 'stopped' ? 'Stopped' : `Failed${code !== undefined ? ` (exit ${code})` : ''}`;
      return notice({ key: 'terminal', topic: 'terminal', state: 'info', severity: ok ? 'info' : 'warning', title: ok ? 'Terminal finished' : 'Terminal ended', labels: [title, outcome], detail: 'Ask me to check the result if you want it verified.' });
    }
    const startup = /^⚠\uFE0F?\s*(.{1,80}?) did not start with the app \(([\s\S]*)\)\. The dashboard keeps working; check the Connections page or ask me to run a diagnosis\.$/.exec(text);
    if (startup) {
      return notice({
        key: `startup:${startup[1].toLowerCase()}`, topic: 'startup', state: 'open', severity: 'error', title: `${startup[1]} didn't start`.slice(0, 80),
        labels: [startup[1]], next: 'The dashboard keeps working. Check Connections, or ask me to diagnose it.', detail: startup[2],
      });
    }
    if (/^Midway (?:is refreshed|is fresh again|is signed in again|authentication is fresh)\b/.test(text) && text.length <= 400) {
      return notice({ key: 'midway', topic: 'midway', state: 'resolved', severity: 'success', title: 'Amazon sign-in working again', labels: connectionsIn(text), detail: text });
    }
    if (/^🔐 Your Amazon session needs re-authentication/.test(text) || /^⚠\uFE0F?\s*Midway re-authentication is still pending/.test(text)) {
      return notice({ key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'Midway sign-in needed', labels: connectionsIn(text), next: 'Run mwinit.', detail: text });
    }
    return null;
  }

  /** The notice a transcript row is, or null for an ordinary message. */
  function noticeOf(m) {
    if (!m || m.role !== 'assistant') return null;
    if (m.notice && typeof m.notice === 'object') return clean(m.notice);
    return legacyNotice(m.content);
  }

  /**
   * A failure the stream bubble shows before any row exists (app.js › createChatStreamBubble): the HTTP refusal, a dropped
   * stream, an error event. The fixed texts of a persisted failure are recognised too.
   */
  function fromLiveError(text, extra) {
    const known = legacyNotice(text);
    if (known) return known;
    const raw = String(text || '').trim();
    const http = /^❌ Error (\d{3}): ([\s\S]*)$/.exec(raw);
    if (http) return notice({ key: 'turn-failed', topic: 'turn', state: 'info', severity: 'error', title: 'Message not sent', labels: [`HTTP ${http[1]}`], next: 'Send it again in a moment.', detail: http[2] });
    if (/^⚠\uFE0F?\s*Stream ended unexpectedly/.test(raw)) {
      return notice({ key: 'turn-failed', topic: 'turn', state: 'info', severity: 'warning', title: 'Reply cut off', next: 'The connection to BotBoy dropped. Reload the chat to see what was saved.' });
    }
    const error = /^❌ Error: ([\s\S]*)$/.exec(raw);
    if (error) {
      const label = reasonLabel(error[1]);
      return notice({ key: 'turn-failed', topic: 'turn', state: 'info', severity: 'error', title: 'Reply failed', labels: label ? [label] : [], next: 'Send your message again.', detail: error[1] });
    }
    if (extra && typeof extra === 'object') {
      const refused = oneLine(extra.error, 200);
      if (refused) {
        return notice({
          key: 'turn-failed', topic: 'turn', state: 'info', severity: 'warning', title: refused.length <= 60 ? refused : 'Message not sent',
          next: oneLine(extra.nextAction, 240), detail: refused.length <= 60 ? '' : refused,
        });
      }
    }
    return null;
  }

  // ── Grouping ──

  const timeOf = (m) => {
    const date = new Date(m?.createdAt || '');
    return Number.isNaN(date.getTime()) ? null : date;
  };
  function clock(date) {
    if (!date) return '';
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const groupIdOf = (entries) => String(entries[0].m.id || `notice-${entries[0].index ?? 0}`);

  /** Open groups that a later "fixed" notice of the same key answered: walking back, each sees the nearest later fix. */
  function settle(groups) {
    const fixedAt = new Map();
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      const latest = group.entries[group.entries.length - 1].notice;
      group.settledAt = latest.state === 'open' && fixedAt.has(group.key) ? fixedAt.get(group.key) : null;
      for (let j = group.entries.length - 1; j >= 0; j--) {
        const entry = group.entries[j];
        if (entry.notice.state === 'resolved') fixedAt.set(group.key, timeOf(entry.m));
      }
    }
    return groups;
  }

  /** The transcript as items: ordinary messages, and runs of consecutive notices about one thing. */
  function itemsOf(messages) {
    const items = [];
    (messages || []).forEach((m, index) => {
      const found = noticeOf(m);
      if (!found) { items.push({ message: m }); return; }
      const last = items[items.length - 1];
      if (last && last.entries && last.key === found.key) last.entries.push({ m, notice: found, index });
      else items.push({ key: found.key, entries: [{ m, notice: found, index }] });
    });
    settle(items.filter(item => item.entries));
    return items;
  }

  // ── Drawing ──

  const CHEVRON = '<svg class="chat-notice-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5l5 5-5 5"/></svg>';
  const safeId = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const linesHtml = (text) => String(text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => `<p>${esc(line)}</p>`).join('');

  /** One group as its compact line plus the body that opens under it. */
  function noticeHtml(group) {
    const entries = group.entries;
    const latest = entries[entries.length - 1];
    const n = latest.notice;
    const id = groupIdOf(entries);
    const open = expanded.has(id);
    const tone = group.settledAt ? 'quiet' : n.state === 'resolved' ? 'fixed' : `sev-${n.severity}`;
    const repeats = entries.filter(entry => entry.notice.title === n.title).length;
    const at = timeOf(latest.m);
    const labels = n.labels.map(label => `<span class="chat-notice-label">${esc(label)}</span>`).join('')
      + (group.settledAt ? `<span class="chat-notice-label fixed-label">Fixed ${esc(clock(group.settledAt))}</span>` : '');
    const live = !group.settledAt && n.state !== 'resolved';
    // The next step is key information for a failure without a button (a turn to resend); otherwise it waits in the body.
    const inlineNext = live && !n.action && n.next && (n.severity === 'error' || n.severity === 'warning');
    const action = live && n.action
      ? n.action.kind === 'open_route'
        ? `<a class="chat-notice-action" href="${esc(n.action.route)}">${esc(n.action.label)}</a>`
        : `<button type="button" class="chat-notice-action" data-notice-action="${esc(n.action.kind)}" data-notice-group="${esc(id)}">${esc(n.action.label)}</button>`
      : '';
    const bodyId = `chat-notice-body-${safeId(id)}`;
    const detail = n.detail
      ? n.detailMarkdown && typeof deps.markdown === 'function'
        ? `<div class="chat-notice-detail content-block">${deps.markdown(n.detail)}</div>`
        : `<div class="chat-notice-detail">${linesHtml(n.detail)}</div>`
      : '';
    // The timeline names labels only where they differ from the line above it (repeats read as times).
    const sameLabels = (entry) => entry.notice.labels.join('\u0000') === n.labels.join('\u0000');
    const timeline = entries.length > 1
      ? `<ol class="chat-notice-timeline">${entries.map(entry => `<li><time>${esc(clock(timeOf(entry.m)))}</time><span>${esc(entry.notice.title)}${entry.notice.labels.length && !sameLabels(entry) ? ` · ${esc(entry.notice.labels.join(', '))}` : ''}</span></li>`).join('')}</ol>`
      : '';
    const noted = actionNotes.get(id);
    const note = live && noted && Date.now() - noted.at < ACTION_NOTE_MS ? noted.text : '';
    const body = [
      n.next && !inlineNext ? `<p class="chat-notice-next">${esc(n.next)}</p>` : '',
      detail,
      timeline,
    ].join('');
    // Line 1 is the toggle (dot, title, count, time, chevron), so the title keeps the full width, with the one button beside it
    // when nothing else needs a second line. Otherwise line 2 holds the labels, the button and a key next step; it toggles too
    // (the button and the link do not).
    const topAction = action && !labels ? action : '';
    const sub = labels || inlineNext || (action && !topAction)
      ? `<div class="chat-notice-sub" data-notice-toggle="${esc(id)}">${labels ? `<span class="chat-notice-labels">${labels}</span>` : ''}`
        + `${inlineNext ? `<span class="chat-notice-next-inline">${esc(n.next)}</span>` : ''}${topAction ? '' : action}</div>`
      : '';
    return `<div class="chat-notice ${tone}${open ? ' expanded' : ''}" data-notice-group="${esc(id)}" data-notice-key="${esc(group.key)}">`
      + '<div class="chat-notice-top">'
      + `<button type="button" class="chat-notice-head" data-notice-toggle="${esc(id)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${esc(bodyId)}">`
      + '<span class="chat-notice-dot" aria-hidden="true"></span>'
      + `<span class="chat-notice-title">${esc(n.title)}</span>`
      + `${repeats > 1 ? `<span class="chat-notice-count" title="${repeats} times">×${repeats}</span>` : ''}`
      + `<time class="chat-notice-time"${at ? ` datetime="${esc(at.toISOString())}"` : ''}>${esc(clock(at))}</time>`
      + CHEVRON
      + '</button>'
      + topAction
      + '</div>'
      + sub
      + `${note ? `<p class="chat-notice-status" role="status">${esc(note)}</p>` : ''}`
      + `<div class="chat-notice-body" id="${esc(bodyId)}">${body || '<p class="chat-notice-next">Nothing more to show.</p>'}</div>`
      + '</div>';
  }

  /** A transcript row wrapping one group (the main chat's rows; app.js › renderChat). */
  function rowHtml(group) {
    const ids = group.entries.map(entry => entry.m.id).filter(Boolean);
    drawn.set(groupIdOf(group.entries), group);
    return `<div class="chat-msg assistant notice-row" data-msg-id="${esc(ids[ids.length - 1] || '')}" data-notice-ids="${esc(ids.join(' '))}" data-notice-group-row="${esc(groupIdOf(group.entries))}">${noticeHtml(group)}</div>`;
  }

  /** The whole main transcript: notice groups drawn here, every other row by app.js (plainRow). */
  function transcriptHtml(messages, plainRow) {
    drawn.clear();
    return itemsOf(messages).map(item => item.entries ? rowHtml(item) : plainRow(item.message)).join('');
  }

  /** One row on its own (a job's thread, a single row app.js appends): the compact notice, or null for an ordinary message. */
  function singleHtml(m) {
    const found = noticeOf(m);
    if (!found) return null;
    const group = { key: found.key, entries: [{ m, notice: found, index: 0 }], settledAt: null };
    return noticeHtml(group);
  }

  /** The live stream bubble's failure: the same compact notice, with no row yet. */
  function liveHtml(found, id) {
    const group = { key: found.key, entries: [{ m: { id: id || `live-${Date.now()}`, createdAt: new Date().toISOString() }, notice: found, index: 0 }], settledAt: null };
    return noticeHtml(group);
  }

  /** Main transcript rows in order, as groups (for marking fixed ones after an append). */
  function domGroups(container) {
    return [...container.querySelectorAll(':scope > .chat-msg[data-notice-group-row]')]
      .map(row => ({ row, group: drawn.get(row.dataset.noticeGroupRow) }))
      .filter(entry => entry.group);
  }
  function redraw(row, group) {
    const before = row.innerHTML;
    const html = noticeHtml(group);
    if (html !== before) row.innerHTML = html;
  }
  /** After rows were appended: a fix later in the transcript quiets the open groups it answered. */
  function settleIn(container) {
    const rows = domGroups(container);
    const before = rows.map(entry => entry.group.settledAt ? entry.group.settledAt.getTime() : null);
    settle(rows.map(entry => entry.group));
    rows.forEach((entry, i) => {
      const now = entry.group.settledAt ? entry.group.settledAt.getTime() : null;
      if (now !== before[i]) redraw(entry.row, entry.group);
    });
  }

  /**
   * The main transcript gained a row (app.js › renderChat's append path). A notice about the same thing as the last row
   * joins that row's group; another notice becomes a new row. Returns false for an ordinary message.
   */
  function appendTo(container, m) {
    const found = noticeOf(m);
    if (!found) return false;
    const last = container.lastElementChild;
    const lastGroup = last?.dataset?.noticeGroupRow ? drawn.get(last.dataset.noticeGroupRow) : null;
    if (lastGroup && lastGroup.key === found.key) {
      lastGroup.entries.push({ m, notice: found, index: lastGroup.entries.length });
      const ids = lastGroup.entries.map(entry => entry.m.id).filter(Boolean);
      last.dataset.noticeIds = ids.join(' ');
      if (m.id) last.dataset.msgId = m.id;
      redraw(last, lastGroup);
    } else {
      const holder = document.createElement('div');
      holder.innerHTML = rowHtml({ key: found.key, entries: [{ m, notice: found, index: 0 }], settledAt: null });
      container.appendChild(holder.firstElementChild);
    }
    settleIn(container);
    return true;
  }

  /** Every row id already drawn inside notice groups (the append path's duplicate check). */
  function drawnIds(container) {
    const ids = new Set();
    for (const row of container.querySelectorAll('.chat-msg[data-notice-ids]')) {
      for (const id of String(row.dataset.noticeIds || '').split(' ')) if (id) ids.add(id);
    }
    return ids;
  }

  // ── Owner clicks ──

  function toggle(trigger) {
    const id = trigger.dataset.noticeToggle;
    const box = trigger.closest('.chat-notice');
    if (!id || !box) return;
    const open = !expanded.has(id);
    if (open) expanded.add(id); else expanded.delete(id);
    box.classList.toggle('expanded', open);
    box.querySelector('.chat-notice-head')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  async function reauth(button) {
    const id = button.dataset.noticeGroup || '';
    const box = button.closest('.chat-notice');
    button.disabled = true;
    const show = (text) => {
      if (text) actionNotes.set(id, { text, at: Date.now() }); else actionNotes.delete(id);
      if (!box) return;
      let status = box.querySelector('.chat-notice-status');
      if (!text) { status?.remove(); return; }
      if (!status) {
        status = document.createElement('p');
        status.className = 'chat-notice-status';
        status.setAttribute('role', 'status');
        (box.querySelector('.chat-notice-sub') || box.querySelector('.chat-notice-top'))?.after(status);
      }
      status.textContent = text;
    };
    try {
      const response = await fetch(`${deps.apiBase}/chat/midway-reauth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.ok) {
        show(`The ${payload.command || 'mwinit'} terminal is open below.`);
        if (typeof deps.afterReauth === 'function') await deps.afterReauth();
      } else {
        show(String(payload.error || 'The terminal could not be opened. Run mwinit in a terminal of your own.'));
      }
    } catch {
      show('BotBoy is not reachable right now. Run mwinit in a terminal of your own.');
    } finally {
      button.disabled = false;
    }
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const action = target.closest('[data-notice-action]');
    if (action && action.dataset.noticeAction === 'midway_reauth') {
      event.preventDefault();
      void reauth(action);
      return;
    }
    if (target.closest('a.chat-notice-action')) return; // the link opens its page; it never toggles the notice
    const head = target.closest('[data-notice-toggle]');
    if (head) {
      event.preventDefault();
      toggle(head);
    }
  }

  let listening = false;
  function init(options = {}) {
    Object.assign(deps, options);
    if (!listening && typeof document !== 'undefined') {
      document.addEventListener('click', onClick);
      listening = true;
    }
  }

  window.BotBoyNotices = {
    init,
    noticeOf,
    fromLiveError,
    transcriptHtml,
    singleHtml,
    liveHtml,
    appendTo,
    drawnIds,
    // For tests: the pure parts.
    _test: { legacyNotice, clean, itemsOf, settle, noticeHtml, reasonLabel, expanded, drawn, actionNotes },
  };
})();
