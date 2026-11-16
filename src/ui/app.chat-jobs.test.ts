// @vitest-environment jsdom
//
// Jobs in the chat panel (chat-jobs-ui.js; owner redesign 2026-11-13, the approved demo .agents/tasks/jobs-ui-demo/demo.html):
// the dock of job pills above the composer (one full pill like the single-job strip, then halves, thirds and "+N more"), each
// pill's live preview, the drawer with every job, the job's bottom sheet with its own thread, and the job cards in the main chat.
// The module and the stream bubble are evaluated straight from the shipped sources, over the real chat panel markup from index.html.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const read = (name: string) => readFileSync(path.join(process.cwd(), 'src/ui', name), 'utf8');
const app = read('app.js');
const css = read('dashboard.css');
const jobsSource = read('chat-jobs-ui.js');
const panelHtml = (() => {
  const html = read('index.html');
  const from = html.indexOf('<aside id="chat-panel"');
  return html.slice(from, html.indexOf('</aside>', from) + '</aside>'.length);
})();
function topLevel(name: string): string {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = app.indexOf('\n}\n', start);
  return app.slice(start, end + 2);
}

const JOB_A = 'cj_aaaaaaaaaaaaaaaaaaaaaaaa';
const JOB_B = 'cj_bbbbbbbbbbbbbbbbbbbbbbbb';
const JOB_C = 'cj_cccccccccccccccccccccccc';
const JOB_D = 'cj_dddddddddddddddddddddddd';
const JOB_E = 'cj_eeeeeeeeeeeeeeeeeeeeeeee';
const job = (over: Record<string, unknown> = {}) => ({
  id: JOB_A, number: 1, title: 'Local offline study', goal: 'Study offline usage', status: 'active', phase: 'working',
  model: { key: 'team.sol', title: 'GPT-6.1 Sol' }, createdAt: '2026-10-28T09:02:00.000Z', endedAt: null, endReason: null,
  continuationCount: 0, nextStep: 'Reading the earlier research', pauseNote: null, options: [], providerWaitUntil: null,
  waitingRuns: [], finishedRuns: 0, results: { files: [], datasets: [], dashboards: [] }, notifyWhatsApp: false, ...over,
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

let createChatStreamBubble: (chatEl: Element, hooks?: Record<string, unknown>) => any;
let jobs: any;
let listPayload: { jobs: any[]; recent: any[]; version: number };
let jobPayloads: Record<string, any>;
let apiCalls: Array<{ path: string; opts?: any }>;
let fetchCalls: Array<{ url: string; body: any }>;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const dock = () => document.getElementById('chat-jobs-dock') as HTMLElement;
const pills = () => [...dock().querySelectorAll('.job-pill')] as HTMLElement[];
const pill = (id: string) => dock().querySelector(`.job-pill[data-job-pill="${id}"]`) as HTMLElement;
const sheet = () => document.getElementById('chat-job-view') as HTMLElement;
const drawer = () => document.getElementById('chat-jobs-drawer') as HTMLElement;
const tones = (el: Element) => [...el.classList].filter(name => ['running', 'waiting', 'needs', 'stuck', 'paused', 'done', 'ended'].includes(name));

beforeAll(() => {
  // eslint-disable-next-line no-new-func
  createChatStreamBubble = new Function(
    'formatMarkdownContent', 'hydrateChatCards', 'linkifyRenderedProjectMentions', 'checkChatTerminal', 'requestAnimationFrame',
    [topLevel('escHtml'), topLevel('createChatStreamBubble'), 'return createChatStreamBubble;'].join('\n'),
  )((raw: string) => raw, () => {}, () => {}, async () => {}, (callback: () => void) => callback());
  // eslint-disable-next-line no-new-func
  new Function(jobsSource)();
  jobs = (window as any).BotBoyJobs;
});

beforeEach(async () => {
  document.body.innerHTML = panelHtml;
  document.getElementById('chat-panel')!.classList.remove('hidden');
  localStorage.clear();
  listPayload = { jobs: [], recent: [], version: 1 };
  jobPayloads = {};
  apiCalls = [];
  fetchCalls = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return new Response('data: {"type":"done"}\n\n', { status: 200 });
  });
  const t = jobs._test.state;
  Object.assign(t, { jobs: [], recent: [], loaded: false, drawerOpen: false, menuOpen: false, viewId: null, view: null, landing: false, returnFocus: null });
  t.live.clear(); t.activity.clear(); t.ownerTurns.clear(); t.cardCache.clear(); t.answering.clear(); t.dismissed.clear();
  jobs.init({
    api: async (p: string, opts?: any) => {
      apiCalls.push({ path: p, opts });
      if (p === '/chat/jobs') return listPayload;
      if (p.startsWith('/chat/queries')) return { queries: [], warnings: [] };
      const one = /^\/chat\/jobs\/(cj_[a-f0-9]{24})$/.exec(p);
      if (one) return jobPayloads[one[1]] ?? { error: 'Job not found' };
      return { ok: true, job: jobPayloads[p.split('/')[3]]?.job };
    },
    apiBase: '/api',
    renderMessage: (m: any) => `<div class="content-block">${String(m.content).replace(/</g, '&lt;')}</div>`,
    createBubble: createChatStreamBubble,
    hydrate: () => {},
    mainModelKey: () => 'team.sol',
  });
  await flush();
});

