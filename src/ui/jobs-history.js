/*
 * The Jobs page (#/jobs, docs/maps/job-history.md): every job BotBoy ran, newest first, kept for good.
 *
 * Owner request 2026-11-14: "keep them forever, can have output, but add these details aesthetically & in a low cognitive
 * load manner". So the page shows little until asked: one quiet line per job (title, how it ended, small counts of what it
 * made), grouped by day. One click opens a job in place: what the owner asked, what it found, and what it made, each a
 * single click away. The raw query files a job pulled on the way fold into one line of their own.
 *
 * Pure functions from a plain model to HTML strings: no DOM, no network, no storage, no timers. dashboard.js owns the state,
 * the requests and the handlers, and passes its escape, icon and Markdown helpers in, so no job text reaches the page
 * unescaped (the Markdown helper is the chat panel's own, which escapes text and admits only safe links).
 */

const STATE_TEXT = {
  running: 'Running',
  needs_you: 'Needs you',
  done: 'Finished',
  stopped: 'Stopped',
  expired: 'Ended',
};
const KIND_ICON = { document: 'file', dashboard: 'activity', dataset: 'database', file: 'download', drive: 'globe' };
const KIND_ORDER = ['document', 'dashboard', 'dataset', 'drive', 'file'];
const KIND_NAME = {
  document: ['document', 'documents'],
  dashboard: ['dashboard', 'dashboards'],
  dataset: ['dataset', 'datasets'],
  drive: ['Drive file', 'Drive files'],
  file: ['file', 'files'],
};
export const JOBS_HISTORY_FILTERS = [['all', 'All'], ['done', 'Finished'], ['stopped', 'Stopped']];

const plural = (count, [one, many]) => `${count} ${count === 1 ? one : many}`;
const time = date => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** "38 min", "2 h 10 min", "3 days"; empty when either end is unknown. */
export function durationText(startIso, endIso) {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** A moment as the list says it: the time when it is on the row's own day, the date and time otherwise. */
function momentText(iso, groupDate) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (groupDate && dayKey(date) === dayKey(groupDate)) return time(date);
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time(date)}`;
}

/**
 * Groups by the day a job started: Today, Yesterday, the last week by weekday and date, then whole months. Jobs keep their
 * order (newest first); a group is one card on the page.
 */
export function groupJobsByDay(jobs, now = new Date()) {
  const groups = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const job of jobs) {
    const started = new Date(job.startedAt);
    if (Number.isNaN(started.getTime())) continue;
    const day = new Date(started.getFullYear(), started.getMonth(), started.getDate());
    const daysAgo = Math.round((today - day) / 86_400_000);
    let key;
    let label;
    if (daysAgo <= 0) { key = 'today'; label = 'Today'; }
    else if (daysAgo === 1) { key = 'yesterday'; label = 'Yesterday'; }
    else if (daysAgo < 7) { key = dayKey(day); label = day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }); }
    else {
      key = `${day.getFullYear()}-${day.getMonth()}`;
      label = day.getFullYear() === now.getFullYear()
        ? day.toLocaleDateString([], { month: 'long' })
        : day.toLocaleDateString([], { month: 'long', year: 'numeric' });
    }
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.jobs.push(job);
    else groups.push({ key, label, day: daysAgo < 7 ? day : null, jobs: [job] });
  }
  return groups;
}

/** The row's one quiet line: how it ended (or that it runs) and when, with how long it took. */
export function statusLine(job, groupDay) {
  const started = momentText(job.startedAt, groupDay);
  if (job.state === 'running') return `Running · started ${started}`;
  if (job.state === 'needs_you') return `Needs your answer · started ${started}`;
  const ended = job.endedAt ? momentText(job.endedAt, groupDay) : '';
  const took = job.endedAt ? durationText(job.startedAt, job.endedAt) : '';
  const lead = job.state === 'done' ? `Finished${ended ? ` ${ended}` : ''}` : `${job.ending || STATE_TEXT[job.state] || 'Ended'}${ended ? ` · ${ended}` : ''}`;
  return took ? `${lead} · took ${took}` : lead;
}

/** Small icon counts of what a job made (data files are not counted here: they are a detail). */
function outputCounts(job, h) {
  const counts = new Map();
  for (const output of job.outputs || []) if (output.group !== 'data') counts.set(output.kind, (counts.get(output.kind) || 0) + 1);
  const more = job.moreOutputs?.made || 0;
  const parts = KIND_ORDER.filter(kind => counts.has(kind)).map(kind => {
    const count = counts.get(kind);
    return `<span class="jobs-history-count" title="${h.attr(plural(count, KIND_NAME[kind]))}">${h.icon(KIND_ICON[kind], 13)}<span>${count}</span></span>`;
  });
  if (more) parts.push(`<span class="jobs-history-count" title="${h.attr(`${more} more`)}">+${more}</span>`);
  return parts.length ? `<span class="jobs-history-counts" aria-label="${h.attr(`Made ${(job.outputs || []).filter(o => o.group !== 'data').length + more} things`)}">${parts.join('')}</span>` : '';
}

function outputLink(output, h) {
  const body = `<span class="jobs-output-icon">${h.icon(KIND_ICON[output.kind] || 'file', 15)}</span><span class="jobs-output-text"><strong title="${h.attr(output.title)}">${h.esc(output.title)}</strong><small>${h.esc(output.detail)}</small></span>`;
  if (!output.href) return `<div class="jobs-output is-static">${body}</div>`;
  const external = output.external || /^\/api\/files\//.test(output.href);
  return `<a class="jobs-output" href="${h.attr(output.href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${body}<span class="jobs-output-go">${h.icon('arrow-right', 13)}</span></a>`;
}

