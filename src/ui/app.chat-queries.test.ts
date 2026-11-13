// @vitest-environment jsdom
//
// Running queries in the chat panel (chat-jobs-ui.js; docs/maps/query-control.md, owner request 2026-11-12): BotBoy's own SQL
// queries and ETL runs show in the jobs dock above the composer, are listed in the drawer it opens, and in a job's sheet, each with
// the owner's Stop, which asks once more in place. The module is evaluated straight from the shipped source over the real chat
// panel markup.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
const read = (name: string) => readFileSync(path.join(process.cwd(), 'src/ui', name), 'utf8');
const jobsSource = read('chat-jobs-ui.js');
const panelHtml = (() => {
  const html = read('index.html');
  const from = html.indexOf('<aside id="chat-panel"');
  return html.slice(from, html.indexOf('</aside>', from) + '</aside>'.length);
})();
const JOB = 'cj_aaaaaaaaaaaaaaaaaaaaaaaa';
const Q1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const Q2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const job = (over: Record<string, unknown> = {}) => ({
  id: JOB, number: 5, title: 'OTT CX behaviour study', goal: 'Study', status: 'active', phase: 'needs_owner',
  model: { key: 'team.sol', title: 'GPT-6.1 Sol' }, createdAt: '2026-11-12T01:00:00.000Z', endedAt: null, endReason: null,
  continuationCount: 0, nextStep: null, pauseNote: 'Please stop query 354627800.', options: [], providerWaitUntil: null,
  waitingRuns: [], finishedRuns: 0, results: { files: [], datasets: [], dashboards: [] }, notifyWhatsApp: false, ...over,
});
const query = (over: Record<string, unknown> = {}) => ({
  id: Q1, kind: 'sql', origin: 'main', label: 'Revenue by week', preview: 'SELECT week, SUM(revenue) FROM orders GROUP BY 1',
  startedAt: new Date().toISOString(), runningForMs: 120_000, where: 'botboy', startedBy: 'the main chat', ...over,
});
let jobs: any;
let listPayload: any;
let queriesPayload: any;
let stopReceipt: any;
let apiCalls: Array<{ path: string; opts?: any }>;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const dock = () => document.getElementById('chat-jobs-dock') as HTMLElement;
const more = () => dock().querySelector('.jobs-more-btn') as HTMLButtonElement;
const sheet = () => document.getElementById('chat-jobs-drawer') as HTMLElement;
const row = (id: string) => document.querySelector(`.jobs-query[data-query-id="${id}"]`) as HTMLElement | null;
const click = (el: Element | null) => { (el as HTMLElement).click(); return flush(); };
beforeAll(() => {
  // eslint-disable-next-line no-new-func
  new Function(jobsSource)();
  jobs = (window as any).BotBoyJobs;
});
beforeEach(async () => {
  document.body.innerHTML = panelHtml;
  document.getElementById('chat-panel')!.classList.remove('hidden');
  listPayload = { jobs: [], recent: [], version: 1 };
  queriesPayload = { available: true, queries: [], warnings: [], checkedAt: new Date().toISOString() };
  stopReceipt = { ok: true, id: Q1, kind: 'sql', state: 'stopped', verified: true };
  apiCalls = [];
  const t = jobs._test.state;
  Object.assign(t, { jobs: [], recent: [], loaded: false, drawerOpen: false, menuOpen: false, viewId: null, view: null, queries: [], queryWarnings: [], confirmStop: null });
  t.live.clear(); t.activity.clear(); t.ownerTurns.clear(); t.cardCache.clear(); t.answering.clear(); t.stopping.clear(); t.queryNotes.clear(); t.dismissed.clear();
  jobs.init({
    api: async (p: string, opts?: any) => {
      apiCalls.push({ path: p, opts });
      if (p === '/chat/jobs') return listPayload;
      if (p.startsWith('/chat/queries/stop')) return stopReceipt;
      if (p.startsWith('/chat/queries')) return queriesPayload;
      const one = /^\/chat\/jobs\/(cj_[a-f0-9]{24})$/.exec(p);
      if (one) return { job: listPayload.jobs.find((entry: any) => entry.id === one[1]), history: [], activity: [] };
      return {};
    },
    apiBase: '/api',
    renderMessage: (m: any) => String(m.content),
    hydrate: () => {},
    mainModelKey: () => 'team.sol',
  });
  await flush();
});

