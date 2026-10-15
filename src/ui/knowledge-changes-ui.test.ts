// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Settings → Knowledge, the write path's part (docs/maps/knowledge-library.md K19): the pending changes and History cards
// from the real renderer (knowledge-ui.js in jsdom) and the real page handlers from dashboard.js run against a stub
// `request`. The chat card is covered by app.knowledge-card.test.ts; the server by routers/knowledge.changes.test.ts.
const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const uiSource = readFileSync(path.join(process.cwd(), 'src/ui/knowledge-ui.js'), 'utf8');
const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');

function topLevel(name: string): string {
  const start = dashboard.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  return dashboard.slice(start, dashboard.indexOf('\n}\n', start) + 2);
}
function constLine(name: string): string {
  const match = dashboard.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}
// eslint-disable-next-line no-new-func
new Function(uiSource)();
const renderer = (window as unknown as { BotBoyKnowledge: any }).BotBoyKnowledge;
// eslint-disable-next-line no-new-func
const helpers = new Function([constLine('icon'), constLine('esc'), constLine('attr'), constLine('number'), topLevel('pageHead'), topLevel('loadingView'), 'return { esc, attr, icon, number, pageHead, loadingView };'].join('\n'))();

const ROOT = '/Users/someone/Documents/BotBoy Knowledge';
const ID = 'kc_0123456789ab';
const READY = { version: 1, activated: true, root: ROOT, defaultRoot: ROOT, pinnedByEnvironment: false, state: 'ready', denyActive: true, sets: [], categories: [], looseCount: 0, analyticsDir: 'library', legacyAnalytics: null, migration: null, formerRoots: [], syncNote: 'x' };
const change = (over: Record<string, unknown> = {}) => ({
  id: ID, set: 'shop-data', kind: 'write', mode: 'edit', file: 'orders.md', status: 'staged', statusReason: null, origin: 'botboy_proposal', sources: [], why: 'verified in a real query', trigger: 'verified_fact',
  round: 1, attempt: 1, suspicious: false, unresolved: [], notes: [], check: {}, overrode: [], files: [{ path: 'shop-data/orders.md', effect: 'changed' }],
  diff: '--- a/orders.md\n+++ b/orders.md\n@@\n+ Use placeholders for dates.', historyId: null, needsAnyway: false, needsConfirm: false, actions: ['apply', 'dismiss', 'recheck'], ...over,
});
const entry = (over: Record<string, unknown> = {}) => ({ id: 'h_000000000001', at: '2026-10-15T10:00:00.000Z', actor: 'owner-via-botboy', kind: 'write', files: [{ path: 'shop-data/orders.md', before: 'a', after: 'b' }], summary: 'edit orders.md', ...over });
const model = (over: Record<string, unknown> = {}) => ({
  status: READY, error: '', busy: '', notice: null, existing: null, createDraft: '', changeDraft: '', changing: false, plan: null, acknowledged: false,
  changes: { counts: { waiting: 1, staged: 1, held: 0, stale: 0 }, changes: [change()] }, changesError: '',
  history: { entries: [entry()], latestUndoableId: 'h_000000000001', git: null, note: 'History stays on this Mac, outside the Knowledge folder.' }, historyError: '', historyOpen: '', historyDetail: {}, historyNotice: null, expandedDiffs: {}, cardNotices: {},
  ...over,
});
const paint = (over: Record<string, unknown> = {}) => { document.body.innerHTML = renderer.renderPage(model(over), helpers); return document.body; };
const text = () => document.body.textContent ?? '';