function madeSection(job, h) {
  const made = (job.outputs || []).filter(output => output.group !== 'data');
  const data = (job.outputs || []).filter(output => output.group === 'data');
  const moreMade = job.moreOutputs?.made || 0;
  const moreData = job.moreOutputs?.data || 0;
  if (!made.length && !data.length) return '';
  const madeHtml = made.length
    ? `<div class="jobs-outputs">${made.map(output => outputLink(output, h)).join('')}</div>${moreMade ? `<p class="jobs-history-more-note">And ${h.esc(plural(moreMade, ['more', 'more']))}: open the conversation to see them all.</p>` : ''}`
    : '';
  // Raw query results: one line, opened only when wanted.
  const dataCount = data.length + moreData;
  const dataHtml = data.length
    ? `<details class="jobs-data"><summary>${h.icon('database', 13)} Data it pulled · ${h.esc(plural(dataCount, ['file', 'files']))}</summary><div class="jobs-data-list">${data.map(output => `<a href="${h.attr(output.href)}" target="_blank" rel="noopener noreferrer">${h.esc(output.title)}</a>`).join('')}${moreData ? `<span>and ${h.esc(String(moreData))} more</span>` : ''}</div></details>`
    : '';
  return `<section class="jobs-history-section"><h3>Made</h3>${madeHtml}${dataHtml}</section>`;
}

function detailHtml(job, h, options) {
  const summaryHtml = job.summary
    ? (h.markdown ? h.markdown(job.summary) : `<p>${h.esc(job.summary)}</p>`)
    : '';
  const fullSummary = options.fullSummary;
  const summary = summaryHtml
    ? `<section class="jobs-history-section"><h3>${job.state === 'running' || job.state === 'needs_you' ? 'Latest' : 'What it found'}</h3><div class="jobs-history-summary ${fullSummary ? 'is-full' : ''}">${summaryHtml}</div>${job.summary.length > 420 ? `<button class="jobs-history-link" type="button" data-action="jobs-summary" data-job-id="${h.attr(job.id)}" aria-expanded="${fullSummary ? 'true' : 'false'}">${fullSummary ? 'Show less' : 'Show all'}</button>` : ''}</section>`
    : '';
  const facts = [
    `Started ${momentText(job.startedAt, null)}`,
    job.model ? h.esc(job.model) : '',
  ].filter(Boolean).join(' · ');
  const open = job.hasThread || job.state === 'running' || job.state === 'needs_you' ? 'Open in chat' : 'Continue in chat';
  return `<div class="jobs-history-detail" id="jobs-detail-${h.attr(job.id)}" role="region" aria-label="${h.attr(job.title)}">`
    + `<section class="jobs-history-section"><h3>You asked</h3><p class="jobs-history-goal">${h.esc(job.goal)}</p></section>`
    + summary
    + madeSection(job, h)
    + `<footer class="jobs-history-foot"><span>${facts}</span><button class="button small" type="button" data-action="jobs-open-chat" data-job-id="${h.attr(job.id)}">${h.icon('message', 14)} ${open}</button></footer>`
    + '</div>';
}