describe('the dock counts BotBoy\'s running queries', () => {
  it('shows a query the warehouse still runs, or one running a while, even with no jobs; never a quick one', async () => {
    queriesPayload.queries = [query({ runningForMs: 5_000 })];
    await jobs.refreshQueries();
    expect(dock().hidden).toBe(true);
    queriesPayload.queries = [query({ runningForMs: 45_000 })];
    await jobs.refreshQueries();
    expect(dock().hidden).toBe(false);
    expect(more().classList.contains('wide')).toBe(true);
    expect(more().textContent).toBe('1 query running');
    expect(more().getAttribute('aria-label')).toBe('1 query running. Show the list.');
    queriesPayload.queries = [query({ runningForMs: 1_000, where: 'warehouse' }), query({ id: Q2, runningForMs: 1_000 })];
    await jobs.refreshQueries();
    expect(more().textContent).toBe('1 query running');
  });

  it('beside the jobs\' pills, counts the queries no pill already shows (a job\'s own query is in its sheet)', async () => {
    listPayload.jobs = [job({ phase: 'working' })];
    queriesPayload.queries = [query(), query({ id: Q2, where: 'warehouse' }), query({ id: 'etl:9', kind: 'etl', where: 'datanet', runId: '9', jobId: JOB })];
    await jobs.refresh();
    await jobs.refreshQueries();
    expect(dock().querySelectorAll('.job-pill')).toHaveLength(1);
    expect(more().classList.contains('wide')).toBe(false);
    expect(more().textContent).toBe('2 queries');
    expect(more().getAttribute('aria-label')).toBe('2 queries running. Show the list.');
  });
});