describe('the pending changes card', () => {
  it('lists what waits for the owner with the same card as chat, and says nothing is written until they apply it', () => {
    paint();
    const card = document.querySelector('.knowledge-pending .knowledge-page-card')!;
    expect(card.getAttribute('data-knowledge-change-id')).toBe(ID);
    expect(text()).toContain('Waiting for your decision');
    expect(text()).toContain('1 change · nothing is written until you apply it');
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Apply', 'Dismiss']);
    expect(card.querySelector('button[data-knowledge-action="apply"]')!.getAttribute('data-change-id')).toBe(ID);
  });

  it('says so when nothing waits, when it is loading, and when the list could not be read', () => {
    paint({ changes: { counts: { waiting: 0, staged: 0, held: 0, stale: 0 }, changes: [] } });
    expect(text()).toContain('Nothing is waiting.');
    paint({ changes: null });
    expect(document.querySelector('.knowledge-pending')!.textContent).toContain('Loading…');
    paint({ changes: null, changesError: 'The list is unavailable.' });
    expect(document.querySelector('.knowledge-pending [role="alert"]')!.textContent).toContain('The list is unavailable.');
  });

  it('shows an untrusted source and the full diff, a card notice, and escapes hostile text', () => {
    const long = ['--- a', '+++ b', ...Array.from({ length: 300 }, (_, index) => `+ line ${index}`)].join('\n');
    paint({ changes: { counts: { waiting: 1 }, changes: [change({ sources: ['email'], needsConfirm: true, diff: long, why: '<img src=x onerror=alert(1)>' })] }, cardNotices: { [ID]: 'The file changed. Use Re-draft.' } });
    expect(text()).toContain('Derived from email');
    expect(document.querySelectorAll('.knowledge-pending .knowledge-diff-line')).toHaveLength(302);
    expect(document.querySelector('.knowledge-pending img')).toBeNull();
    expect(text()).toContain('The file changed. Use Re-draft.');
    expect(text()).toContain('Review and apply');
  });

  it('only a ready folder shows it, and there is no scroller, timer or motion in its styles', () => {
    document.body.innerHTML = renderer.renderPage(model({ status: { ...READY, activated: false, state: 'not_created', root: null } }), helpers);
    expect(document.querySelector('.knowledge-pending')).toBeNull();
    expect(document.querySelector('.knowledge-history-card')).toBeNull();
    const styles = css.slice(css.indexOf('/* ── Settings → Knowledge'));
    expect(styles).not.toMatch(/animation|transition|position:\s*(fixed|sticky)|overflow(?:-[xy])?\s*:/);
  });
});

