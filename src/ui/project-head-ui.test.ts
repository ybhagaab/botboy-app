// @vitest-environment jsdom
//
// The project page header (owner request 2026-10-22): an Archive button (click, confirm, done; Restore on an archived
// project), and a layout that narrows cleanly beside the chat panel — breadcrumb and actions on one wrapping top row,
// the title and its facts below at full width, the facts on one wrapping row, no status line that only repeats the
// status pill. Rendered from the shipped dashboard.js and project-layouts.js, like analytics-presentation-ui.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const dashboard = read('src/ui/dashboard.js');
const css = read('src/ui/dashboard.css');
const layoutsCss = read('src/ui/project-layouts.css');
const indexHtml = read('src/ui/index.html');

function topLevel(name: string): string {
  const start = dashboard.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = dashboard.indexOf('\n}\n', start);
  return dashboard.slice(start, end + 2);
}
function constLine(name: string): string {
  const match = dashboard.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}

const icon = (name: string) => `<svg data-icon="${name}"></svg>`;

function loadHead(state: Record<string, unknown>) {
  const source = [
    constLine('esc'), constLine('attr'), constLine('number'), constLine('projectAskSeed'),
    topLevel('projectTone'), topLevel('statusLabel'), topLevel('projectArchiveButton'), topLevel('renderProjectHead'),
    'return { head: renderProjectHead, button: projectArchiveButton };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', 'icon', 'relativeTime', source)(state, icon, () => 'Oct 5') as {
    head(project: unknown, detail: unknown, area: unknown, brain: unknown): string;
    button(project: unknown): string;
  };
}

const headState = () => ({ rebuilding: new Set<string>(), archivingProjects: new Set<string>() });
const PROJECT = { id: 'proj_666eaad1', title: 'MXP PV Capability Compatibility', status: 'active', itemCount: 232, updatedAt: '2026-10-05T00:00:00Z' };
const AREA = { id: 'area_mx', title: 'MX–Prime Video Catalog Unification, Discovery, CX, Content Standards & Windowing' };

function renderHead(options: { project?: Record<string, unknown>; brain?: Record<string, unknown>; detail?: Record<string, unknown>; state?: ReturnType<typeof headState> } = {}) {
  const { head } = loadHead(options.state ?? headState());
  document.body.innerHTML = head({ ...PROJECT, ...options.project }, { scopeAlertCount: 2, ...options.detail }, AREA, { title: PROJECT.title, statusLine: 'active', ...options.brain });
}