describe('the list: every running query, with who started it and a Stop that asks once more', () => {
  it('opening the list reads the queries fresh, and shows each with its words, its SQL and the warnings', async () => {
    queriesPayload.queries = [query({ runningForMs: 60_000 }), query({
      id: 'earlier:1073826734', origin: 'earlier', label: 'A SQL query BotBoy sent before it labelled its queries', where: 'warehouse',
      warehouse: { sessionId: 1073826734, queryId: 354627800 }, startedBy: 'BotBoy, before it labelled its queries (so who started it is not known)',
      startedAt: '2026-11-11T19:18:20.000Z', preview: 'WITH tmp_win AS (SELECT 1)',
    })];
    queriesPayload.warnings = ['Datanet did not answer for 1 ETL run; it is listed as still running.'];
    await jobs.refreshQueries();
    await click(more());
    expect(apiCalls.some(call => call.path === '/chat/queries?fresh=1')).toBe(true);
    expect(sheet().hidden).toBe(false);
    expect(sheet().classList.contains('open')).toBe(true);
    expect(document.getElementById('chat-jobs-drawer-title')!.textContent).toBe('Running queries');
    expect(sheet().textContent).toContain('Queries running');
    expect(row(Q1)!.textContent).toContain('Revenue by week');
    expect(row(Q1)!.textContent).toContain('From the main chat · since');
    expect(row(Q1)!.querySelector('code')!.textContent).toBe('SELECT week, SUM(revenue) FROM orders GROUP BY 1');
    const earlier = row('earlier:1073826734')!;
    expect(earlier.textContent).toContain('BotBoy lost its connection; the warehouse still runs it');
    expect(earlier.textContent).toContain('session 1073826734, query 354627800');
    expect(earlier.textContent).not.toContain('From BotBoy, before');
    expect(sheet().querySelector('.jobs-query-warn')!.textContent).toContain('Datanet did not answer');
  });

  it('Stop asks once more in place; Keep and Escape take it back; Stop it stops it and says what happened', async () => {
    queriesPayload.queries = [query()];
    await jobs.refreshQueries();
    await click(more());
    await click(row(Q1)!.querySelector('[data-queries-stop]'));
    expect(row(Q1)!.querySelector('[data-queries-confirm="1"]')!.textContent).toBe('Stop it');
    expect(apiCalls.some(call => call.path === '/chat/queries/stop')).toBe(false);
    await click(row(Q1)!.querySelector('[data-queries-keep]'));
    expect(row(Q1)!.querySelector('[data-queries-confirm]')).toBeNull();
    await click(row(Q1)!.querySelector('[data-queries-stop]'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(row(Q1)!.querySelector('[data-queries-confirm]')).toBeNull();
    expect(sheet().classList.contains('open')).toBe(true);
    await click(row(Q1)!.querySelector('[data-queries-stop]'));
    queriesPayload.queries = [];
    await click(row(Q1)!.querySelector('[data-queries-confirm="1"]'));
    await flush();
    const stop = apiCalls.find(call => call.path === '/chat/queries/stop')!;
    expect(stop.opts).toEqual({ method: 'POST', body: { id: Q1 } });
    expect(document.getElementById('chat-jobs-toast')!.textContent).toBe('Stopped. It no longer runs.');
    expect(row(Q1)).toBeNull();
  });

  it('a stop that did not take keeps its reason and next step on the row', async () => {
    queriesPayload.queries = [query()];
    stopReceipt = { ok: false, id: Q1, state: 'still_running', code: 'stop_failed', error: 'The warehouse still runs this query in session 601 after BotBoy asked it to stop.', nextAction: 'Try once more in a minute.' };
    await jobs.refreshQueries();
    await click(more());
    await click(row(Q1)!.querySelector('[data-queries-stop]'));
    await click(row(Q1)!.querySelector('[data-queries-confirm="1"]'));
    await flush();
    expect(row(Q1)!.querySelector('.jobs-query-note')!.textContent).toBe('The warehouse still runs this query in session 601 after BotBoy asked it to stop. Try once more in a minute.');
    expect(document.getElementById('chat-jobs-toast')!.textContent).toBe('The query was not stopped; the list says why.');
  });

  it('escapes everything it shows', async () => {
    queriesPayload.queries = [query({ label: '<img src=x onerror="window.__pwned=1">', preview: '<b>x</b>', startedBy: '<i>y</i>' })];
    await jobs.refreshQueries();
    await click(more());
    expect(row(Q1)!.querySelector('img, b > b, i')).toBeNull();
    expect(row(Q1)!.textContent).toContain('<img src=x');
    expect((window as any).__pwned).toBeUndefined();
  });

  it('ignores an id that is not one of BotBoy\'s query ids', async () => {
    queriesPayload.queries = [query({ id: '"><script>' }), query({ id: 'etl:77', kind: 'etl', where: 'datanet', runId: '77' })];
    await jobs.refreshQueries();
    expect(jobs._test.state.queries.map((entry: any) => entry.id)).toEqual(['etl:77']);
  });
});

describe('a job\'s sheet lists the queries it started', () => {
  it('shows the job\'s own queries with Stop, and no other\'s', async () => {
    listPayload.jobs = [job()];
    queriesPayload.queries = [query({ id: Q1, origin: 'job', jobId: JOB, label: 'Overlap query', startedBy: 'job #5 OTT CX behaviour study' }), query({ id: Q2 })];
    await jobs.refresh();
    jobs.openJob(JOB);
    await flush();
    await flush();
    const chrome = document.getElementById('chat-job-chrome')!;
    expect(chrome.textContent).toContain('Queries running');
    expect(chrome.querySelector(`.jobs-query[data-query-id="${Q1}"]`)).not.toBeNull();
    expect(chrome.querySelector(`.jobs-query[data-query-id="${Q2}"]`)).toBeNull();
    expect(apiCalls.some(call => call.path === '/chat/queries?fresh=1')).toBe(true);
    await click(chrome.querySelector(`[data-queries-stop="${Q1}"]`));
    expect(document.getElementById('chat-job-chrome')!.querySelector('[data-queries-confirm="1"]')).not.toBeNull();
  });
});