export function jobRowHtml(job, h, options = {}) {
  const open = Boolean(options.open);
  const number = job.number ? `<span class="jobs-history-number">#${h.esc(String(job.number))}</span>` : '';
  return `<article class="jobs-history-row state-${h.attr(job.state)} ${open ? 'is-open' : ''}" data-job-row="${h.attr(job.id)}">`
    + `<button class="jobs-history-head" type="button" data-action="jobs-toggle" data-job-id="${h.attr(job.id)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="jobs-detail-${h.attr(job.id)}">`
    + `<span class="jobs-history-dot" aria-hidden="true"></span>`
    + `<span class="jobs-history-main"><span class="jobs-history-title"><strong title="${h.attr(job.title)}">${h.esc(job.title)}</strong>${number}</span><small>${h.esc(statusLine(job, options.groupDay))}</small></span>`
    + outputCounts(job, h)
    + `<span class="jobs-history-chevron" aria-hidden="true">${h.icon('chevron-down', 15)}</span>`
    + '</button>'
    + (open ? detailHtml(job, h, options) : '')
    + '</article>';
}

/** The list under the toolbar: day groups, the older-page button, or the right empty or error words. */
export function renderJobsHistoryList(model, h) {
  if (model.error && !model.jobs) {
    return `<div class="card jobs-history-empty"><p>BotBoy could not read the job history: ${h.esc(model.error)}</p><button class="button small" type="button" data-action="jobs-retry">Try again</button></div>`;
  }
  if (!model.jobs) return '<div class="jobs-history-loading" aria-label="Loading jobs"><div class="skeleton row"></div><div class="skeleton row"></div><div class="skeleton row"></div></div>';
  if (!model.jobs.length) {
    const searching = model.query || model.status !== 'all';
    return `<div class="card jobs-history-empty">${searching
      ? `<p>No jobs match${model.query ? ` “${h.esc(model.query)}”` : ''}.</p><button class="button small" type="button" data-action="jobs-clear">Show all jobs</button>`
      : '<p>No jobs yet. Ask BotBoy for something that takes a while, and it shows up here.</p>'}</div>`;
  }
  const groups = groupJobsByDay(model.jobs, model.now || new Date());
  return groups.map(group => `<section class="jobs-history-group" aria-label="${h.attr(group.label)}"><h2>${h.esc(group.label)}</h2><div class="card jobs-history-card">${group.jobs.map(job => jobRowHtml(job, h, {
    open: model.openId === job.id,
    fullSummary: model.fullSummary === job.id,
    groupDay: group.day,
  })).join('')}</div></section>`).join('')
    + (model.next ? `<div class="jobs-history-older"><button class="button" type="button" data-action="jobs-more" ${model.loadingMore ? 'disabled' : ''}>${model.loadingMore ? 'Loading…' : 'Show older jobs'}</button></div>` : '')
    + (model.error ? `<p class="jobs-history-more-note" role="status">Could not refresh: ${h.esc(model.error)}</p>` : '');
}

export function renderJobsHistoryFilters(model, h) {
  const counts = model.counts || {};
  return JOBS_HISTORY_FILTERS.map(([value, label]) => {
    const active = model.status === value;
    const count = counts[value];
    return `<button class="jobs-history-filter ${active ? 'is-active' : ''}" type="button" data-action="jobs-filter" data-status="${value}" aria-pressed="${active ? 'true' : 'false'}">${h.esc(label)}${Number.isFinite(count) ? `<span>${h.esc(Number(count).toLocaleString())}</span>` : ''}</button>`;
  }).join('');
}

export function renderJobsHistoryPage(model, h) {
  const head = h.pageHead('Work', 'Jobs', 'Everything BotBoy worked on for you, newest first. Jobs are kept for good.');
  return `${head}<div class="jobs-history">`
    + `<div class="jobs-history-toolbar"><label class="jobs-history-search">${h.icon('search', 14)}<span class="visually-hidden">Search jobs</span><input type="search" data-jobs-search value="${h.attr(model.query || '')}" placeholder="Search what you asked or what it found" autocomplete="off"></label>`
    + `<div class="jobs-history-filters" id="jobs-history-filters" role="group" aria-label="Show">${renderJobsHistoryFilters(model, h)}</div></div>`
    + `<div id="jobs-history-list" data-scroll-key="jobs:list">${renderJobsHistoryList(model, h)}</div>`
    + '</div>';
}
