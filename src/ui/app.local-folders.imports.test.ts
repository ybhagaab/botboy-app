// @vitest-environment jsdom
//
// UI seams for Local folders import safety (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md
// P1/P3): per-folder state lines from `/api/local-folders/imports`, the
// big-file review card (grouped by subfolder, type-aware defaults, subfolder
// exclusion, all-or-nothing save), and the storage card with floor warnings.
// Same bootstrap as app.local-folders.test.ts: stub fetch/timers, then import
// app.js so its IIFE exposes the panel helpers on `window`.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const APP_HTML = `
  <div id="breadcrumb"></div>
  <div id="grid-view"></div>
  <div id="detail-view"></div>
  <div id="chat-messages"></div>
  <div id="chat-panel"></div>
  <input id="chatInput" />
  <span id="noise-toggle"></span>
  <section id="slack-sources">
    <div id="slack-sources-status" hidden></div>
    <div id="slack-sources-error" hidden></div>
    <div id="slack-sources-list"></div>
    <button id="slack-sources-save" type="button">Save</button>
  </section>
  <section id="local-folders" style="display:block">
    <div id="local-folders-status" hidden></div>
    <div id="local-folders-error" hidden></div>
    <button id="local-folders-add-btn" type="button">+ Add folder</button>
    <div id="local-folders-add-form" hidden>
      <input id="lf-path-input" type="text" />
      <label><input id="lf-recursive-input" type="checkbox" checked /> Recursive</label>
      <button id="lf-submit-add" type="button">Add</button>
      <button id="lf-cancel-add" type="button">Cancel</button>
    </div>
    <section id="local-folders-storage"></section>
    <div id="local-folders-list"></div>
  </section>
