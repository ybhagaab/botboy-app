// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  durationText,
  groupJobsByDay,
  jobRowHtml,
  renderJobsHistoryFilters,
  renderJobsHistoryList,
  renderJobsHistoryPage,
  statusLine,
} from './jobs-history.js';

/**
 * The Jobs page (docs/maps/job-history.md): one quiet line per job, one click to open what it asked, found and made. These
 * pin the low-load shape (nothing but the line until opened; raw query files folded away) and that every job word is escaped.
 */
const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
const h = {
  esc,
  attr: esc,
  icon: (name: string) => `<svg data-icon="${name}"></svg>`,
  pageHead: (eyebrow: string, title: string, subtitle: string) => `<header><small>${esc(eyebrow)}</small><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></header>`,
  markdown: (text: string) => `<div class="md">${esc(text)}</div>`,
};
const NOW = new Date(2026, 10, 14, 15, 0, 0);
const at = (days: number, hour: number, minute = 0) => new Date(2026, 10, 14 - days, hour, minute).toISOString();
const job = (over: Record<string, unknown> = {}) => ({
  id: 'cj_aaaaaaaaaaaaaaaaaaaaaaaa',
  number: 25,
  title: 'Notification permission PRD',
  goal: 'Write a PRD for the notification permission prompt',
  state: 'done',
  startedAt: at(0, 13, 30),
  endedAt: at(0, 14, 8),
  ending: null,
  summary: 'Saved the PRD as a working draft.',
  outputs: [
    { kind: 'document', group: 'made', title: 'Notification PRD', detail: 'Document', href: '#/documents/doc-1' },
    { kind: 'file', group: 'made', title: 'worksheet.csv', detail: 'Table', href: '/api/files/ws/worksheet.csv' },
    { kind: 'drive', group: 'made', title: 'Deck', detail: 'Google Slides', href: 'https://docs.google.com/presentation/d/f1', external: true },
    { kind: 'file', group: 'data', title: 'adhoc_1.tsv', detail: 'Table', href: '/api/files/etl-results/adhoc_1.tsv' },
  ],
  moreOutputs: { made: 0, data: 0 },
  model: 'GPT-5.6 Terra',
  hasThread: true,
  ...over,
});
const dom = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