describe('the dock: one pill per job above the composer, as the single-job strip was', () => {
  it('sits right above the composer, where the strip was; the main chat has no capsule or banner', () => {
    const order = [...document.getElementById('chat-panel')!.children].map(el => el.id || el.className);
    expect(order.indexOf('chat-jobs-dock')).toBe(order.indexOf('chat-terminal-dock') + 1);
    expect(order.indexOf('chat-jobs-dock')).toBeLessThan(order.indexOf('chat-input-area'));
    expect(order.indexOf('chat-messages')).toBeLessThan(order.indexOf('chat-jobs-dock'));
    const html = read('index.html');
    for (const gone of ['chat-jobs-bar', 'chat-jobs-capsule', 'chat-jobs-banner', 'chat-jobs-sheet"']) expect(html, gone).not.toContain(gone);
  });

  it('is hidden with no jobs; one job is one full pill with what it works on, its state and Stop', async () => {
    await jobs.refresh();
    expect(dock().hidden).toBe(true);
    listPayload.jobs = [job()];
    await jobs.refresh();
    expect(dock().hidden).toBe(false);
    expect(dock().classList.contains('n1')).toBe(true);
    expect(pills()).toHaveLength(1);
    const one = pill(JOB_A);
    expect(one.querySelector('.job-pill-goal')!.textContent).toBe('Working on: #1Local offline study');
    expect(one.querySelector('.job-pill-state')!.textContent).toBe('working');
    expect(one.querySelector('.job-pill-tx')!.textContent).toBe('Reading the earlier research');
    expect(tones(one)).toEqual(['running']);
    (one.querySelector('[data-jobs-pill-stop]') as HTMLElement).click();
    await vi.waitFor(() => expect(apiCalls.some(call => call.path === `/chat/jobs/${JOB_A}/stop` && call.opts?.method === 'POST')).toBe(true));
    expect(jobs.currentJobId()).toBeNull(); // Stop stops; it does not open the job
  });

  it('two jobs split the row and three take a third each; past three, "+N more" opens the rest', async () => {
    listPayload.jobs = [job(), job({ id: JOB_B, number: 2, title: 'Release note' })];
    await jobs.refresh();
    expect(dock().classList.contains('n2')).toBe(true);
    expect(pills().map(el => el.dataset.jobPill)).toEqual([JOB_A, JOB_B]);
    expect(dock().querySelector('[data-jobs-pill-stop]')).toBeNull(); // Stop lives in the job's sheet once jobs share the row
    listPayload.jobs.push(job({ id: JOB_C, number: 3, title: 'Downloads refresh' }));
    await jobs.refresh();
    expect(dock().classList.contains('n3')).toBe(true);
    expect([...dock().classList].filter(name => /^n\d$/.test(name))).toEqual(['n3']);
    expect(dock().querySelector('.jobs-more-btn')).toBeNull();
    listPayload.jobs.push(job({ id: JOB_D, number: 4, title: 'Fourth' }), job({ id: JOB_E, number: 5, title: 'Fifth' }));
    await jobs.refresh();
    expect(pills()).toHaveLength(3);
    const more = dock().querySelector('.jobs-more-btn') as HTMLButtonElement;
    expect(more.textContent).toBe('+2more');
    expect(dock().lastElementChild).toBe(more);
    expect(more.getAttribute('aria-label')).toBe('All 5 jobs. Show the list.');
    more.click();
    expect(drawer().classList.contains('open')).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });

  it('a job that needs you always gets a pill, never one behind "+N more", and turns its pill yellow', async () => {
    listPayload.jobs = [job(), job({ id: JOB_B, number: 2 }), job({ id: JOB_C, number: 3 }), job({ id: JOB_D, number: 4 }),
      job({ id: JOB_E, number: 5, title: 'Clean up duplicates', phase: 'needs_owner', pauseNote: 'Keep r4 and hide r3?' })];
    await jobs.refresh();
    expect(pills().map(el => el.dataset.jobPill)).toEqual([JOB_A, JOB_B, JOB_E]);
    expect(tones(pill(JOB_E))).toEqual(['needs']);
    expect(pill(JOB_E).querySelector('.job-pill-tx')!.textContent).toBe('Asks you: Keep r4 and hide r3?');
    expect(dock().querySelector('.jobs-more-flag')).toBeNull();
    // More questions than pills: the one behind "+N more" puts a dot on it.
    listPayload.jobs = listPayload.jobs.map(entry => ({ ...entry, phase: 'needs_owner', pauseNote: 'Which?' }));
    await jobs.refresh();
    expect(dock().querySelector('.jobs-more-flag')).not.toBeNull();
    expect(dock().querySelector('.jobs-more-btn')!.getAttribute('aria-label')).toContain('(one needs you)');
  });

  it('each state reads on the border with its one-pill action: Answer, Reply, Resume, and a still ring while waiting', async () => {
    jobPayloads[JOB_A] = { job: job(), history: [], activity: [] };
    listPayload.jobs = [job({ phase: 'needs_owner', pauseNote: 'Short or long?' })];
    await jobs.refresh();
    expect(pill(JOB_A).querySelector('.job-pill-goal')!.textContent).toContain('Needs you:');
    expect(pill(JOB_A).querySelector('.job-pill-state')!.textContent).toBe('needs you');
    (pill(JOB_A).querySelector('.job-pill-act [data-jobs-open]') as HTMLElement).click();
    expect(jobs.currentJobId()).toBe(JOB_A);
    jobs.closeJob();
    listPayload.jobs = [job({ phase: 'stuck', pauseNote: 'Two turns failed.' })];
    await jobs.refresh();
    expect(tones(pill(JOB_A))).toEqual(['stuck']);
    expect(pill(JOB_A).querySelector('.job-pill-act')!.textContent).toBe('Reply');
    listPayload.jobs = [job({ phase: 'paused', pauseNote: 'You paused this job.' })];
    await jobs.refresh();
    expect(tones(pill(JOB_A))).toEqual(['paused']);
    (pill(JOB_A).querySelector('[data-jobs-pill-resume]') as HTMLElement).click();
    await vi.waitFor(() => expect(apiCalls.some(call => call.path === `/chat/jobs/${JOB_A}/resume`)).toBe(true));
    listPayload.jobs = [job({ phase: 'waiting', waitingRuns: [{ runId: 'w_1', kind: 'sql_export', label: 'a SQL export: overlap query', submittedAt: minutesAgo(4) }] })];
    await jobs.refresh();
    expect(tones(pill(JOB_A))).toEqual(['waiting']);
    expect(pill(JOB_A).querySelector('.job-pill-tx')!.textContent).toBe('Waiting for a SQL export: overlap query · 4 min');
    listPayload.jobs = [job({ notifyWhatsApp: true })];
    await jobs.refresh();
    expect(pill(JOB_A).querySelector('.job-pill-state')!.textContent).toBe('working · WhatsApp on');
  });

  it('a job that ended keeps its pill for ten minutes, green only when it finished, with × at every size; × hides it for good', async () => {
    listPayload = { jobs: [job({ id: JOB_B, number: 2 })], recent: [
      job({ status: 'done', phase: null, endedAt: minutesAgo(2) }),
      job({ id: JOB_C, number: 3, status: 'stopped', phase: null, endedAt: minutesAgo(3) }),
      job({ id: JOB_D, number: 4, status: 'done', phase: null, endedAt: minutesAgo(11) }),
    ], version: 2 };
    await jobs.refresh();
    expect(pills().map(el => el.dataset.jobPill)).toEqual([JOB_A, JOB_B, JOB_C]);
    expect(tones(pill(JOB_A))).toEqual(['done']);
    expect(pill(JOB_A).querySelector('.job-pill-tx')!.textContent).toBe('Finished · its report is in your chat');
    expect(tones(pill(JOB_C))).toEqual(['ended']);
    expect(pill(JOB_C).querySelector('.job-pill-goal')!.textContent).toContain('Stopped:');
    expect(pill(JOB_B).querySelector('.job-pill-act')!.textContent).toBe(''); // three share the row: no Stop
    (pill(JOB_A).querySelector('[data-jobs-dismiss]') as HTMLElement).click();
    expect(pills().map(el => el.dataset.jobPill)).toEqual([JOB_B, JOB_C]);
    expect(JSON.parse(localStorage.getItem('botboy.jobs.dismissed.v1') || '[]')).toEqual([JOB_A]);
    expect(jobs.currentJobId()).toBeNull();
    // Picked up again: it shows again.
    listPayload = { jobs: [job(), job({ id: JOB_B, number: 2 })], recent: [], version: 3 };
    await jobs.refresh();
    expect(pills().map(el => el.dataset.jobPill)).toEqual([JOB_A, JOB_B]);
    expect(JSON.parse(localStorage.getItem('botboy.jobs.dismissed.v1') || '[]')).toEqual([]);
  });

  it('redrawing the same state changes nothing in the dock, so the travelling light on a pill is never restarted', async () => {
    listPayload.jobs = [job(), job({ id: JOB_B, number: 2, phase: 'needs_owner', pauseNote: 'Which?' })];
    await jobs.refresh();
    const before = dock().outerHTML;
    const changes: MutationRecord[] = [];
    const watch = new MutationObserver(records => changes.push(...records));
    watch.observe(dock(), { attributes: true, childList: true, subtree: true, characterData: true });
    await jobs.refresh();
    jobs._test.renderDock();
    await flush();
    watch.disconnect();
    expect(changes).toEqual([]);
    expect(dock().outerHTML).toBe(before);
  });

  it('a pill previews what its job does now: its thinking, a tool (a connector call by its own name), its words, and keeps the last after the turn', async () => {
    listPayload.jobs = [job()];
    await jobs.refresh();
    const text = () => pill(JOB_A).querySelector('.job-pill-tx')!.textContent;
    const icon = () => pill(JOB_A).querySelector('.job-pill-ic')!.textContent;
    jobs.live({ kind: 'begin', info: { turnKey: 't1', jobId: JOB_A, note: '↻ Continued automatically: run 1 finished.' } });
    jobs._test.renderDock();
    expect(text()).toBe('Continuing · run 1 finished.');
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'thinking', text: 'September has about 522M events, so it goes out as a background export.' } });
    jobs._test.renderDock();
    expect(icon()).toBe('💭');
    expect(text()).toBe('Thinking · September has about 522M events, so it goes out as a background export.');
    expect(pill(JOB_A).classList.contains('busy')).toBe(true);
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'tool_start', name: 'mcp_call_tool', index: 0 } });
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'tool_args', text: '{"serverId":"sql-context","toolName":"export_query","arguments":{}}' } });
    jobs._test.renderDock();
    expect(text()).toBe('export_query · running');
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'tool_result', name: 'mcp_call_tool', preview: '{"exportId":"e_9k2m","state":"running"}' } });
    jobs._test.renderDock();
    expect(icon()).toBe('✓');
    // A raw JSON result reads as "done", like the tool card in the chat; a plain-words result says what the tool found.
    expect(text()).toBe('export_query · done');
    expect(pill(JOB_A).classList.contains('busy')).toBe(false);
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'tool_start', name: 'run_command', index: 1 } });
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'tool_result', name: 'run_command', preview: 'both=18,512 either=48,210\noverlap=38.40%' } });
    jobs._test.renderDock();
    expect(text()).toBe('run_command · both=18,512 either=48,210 overlap=38.40%');
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'Started the **full-month** export.' } });
    jobs._test.renderDock();
    expect(text()).toBe('Started the full-month export.');
    jobs.live({ kind: 'end', turnKey: 't1' });
    jobs._test.renderDock();
    expect(text()).toBe('Started the full-month export.');
    // A wait the turn left wins over its last words; a question wins over everything.
    listPayload.jobs = [job({ phase: 'waiting', waitingRuns: [{ runId: 'w_1', kind: 'sql_export', label: 'a SQL export: e_9k2m' }] })];
    await jobs.refresh();
    expect(text()).toBe('Waiting for a SQL export: e_9k2m');
    listPayload.jobs = [job({ phase: 'needs_owner', pauseNote: 'Full month or sample?' })];
    await jobs.refresh();
    expect(text()).toBe('Asks you: Full month or sample?');
  });

  it('previews the owner\'s own reply in a job\'s thread too, and escapes what it shows', async () => {
    listPayload.jobs = [job({ phase: 'waiting', waitingRuns: [{ runId: 'w_1', kind: 'file', label: 'the file a.csv' }] })];
    await jobs.refresh();
    jobs.ownerEvent(JOB_A, { type: 'token', text: 'Reading <img src=x onerror="window.__pwned=1">' });
    jobs._test.renderDock();
    expect(tones(pill(JOB_A))).toEqual(['running']);
    expect(pill(JOB_A).querySelector('.job-pill-tx img')).toBeNull();
    expect(pill(JOB_A).querySelector('.job-pill-tx')!.textContent).toContain('Reading <img');
    jobs.ownerTurnEnded(JOB_A);
    jobs._test.renderDock();
    expect(tones(pill(JOB_A))).toEqual(['waiting']);
    expect((window as any).__pwned).toBeUndefined();
  });
});