describe('the project header layout', () => {
  it('puts the breadcrumb and the actions on the top row, and the title and its facts below at full width', () => {
    renderHead();
    const bar = document.querySelector('.project-head-bar') as HTMLElement;
    expect([...bar.children].map(child => child.className)).toEqual(['breadcrumb', 'head-actions']);
    expect(bar.nextElementSibling?.matches('header.page-head.project-page-head')).toBe(true);
    // Nothing shares the title's row: the header holds only the title block.
    const header = document.querySelector('header.project-page-head') as HTMLElement;
    expect(header.querySelector('.head-actions, button')).toBeNull();
    expect([...header.children].map(child => child.className)).toEqual(['project-head-main']);
    expect(header.querySelector('h1.page-title')?.textContent).toBe('MXP PV Capability Compatibility');
    expect([...bar.querySelectorAll('.head-actions > button')].map(button => button.textContent?.trim())).toEqual(['Archive', 'Rebuild from evidence', 'Ask BotBoy']);
    // The long area name can shorten to fit; its full name stays on hover.
    expect(bar.querySelector('.breadcrumb a[href="#/areas/area_mx"]')?.getAttribute('title')).toBe(AREA.title);
  });

  it('keeps updated, evidence, local workspace and scope alerts on one facts row', () => {
    renderHead();
    const rows = document.querySelectorAll('.project-meta');
    expect(rows).toHaveLength(1);
    expect([...rows[0].children].map(child => child.textContent?.trim())).toEqual(['Updated Oct 5', '232 evidence items', 'Local workspace', 'Scope alerts: 2']);
    renderHead({ detail: { scopeAlertCount: 0 } });
    expect([...document.querySelector('.project-meta')!.children].map(child => child.textContent?.trim())).toEqual(['Updated Oct 5', '232 evidence items', 'Local workspace']);
  });

  it('drops a status line that only repeats the status pill, and keeps a real one', () => {
    for (const statusLine of ['active', ' Active ', 'ACTIVE']) {
      renderHead({ brain: { statusLine } });
      expect(document.querySelector('.project-status-line'), statusLine).toBeNull();
      expect(document.querySelector('.project-title-row .pill')?.textContent).toBe('Active');
    }
    renderHead({ brain: { statusLine: 'Waiting on the legal review of the PV entitlements' } });
    expect(document.querySelector('.project-status-line')?.textContent).toBe('Waiting on the legal review of the PV entitlements');
    renderHead({ brain: { statusLine: '' }, project: { oneLiner: 'Playback rules by entitlement' } });
    expect(document.querySelector('.project-status-line')?.textContent).toBe('Playback rules by entitlement');
    renderHead({ brain: { statusLine: '' } });
    expect(document.querySelector('.project-status-line')?.textContent).toBe('No current status line has been synthesized.');
    // A paused project whose line says "active" still shows it: it is not a repeat of "Paused".
    renderHead({ project: { status: 'paused' }, brain: { statusLine: 'active' } });
    expect(document.querySelector('.project-status-line')?.textContent).toBe('active');
  });

  it('ships the row rules: the top row wraps, the header is a plain block, the facts never break inside an item', () => {
    expect(css).toMatch(/\.project-head-bar \{[^}]*display:flex;[^}]*flex-wrap:wrap;/);
    expect(css).toMatch(/\.project-head-bar \.head-actions \{[^}]*flex-wrap:wrap;[^}]*margin:0 0 0 auto;/);
    expect(css).toMatch(/\.project-head-bar \.breadcrumb > a \{[^}]*text-overflow:ellipsis;/);
    // Only the area name shortens: "Workspace" stays whole (a 620 px render had cut it to "Worksp…").
    expect(css).toContain('.project-head-bar .breadcrumb > a:first-child { flex:0 0 auto; }');
    expect(css).toMatch(/\.project-page-head \{ display:block; \}/);
    expect(css).toMatch(/\.project-page-head \.project-meta > span \{ white-space:nowrap; \}/);
    // The roadmap's small-screen rule follows the actions to their new row.
    expect(layoutsCss).not.toContain('.roadmap-page-head .head-actions');
    expect(layoutsCss).toContain('.roadmap-layout .project-head-bar .head-actions{flex-basis:100%;align-items:stretch;flex-direction:column}');
  });
});