`;

type MockResponse = { ok: boolean; status: number; statusText: string; text: () => Promise<string>; json: () => Promise<unknown>; clone: () => MockResponse };
function makeResponse(status: number, body: unknown): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
    clone() { return makeResponse(status, body); },
  };
}

const GB = 1024 ** 3;
const ROOT = '/Users/me/Synthetic Persona';
const FOLDERS = [{ id: 5, path: ROOT, recursive: true, enabled: true, include_globs: [], exclude_globs: [] }];

function importsStatus(phase: string, overrides: Record<string, unknown> = {}) {
  return {
    started: true,
    firstPassAt: 1,
    disk: { freeBytes: 18 * GB, totalBytes: 460 * GB, measuredAt: 1, importFloorBytes: 10 * GB, liveFloorBytes: 2 * GB, importsPaused: false, liveCapturesPaused: false },
    thresholds: { bigFileBytes: 25 * 1024 ** 2, maxFileBytes: 200 * 1024 ** 2 },
    mainThread: { enabled: true, p99Ms: 20, maxMs: 40, stallCount: 0, recentStalls: [] },
    folders: [{
      folderId: 5, path: ROOT, enabled: true, phase, firstImportDone: false, progress: null,
      counts: { imported: 0, needs_review: 3, approved: 0, excluded: 0, too_large: 2, deferred_low_disk: 0 },
      excludedEntries: 0, lastResult: null, lastError: null,
      ...overrides,
    }],
  };
}

const REVIEW = {
  folderId: 5, root: ROOT, bigFileBytes: 25 * 1024 ** 2, maxFileBytes: 200 * 1024 ** 2, undecided: 3,
  files: [
    { path: `${ROOT}/data/users.csv`, relPath: 'data/users.csv', dir: 'data', name: 'users.csv', ext: '.csv', size: 40 * 1024 ** 2, mtimeMs: 1, decision: 'undecided', imported: false, readable: true, contentRemoved: false },
    { path: `${ROOT}/data/model.joblib`, relPath: 'data/model.joblib', dir: 'data', name: 'model.joblib', ext: '.joblib', size: 90 * 1024 ** 2, mtimeMs: 1, decision: 'undecided', imported: false, readable: false, contentRemoved: false },
    { path: `${ROOT}/registry/old.csv`, relPath: 'registry/old.csv', dir: 'registry', name: 'old.csv', ext: '.csv', size: 60 * 1024 ** 2, mtimeMs: 1, decision: 'undecided', imported: false, readable: true, contentRemoved: true },
  ],
  tooLarge: [
    { path: `${ROOT}/data/q22.csv`, relPath: 'data/q22.csv', dir: 'data', name: 'q22.csv', ext: '.csv', size: 19.8 * GB },
    { path: `${ROOT}/data/q23.csv`, relPath: 'data/q23.csv', dir: 'data', name: 'q23.csv', ext: '.csv', size: 3 * GB },
  ],
  excludedDirs: [],
};

const STORAGE = {
  measuredAt: Date.now(), durationMs: 400, dataDir: '/Users/me/.personal-productivity-tracker', botboyBytes: 8.1 * GB,
  categories: [
    { key: 'database', label: 'Database', bytes: 1.1 * GB, paths: [] },
    { key: 'backups', label: 'Repair backups', bytes: 1.9 * GB, paths: [] },
    { key: 'chromeProfile', label: 'Debug Chrome profile', bytes: 1.6 * GB, paths: [] },
  ],
  disk: { freeBytes: 18 * GB, totalBytes: 460 * GB },
  floors: { importFloorBytes: 10 * GB, liveFloorBytes: 2 * GB },
  warnings: [],
  nextActions: ['Exclude big files, or disable a folder you do not need, in the list below.', 'Delete old repair backups (1.9 GB).'],
};

type AnyFn = (...args: unknown[]) => unknown;
let fetchMock: ReturnType<typeof vi.fn>;
let appWindow: Window & Record<string, AnyFn | undefined>;
let imports: unknown;
let decideResponse: { status: number; body: unknown };

function route(input: RequestInfo, init?: RequestInit): Promise<MockResponse> {
  const url = typeof input === 'string' ? input : (input as Request).url;
  const method = init?.method ?? 'GET';
  if (url.endsWith('/api/local-folders') && method === 'GET') return Promise.resolve(makeResponse(200, { folders: FOLDERS }));
  if (url.endsWith('/api/local-folders/imports')) return Promise.resolve(makeResponse(200, imports));
  if (url.startsWith('/api/local-folders/storage')) return Promise.resolve(makeResponse(200, STORAGE));
  if (url.endsWith('/api/local-folders/5/review') && method === 'GET') return Promise.resolve(makeResponse(200, { review: REVIEW }));
  if (url.endsWith('/api/local-folders/5/review') && method === 'POST') return Promise.resolve(makeResponse(decideResponse.status, decideResponse.body));
  if (url.endsWith('/api/dashboard/version')) return Promise.resolve(makeResponse(200, { version: 0 }));
  if (url.endsWith('/api/slack/conversations')) return Promise.resolve(makeResponse(200, { conversations: [] }));
  if (url.endsWith('/api/slack/config')) return Promise.resolve(makeResponse(200, { ids: [] }));
  return Promise.resolve(makeResponse(200, []));
}

function calls(method: string, re: RegExp): Array<[string, RequestInit | undefined]> {
  return (fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>)
    .map(([u, init]) => [typeof u === 'string' ? u : (u as Request).url, init] as [string, RequestInit | undefined])
    .filter(([u, init]) => re.test(u) && (init?.method ?? 'GET') === method);
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Auto-open happens once per page session; later tests open the card explicitly. */
async function openReview(): Promise<Element> {
  (document.querySelector('[data-lf-state="5"] [data-lf-action="open-review"]') as HTMLButtonElement).click();
  await flush();
  return document.querySelector('[data-lf-review="5"]')!;
}

beforeAll(async () => {
  appWindow = window as unknown as typeof appWindow;
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  vi.stubGlobal('setTimeout', ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
  document.body.innerHTML = APP_HTML;
  imports = { folders: [] };
  fetchMock = vi.fn(route as unknown as AnyFn);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', () => true);
  await import('./app.js');
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  vi.stubGlobal('confirm', () => true);
  await Promise.resolve();
});

beforeEach(() => {
  document.body.innerHTML = APP_HTML;
  fetchMock.mockClear();
  imports = importsStatus('needs_review');
  decideResponse = { status: 200, body: { ok: true, applied: { kept: 1, excluded: 1, excludedDirs: 1, restoredDirs: 0 }, review: REVIEW } };
});

describe('Local folders — import states, big-file review, storage card', () => {
  it('shows the waiting-for-decision state and opens the review with type-aware defaults', async () => {
    await appWindow.loadLocalFolders!();
    await flush();
    const state = document.querySelector('[data-lf-state="5"]')!;
    expect(state.textContent).toContain('Needs your decision: 3 big files');
    expect(state.textContent).toContain('Skipped: 2 files too large to import yet');

    const card = document.querySelector('[data-lf-review="5"] .lf-review')!;
    expect(card).not.toBeNull();
    const heads = [...card.querySelectorAll('.lf-review-group-head')].map(el => el.textContent!.trim());
    expect(heads[0]).toMatch(/^data/);
    expect(heads[1]).toMatch(/^registry/);
    const box = (name: string) => card.querySelector(`input[data-lf-file$="/${name}"]`) as HTMLInputElement;
    expect(box('users.csv').checked).toBe(true);
    expect(box('model.joblib').checked).toBe(false);
    expect(box('old.csv').checked).toBe(false);
    expect(card.textContent).toContain('BotBoy may not be able to read this type');
    expect(card.textContent).toContain('Its content was removed earlier to free space');
    expect(card.querySelector('[data-lf-review-summary="5"]')!.textContent).toBe('Import 1 · Exclude 2');

    (card.querySelector('[data-lf-action="toggle-too-large"]') as HTMLButtonElement).click();
    const reopened = document.querySelector('[data-lf-review="5"] .lf-review')!;
    expect(reopened.textContent).toContain('data/q22.csv');
    expect(reopened.textContent).toContain('19.8 GB');
  });

  it('saves choices with a subfolder exclusion as one decision and closes on success', async () => {
    await appWindow.loadLocalFolders!();
    await flush();
    const slot = await openReview();
    (slot.querySelector('[data-lf-action="exclude-dir"][data-dir$="/registry"]') as HTMLButtonElement).click();
    const users = slot.querySelector('input[data-lf-file$="/users.csv"]') as HTMLInputElement;
    users.checked = false;
    users.dispatchEvent(new Event('change', { bubbles: true }));
    users.checked = true;
    users.dispatchEvent(new Event('change', { bubbles: true }));
    (slot.querySelector('[data-lf-action="save-review"]') as HTMLButtonElement).click();
    await flush();

    const posts = calls('POST', /\/api\/local-folders\/5\/review$/);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]!.body))).toEqual({
      keep: [`${ROOT}/data/users.csv`],
      exclude: [`${ROOT}/data/model.joblib`],
      excludeDirs: [`${ROOT}/registry`],
      restoreDirs: [],
    });
    expect(slot.innerHTML).toBe('');
    const status = document.getElementById('local-folders-status')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Saved: 1 kept, 2 excluded. Importing in the background.');
  });

  it('keeps the card and the choices when the server rejects the decision', async () => {
    decideResponse = {
      status: 400,
      body: { error: '1 entry could not be applied; nothing was changed.', invalid: [{ path: `${ROOT}/data/users.csv`, reason: 'is not in this folder’s big-file list' }], nextAction: 'Reload the big-file list and choose again.' },
    };
    await appWindow.loadLocalFolders!();
    await flush();
    const slot = await openReview();
    (slot.querySelector('[data-lf-action="save-review"]') as HTMLButtonElement).click();
    await flush();
    const error = slot.querySelector('.lf-review-error')!;
    expect(error.textContent).toContain('Not saved.');
    expect(error.textContent).toContain('users.csv is not in this folder’s big-file list');
    expect(error.textContent).toContain('Reload the big-file list');
    expect((slot.querySelector('input[data-lf-file$="/users.csv"]') as HTMLInputElement).checked).toBe(true);
  });

  it('names held possible credentials on the state line and lists them, with reasons, in the card', async () => {
    imports = importsStatus('watching', {
      firstImportDone: true,
      counts: { imported: 12, needs_review: 0, approved: 0, excluded: 0, too_large: 0, deferred_low_disk: 0, sensitive: 2 },
    });
    const review = {
      ...REVIEW, undecided: 0, files: [], tooLarge: [],
      sensitive: [
        { path: `${ROOT}/keys/server.pem`, relPath: 'keys/server.pem', dir: 'keys', name: 'server.pem', ext: '.pem', size: 1_700, reason: 'File type of a private key or certificate file (.pem)' },
        { path: `${ROOT}/deploy.md`, relPath: 'deploy.md', dir: '', name: 'deploy.md', ext: '.md', size: 90, reason: 'Contains what looks like a GitHub token' },
      ],
    };
    fetchMock.mockImplementation(((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/api/local-folders/5/review') && (init?.method ?? 'GET') === 'GET') return Promise.resolve(makeResponse(200, { review }));
      return route(input, init);
    }) as unknown as AnyFn);
    try {
      await appWindow.loadLocalFolders!();
      await flush();
      const state = document.querySelector('[data-lf-state="5"]')!;
      expect(state.textContent).toContain('2 possible credentials kept on this Mac (never sent to the AI)');
      const slot = await openReview();
      expect(slot.textContent).toContain('Show 2 possible credentials kept on this Mac');
      (slot.querySelector('[data-lf-action="toggle-sensitive"]') as HTMLButtonElement).click();
      const card = document.querySelector('[data-lf-review="5"] .lf-review')!;
      expect(card.textContent).toContain('keys/server.pem');
      expect(card.textContent).toContain('Contains what looks like a GitHub token');
      expect(card.textContent).toContain('never opened');
    } finally {
      fetchMock.mockImplementation(route as unknown as AnyFn);
    }
  });

  it('updates state lines on a poll without re-rendering an open review card', async () => {
    await appWindow.loadLocalFolders!();
    await flush();
    await openReview();
    const card = document.querySelector('[data-lf-review="5"] .lf-review');
    const users = document.querySelector('input[data-lf-file$="/users.csv"]') as HTMLInputElement;
    users.checked = false;
    users.dispatchEvent(new Event('change', { bubbles: true }));
    imports = importsStatus('needs_review', { counts: { imported: 0, needs_review: 4, approved: 0, excluded: 0, too_large: 2, deferred_low_disk: 0 } });
    await appWindow.refreshLfImportState!();
    expect(document.querySelector('[data-lf-state="5"]')!.textContent).toContain('Needs your decision: 4 big files');
    expect(document.querySelector('[data-lf-review="5"] .lf-review')).toBe(card);
    expect((document.querySelector('input[data-lf-file$="/users.csv"]') as HTMLInputElement).checked).toBe(false);
  });

  it('renders the storage card with the import-floor warning and refreshes on demand', async () => {
    imports = importsStatus('paused_low_disk', { counts: { imported: 0, needs_review: 0, approved: 0, excluded: 0, too_large: 0, deferred_low_disk: 0 } });
    (imports as any).disk.freeBytes = 6 * GB;
    (imports as any).disk.importsPaused = true;
    await appWindow.loadLocalFolders!();
    await flush();
    const storage = document.getElementById('local-folders-storage')!;
    expect(storage.textContent).toContain('BotBoy uses 8.1 GB · 6.0 GB free on this Mac');
    expect(storage.textContent).toContain('Repair backups');
    const warning = storage.querySelector('.lf-storage-warning.import')!;
    expect(warning.textContent).toContain('Folder imports are paused; watching and live captures continue.');
    expect((storage.querySelector('details.lf-storage-help') as HTMLDetailsElement).open).toBe(true);
    expect(document.querySelector('[data-lf-state="5"]')!.textContent).toContain('Import paused: free space is below 10.0 GB');

    fetchMock.mockClear();
    (storage.querySelector('[data-lf-storage="refresh"]') as HTMLButtonElement).click();
    await flush();
    expect(calls('GET', /\/api\/local-folders\/storage\?refresh=1$/)).toHaveLength(1);
  });

  it('warns about a file that keeps changing and pauses, keeps, or resumes it in one click', async () => {
    const changing = `${ROOT}/dashboard/training-progress.json`;
    const paused = `${ROOT}/reports/ledger.jsonl`;
    imports = importsStatus('watching', {
      firstImportDone: true,
      counts: { imported: 12, needs_review: 0, approved: 0, excluded: 0, too_large: 0, deferred_low_disk: 0, owner_paused: 1 },
      changingOften: [{ path: changing, relPath: 'dashboard/training-progress.json', versions: 47, maxBytes: 2.4 * 1024 ** 2, storedBytes: 110 * 1024 ** 2, lastCapturedAt: new Date().toISOString(), acknowledged: false }],
      ownerPaused: [{ path: paused, relPath: 'reports/ledger.jsonl', size: 800_000, mtimeMs: Date.now() - 2 * 3600_000 }],
    });
    decideResponse = { status: 200, body: { ok: true, applied: { paused: 1 } } };
    await appWindow.loadLocalFolders!();
    await flush();
    const state = document.querySelector('[data-lf-state="5"]')!;
    expect(state.textContent).toContain('Changing often: dashboard/training-progress.json (2.4 MB) was captured 47 times in the last day, 110.0 MB stored.');
    expect(state.textContent).toContain('Paused by you: reports/ledger.jsonl · last changed 2 hr ago');

    (state.querySelector(`[data-lf-action="pause-file"][data-path="${changing}"]`) as HTMLButtonElement).click();
    await flush();
    (document.querySelector(`[data-lf-state="5"] [data-lf-action="resume-file"][data-path="${paused}"]`) as HTMLButtonElement).click();
    await flush();
    (document.querySelector(`[data-lf-state="5"] [data-lf-action="keep-changing"][data-path="${changing}"]`) as HTMLButtonElement).click();
    await flush();
    const bodies = calls('POST', /\/api\/local-folders\/5\/review$/).map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies).toEqual([{ pause: [changing] }, { resume: [paused] }, { keepChanging: [changing] }]);
    expect(document.getElementById('local-folders-status')!.textContent).toContain('this warning stays off');
  });
});