describe('the drawer: every job and every running query', () => {
  it('lists every job by what needs you, what runs and what finished, and closes with ⌄, Escape or a tap on the dimmed chat', async () => {
    listPayload = {
      jobs: [job(), job({ id: JOB_B, number: 2, title: 'Release <note>', phase: 'needs_owner', pauseNote: 'Short or long?' }), job({ id: JOB_D, number: 4 }), job({ id: JOB_E, number: 5 })],
      recent: [job({ id: JOB_C, number: 3, title: 'Downloads refresh', status: 'done', phase: null, endedAt: minutesAgo(30) })],
      version: 3,
    };
    await jobs.refresh();
    (dock().querySelector('.jobs-more-btn') as HTMLElement).click();
    expect(drawer().hidden).toBe(false);
    expect(drawer().classList.contains('open')).toBe(true);
    expect(document.getElementById('chat-jobs-scrim')!.classList.contains('open')).toBe(true);
    const list = document.getElementById('chat-jobs-drawer-list')!;
    expect([...list.querySelectorAll('.jobs-group')].map(group => group.textContent)).toEqual(['Needs you', 'Running', 'Finished today']);
    expect(list.innerHTML).toContain('Release &lt;note&gt;'); // escaped
    expect(list.querySelector('.jobs-row .jobs-dot.needs')).not.toBeNull();
    expect(document.getElementById('chat-jobs-drawer-title')!.textContent).toBe('Jobs4 running · 1 needs you');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drawer().classList.contains('open')).toBe(false);
    (dock().querySelector('.jobs-more-btn') as HTMLElement).click();
    (drawer().querySelector('[data-jobs-close]') as HTMLElement).click();
    expect(drawer().classList.contains('open')).toBe(false);
    (dock().querySelector('.jobs-more-btn') as HTMLElement).click();
    (document.getElementById('chat-jobs-scrim') as HTMLElement).click();
    expect(drawer().classList.contains('open')).toBe(false);
    // A row opens its job's sheet, and the drawer gives way to it.
    (dock().querySelector('.jobs-more-btn') as HTMLElement).click();
    jobPayloads[JOB_B] = { job: listPayload.jobs[1], history: [], activity: [] };
    (list.querySelector(`[data-jobs-open="${JOB_B}"]`) as HTMLElement).click();
    expect(jobs.currentJobId()).toBe(JOB_B);
    expect(drawer().classList.contains('open')).toBe(false);
    expect(sheet().classList.contains('open')).toBe(true);
  });

  it('says what a waiting job waits for, in the server\'s words, and a time it set as its clock time', async () => {
    const at = '2026-10-28T13:30:00.000Z';
    listPayload = {
      jobs: [
        job({ phase: 'waiting', waitingRuns: [{ runId: 'w_1', kind: 'sql_export', label: 'a SQL export: overlap query' }] }),
        job({ id: JOB_B, number: 2, title: 'Reminder', phase: 'waiting', waitingRuns: [{ runId: 'w_2', kind: 'time', label: 'a time it set', at, submittedAt: minutesAgo(5) }] }),
        job({ id: JOB_C, number: 3, title: 'Two waits', phase: 'waiting', waitingRuns: [
          { runId: '77', kind: 'etl_run', label: 'the Datanet run: weekly players' },
          { runId: 'w_3', kind: 'file', label: 'the file downloads/a.csv' },
        ] }),
        job({ id: JOB_D, number: 4 }),
      ],
      recent: [],
      version: 4,
    };
    await jobs.refresh();
    jobs.openDrawer();
    const lines = [...document.querySelectorAll('#chat-jobs-drawer-list .jobs-row-text > span')].map(el => el.textContent);
    expect(lines).toContain('Waiting for a SQL export: overlap query');
    // A time it set reads as its clock time, never as how long it has waited.
    expect(lines).toContain(`Waiting until ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    expect(lines).toContain('Waiting for the Datanet run: weekly players, and 1 more');
  });
});

describe('the job sheet: a bottom sheet over the main chat, with the job\'s own thread', () => {
  async function openA(over: Record<string, unknown> = {}, history: any[] = []) {
    const current = job(over);
    listPayload.jobs = [current];
    jobPayloads[JOB_A] = { job: current, history, activity: [{ runId: '88412', purpose: 'weekly', status: 'pending', remoteStatus: 'EXECUTING' }] };
    await jobs.refresh();
    jobs.openJob(JOB_A);
    await vi.waitFor(() => expect(document.getElementById('chat-job-title')!.textContent).toBe(`#${current.number} · ${current.title}`));
  }

  it('rises over the main chat (which stays as it is), shows the progress on top and the thread under it, and takes the composer along', async () => {
    await openA({ results: { files: [{ path: '/f/etl-results/adhoc_1.tsv', label: 'ETL run 1' }], datasets: [{ datasetId: 'ds_1', title: 'Cohorts' }], dashboards: [{ dashboardId: 'dash_1', title: 'Offline' }] } },
      [{ id: 'u1', role: 'user', content: 'Leave out test accounts' }, { id: 'a1', role: 'assistant', content: 'Done. 2,140 sessions are out.' }]);
    expect(sheet().hidden).toBe(false);
    expect(sheet().classList.contains('open')).toBe(true);
    expect(sheet().getAttribute('aria-hidden')).toBe('false');
    expect(document.getElementById('chat-jobs-scrim')!.classList.contains('open')).toBe(true);
    // The main chat is not replaced: it stays under the sheet, untouched.
    expect(document.getElementById('chat-messages')!.hidden).toBe(false);
    expect(document.getElementById('chat-panel')!.className).not.toContain('job-view-open');
    const chrome = document.getElementById('chat-job-chrome')!;
    expect(chrome.querySelector('.jobs-pill')!.textContent).toBe('Working');
    expect(chrome.querySelector('.jobs-now')!.textContent).toBe('Reading the earlier research');
    expect(chrome.querySelector('.jobs-view-meta')!.textContent).toBe('#1 · started ' + new Date('2026-10-28T09:02:00.000Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' · GPT-6.1 Sol');
    expect(chrome.querySelector('.jobs-details summary')!.textContent).toBe('3 results · details');
    expect([...chrome.querySelectorAll('.jobs-out')].map(out => out.getAttribute('href'))).toEqual(['#/dashboards/dash_1', '#/data-room/ds_1', null]);
    expect(chrome.querySelector('.jobs-details')!.textContent).toContain('Run 88412 · weekly · EXECUTING');
    const thread = jobs.threadElement();
    expect([...thread.querySelectorAll('.chat-msg')].map((m: Element) => m.textContent)).toEqual(['Leave out test accounts', 'Done. 2,140 sessions are out.']);
    // The composer (and its attachments and terminal) moved into the sheet, and go back on close, where they were.
    const composer = document.getElementById('chat-job-composer')!;
    expect([...composer.children].map(el => el.id)).toEqual(['chat-terminal-dock', 'chat-attach-strip', 'chat-input-area']);
    (document.getElementById('chatInput') as HTMLTextAreaElement).value = 'half a thought';
    jobs.closeJob();
    expect(sheet().classList.contains('open')).toBe(false);
    expect(sheet().getAttribute('aria-hidden')).toBe('true');
    expect(composer.children).toHaveLength(0);
    const order = [...document.getElementById('chat-panel')!.children].map(el => el.id || el.className);
    expect(order.slice(order.indexOf('chat-messages'), order.indexOf('chat-input-area') + 1)).toEqual(['chat-messages', 'chat-terminal-dock', 'chat-jobs-dock', 'assistant-prompts', 'chat-attach-strip', 'chat-input-area']);
    expect((document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('half a thought');
    await vi.waitFor(() => expect(sheet().hidden).toBe(true), { timeout: 1000 });
  });

  it('lands on the newest message, then follows new messages only while the owner reads the end; "↓ Newest" brings him back', async () => {
    // jsdom has no layout: give the thread's scroller a fixed geometry and a writable position.
    const scroller = document.getElementById('chat-job-scroll')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 });
    const history = [{ id: 'u1', role: 'user', content: 'Leave out test accounts' }, { id: 'a1', role: 'assistant', content: 'Done.' }];
    await openA({}, history);
    await vi.waitFor(() => expect(jobs.threadElement().querySelectorAll('.chat-msg')).toHaveLength(2));
    expect(scroller.scrollTop).toBe(1000); // the newest message, not the top of the thread
    expect(document.getElementById('chat-job-newest')!.hidden).toBe(true);
    jobs._test.state.landing = false;
    jobPayloads[JOB_A].history = [...history, { id: 'a2', role: 'assistant', content: 'Next step done.' }];
    scroller.scrollTop = 700; // still at the end
    await jobs.refresh();
    expect(scroller.scrollTop).toBe(1000);
    scroller.scrollTop = 100; // the owner scrolled up to read
    jobPayloads[JOB_A].history = [...jobPayloads[JOB_A].history, { id: 'a3', role: 'assistant', content: 'And another.' }];
    await jobs.refresh();
    expect(jobs.threadElement().querySelectorAll('.chat-msg')).toHaveLength(4);
    expect(scroller.scrollTop).toBe(100);
    const newest = document.getElementById('chat-job-newest') as HTMLButtonElement;
    expect(newest.hidden).toBe(false);
    newest.click();
    expect(scroller.scrollTop).toBe(1000);
    expect(newest.hidden).toBe(true);
    expect(jobs.scrollElement()).toBe(scroller);
  });

  it('collapses with ⌄, a tap on the dimmed chat, a drag down, or Escape (but never hides a half-written message)', async () => {
    await openA();
    (sheet().querySelector('[data-jobs-back]') as HTMLElement).click();
    expect(jobs.currentJobId()).toBeNull();
    await openA();
    (document.getElementById('chat-jobs-scrim') as HTMLElement).click();
    expect(jobs.currentJobId()).toBeNull();
    await openA();
    const grab = sheet().querySelector('.jobs-grab') as HTMLElement;
    grab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100, button: 0 }));
    grab.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 160 }));
    expect(sheet().style.transform).toBe('translateY(60px)');
    grab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 160 }));
    expect(jobs.currentJobId()).toBe(JOB_A); // a short drag snaps back
    expect(sheet().style.transform).toBe('');
    grab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100, button: 0 }));
    grab.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 400 }));
    grab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 400 }));
    expect(jobs.currentJobId()).toBeNull();
    await openA();
    const box = document.getElementById('chatInput') as HTMLTextAreaElement;
    box.value = 'Use the sample';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(jobs.currentJobId()).toBe(JOB_A);
    box.value = '';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(jobs.currentJobId()).toBeNull();
  });

  it('a stopped or expired job says how to pick it up again (a message in its sheet reopens it), never "Stopped" twice', async () => {
    await openA({ status: 'stopped', phase: null, endedAt: '2026-10-29T00:27:50.010Z', endReason: 'stopped by the owner' });
    const chrome = () => document.getElementById('chat-job-chrome')!;
    expect(chrome().querySelector('.jobs-pill')!.textContent).toBe('Stopped');
    expect(chrome().querySelector('.jobs-now')!.textContent).toMatch(/^You stopped it at .+\. Send a message here to pick it up again\.$/);
    jobs.closeJob();
    await openA({ status: 'expired', phase: null, endedAt: '2026-10-29T00:27:50.010Z' });
    expect(chrome().querySelector('.jobs-now')!.textContent).toBe('Ended after a day with nothing to do. Send a message here to pick it up again.');
  });

  it('the now line follows the job\'s turn as it streams, without redrawing the rest of the progress', async () => {
    await openA();
    const chrome = document.getElementById('chat-job-chrome')!;
    const details = chrome.querySelector('.jobs-details');
    jobs.live({ kind: 'begin', info: { turnKey: 't9', jobId: JOB_A, note: '' } });
    jobs.live({ kind: 'event', turnKey: 't9', event: { type: 'tool_start', name: 'run_command', index: 0 } });
    await vi.waitFor(() => expect(chrome.querySelector('.jobs-now')!.textContent).toBe('run_command · running'), { timeout: 1000 });
    expect(chrome.querySelector('.jobs-details')).toBe(details);
  });

  it('carries its pill\'s travelling light only while the job runs: not while it waits, asks or has ended, nor once closed', async () => {
    await openA();
    expect(sheet().classList.contains('running')).toBe(true);
    listPayload.jobs = [job({ phase: 'waiting', waitingRuns: [{ runId: 'w_1', kind: 'file', label: 'the file a.csv' }] })];
    jobPayloads[JOB_A].job = listPayload.jobs[0];
    await jobs.refresh();
    expect(sheet().classList.contains('running')).toBe(false);
    jobs.live({ kind: 'begin', info: { turnKey: 't8', jobId: JOB_A, note: '' } });
    await vi.waitFor(() => expect(sheet().classList.contains('running')).toBe(true), { timeout: 1000 });
    jobs.live({ kind: 'end', turnKey: 't8' });
    listPayload.jobs = [job({ phase: 'needs_owner', pauseNote: 'Which?' })];
    jobPayloads[JOB_A].job = listPayload.jobs[0];
    await jobs.refresh();
    expect(sheet().classList.contains('running')).toBe(false);
    listPayload.jobs = [job()];
    jobPayloads[JOB_A].job = listPayload.jobs[0];
    await jobs.refresh();
    expect(sheet().classList.contains('running')).toBe(true);
    jobs.closeJob();
    expect(sheet().classList.contains('running')).toBe(false);
  });

  it('says WhatsApp is on only for a job that asked to be told (job-notify.md), and only a boolean true shows it', async () => {
    await openA({ notifyWhatsApp: 'yes' });
    const chrome = () => document.getElementById('chat-job-chrome')!;
    expect(chrome().textContent).not.toContain('WhatsApp');
    jobs.closeJob();
    await openA({ notifyWhatsApp: true });
    expect(chrome().querySelector('.jobs-view-meta')!.textContent).toContain('· WhatsApp on');
    expect(chrome().querySelector('.jobs-details')!.textContent).toContain('WhatsApp updates are on');
  });

  it('a question asks with its answers on top of the sheet; a stuck job says how to go on', async () => {
    await openA({ phase: 'needs_owner', pauseNote: 'Short or long?', options: ['Short', 'Long'] });
    const chrome = document.getElementById('chat-job-chrome')!;
    expect(chrome.querySelector('.jobs-pill')!.textContent).toBe('Needs you');
    expect(chrome.querySelector('.jobs-now')!.textContent).toBe('Waiting for your answer');
    expect([...chrome.querySelectorAll('.jobs-ask [data-jobs-answer]')].map(chip => chip.textContent)).toEqual(['Short', 'Long']);
    expect(chrome.querySelector('.jobs-ask [data-jobs-open]')).toBeNull();
    jobPayloads[JOB_A].job = job({ phase: 'stuck', pauseNote: 'Two turns in a row failed.' });
    listPayload.jobs = [jobPayloads[JOB_A].job];
    await jobs.refresh();
    expect(chrome.querySelector('.jobs-ask.stuck')!.textContent).toContain('Two turns in a row failed.');
    expect(chrome.querySelector('.jobs-bar')!.className).toContain('stuck');
  });

  it('the menu pauses, resumes and stops the job through its owner routes', async () => {
    await openA();
    (document.querySelector('[data-jobs-menu]') as HTMLElement).click();
    expect(document.querySelector('.jobs-menu')).not.toBeNull();
    (document.querySelector('[data-jobs-pause]') as HTMLElement).click();
    await vi.waitFor(() => expect(apiCalls.some(call => call.path === `/chat/jobs/${JOB_A}/pause` && call.opts?.method === 'POST')).toBe(true));
    jobPayloads[JOB_A].job = job({ phase: 'paused', pauseNote: 'You paused this job.' });
    listPayload.jobs = [jobPayloads[JOB_A].job];
    await jobs.refresh();
    (document.querySelector('[data-jobs-menu]') as HTMLElement).click();
    (document.querySelector('[data-jobs-resume]') as HTMLElement).click();
    await vi.waitFor(() => expect(apiCalls.some(call => call.path === `/chat/jobs/${JOB_A}/resume`)).toBe(true));
    (document.querySelector('[data-jobs-menu]') as HTMLElement).click();
    (document.querySelector('[data-jobs-stop]') as HTMLElement).click();
    await vi.waitFor(() => expect(apiCalls.some(call => call.path === `/chat/jobs/${JOB_A}/stop`)).toBe(true));
  });

  it('the panel\'s model picker sets the open job\'s model (a PUT with the key, never a string body)', async () => {
    await openA();
    await jobs.setModel('anthropic.sonnet');
    const put = apiCalls.find(call => call.path === `/chat/jobs/${JOB_A}/model`);
    expect(put?.opts).toEqual({ method: 'PUT', body: { model: 'anthropic.sonnet' } });
  });
});