describe('the Archive button', () => {
  it('reads Archive on an active project and Restore on an archived one, and shows when a request runs', () => {
    const state = headState();
    const { button } = loadHead(state);
    document.body.innerHTML = button(PROJECT);
    let element = document.querySelector('button') as HTMLButtonElement;
    expect(element.dataset).toMatchObject({ action: 'archive-project', project: 'proj_666eaad1' });
    expect(element.textContent?.trim()).toBe('Archive');
    expect(element.querySelector('svg')?.dataset.icon).toBe('archive');
    expect(element.title).toBe('Hide this project from your areas and the sidebar. Nothing is deleted.');
    expect(element.disabled).toBe(false);
    document.body.innerHTML = button({ ...PROJECT, status: 'archived' });
    element = document.querySelector('button') as HTMLButtonElement;
    expect(element.dataset.action).toBe('restore-project');
    expect(element.textContent?.trim()).toBe('Restore');
    expect(element.querySelector('svg')?.dataset.icon).toBe('archive-restore');
    state.archivingProjects.add(PROJECT.id);
    document.body.innerHTML = button(PROJECT) + button({ ...PROJECT, status: 'archived' });
    expect([...document.querySelectorAll('button')].map(b => [b.textContent?.trim(), (b as HTMLButtonElement).disabled])).toEqual([['Archiving…', true], ['Restoring…', true]]);
  });

  it('has both icons in the page sprite and is wired to the click dispatcher and the roadmap header', () => {
    expect(indexHtml).toContain('<symbol id="i-archive" viewBox="0 0 24 24">');
    expect(indexHtml).toContain('<symbol id="i-archive-restore" viewBox="0 0 24 24">');
    expect(dashboard).toContain("if (action === 'archive-project') void setProjectArchived(target.dataset.project, true);");
    expect(dashboard).toContain("if (action === 'restore-project') void setProjectArchived(target.dataset.project, false);");
    expect(dashboard).toContain('archiveActionHtml: projectArchiveButton(project),');
    expect(dashboard).toContain('const fallbackHtml = `${renderProjectHead(project, detail, area, brain)}');
  });
});

type Call = { path: string; options: { method?: string; body?: unknown } };

function loadArchive(options: { confirm?: boolean; fail?: Error; hold?: boolean } = {}) {
  const calls: Call[] = [];
  const toasts: Array<[string, string | undefined]> = [];
  const confirmTexts: string[] = [];
  let release: () => void = () => {};
  const state = {
    archivingProjects: new Set<string>(),
    projectDetails: new Map<string, unknown>([['proj/1', { brain: { title: 'Launch email' } }]]),
    route: { view: 'project', projectId: 'proj/1' },
  };
  const request = vi.fn(async (pathname: string, requestOptions: Call['options']) => {
    calls.push({ path: pathname, options: requestOptions });
    if (options.hold) await new Promise<void>(resolve => { release = resolve; });
    if (options.fail) throw options.fail;
    return { project: { id: 'proj/1' } };
  });
  const loadCore = vi.fn(async () => {});
  const renderRoute = vi.fn();
  const confirm = vi.fn((text: string) => { confirmTexts.push(text); return options.confirm ?? true; });
  window.confirm = confirm as unknown as typeof window.confirm;
  const source = [topLevel('setProjectArchived'), 'return setProjectArchived;'].join('\n');
  // eslint-disable-next-line no-new-func
  const setProjectArchived = new Function('state', 'projectById', 'request', 'toast', 'loadCore', 'renderRoute', source)(
    state,
    (id: string) => (id === 'proj/1' ? { id, title: 'Stale title', status: 'active' } : null),
    request,
    (message: string, tone?: string) => toasts.push([message, tone]),
    loadCore,
    renderRoute,
  ) as (projectId: string, archived: boolean) => Promise<void>;
  return { setProjectArchived, state, calls, toasts, confirm, confirmTexts, loadCore, renderRoute, release: () => release() };
}

