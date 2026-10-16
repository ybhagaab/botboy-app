// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Settings → Knowledge (docs/maps/knowledge-library.md K12). Server behavior is covered by routers/knowledge.test.ts and
// the core suites; these tests pin the SPA side: the renderers in knowledge-ui.js (real file, real jsdom), the handlers
// in dashboard.js (the real functions, run against a stub `request`), and the wiring seams (route, navs, version poll).
const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const html = readFileSync(path.join(process.cwd(), 'src/ui/index.html'), 'utf8');
const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');
const uiSource = readFileSync(path.join(process.cwd(), 'src/ui/knowledge-ui.js'), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}
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

// ── The real renderers, loaded the way the browser loads them (a classic script that sets one global) ──

type Renderer = {
  renderPage(model: Record<string, unknown>, helpers: Record<string, unknown>): string;
  renderAnalyticsInLibrary(ctx: Record<string, unknown>, helpers: Record<string, unknown>): string;
  planSummary(plan: unknown): Record<string, number>;
  COVERAGE: string;
};
function loadRenderer(): Renderer {
  // eslint-disable-next-line no-new-func
  new Function(uiSource)();
  return (window as unknown as { BotBoyKnowledge: Renderer }).BotBoyKnowledge;
}
// The helpers dashboard.js hands in are its own (same escaping, same icon markup), not stand-ins.
function realHelpers(): Record<string, unknown> {
  const source = [constLine('icon'), constLine('esc'), constLine('attr'), constLine('number'), topLevel('pageHead'), topLevel('loadingView'),
    'return { esc, attr, icon, number, pageHead, loadingView };'].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(source)();
}
const renderer = loadRenderer();
const helpers = realHelpers();

const SYNC = 'This folder may be synced by iCloud Drive or backed up by Time Machine; use Change location first if you do not want that.';
const ROOT = '/Users/someone/Documents/BotBoy Knowledge';
function statusOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3, activated: true, root: ROOT, defaultRoot: ROOT, pinnedByEnvironment: false, state: 'ready', denyActive: true,
    sets: [], categories: [], looseCount: 0, analyticsDir: 'library', legacyAnalytics: null, migration: null, formerRoots: [], syncNote: SYNC,
    ...overrides,
  };
}
function modelOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: statusOf(), error: '', busy: '', notice: null, existing: null, createDraft: '', changeDraft: '', changing: false, plan: null, acknowledged: false, ...overrides };
}
function paint(model: Record<string, unknown>): string {
  const page = renderer.renderPage(model, helpers);
  document.body.innerHTML = page;
  return page;
}
const text = () => document.body.textContent ?? '';
const set = (overrides: Record<string, unknown> = {}) => ({
  id: 'shop-data', name: 'Shop data', kind: 'analytics', description: 'Order tables and refund rules for the shop', category: null,
  fileCount: 4, archived: 0, hasGuide: true, writable: true, reserved: false, issues: [], ...overrides,
});