describe('job cards in the main chat, drawn from live state', () => {
  const slot = (id: string, kind: string) => {
    const chat = document.getElementById('chat-messages')!;
    chat.insertAdjacentHTML('beforeend', `<div class="chat-msg assistant job-card-row"><div class="jobs-card-slot" data-job-card-id="${id}" data-job-card-kind="${kind}"></div></div>`);
    return chat.lastElementChild!.firstElementChild as HTMLElement;
  };

  it('a started chip opens its job, and names the model only when it differs from the chat\'s', async () => {
    listPayload.jobs = [job(), job({ id: JOB_B, number: 2, title: 'Release note', model: { key: 'anthropic.sonnet', title: 'Claude Sonnet' } })];
    await jobs.refresh();
    const a = slot(JOB_A, 'started');
    const b = slot(JOB_B, 'started');
    jobs.fillCards(document);
    expect(a.textContent).toBe('Started #1 Local offline study›');
    expect(b.textContent).toContain('Started #2 Release note · Claude Sonnet');
    jobPayloads[JOB_B] = { job: listPayload.jobs[1], history: [], activity: [] };
    (b.querySelector('[data-jobs-open]') as HTMLElement).click();
    expect(jobs.currentJobId()).toBe(JOB_B);
  });

  it('a stuck card asks to open the job while stuck, and goes quiet once the job moves on', async () => {
    listPayload.jobs = [job({ phase: 'stuck', pauseNote: 'The table has no column dt.' })];
    await jobs.refresh();
    const card = slot(JOB_A, 'stuck');
    jobs.fillCards(document);
    expect(card.querySelector('.jobs-card.stuck')!.textContent).toContain('The table has no column dt.');
    listPayload.jobs = [job({ phase: 'working' })];
    await jobs.refresh();
    expect(card.querySelector('.jobs-card.stuck')).toBeNull();
    expect(card.textContent).toContain('Back on track');
  });

  it('a done card carries the summary and what the job made; a job no longer listed is read once', async () => {
    jobPayloads[JOB_C] = { job: job({ id: JOB_C, number: 7, title: 'Downloads refresh', status: 'done', phase: null, endReason: 'All six widgets refreshed', results: { files: [], datasets: [], dashboards: [{ dashboardId: 'dash_9', title: 'OTT Downloads' }] } }) };
    const card = slot(JOB_C, 'done');
    jobs.fillCards(document);
    await vi.waitFor(() => expect(card.querySelector('.jobs-card.done')).not.toBeNull());
    expect(card.textContent).toContain('#7 Downloads refresh');
    expect(card.textContent).toContain('All six widgets refreshed');
    expect(card.querySelector('a.jobs-out')!.getAttribute('href')).toBe('#/dashboards/dash_9');
    expect(apiCalls.filter(call => call.path === `/chat/jobs/${JOB_C}`)).toHaveLength(1);
  });
});