describe('archiving and restoring from the page', () => {
  it('asks first, naming the project and what happens; a No changes nothing', async () => {
    const declined = loadArchive({ confirm: false });
    await declined.setProjectArchived('proj/1', true);
    expect(declined.confirmTexts).toEqual(['Archive "Launch email"?\n\nIt leaves your areas and the sidebar. Its brain, evidence and documents are kept, and Restore on this page brings it back.']);
    expect(declined.calls).toEqual([]);
    expect(declined.state.archivingProjects.size).toBe(0);
    expect(declined.renderRoute).not.toHaveBeenCalled();
  });

  it('a Yes archives through the workspace route, says so, and reloads the project', async () => {
    const run = loadArchive();
    await run.setProjectArchived('proj/1', true);
    expect(run.calls).toEqual([{ path: '/workspace/projects/proj%2F1/archive', options: { method: 'POST', body: {} } }]);
    expect(run.toasts).toEqual([['Archived "Launch email"', undefined]]);
    expect(run.state.projectDetails.has('proj/1')).toBe(false);
    expect(run.loadCore).toHaveBeenCalledWith({ quiet: true });
    expect(run.state.archivingProjects.size).toBe(0);
    expect(run.renderRoute).toHaveBeenCalledTimes(2);
  });

  it('Restore needs no confirmation', async () => {
    const run = loadArchive();
    await run.setProjectArchived('proj/1', false);
    expect(run.confirm).not.toHaveBeenCalled();
    expect(run.calls.map(call => call.path)).toEqual(['/workspace/projects/proj%2F1/restore']);
    expect(run.toasts).toEqual([['Restored "Launch email"', undefined]]);
  });

  it('a second click while the first is running sends nothing more', async () => {
    const run = loadArchive({ hold: true });
    const first = run.setProjectArchived('proj/1', true);
    await vi.waitFor(() => expect(run.calls).toHaveLength(1));
    expect(run.state.archivingProjects.has('proj/1')).toBe(true);
    await run.setProjectArchived('proj/1', true);
    await run.setProjectArchived('proj/1', false);
    expect(run.calls).toHaveLength(1);
    run.release();
    await first;
    expect(run.state.archivingProjects.size).toBe(0);
  });

  it('a refusal is shown as it came, and the project keeps its loaded page', async () => {
    const run = loadArchive({ fail: new Error('HTTP 409 — Project brain has manual edits') });
    await run.setProjectArchived('proj/1', true);
    expect(run.toasts).toEqual([['Archive failed: HTTP 409 — Project brain has manual edits', 'bad']]);
    expect(run.state.projectDetails.has('proj/1')).toBe(true);
    expect(run.loadCore).not.toHaveBeenCalled();
    expect(run.state.archivingProjects.size).toBe(0);
  });

  it('ignores a project it cannot find', async () => {
    const run = loadArchive();
    await run.setProjectArchived('proj_missing', true);
    expect(run.confirm).not.toHaveBeenCalled();
    expect(run.calls).toEqual([]);
  });
});

describe('the roadmap template header', () => {
  it('draws the same top row, with the archive button first', async () => {
    const layout = { template: 'roadmap', version: 1, config: { items: [{ title: 'TTFF fix', version: 'v1', status: 'active' }] } };
    window.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ layout }) })) as unknown as typeof fetch;
    delete (window as { BotBoyLayouts?: unknown }).BotBoyLayouts;
    // eslint-disable-next-line no-new-func
    new Function(read('src/ui/project-layouts.js'))();
    const layouts = (window as unknown as { BotBoyLayouts: { prefetch(type: string, id: string): Promise<unknown>; renderProject(input: unknown): string } }).BotBoyLayouts;
    await layouts.prefetch('project', 'proj_1');
    document.body.innerHTML = layouts.renderProject({
      project: { id: 'proj_1', title: 'Roadmap', status: 'active', itemCount: 3 },
      detail: { brain: { title: 'Roadmap' } },
      area: AREA,
      activeTab: 'brief',
      archiveActionHtml: '<button class="button" type="button" data-action="archive-project" data-project="proj_1">Archive</button>',
      fallbackHtml: 'FALLBACK',
    });
    const bar = document.querySelector('.roadmap-layout > .project-head-bar') as HTMLElement;
    expect([...bar.children].map(child => child.className)).toEqual(['breadcrumb', 'head-actions']);
    expect([...bar.querySelectorAll('.head-actions > button')].map(button => button.textContent?.trim())).toEqual(['Archive', 'Rebuild brain', 'Ask BotBoy']);
    const header = document.querySelector('header.roadmap-page-head.project-page-head') as HTMLElement;
    expect(header.querySelector('.head-actions, button')).toBeNull();
    expect(header.querySelector('h1.page-title')?.textContent).toBe('Roadmap');
  });
});
