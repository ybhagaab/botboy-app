/**
 * Jobs in the chat panel (owner redesign 2026-11-13; the approved demo `.agents/tasks/jobs-ui-demo/demo.html`;
 * docs/maps/job-continuations.md).
 *
 * The main chat stays the plain chat. Jobs live in a dock right above the composer, where the single-job strip was:
 * one job is one full-width pill (what it works on, its state and Stop), two jobs split the row, three take a third each, and
 * more add a "+N more" button that opens a drawer with every job. Each pill's second line previews what its job is doing right
 * now: its thinking, a tool, its words, a wait, or its question. A job opens as a bottom sheet over the main chat: its progress
 * on top, its own thread (the main chat's bubbles) below, landing on the newest message, with the composer moved into it.
 *
 * Every surface is drawn from GET /chat/jobs (what the server derives from what actually runs) and GET /chat/live (each job's
 * automatic turn as it streams), never from a guess; all text is escaped here.
 *
 * app.js owns the transcript renderer, the stream bubble and the composer; it hands them in with init(), and asks this
 * module which thread the composer talks to (currentJobId) and where a job's bubbles go (threadElement).
 */
(function () {
  'use strict';
  const JOB_ID_RE = /^cj_[a-f0-9]{24}$/;
  const POLL_MS = 4000;
  /** Running queries (docs/maps/query-control.md): BotBoy's own SQL queries and ETL runs, read while the panel is open. */
  const QUERY_POLL_MS = 12000;
  const QUERY_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|etl:\d+|earlier:\d+)$/i;
  /** A query BotBoy is still waiting on shows in the dock only once it has run this long (a quick one never flickers it). */
  const QUERY_DOCK_MS = 30000;
  /** Pills in the dock; more jobs go behind "+N more". */
  const DOCK_PILLS = 3;
  /** A job that ended keeps its pill this long (green when it finished), unless the owner dismisses it. */
  const ENDED_PILL_MS = 10 * 60_000;
  const DISMISSED_KEY = 'botboy.jobs.dismissed.v1';
  /** The sheets' slide (dashboard.css › .jobs-sheet-panel). */
  const SHEET_MS = 300;
  const LIVE_EVENT_CAP = 4000;
  /** The composer moves into an open job's sheet and back, so its attachments, Stop and model picker keep working. */
  const COMPOSER_IDS = ['chat-terminal-dock', 'chat-attach-strip', 'chat-input-area'];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  /** The newest words of a running text, from a word boundary. */
  const tail = (value, max) => {
    const text = oneLine(String(value ?? '').replace(/\*\*|__|`/g, ''));
    if (text.length <= max) return text;
    const cut = text.slice(text.length - max);
    return `…${cut.replace(/^\S*\s/, '')}`;
  };
  const head = (value, max) => {
    const text = oneLine(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  /** A job's look, from its own words (cosmetic only). */
  function kindOf(job) {
    const text = `${job?.title || ''} ${job?.goal || ''}`;
    if (/\b(dashboard|widget|chart)s?\b/i.test(text)) return 'dash';
    if (/\b(draft|write|doc|document|note|memo|email|deck|report|summary|brief)s?\b/i.test(text)) return 'doc';
    return 'data';
  }
  const ICON = {
    data: '<path d="M4.5 16V10M10 16V4.5M15.5 16v-6.5"/>',
    doc: '<path d="M6 2.75h5.25L15 6.5v10.75H6z"/><path d="M11 3v3.75h3.75M8.5 10.5h4M8.5 13.5h4"/>',
    dash: '<path d="M3.5 14.5a6.5 6.5 0 0 1 13 0"/><path d="M10 14.5l3.25-4.25"/>',
  };
  const glyph = (job, extra = '') => `<span class="job-glyph k-${kindOf(job)}${extra ? ` ${extra}` : ''}" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[kindOf(job)]}</svg></span>`;
  /** A query's look: a database. */
  const queryGlyph = (extra = 'small') => `<span class="job-glyph k-data ${extra}" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="10" cy="5" rx="5.5" ry="2.25"/><path d="M4.5 5v10c0 1.25 2.46 2.25 5.5 2.25s5.5-1 5.5-2.25V5"/><path d="M4.5 10c0 1.25 2.46 2.25 5.5 2.25s5.5-1 5.5-2.25"/></svg></span>`;
  const clock = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  /** How long something has run: "just now", "4 min", "1 h 5 min". */
  function sinceWords(iso) {
    const started = new Date(iso).getTime();
    if (!Number.isFinite(started)) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - started) / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  }

  const deps = {
    api: null, renderMessage: null, createBubble: null, hydrate: null, onViewChange: null, setStreaming: null,
    mainModelKey: () => '', toolEffects: () => {},
  };
  const state = {
    jobs: [], recent: [], version: -1, loaded: false,
    drawerOpen: false, menuOpen: false,
    viewId: null, view: null,
    live: new Map(), // turnKey → { jobId, info, events, bubble }
    activity: new Map(), // job id → what its turn does now, for the pill's preview (kept after the turn ends)
    ownerTurns: new Set(), // jobs with an owner reply streaming in this tab
    cardCache: new Map(), // job id → job (cards for jobs no longer listed)
    answering: new Set(), // jobs the owner just answered from a card (its answers hide at once)
    dismissed: new Set(), // ended jobs whose pill the owner closed
    detailsOpen: false,
    landing: false,
    returnFocus: null,
    timer: null,
    // Running queries (GET /chat/queries): what BotBoy runs, the owner's two-step Stop, and what a failed stop said.
    queries: [], queryWarnings: [], queriesLoaded: false,
    confirmStop: null, stopping: new Set(), queryNotes: new Map(),
    queryTimer: null,
  };
  const byId = (id) => state.jobs.find(job => job.id === id) || state.recent.find(job => job.id === id) || state.cardCache.get(id) || null;
  const $ = (id) => document.getElementById(id);

  function loadDismissed() {
    try {
      const ids = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
      if (Array.isArray(ids)) for (const id of ids) if (JOB_ID_RE.test(String(id))) state.dismissed.add(String(id));
    } catch { /* private mode or a malformed value: nothing dismissed */ }
  }
  function saveDismissed() {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...state.dismissed].slice(-50))); } catch { /* keep it in memory */ }
  }

  // ── Words: what a job is doing, said plainly (the server's phase, never a guess) ──
  const PILL = { working: 'Working', continuing: 'Working', waiting: 'Waiting', provider_wait: 'Waiting', needs_owner: 'Needs you', stuck: 'Stuck', paused: 'Paused' };
  const ENDED_PILL = { done: 'Done', stopped: 'Stopped', expired: 'Ended', blocked: 'Ended' };
  const phaseClass = (job) => (job.status !== 'active' ? (job.status === 'done' ? 'done' : 'ended')
    : job.phase === 'needs_owner' ? 'needs' : job.phase === 'stuck' ? 'stuck' : job.phase === 'paused' ? 'paused' : 'working');
  /** A turn of this job is streaming now: an automatic one (GET /chat/live) or the owner's own reply in this tab. */
  const isLiveIn = (jobId) => state.ownerTurns.has(jobId) || [...state.live.values()].some(entry => entry.jobId === jobId);
  /** The pill's tone: its border and dot. */
  function toneOf(job) {
    if (job.status !== 'active') return job.status === 'done' ? 'done' : 'ended';
    if (job.phase === 'needs_owner') return 'needs';
    if (job.phase === 'stuck') return 'stuck';
    if (job.phase === 'paused') return 'paused';
    if (isLiveIn(job.id)) return 'running';
    return job.phase === 'waiting' || job.phase === 'provider_wait' ? 'waiting' : 'running';
  }

  /** What a job waits for, in the owner's words: the server names each wait (its label); a time it set reads as its clock time. */
  function waitWords(run) {
    if (run.kind === 'time' && run.at) return `until ${clock(run.at)}`;
    if (run.label) return `for ${run.label}`;
    return run.purpose ? `for the Datanet run: ${run.purpose}` : 'for the Datanet run';
  }
  function runsLine(job) {
    const runs = Array.isArray(job.waitingRuns) ? job.waitingRuns : [];
    if (!runs.length) return 'Waiting';
    return `Waiting ${waitWords(runs[0])}${runs.length > 1 ? `, and ${runs.length - 1} more` : ''}`;
  }

  /** One line for a list row or a card. */
  function lineOf(job) {
    if (job.status !== 'active') {
      if (job.status === 'done') return `Finished ${clock(job.endedAt)}`.trim();
      return job.status === 'stopped' ? 'Stopped' : 'Ended after a day with nothing to do';
    }
    switch (job.phase) {
      case 'needs_owner': return job.pauseNote || 'Needs your answer';
      case 'stuck': return `Stuck: ${job.pauseNote || 'it could not get past a problem'}`;
      case 'paused': return job.pauseNote || 'Paused';
      case 'waiting': return runsLine(job);
      case 'provider_wait': return `Waiting its turn: the AI provider asked BotBoy to slow down${job.providerWaitUntil ? ` (until ${clock(job.providerWaitUntil)})` : ''}`;
      case 'continuing': return job.nextStep ? `Next: ${job.nextStep}` : 'About to take its next step';
      default: return job.nextStep || 'Working';
    }
  }

  /** The job sheet's "now" line for a job that is not running: how it ended, or what it needs. An ended job says how to pick it up. */
  function nowOf(job) {
    if (job.status === 'done') return job.endReason && job.endReason !== 'done' ? job.endReason : `Finished ${clock(job.endedAt)}`;
    if (job.status === 'stopped') return `You stopped it${job.endedAt ? ` at ${clock(job.endedAt)}` : ''}. Send a message here to pick it up again.`;
    if (job.status !== 'active') return `${lineOf(job)}. Send a message here to pick it up again.`;
    if (job.phase === 'needs_owner') return 'Waiting for your answer';
    if (job.phase === 'stuck') return 'Stuck. Tell it how to go on, or open the details below.';
    return lineOf(job);
  }

  // ── The preview: what a job's turn is doing right now (its thinking, a tool, its words) ──
  /** A tool's name in the preview: a connector call reads as the connector's own tool (mcp_call_tool → export_query). */
  function toolLabel(activity) {
    if (activity.name === 'mcp_call_tool') {
      const inner = /"toolName"\s*:\s*"([^"]{1,60})"/.exec(activity.args || '');
      if (inner) return inner[1];
    }
    return activity.name || 'a tool';
  }
  /** One stream event (the same events the chat bubble draws) moves the job's preview on. */
  function noteActivity(jobId, event) {
    if (!JOB_ID_RE.test(jobId || '') || !event || typeof event !== 'object') return;
    let now = state.activity.get(jobId);
    if (!now || now.ended) {
      now = { kind: 'start', text: '', name: '', args: '', ended: false };
      state.activity.set(jobId, now);
    }
    switch (event.type) {
      case 'thinking':
        if (now.kind !== 'thinking') { now.kind = 'thinking'; now.text = ''; }
        now.text = `${now.text}${event.text || ''}`.slice(-600);
        break;
      case 'token':
        if (now.kind !== 'text') { now.kind = 'text'; now.text = ''; }
        now.text = `${now.text}${event.text || ''}`.slice(-600);
        break;
      case 'status':
        if (now.kind === 'start' || now.kind === 'status') { now.kind = 'status'; now.text = oneLine(event.text); }
        break;
      case 'tool_start':
        Object.assign(now, { kind: 'tool', name: String(event.name || ''), args: '', text: '' });
        break;
      case 'tool_args':
        if (now.kind === 'tool') now.args = `${now.args}${event.text || ''}`.slice(0, 4000);
        break;
      case 'tool':
        if (now.kind !== 'tool' || now.name !== event.name) Object.assign(now, { kind: 'tool', name: String(event.name || ''), args: '', text: '' });
        break;
      case 'tool_result': {
        now.kind = 'tool_done';
        now.name = String(event.name || now.name || '');
        // A plain-words result says what the tool found ("12 presets"); raw JSON reads as noise, so it shows as "done" like
        // the tool card in the chat ("write_file ✓").
        const result = oneLine(event.preview);
        now.text = /^[[{]/.test(result) ? '' : head(result, 90);
        break;
      }
      case 'retry':
        Object.assign(now, { kind: 'status', text: oneLine(event.message) || 'Retrying' });
        break;
      case 'done': {
        const content = typeof event.message?.content === 'string' ? event.message.content : '';
        if (content.trim() && !/\[\[job:/.test(content)) Object.assign(now, { kind: 'text', text: content.slice(-600) });
        now.ended = true;
        break;
      }
      case 'error':
        Object.assign(now, { kind: 'status', text: `The turn failed: ${oneLine(event.error) || 'unknown error'}`, ended: true });
        break;
      default:
        return;
    }
    scheduleDock();
  }
  function activityPreview(now, max) {
    switch (now.kind) {
      case 'thinking': {
        const words = tail(now.text, max - 12);
        return { kind: 'thinking', icon: '💭', html: words ? `<b>Thinking</b> · ${esc(words)}` : '<b>Thinking…</b>', text: words ? `Thinking · ${words}` : 'Thinking…' };
      }
      case 'tool': return { kind: 'tool', icon: '🔧', html: `<b>${esc(toolLabel(now))}</b> · running`, text: `${toolLabel(now)} · running` };
      case 'tool_done': return { kind: 'tool_done', icon: '✓', html: `<b>${esc(toolLabel(now))}</b> · ${esc(now.text || 'done')}`, text: `${toolLabel(now)} · ${now.text || 'done'}` };
      case 'text': { const words = tail(now.text, max); return { kind: 'text', icon: '✍️', html: esc(words), text: words }; }
      default: {
        const words = now.text ? head(now.text, max) : 'Starting its next step';
        return { kind: 'status', icon: '↻', html: esc(words), text: words };
      }
    }
  }
  /** The pill's second line: its question first, then what its turn does now, then what it waits for, then its next step. */
  function previewOf(job, max = 110) {
    const line = (kind, icon, html, text) => ({ kind, icon, html, text });
    if (job.status !== 'active') {
      if (job.status === 'done') {
        const why = job.endReason && job.endReason !== 'done' ? job.endReason : 'its report is in your chat';
        return line('done', '✓', `<b>Finished</b> · ${esc(head(why, max))}`, `Finished · ${why}`);
      }
      const text = job.status === 'stopped' ? `You stopped it${job.endedAt ? ` at ${clock(job.endedAt)}` : ''}` : lineOf(job);
      return line('ended', '■', esc(text), text);
    }
    if (job.phase === 'needs_owner') {
      const note = job.pauseNote || 'Needs your answer';
      return line('ask', '❓', `<b>Asks you:</b> ${esc(head(note, max * 2))}`, `Asks you: ${note}`);
    }
    if (job.phase === 'stuck') {
      const note = job.pauseNote || 'it could not get past a problem';
      return line('stuck', '⚠️', `<b>Stuck:</b> ${esc(head(note, max * 2))}`, `Stuck: ${note}`);
    }
    if (job.phase === 'paused') return line('paused', '⏸', esc(job.pauseNote || 'Paused'), job.pauseNote || 'Paused');
    const now = state.activity.get(job.id);
    if (now && (isLiveIn(job.id) || !now.ended)) return activityPreview(now, max);
    if (job.phase === 'waiting') {
      const runs = Array.isArray(job.waitingRuns) ? job.waitingRuns : [];
      const since = runs[0]?.submittedAt && runs[0]?.kind !== 'time' ? sinceWords(runs[0].submittedAt) : '';
      const text = `${runsLine(job)}${since ? ` · ${since}` : ''}`;
      return line('wait', '⏳', esc(text), text);
    }
    if (job.phase === 'provider_wait') return line('wait', '⏳', esc(lineOf(job)), lineOf(job));
    if (now) return activityPreview(now, max);
    return line('next', '…', esc(lineOf(job)), lineOf(job));
  }
  /** The sheet's now line: the same facts as the pill, a little fuller. */
  function nowText(job) {
    if (job.status === 'active' && !['needs_owner', 'stuck', 'paused'].includes(job.phase)) return previewOf(job, 220).text;
    return nowOf(job);
  }

  /** Writes HTML only when it changed, so a poll never restarts an animation or loses a scroll position. */
  function put(el, html) {
    if (!el || el.__jobsHtml === html) return false;
    el.innerHTML = html;
    el.__jobsHtml = html;
    return true;
  }
  /** setAttribute queues a mutation even for the same value, so write only a change. */
  function setAttr(el, name, value) {
    if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  function setHidden(el, hidden) {
    if (el && el.hidden !== hidden) el.hidden = hidden;
  }
  /** Each class by an explicit boolean: a redraw of the same state changes no attribute, so a running light is never restarted. */
  function setFlags(el, names, on) {
    for (const name of names) if (el.classList.contains(name) !== on.has(name)) el.classList.toggle(name, on.has(name));
  }

  // ── The dock: one pill per job above the composer ──
  /** Every job the dock may show: what runs, and what ended in the last ten minutes that the owner has not dismissed. */
  function dockJobs() {
    const now = Date.now();
    const ended = state.recent.filter(job => !state.dismissed.has(job.id) && !state.jobs.some(active => active.id === job.id)
      && now - new Date(job.endedAt || 0).getTime() < ENDED_PILL_MS);
    return [...state.jobs, ...ended].sort((a, b) => Number(a.number) - Number(b.number));
  }
  /** The pills that show: a job that needs the owner first, then running jobs, then ended ones; drawn in start order. */
  function shownJobs(all) {
    const rank = (job) => (['needs', 'stuck'].includes(toneOf(job)) ? 0 : job.status === 'active' ? 1 : 2);
    return [...all].sort((a, b) => rank(a) - rank(b) || Number(a.number) - Number(b.number)).slice(0, DOCK_PILLS)
      .sort((a, b) => Number(a.number) - Number(b.number));
  }
  /** BotBoy's own queries the dock counts: one running a while, or one only the warehouse still runs; not those of a job shown. */
  function dockQueries(shownIds) {
    return state.queries.filter(query => (query.where !== 'botboy' || Number(query.runningForMs) >= QUERY_DOCK_MS)
      && !(query.jobId && shownIds.has(query.jobId)));
  }
  function dockModel() {
    const all = dockJobs();
    const shown = shownJobs(all);
    const shownIds = new Set(shown.map(job => job.id));
    const hiddenJobs = all.filter(job => !shownIds.has(job.id));
    return { all, shown, hiddenJobs, queries: dockQueries(shownIds) };
  }
  const LEAD = { running: 'Working on:', waiting: 'Waiting:', needs: 'Needs you:', stuck: 'Stuck:', paused: 'Paused:', done: 'Done:' };
  const PILL_FLAGS = ['running', 'waiting', 'needs', 'stuck', 'paused', 'done', 'ended', 'busy', 'has-act', 'act-x'];
  /** The one-pill action: Stop, Answer, Reply or Resume; an ended job's × at every size. */
  function pillAction(job, tone, single) {
    const id = esc(job.id);
    if (tone === 'done' || tone === 'ended') return `<button type="button" class="jobs-icon jobs-dismiss" data-jobs-dismiss="${id}" aria-label="Dismiss #${esc(job.number)}" title="Hide this job">×</button>`;
    if (!single) return '';
    if (tone === 'needs') return `<button type="button" class="button small" data-jobs-open="${id}" data-jobs-focus="1">Answer</button>`;
    if (tone === 'stuck') return `<button type="button" class="button small" data-jobs-open="${id}" data-jobs-focus="1">Reply</button>`;
    if (tone === 'paused') return `<button type="button" class="button small" data-jobs-pill-resume="${id}" title="Let this job continue">Resume</button>`;
    return `<button type="button" class="button small" data-jobs-pill-stop="${id}" title="End this job: BotBoy stops continuing it on its own">Stop</button>`;
  }
  function stateWords(job, tone) {
    const words = {
      running: job.phase === 'continuing' && !isLiveIn(job.id) ? 'continuing shortly' : 'working',
      waiting: 'waiting', needs: 'needs you', stuck: 'stuck', paused: 'paused', done: 'completed', ended: 'not running',
    }[tone];
    // The owner asked to be told on WhatsApp (job-notify.md): the promise stays visible, not only remembered.
    return job.notifyWhatsApp === true && job.status === 'active' ? `${words} · WhatsApp on` : words;
  }
  function pillElement(dock, id) {
    const found = [...dock.querySelectorAll('.job-pill')].find(el => el.dataset.jobPill === id);
    if (found) return found;
    const el = document.createElement('div');
    el.className = 'job-pill';
    el.dataset.jobPill = id;
    el.innerHTML = `<button type="button" class="job-pill-main" data-jobs-open="${esc(id)}"><span class="job-pill-row"><span class="job-pill-dot" aria-hidden="true"></span><span class="job-pill-goal"></span><span class="job-pill-state"></span></span><span class="job-pill-preview"><span class="job-pill-ic" aria-hidden="true"></span><span class="job-pill-tx"></span></span></button><span class="job-pill-act"></span>`;
    return el;
  }
  function drawPill(el, job, single) {
    const tone = toneOf(job);
    const now = state.activity.get(job.id);
    const busy = isLiveIn(job.id) && now && ['thinking', 'tool'].includes(now.kind);
    const action = pillAction(job, tone, single);
    const flags = new Set([tone, ...(busy ? ['busy'] : []), ...(action ? ['has-act'] : []), ...(action && (tone === 'done' || tone === 'ended') ? ['act-x'] : [])]);
    setFlags(el, PILL_FLAGS, flags);
    const lead = tone === 'ended' ? (job.status === 'stopped' ? 'Stopped:' : 'Ended:') : LEAD[tone];
    put(el.querySelector('.job-pill-goal'), `<strong class="job-pill-lead">${esc(lead)} </strong><span class="job-pill-num">#${esc(job.number)}</span>${esc(job.title)}`);
    put(el.querySelector('.job-pill-state'), esc(stateWords(job, tone)));
    put(el.querySelector('.job-pill-act'), action);
    const preview = previewOf(job);
    put(el.querySelector('.job-pill-ic'), esc(preview.icon));
    put(el.querySelector('.job-pill-tx'), preview.html);
    // A new kind of step (thinking, then a tool, then words) eases in; the words of one step do not.
    const line = el.querySelector('.job-pill-preview');
    if (line && el.__previewKind !== preview.kind) {
      if (el.__previewKind !== undefined) { line.classList.remove('fresh'); void line.offsetWidth; line.classList.add('fresh'); }
      el.__previewKind = preview.kind;
    }
    const main = el.querySelector('.job-pill-main');
    setAttr(main, 'aria-label', `#${job.number} ${job.title}, ${stateWords(job, tone)}: ${preview.text}. Open its chat.`);
    setAttr(main, 'title', `#${job.number} ${job.title}\n${preview.text}`);
  }
  function renderDock() {
    const dock = $('chat-jobs-dock');
    if (!dock) return;
    const { all, shown, hiddenJobs, queries } = dockModel();
    setHidden(dock, !shown.length && !queries.length);
    const size = Math.min(shown.length, DOCK_PILLS);
    for (const n of [1, 2, 3]) if (dock.classList.contains(`n${n}`) !== (size === n)) dock.classList.toggle(`n${n}`, size === n);
    const shownIds = new Set(shown.map(job => job.id));
    for (const el of [...dock.querySelectorAll('.job-pill')]) if (!shownIds.has(el.dataset.jobPill)) el.remove();
    shown.forEach((job, index) => {
      const el = pillElement(dock, job.id);
      if (dock.children[index] !== el) dock.insertBefore(el, dock.children[index] || null);
      drawPill(el, job, shown.length === 1);
    });
    let more = dock.querySelector('.jobs-more-btn');
    if (!hiddenJobs.length && !queries.length) { more?.remove(); return; }
    if (!more) {
      more = document.createElement('button');
      more.type = 'button';
      more.className = 'jobs-more-btn';
      more.setAttribute('data-jobs-drawer', '');
    }
    if (dock.lastElementChild !== more) dock.appendChild(more);
    const count = queries.length;
    const queryWords = `${count} ${count === 1 ? 'query' : 'queries'}`;
    const flag = hiddenJobs.some(job => ['needs', 'stuck'].includes(toneOf(job)));
    const wide = !shown.length;
    if (more.classList.contains('wide') !== wide) more.classList.toggle('wide', wide);
    const html = wide
      ? `${queryGlyph('small')}<span>${esc(queryWords)} running</span>`
      : hiddenJobs.length
        ? `+${hiddenJobs.length}<small>${count ? `more · ${esc(queryWords)}` : 'more'}</small>${flag ? '<span class="jobs-more-flag" aria-hidden="true"></span>' : ''}`
        : `${queryGlyph('small')}<small>${esc(queryWords)}</small>`;
    put(more, html);
    const label = [hiddenJobs.length ? `All ${all.length} jobs` : '', count ? `${queryWords} running` : ''].filter(Boolean).join(' and ');
    setAttr(more, 'aria-label', `${label}${flag ? ' (one needs you)' : ''}. ${state.drawerOpen ? 'Hide' : 'Show'} the list.`);
    setAttr(more, 'aria-expanded', state.drawerOpen ? 'true' : 'false');
  }
  /** Live events arrive many times a second: the dock (and an open sheet's now line) redraw at most every 120 ms. */
  let dockTimer = null;
  function scheduleDock() {
    if (dockTimer) return;
    dockTimer = setTimeout(() => {
      dockTimer = null;
      renderDock();
      if (state.drawerOpen) renderDrawer();
      if (state.viewId && state.view) renderNow();
    }, 120);
  }

  /** The one-tap answers; outside the job's own sheet, also a way into it. */
  function answerChips(job, { withOpen = true } = {}) {
    const options = Array.isArray(job.options) ? job.options : [];
    const chips = options.map(option => `<button type="button" class="jobs-chip" data-jobs-answer="${esc(option)}" data-jobs-job="${esc(job.id)}">${esc(option)}</button>`).join('');
    const open = withOpen
      ? `<button type="button" class="jobs-chip ${options.length ? 'ghost' : 'primary'}" data-jobs-open="${esc(job.id)}" data-jobs-focus="1">${options.length ? 'Open job' : 'Answer'}</button>`
      : '';
    return chips || open ? `<div class="jobs-chips">${chips}${open}</div>` : '';
  }

  // ── The drawer: every job and every running query, one line each ──
  function jobRow(job) {
    const preview = previewOf(job, 120);
    return `<button type="button" class="jobs-row" data-jobs-open="${esc(job.id)}"><span class="jobs-dot ${toneOf(job)}" aria-hidden="true"></span><span class="jobs-row-text"><b>${esc(job.title)} <em>#${esc(job.number)}</em></b><span>${preview.html}</span></span><span class="jobs-row-when">${esc(clock(job.createdAt))}</span></button>`;
  }
  function renderDrawer() {
    const drawer = $('chat-jobs-drawer');
    if (!drawer) return;
    showPanel(drawer, state.drawerOpen);
    renderScrim();
    if (!state.drawerOpen) return;
    const attention = state.jobs.filter(job => job.phase === 'needs_owner' || job.phase === 'stuck');
    const running = state.jobs.filter(job => !attention.includes(job));
    const groups = [['Needs you', attention], ['Running', running], ['Finished today', state.recent]]
      .filter(([, jobs]) => jobs.length)
      .map(([name, jobs]) => `<div class="jobs-group">${esc(name)}</div>${jobs.map(jobRow).join('')}`)
      .join('');
    const queries = queriesGroupHtml();
    const counts = [state.jobs.length ? `${state.jobs.length} running` : '', attention.length ? `${attention.length} ${attention.length === 1 ? 'needs' : 'need'} you` : ''].filter(Boolean).join(' · ');
    const title = groups || !queries ? 'Jobs' : 'Running queries';
    put($('chat-jobs-drawer-title'), `${esc(title)}${counts && title === 'Jobs' ? `<small>${esc(counts)}</small>` : ''}`);
    put($('chat-jobs-drawer-list'), `${groups || (queries ? '' : '<p class="jobs-empty">No jobs yet.</p>')}${queries}`
      + `<div class="jobs-sheet-foot">Ask in chat to start a job. Begin a message with #${esc(state.jobs[0]?.number ?? 2)} to talk to that job.</div>`);
  }

  // ── Running queries: BotBoy's own SQL queries and Datanet ETL runs, whoever started them, each with the owner's Stop ──
  function sinceText(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (date.toDateString() === new Date().toDateString()) return time;
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }
  /** Who started it, since when, and where it runs: static words, so a poll redraws nothing until something changes. */
  function queryMeta(query) {
    const parts = [];
    if (query.origin !== 'earlier' && query.startedBy) parts.push(`From ${query.startedBy}`);
    const since = sinceText(query.startedAt);
    if (since) parts.push(`since ${since}`);
    if (query.where === 'warehouse') parts.push('BotBoy lost its connection; the warehouse still runs it');
    if (query.where === 'background') parts.push(`background export${query.exportId ? ` ${query.exportId}` : ''}`);
    if (query.where === 'datanet') parts.push(`Datanet run ${query.runId}${query.remoteStatus ? ` (${String(query.remoteStatus).toLowerCase().replace(/_/g, ' ')})` : ''}`);
    if (query.warehouse?.sessionId) parts.push(`session ${query.warehouse.sessionId}${query.warehouse.queryId ? `, query ${query.warehouse.queryId}` : ''}`);
    const text = parts.join(' · ');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }
  function queryRow(query) {
    const id = esc(query.id);
    let action;
    if (state.stopping.has(query.id)) action = '<span class="jobs-query-busy" role="status">Stopping…</span>';
    else if (state.confirmStop === query.id) {
      action = `<button type="button" class="jobs-chip danger" data-queries-stop="${id}" data-queries-confirm="1">Stop it</button><button type="button" class="jobs-chip ghost" data-queries-keep="${id}">Keep</button>`;
    } else action = `<button type="button" class="jobs-chip ghost" data-queries-stop="${id}" aria-label="Stop: ${esc(query.label)}">Stop</button>`;
    const note = state.queryNotes.get(query.id);
    return `<div class="jobs-query" data-query-id="${id}">${queryGlyph()}<div class="jobs-query-text"><b>${esc(query.label)}</b><span>${esc(queryMeta(query))}</span>`
      + `${query.preview ? `<code title="${esc(query.preview)}">${esc(query.preview)}</code>` : ''}${note ? `<p class="jobs-query-note">${esc(note)}</p>` : ''}</div>`
      + `<div class="jobs-query-act">${action}</div></div>`;
  }
  function queriesGroupHtml() {
    const warnings = state.queryWarnings.map(text => `<p class="jobs-query-warn">${esc(text)}</p>`).join('');
    if (!state.queries.length && !warnings) return '';
    return `<div class="jobs-group">Queries running</div>${state.queries.map(queryRow).join('')}${warnings}`;
  }
  /** What a stop did, for the toast: the server's receipt in a sentence. */
  function stopText(receipt) {
    if (!receipt || typeof receipt !== 'object') return 'Could not reach BotBoy to stop the query.';
    if (receipt.ok && receipt.state === 'stopped') {
      return receipt.verified ? 'Stopped. It no longer runs.' : `Stop sent. ${receipt.nextAction || 'BotBoy could not confirm it yet.'}`;
    }
    if (receipt.ok && receipt.state === 'already_finished') return 'It had already finished.';
    if (receipt.ok && receipt.state === 'still_running') return receipt.nextAction || 'The stop was taken; it still shows as running.';
    return [receipt.error || 'That did not work.', receipt.nextAction].filter(Boolean).join(' ');
  }

  // ── Cards in the main chat: started, stuck, done (drawn from the job's live state) ──
  function resultsList(job) {
    const results = job.results || {};
    const items = [
      ...(results.dashboards || []).map(item => `<a class="jobs-out" href="#/dashboards/${encodeURIComponent(item.dashboardId)}">${esc(item.title || item.dashboardId)}<i>Dashboard</i></a>`),
      ...(results.datasets || []).filter(item => item.datasetId).map(item => `<a class="jobs-out" href="#/data-room/${encodeURIComponent(item.datasetId)}">${esc(item.title || item.datasetId)}<i>Data</i></a>`),
      ...(results.files || []).map(item => `<span class="jobs-out" title="${esc(item.path)}">${esc(String(item.path || '').split('/').pop() || item.path)}<i>${esc(item.label || 'File')}</i></span>`),
    ];
    return items.length ? `<div class="jobs-outs">${items.join('')}</div>` : '';
  }
  const resultsCount = (job) => ['dashboards', 'datasets', 'files'].reduce((sum, key) => sum + (job.results?.[key]?.length || 0), 0);
  /** What the job is doing now, as a badge: its live phase, or how it ended. */
  function stateBadge(job) {
    if (job.status !== 'active') return [ENDED_PILL[job.status] || 'Ended', job.status === 'done' ? 'done' : 'ended'];
    const tone = job.phase === 'needs_owner' ? 'needs' : job.phase === 'stuck' ? 'stuck' : job.phase === 'paused' ? 'ended' : 'run';
    return [PILL[job.phase] || 'Working', tone];
  }
  /**
   * The footer under a job's report, or under a quiet line about a job: the main chat's decision on a job update, or a job that
   * ended idle (PARALLEL_JOBS_PLAN.md §11, §12): which job, what it is doing now, what it made, its next steps while it is done,
   * and its answers while it asks the owner. A next step is the owner's message to the job, as if typed "#N …" in the main chat:
   * it runs in the job's thread and its reply shows here too.
   */
  function updateFootHtml(job, kind) {
    const [badge, tone] = stateBadge(job);
    const top = `<div class="jobs-update-head">${glyph(job, 'small')}<b>#${esc(job.number)} ${esc(job.title)}</b><span class="jobs-badge ${tone}">${esc(badge)}</span>`;
    if (kind !== 'report') {
      // A job that asks the owner something (the main chat left the choice to him, §12) takes the answer right where it asks,
      // unless an answer is already on its way.
      const asks = job.status === 'active' && job.phase === 'needs_owner' && !state.answering.has(job.id);
      if (asks) return `<div class="jobs-update quiet">${top}</div>${answerChips(job)}</div>`;
      return `<div class="jobs-update quiet">${top}<button type="button" class="jobs-chip ghost" data-jobs-open="${esc(job.id)}">Open job</button></div></div>`;
    }
    const steps = job.status === 'done' && Array.isArray(job.nextSteps) ? job.nextSteps : [];
    const chips = steps.map(step => `<button type="button" class="jobs-chip" data-jobs-step="${esc(step)}" data-jobs-job="${esc(job.id)}">${esc(step)}</button>`).join('');
    return `<div class="jobs-update">${top}</div>${resultsList(job)}<div class="jobs-chips">${chips}<button type="button" class="jobs-chip ghost" data-jobs-open="${esc(job.id)}">Open job</button></div></div>`;
  }
  function cardHtml(job, kind) {
    if (!job) return '<em class="jobs-card-missing">This job is no longer available.</em>';
    if (kind === 'report' || kind === 'update' || kind === 'ended') return updateFootHtml(job, kind);
    const top = (badge, tone) => `<div class="jobs-card-head">${glyph(job, 'small')}<b>#${esc(job.number)} ${esc(job.title)}</b><span class="jobs-badge ${tone}">${esc(badge)}</span></div>`;
    if (kind === 'started') {
      const model = job.model?.key && job.model.key !== deps.mainModelKey() && job.model.title ? ` · ${esc(job.model.title)}` : '';
      return `<button type="button" class="jobs-started" data-jobs-open="${esc(job.id)}">${glyph(job, 'round')}<span>Started <b>#${esc(job.number)} ${esc(job.title)}</b>${model}</span><span class="jobs-chev" aria-hidden="true">›</span></button>`;
    }
    if (kind === 'stuck') {
      if (job.status === 'active' && job.phase === 'stuck') {
        return `<div class="jobs-card stuck">${top('Stuck', 'stuck')}<p>${esc(job.pauseNote || 'It could not get past a problem.')}</p><div class="jobs-chips"><button type="button" class="jobs-chip primary" data-jobs-open="${esc(job.id)}" data-jobs-focus="1">Open job</button></div></div>`;
      }
      const now = job.status === 'active' ? 'Back on track' : (ENDED_PILL[job.status] || 'Ended');
      return `<div class="jobs-card">${top(now, job.status === 'active' || job.status === 'done' ? 'done' : 'ended')}<p class="jobs-card-quiet">It was stuck earlier.</p></div>`;
    }
    const summary = job.endReason && job.endReason !== 'done' ? `<p>${esc(job.endReason)}</p>` : '';
    return `<div class="jobs-card done">${top(job.status === 'done' ? 'Done' : (ENDED_PILL[job.status] || 'Ended'), job.status === 'done' ? 'done' : 'ended')}${summary}${resultsList(job)}<div class="jobs-chips"><button type="button" class="jobs-chip ghost" data-jobs-open="${esc(job.id)}">Open job</button></div></div>`;
  }

  /** Draws every job card under `root` (markers app.js expanded) from the current list; unknown jobs are read once. */
  function fillCards(root) {
    for (const card of (root || document).querySelectorAll('.jobs-card-slot[data-job-card-id]')) {
      const id = card.getAttribute('data-job-card-id');
      const kind = card.getAttribute('data-job-card-kind');
      const job = byId(id);
      if (job) { put(card, cardHtml(job, kind)); continue; }
      if (card.dataset.loading === '1' || !deps.api || !JOB_ID_RE.test(id || '')) continue;
      card.dataset.loading = '1';
      void deps.api(`/chat/jobs/${id}`).then((payload) => {
        if (payload?.job) state.cardCache.set(id, payload.job);
        put(card, cardHtml(payload?.job || null, kind));
      }, () => put(card, cardHtml(null, kind)));
    }
  }

  // ── Sheets: the drawer and a job's chat rise over the main chat ──
  /** Opens or closes a sheet; it slides, so it is hidden only once it has left the screen. */
  function showPanel(el, open) {
    if (!el) return;
    if (open) {
      clearTimeout(el.__hideTimer);
      el.__hideTimer = null;
      if (el.hidden) { el.hidden = false; void el.offsetWidth; }
      if (!el.classList.contains('open')) el.classList.add('open');
      setAttr(el, 'aria-hidden', 'false');
    } else if (!el.hidden && !el.__hideTimer) {
      el.classList.remove('open');
      setAttr(el, 'aria-hidden', 'true');
      el.style.transform = '';
      el.__hideTimer = setTimeout(() => { el.__hideTimer = null; if (!el.classList.contains('open')) el.hidden = true; }, SHEET_MS);
    }
  }
  function renderScrim() {
    showPanel($('chat-jobs-scrim'), Boolean(state.viewId) || state.drawerOpen);
  }
  /** The sheets rise up to the panel's header, which stays usable (its model picker sets an open job's model, PJ5). */
  function placeSheets() {
    const panel = $('chat-panel');
    const header = panel?.querySelector('.chat-header');
    if (!panel || !header) return;
    const top = `${Math.round(header.offsetTop + header.offsetHeight)}px`;
    if (top !== '0px' && panel.style.getPropertyValue('--jobs-sheet-top') !== top) panel.style.setProperty('--jobs-sheet-top', top);
  }
  /** Where each piece of the composer lives in the main chat, so it can go back exactly there. */
  const composerHomes = new Map();
  function moveComposer(intoSheet) {
    const slot = $('chat-job-composer');
    if (!slot) return;
    const focused = document.activeElement;
    let refocus = null;
    for (const id of COMPOSER_IDS) {
      const el = $(id);
      if (!el) continue;
      if (focused && el.contains(focused)) refocus = focused;
      if (intoSheet) {
        if (el.parentElement === slot) continue;
        let home = composerHomes.get(id);
        if (!home || !home.isConnected) { home = document.createComment(`composer:${id}`); el.before(home); composerHomes.set(id, home); }
        slot.appendChild(el);
      } else if (el.parentElement === slot) {
        const home = composerHomes.get(id);
        // Its place in the main chat; if that is gone, the end of the panel's chat column (before the sheets).
        if (home?.isConnected) home.parentNode.insertBefore(el, home);
        else $('chat-jobs-scrim')?.before(el);
      }
    }
    if (refocus && document.activeElement !== refocus) refocus.focus?.();
  }

  // ── A job's sheet: its progress, its own thread, the composer ──
  function menuHtml(job) {
    if (!state.menuOpen) return '';
    if (job.status !== 'active') return '<div class="jobs-menu" role="menu"><button type="button" role="menuitem" data-jobs-back>Back to chat</button></div>';
    const pause = job.phase === 'paused'
      ? '<button type="button" role="menuitem" data-jobs-resume>Resume</button>'
      : '<button type="button" role="menuitem" data-jobs-pause>Pause</button>';
    return `<div class="jobs-menu" role="menu">${pause}<hr><button type="button" role="menuitem" class="danger" data-jobs-stop>Stop job</button></div>`;
  }
  function askHtml(job) {
    if (job.status !== 'active') return '';
    if (job.phase === 'needs_owner') {
      const chips = answerChips(job, { withOpen: false });
      return `<div class="jobs-ask"><p>${esc(job.pauseNote || 'This job needs your answer.')}</p>${chips || '<span class="jobs-ask-hint">Answer below.</span>'}</div>`;
    }
    if (job.phase === 'stuck') return `<div class="jobs-ask stuck"><p>${esc(job.pauseNote || 'It could not get past a problem.')}</p><span class="jobs-ask-hint">Reply below with how to go on.</span></div>`;
    return '';
  }
  function detailsHtml(job, activity) {
    const runs = (activity || []).slice(-8).map(run => `${run.runId}${run.purpose ? ` · ${run.purpose}` : ''} · ${run.status === 'pending' ? (run.remoteStatus || 'submitted') : run.status}`);
    const lines = [
      job.nextStep ? `Next step: ${job.nextStep}` : '',
      `Started ${clock(job.createdAt)} · ${plural(job.continuationCount || 0, 'automatic turn')} since your last message`,
      ...runs.map(run => `Run ${run}`),
      job.notifyWhatsApp === true ? 'WhatsApp updates are on' : '',
    ].filter(Boolean);
    const made = resultsCount(job);
    const summary = made ? `${plural(made, 'result')} · details` : 'Details';
    return `<details class="jobs-details"${state.detailsOpen ? ' open' : ''}><summary>${esc(summary)}</summary>${resultsList(job)}<div class="jobs-details-body">${lines.map(line => `<div>${esc(line)}</div>`).join('')}</div></details>`;
  }
  /** The progress block on top of the sheet; its now line is drawn on its own (renderNow), so a token never redraws the rest. */
  function chromeHtml(view) {
    const job = view.job;
    // The owner asked to be told on WhatsApp (job-notify.md): the promise stays visible, not only remembered.
    const meta = [`#${job.number}`, `started ${clock(job.createdAt)}`, job.model?.title || '', job.notifyWhatsApp === true && job.status === 'active' ? 'WhatsApp on' : '']
      .filter(Boolean).join(' · ');
    const pill = job.status === 'active' ? PILL[job.phase] || 'Working' : ENDED_PILL[job.status] || 'Ended';
    const queries = state.queries.filter(query => query.jobId === job.id);
    return `<div class="jobs-progress-head"><span class="jobs-pill ${phaseClass(job)}">${esc(pill)}</span><span class="jobs-view-meta">${esc(meta)}</span></div>`
      + `<p class="jobs-now"></p><div class="jobs-bar ${phaseClass(job)}" aria-hidden="true"></div>${askHtml(job)}`
      + (queries.length ? `<div class="jobs-sec">Queries running</div><div class="jobs-queries">${queries.map(queryRow).join('')}</div>` : '')
      + detailsHtml(job, view.activity);
  }
  /** The open job's sheet carries its pill's travelling light while the job runs (owner request 2026-11-13). */
  function paintSheet() {
    const section = $('chat-job-view');
    if (!section) return;
    const running = Boolean(state.viewId && state.view) && toneOf(state.view.job) === 'running';
    if (section.classList.contains('running') !== running) section.classList.toggle('running', running);
  }
  function renderNow() {
    paintSheet();
    const now = $('chat-job-chrome')?.querySelector('.jobs-now');
    if (!now || !state.view) return;
    const text = nowText(state.view.job);
    if (now.textContent !== text) now.textContent = text;
  }

  function renderView() {
    const section = $('chat-job-view');
    if (!section) return;
    const open = Boolean(state.viewId);
    showPanel(section, open);
    renderScrim();
    paintSheet();
    if (!open) return;
    placeSheets();
    if (!state.view) { put($('chat-job-chrome'), '<p class="jobs-empty">Loading the job…</p>'); return; }
    const job = state.view.job;
    put($('chat-job-title'), `#${esc(job.number)} · ${esc(job.title)}`);
    put($('chat-job-chrome'), chromeHtml(state.view));
    renderNow();
    put($('chat-job-menu'), menuHtml(job));
    setAttr($('chat-job-more'), 'aria-expanded', state.menuOpen ? 'true' : 'false');
    syncThread();
  }

  const threadKeyOf = (view) => `${view.job.id}:${view.history.length}:${view.history.at(-1)?.id || ''}`;
  const messageHtml = (m) => `<div class="chat-msg ${m.role === 'user' ? 'user' : 'assistant'}"${m.id ? ` data-msg-id="${esc(m.id)}"` : ''}>${deps.renderMessage ? deps.renderMessage(m) : esc(m.content)}</div>`;
  const nearBottom = (scroller) => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  function updateNewest() {
    setHidden($('chat-job-newest'), nearBottom($('chat-job-scroll')));
  }
  /**
   * Opening a job lands on its newest message. Pictures and cards can grow the thread for a moment after it is drawn, so the
   * scroller is held at the end for a little while, until the owner scrolls himself.
   */
  function landAtBottom() {
    const scroller = $('chat-job-scroll');
    if (!scroller) return;
    state.landing = true;
    const go = () => { if (state.landing && $('chat-job-scroll') === scroller) scroller.scrollTop = scroller.scrollHeight; updateNewest(); };
    go();
    (window.requestAnimationFrame || ((callback) => setTimeout(callback, 16)))(go);
    setTimeout(go, 150);
    setTimeout(() => { go(); state.landing = false; }, 700);
  }

  /** The thread shows its history; a reply being written stays, and finished bubbles (with their steps) are kept. */
  function syncThread() {
    const thread = $('chat-job-thread');
    const view = state.view;
    if (!thread || !view) return;
    if (thread.querySelector('.streaming-live')) return;
    const key = threadKeyOf(view);
    const prior = thread.__jobsKey;
    if (prior === key) return;
    const scroller = $('chat-job-scroll');
    const fresh = !prior || !prior.startsWith(`${view.job.id}:`);
    // Its first draw, or the first one with its history after the empty placeholder: the owner lands on the newest message.
    const opening = fresh || (prior === `${view.job.id}:0:` && !thread.querySelector('.chat-msg'));
    const following = !opening && nearBottom(scroller);
    thread.__jobsKey = key;
    if (!view.history.length) {
      thread.innerHTML = '<p class="jobs-empty">Messages you send here go to this job only.</p>';
    } else if (fresh || !thread.querySelector('.chat-msg.streaming-frozen')) {
      thread.innerHTML = view.history.map(messageHtml).join('');
    } else {
      // Like the main chat: append only what is not on screen, so a finished bubble keeps its tool steps.
      const ids = new Set([...thread.querySelectorAll('.chat-msg[data-msg-id]')].map(el => el.dataset.msgId));
      const sig = (role, text) => `${role}:${String(text || '').trim().slice(0, 200)}`;
      const sigs = new Set([...thread.querySelectorAll('.chat-msg')].map(el => sig(el.classList.contains('user') ? 'user' : 'assistant', el.textContent)));
      for (const m of view.history) {
        if ((m.id && ids.has(m.id)) || sigs.has(sig(m.role === 'user' ? 'user' : 'assistant', m.content))) continue;
        thread.insertAdjacentHTML('beforeend', messageHtml(m));
      }
    }
    deps.hydrate?.(thread);
    if (!scroller) return;
    if (opening) landAtBottom();
    else if (following) scroller.scrollTop = scroller.scrollHeight;
    updateNewest();
  }

  /** A reply that finished streaming in the open sheet: it joins the history without redrawing the bubble that showed it. */
  function noteMessage(message) {
    if (!message || !state.view) return;
    state.view.history.push(message);
    const thread = $('chat-job-thread');
    if (thread) thread.__jobsKey = threadKeyOf(state.view);
  }

  function renderAll() {
    renderDock();
    renderDrawer();
    renderView();
    fillCards(document.getElementById('chat-messages'));
  }

  // ── Opening a job ──
  async function loadView(id) {
    if (!deps.api) return;
    let payload;
    try { payload = await deps.api(`/chat/jobs/${id}`); } catch { payload = null; }
    if (state.viewId !== id) return;
    if (payload?.job) {
      state.view = { job: payload.job, history: Array.isArray(payload.history) ? payload.history : [], activity: payload.activity || [] };
      state.cardCache.set(id, payload.job);
    } else if (!state.view) {
      state.view = { job: byId(id) || { id, number: '?', title: 'This job', status: 'active', phase: 'paused' }, history: [], activity: [] };
    }
    renderView();
    attachLive(id);
  }

  function openJob(id, { focus = false } = {}) {
    if (!JOB_ID_RE.test(id || '')) return;
    if (!state.viewId) {
      const active = document.activeElement;
      state.returnFocus = active && active !== document.body && $('chat-panel')?.contains(active) ? active : null;
    }
    if (state.viewId !== id) {
      if (state.viewId) detachLive(state.viewId);
      const known = byId(id);
      state.view = known ? { job: known, history: [], activity: [] } : null;
      const thread = $('chat-job-thread');
      if (thread) { thread.innerHTML = ''; thread.__jobsKey = undefined; }
      put($('chat-job-chrome'), '');
    }
    state.viewId = id;
    state.drawerOpen = false;
    state.menuOpen = false;
    moveComposer(true);
    renderAll();
    deps.onViewChange?.(state.view?.job || null);
    void loadView(id).then(() => deps.onViewChange?.(state.view?.job || null));
    void refreshQueries(true);
    setTimeout(() => {
      if (state.viewId !== id) return;
      if (focus) $('chatInput')?.focus();
      else $('chat-job-title')?.focus?.({ preventScroll: true });
    }, 0);
  }

  function closeJob() {
    if (!state.viewId) return;
    detachLive(state.viewId);
    state.viewId = null;
    state.view = null;
    state.menuOpen = false;
    state.landing = false;
    moveComposer(false);
    renderAll();
    deps.onViewChange?.(null);
    const back = state.returnFocus;
    state.returnFocus = null;
    if (back && back.isConnected && !$('chat-jobs-scrim')?.classList.contains('open')) back.focus?.({ preventScroll: true });
  }
  function openDrawer() {
    state.drawerOpen = true;
    state.confirmStop = null;
    renderDock();
    renderDrawer();
    void refresh();
    void refreshQueries(true);
  }
  function closeDrawer() {
    if (!state.drawerOpen) return;
    state.drawerOpen = false;
    state.confirmStop = null;
    renderDock();
    renderDrawer();
  }

  // ── Automatic turns, live: each in its own job's thread (never in the main chat), and in its pill's preview ──
  function liveBubbleFor(entry) {
    const thread = $('chat-job-thread');
    if (!thread || !deps.createBubble) return null;
    thread.querySelector('.jobs-empty')?.remove();
    const bubble = deps.createBubble(thread, {
      scrollEl: $('chat-job-scroll') || thread,
      onToolResult: deps.toolEffects,
      onDone(event) { if (state.view && state.view.job.id === entry.jobId) noteMessage(event.message); },
    });
    bubble.msgEl.classList.add('continuation');
    if (entry.info.note) bubble.handle({ type: 'status', text: entry.info.note });
    for (const event of entry.events) bubble.handle(event);
    return bubble;
  }
  function attachLive(jobId) {
    for (const entry of state.live.values()) if (entry.jobId === jobId && !entry.bubble) entry.bubble = liveBubbleFor(entry);
  }
  function detachLive(jobId) {
    for (const entry of state.live.values()) {
      if (entry.jobId !== jobId || !entry.bubble) continue;
      if (entry.bubble.isLive()) entry.bubble.msgEl.remove();
      entry.bubble = null;
    }
  }
  /** The owner wrote in a job's thread: its automatic turn gives way on the server, so its bubble goes too. */
  function dropLive(jobId) {
    for (const [key, entry] of state.live) {
      if (entry.jobId !== jobId) continue;
      if (entry.bubble?.isLive()) entry.bubble.msgEl.remove();
      state.live.delete(key);
    }
    scheduleDock();
  }
  /** The trigger note of an automatic turn, as the preview's first words ("↻ Continued automatically: run 1 finished."). */
  function continuingWords(note) {
    const rest = oneLine(note).replace(/^↻\s*/, '').replace(/^Continued automatically:?\s*/i, '');
    return rest ? `Continuing · ${rest}` : 'Continuing';
  }

  /** One message from GET /chat/live (chat-continuations.ts › createChatLiveHub). */
  function live(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind === 'begin') {
      const info = payload.info || {};
      if (typeof info.turnKey !== 'string' || !info.turnKey || !JOB_ID_RE.test(info.jobId || '')) return;
      const previous = state.live.get(info.turnKey);
      if (previous && previous.bubble && !previous.bubble.isLive()) return; // already finished on screen
      if (previous?.bubble) previous.bubble.msgEl.remove(); // a replay after a reconnect starts the bubble over
      const entry = { jobId: info.jobId, info, events: [], bubble: null };
      state.live.set(info.turnKey, entry);
      state.activity.set(info.jobId, { kind: 'status', text: continuingWords(info.note), name: '', args: '', ended: false });
      if (state.viewId === info.jobId) entry.bubble = liveBubbleFor(entry);
      scheduleDock();
      scheduleRefresh();
    } else if (payload.kind === 'event') {
      const entry = state.live.get(payload.turnKey);
      if (!entry || !payload.event) return;
      const bulky = ['token', 'thinking', 'tool_args'].includes(payload.event.type);
      if (!bulky || entry.events.length < LIVE_EVENT_CAP) entry.events.push(payload.event);
      entry.bubble?.handle(payload.event);
      noteActivity(entry.jobId, payload.event);
    } else if (payload.kind === 'end') {
      const entry = state.live.get(payload.turnKey);
      state.live.delete(payload.turnKey);
      if (entry) { const now = state.activity.get(entry.jobId); if (now) now.ended = true; }
      if (entry?.bubble?.isLive()) entry.bubble.msgEl.remove(); // the persisted reply arrives with the next read
      scheduleDock();
      scheduleRefresh(true);
    }
  }
  /** The owner's own reply in a job's thread (app.js › sendChat) streams in this tab: the job's pill previews it too. */
  function ownerEvent(jobId, event) {
    if (!JOB_ID_RE.test(jobId || '')) return;
    if (!state.ownerTurns.has(jobId)) {
      state.ownerTurns.add(jobId);
      state.activity.set(jobId, { kind: 'start', text: '', name: '', args: '', ended: false });
    }
    noteActivity(jobId, event);
  }
  function ownerTurnEnded(jobId) {
    if (!state.ownerTurns.delete(jobId)) return;
    const now = state.activity.get(jobId);
    if (now) now.ended = true;
    scheduleDock();
    scheduleRefresh(true);
  }

  // ── Reading the jobs: a poll while the panel is open, and right after anything changes ──
  let refreshTimer = null;
  let refreshing = null;
  function scheduleRefresh(soon = false) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh(); }, soon ? 150 : 400);
  }
  async function refresh() {
    if (!deps.api) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let payload;
      try { payload = await deps.api('/chat/jobs'); } catch { return; }
      if (!payload || !Array.isArray(payload.jobs)) return;
      const active = payload.jobs.filter(job => JOB_ID_RE.test(job?.id || ''));
      const recent = (Array.isArray(payload.recent) ? payload.recent : []).filter(job => JOB_ID_RE.test(job?.id || ''));
      for (const job of state.answering) if (!active.some(entry => entry.id === job && entry.phase === 'needs_owner')) state.answering.delete(job);
      // A job picked up again shows again, even if its earlier pill was dismissed.
      for (const job of active) if (state.dismissed.delete(job.id)) saveDismissed();
      state.jobs = active;
      state.recent = recent;
      state.version = payload.version;
      state.loaded = true;
      if (state.viewId && state.view) state.view.job = byId(state.viewId) || state.view.job;
      renderAll();
      if (state.viewId) await loadView(state.viewId);
    })();
    try { await refreshing; } finally { refreshing = null; }
  }

  /** Reads BotBoy's running queries (fresh: the owner just looked; the server reads the warehouse again). */
  let queriesReading = null;
  async function refreshQueries(fresh = false) {
    if (!deps.api) return;
    if (queriesReading) return queriesReading;
    queriesReading = (async () => {
      let payload;
      try { payload = await deps.api(`/chat/queries${fresh ? '?fresh=1' : ''}`); } catch { return; }
      if (!payload || !Array.isArray(payload.queries)) return;
      state.queries = payload.queries.filter(query => QUERY_ID_RE.test(String(query?.id || '')));
      state.queryWarnings = (Array.isArray(payload.warnings) ? payload.warnings : []).map(String).slice(0, 4);
      state.queriesLoaded = true;
      const listedIds = new Set(state.queries.map(query => query.id));
      if (state.confirmStop && !listedIds.has(state.confirmStop)) state.confirmStop = null;
      for (const id of [...state.queryNotes.keys()]) if (!listedIds.has(id)) state.queryNotes.delete(id);
      renderDock();
      renderDrawer();
      renderView();
    })();
    try { await queriesReading; } finally { queriesReading = null; }
  }

  /** The owner's Stop, after the second tap: the server stops it and checks, and its receipt says what happened. */
  async function stopQuery(id) {
    if (!deps.api || !QUERY_ID_RE.test(id || '') || state.stopping.has(id)) return;
    state.confirmStop = null;
    state.queryNotes.delete(id);
    state.stopping.add(id);
    renderDrawer();
    renderView();
    let receipt = null;
    try { receipt = await deps.api('/chat/queries/stop', { method: 'POST', body: { id } }); } catch { receipt = null; }
    state.stopping.delete(id);
    const text = stopText(receipt);
    // A stop that did not take keeps its words on the row, which is still listed; the toast only points there.
    if (!receipt?.ok) state.queryNotes.set(id, text);
    toast(receipt?.ok ? text : 'The query was not stopped; the list says why.', receipt?.ok ? 4000 : 3200);
    await refreshQueries(true);
    renderDrawer();
    renderView();
  }

  // ── Owner actions ──
  function toast(text, ms = 2600) {
    const el = $('chat-jobs-toast');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /**
   * A one-tap answer from a card in the main chat: an owner message in the job's own thread. The reply is not shown here (it is
   * in the job), but the stream is read to its end, because closing it would stop the turn on the server.
   */
  async function sendInBackground(job, text) {
    const requestId = `jobans-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    state.answering.add(job.id);
    renderDock();
    // A footer that offered the same answers drops them too.
    fillCards(document.getElementById('chat-messages'));
    toast(`Sent to #${job.number}: ${text}`);
    deps.setStreaming?.(job.id, requestId, true);
    try {
      const response = await fetch(`${deps.apiBase}/chat/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, stream: true, requestId, jobId: job.id }),
      });
      if (!response.ok || !response.body) {
        state.answering.delete(job.id);
        let reason = '';
        try { reason = (await response.json())?.error || ''; } catch { /* keep the status */ }
        toast(reason ? `#${job.number}: ${reason}` : `#${job.number} did not take the answer (HTTP ${response.status}).`);
        return;
      }
      const reader = response.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    } catch {
      state.answering.delete(job.id);
      toast(`Could not reach BotBoy to answer #${job.number}.`);
    } finally {
      deps.setStreaming?.(job.id, requestId, false);
      scheduleRefresh(true);
    }
  }

  /**
   * A next step under a job's report: the owner's message to that job, sent from the main chat as "#N <step>" (the server routes
   * it into the job's thread and shows the reply here too). The button goes once the job picks the work up again.
   */
  function step(jobId, text) {
    const job = byId(jobId);
    if (!job || !text || !deps.send) return;
    void deps.send(`#${job.number} ${text}`);
  }

  function answer(jobId, text) {
    const job = byId(jobId);
    if (!job || !text) return;
    // In the job's own sheet the answer is an ordinary message there, so its reply streams into the thread.
    if (state.viewId === jobId && deps.send) { void deps.send(text); return; }
    void sendInBackground(job, text);
  }

  async function control(path, okText, id = state.viewId) {
    if (!id || !deps.api) return;
    state.menuOpen = false;
    renderView();
    try {
      const payload = await deps.api(`/chat/jobs/${id}/${path}`, { method: 'POST' });
      toast(payload?.ok ? okText : (payload?.error || 'That did not work. Try again.'));
    } catch {
      toast('That did not work. Try again.');
    }
    await refresh();
  }

  /** The panel's model picker, while a job is open, sets that job's model: its next turn runs on it (PJ5). */
  async function setModel(key) {
    const job = state.view?.job;
    if (!job || job.status !== 'active' || !deps.api) return false;
    try {
      const payload = await deps.api(`/chat/jobs/${job.id}/model`, { method: 'PUT', body: { model: key || 'default' } });
      if (!payload?.ok || !payload.job) throw new Error(payload?.error || 'not set');
      if (state.view?.job.id === job.id) state.view.job = payload.job;
      toast(`#${job.number} runs on ${payload.job.model?.title || 'the chosen model'} from its next step`);
      renderView();
      return true;
    } catch {
      toast('That model could not be set for this job.');
      return false;
    }
  }

  // ── Clicks, keys and the drag that closes a sheet ──
  function onClick(event) {
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (state.menuOpen && !target.closest('.jobs-menu') && !target.closest('[data-jobs-menu]')) { state.menuOpen = false; renderView(); }
    if (target.closest('#chat-jobs-scrim')) { closeDrawer(); closeJob(); return; }
    const button = target.closest('[data-jobs-open],[data-jobs-drawer],[data-jobs-close],[data-jobs-back],[data-jobs-menu],[data-jobs-pause],[data-jobs-resume],[data-jobs-stop],[data-jobs-pill-stop],[data-jobs-pill-resume],[data-jobs-dismiss],[data-jobs-answer],[data-jobs-step],[data-queries-stop],[data-queries-keep],#chat-job-newest');
    if (!button || !button.closest('#chat-panel')) return;
    const data = button.dataset;
    if (button.id === 'chat-job-newest') {
      const scroller = $('chat-job-scroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      updateNewest();
      return;
    }
    // A query's Stop asks once more in place ("Stop it" / "Keep"); only the second tap stops it.
    if (data.queriesStop !== undefined) {
      if (data.queriesConfirm === '1') { void stopQuery(data.queriesStop); return; }
      state.confirmStop = data.queriesStop;
      renderDrawer();
      renderView();
      return;
    }
    if (data.queriesKeep !== undefined) { state.confirmStop = null; renderDrawer(); renderView(); return; }
    if (data.jobsAnswer !== undefined) { answer(data.jobsJob, data.jobsAnswer); return; }
    if (data.jobsStep !== undefined) { step(data.jobsJob, data.jobsStep); return; }
    if (data.jobsDismiss !== undefined) {
      event.stopPropagation();
      state.dismissed.add(data.jobsDismiss);
      saveDismissed();
      renderDock();
      return;
    }
    if (data.jobsPillStop !== undefined) { void control('stop', 'Stopped. Nothing more will run for this job.', data.jobsPillStop); return; }
    if (data.jobsPillResume !== undefined) { void control('resume', 'Resumed.', data.jobsPillResume); return; }
    if (data.jobsOpen !== undefined) { event.preventDefault(); openJob(data.jobsOpen, { focus: data.jobsFocus === '1' }); return; }
    if (data.jobsDrawer !== undefined) { if (state.drawerOpen) closeDrawer(); else openDrawer(); return; }
    if (data.jobsClose !== undefined) { closeDrawer(); return; }
    if (data.jobsBack !== undefined) { closeJob(); return; }
    if (data.jobsMenu !== undefined) { state.menuOpen = !state.menuOpen; renderView(); return; }
    if (data.jobsPause !== undefined) { void control('pause', 'Paused. It keeps its place.'); return; }
    if (data.jobsResume !== undefined) { void control('resume', 'Resumed.'); return; }
    if (data.jobsStop !== undefined) void control('stop', 'Stopped. Nothing more will run for this job.');
  }
  function onKey(event) {
    if (event.key !== 'Escape') return;
    if (state.confirmStop) { state.confirmStop = null; renderDrawer(); renderView(); return; }
    if (state.menuOpen) { state.menuOpen = false; renderView(); return; }
    if (state.drawerOpen) { closeDrawer(); return; }
    if (!state.viewId) return;
    // Escape in the message box closes the job only while the box is empty: a half-written message is never hidden away.
    if (event.target?.closest?.('#chat-input-area') && String($('chatInput')?.value || '').trim()) return;
    closeJob();
  }
  function onPointerDown(event) {
    const handle = event.target?.closest?.('[data-jobs-drag]');
    if (!handle || event.button > 0 || event.target.closest('button, a, input, textarea, select')) return;
    const sheet = handle.closest('.jobs-sheet-panel');
    if (!sheet || !sheet.classList.contains('open')) return;
    const startY = event.clientY;
    let moved = 0;
    sheet.classList.add('dragging');
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* the drag still follows the pointer while it is over the handle */ }
    const move = (e) => { moved = Math.max(0, e.clientY - startY); sheet.style.transform = `translateY(${moved}px)`; };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      sheet.classList.remove('dragging');
      if (moved > Math.min(120, (sheet.offsetHeight || 480) * 0.25)) {
        if (sheet.id === 'chat-job-view') closeJob(); else closeDrawer();
      }
      sheet.style.transform = '';
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  let listening = false;
  function init(options = {}) {
    Object.assign(deps, options);
    if (!listening) {
      listening = true;
      loadDismissed();
      document.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey);
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('toggle', (event) => {
        if (event.target?.classList?.contains('jobs-details')) state.detailsOpen = event.target.open;
      }, true);
      // The "↓ Newest" button follows the thread's scroll; the owner's own scroll ends the landing on the newest message.
      document.addEventListener('scroll', (event) => { if (event.target?.id === 'chat-job-scroll') updateNewest(); }, true);
      for (const type of ['wheel', 'touchstart', 'keydown']) {
        document.addEventListener(type, (event) => { if (event.target?.closest?.('#chat-job-scroll')) state.landing = false; }, { capture: true, passive: true });
      }
      window.addEventListener('resize', () => { if (state.viewId) placeSheets(); });
    }
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      // Poll while the panel is open, or while anything runs (the dock tells the truth when the panel opens).
      const panelOpen = !document.getElementById('chat-panel')?.classList.contains('hidden');
      if (!document.hidden && (panelOpen || state.jobs.length)) void refresh();
    }, POLL_MS);
    // BotBoy's running queries: read while the panel is open (the server reads the warehouse only for a query BotBoy lost).
    clearInterval(state.queryTimer);
    state.queryTimer = setInterval(() => {
      const panelOpen = !document.getElementById('chat-panel')?.classList.contains('hidden');
      if (!document.hidden && panelOpen) void refreshQueries();
    }, QUERY_POLL_MS);
    void refresh();
    void refreshQueries();
  }

  window.BotBoyJobs = {
    init,
    refresh,
    scheduleRefresh,
    refreshQueries,
    openJob,
    closeJob,
    openDrawer,
    closeDrawer,
    live,
    ownerEvent,
    ownerTurnEnded,
    dropLive,
    fillCards,
    noteMessage,
    setModel,
    currentJobId: () => state.viewId,
    viewJob: () => state.view?.job || null,
    threadElement: () => $('chat-job-thread'),
    // The sheet's thread scroller: a reply's auto-scroll moves this one.
    scrollElement: () => $('chat-job-scroll'),
    numberOf: (id) => byId(id)?.number ?? null,
    hasNumber: (number) => [...state.jobs, ...state.recent].some(job => String(job.number) === String(number)),
    isLive: isLiveIn,
    // For tests: the pure words and markup.
    _test: { state, dockModel, previewOf, lineOf, nowOf, nowText, cardHtml, chromeHtml, kindOf, answerChips, renderAll, renderDock, queryRow, queryMeta, stopText, refreshQueries, toneOf },
  };
})();