describe('automatic turns, live: in their own job\'s sheet, never in the main chat', () => {
  const begin = (turnKey = 't1') => jobs.live({ kind: 'begin', info: { turnKey, jobId: JOB_A, seq: 1, title: 'Local offline study', goal: 'g', note: '↻ Continued automatically: run 1 finished.', startedAt: 'now' } });

  it('buffers a running turn for a job that is not open, and replays it into the bubble when the job opens', async () => {
    listPayload.jobs = [job()];
    jobPayloads[JOB_A] = { job: job(), history: [], activity: [] };
    await jobs.refresh();
    begin();
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'Reading' } });
    expect(document.querySelector('#chat-messages .chat-msg')).toBeNull();
    jobs.openJob(JOB_A);
    await vi.waitFor(() => expect(jobs.threadElement().querySelector('.chat-msg.assistant.continuation')).not.toBeNull());
    const bubble = jobs.threadElement().querySelector('.chat-msg.assistant.continuation') as HTMLElement;
    expect(bubble.textContent).toContain('Reading');
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'token', text: ' the research' } });
    expect(bubble.textContent).toContain('Reading the research');
    // Events for another turn never reach it.
    jobs.live({ kind: 'event', turnKey: 'other', event: { type: 'token', text: ' WRONG' } });
    expect(bubble.textContent).not.toContain('WRONG');
    // An unfinished turn that ends gives way to the persisted reply.
    jobs.live({ kind: 'end', turnKey: 't1' });
    expect(jobs.threadElement().querySelector('.chat-msg.assistant.continuation')).toBeNull();
  });

  it('a replay after a reconnect starts the bubble over instead of duplicating it; the owner\'s message drops it', async () => {
    listPayload.jobs = [job()];
    jobPayloads[JOB_A] = { job: job(), history: [], activity: [] };
    await jobs.refresh();
    jobs.openJob(JOB_A);
    await flush();
    begin();
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'Part one' } });
    begin();
    jobs.live({ kind: 'event', turnKey: 't1', event: { type: 'token', text: 'Part one' } });
    expect(jobs.threadElement().querySelectorAll('.chat-msg.continuation')).toHaveLength(1);
    expect(jobs.threadElement().textContent.match(/Part one/g)).toHaveLength(1);
    jobs.dropLive(JOB_A);
    expect(jobs.threadElement().querySelectorAll('.chat-msg.continuation')).toHaveLength(0);
    expect(jobs.isLive(JOB_A)).toBe(false);
  });
});