describe('Jobs page rows', () => {
  it('shows one quiet line until opened: title, number, how it ended, and small counts of what it made', () => {
    const host = dom(jobRowHtml(job(), h, { groupDay: new Date(2026, 10, 14) }));
    const head = host.querySelector('.jobs-history-head')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.querySelector('strong')!.textContent).toBe('Notification permission PRD');
    expect(head.querySelector('.jobs-history-number')!.textContent).toBe('#25');
    expect(head.querySelector('small')!.textContent).toMatch(/^Finished .+ · took 38 min$/);
    // Counts cover made things only (document, Drive file, file), never the raw query files.
    expect([...head.querySelectorAll('.jobs-history-count')].map(count => count.getAttribute('title'))).toEqual(['1 document', '1 Drive file', '1 file']);
    expect(host.querySelector('.jobs-history-detail')).toBeNull();
  });

  it('opens in place with what was asked, what it found, what it made, and one way back into the conversation', () => {
    const host = dom(jobRowHtml(job(), h, { open: true }));
    expect(host.querySelector('.jobs-history-head')!.getAttribute('aria-expanded')).toBe('true');
    expect([...host.querySelectorAll('.jobs-history-section h3')].map(title => title.textContent)).toEqual(['You asked', 'What it found', 'Made']);
    const made = [...host.querySelectorAll('.jobs-outputs .jobs-output')] as HTMLAnchorElement[];
    expect(made.map(link => [link.getAttribute('href'), link.getAttribute('target')])).toEqual([
      ['#/documents/doc-1', null],
      ['/api/files/ws/worksheet.csv', '_blank'],
      ['https://docs.google.com/presentation/d/f1', '_blank'],
    ]);
    for (const link of made.filter(link => link.target)) expect(link.rel).toBe('noopener noreferrer');
    // Raw query results: one folded line.
    const data = host.querySelector('details.jobs-data')!;
    expect(data.hasAttribute('open')).toBe(false);
    expect(data.querySelector('summary')!.textContent).toContain('Data it pulled · 1 file');
    const open = host.querySelector('[data-action="jobs-open-chat"]')!;
    expect(open.textContent).toContain('Open in chat');
    expect(open.getAttribute('data-job-id')).toBe('cj_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(host.querySelector('.jobs-history-foot span')!.textContent).toContain('GPT-5.6 Terra');
  });

  it('escapes every word that came from a job', () => {
    const evil = '<img src=x onerror=alert(1)>"\'';
    const html = jobRowHtml(job({
      title: evil, goal: evil, summary: evil, model: evil,
      outputs: [
        { kind: 'document', group: 'made', title: evil, detail: evil, href: `#/documents/x" onclick="alert(1)` },
        { kind: 'file', group: 'data', title: evil, detail: 'Table', href: '/api/files/a"b' },
      ],
    }), h, { open: true });
    const host = dom(html);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[onclick]')).toBeNull();
    expect(host.querySelector('.jobs-history-head strong')!.textContent).toBe(evil);
    expect(host.querySelector('.jobs-history-goal')!.textContent).toBe(evil);
  });

  it('says Latest for a job still running, Continue in chat for an old job with no thread, and how a stopped job ended', () => {
    expect(dom(jobRowHtml(job({ state: 'running', endedAt: null }), h, { open: true })).querySelector('.jobs-history-section:nth-of-type(2) h3')!.textContent).toBe('Latest');
    expect(dom(jobRowHtml(job({ hasThread: false, number: null }), h, { open: true })).querySelector('[data-action="jobs-open-chat"]')!.textContent).toContain('Continue in chat');
    expect(dom(jobRowHtml(job({ number: null }), h)).querySelector('.jobs-history-number')).toBeNull();
    const stopped = job({ state: 'stopped', ending: 'You stopped it' });
    expect(statusLine(stopped, new Date(2026, 10, 14))).toMatch(/^You stopped it · .+ · took 38 min$/);
    expect(statusLine(job({ state: 'needs_you', endedAt: null }), new Date(2026, 10, 14))).toMatch(/^Needs your answer · started /);
  });

  it('offers Show all only for a long summary, and a note when it made more than it shows', () => {
    expect(dom(jobRowHtml(job(), h, { open: true })).querySelector('[data-action="jobs-summary"]')).toBeNull();
    const long = dom(jobRowHtml(job({ summary: 'word '.repeat(120), moreOutputs: { made: 3, data: 0 } }), h, { open: true }));
    expect(long.querySelector('[data-action="jobs-summary"]')!.textContent).toBe('Show all');
    expect(long.querySelector('.jobs-history-more-note')!.textContent).toContain('And 3 more');
    expect(dom(jobRowHtml(job({ summary: 'word '.repeat(120) }), h, { open: true, fullSummary: true })).querySelector('.jobs-history-summary.is-full')).not.toBeNull();
  });
});