describe('Settings → Knowledge page: states', () => {
  it('not created: a Create folder form with the default path, the sync sentence, and nothing created yet', () => {
    paint(modelOf({ status: statusOf({ activated: false, root: null, state: 'not_created', denyActive: false }) }));
    const form = document.querySelector('form[data-knowledge-form="create"]')!;
    expect(form).not.toBeNull();
    const input = form.querySelector('input[name="path"]') as HTMLInputElement;
    expect(input.value).toBe(ROOT);
    expect(input.required).toBe(true);
    expect(input.maxLength).toBe(1024);
    expect(form.querySelector('button[type="submit"]')!.textContent).toBe('Create folder');
    expect(text()).toContain('Nothing is created until you click Create folder');
    expect(text()).toContain('macOS may ask whether BotBoy can use your Documents folder');
    expect(text()).toContain(SYNC);
    expect(document.querySelector('.knowledge-sets')).toBeNull();
    expect(document.querySelector('.knowledge-move')).toBeNull();
    expect(document.querySelector('[data-action="knowledge-change-open"]')).toBeNull();
  });

  it('ready with sets: one row per set with kind, description, file count, guide state and the first two issues', () => {
    paint(modelOf({
      status: statusOf({
        sets: [
          set(),
          set({ id: 'analytics', name: 'analytics', description: 'Presets and lessons', fileCount: 7, reserved: true }),
          set({ id: 'notes', name: 'Notes', kind: 'memory', description: '', fileCount: 1, hasGuide: false, issues: [{ code: 'a', message: 'One' }, { code: 'b', message: 'Two' }, { code: 'c', message: 'Three' }] }),
        ],
        looseCount: 2,
      }),
    }));
    const rows = [...document.querySelectorAll('.knowledge-sets-table tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Shop data');
    expect(rows[0].textContent).toContain('Analytics');
    expect(rows[0].textContent).toContain('Guide: Yes');
    expect(rows[1].textContent).toContain('Built in');
    expect(rows[2].textContent).toContain('No guide yet');
    expect(rows[2].textContent).toContain('Memory');
    const issues = [...rows[2].querySelectorAll('.knowledge-issues li')].map(li => li.textContent);
    expect(issues).toEqual(['One', 'Two', 'and 1 more']);
    expect(document.querySelector('.knowledge-sets .card-meta')!.textContent).toBe('3 sets · 2 files outside any set');
    expect(document.querySelector('.knowledge-sets caption')!.textContent).toBe('Sets in your Knowledge folder');
    expect(document.querySelector('.data-room-table-wrap')!.getAttribute('data-scroll-key')).toBe('knowledge:sets');
    expect(text()).toContain('Ready to use');
    expect(text()).toContain(ROOT);
  });

  it('ready with no sets: says how to add one and to press Rescan', () => {
    paint(modelOf());
    expect(text()).toContain('No sets yet. Add a folder under');
    expect(text()).toContain('then press Rescan');
  });

  it('needs permission: names the problem and the System Settings steps, offers Rescan and Change location, shows no sets', () => {
    paint(modelOf({
      status: statusOf({
        state: 'needs_permission',
        message: 'macOS did not allow BotBoy to use the Knowledge folder.',
        nextAction: 'Open System Settings → Privacy & Security → Files and Folders, allow BotBoy, then press Rescan.',
        sets: [set()],
      }),
    }));
    expect(document.querySelector('.knowledge-location .pill')!.textContent).toBe('Needs permission');
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('macOS did not allow BotBoy');
    expect(alert.textContent).toContain('Files and Folders');
    expect(document.querySelector('[data-action="knowledge-rescan"]')).not.toBeNull();
    expect(document.querySelector('[data-action="knowledge-change-open"]')).not.toBeNull();
    expect(document.querySelector('[data-action="knowledge-recreate"]')).toBeNull();
    // A folder that cannot be read has no sets to list, whatever an older answer held.
    expect(document.querySelector('.knowledge-sets')).toBeNull();
  });

  it('folder missing: offers Create folder again at the same place, and shows no sets or Move card', () => {
    paint(modelOf({
      status: statusOf({
        state: 'folder_missing', message: `The folder ${ROOT} is missing.`,
        nextAction: 'Create the folder again from Settings → Knowledge, or choose another location with Change location.',
        legacyAnalytics: { dir: '/old', files: 2, hasManifest: false }, analyticsDir: 'legacy',
      }),
    }));
    expect(document.querySelector('.knowledge-location .pill')!.textContent).toBe('Folder missing');
    expect(document.querySelector('[data-action="knowledge-recreate"]')!.textContent).toBe('Create folder again');
    expect(document.querySelector('.knowledge-sets')).toBeNull();
    expect(document.querySelector('.knowledge-move')).toBeNull();
  });

  it('a general problem uses the Problem pill and the server next action', () => {
    paint(modelOf({ status: statusOf({ state: 'error', message: 'The Knowledge folder was too slow to read.', nextAction: 'Check that its disk is connected, or choose another location.' }) }));
    expect(document.querySelector('.knowledge-location .pill')!.textContent).toBe('Problem');
    expect(text()).toContain('Check that its disk is connected');
  });

  it('a location pinned by BOTBOY_KNOWLEDGE_ROOT cannot be changed here', () => {
    paint(modelOf({ status: statusOf({ pinnedByEnvironment: true }) }));
    expect(text()).toContain('set by BOTBOY_KNOWLEDGE_ROOT');
    expect(document.querySelector('[data-action="knowledge-change-open"]')).toBeNull();
    paint(modelOf({ status: statusOf({ pinnedByEnvironment: true, state: 'folder_missing', message: 'missing' }) }));
    expect(document.querySelector('[data-action="knowledge-recreate"]')).toBeNull();
  });

  it('loading and load failure: a skeleton first, then the error with Try again', () => {
    paint(modelOf({ status: null }));
    expect(document.querySelector('.loading-shell')).not.toBeNull();
    paint(modelOf({ status: null, error: 'HTTP 500 — boom' }));
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('HTTP 500 — boom');
    expect(document.querySelector('[data-action="knowledge-refresh"]')!.textContent).toBe('Try again');
  });
});

describe('Settings → Knowledge page: what is said about the folder', () => {
  it('the usage card names exactly what the write protection covers and what it does not', () => {
    paint(modelOf());
    const usage = document.querySelector('.knowledge-usage')!.textContent ?? '';
    expect(usage).toContain('Loaded files are sent to your chosen AI model');
    expect(usage).toContain('BotBoy never watches this folder');
    expect(usage).toContain('Commands BotBoy runs for you can read this folder but cannot change it');
    expect(usage).toContain('the run_command tool, the chat terminal and MCP servers you added with a command');
    expect(usage).toContain('It does not cover BotBoy’s built-in connections or the browser BotBoy drives');
    // The draft said "terminal, run_command and connectors": built-in connectors are NOT covered by the deny.
    expect(usage).not.toMatch(/and connectors/);
    expect(usage).toContain('BotBoy refuses to load a file that contains a secret');
  });

  it('the location card says the protection is off when the deny does not report the root', () => {
    paint(modelOf({ status: statusOf({ denyActive: true }) }));
    expect(text()).toContain('Commands BotBoy runs for you can read this folder but cannot change it');
    paint(modelOf({ status: statusOf({ denyActive: false }) }));
    expect(document.querySelector('.knowledge-location')!.textContent).toContain('is not active. Restart BotBoy.');
    expect(document.querySelector('.knowledge-location')!.textContent).not.toContain('cannot change it');
  });

  it('the location card repeats the sync sentence from the server', () => {
    paint(modelOf());
    expect(document.querySelector('.knowledge-location')!.textContent).toContain(SYNC);
  });
});

describe('Settings → Knowledge page: Change location', () => {
  it('opens a form that explains the copy, and shows the existing-folder question inside it', () => {
    paint(modelOf({ changing: true, changeDraft: '/Users/someone/Elsewhere' }));
    const form = document.querySelector('form[data-knowledge-form="change"]')!;
    expect(form).not.toBeNull();
    expect((form.querySelector('input[name="path"]') as HTMLInputElement).value).toBe('/Users/someone/Elsewhere');
    expect(form.textContent).toContain('copies the whole folder to the new place, checks every file, and only then switches');
    expect(form.textContent).toContain('BotBoy never deletes it');
    expect(form.querySelector('button[type="submit"]')!.textContent).toBe('Copy and switch');
    expect(document.querySelector('[data-action="knowledge-change-open"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(form.querySelector('input[name="confirmExisting"]')).toBeNull();

    paint(modelOf({ changing: true, changeDraft: '/x', existing: { mode: 'change', path: '/x', entries: 3, sample: ['a.md', 'b.md'] } }));
    const box = document.querySelector('form[data-knowledge-form="change"] input[name="confirmExisting"]') as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(document.body.textContent).toContain('/x already holds 3 items (a.md, b.md).');
    // The create form's question never appears inside the change form, and vice versa.
    paint(modelOf({ changing: true, existing: { mode: 'create', path: '/y', entries: 1, sample: [] } }));
    expect(document.querySelector('input[name="confirmExisting"]')).toBeNull();
  });

  it('shows the note the server returns after a switch, beside the result', () => {
    const note = 'Your old folder at /old was left exactly as it was; BotBoy never deletes it. Terminals or tools started before this change keep the old protection until they restart.';
    paint(modelOf({ notice: { scope: 'location', tone: 'good', message: 'Switched to /new. 4 files copied.', nextAction: note } }));
    const status = document.querySelector('.knowledge-location [role="status"]')!;
    expect(status.textContent).toContain('Switched to /new. 4 files copied.');
    expect(status.textContent).toContain('Terminals or tools started before this change keep the old protection until they restart.');
  });

  it('keeps a Move notice out of the location card and the reverse', () => {
    paint(modelOf({ notice: { scope: 'move', tone: 'bad', message: 'moved wrongly' }, status: statusOf({ legacyAnalytics: { dir: '/old', files: 1, hasManifest: false }, analyticsDir: 'legacy' }) }));
    expect(document.querySelector('.knowledge-location')!.textContent).not.toContain('moved wrongly');
    expect(document.querySelector('.knowledge-move')!.textContent).toContain('moved wrongly');
  });
});

describe('Settings → Knowledge page: moving the analytics knowledge', () => {
  const legacy = { dir: '/Users/someone/old-notes', files: 5, hasManifest: true };
  const plan = (overrides: Record<string, unknown> = {}) => ({
    ok: true, reason: null, alreadyMigrated: false, source: legacy.dir, target: `${ROOT}/analytics`,
    entries: [
      { name: 'schema.md', bytes: 2048, sha256: 'a'.repeat(64), fromLink: false, state: 'copy' },
      { name: 'presets/shopwave.md', bytes: 1024, sha256: 'b'.repeat(64), fromLink: false, state: 'copy' },
      { name: 'notes.md', bytes: 10, sha256: 'c'.repeat(64), fromLink: false, state: 'present' },
    ],
    conflicts: [], blocked: [], ignored: [], reclassified: [], totalBytes: 3082, freeBytes: null, onboardingBusy: false, boundaryRegistered: true,
    planSha256: 'd'.repeat(64), previousDir: legacy.dir, ...overrides,
  });
  const legacyStatus = () => statusOf({ analyticsDir: 'legacy', legacyAnalytics: legacy });

  it('offers a preview while the knowledge is still in the old folder, and repeats the sync sentence there', () => {
    paint(modelOf({ status: legacyStatus() }));
    const card = document.querySelector('.knowledge-move')!;
    expect(card.textContent).toContain('5 files and a manifest in /Users/someone/old-notes');
    expect(card.querySelector('[data-action="knowledge-move-preview"]')!.textContent).toBe('Preview the move');
    expect(card.querySelector('.knowledge-sync-note')!.textContent).toBe(SYNC);
    expect(card.textContent).toContain('The old folder is left as it is, and you can revert at any time.');
    expect(card.querySelector('[data-action="knowledge-move-apply"]')).toBeNull();
  });

  it('shows what the preview will copy and enables Move now only for a plan that can be applied', () => {
    paint(modelOf({ status: legacyStatus(), plan: plan() }));
    const card = document.querySelector('.knowledge-move')!;
    expect(card.textContent).toContain('2 files (3 KB) will be copied to');
    expect(card.textContent).toContain('1 file is already there with the same content');
    expect((card.querySelector('[data-action="knowledge-move-apply"]') as HTMLButtonElement).disabled).toBe(false);

    paint(modelOf({ status: legacyStatus(), plan: plan({ ok: false, reason: 'conflict', conflicts: ['schema.md'] }) }));
    expect((document.querySelector('[data-action="knowledge-move-apply"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('1 file differs from what is already in the Knowledge folder: schema.md.');
    expect(document.body.textContent).toContain('Nothing was changed.');
  });

  it('names blocked items, a running preset generation, a missing protection, and ignored items', () => {
    paint(modelOf({
      status: legacyStatus(),
      plan: plan({
        ok: false, blocked: [{ name: 'odd.md', reason: 'a link that leaves the folder' }], onboardingBusy: true, reason: 'boundary_not_registered',
        ignored: [{ name: '.onboarding', reason: 'private work files' }],
      }),
    }));
    const body = document.body.textContent ?? '';
    expect(body).toContain('1 item cannot be moved safely: odd.md (a link that leaves the folder).');
    expect(body).toContain('Preset generation is running');
    expect(body).toContain('The protection for the Knowledge folder is not in effect');
    expect(body).toContain('1 item is not moved');
    expect(document.querySelector('.knowledge-plan details li')!.textContent).toContain('.onboarding');
  });

  it('asks for an acknowledgement when a root GUIDE.md would be reclassified, and keeps Move now off until it is given', () => {
    paint(modelOf({ status: legacyStatus(), plan: plan({ reclassified: ['GUIDE.md'] }) }));
    const box = document.querySelector('[data-knowledge-ack]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.querySelector('.knowledge-confirm')!.textContent).toContain('GUIDE.md in the old folder becomes the guide of the analytics set');
    expect((document.querySelector('[data-action="knowledge-move-apply"]') as HTMLButtonElement).disabled).toBe(true);
    paint(modelOf({ status: legacyStatus(), plan: plan({ reclassified: ['GUIDE.md'] }), acknowledged: true }));
    expect((document.querySelector('[data-knowledge-ack]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('[data-action="knowledge-move-apply"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables every move control while an action runs', () => {
    paint(modelOf({ status: legacyStatus(), plan: plan(), busy: 'apply' }));
    expect(document.querySelector('[data-action="knowledge-move-apply"]')!.textContent).toBe('Moving…');
    for (const button of document.querySelectorAll('.knowledge-move button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.knowledge-move')!.getAttribute('aria-busy')).toBe('true');
  });

  it('after the move: says where the files came from and what Revert does, and never says anything is deleted', () => {
    paint(modelOf({ status: statusOf({ migration: { at: '2026-10-15T10:00:00.000Z', files: 5, source: legacy.dir, target: `${ROOT}/analytics` }, analyticsDir: 'library' }) }));
    const card = document.querySelector('.knowledge-move')!;
    expect(card.textContent).toContain('5 files now live in the analytics set');
    expect(card.textContent).toContain(legacy.dir);
    expect(card.textContent).toContain('Nothing is deleted.');
    expect(card.querySelector('[data-action="knowledge-move-revert"]')!.textContent).toBe('Revert');
    expect(card.textContent).toContain('.pre-revert');
    // Library mode on a fresh install, with nothing moved, has no Move card at all.
    paint(modelOf());
    expect(document.querySelector('.knowledge-move')).toBeNull();
  });
});

describe('Settings → Knowledge page: untrusted text is escaped', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>window.__pwned = 1</script>';

  it('escapes a hostile set name, id, description, issue and folder path in the rendered page', () => {
    (window as unknown as { __pwned?: number }).__pwned = 0;
    paint(modelOf({
      status: statusOf({
        root: `/Users/${hostile}/Knowledge`,
        sets: [set({ id: `x/${hostile}`, name: hostile, description: hostile, issues: [{ code: 'hostile', message: hostile }] })],
      }),
    }));
    expect(document.querySelector('img, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBe(0);
    const row = document.querySelector('.knowledge-sets-table tbody tr')!;
    expect(row.textContent).toContain(hostile);
    expect(row.querySelectorAll('li')).toHaveLength(1);
    expect(document.querySelector('.knowledge-path')!.textContent).toContain(hostile);
  });

  it('escapes a hostile path draft in the input, an existing-folder sample, a conflict name and a notice', () => {
    paint(modelOf({
      status: statusOf({ activated: false, root: null, state: 'not_created' }),
      createDraft: `"><script>window.__pwned = 2</script>`,
      existing: { mode: 'create', path: hostile, entries: 2, sample: [hostile] },
      notice: { scope: 'location', tone: 'bad', message: hostile, nextAction: hostile },
    }));
    expect(document.querySelector('script, img')).toBeNull();
    expect((document.querySelector('input[name="path"]') as HTMLInputElement).value).toBe(`"><script>window.__pwned = 2</script>`);
    expect(text()).toContain(hostile);

    paint(modelOf({
      status: statusOf({ analyticsDir: 'legacy', legacyAnalytics: { dir: hostile, files: 1, hasManifest: false } }),
      plan: { ok: false, entries: [], conflicts: [hostile], blocked: [{ name: hostile, reason: hostile }], ignored: [{ name: hostile, reason: hostile }], reclassified: [hostile], target: hostile },
    }));
    expect(document.querySelector('script, img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBe(0);
  });

  it('escapes the analytics card text for a library-mode folder name and its unavailable message', () => {
    document.body.innerHTML = renderer.renderAnalyticsInLibrary({ dir: hostile, fileCount: 2, unavailable: { message: hostile, nextAction: hostile } }, helpers);
    expect(document.querySelector('script, img')).toBeNull();
    expect(text()).toContain(hostile);
  });
});

describe('Settings → Knowledge page: the ETL connection card', () => {
  function loadCard(): (ctx: Record<string, unknown> | null) => string {
    const source = [constLine('icon'), constLine('esc'), constLine('attr'), constLine('number'), topLevel('pageHead'), topLevel('loadingView'),
      topLevel('renderAnalyticsKnowledgeDirSection'), 'return renderAnalyticsKnowledgeDirSection;'].join('\n');
    // eslint-disable-next-line no-new-func
    return new Function('window', source)(window);
  }

  it('legacy mode is unchanged: the directory field and Save directory', () => {
    const render = loadCard();
    document.body.innerHTML = render({ dir: '/old/notes', configured: '', fileCount: 3 });
    expect(document.getElementById('analytics-context-dir')).not.toBeNull();
    expect(document.querySelector('[data-action="analytics-context-save"]')!.textContent).toBe('Save directory');
    expect(text()).toContain('3 knowledge files');
    expect(text()).toContain('drop your schema or methodology notes at the root');
    expect(document.querySelector('a[href="#/settings/knowledge"]')).toBeNull();
    document.body.innerHTML = render(null);
    expect(text()).toContain('Loading…');
  });

  it('library mode hides the directory field and links to Settings → Knowledge', () => {
    const render = loadCard();
    document.body.innerHTML = render({ library: true, dir: `${ROOT}/analytics`, configured: '', fileCount: 1 });
    expect(document.getElementById('analytics-context-dir')).toBeNull();
    expect(document.querySelector('[data-action="analytics-context-save"]')).toBeNull();
    expect(text()).toContain('1 knowledge file');
    expect(text()).toContain('lives in the Knowledge folder');
    expect(document.querySelector('a[href="#/settings/knowledge"]')).not.toBeNull();
    expect(text()).toContain(`${ROOT}/analytics`);
  });

  it('library mode shows a folder macOS blocked instead of an empty count', () => {
    const render = loadCard();
    document.body.innerHTML = render({ library: true, dir: `${ROOT}/analytics`, fileCount: 0, unavailable: { message: 'macOS blocked the Knowledge folder.', nextAction: 'Allow it in System Settings.' } });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('macOS blocked the Knowledge folder. Allow it in System Settings.');
  });

  it('the legacy-only POST path is not reachable from the card in library mode (the server answers moved_to_library)', () => {
    expect(dashboard).toContain("if (ctx?.library && window.BotBoyKnowledge) return window.BotBoyKnowledge.renderAnalyticsInLibrary(ctx, {");
  });
});

// ── The real handlers, run against a stub `request` ──

type Call = { path: string; options: { method?: string; body?: unknown } | undefined };
function freshKnowledgeState(): Record<string, unknown> {
  const line = between(dashboard, '  knowledge: {', '\n');
  // eslint-disable-next-line no-new-func
  return new Function(`return ({${line}});`)().knowledge;
}
function loadHandlers(options: {
  respond: (path: string, init: Call['options']) => unknown | Promise<unknown>;
  confirm?: boolean;
  route?: string;
}) {
  const calls: Call[] = [];
  const renders: Array<Record<string, unknown>> = [];
  const state: any = { route: { view: options.route ?? 'knowledge-settings' }, knowledge: freshKnowledgeState() };
  const request = async (requestPath: string, init?: Call['options']) => {
    calls.push({ path: requestPath, options: init });
    return options.respond(requestPath, init);
  };
  const source = ['knowledgeErrorText', 'knowledgeNotice', 'applyKnowledgeStatus', 'loadKnowledgeStatus', 'restoreKnowledgeFocus', 'runKnowledgeAction',
    'knowledgeRootBody', 'createKnowledgeFolder', 'rescanKnowledge', 'changeKnowledgeLocation', 'previewKnowledgeMove', 'applyKnowledgeMove',
    'revertKnowledgeMove', 'loadKnowledgeStatusNow', 'enterKnowledgePage', 'loadKnowledgeWritePath', 'knowledgePageAction'].map(topLevel).join('\n')
    + '\nreturn { createKnowledgeFolder, rescanKnowledge, changeKnowledgeLocation, previewKnowledgeMove, applyKnowledgeMove, revertKnowledgeMove, loadKnowledgeStatus, enterKnowledgePage, restoreKnowledgeFocus, loadKnowledgeWritePath, knowledgePageAction };';
  const fakeWindow = { confirm: () => options.confirm ?? true, BotBoyKnowledge: renderer, submitChat: async () => { submitted.push(String((document.getElementById('chatInput') as HTMLTextAreaElement | null)?.value ?? '')); } };
  const submitted: string[] = [];
  const assistantOpened: boolean[] = [];
  const renderRoute = (arg: Record<string, unknown>) => renders.push({ ...arg, busy: state.knowledge.busy });
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'request', 'renderRoute', 'window', 'document', 'CSS', 'toggleAssistant', source)(
    state, request, renderRoute, fakeWindow, document, { escape: (value: string) => value }, (open: boolean) => { assistantOpened.push(open); },
  );
  return { api, calls, renders, state, submitted, assistantOpened };
}
class HttpError extends Error {
  status: number; code: string; nextAction: string; payload: Record<string, unknown>;
  constructor(status: number, payload: Record<string, unknown>) {
    super(`HTTP ${status} — ${payload.error}`);
    this.status = status; this.code = String(payload.code ?? ''); this.nextAction = String(payload.nextAction ?? ''); this.payload = payload;
  }
}

describe('Settings → Knowledge handlers', () => {
  it('Create folder sends an object body {path} and adds confirmExisting only after the owner ticked it', async () => {
    const h = loadHandlers({ respond: () => ({ ok: true, root: ROOT, created: true, seededGuide: true, status: statusOf() }) });
    await h.api.createKnowledgeFolder('  /Users/someone/Documents/BotBoy Knowledge  ', false);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].path).toBe('/knowledge/root');
    expect(h.calls[0].options?.method).toBe('POST');
    expect(typeof h.calls[0].options?.body).toBe('object');
    expect(h.calls[0].options?.body).toStrictEqual({ path: '/Users/someone/Documents/BotBoy Knowledge' });

    await h.api.createKnowledgeFolder('/x', true);
    expect(h.calls[1].options?.body).toStrictEqual({ path: '/x', confirmExisting: true });
  });

  it('Create folder success replaces the status, clears the draft, says what happened, and moves focus to a control that still exists', async () => {
    const h = loadHandlers({ respond: () => ({ ok: true, root: ROOT, created: true, seededGuide: true, status: statusOf({ version: 9 }) }) });
    await h.api.createKnowledgeFolder('/x', false);
    const k = h.state.knowledge;
    expect(k.status.version).toBe(9);
    expect(k.createDraft).toBe('');
    expect(k.existing).toBeNull();
    expect(k.busy).toBe('');
    expect(k.notice).toMatchObject({ scope: 'location', tone: 'good', message: 'Knowledge folder created.' });
    expect(k.pendingFocus).toBe('change-open');
    // Busy repaint first, final repaint after; both are owner actions and keep the scroll.
    expect(h.renders.map(render => render.busy)).toEqual(['create', '']);
    expect(h.renders.every(render => render.userAction === true && render.preserveScroll === true)).toBe(true);
  });

  it('a non-empty existing folder is asked about inside the form, then confirmed on the second click', async () => {
    let attempt = 0;
    const h = loadHandlers({
      respond: (_path, init) => {
        attempt += 1;
        if (attempt === 1) throw new HttpError(409, { error: 'The folder is not empty.', code: 'confirm_existing', nextAction: 'Confirm to use it.', existing: { entries: 3, sample: ['a.md'] } });
        expect((init?.body as Record<string, unknown>).confirmExisting).toBe(true);
        return { ok: true, root: '/x', created: false, seededGuide: false, status: statusOf() };
      },
    });
    await h.api.createKnowledgeFolder('/x', false);
    expect(h.state.knowledge.existing).toStrictEqual({ mode: 'create', path: '/x', entries: 3, sample: ['a.md'] });
    expect(h.state.knowledge.notice).toBeNull();
    expect(h.state.knowledge.createDraft).toBe('/x');
    expect(h.state.knowledge.pendingFocus).toBe('existing-create');
    await h.api.createKnowledgeFolder('/x', true);
    expect(h.state.knowledge.existing).toBeNull();
    expect(h.state.knowledge.notice).toMatchObject({ tone: 'good', message: 'Knowledge folder ready.' });
  });

  it('a refusal is shown with the server message and next action, and the form stays', async () => {
    const h = loadHandlers({ respond: () => { throw new HttpError(403, { error: 'macOS did not allow it.', code: 'permission_denied', nextAction: 'Allow Documents in System Settings.' }); } });
    await h.api.createKnowledgeFolder('/x', false);
    expect(h.state.knowledge.notice).toStrictEqual({ scope: 'location', tone: 'bad', message: 'macOS did not allow it.', nextAction: 'Allow Documents in System Settings.' });
    expect(h.state.knowledge.status).toBeNull();
    expect(h.state.knowledge.busy).toBe('');
    expect(h.state.knowledge.pendingFocus).toBe('create');
  });

  it('Create folder again posts the recorded root and returns focus to its own button on failure', async () => {
    const h = loadHandlers({ respond: () => { throw new HttpError(503, { error: 'Still missing.', code: 'boundary_not_registered', nextAction: 'Restart BotBoy.' }); } });
    await h.api.createKnowledgeFolder(ROOT, false, 'recreate');
    expect(h.calls[0].options?.body).toStrictEqual({ path: ROOT });
    expect(h.state.knowledge.pendingFocus).toBe('recreate');
  });

  it('an empty path sends nothing', async () => {
    const h = loadHandlers({ respond: () => ({}) });
    await h.api.createKnowledgeFolder('   ', false);
    await h.api.changeKnowledgeLocation('', false);
    expect(h.calls).toHaveLength(0);
  });

  it('one action at a time: a second click while one runs sends nothing', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise(resolve => { release = resolve; });
    const h = loadHandlers({ respond: () => gate });
    const first = h.api.createKnowledgeFolder('/x', false);
    await h.api.createKnowledgeFolder('/x', false);
    await h.api.rescanKnowledge();
    expect(h.calls).toHaveLength(1);
    release({ ok: true, status: statusOf() });
    await first;
    expect(h.state.knowledge.busy).toBe('');
  });

  it('Rescan posts with no body and shows the fresh status', async () => {
    const h = loadHandlers({ respond: () => statusOf({ version: 12, sets: [set()] }) });
    await h.api.rescanKnowledge();
    expect(h.calls[0]).toStrictEqual({ path: '/knowledge/rescan', options: { method: 'POST' } });
    expect(h.state.knowledge.status.sets).toHaveLength(1);
    expect(h.state.knowledge.notice).toMatchObject({ tone: 'good', message: 'Rescanned the Knowledge folder.' });
  });

  it('Change location shows the server note, closes the form, and a confirm question stays in the form', async () => {
    const note = 'Your old folder at /old was left exactly as it was; BotBoy never deletes it. Terminals or tools started before this change keep the old protection until they restart.';
    let attempt = 0;
    const h = loadHandlers({
      respond: (_path, init) => {
        attempt += 1;
        if (attempt === 1) throw new HttpError(409, { error: 'not empty', code: 'confirm_existing', nextAction: 'Confirm.', existing: { entries: 2, sample: ['z.md'] } });
        expect(init?.body).toStrictEqual({ path: '/new', confirmExisting: true });
        return { ok: true, root: '/new', oldRoot: '/old', copied: 4, skipped: 0, note, status: statusOf({ root: '/new' }) };
      },
    });
    h.state.knowledge.changing = true;
    await h.api.changeKnowledgeLocation('/new', false);
    expect(h.state.knowledge.existing).toStrictEqual({ mode: 'change', path: '/new', entries: 2, sample: ['z.md'] });
    expect(h.state.knowledge.changing).toBe(true);
    await h.api.changeKnowledgeLocation('/new', true);
    const k = h.state.knowledge;
    expect(h.calls[0].path).toBe('/knowledge/root/change');
    expect(k.changing).toBe(false);
    expect(k.changeDraft).toBe('');
    expect(k.status.root).toBe('/new');
    expect(k.notice).toStrictEqual({ scope: 'location', tone: 'good', message: 'Switched to /new. 4 files copied.', nextAction: note });
  });

  it('Change location says what it did not copy, ahead of the server note (review D7)', async () => {
    const result = (notCopied: number, notCopiedSample: string[]) => ({ ok: true, root: '/new', oldRoot: '/old', copied: 3, skipped: 0, notCopied, notCopiedSample, note: 'NOTE', status: statusOf({ root: '/new' }) });
    const many = loadHandlers({ respond: () => result(5, ['.git', 'a/.draft.md', 'link.md', 'x', 'y']) });
    await many.api.changeKnowledgeLocation('/new', false);
    expect(many.state.knowledge.notice.nextAction).toBe('5 hidden items or links (.git, a/.draft.md, link.md, …) were not copied and are still in the old folder. NOTE');
    const one = loadHandlers({ respond: () => result(1, ['.git']) });
    await one.api.changeKnowledgeLocation('/new', false);
    expect(one.state.knowledge.notice.nextAction).toBe('1 hidden item or link (.git) was not copied and is still in the old folder. NOTE');
    const none = loadHandlers({ respond: () => result(0, []) });
    await none.api.changeKnowledgeLocation('/new', false);
    expect(none.state.knowledge.notice.nextAction).toBe('NOTE');
  });

  it('Move: preview, then apply sends the plan SHA (and the acknowledgement only when given), then reads the new status', async () => {
    const planned = { ok: true, planSha256: 'e'.repeat(64), entries: [], conflicts: [], blocked: [], ignored: [], reclassified: ['GUIDE.md'], target: '/t' };
    const h = loadHandlers({
      respond: path => {
        if (path === '/knowledge/migration/preview') return planned;
        if (path === '/knowledge/migration/apply') return { ok: true, copied: 5, skipped: 0, source: '/old', target: '/t', record: {} };
        return statusOf({ analyticsDir: 'library' });
      },
    });
    await h.api.previewKnowledgeMove();
    expect(h.state.knowledge.plan).toBe(planned);
    expect(h.state.knowledge.acknowledged).toBe(false);
    h.state.knowledge.acknowledged = true;
    await h.api.applyKnowledgeMove();
    const apply = h.calls.find(call => call.path === '/knowledge/migration/apply')!;
    expect(apply.options?.body).toStrictEqual({ confirm: 'e'.repeat(64), acknowledgeReclassified: true });
    expect(h.calls.map(call => call.path)).toEqual(['/knowledge/migration/preview', '/knowledge/migration/apply', '/knowledge/status']);
    expect(h.state.knowledge.plan).toBeNull();
    expect(h.state.knowledge.status.analyticsDir).toBe('library');
    expect(h.state.knowledge.notice).toMatchObject({ scope: 'move', tone: 'good', message: 'Moved 5 files into the analytics set.' });
    expect(h.state.knowledge.pendingFocus).toBe('move-revert');
  });

  it('Move without an acknowledgement does not send one; a plan that cannot be applied sends nothing', async () => {
    const h = loadHandlers({ respond: path => (path.endsWith('/apply') ? { ok: true, copied: 1 } : statusOf()) });
    h.state.knowledge.plan = { ok: true, planSha256: 'f'.repeat(64) };
    await h.api.applyKnowledgeMove();
    expect(h.calls.find(call => call.path.endsWith('/apply'))!.options?.body).toStrictEqual({ confirm: 'f'.repeat(64) });
    const blocked = loadHandlers({ respond: () => ({}) });
    blocked.state.knowledge.plan = { ok: false, planSha256: 'f'.repeat(64) };
    await blocked.api.applyKnowledgeMove();
    await blocked.api.applyKnowledgeMove();
    expect(blocked.calls).toHaveLength(0);
  });

  it('a changed folder clears the stale plan and asks for a fresh preview', async () => {
    const h = loadHandlers({ respond: () => { throw new HttpError(409, { error: 'The folder changed after the preview.', code: 'plan_changed', nextAction: 'Preview again.' }); } });
    h.state.knowledge.plan = { ok: true, planSha256: 'a'.repeat(64) };
    await h.api.applyKnowledgeMove();
    expect(h.state.knowledge.plan).toBeNull();
    expect(h.state.knowledge.notice).toMatchObject({ scope: 'move', tone: 'bad', message: 'The folder changed after the preview.', nextAction: 'Preview again.' });
    expect(h.state.knowledge.pendingFocus).toBe('move-preview');
  });

  it('Revert asks first, sends nothing when declined, and reports files kept as .pre-revert', async () => {
    const declined = loadHandlers({ respond: () => ({}), confirm: false });
    await declined.api.revertKnowledgeMove();
    expect(declined.calls).toHaveLength(0);
    const h = loadHandlers({
      respond: path => (path === '/knowledge/migration/revert' ? { ok: true, mirrored: 5, savedAsPreRevert: 2, source: '/old' } : statusOf({ analyticsDir: 'legacy' })),
    });
    await h.api.revertKnowledgeMove();
    expect(h.calls.map(call => call.path)).toEqual(['/knowledge/migration/revert', '/knowledge/status']);
    expect(h.state.knowledge.notice).toStrictEqual({
      scope: 'move', tone: 'good', message: 'Reverted: 5 files copied back to /old.', nextAction: '2 different files were kept as .pre-revert.',
    });
    expect(h.state.knowledge.pendingFocus).toBe('move-preview');
  });

  it('the latest answer wins: a status read that began before a write cannot overwrite it', async () => {
    let releaseRead: (value: unknown) => void = () => {};
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const h = loadHandlers({ respond: path => (path === '/knowledge/status' ? readGate : { ok: true, root: '/x', created: true, status: statusOf({ version: 50 }) }) });
    const read = h.api.loadKnowledgeStatus();
    await h.api.createKnowledgeFolder('/x', false);
    expect(h.state.knowledge.status.version).toBe(50);
    releaseRead(statusOf({ version: 1 }));
    await read;
    expect(h.state.knowledge.status.version).toBe(50);
  });

  it('a failed status read keeps the last good status and only sets an error', async () => {
    const h = loadHandlers({ respond: () => { throw new HttpError(500, { error: 'boom' }); } });
    h.state.knowledge.status = statusOf({ version: 4 });
    await h.api.loadKnowledgeStatus();
    expect(h.state.knowledge.status.version).toBe(4);
    expect(h.state.knowledge.error).toBe('boom');
    expect(h.state.knowledge.loading).toBe(false);
  });

  it('arriving on the page forgets the last visit and reads the status once', async () => {
    const h = loadHandlers({ respond: () => statusOf() });
    Object.assign(h.state.knowledge, { notice: { scope: 'location', tone: 'good', message: 'old' }, existing: { mode: 'create' }, changing: true, plan: {}, acknowledged: true, changeDraft: 'x' });
    h.api.enterKnowledgePage();
    await Promise.resolve();
    const k = h.state.knowledge;
    expect([k.notice, k.existing, k.changing, k.plan, k.acknowledged, k.changeDraft]).toStrictEqual([null, null, false, null, false, '']);
    // The status is read once; a ready folder then reads its pending changes and History with it (P2).
    expect(h.calls.map(call => call.path)).toEqual(['/knowledge/status', '/knowledge/changes', '/knowledge/history']);
  });

  it('focus returns to the control named by the last action once it is idle, and waits while busy', () => {
    const h = loadHandlers({ respond: () => ({}) });
    document.body.innerHTML = '<button data-knowledge-focus="rescan">Rescan</button><button data-knowledge-focus="create">Create</button>';
    h.state.knowledge.pendingFocus = 'rescan';
    h.state.knowledge.busy = 'rescan';
    h.api.restoreKnowledgeFocus();
    expect(document.activeElement).toBe(document.body);
    expect(h.state.knowledge.pendingFocus).toBe('rescan');
    h.state.knowledge.busy = '';
    h.api.restoreKnowledgeFocus();
    expect((document.activeElement as HTMLElement).dataset.knowledgeFocus).toBe('rescan');
    expect(h.state.knowledge.pendingFocus).toBe('');
  });
});

describe('Settings → Knowledge wiring', () => {
  it('routes, links and renders the page inside the existing Settings shell', () => {
    expect(dashboard).toContain("if (parts[0] === 'settings' && parts[1] === 'knowledge') return { view: 'knowledge-settings' };");
    // Settings stays highlighted in the sidebar on this page; the existing list is left as it was (two older tests pin it).
    expect(dashboard).toContain("|| (view === 'settings' && route.view === 'knowledge-settings');");
    expect(dashboard).toContain("['publisher-settings', 'llm-usage-settings', 'ai-model-settings', 'workplace-settings'].includes(route.view))");
    expect(dashboard).toContain("if (routeChanged && state.route.view === 'knowledge-settings') enterKnowledgePage();");
    expect(dashboard).toContain("if (state.route.view === 'knowledge-settings') html = renderKnowledgeSettings();");
    expect(dashboard).toContain("if (state.route.view === 'knowledge-settings') restoreKnowledgeFocus();");
  });

  it('is linked from both Settings navs (General and Workplace); the AI model page has a breadcrumb, not a nav', () => {
    const link = '<a class="button ghost" href="#/settings/knowledge">${icon(\'folder\')} Knowledge</a>';
    expect(topLevel('renderSettings')).toContain(link);
    expect(topLevel('renderWorkplaceSettings')).toContain(link);
    expect((dashboard.match(/class="card settings-nav"/g) ?? []).length).toBe(2);
    expect(topLevel('renderAiModelSettings')).not.toContain('settings-nav');
  });

  it('loads one classic script before the dashboard module, so window.BotBoyKnowledge exists when the page renders', () => {
    const tag = '<script src="./knowledge-ui.js"></script>';
    expect(html).toContain(tag);
    expect(html).not.toMatch(/<script[^>]*type="module"[^>]*knowledge-ui\.js/);
    expect(html.indexOf(tag)).toBeGreaterThan(html.indexOf('<script src="./analytics-html-view.js"></script>'));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf('<script type="module" src="./dashboard.js"></script>'));
    // The overlay controller is a second classic script (the renderer file must stay free of the DOM), between the two.
    const overlayTag = '<script src="./knowledge-overlay.js"></script>';
    expect(html).toContain(overlayTag);
    expect(html.indexOf(overlayTag)).toBeGreaterThan(html.indexOf(tag));
    expect(html.indexOf(overlayTag)).toBeLessThan(html.indexOf('<script type="module" src="./dashboard.js"></script>'));
    expect(uiSource).toContain('window.BotBoyKnowledge = {');
  });

  it('refetches only when knowledgeVersion moves, never on the first poll, never mid-action or mid-typing, and never reloads the tab', () => {
    expect(dashboard).toContain('state.lastKnowledgeVersion = payload.knowledgeVersion ?? null;');
    expect(dashboard).toContain('const previousKnowledgeVersion = state.lastKnowledgeVersion;');
    const refresh = between(dashboard, '// The Knowledge library changed', 'if (previousVersion !== null && payload.version !== previousVersion)');
    expect(refresh).toContain("state.route.view === 'knowledge-settings'");
    expect(refresh).toContain('!state.knowledge.busy');
    expect(refresh).toContain('previousKnowledgeVersion !== null && state.lastKnowledgeVersion !== null');
    expect(refresh).toContain('state.lastKnowledgeVersion !== previousKnowledgeVersion');
    expect(refresh).toContain("startsWith('knowledge-')");
    expect(refresh).toContain('void loadKnowledgeStatus();');
    expect(refresh).not.toMatch(/location\.reload|setTimeout|setInterval/);
  });

  it('announces a moved knowledgeVersion to the chat panel from the same poll, on any page, never on the first poll, and without a timer', () => {
    const announce = between(dashboard, '// Wherever the owner is, the chat panel', 'if (previousVersion !== null && payload.version !== previousVersion)');
    expect(announce).toContain('previousKnowledgeVersion !== null && state.lastKnowledgeVersion !== null && state.lastKnowledgeVersion !== previousKnowledgeVersion');
    expect(announce).toContain('announceKnowledgeChanged();');
    expect(announce).not.toContain('state.route.view'); // the chat panel is on every page
    expect(announce).not.toMatch(/location\.reload|setTimeout|setInterval/);
    // The helper is one event on window; the page needs no listener of its own (app.js listens).
    const helper = between(dashboard, 'function announceKnowledgeChanged() {', '\n}\n');
    expect(helper).toContain("new CustomEvent('botboy:knowledge-changed')");
    expect(helper).toContain('window.dispatchEvent?.(');
    expect(dashboard).not.toContain("addEventListener('botboy:knowledge-changed'");
  });

  it('adds no timer, poll, scroller or storage: the whole block and the renderer are free of them', () => {
    const block = between(dashboard, '// ── Settings → Knowledge (docs/maps/knowledge-library.md K12) ──', '// ── Explicitly confirmed S3/CloudFront snapshot publishing ──');
    expect(block).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|scrollTo|scrollTop|scrollIntoView|localStorage|sessionStorage|new EventSource|WebSocket/);
    expect(block).toContain("renderRoute({ preserveScroll: true, userAction: true })");
    expect(uiSource).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|scrollTo|scrollTop|scrollIntoView|localStorage|sessionStorage|fetch\(|document\.|XMLHttpRequest|innerHTML\s*=/);
    const from = css.indexOf('/* ── Settings → Knowledge');
    const overlayFrom = css.indexOf('/* ── Knowledge diff preview and overlay');
    expect(overlayFrom).toBeGreaterThan(from);
    // The page itself: no motion, no fixed layer and no scroll container of its own (overflow-wrap is text wrapping, not a scroller).
    expect(css.slice(from, overlayFrom)).not.toMatch(/animation|transition|position:\s*(fixed|sticky)|overflow(?:-[xy])?\s*:/);
    // The overlay section is the one deliberate exception: a fixed layer, a body that scrolls without chaining to the page,
    // a clipped preview window of fixed height, and still no motion.
    const overlayStyles = css.slice(overlayFrom);
    expect(overlayStyles).toMatch(/\.knowledge-overlay \{[^}]*position:fixed/);
    expect(overlayStyles).toMatch(/\.knowledge-overlay-body \{[^}]*overflow:auto;[^}]*overscroll-behavior:contain/);
    expect(overlayStyles).toMatch(/\.knowledge-diff-window \{[^}]*height:220px;[^}]*overflow:hidden/);
    expect(overlayStyles).not.toMatch(/animation|transition|sticky/);
  });

  it('the sets table wraps its prose and shows names as names, with selectors that outrank the shared Data Room table rules', () => {
    // jsdom has no layout, so the guard is on the rules. A long description once ran over the Files and Guide cells and the table was
    // cut off at the right (owner report 2026-10-16): `.data-room-table td { white-space: nowrap }` (0,1,1) beat `.knowledge-description`
    // (0,1,0), which never set white-space, and the row header inherited the 8px uppercase column-heading look.
    expect(css).toMatch(/\.data-room-table th,\.data-room-table td \{[^}]*white-space:nowrap/); // the premise: the shared rule is still there
    const specificity = (selector: string) => {
      const bare = selector.trim().replace(/\[[^\]]*\]/g, '[]');
      const ids = (bare.match(/#[\w-]+/g) ?? []).length;
      const classes = (bare.match(/\.[\w-]+|\[\]|:(?!:)[\w-]+/g) ?? []).length;
      const types = (bare.replace(/\[\]|[.#:][\w-]+/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
      return ids * 10000 + classes * 100 + types;
    };
    const declarationsOf = (selector: string): Record<string, string> => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
      expect(match, `missing the rule for ${selector}`).not.toBeNull();
      return Object.fromEntries(match![1].split(';').map(part => part.trim()).filter(Boolean).map(part => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]));
    };
    expect(specificity('.data-room-table td')).toBe(101); // 0,1,1: what the sets rules have to beat
    const description = declarationsOf('.knowledge-sets-table td.knowledge-description');
    expect(description).toMatchObject({ 'white-space': 'normal', 'overflow-wrap': 'anywhere', 'max-width': '340px' });
    expect(specificity('.knowledge-sets-table td.knowledge-description')).toBeGreaterThan(specificity('.data-room-table td'));
    const rowHeader = declarationsOf('.knowledge-sets-table th[scope="row"]');
    expect(rowHeader).toMatchObject({ 'white-space': 'normal', 'text-transform': 'none', 'font-size': '11px', 'letter-spacing': 'normal', background: 'transparent' });
    expect(specificity('.knowledge-sets-table th[scope="row"]')).toBeGreaterThan(specificity('.data-room-table th'));
    expect(declarationsOf('.knowledge-sets-table td:last-child')['white-space']).toBe('normal');
    expect(specificity('.knowledge-sets-table td:last-child')).toBeGreaterThan(specificity('.data-room-table td'));
    expect(declarationsOf('.knowledge-sets-table tbody th, .knowledge-sets-table tbody td')['vertical-align']).toBe('top');
    // The real markup still has the hooks those selectors need: a row header, the description as the third cell, the issues in the last.
    paint(modelOf({ status: statusOf({ sets: [set({ description: 'x'.repeat(220), issues: [{ code: 'a', message: 'One' }] })] }) }));
    const row = document.querySelector('.knowledge-sets-table tbody tr')!;
    expect(row.children[0].matches('th[scope="row"]')).toBe(true);
    expect(row.children[2].matches('td.knowledge-description')).toBe(true);
    expect(row.lastElementChild!.matches('td')).toBe(true);
    expect(row.lastElementChild!.querySelector('.knowledge-issues')).not.toBeNull();
  });

  it('keeps no secret or key in the page state, and every request goes to a /knowledge route', () => {
    const initial = between(dashboard, '  knowledge: {', '\n');
    expect(initial).not.toMatch(/apiKey|token|secret|password/i);
    const block = between(dashboard, '// ── Settings → Knowledge (docs/maps/knowledge-library.md K12) ──', '// ── Explicitly confirmed S3/CloudFront snapshot publishing ──');
    const paths = [...block.matchAll(/request\('([^']+)'/g)].map(match => match[1]);
    expect(new Set(paths)).toStrictEqual(new Set(['/knowledge/status', '/knowledge/changes', '/knowledge/history', '/knowledge/undo', '/knowledge/root', '/knowledge/rescan', '/knowledge/root/change', '/knowledge/migration/preview', '/knowledge/migration/apply', '/knowledge/migration/revert']));
  });

  it('dispatches every action the renderer emits, and every form it submits', () => {
    const actions = [...uiSource.matchAll(/data-action="(knowledge-[a-z-]+)"/g)].map(match => match[1]);
    expect(new Set(actions).size).toBeGreaterThanOrEqual(9);
    for (const action of new Set(actions)) {
      expect(dashboard, `no handler for ${action}`).toContain(`action === '${action}'`);
    }
    expect(dashboard).toContain('if (event.target?.dataset?.knowledgeForm) {');
    for (const form of ['create', 'change']) expect(dashboard).toContain(`form.dataset.knowledgeForm === '${form}'`);
    expect(dashboard).toContain("event.target?.matches?.('[data-knowledge-ack]')");
    // Every focus target the handlers name exists in the renderer.
    const targets = new Set([...dashboard.matchAll(/(?:pendingFocus(?: =|:) |, ')'?([a-z-]+)'/g)].map(match => match[1]));
    const rendered = new Set([...uiSource.matchAll(/data-knowledge-focus="([a-z-]+?)(?:-\$\{|")/g)].map(match => match[1]));
    for (const target of ['create', 'rescan', 'change', 'change-open', 'recreate', 'move-preview', 'move-apply', 'move-revert', 'move-ack']) {
      expect(rendered.has(target) || uiSource.includes(`data-knowledge-focus="${target}"`), `no control for focus target ${target}`).toBe(true);
    }
    expect(targets.size).toBeGreaterThan(0);
  });

  it('summarizes a plan without throwing on partial data', () => {
    expect(renderer.planSummary(null)).toStrictEqual({ copyCount: 0, presentCount: 0, copyBytes: 0, conflictCount: 0, blockedCount: 0, ignoredCount: 0 });
    expect(renderer.planSummary({ entries: [{ state: 'copy', bytes: 5 }, { state: 'present', bytes: 9 }], conflicts: ['a'], blocked: [{}], ignored: [{}, {}] }))
      .toStrictEqual({ copyCount: 1, presentCount: 1, copyBytes: 5, conflictCount: 1, blockedCount: 1, ignoredCount: 2 });
  });
});