describe('the dock and sheets: the stylesheet', () => {
  const jobsCss = () => {
    const from = css.indexOf('/* ── Jobs in the chat panel');
    const to = css.indexOf('.chat-msg.assistant.continuation', from);
    expect(from, 'missing the jobs block').toBeGreaterThanOrEqual(0);
    return css.slice(from, to);
  };
  const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declarations = (source: string, selector: string): Record<string, string> => {
    const match = source.match(new RegExp(`(?:^|\\n)${escapeRe(selector)} \\{([^}]*)\\}`));
    expect(match, `missing the rule for ${selector}`).not.toBeNull();
    return Object.fromEntries(match![1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]));
  };

  it('a running pill\'s light is painted on a masked 2px ring, so it can only show on the border, and it never blocks a click', () => {
    const ring = declarations(jobsCss(), '.job-pill.running::before');
    expect(ring).toMatchObject({ position: 'absolute', inset: '-1px', padding: '2px', 'pointer-events': 'none', 'mask-composite': 'exclude', animation: 'chat-job-orbit 8s linear infinite' });
    expect(ring.mask).toContain('content-box');
    expect(ring['border-radius']).toBe('inherit');
    expect(declarations(jobsCss(), '.jobs-dock')).toMatchObject({ '--job-run': 'var(--accent)', '--job-pause': 'var(--ring-yellow)', '--job-done': 'var(--green)', '--job-stuck': 'var(--red)' });
  });

  it('the light makes a closed loop through all four corners, and stops while the panel is closed', () => {
    const match = css.match(/@keyframes chat-job-orbit \{([\s\S]*?)\n\}/);
    expect(match, 'missing the keyframes').not.toBeNull();
    const frames = [...match![1].matchAll(/(\d+(?:\.\d+)?)%\s*\{\s*background-position:([^;]+);/g)].map((frame) => [Number(frame[1]), frame[2].trim()] as const);
    expect(frames[0][1]).toBe(frames.at(-1)![1]);
    expect(new Set(frames.map(([, position]) => position)).size).toBe(4);
    expect(declarations(jobsCss(), '#chat-panel.hidden .job-pill.running::before, #chat-panel.hidden .job-pill.busy .job-pill-dot')).toEqual({ 'animation-play-state': 'paused' });
    expect(css).toMatch(/#chat-panel\.hidden \{ transform:translateX\(100%\)/);
  });

  it('only running things move: waiting, needs-you, stuck and done declare no animation, and reduced motion stills everything', () => {
    for (const selector of ['.job-pill.waiting', '.job-pill.needs', '.job-pill.stuck', '.job-pill.done']) expect(declarations(jobsCss(), selector), selector).not.toHaveProperty('animation');
    const media = jobsCss().match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
    expect(media, 'missing the reduced-motion block').not.toBeNull();
    expect(media![1]).toMatch(/\.job-pill\.running::before \{ animation:none; background:color-mix\(in srgb, var\(--job-run\)/);
    expect(media![1]).toContain('.jobs-bar::after');
    expect(media![1]).toContain('.jobs-sheet-panel, .jobs-scrim { transition:none; }');
  });

  it('uses the normal chat colours: theme tokens only, no blue, and nothing styles a job\'s messages apart from the main chat\'s', () => {
    const block = jobsCss();
    const literals = [...block.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map(match => match[0]).filter(value => value !== '#000');
    expect([...new Set(literals)].sort()).toEqual(['#fff', 'rgba(0,0,0,.3)', 'rgba(0,0,0,.35)']);
    expect(block).not.toMatch(/--blue|--job-accent|job-view-open/);
    expect(css).not.toContain('job-view-open');
    // The thread's bubbles are the main chat's own: no rule restyles them inside a job.
    const threadRules = [...block.matchAll(/(?:^|\n)([^{}\n]*\.jobs-thread[^{}\n]*)\{/g)].map(match => match[1].trim());
    expect(threadRules).toEqual(['.jobs-thread .chat-msg:last-child']);
  });

  it('no jobs surface stretches with the panel at Wide or Expand (owner request 2026-10-29)', () => {
    const block = jobsCss();
    expect(declarations(block, '#chat-panel')).toMatchObject({ '--jobs-card-max': '560px', '--jobs-column': '720px' });
    expect(declarations(block, '.jobs-dock')['max-width']).toBe('var(--jobs-column)');
    expect(declarations(block, '.jobs-drawer-list > *')['max-width']).toBe('var(--jobs-column)');
    expect(declarations(block, '.jobs-progress > *')['max-width']).toBe('var(--jobs-column)');
    expect(declarations(block, '.jobs-card')['max-width']).toBe('var(--jobs-card-max)');
    expect(declarations(block, '.jobs-toast')['max-width']).toBe('min(88%, 480px)');
  });

  it('pills share the row as jobs add up, and the sheets rise to the header over a dimmed chat', () => {
    const block = jobsCss();
    expect(declarations(block, '.job-pill')).toMatchObject({ flex: '1 1 0', 'min-width': '0' });
    expect(declarations(block, '.jobs-dock.n2 .job-pill-lead, .jobs-dock.n3 .job-pill-lead, .jobs-dock.n2 .job-pill-state, .jobs-dock.n3 .job-pill-state')).toEqual({ display: 'none' });
    expect(declarations(block, '.jobs-scrim')).toMatchObject({ position: 'absolute', top: 'var(--jobs-sheet-top, 67px)', bottom: '0', background: 'color-mix(in srgb, var(--bg) 62%, transparent)' });
    // 8px inside the panel's sides, with a slim edge in the running pill's colour (owner request 2026-11-13).
    expect(declarations(block, '.jobs-sheet-panel')).toMatchObject({ position: 'absolute', left: '8px', right: '8px', bottom: '0', transform: 'translateY(105%)',
      border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border-strong))', 'border-bottom': '0' });
    const light = declarations(block, '.jobs-view.running::before');
    expect(light).toMatchObject({ position: 'absolute', inset: '-1px -1px 0', 'z-index': '3', padding: '2px 2px 0', 'pointer-events': 'none', 'mask-composite': 'exclude', animation: 'jobs-sheet-orbit 9s linear infinite' });
    expect(light.background).toContain('var(--accent)');
    expect(declarations(block, '#chat-panel.hidden .jobs-view.running::before')).toEqual({ 'animation-play-state': 'paused' });
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.jobs-view\.running::before \{ animation:none;/);
    expect(declarations(block, '.jobs-sheet-panel.open')).toEqual({ transform: 'translateY(0)' });
    // The job's sheet wears the job rows' faint accent wash (owner request 2026-11-13).
    expect(declarations(block, '.jobs-view')).toEqual({ top: 'calc(var(--jobs-sheet-top, 67px) + 8px)', background: 'color-mix(in srgb, var(--accent) 4%, var(--bg-raised))' });
    expect(declarations(block, '.jobs-view-scroll')).toMatchObject({ 'overflow-y': 'auto', flex: '1', 'mask-image': 'linear-gradient(to bottom, transparent 0, #000 22px)' });
    // The progress casts its shadow over the thread (owner request 2026-11-13): positioned above it, so the bubbles never cover it.
    expect(declarations(block, '.jobs-view .jobs-grab, .jobs-view .jobs-sheet-bar')).toEqual({ background: 'color-mix(in srgb, var(--accent) 7%, var(--bg-raised))' });
    expect(declarations(block, '.jobs-progress')).toMatchObject({ position: 'relative', 'z-index': '2', 'box-shadow': '0 10px 14px -10px rgba(0,0,0,.35)', background: 'color-mix(in srgb, var(--accent) 7%, var(--bg-raised))' });
    expect(declarations(block, '.jobs-newest')).toMatchObject({ position: 'sticky' });
  });
});

describe('app.js: the composer follows the thread on screen', () => {
  it('sends to the open job, streams per thread, and Stop names the reply on screen', () => {
    const send = topLevel('sendChat');
    expect(send).toContain("const jobId = window.BotBoyJobs?.currentJobId() || null;");
    expect(send).toContain('...(jobId ? { jobId } : {})');
    expect(send).toContain('setChatStreaming(true, threadKey, requestId)');
    expect(send).toContain('if (jobId) window.BotBoyJobs.dropLive(jobId);');
    // In a job's sheet the reply scrolls the thread's own scroller (under the job's progress).
    expect(send).toContain('const scrollEl = (jobId && window.BotBoyJobs.scrollElement?.()) || chatEl;');
    expect(send).toMatch(/createChatStreamBubble\(chatEl, \{\n\s+scrollEl,/);
    expect(topLevel('createChatStreamBubble')).toContain('const scrollEl = hooks.scrollEl || chatEl;');
    // A reply in a job's thread also moves that job's pill: the bubble hands each event on, and the turn's end is said once.
    expect(topLevel('createChatStreamBubble')).toContain("if (typeof hooks.onEvent === 'function') hooks.onEvent(event);");
    expect(send).toContain('onEvent: jobId ? (event) => window.BotBoyJobs?.ownerEvent?.(jobId, event) : undefined,');
    expect(send).toContain('if (jobId) window.BotBoyJobs?.ownerTurnEnded?.(jobId);');
    expect(app).toMatch(/body: JSON\.stringify\(requestId \? \{ requestId \} : \{\}\)/);
    // One reply at a time per thread: Enter while this thread's reply is written keeps the text in the box.
    expect(app).toMatch(/window\.submitChat = async \(\) => \{ if \(chatStreams\.has\(currentChatThread\(\)\)\) return;/);
    // The jobs UI starts after the start's one await, which never waits for Slack (a timed-out Slack connector held it, live 2026-10-29).
    const startupAwait = app.match(/\n  await Promise\.all\(\[([\s\S]*?)\]\);\n  render\(\);/);
    expect(startupAwait, 'the start awaits its loads once, then renders').not.toBeNull();
    expect(startupAwait![1]).not.toContain('loadSlackSources');
    expect(app).toContain('void loadSlackSources().catch(() => {});');
    expect(app.indexOf('window.BotBoyJobs?.init({')).toBeGreaterThan(app.indexOf(startupAwait![0]));
    // The old job strip is gone.
    expect(app).not.toContain('renderChatJobStrip');
    expect(read('index.html')).not.toContain('chat-job-strip');
    expect(read('index.html').indexOf('chat-jobs-ui.js')).toBeLessThan(read('index.html').indexOf('src="./app.js"'));
  });
});

describe('stream bubble', () => {
  it('shows a failure line, and the no-done safety net only once', () => {
    const bubble = createChatStreamBubble(document.getElementById('chat-messages')!);
    bubble.handle({ type: 'status', text: 'Thinking...' });
    bubble.handle({ type: 'token', text: 'Hello' });
    expect(bubble.msgEl.textContent).toBe('Hello');
    bubble.finishIfLive('⚠️ Stream ended unexpectedly (no done event)');
    bubble.finishIfLive('⚠️ again');
    expect(bubble.msgEl.textContent).toBe('Hello⚠️ Stream ended unexpectedly (no done event)');
    expect(bubble.isLive()).toBe(false);
    const failed = createChatStreamBubble(document.getElementById('chat-messages')!);
    failed.fail('❌ Error 400: bad');
    expect(failed.msgEl.classList.contains('streaming-frozen')).toBe(true);
  });
});
describe('a job\'s report in the main chat (PARALLEL_JOBS_PLAN.md §11)', () => {
  const constLine = (name: string) => {
    const match = app.match(new RegExp(`\\nconst ${name} = .*\\n`));
    expect(match, `missing const ${name}`).not.toBeNull();
    return match![0];
  };
  let renderChatMsgInner: (m: any) => string;
  let markerRe: RegExp;
  beforeAll(() => {
    const source = [
      constLine('JOB_CARD_MARKER_RE'), constLine('JOB_CARD_ONLY_RE'), constLine('WHATSAPP_NOTE_RE'),
      constLine('JOB_UPDATE_RE'), constLine('JOB_REPORT_FOLD_CHARS'), constLine('JOB_REPORT_FOLD_LINES'),
      topLevel('escHtml'), topLevel('renderChatMsgInner'), 'return { renderChatMsgInner, JOB_CARD_MARKER_RE };',
    ].join('\n');
    // eslint-disable-next-line no-new-func
    ({ renderChatMsgInner, JOB_CARD_MARKER_RE: markerRe } = new Function('formatMarkdownContent', 'thinkingTextHtml', 'escAttr', source)(
      (text: string) => `<p>${String(text).replace(/</g, '&lt;')}</p>`, (text: string) => text, (text: string) => text,
    ));
    // The "Show all" toggle is a document listener in app.js.
    const start = app.indexOf('// A folded job report opens and closes in place');
    expect(start).toBeGreaterThan(0);
    // eslint-disable-next-line no-new-func
    new Function(app.slice(start, app.indexOf('\n});\n', start) + 5))();
  });
  const report = (content: string, role = 'assistant') => ({ id: 'r1', role, content, refJobId: JOB_A });

  it('draws the job\'s words with its footer card under them; a long report folds and opens in place', () => {
    const short = renderChatMsgInner(report(`**Done.** Outlook is not syncing.\n\n[[job:${JOB_A}:report]]`));
    expect(short).toBe(`<div class="job-update-body"><p>**Done.** Outlook is not syncing.</p></div><div class="job-update-foot">[[job:${JOB_A}:report]]</div>`);
    // The footer marker is one the transcript expands into a card slot.
    expect(`[[job:${JOB_A}:report]] [[job:${JOB_A}:update]] [[job:${JOB_A}:ended]]`.match(markerRe)).toHaveLength(3);
    const lines = Array.from({ length: 15 }, (_, i) => `- line ${i}`).join('\n');
    for (const body of [lines, 'x'.repeat(901)]) {
      document.body.innerHTML = `<div id="chat-panel"><div class="chat-msg">${renderChatMsgInner(report(`${body}\n\n[[job:${JOB_A}:report]]`))}</div></div>`;
      const shown = document.querySelector('.job-update-body')!;
      const more = document.querySelector('[data-job-update-more]') as HTMLButtonElement;
      expect(shown.classList.contains('folded')).toBe(true);
      expect(more.textContent).toBe('Show all');
      more.click();
      expect(shown.classList.contains('folded')).toBe(false);
      expect(more.textContent).toBe('Show less');
      expect(more.getAttribute('aria-expanded')).toBe('true');
      more.click();
      expect(shown.classList.contains('folded')).toBe(true);
    }
    expect(renderChatMsgInner(report(`${'x'.repeat(900)}\n\n[[job:${JOB_A}:report]]`))).not.toContain('folded');
  });

  it('the main chat\'s decision on a job update is quiet and never folds; an owner\'s row is never a report', () => {
    const decided = renderChatMsgInner(report(`↻ Job update: #1 Local offline study is stuck.\n\nIt kept failing on dt; I told it to use dataset_date. ${'y'.repeat(1_200)}\n\n[[job:${JOB_A}:update]]`));
    expect(decided).toContain('<div class="job-update-body quiet">');
    expect(decided).toContain('↻ Job update: #1 Local offline study is stuck.');
    expect(decided).not.toContain('folded');
    expect(decided).toContain(`<div class="job-update-foot">[[job:${JOB_A}:update]]</div>`);
    expect(renderChatMsgInner(report(`quoting [[job:${JOB_A}:report]]`, 'user'))).not.toContain('job-update');
    // A report whose words already show above it (the owner's #N reply from the main chat) is the card alone.
    expect(renderChatMsgInner(report(`[[job:${JOB_A}:report]]`))).toBe(`<div class="job-update-foot">[[job:${JOB_A}:report]]</div>`);
  });

  const footSlot = (id: string, kind: string) => {
    const chat = document.getElementById('chat-messages')!;
    chat.insertAdjacentHTML('beforeend', `<div class="chat-msg assistant"><div class="job-update-foot"><div class="jobs-card-slot" data-job-card-id="${id}" data-job-card-kind="${kind}"></div></div></div>`);
    return chat.lastElementChild!.querySelector('.jobs-card-slot') as HTMLElement;
  };

  it('the footer names the job and its state, lists what it made, and offers its next steps while it is done', async () => {
    const send = vi.fn(async () => {});
    listPayload = { jobs: [], version: 2, recent: [job({
      status: 'done', phase: null, endedAt: '2026-11-08T10:00:00.000Z', endReason: 'All connections checked',
      nextSteps: ['Restore Outlook sync', 'Clear the capture backlog'],
      results: { files: [], datasets: [], dashboards: [{ dashboardId: 'dash_9', title: 'Connection health' }] },
    })] };
    jobs.init({ send }); // its own first read takes the list above
    try {
      await jobs.refresh();
      const foot = footSlot(JOB_A, 'report');
      jobs.fillCards(document);
      expect(foot.querySelector('.jobs-update-head')!.textContent).toBe('#1 Local offline studyDone');
      expect(foot.querySelector('.jobs-badge.done')).not.toBeNull();
      expect(foot.querySelector('a.jobs-out')!.getAttribute('href')).toBe('#/dashboards/dash_9');
      const chips = [...foot.querySelectorAll('[data-jobs-step]')] as HTMLButtonElement[];
      expect(chips.map(chip => chip.textContent)).toEqual(['Restore Outlook sync', 'Clear the capture backlog']);
      // A next step is the owner's message to the job, sent from the main chat as "#N …".
      chips[0].click();
      expect(send).toHaveBeenCalledWith('#1 Restore Outlook sync');
      expect(jobs.currentJobId()).toBeNull();
      jobPayloads[JOB_A] = { job: listPayload.recent[0], history: [], activity: [] };
      (foot.querySelector('[data-jobs-open]') as HTMLElement).click();
      expect(jobs.currentJobId()).toBe(JOB_A);
      jobs.closeJob?.();
      // Picked up again: the footer shows it working, and its old next steps go.
      listPayload = { jobs: [job({ nextSteps: ['Restore Outlook sync'] })], recent: [], version: 3 };
      await jobs.refresh();
      jobs.fillCards(document);
      expect(foot.querySelector('.jobs-badge.run')!.textContent).toBe('Working');
      expect(foot.querySelectorAll('[data-jobs-step]')).toHaveLength(0);
      listPayload = { jobs: [job({ phase: 'needs_owner', pauseNote: 'Which cohort?' })], recent: [], version: 4 };
      await jobs.refresh();
      jobs.fillCards(document);
      expect(foot.querySelector('.jobs-badge.needs')!.textContent).toBe('Needs you');
    } finally {
      jobs.init({ send: undefined });
    }
  });

  it('a quiet line\'s footer names the job and opens it, with no next steps', async () => {
    listPayload = { jobs: [job({ phase: 'working' })], recent: [job({ id: JOB_B, number: 2, title: 'Idle study', status: 'expired', phase: null, nextSteps: ['x'] })], version: 2 };
    await jobs.refresh();
    const update = footSlot(JOB_A, 'update');
    const ended = footSlot(JOB_B, 'ended');
    jobs.fillCards(document);
    expect(update.querySelector('.jobs-update.quiet .jobs-update-head')!.textContent).toBe('#1 Local offline studyWorkingOpen job');
    expect(ended.querySelector('.jobs-update.quiet .jobs-badge.ended')!.textContent).toBe('Ended');
    expect(document.querySelectorAll('[data-jobs-step]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-jobs-answer]')).toHaveLength(0);
  });

  // PARALLEL_JOBS_PLAN.md §12: when the main chat leaves a choice to the owner, the answer is taken where the question appears.
  it('a quiet line\'s footer takes the job\'s answers while it asks the owner, and drops them once one is sent', async () => {
    listPayload = { jobs: [
      job({ id: JOB_B, number: 2, title: 'Cohort study', phase: 'needs_owner', pauseNote: 'Use the 2023 or the 2024 cohort?', options: ['Use 2023', 'Use 2024'] }),
      job({ id: JOB_C, number: 3, title: 'Release note', phase: 'needs_owner', pauseNote: 'Which tone?', options: [] }),
    ], recent: [], version: 2 };
    await jobs.refresh();
    const asking = footSlot(JOB_B, 'update');
    const open = footSlot(JOB_C, 'update');
    jobs.fillCards(document);
    expect(asking.querySelector('.jobs-update.quiet .jobs-badge.needs')!.textContent).toBe('Needs you');
    expect([...asking.querySelectorAll('.jobs-update.quiet .jobs-chips [data-jobs-answer]')].map(chip => chip.textContent)).toEqual(['Use 2023', 'Use 2024']);
    expect(asking.querySelector('.jobs-chips [data-jobs-open]')!.textContent).toBe('Open job');
    expect(open.querySelector('.jobs-chips [data-jobs-open]')!.textContent).toBe('Answer');
    (asking.querySelector('[data-jobs-answer="Use 2024"]') as HTMLElement).click();
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0]).toMatchObject({ url: '/api/chat/messages', body: { message: 'Use 2024', stream: true, jobId: JOB_B } });
    expect(fetchCalls[0].body.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    // Sent: its answers go at once; the job's own sheet was never opened.
    expect(asking.querySelectorAll('[data-jobs-answer]')).toHaveLength(0);
    expect(jobs.currentJobId()).toBeNull();
    listPayload = { jobs: [job({ id: JOB_B, number: 2, title: 'Cohort study', phase: 'working' }), job({ id: JOB_C, number: 3, phase: 'working' })], recent: [], version: 3 };
    await jobs.refresh();
    jobs.fillCards(document);
    expect(document.querySelectorAll('#chat-messages [data-jobs-answer]')).toHaveLength(0);
  });

  // Owner report 2026-11-14: next steps sit beside the job's files and looked alike, and a tap sent a cut-off message.
  it('a next step or an answer stands apart from the files, clips only its label, and a tap sends the whole text', async () => {
    const step = 'Submit P1 only, report back before P2 and P3, then rerun the September comparison against the warehouse counts';
    const answer = 'Submit P1 only, report back before P2 and P3 are submitted';
    const send = vi.fn(async () => {});
    listPayload = { jobs: [job({ id: JOB_B, number: 2, title: 'Cradle pulls', phase: 'needs_owner', pauseNote: 'Which pulls?', options: [answer] })], recent: [job({
      status: 'done', phase: null, endedAt: '2026-11-08T10:00:00.000Z', nextSteps: [step],
      results: { files: [{ path: '/files/study-note.md', label: 'Note' }], datasets: [], dashboards: [] },
    })], version: 2 };
    jobs.init({ send });
    try {
      await jobs.refresh();
      const foot = footSlot(JOB_A, 'report');
      const asking = footSlot(JOB_B, 'update');
      jobs.fillCards(document);
      const stepChip = foot.querySelector('[data-jobs-step]') as HTMLButtonElement;
      expect(stepChip.classList.contains('action')).toBe(true);
      expect(foot.querySelector('.jobs-out')!.classList.contains('action')).toBe(false);
      expect(foot.querySelector('[data-jobs-open]')!.classList.contains('action')).toBe(false);
      expect(stepChip.querySelector('.jobs-chip-label')!.textContent).toBe(step);
      expect(stepChip.title).toBe(step);
      stepChip.click();
      expect(send).toHaveBeenCalledWith(`#1 ${step}`);
      const answerChip = asking.querySelector('[data-jobs-answer]') as HTMLButtonElement;
      expect(answerChip.classList.contains('action')).toBe(true);
      expect(answerChip.title).toBe(answer);
      answerChip.click();
      await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
      expect(fetchCalls[0]).toMatchObject({ url: '/api/chat/messages', body: { message: answer, jobId: JOB_B } });
    } finally {
      jobs.init({ send: undefined });
    }
  });
});

// Owner request 2026-11-13: the job rows the main chat keeps stand out in the running pill's accent.
describe('job rows in the main chat wear the running pill\'s accent', () => {
  const constLine = (name: string) => {
    const match = app.match(new RegExp(`\\nconst ${name} = .*\\n`));
    expect(match, `missing const ${name}`).not.toBeNull();
    return match![0];
  };
  let chatRowClass: (m: any) => string;
  beforeAll(() => {
    // eslint-disable-next-line no-new-func
    chatRowClass = new Function([constLine('JOB_CARD_ONLY_RE'), constLine('JOB_ROW_RE'), topLevel('chatRowClass'), 'return chatRowClass;'].join('\n'))();
  });
  const marked = (m: any) => chatRowClass(m).split(' ').includes('job-row');
  it('marks a report, a question or hand-back, an ended job and a job\'s reply to a #N message; nothing else', () => {
    expect(marked({ role: 'assistant', content: `**Done.** 38.4%\n\n[[job:${JOB_A}:report]]`, refJobId: JOB_A })).toBe(true);
    expect(marked({ role: 'assistant', content: `#1 asks you: which cohort?\n\n[[job:${JOB_A}:update]]` })).toBe(true);
    expect(marked({ role: 'assistant', content: `#1 ended after a day.\n\n[[job:${JOB_A}:ended]]` })).toBe(true);
    expect(marked({ role: 'assistant', content: 'Recovered 3.9M records.', refJobId: JOB_A })).toBe(true);
    // The main chat's own reply that started a job keeps the plain look; so does the owner's #N message and a card-only row.
    expect(marked({ role: 'assistant', content: `Started #25 to draft the PRD.\n\n[[job:${JOB_A}:started]]` })).toBe(false);
    expect(marked({ role: 'user', content: '#5 use the sample', refJobId: JOB_A })).toBe(false);
    expect(marked({ role: 'assistant', content: `[[job:${JOB_A}:report]]`, refJobId: JOB_A })).toBe(false);
    expect(marked({ role: 'assistant', content: 'An ordinary answer.' })).toBe(false);
    expect(chatRowClass({ role: 'assistant', content: 'x' })).toBe('chat-msg assistant');
  });
  it('every main-chat row takes its class from there, a #N reply streamed here is marked when it finishes, and the look is the accent', () => {
    const render = topLevel('renderChat');
    expect(render).toContain('bubble.className = chatRowClass(m);');
    expect(render).toContain('return `<div class="${chatRowClass(m)}"${idAttr}>${renderChatMsgInner(m)}</div>`;');
    expect(topLevel('sendChat')).toContain("if (routed && window.BotBoyJobs?.hasNumber?.(routed[1])) bubble.msgEl.classList.add('job-row');");
    const rule = css.match(/\n\.chat-msg\.assistant\.job-row \{([^}]*)\}/);
    expect(rule, 'missing the job-row rule').not.toBeNull();
    // A faint wash only (owner request 2026-11-13): no bar, no accent border, fainter than the owner's --accent-soft bubbles.
    expect(rule![1].trim()).toBe('background:color-mix(in srgb, var(--accent) 4%, var(--surface));');
  });
});