describe('Jobs page list and words', () => {
  it('groups by the day a job started: Today, Yesterday, the last week by day, then months', () => {
    const groups = groupJobsByDay([
      job({ id: 'a', startedAt: at(0, 9) }), job({ id: 'b', startedAt: at(0, 8) }),
      job({ id: 'c', startedAt: at(1, 9) }), job({ id: 'd', startedAt: at(3, 9) }),
      job({ id: 'e', startedAt: at(20, 9) }), job({ id: 'f', startedAt: at(40, 9) }),
    ], NOW);
    // Nov 11 is three days back (its weekday and date); Oct 25 and Oct 5 share one month group, named without the year.
    expect(groups.map(group => [group.label, group.jobs.map(entry => entry.id).join('')])).toEqual([
      ['Today', 'ab'],
      ['Yesterday', 'c'],
      [new Date(2026, 10, 11).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), 'd'],
      [new Date(2026, 9, 1).toLocaleDateString([], { month: 'long' }), 'ef'],
    ]);
    expect(groupJobsByDay([job({ startedAt: new Date(2025, 9, 5).toISOString() })], NOW)[0].label)
      .toBe(new Date(2025, 9, 5).toLocaleDateString([], { month: 'long', year: 'numeric' }));
  });

  it('says how long a job took in plain words', () => {
    const start = '2026-11-14T10:00:00.000Z';
    expect(durationText(start, '2026-11-14T10:00:20.000Z')).toBe('under a minute');
    expect(durationText(start, '2026-11-14T10:38:00.000Z')).toBe('38 min');
    expect(durationText(start, '2026-11-14T12:10:00.000Z')).toBe('2 h 10 min');
    expect(durationText(start, '2026-11-14T13:00:00.000Z')).toBe('3 h');
    expect(durationText(start, '2026-11-17T10:00:00.000Z')).toBe('3 days');
    expect(durationText(start, 'never')).toBe('');
  });

  it('has the right words when there is nothing to show, when a search finds nothing, and when the read failed', () => {
    expect(dom(renderJobsHistoryList({ jobs: [], query: '', status: 'all' }, h)).textContent).toContain('No jobs yet');
    const none = dom(renderJobsHistoryList({ jobs: [], query: 'roadmap', status: 'all' }, h));
    expect(none.textContent).toContain('No jobs match “roadmap”');
    expect(none.querySelector('[data-action="jobs-clear"]')).not.toBeNull();
    const failed = dom(renderJobsHistoryList({ jobs: null, error: 'offline', query: '', status: 'all' }, h));
    expect(failed.querySelector('[data-action="jobs-retry"]')).not.toBeNull();
    expect(dom(renderJobsHistoryList({ jobs: null, query: '', status: 'all' }, h)).querySelector('.jobs-history-loading')).not.toBeNull();
    const more = dom(renderJobsHistoryList({ jobs: [job()], next: 'cursor', query: '', status: 'all', now: NOW }, h));
    expect(more.querySelector('[data-action="jobs-more"]')!.textContent).toBe('Show older jobs');
  });

  it('marks the active filter and shows its count; the page has one search box and one list', () => {
    const filters = dom(renderJobsHistoryFilters({ status: 'done', counts: { all: 120, done: 91, stopped: 28 } }, h));
    expect([...filters.querySelectorAll('button')].map(button => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
      ['All120', 'false'], ['Finished91', 'true'], ['Stopped28', 'false'],
    ]);
    const page = dom(renderJobsHistoryPage({ jobs: [job()], counts: { all: 1, done: 1, stopped: 0 }, query: 'prd', status: 'all', now: NOW }, h));
    expect(page.querySelectorAll('input[data-jobs-search]')).toHaveLength(1);
    expect((page.querySelector('input[data-jobs-search]') as HTMLInputElement).value).toBe('prd');
    expect(page.querySelector('#jobs-history-list')).not.toBeNull();
    expect(page.querySelector('#jobs-history-filters')).not.toBeNull();
    expect(page.querySelector('h1')!.textContent).toBe('Jobs');
  });
});

describe('Jobs page wiring (source)', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');
  it('routes #/jobs, lists Jobs in the sidebar, and refreshes on the chat panel\'s event with no timer of its own', () => {
    const dashboard = read('dashboard.js');
    expect(dashboard).toContain("'nodes', 'jobs'].includes(parts[0])");
    expect(dashboard).toContain("['jobs', 'clock', 'Jobs', '#/jobs', '']");
    // A page opened straight at #/jobs has no route change: its first render starts the read (live-found 2026-11-14).
    expect(dashboard).toMatch(/if \(state\.route\.view === 'jobs'\) \{\s*\/\/[^\n]*\n\s*if \(!state\.jobsHistory\.jobs && !state\.jobsHistory\.loading && !state\.jobsHistory\.error\) void loadJobsHistory\(\);\s*html = renderJobsHistoryPage\(/);
    expect(dashboard).toContain("window.addEventListener('botboy:jobs-changed'");
    const block = dashboard.slice(dashboard.indexOf('// ── Jobs (#/jobs'), dashboard.indexOf('// ── Settings → Knowledge'));
    expect(block).not.toMatch(/setInterval/);
    // The search box is a view filter: its defaultValue follows it, so background repaints are not frozen by it.
    expect(block).toContain('input.defaultValue = input.value;');
  });

  it('links the drawer to the page and announces job changes from the poll it already runs', () => {
    const jobsUi = read('chat-jobs-ui.js');
    expect(jobsUi).toContain('href="#/jobs" data-jobs-history-link');
    expect(jobsUi).toContain("window.dispatchEvent(new CustomEvent('botboy:jobs-changed'))");
  });
});
