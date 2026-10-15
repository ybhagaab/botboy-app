/*
 * Settings → Knowledge (docs/maps/knowledge-library.md K12, K19): the renderers for the page that creates the Knowledge folder,
 * lists its sets, moves the analytics knowledge into it and changes its location, and (P2) the change card that chat and the
 * page share, the pending list and History.
 *
 * A classic script loaded before dashboard.js (the same way analytics-html-view.js is) that exposes one global,
 * window.BotBoyKnowledge. Everything here is a pure function from a plain model to an HTML string: no DOM access, no
 * network, no storage, no timers. dashboard.js owns the state, the requests and the handlers, and passes its own
 * escape, icon and layout helpers in, so a folder or set name can never reach the page unescaped.
 */
(function () {
  const STATES = {
    not_created: { label: 'Not created', tone: '' },
    ready: { label: 'Ready', tone: 'good' },
    needs_permission: { label: 'Needs permission', tone: 'warn' },
    folder_missing: { label: 'Folder missing', tone: 'warn' },
    error: { label: 'Problem', tone: 'bad' },
  };
  const KIND_LABELS = { analytics: 'Analytics', product: 'Product', research: 'Research', memory: 'Memory', generic: 'General' };
  const ISSUES_SHOWN = 2;
  const NAMES_SHOWN = 4;

  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
  }

  function stateView(state) {
    return STATES[state] || STATES.error;
  }

  function guideLabel(set) {
    return set && set.hasGuide ? 'Guide: Yes' : 'No guide yet';
  }

  function dateLabel(iso) {
    const time = Date.parse(String(iso || ''));
    return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  }

  /** "a, b, c and 2 more" from a list of names (already plain strings). */
  function nameList(names, shown = NAMES_SHOWN) {
    const list = (Array.isArray(names) ? names : []).map(String);
    if (list.length <= shown) return list.join(', ');
    return `${list.slice(0, shown).join(', ')} and ${list.length - shown} more`;
  }

  // What the write protection covers (design Q11b "What it reaches"): commands BotBoy launches through its sandbox. The
  // built-in connections and the browser BotBoy drives are outside it, and the copy says so instead of overclaiming.
  const COVERAGE_LEAD = 'Commands BotBoy runs for you can read this folder but cannot change it.';
  const COVERAGE_DETAIL = 'That covers the run_command tool, the chat terminal and MCP servers you added with a command. It does not cover BotBoy\u2019s built-in connections or the browser BotBoy drives.';
  const COVERAGE = `${COVERAGE_LEAD} ${COVERAGE_DETAIL}`;

  // ── Small pieces ─────────────────────────────────────────────────────────

  function alertBox(h, tone, message, nextAction) {
    const klass = tone === 'good' ? 'mcp-alert good' : 'mcp-alert';
    const role = tone === 'good' ? 'status' : 'alert';
    return `<div class="${klass}" role="${role}">${h.icon(tone === 'good' ? 'check' : 'alert', 15)}<span><strong>${h.esc(message)}</strong>${nextAction ? ` ${h.esc(nextAction)}` : ''}</span></div>`;
  }

  function noticeBox(model, h, scope) {
    const notice = model.notice;
    if (!notice || (notice.scope || 'location') !== scope) return '';
    return alertBox(h, notice.tone, notice.message, notice.nextAction);
  }

  /** The "this folder already holds things" question, shown inside the form that asked it. */
  function existingBox(model, h, mode) {
    const existing = model.existing;
    if (!existing || existing.mode !== mode) return '';
    const sample = Array.isArray(existing.sample) && existing.sample.length ? ` (${nameList(existing.sample)})` : '';
    return `<div class="mcp-alert" role="alert">${h.icon('alert', 15)}<span><strong>${h.esc(existing.path)} already holds ${h.esc(plural(Number(existing.entries) || 0, 'item', 'items'))}${h.esc(sample)}.</strong> BotBoy only adds to it; files that differ stop the copy.
      <label class="knowledge-confirm"><input type="checkbox" name="confirmExisting" value="yes" data-knowledge-focus="existing-${h.attr(mode)}"> Yes, use this folder</label></span></div>`;
  }

  // ── Location ─────────────────────────────────────────────────────────────

  function createCard(model, h) {
    const status = model.status;
    const busy = model.busy === 'create';
    const defaultPath = model.createDraft || status.defaultRoot || '';
    return `<form class="card mcp-form knowledge-location" data-knowledge-form="create" aria-busy="${busy ? 'true' : 'false'}">
      <div class="card-header"><div><h2 class="card-title">Knowledge folder</h2><div class="card-meta">Not created yet</div></div><span class="pill">Not created</span></div>
      ${noticeBox(model, h, 'location')}
      <div class="mcp-form-body">
        <p class="card-meta">Nothing is created until you click Create folder. BotBoy then makes one folder with a short GUIDE.md that explains how to add your own sets: a folder of reference files plus a guide that says what each file is for.</p>
        <label class="mcp-field"><span>Folder location</span><input name="path" id="knowledge-create-path" type="text" value="${h.attr(defaultPath)}" autocomplete="off" maxlength="1024" required aria-describedby="knowledge-create-hint"><small id="knowledge-create-hint">macOS may ask whether BotBoy can use your Documents folder. Choose Allow. You can pick another place; a new or empty folder is best.</small></label>
        ${existingBox(model, h, 'create')}
        <p class="card-meta">${h.esc(status.syncNote || '')}</p>
      </div>
      <div class="mcp-form-actions"><span>${h.icon('shield', 14)} BotBoy reads this folder only when a chat needs a file. Commands BotBoy runs for you cannot change it.</span><button class="button primary" type="submit" data-knowledge-focus="create" ${model.busy ? 'disabled' : ''}>${busy ? 'Creating…' : 'Create folder'}</button></div>
    </form>`;
  }

  function changeForm(model, h) {
    const busy = model.busy === 'change';
    return `<form class="knowledge-change-form" data-knowledge-form="change" aria-busy="${busy ? 'true' : 'false'}">
      <label class="mcp-field"><span>New folder location</span><input name="path" id="knowledge-change-path" type="text" value="${h.attr(model.changeDraft || '')}" placeholder="~/Documents/BotBoy Knowledge 2" autocomplete="off" maxlength="1024" required aria-describedby="knowledge-change-hint"><small id="knowledge-change-hint">BotBoy copies the whole folder to the new place, checks every file, and only then switches. Your old folder is left exactly as it is; BotBoy never deletes it.</small></label>
      ${existingBox(model, h, 'change')}
      <div class="knowledge-form-actions"><button class="button primary" type="submit" data-knowledge-focus="change" ${model.busy ? 'disabled' : ''}>${busy ? 'Copying…' : 'Copy and switch'}</button><button class="button ghost" type="button" data-action="knowledge-change-cancel" data-knowledge-focus="change-cancel" ${model.busy ? 'disabled' : ''}>Cancel</button></div>
    </form>`;
  }

  function readyCard(model, h) {
    const status = model.status;
    const view = stateView(status.state);
    const busy = Boolean(model.busy);
    const problem = status.state !== 'ready' && status.message
      ? alertBox(h, 'bad', status.message, status.nextAction)
      : '';
    const pinned = status.pinnedByEnvironment
      ? `<p class="card-meta">The location is set by BOTBOY_KNOWLEDGE_ROOT, so it cannot be changed here.</p>`
      : '';
    // A folder that is gone is brought back by creating it again at the same place (activation is idempotent).
    const recreate = status.state === 'folder_missing' && !status.pinnedByEnvironment
      ? `<button class="button small" type="button" data-action="knowledge-recreate" data-knowledge-focus="recreate" ${busy ? 'disabled' : ''}>${model.busy === 'create' ? 'Creating…' : 'Create folder again'}</button>`
      : '';
    const change = status.pinnedByEnvironment
      ? ''
      : `<button class="button small" type="button" data-action="knowledge-change-open" data-knowledge-focus="change-open" aria-expanded="${model.changing ? 'true' : 'false'}" ${busy ? 'disabled' : ''}>Change location</button>`;
    const protection = status.denyActive
      ? COVERAGE
      : 'The protection that stops commands from changing this folder is not active. Restart BotBoy.';
    return `<article class="card settings-panel knowledge-location" aria-busy="${busy ? 'true' : 'false'}">
      <div class="card-header ai-model-status-head"><div><h2 class="card-title">Knowledge folder</h2><div class="card-meta">${h.esc(view.label === 'Ready' ? 'Ready to use' : view.label)}</div></div><span class="pill ${view.tone}">${h.esc(view.label)}</span></div>
      ${noticeBox(model, h, 'location')}${problem}
      <div class="setting-row ai-model-role-row"><span class="setting-copy"><strong>Location</strong><span class="knowledge-path">${h.esc(status.root || '')}</span></span><span class="ai-model-role-controls">${recreate}${change}<button class="button small ghost" type="button" data-action="knowledge-rescan" data-knowledge-focus="rescan" ${busy ? 'disabled' : ''}>${model.busy === 'rescan' ? 'Rescanning…' : 'Rescan'}</button></span></div>
      <p class="card-meta">${h.esc(status.syncNote || '')} ${h.esc(protection)}</p>${pinned}
      ${model.changing && !status.pinnedByEnvironment ? changeForm(model, h) : ''}
    </article>`;
  }

  // ── Sets ─────────────────────────────────────────────────────────────────

  function issueCell(set, h) {
    const issues = Array.isArray(set.issues) ? set.issues : [];
    if (!issues.length) return '<span class="card-meta">None</span>';
    const shown = issues.slice(0, ISSUES_SHOWN).map(issue => `<li>${h.esc(issue.message || issue.code || 'Issue')}</li>`).join('');
    const more = issues.length > ISSUES_SHOWN ? `<li>${h.esc(`and ${issues.length - ISSUES_SHOWN} more`)}</li>` : '';
    return `<ul class="knowledge-issues">${shown}${more}</ul>`;
  }

  function setRow(set, h) {
    const kind = KIND_LABELS[set.kind] || KIND_LABELS.generic;
    const id = set.id && set.id !== set.name ? `<small class="knowledge-set-id">${h.esc(set.id)}</small>` : '';
    const builtIn = set.reserved ? ' <span class="pill blue">Built in</span>' : '';
    return `<tr>
      <th scope="row"><strong>${h.esc(set.name)}</strong>${builtIn}${id}</th>
      <td>${h.esc(kind)}</td>
      <td class="knowledge-description">${h.esc(set.description || '')}</td>
      <td>${h.esc(h.number(set.fileCount))}</td>
      <td><span class="pill ${set.hasGuide ? 'good' : ''}">${h.esc(guideLabel(set))}</span></td>
      <td>${issueCell(set, h)}</td>
    </tr>`;
  }

  function setsCard(model, h) {
    const status = model.status;
    const sets = Array.isArray(status.sets) ? status.sets : [];
    const loose = Number(status.looseCount) || 0;
    const meta = [plural(sets.length, 'set', 'sets'), loose ? `${plural(loose, 'file', 'files')} outside any set` : ''].filter(Boolean).join(' · ');
    const body = sets.length
      ? `<div class="data-room-table-wrap" data-scroll-key="knowledge:sets"><table class="data-room-table knowledge-sets-table"><caption class="visually-hidden">Sets in your Knowledge folder</caption><thead><tr><th scope="col">Set</th><th scope="col">Kind</th><th scope="col">What it holds</th><th scope="col">Files</th><th scope="col">Guide</th><th scope="col">Issues</th></tr></thead><tbody>${sets.map(set => setRow(set, h)).join('')}</tbody></table></div>`
      : `<p class="card-meta">No sets yet. Add a folder under ${h.esc(status.root || 'the Knowledge folder')} with a GUIDE.md that lists its files, then press Rescan. The GUIDE.md in the folder explains the layout.</p>`;
    return `<article class="card settings-panel knowledge-sets"><div class="card-header ai-model-status-head"><div><h2 class="card-title">Sets</h2><div class="card-meta">${h.esc(meta)}</div></div></div>${body}</article>`;
  }

  // ── Moving the analytics knowledge ───────────────────────────────────────

  function planSummary(plan) {
    const entries = Array.isArray(plan && plan.entries) ? plan.entries : [];
    const copy = entries.filter(entry => entry.state === 'copy');
    const present = entries.filter(entry => entry.state === 'present');
    return {
      copyCount: copy.length,
      presentCount: present.length,
      copyBytes: copy.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
      conflictCount: Array.isArray(plan && plan.conflicts) ? plan.conflicts.length : 0,
      blockedCount: Array.isArray(plan && plan.blocked) ? plan.blocked.length : 0,
      ignoredCount: Array.isArray(plan && plan.ignored) ? plan.ignored.length : 0,
    };
  }

  function planView(model, h) {
    const plan = model.plan;
    if (!plan) return '';
    const summary = planSummary(plan);
    const busy = Boolean(model.busy);
    const lines = [];
    lines.push(`<p class="card-meta">${h.esc(plural(summary.copyCount, 'file', 'files'))} (${h.esc(formatBytes(summary.copyBytes))}) will be copied to ${h.esc(plan.target || '')}${summary.presentCount ? `; ${h.esc(plural(summary.presentCount, 'file is', 'files are'))} already there with the same content` : ''}. Your old folder stays exactly as it is; BotBoy never deletes it.</p>`);
    if (summary.conflictCount) {
      lines.push(alertBox(h, 'bad', `${plural(summary.conflictCount, 'file differs', 'files differ')} from what is already in the Knowledge folder: ${nameList(plan.conflicts)}.`, 'Rename or move those files in the Knowledge folder, then preview again. Nothing was changed.'));
    }
    if (summary.blockedCount) {
      const names = (plan.blocked || []).map(item => `${item.name} (${item.reason})`);
      lines.push(alertBox(h, 'bad', `${plural(summary.blockedCount, 'item cannot', 'items cannot')} be moved safely: ${nameList(names, 3)}.`, 'Fix or remove them in the old folder, then preview again. Nothing was changed.'));
    }
    if (plan.onboardingBusy) {
      lines.push(alertBox(h, 'bad', 'Preset generation is running, and it writes into this folder.', 'Wait for it to finish, then preview again.'));
    }
    if (plan.reason === 'boundary_not_registered') {
      lines.push(alertBox(h, 'bad', 'The protection for the Knowledge folder is not in effect, so nothing can be moved.', 'Restart BotBoy and try again.'));
    }
    if (summary.ignoredCount) {
      const items = plan.ignored.slice(0, 20).map(item => `<li><code>${h.esc(item.name)}</code> <span class="card-meta">${h.esc(item.reason)}</span></li>`).join('');
      lines.push(`<details class="ai-model-models"><summary>${h.esc(plural(summary.ignoredCount, 'item is', 'items are'))} not moved</summary><ul>${items}</ul></details>`);
    }
    const reclassified = Array.isArray(plan.reclassified) ? plan.reclassified : [];
    if (reclassified.length) {
      lines.push(`<label class="knowledge-confirm"><input type="checkbox" data-knowledge-ack data-knowledge-focus="move-ack" ${model.acknowledged ? 'checked' : ''} ${busy ? 'disabled' : ''}> ${h.esc(`I understand that ${reclassified.join(', ')} in the old folder becomes the guide of the analytics set and leaves its list of notes.`)}</label>`);
    }
    const canMove = plan.ok && !busy && (!reclassified.length || model.acknowledged);
    lines.push(`<div class="knowledge-form-actions"><button class="button primary" type="button" data-action="knowledge-move-apply" data-knowledge-focus="move-apply" ${canMove ? '' : 'disabled'}>${model.busy === 'apply' ? 'Moving…' : 'Move now'}</button><button class="button ghost" type="button" data-action="knowledge-move-cancel" data-knowledge-focus="move-cancel" ${busy ? 'disabled' : ''}>Cancel</button></div>`);
    return `<div class="knowledge-plan">${lines.join('')}</div>`;
  }

  function moveCard(model, h) {
    const status = model.status;
    if (!status.activated) return '';
    const busy = Boolean(model.busy);
    const record = status.migration;
    if (status.analyticsDir === 'library') {
      if (!record) return '';
      const when = dateLabel(record.at);
      return `<article class="card settings-panel knowledge-move"><div class="card-header ai-model-status-head"><div><h2 class="card-title">Analytics knowledge</h2><div class="card-meta">Moved${when ? ` on ${h.esc(when)}` : ''}</div></div><span class="pill good">In the Knowledge folder</span></div>
        ${noticeBox(model, h, 'move')}
        <div class="setting-row ai-model-role-row"><span class="setting-copy"><strong>${h.esc(plural(Number(record.files) || 0, 'file', 'files'))} now live in the analytics set</strong><span>You moved them from <span class="knowledge-path">${h.esc(record.source || '')}</span>, which BotBoy left untouched. Revert copies the files back there (a different file already there is kept as .pre-revert) and switches back. Nothing is deleted.</span></span><span class="ai-model-role-controls"><button class="button small" type="button" data-action="knowledge-move-revert" data-knowledge-focus="move-revert" ${busy ? 'disabled' : ''}>${model.busy === 'revert' ? 'Reverting…' : 'Revert'}</button></span></div>
      </article>`;
    }
    const legacy = status.legacyAnalytics;
    if (!legacy) return '';
    const preview = model.busy === 'preview';
    return `<article class="card settings-panel knowledge-move" aria-busy="${busy ? 'true' : 'false'}"><div class="card-header ai-model-status-head"><div><h2 class="card-title">Analytics knowledge</h2><div class="card-meta">Still in the old folder</div></div><span class="pill warn">Not moved</span></div>
      ${noticeBox(model, h, 'move')}
      <div class="setting-row ai-model-role-row"><span class="setting-copy"><strong>${h.esc(plural(Number(legacy.files) || 0, 'file', 'files'))}${legacy.hasManifest ? ' and a manifest' : ''} in <span class="knowledge-path">${h.esc(legacy.dir || '')}</span></strong><span>Move them into the Knowledge folder to keep everything in one place. BotBoy copies first, checks every file, and switches only if all match. The old folder is left as it is, and you can revert at any time.</span></span><span class="ai-model-role-controls"><button class="button small" type="button" data-action="knowledge-move-preview" data-knowledge-focus="move-preview" ${busy ? 'disabled' : ''}>${preview ? 'Checking…' : 'Preview the move'}</button></span></div>
      <p class="card-meta knowledge-sync-note">${h.esc(status.syncNote || '')}</p>
      ${planView(model, h)}
    </article>`;
  }


  // ── The write path (K19): one change card for chat and the page, the pending list and History ──────────────
  const DIFF_LINES_SHOWN = 200;
  const MODE_LABELS = { create: 'Create', append: 'Add to', edit: 'Edit', replace: 'Replace', import: 'Import', move: 'Move', archive: 'Archive', create_set: 'Create set' };
  const ACTOR_LABELS = { botboy: 'BotBoy', 'owner-via-botboy': 'You, through BotBoy', outside: 'Edited outside BotBoy', generated: 'Generated by BotBoy' };
  const TIER_LABELS = { must_fix: 'Breach', should_fix: 'Worth fixing', note: 'Note' };
  const esc = (h, value) => h.esc(value == null ? '' : value);
  const attr = (h, value) => (h.attr || h.esc)(value == null ? '' : value);
  /** The first 200 lines of a unified diff, one line per element, with the glyph as well as the colour; the rest behind a button. */
  function diffBlock(diffText, h, expanded) {
    const lines = String(diffText || '').split('\n');
    const shown = expanded ? lines : lines.slice(0, DIFF_LINES_SHOWN);
    const rows = shown.map((line) => {
      const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx';
      return `<span class="knowledge-diff-line ${kind}">${esc(h, line)}</span>`;
    }).join('\n');
    const more = lines.length > shown.length
      ? `<button type="button" class="button small ghost" data-knowledge-action="diff-more">Show all ${lines.length} lines</button>` : '';
    return `<pre class="knowledge-diff" tabindex="0" aria-label="What would change">${rows || 'No text changes.'}</pre>${more}`;
  }
  function changeTitle(change) {
    const verb = MODE_LABELS[change.mode] || change.mode;
    if (change.kind === 'create_set') return `Create the set ${change.set}`;
    return change.file ? `${verb} ${change.file} in ${change.set}` : `${verb} the set ${change.set}`;
  }
  function itemsList(items, h) {
    if (!items || !items.length) return '';
    return `<ul class="knowledge-items">${items.slice(0, 8).map((item) => {
      const rule = item.rule ? ` <q>${esc(h, item.rule)}</q>` : '';
      return `<li><strong>${esc(h, TIER_LABELS[item.tier] || item.tier)}:</strong>${rule} ${esc(h, item.problem)}${item.fix ? ` <em>Fix: ${esc(h, item.fix)}</em>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  /**
   * One change as a card (the chat card and the page's pending list use the same markup). The five states: clean, unresolved
   * (a guide breach is open), held (the check could not run), stale (the file or the guide moved), applied. A card for text that
   * came from an untrusted source shows where from and its FULL diff, and its button says Review and apply.
   */
  function renderChangeCard(change, h, options) {
    const opts = options || {};
    const id = attr(h, change.id);
    const untrusted = Array.isArray(change.sources) && change.sources.length > 0;
    const head = `<div class="knowledge-card-head"><span class="knowledge-card-kind">${change.origin === 'botboy_proposal' ? 'BotBoy proposes' : 'Change'}</span><strong>${esc(h, changeTitle(change))}</strong></div>`;
    const why = change.why ? `<p class="knowledge-card-why">${esc(h, change.why)}</p>` : '';
    const where = untrusted
      ? `<p class="knowledge-card-source" role="note">Derived from ${esc(h, change.sources.join(', '))}. Nothing from a message, page or document is applied by itself: read the whole change before you apply it.</p>` : '';
    const flagged = change.suspicious && !untrusted ? '<p class="knowledge-card-source" role="note">This text reads like instructions to an assistant. Read the whole change before you apply it.</p>' : '';
    const diff = change.diff ? diffBlock(change.diff, h, opts.expandDiff || untrusted) : '';
    const button = (action, label, klass) => `<button type="button" class="button small ${klass || ''}" data-knowledge-action="${action}" data-change-id="${id}">${esc(h, label)}</button>`;
    const note = opts.notice ? `<div class="knowledge-card-note" role="status">${esc(h, opts.notice)}</div>` : '';
    const open = itemsList(change.unresolved, h);
    const notes = itemsList(change.notes, h);
    let state;
    let actions = '';
    if (change.status === 'applied') {
      state = `<div class="knowledge-card-state good">Applied. Settings → Knowledge → History has the diff and an Undo.${change.overrode && change.overrode.length ? ' You applied it despite an open item.' : ''}</div>`;
      actions = button('undo', 'Undo', 'ghost');
    } else if (change.status === 'undone') {
      state = '<div class="knowledge-card-state good">Undone. The file is back as it was before this change.</div>';
    } else if (change.status === 'dismissed' || change.status === 'expired') {
      state = `<div class="knowledge-card-state">${change.status === 'dismissed' ? 'Dismissed. Nothing was written.' : 'Expired after 14 days. Nothing was written.'}</div>`;
    } else if (change.status === 'held') {
      state = `<div class="knowledge-card-state warn">The guide check could not run, so this cannot be applied yet. ${esc(h, (change.check && change.check.nextAction) || 'Check Settings → AI model, then Retry check.')}</div>`;
      actions = button('recheck', 'Retry check', 'primary') + button('dismiss', 'Dismiss', 'ghost');
    } else if (change.status === 'stale') {
      state = '<div class="knowledge-card-state warn">The file or the guide changed after this was prepared, so it was not applied.</div>';
      actions = button('redraft', 'Re-draft', 'primary') + button('dismiss', 'Dismiss', 'ghost');
    } else if (change.status === 'revising') {
      state = '<div class="knowledge-card-state">BotBoy is still revising this change.</div>';
    } else if (change.needsAnyway) {
      state = '<div class="knowledge-card-state warn">The guide check still has open items. Applying anyway is your decision.</div>';
      actions = button('apply-anyway', untrusted ? 'Review and apply anyway' : 'Apply anyway', 'primary') + button('ask-fix', 'Ask BotBoy to fix', '') + button('dismiss', 'Dismiss', 'ghost');
    } else {
      state = '';
      actions = button('apply', untrusted || change.suspicious ? 'Review and apply' : 'Apply', 'primary') + button('dismiss', 'Dismiss', 'ghost');
    }
    const anywayHint = '';
    return `${head}${why}${where}${flagged}${open ? `<div class="knowledge-card-open">${open}</div>` : ''}${diff}${notes && change.status === 'applied' ? `<details class="knowledge-card-notes"><summary>Things the check mentioned</summary>${notes}</details>` : ''}${state}${note}${actions ? `<div class="knowledge-card-actions">${actions}</div>` : ''}${anywayHint}`;
  }
  /** What a card's buttons ask the server: the two flags of POST apply (never content). */
  function applyBody(change, action) {
    return { anyway: action === 'apply-anyway', confirmFlagged: Boolean(change && change.needsConfirm) };
  }
  /** The text seeded into the chat composer by Ask BotBoy to fix and Re-draft: a fixed sentence and the card marker. */
  function followUpMessage(action, changeId) {
    const note = action === 'redraft'
      ? 'Please prepare this change again from the current file and rules.'
      : 'Please fix this change so it follows the guide.';
    return `${note} [[knowledge:${changeId}]]`;
  }
  /** Settings → Knowledge: what is waiting for a decision. */
  function pendingCard(model, h) {
    const data = model.changes;
    const body = model.changesError
      ? alertBox(h, 'bad', model.changesError, 'Reload the page; tell the owner if it repeats.')
      : !data ? '<p class="card-meta">Loading…</p>'
      : data.changes.length === 0 ? '<p class="card-meta">Nothing is waiting. When BotBoy proposes a change, or holds one for you, it appears here and in the chat.</p>'
      : data.changes.map((change) => `<article class="knowledge-card knowledge-page-card" data-knowledge-change-id="${attr(h, change.id)}" aria-live="polite">${renderChangeCard(change, h, { expandDiff: Boolean(model.expandedDiffs && model.expandedDiffs[change.id]), notice: model.cardNotices && model.cardNotices[change.id] })}</article>`).join('');
    const count = data && data.counts ? data.counts.waiting : 0;
    return `<article class="card settings-panel knowledge-pending"><div class="card-header ai-model-status-head"><div><h2 class="card-title">Waiting for your decision</h2><div class="card-meta">${plural(count, 'change', 'changes')} · nothing is written until you apply it</div></div></div>${body}</article>`;
  }
  const whenLabel = (iso) => dateLabel(iso);
  /** Settings → Knowledge: History with a diff per entry, Undo on the latest, and the git mirror's hint. */
  function historyCard(model, h) {
    const data = model.history;
    let body;
    if (model.historyError) body = alertBox(h, 'bad', model.historyError, 'Reload the page; tell the owner if it repeats.');
    else if (!data) body = '<p class="card-meta">Loading…</p>';
    else if (!data.entries.length) body = '<p class="card-meta">No changes yet. Each change BotBoy makes, and each edit made outside it, is listed here.</p>';
    else {
      body = `<ul class="knowledge-history">${data.entries.map((entry) => {
        const open = model.historyOpen === entry.id;
        const detail = open && model.historyDetail ? model.historyDetail[entry.id] : null;
        const files = (entry.files || []).map((file) => file.path);
        const diffs = detail ? (detail.files || []).map((file) => `<div class="knowledge-history-file"><strong>${esc(h, file.path)}</strong> <span class="card-meta">${esc(h, file.kind)}</span>${file.diff ? diffBlock(unifiedText(file.diff), h, true) : `<p class="card-meta">${esc(h, file.note || 'No diff is kept for this file.')}</p>`}</div>`).join('') : '';
        const undo = data.latestUndoableId === entry.id ? `<button type="button" class="button small ghost" data-knowledge-action="history-undo" data-entry-id="${attr(h, entry.id)}">Undo</button>` : '';
        return `<li class="knowledge-history-entry"><div><span class="card-meta">${esc(h, whenLabel(entry.at))} · ${esc(h, entry.kind === 'baseline' ? 'History started' : (ACTOR_LABELS[entry.actor] || entry.actor))}</span><div>${esc(h, entry.summary)}</div>${entry.sources && entry.sources.length ? `<div class="card-meta">Derived from ${esc(h, entry.sources.join(', '))}</div>` : ''}${entry.overrode && entry.overrode.length ? '<div class="card-meta">Applied despite an open guide-check item.</div>' : ''}</div><div class="knowledge-card-actions">${files.length ? `<button type="button" class="button small ghost" data-knowledge-action="history-open" data-entry-id="${attr(h, entry.id)}" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Hide' : 'Show'} ${plural(files.length, 'file', 'files')}</button>` : ''}${undo}</div>${diffs}</li>`;
      }).join('')}</ul>`;
    }
    const git = data && data.git ? (data.git.state === 'active' && data.git.hint ? `<p class="card-meta">Also browsable with git: <code>${esc(h, data.git.hint)}</code></p>` : data.git.notice ? `<p class="card-meta">${esc(h, data.git.notice)}</p>` : '') : '';
    const note = data && data.note ? `<p class="card-meta">${esc(h, data.note)} Back it up with your Mac backup (Time Machine) if you want it kept.</p>` : '';
    const notice = model.historyNotice ? alertBox(h, model.historyNotice.tone, model.historyNotice.message, model.historyNotice.nextAction) : '';
    return `<article class="card settings-panel knowledge-history-card"><div class="card-header ai-model-status-head"><div><h2 class="card-title">History</h2><div class="card-meta">Every change, newest first. Undo takes back the latest.</div></div></div>${notice}${body}${git}${note}</article>`;
  }
  /** A history diff arrives as {text, ...} or as plain text; the card shows the text. */
  function unifiedText(diff) {
    return diff && typeof diff === 'object' ? String(diff.text || '') : String(diff || '');
  }
  // ── What BotBoy does with the folder ─────────────────────────────────────

  function usageCard(h) {
    return `<article class="card settings-panel knowledge-usage"><div class="card-header ai-model-status-head"><div><h2 class="card-title">What BotBoy does with this folder</h2><div class="card-meta">Plain answers</div></div></div>
      <ul class="knowledge-usage-list">
        <li><strong>Loaded files are sent to your chosen AI model.</strong> When a chat or a job opens a file, the whole file goes to the model you picked for it, like any other message. The content of files BotBoy does not open is never sent. Every chat carries a one-line note naming your sets, and a message that matches a set also carries that set\u2019s short file table.</li>
        <li><strong>Changes are checked against the guide and need your say.</strong> When BotBoy proposes or makes a change, the new text and the guide go to your Document writing model for a check, and a new set\u2019s guide is drafted by it. A change you asked for exactly is applied and recorded in History with an Undo; anything else waits above as a card until you apply it. Nothing from an email, message, page or document is applied by itself.</li>
        <li><strong>BotBoy never watches this folder.</strong> Its files do not become captures, project evidence or Today items.</li>
        <li><strong>${h.esc(COVERAGE_LEAD)}</strong> ${h.esc(COVERAGE_DETAIL)}</li>
        <li><strong>Keep secrets out.</strong> Do not put passwords, tokens or other people\u2019s private details in any set. BotBoy refuses to load a file that contains a secret.</li>
      </ul>
    </article>`;
  }

  // ── The page ─────────────────────────────────────────────────────────────

  function renderPage(model, h) {
    const head = `<div class="breadcrumb"><a href="#/settings">Settings</a>${h.icon('chevron-right', 11)}<span>Knowledge</span></div>${h.pageHead('Settings', 'Knowledge', 'Guides and reference files BotBoy reads when a question needs them.', '<a class="button" href="#/settings">Back</a>')}`;
    const status = model.status;
    if (!status) {
      if (!model.error) return h.loadingView();
      return `${head}<section class="knowledge-settings"><article class="card settings-panel">${alertBox(h, 'bad', model.error, 'Check that BotBoy is running, then try again.')}<div class="knowledge-form-actions"><button class="button small" type="button" data-action="knowledge-refresh" data-knowledge-focus="refresh">Try again</button></div></article></section>`;
    }
    const cards = [];
    cards.push(status.activated ? readyCard(model, h) : createCard(model, h));
    // Sets and the Move card need a folder that can be read; the location card above already says what is wrong.
    if (status.activated && status.state === 'ready') {
      cards.push(setsCard(model, h));
      cards.push(pendingCard(model, h));
      cards.push(historyCard(model, h));
      const move = moveCard(model, h);
      if (move) cards.push(move);
    }
    cards.push(usageCard(h));
    return `${head}<section class="knowledge-settings">${cards.join('')}</section>`;
  }

  /** The analytics card on the connection page while the analytics knowledge lives in the Knowledge folder. */
  function renderAnalyticsInLibrary(ctx, h) {
    const count = Number(ctx && ctx.fileCount) || 0;
    const blocked = ctx && ctx.unavailable ? alertBox(h, 'bad', ctx.unavailable.message || 'The analytics folder cannot be read.', ctx.unavailable.nextAction) : '';
    return `<div class="eyebrow">${h.icon('file', 14)} Analytics knowledge</div>
    <h3 class="card-title">${h.esc(plural(count, 'knowledge file', 'knowledge files'))}</h3>
    <p class="page-subtitle">Your analytics knowledge lives in the Knowledge folder, in its analytics set. BotBoy reads these files on demand to ground data questions; generated presets and adopted lessons land there too.</p>
    <div class="mcp-fact"><span>Folder</span><strong style="word-break:break-all">${h.esc(ctx && ctx.dir || '')}</strong></div>
    ${blocked}
    <div style="margin-top:8px"><a class="button small" href="#/settings/knowledge">Open Settings → Knowledge ${h.icon('chevron-right', 12)}</a></div>`;
  }

  window.BotBoyKnowledge = {
    renderPage,
    renderAnalyticsInLibrary,
    renderChangeCard,
    applyBody,
    followUpMessage,
    diffBlock,
    pendingCard,
    historyCard,
    planSummary,
    stateView,
    guideLabel,
    formatBytes,
    nameList,
    COVERAGE,
  };
})();