describe('the History card', () => {
  it('lists entries with who did it, a diff on demand, Undo on the latest only, and the notes', () => {
    paint({ history: { entries: [entry(), entry({ id: 'h_000000000002', actor: 'outside', kind: 'outside', summary: 'Edited outside BotBoy: notes.md', files: [] })], latestUndoableId: 'h_000000000001', git: { state: 'active', notice: null, gitDirectory: '/x', hint: 'git --git-dir="/x" log --stat' }, note: 'History stays on this Mac, outside the Knowledge folder.' } });
    const rows = [...document.querySelectorAll('.knowledge-history-entry')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('You, through BotBoy');
    expect(rows[1].textContent).toContain('Edited outside BotBoy');
    expect(document.querySelectorAll('[data-knowledge-action="history-undo"]')).toHaveLength(1);
    expect(rows[0].querySelector('[data-knowledge-action="history-undo"]')).not.toBeNull();
    // The button carries the entry it undoes (R26), and no change id.
    expect(rows[0].querySelector('[data-knowledge-action="history-undo"]')!.getAttribute('data-entry-id')).toBe('h_000000000001');
    expect(rows[0].querySelector('[data-knowledge-action="history-undo"]')!.hasAttribute('data-change-id')).toBe(false);
    expect(text()).toContain('Also browsable with git');
    expect(text()).toContain('History stays on this Mac');
    expect(text()).toContain('Time Machine');
  });

  it('opens a per-file diff, escapes it, and names a file whose older copy is gone or whose content is withheld', () => {
    const detail = { files: [{ path: 'shop-data/orders.md', kind: 'changed', diff: { text: '+<script>alert(1)</script>', totalLines: 1, shownLines: 1, truncated: false } }, { path: 'secrets.md', kind: 'created', diff: null, note: 'Content not shown or copied: it contains a private key.' }] };
    paint({ historyOpen: 'h_000000000001', historyDetail: { h_000000000001: detail } });
    expect(document.querySelector('.knowledge-history-entry script')).toBeNull();
    expect(text()).toContain('+<script>alert(1)</script>');
    expect(text()).toContain('Content not shown or copied');
    expect(document.querySelector('[data-knowledge-action="history-open"]')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('says so when there is nothing yet, and shows the Undo result or failure as a notice', () => {
    paint({ history: { entries: [], latestUndoableId: null, git: null, note: '' } });
    expect(text()).toContain('No changes yet');
    paint({ historyNotice: { scope: 'history', tone: 'bad', message: 'Another change came after this one.', nextAction: 'Open History.' } });
    expect(document.querySelector('.knowledge-history-card [role="alert"]')!.textContent).toContain('Another change came after this one.');
  });
});

// ── The real page handlers ──
type Call = { path: string; options: { method?: string; body?: unknown } | undefined };
function freshState(): Record<string, any> {
  const line = dashboard.slice(dashboard.indexOf('  knowledge: {'), dashboard.indexOf('\n', dashboard.indexOf('  knowledge: {')));
  // eslint-disable-next-line no-new-func
  return new Function(`return ({${line}});`)().knowledge;
}
function harness(respond: (path: string, init: Call['options']) => unknown) {
  const calls: Call[] = [];
  const renders: Array<Record<string, unknown>> = [];
  const submitted: string[] = [];
  const opened: boolean[] = [];
  const state: any = { route: { view: 'knowledge-settings' }, knowledge: { ...freshState(), status: READY } };
  const request = async (requestPath: string, init?: Call['options']) => {
    calls.push({ path: requestPath, options: init });
    const result = respond(requestPath, init);
    if (result instanceof Error) throw result;
    return result;
  };
  const source = ['knowledgeErrorText', 'knowledgeNotice', 'runKnowledgeAction', 'loadKnowledgeWritePath', 'knowledgePageAction'].map(topLevel).join('\n') + '\nreturn { loadKnowledgeWritePath, knowledgePageAction };';
  const fakeWindow = { BotBoyKnowledge: renderer, submitChat: async () => { submitted.push((document.getElementById('chatInput') as HTMLTextAreaElement).value); } };
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'request', 'renderRoute', 'window', 'document', 'toggleAssistant', source)(
    state, request, (arg: Record<string, unknown>) => renders.push(arg), fakeWindow, document, (open: boolean) => opened.push(open),
  );
  return { api, calls, renders, state, submitted, opened };
}
const failure = (payload: Record<string, unknown>) => Object.assign(new Error(String(payload.error)), { payload });
const clickable = (action: string, extra: Record<string, string> = {}) => {
  document.body.innerHTML = `<div class="knowledge-settings"><article data-knowledge-change-id="${ID}"><button data-knowledge-action="${action}" ${Object.entries(extra).map(([key, value]) => `data-${key}="${value}"`).join(' ')}>x</button></article></div><textarea id="chatInput"></textarea>`;
  return document.querySelector('button') as HTMLElement;
};

describe('the page handlers', () => {
  it('loads the pending changes and History together, each failing alone, and nothing for a folder that is not ready', async () => {
    const h = harness((p) => (p === '/knowledge/changes' ? { counts: { waiting: 0 }, changes: [] } : failure({ error: 'History is slow.' })));
    await h.api.loadKnowledgeWritePath();
    expect(h.state.knowledge.changes).toEqual({ counts: { waiting: 0 }, changes: [] });
    expect(h.state.knowledge.history).toBeNull();
    expect(h.state.knowledge.historyError).toBe('History is slow.');
    h.state.knowledge.status = { ...READY, state: 'needs_permission' };
    h.calls.length = 0;
    await h.api.loadKnowledgeWritePath();
    expect(h.calls).toEqual([]);
    expect(h.state.knowledge.changes).toBeNull();
  });

  it('Apply sends two booleans and no text; a refusal becomes a note on the card; the list is read again afterwards', async () => {
    const h = harness((p) => (p.endsWith('/apply') ? { ok: true } : p === '/knowledge/changes' ? { counts: {}, changes: [change({ needsConfirm: true, sources: ['email'] })] } : { entries: [], latestUndoableId: null }));
    h.state.knowledge.changes = { counts: {}, changes: [change({ needsConfirm: true, sources: ['email'] })] };
    await h.api.knowledgePageAction(clickable('apply', { 'change-id': ID }));
    const post = h.calls.find((call) => call.options?.method === 'POST')!;
    expect(post.path).toBe(`/knowledge/changes/${ID}/apply`);
    expect(post.options?.body).toEqual({ anyway: false, confirmFlagged: true });
    expect(h.calls.map((call) => call.path)).toContain('/knowledge/changes');
    const refused = harness((p) => (p.endsWith('/apply') ? failure({ error: 'The guide check still has open items.', nextAction: 'Press Apply anyway.' }) : { counts: {}, changes: [] }));
    refused.state.knowledge.changes = { counts: {}, changes: [change()] };
    await refused.api.knowledgePageAction(clickable('apply', { 'change-id': ID }));
    expect(refused.state.knowledge.cardNotices[ID]).toBe('The guide check still has open items. Press Apply anyway.');
  });

  it('Dismiss, Retry check, Undo and the History Undo go to their own routes; a failed Undo is a History notice', async () => {
    const h = harness(() => ({ ok: true, counts: {}, changes: [], entries: [], latestUndoableId: null }));
    for (const [action, expected] of [['dismiss', `/knowledge/changes/${ID}/dismiss`], ['recheck', `/knowledge/changes/${ID}/recheck`], ['undo', `/knowledge/changes/${ID}/undo`]] as const) {
      h.calls.length = 0;
      await h.api.knowledgePageAction(clickable(action, { 'change-id': ID }));
      expect(h.calls[0]).toEqual({ path: expected, options: { method: 'POST' } });
    }
    h.calls.length = 0;
    await h.api.knowledgePageAction(clickable('history-undo', { 'entry-id': 'h_000000000001' }));
    expect(h.calls[0]).toEqual({ path: '/knowledge/undo', options: { method: 'POST', body: { entryId: 'h_000000000001' } } });
    expect(h.state.knowledge.historyNotice).toMatchObject({ tone: 'good' });
    const failing = harness((p) => (p === '/knowledge/undo' ? failure({ error: 'Another change came after this one.', nextAction: 'Open History.' }) : { counts: {}, changes: [], entries: [] }));
    await failing.api.knowledgePageAction(clickable('history-undo', { 'entry-id': 'h_000000000001' }));
    expect(failing.state.knowledge.historyNotice).toMatchObject({ tone: 'bad', message: 'Another change came after this one.', nextAction: 'Open History.' });
    // The page reads the pending list and History again after the refusal, so it repaints with the new latest entry (R26).
    expect(failing.calls.map((call) => call.path)).toEqual(['/knowledge/undo', '/knowledge/changes', '/knowledge/history']);
    expect(failing.renders.length).toBeGreaterThan(0);
  });

  it('opens a History entry once (the detail is fetched, then kept), closes it again, and Show all expands a diff', async () => {
    const h = harness((p) => (p.startsWith('/knowledge/history/') ? { entry: entry(), files: [], undoable: true } : {}));
    await h.api.knowledgePageAction(clickable('history-open', { 'entry-id': 'h_000000000001' }));
    expect(h.state.knowledge.historyOpen).toBe('h_000000000001');
    expect(h.calls.map((call) => call.path)).toEqual(['/knowledge/history/h_000000000001']);
    await h.api.knowledgePageAction(clickable('history-open', { 'entry-id': 'h_000000000001' }));
    expect(h.state.knowledge.historyOpen).toBe('');
    await h.api.knowledgePageAction(clickable('history-open', { 'entry-id': 'h_000000000001' }));
    expect(h.calls).toHaveLength(1);
    await h.api.knowledgePageAction(clickable('diff-more', { 'change-id': ID }));
    expect(h.state.knowledge.expandedDiffs[ID]).toBe(true);
  });

  it('Ask BotBoy to fix opens the chat and sends an ordinary message with the card marker; no route is called', async () => {
    const h = harness(() => ({}));
    await h.api.knowledgePageAction(clickable('ask-fix', { 'change-id': ID }));
    expect(h.opened).toEqual([true]);
    expect(h.submitted).toEqual([`Please fix this change so it follows the guide. [[knowledge:${ID}]]`]);
    expect(h.calls).toEqual([]);
  });
});

describe('the wiring', () => {
  it('one page listener, scoped to the page, so a chat card is never handled twice', () => {
    expect(dashboard).toContain("const button = event.target.closest('.knowledge-settings [data-knowledge-action]');");
    expect(dashboard).toContain('if (button) void knowledgePageAction(button);');
    expect(readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8')).toContain("event.target.closest('.knowledge-chat-card [data-knowledge-action]')");
  });
});

describe('the first History entry', () => {
  it('is labelled "History started", not as an edit made outside BotBoy', () => {
    paint({ history: { entries: [entry({ id: 'h_000000000003', actor: 'outside', kind: 'baseline', files: [], summary: '1 file was in the folder when history started' })], latestUndoableId: null } });
    const row = document.querySelector('.knowledge-history-entry') as HTMLElement;
    expect(row.textContent).toContain('History started');
    expect(row.textContent).toContain('1 file was in the folder when history started');
    expect(row.textContent).not.toContain('Edited outside BotBoy');
  });

  it('keeps the outside label for a real outside edit', () => {
    paint({ history: { entries: [entry({ id: 'h_000000000004', actor: 'outside', kind: 'outside', files: [], summary: 'Edited outside BotBoy: notes.md' })], latestUndoableId: null } });
    expect((document.querySelector('.knowledge-history-entry') as HTMLElement).textContent).toContain('Edited outside BotBoy');
  });
});
