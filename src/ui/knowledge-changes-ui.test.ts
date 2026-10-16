// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Settings → Knowledge, the write path's part (docs/maps/knowledge-library.md K19): the pending changes and History cards
// from the real renderer (knowledge-ui.js in jsdom) and the real page handlers from dashboard.js run against a stub
// `request`. The chat card is covered by app.knowledge-card.test.ts; the server by routers/knowledge.changes.test.ts.
const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const uiSource = readFileSync(path.join(process.cwd(), 'src/ui/knowledge-ui.js'), 'utf8');
const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');
const overlaySource = readFileSync(path.join(process.cwd(), 'src/ui/knowledge-overlay.js'), 'utf8');

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
// eslint-disable-next-line no-new-func
new Function(overlaySource)();
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

// A diff with a file header pair, a hunk header, one removed and 300 added lines: 304 lines.
const LONG_DIFF = ['--- a/orders.md', '+++ b/orders.md', '@@ -1,2 +1,300 @@', '- old line', ...Array.from({ length: 300 }, (_, index) => `+ line ${index}`)].join('\n');
const BREACH = { tier: 'must_fix', rule: 'Do NOT add hardcoded dates', where: { file: 'orders.md', line: 8 }, problem: 'The new line names a date.', evidence: 'x', fix: 'Say "the campaign".', source: 'model' };

describe('the pending changes card', () => {
  it('lists what waits for the owner with a preview window and an Expand button, and says nothing is written until they apply it', () => {
    paint();
    const card = document.querySelector('.knowledge-pending .knowledge-page-card')!;
    expect(card.getAttribute('data-knowledge-change-id')).toBe(ID);
    expect(text()).toContain('Waiting for your decision');
    expect(text()).toContain('1 change · nothing is written until you apply it');
    expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Expand to read all 4 lines', 'Apply', 'Dismiss']);
    expect(card.querySelector('button[data-knowledge-action="apply"]')!.getAttribute('data-change-id')).toBe(ID);
    expect(card.querySelector('button[data-knowledge-action="diff-expand"]')!.getAttribute('data-change-id')).toBe(ID);
  });

  it('says so when nothing waits, when it is loading, and when the list could not be read', () => {
    paint({ changes: { counts: { waiting: 0, staged: 0, held: 0, stale: 0 }, changes: [] } });
    expect(text()).toContain('Nothing is waiting.');
    paint({ changes: null });
    expect(document.querySelector('.knowledge-pending')!.textContent).toContain('Loading…');
    paint({ changes: null, changesError: 'The list is unavailable.' });
    expect(document.querySelector('.knowledge-pending [role="alert"]')!.textContent).toContain('The list is unavailable.');
  });

  it('shows an untrusted source, a window onto the first 30 lines with Expand for the rest, a card notice, and escapes hostile text', () => {
    const long = ['--- a', '+++ b', ...Array.from({ length: 300 }, (_, index) => `+ line ${index}`)].join('\n');
    paint({ changes: { counts: { waiting: 1 }, changes: [change({ sources: ['email'], needsConfirm: true, diff: long, why: '<img src=x onerror=alert(1)>' })] }, cardNotices: { [ID]: 'The file changed. Use Re-draft.' } });
    expect(text()).toContain('Derived from email');
    expect(document.querySelectorAll('.knowledge-pending .knowledge-diff-line')).toHaveLength(30);
    expect(document.querySelector('.knowledge-pending button[data-knowledge-action="diff-expand"]')!.textContent).toBe('Expand to read all 302 lines');
    expect(document.querySelector('.knowledge-pending img')).toBeNull();
    expect(text()).toContain('The file changed. Use Re-draft.');
    expect(text()).toContain('Review and apply');
  });

  it('the preview is a labelled window, and Expand names what it opens: a change, or one History file', () => {
    paint({ changes: { counts: { waiting: 1 }, changes: [change({ diff: LONG_DIFF })] } });
    const window_ = document.querySelector('.knowledge-pending .knowledge-diff-window')!;
    expect(window_.getAttribute('role')).toBe('group');
    expect(window_.getAttribute('aria-label')).toContain('Preview');
    expect(window_.querySelectorAll('.knowledge-diff-line')).toHaveLength(30);
    const expand = document.querySelector('.knowledge-pending button[data-knowledge-action="diff-expand"]')!;
    expect(expand.getAttribute('aria-haspopup')).toBe('dialog');
    expect(document.querySelector('.knowledge-pending .knowledge-diff-bar .card-meta')!.textContent).toBe('1 file · 300 lines added, 1 removed');
    const detail = { files: [{ path: 'shop-data/orders.md', kind: 'changed', diff: { text: LONG_DIFF, totalLines: 304, shownLines: 304, truncated: false } }] };
    paint({ historyOpen: 'h_000000000001', historyDetail: { h_000000000001: detail } });
    const historyExpand = document.querySelector('.knowledge-history-entry button[data-knowledge-action="diff-expand"]')!;
    expect(historyExpand.getAttribute('data-entry-id')).toBe('h_000000000001');
    expect(historyExpand.getAttribute('data-file-index')).toBe('0');
    expect(historyExpand.hasAttribute('data-change-id')).toBe(false);
    expect(document.querySelectorAll('.knowledge-history-entry .knowledge-diff-line')).toHaveLength(30);
  });

  it('draws a header pair and a hunk header as meta, counts a real added line that begins with ++, and a diff with no text has no window', () => {
    paint({ changes: { counts: { waiting: 1 }, changes: [change({ diff: '--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-old\n+++ kept\n  same' })] } });
    const kinds = [...document.querySelectorAll('.knowledge-pending .knowledge-diff-line')].map((line) => line.className.replace('knowledge-diff-line ', ''));
    expect(kinds).toEqual(['meta', 'meta', 'meta', 'del', 'add', 'ctx']);
    paint({ changes: { counts: { waiting: 1 }, changes: [change({ diff: '' })] } });
    expect(document.querySelector('.knowledge-pending .knowledge-diff-window')).toBeNull();
    expect(document.querySelector('.knowledge-pending button[data-knowledge-action="diff-expand"]')).toBeNull();
  });

  it('puts the card that waits above the sets table, and the empty card below it', () => {
    const order = () => [...document.querySelectorAll('.knowledge-settings > *')].map((card) => ['knowledge-pending', 'knowledge-sets'].find((name) => card.classList.contains(name)) ?? '').filter(Boolean);
    paint();
    expect(order()).toEqual(['knowledge-pending', 'knowledge-sets']);
    paint({ changes: { counts: { waiting: 0, staged: 0, held: 0, stale: 0 }, changes: [] } });
    expect(order()).toEqual(['knowledge-sets', 'knowledge-pending']);
  });

  it('only a ready folder shows it, and the page styles have no scroller, timer or motion (the overlay section is the one exception)', () => {
    document.body.innerHTML = renderer.renderPage(model({ status: { ...READY, activated: false, state: 'not_created', root: null } }), helpers);
    expect(document.querySelector('.knowledge-pending')).toBeNull();
    expect(document.querySelector('.knowledge-history-card')).toBeNull();
    const from = css.indexOf('/* ── Settings → Knowledge');
    const styles = css.slice(from, css.indexOf('/* ── Knowledge diff preview and overlay', from));
    expect(styles).not.toMatch(/animation|transition|position:\s*(fixed|sticky)|overflow(?:-[xy])?\s*:/);
  });
});

describe('the diff styles', () => {
  it('draw one line per row: the box does not pre-wrap, so the newline between line elements is not a blank line (the first version doubled the height)', () => {
    expect(css).toMatch(/\.knowledge-diff \{[^}]*white-space:normal/);
    expect(css).toMatch(/\.knowledge-diff-line \{[^}]*white-space:pre-wrap/);
    expect(css).toMatch(/\.knowledge-diff-line \{[^}]*min-height:1\.5em/);
  });
});

describe('the overlay content: the whole change, with the buttons in a footer that does not scroll', () => {
  const overlayOf = (over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => {
    document.body.innerHTML = `<div class="knowledge-overlay">${renderer.renderChangeOverlay(change({ diff: LONG_DIFF, ...over }), helpers, options)}</div>`;
    return document.querySelector('.knowledge-overlay-panel') as HTMLElement;
  };
  const footer = () => [...document.querySelectorAll('.knowledge-overlay-foot button')].map((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim());

  it('is a labelled modal dialog: the title names it, the exit button is in the header, and the body holds the whole diff and can take focus', () => {
    const panel = overlayOf();
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    const title = panel.querySelector('#knowledge-overlay-title')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(title.id);
    expect(title.textContent).toBe('Edit orders.md in shop-data');
    const exit = panel.querySelector('.knowledge-overlay-head [data-knowledge-action="overlay-close"]')!;
    expect(exit.getAttribute('aria-label')).toContain('Close');
    const body = panel.querySelector('.knowledge-overlay-body') as HTMLElement;
    expect(body.getAttribute('tabindex')).toBe('0');
    expect(body.querySelectorAll('.knowledge-diff-line')).toHaveLength(304);
    expect(body.querySelectorAll('.knowledge-diff-line.meta')).toHaveLength(3);
    expect(body.querySelectorAll('.knowledge-diff-line.add')).toHaveLength(300);
    expect(body.querySelectorAll('.knowledge-diff-line.del')).toHaveLength(1);
    expect(body.textContent).toContain('1 file · 300 lines added, 1 removed');
  });

  it('keeps the card buttons in the footer: Apply once the reader has the whole text, Apply anyway with open items, Undo when applied', () => {
    overlayOf({ sources: ['email'], needsConfirm: true });
    expect(footer()).toEqual(['Apply', 'Dismiss', 'Close Esc']);
    expect(document.querySelector('.knowledge-overlay-body [data-knowledge-action="apply"]')).toBeNull();
    expect(document.querySelector('.knowledge-overlay-foot [data-knowledge-action="apply"]')!.getAttribute('data-change-id')).toBe(ID);
    overlayOf({ unresolved: [BREACH], needsAnyway: true, sources: ['email'] });
    expect(footer()).toEqual(['Apply anyway', 'Ask BotBoy to fix', 'Dismiss', 'Close Esc']);
    overlayOf({ status: 'applied', historyId: 'h_000000000001' });
    expect(footer()).toEqual(['Undo', 'Close Esc']);
    overlayOf({ status: 'dismissed' });
    expect(footer()).toEqual(['Close Esc']);
  });

  it('names the source and the open items, shows a refusal as a note in the footer, and escapes hostile text', () => {
    overlayOf({ sources: ['<s>x</s>'], unresolved: [{ ...BREACH, problem: '<script>p</script>' }], needsAnyway: true, set: '<img src=x onerror=alert(1)>', diff: '+<script>alert(2)</script>' }, { notice: 'The guide changed. Use Re-draft.' });
    for (const tag of ['script', 'img', 's']) expect(document.querySelector(tag)).toBeNull();
    expect(text()).toContain('Derived from <s>x</s>');
    expect(text()).toContain('<script>p</script>');
    expect(text()).toContain('<script>alert(2)</script>');
    expect(document.querySelector('.knowledge-overlay-foot .knowledge-card-note')!.textContent).toContain('The guide changed. Use Re-draft.');
  });

  it('shows a History file whole, with who and when, and only Close; a file with no diff says why', () => {
    const file = { path: 'shop-data/orders.md', kind: 'changed', diff: { text: LONG_DIFF, totalLines: 304, shownLines: 304, truncated: false } };
    document.body.innerHTML = `<div class="knowledge-overlay">${renderer.renderHistoryOverlay(entry(), file, helpers)}</div>`;
    expect(document.querySelector('#knowledge-overlay-title')!.textContent).toBe('shop-data/orders.md');
    expect(text()).toContain('You, through BotBoy');
    expect(document.querySelectorAll('.knowledge-overlay-body .knowledge-diff-line')).toHaveLength(304);
    expect(footer()).toEqual(['Close Esc']);
    document.body.innerHTML = `<div class="knowledge-overlay">${renderer.renderHistoryOverlay(entry(), { path: 'secrets.md', kind: 'created', diff: null, note: 'Content not shown or copied.' }, helpers)}</div>`;
    expect(text()).toContain('Content not shown or copied.');
    expect(document.querySelector('.knowledge-diff')).toBeNull();
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
type OverlayEvent = { kind: 'open' | 'update' | 'close'; html?: string };
function harness(respond: (path: string, init: Call['options']) => unknown, options: { realOverlay?: boolean } = {}) {
  const calls: Call[] = [];
  const renders: Array<Record<string, unknown>> = [];
  const submitted: string[] = [];
  const opened: boolean[] = [];
  const overlay: OverlayEvent[] = [];
  /** Every request path and every event the page announced, in the order they happened. */
  const order: string[] = [];
  let focusBack: (() => Element | null) | null = null;
  let onClose: (() => void) | null = null;
  let isOpen = false;
  // A stand-in for knowledge-overlay.js that records what the page asks of it (the real controller has its own suite).
  const stub = {
    open: (html: string, opts?: { focusBack?: () => Element | null; onClose?: () => void }) => { isOpen = true; focusBack = opts?.focusBack ?? null; onClose = opts?.onClose ?? null; overlay.push({ kind: 'open', html }); },
    update: (html: string) => { overlay.push({ kind: 'update', html }); },
    close: () => { if (!isOpen) return; isOpen = false; overlay.push({ kind: 'close' }); onClose?.(); },
    isOpen: () => isOpen,
  };
  const state: any = { route: { view: 'knowledge-settings' }, knowledge: { ...freshState(), status: READY } };
  const request = async (requestPath: string, init?: Call['options']) => {
    calls.push({ path: requestPath, options: init });
    order.push(requestPath);
    const result = respond(requestPath, init);
    if (result instanceof Error) throw result;
    return result;
  };
  const names = ['knowledgeErrorText', 'knowledgeNotice', 'announceKnowledgeChanged', 'runKnowledgeAction', 'loadKnowledgeWritePath', 'knowledgeOverlayHtml', 'openKnowledgeOverlay', 'refreshKnowledgeOverlay', 'knowledgePageAction'];
  const source = names.map(topLevel).join('\n') + '\nreturn { loadKnowledgeWritePath, knowledgePageAction };';
  const submit = async () => { submitted.push((document.getElementById('chatInput') as HTMLTextAreaElement).value); };
  (window as unknown as { submitChat: () => Promise<void> }).submitChat = submit;
  const fakeWindow = options.realOverlay ? window : { BotBoyKnowledge: renderer, BotBoyKnowledgeOverlay: stub, submitChat: submit, dispatchEvent: (event: Event) => { order.push(event.type); return true; } };
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'request', 'renderRoute', 'window', 'document', 'toggleAssistant', 'esc', 'attr', 'icon', source)(
    state, request, (arg: Record<string, unknown>) => renders.push(arg), fakeWindow, document, (open: boolean) => opened.push(open), helpers.esc, helpers.attr, helpers.icon,
  );
  return { api, calls, renders, state, submitted, opened, overlay, order, focusBack: () => (focusBack ? focusBack() : null) };
}
const failure = (payload: Record<string, unknown>) => Object.assign(new Error(String(payload.error)), { payload });
/** One button on the page (`.knowledge-settings`) or inside the overlay (`.knowledge-overlay`), as the delegated listener would hand it over. */
const clickable = (action: string, extra: Record<string, string> = {}, where: 'page' | 'overlay' = 'page') => {
  const button = `<button data-knowledge-action="${action}" ${Object.entries(extra).map(([key, value]) => `data-${key}="${value}"`).join(' ')}>x</button>`;
  document.body.innerHTML = (where === 'page' ? `<div class="knowledge-settings"><article data-knowledge-change-id="${ID}">${button}</article></div>` : `<div class="knowledge-overlay">${button}</div>`) + '<textarea id="chatInput"></textarea>';
  return document.querySelector('button') as HTMLElement;
};
const listsOf = (changes: unknown[]) => (p: string) => (p === '/knowledge/changes' ? { counts: {}, changes } : p === '/knowledge/history' ? { entries: [], latestUndoableId: null } : { ok: true });

afterEach(() => { (window as unknown as { BotBoyKnowledgeOverlay: { close: () => void } }).BotBoyKnowledgeOverlay.close(); });

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

  it('Apply on a change that is not derived sends two booleans and no text; a refusal becomes a note on the card; the list is read again afterwards', async () => {
    const h = harness((p) => (p.endsWith('/apply') ? { ok: true } : listsOf([])(p)));
    h.state.knowledge.changes = { counts: {}, changes: [change()] };
    await h.api.knowledgePageAction(clickable('apply', { 'change-id': ID }));
    const post = h.calls.find((call) => call.options?.method === 'POST')!;
    expect(post.path).toBe(`/knowledge/changes/${ID}/apply`);
    expect(post.options?.body).toEqual({ anyway: false, confirmFlagged: false });
    expect(h.calls.map((call) => call.path)).toContain('/knowledge/changes');
    expect(h.overlay).toEqual([]);
    const refused = harness((p) => (p.endsWith('/apply') ? failure({ error: 'The guide check still has open items.', nextAction: 'Press Apply anyway.' }) : { counts: {}, changes: [] }));
    refused.state.knowledge.changes = { counts: {}, changes: [change()] };
    await refused.api.knowledgePageAction(clickable('apply', { 'change-id': ID }));
    expect(refused.state.knowledge.cardNotices[ID]).toBe('The guide check still has open items. Press Apply anyway.');
  });

  it.each([
    ['derived from an email', { sources: ['email'], needsConfirm: true }],
    ['flagged as instructions to an assistant', { suspicious: true, needsConfirm: true }],
  ])('a change %s cannot be applied from its card: the button opens the whole change, and Apply in the overlay posts', async (_name, over) => {
    const flagged = change(over);
    const h = harness(listsOf([]));
    h.state.knowledge.changes = { counts: {}, changes: [flagged] };
    await h.api.knowledgePageAction(clickable('apply', { 'change-id': ID }));
    expect(h.calls).toEqual([]); // nothing was asked of the server
    expect(h.overlay.map((event) => event.kind)).toEqual(['open']);
    expect(h.overlay[0].html).toContain('knowledge-overlay-panel');
    expect(h.state.knowledge.overlay).toEqual({ changeId: ID });
    await h.api.knowledgePageAction(clickable('apply', { 'change-id': ID }, 'overlay'));
    const post = h.calls.find((call) => call.options?.method === 'POST')!;
    expect(post.path).toBe(`/knowledge/changes/${ID}/apply`);
    expect(post.options?.body).toEqual({ anyway: false, confirmFlagged: true });
    expect(JSON.stringify(h.calls.map((call) => call.options?.body))).not.toMatch(/content|edits|diff/);
    // The list was read again, the change is gone, so the overlay closed and the page forgot it.
    expect(h.overlay.map((event) => event.kind)).toEqual(['open', 'close']);
    expect(h.state.knowledge.overlay).toBeNull();
  });

  it('Apply anyway on a derived change also opens the overlay first, and applies with anyway from inside it', async () => {
    const derived = change({ sources: ['email'], needsConfirm: true, unresolved: [BREACH], needsAnyway: true });
    const h = harness(listsOf([]));
    h.state.knowledge.changes = { counts: {}, changes: [derived] };
    await h.api.knowledgePageAction(clickable('apply-anyway', { 'change-id': ID }));
    expect(h.calls).toEqual([]);
    expect(h.overlay.map((event) => event.kind)).toEqual(['open']);
    await h.api.knowledgePageAction(clickable('apply-anyway', { 'change-id': ID }, 'overlay'));
    expect(h.calls.find((call) => call.options?.method === 'POST')!.options?.body).toEqual({ anyway: true, confirmFlagged: true });
  });

  it('a refusal inside the overlay keeps it open and shows the reason in its footer', async () => {
    const derived = change({ sources: ['email'], needsConfirm: true });
    const h = harness((p) => (p.endsWith('/apply') ? failure({ error: 'The guide check still has open items.', nextAction: 'Press Apply anyway.' }) : listsOf([derived])(p)));
    h.state.knowledge.changes = { counts: {}, changes: [derived] };
    await h.api.knowledgePageAction(clickable('diff-expand', { 'change-id': ID }));
    await h.api.knowledgePageAction(clickable('apply', { 'change-id': ID }, 'overlay'));
    expect(h.overlay.map((event) => event.kind)).toEqual(['open', 'update']);
    expect(h.overlay[1].html).toContain('The guide check still has open items. Press Apply anyway.');
    expect(h.state.knowledge.overlay).toEqual({ changeId: ID });
  });

  it('Expand opens the overlay with the whole change; the exit buttons close it; focus goes back to Expand, even after the page was repainted', async () => {
    const h = harness(() => ({}));
    h.state.knowledge.changes = { counts: {}, changes: [change({ diff: LONG_DIFF })] };
    const expand = clickable('diff-expand', { 'change-id': ID });
    await h.api.knowledgePageAction(expand);
    expect(h.overlay[0].html).toContain('Edit orders.md in shop-data');
    expect((h.overlay[0].html ?? '').match(/knowledge-diff-line/g)).toHaveLength(304);
    expect(h.focusBack()).toBe(expand); // the button that opened it is still on the page
    document.body.innerHTML = renderer.renderPage(model({ changes: { counts: { waiting: 1 }, changes: [change({ diff: LONG_DIFF })] } }), helpers);
    expect(h.focusBack()).toBe(document.querySelector('button[data-knowledge-action="diff-expand"]')); // repainted: the matching button
    await h.api.knowledgePageAction(clickable('overlay-close', {}, 'overlay'));
    expect(h.overlay.map((event) => event.kind)).toEqual(['open', 'close']);
    expect(h.state.knowledge.overlay).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('Expand on a History file opens that file, whole, with only Close', async () => {
    const h = harness(() => ({}));
    const detail = { files: [{ path: 'shop-data/orders.md', kind: 'changed', diff: { text: LONG_DIFF, totalLines: 304, shownLines: 304, truncated: false } }] };
    Object.assign(h.state.knowledge, { history: { entries: [entry()], latestUndoableId: null }, historyDetail: { h_000000000001: detail }, historyOpen: 'h_000000000001' });
    await h.api.knowledgePageAction(clickable('diff-expand', { 'entry-id': 'h_000000000001', 'file-index': '0' }));
    expect(h.state.knowledge.overlay).toEqual({ entryId: 'h_000000000001', fileIndex: 0 });
    expect(h.overlay[0].html).toContain('shop-data/orders.md');
    expect(h.overlay[0].html).not.toContain('data-knowledge-action="apply"');
    h.calls.length = 0;
    await h.api.knowledgePageAction(clickable('diff-expand', { 'entry-id': 'h_missing', 'file-index': '0' }));
    expect(h.overlay).toHaveLength(1); // nothing to show: nothing opens
  });

  it('a reload of the lists closes the overlay when its change is gone, and leaves it alone (no redraw) while it is still there', async () => {
    let current: unknown[] = [change()];
    const h = harness((p) => listsOf(current)(p));
    h.state.knowledge.changes = { counts: {}, changes: current };
    await h.api.knowledgePageAction(clickable('diff-expand', { 'change-id': ID }));
    await h.api.loadKnowledgeWritePath();
    expect(h.overlay.map((event) => event.kind)).toEqual(['open']);
    current = [];
    await h.api.loadKnowledgeWritePath();
    expect(h.overlay.map((event) => event.kind)).toEqual(['open', 'close']);
    expect(h.state.knowledge.overlay).toBeNull();
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

  it('tells the chat panel once the lists are read again after an owner action, so a chat card never keeps the button of a decided change', async () => {
    const h = harness((p) => (p.endsWith('/apply') ? { ok: true } : listsOf([])(p)));
    h.state.knowledge.changes = { counts: {}, changes: [change()] };
    await h.api.knowledgePageAction(clickable('apply', { 'change-id': ID }));
    expect(h.order).toEqual([`/knowledge/changes/${ID}/apply`, '/knowledge/changes', '/knowledge/history', 'botboy:knowledge-changed']);
    // A refusal can leave the change in a state the chat card does not show yet, so it announces too.
    const refused = harness((p) => (p.endsWith('/dismiss') ? failure({ error: 'That change is closed.', nextAction: 'Nothing to do.' }) : listsOf([])(p)));
    await refused.api.knowledgePageAction(clickable('dismiss', { 'change-id': ID }));
    expect(refused.order.at(-1)).toBe('botboy:knowledge-changed');
    // Looking at a change moves nothing, so it announces nothing.
    const quiet = harness(() => ({}));
    quiet.state.knowledge.changes = { counts: {}, changes: [change({ diff: LONG_DIFF })] };
    await quiet.api.knowledgePageAction(clickable('diff-expand', { 'change-id': ID }));
    expect(quiet.order).toEqual([]);
  });

  it('opens a History entry once (the detail is fetched, then kept) and closes it again', async () => {
    const h = harness((p) => (p.startsWith('/knowledge/history/') ? { entry: entry(), files: [], undoable: true } : {}));
    await h.api.knowledgePageAction(clickable('history-open', { 'entry-id': 'h_000000000001' }));
    expect(h.state.knowledge.historyOpen).toBe('h_000000000001');
    expect(h.calls.map((call) => call.path)).toEqual(['/knowledge/history/h_000000000001']);
    await h.api.knowledgePageAction(clickable('history-open', { 'entry-id': 'h_000000000001' }));
    expect(h.state.knowledge.historyOpen).toBe('');
    await h.api.knowledgePageAction(clickable('history-open', { 'entry-id': 'h_000000000001' }));
    expect(h.calls).toHaveLength(1);
  });

  it('Ask BotBoy to fix opens the chat and sends an ordinary message with the card marker; no route is called', async () => {
    const h = harness(() => ({}));
    await h.api.knowledgePageAction(clickable('ask-fix', { 'change-id': ID }));
    expect(h.opened).toEqual([true]);
    expect(h.submitted).toEqual([`Please fix this change so it follows the guide. [[knowledge:${ID}]]`]);
    expect(h.calls).toEqual([]);
  });

  it('Ask BotBoy to fix, pressed in the overlay, closes it first so the chat behind it is seen', async () => {
    const h = harness(() => ({}));
    h.state.knowledge.changes = { counts: {}, changes: [change({ unresolved: [BREACH], needsAnyway: true })] };
    await h.api.knowledgePageAction(clickable('diff-expand', { 'change-id': ID }));
    await h.api.knowledgePageAction(clickable('ask-fix', { 'change-id': ID }, 'overlay'));
    expect(h.overlay.map((event) => event.kind)).toEqual(['open', 'close']);
    expect(h.opened).toEqual([true]);
    expect(h.submitted).toHaveLength(1);
  });
});

describe('with the real overlay controller', () => {
  const longChange = () => change({ diff: LONG_DIFF, sources: ['email'], needsConfirm: true });
  const pageWithCard = () => {
    document.body.innerHTML = renderer.renderPage(model({ changes: { counts: { waiting: 1 }, changes: [longChange()] } }), helpers) + '<textarea id="chatInput"></textarea>';
    return document.querySelector('button[data-knowledge-action="diff-expand"]') as HTMLElement;
  };

  it('Expand opens a modal dialog with the whole change; Escape closes it, puts the focus back on Expand, and the chat panel behind never hears the key', async () => {
    const h = harness(listsOf([longChange()]), { realOverlay: true });
    h.state.knowledge.changes = { counts: {}, changes: [longChange()] };
    const expand = pageWithCard();
    expand.focus();
    await h.api.knowledgePageAction(expand);
    const dialog = document.querySelector('.knowledge-overlay [role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelectorAll('.knowledge-overlay .knowledge-diff-line')).toHaveLength(304);
    expect(document.activeElement).toBe(document.querySelector('.knowledge-overlay-body'));
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', heard);
    expect(document.querySelector('.knowledge-overlay')).toBeNull();
    expect(heard).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(expand);
    expect(h.state.knowledge.overlay).toBeNull();
  });

  it('the exit button in the header and the Close in the footer each close it, and a card that waits is still on the page behind', async () => {
    const h = harness(listsOf([longChange()]), { realOverlay: true });
    h.state.knowledge.changes = { counts: {}, changes: [longChange()] };
    const expand = pageWithCard();
    for (const selector of ['.knowledge-overlay-head [data-knowledge-action="overlay-close"]', '.knowledge-overlay-foot [data-knowledge-action="overlay-close"]']) {
      await h.api.knowledgePageAction(expand);
      expect(document.querySelector('.knowledge-overlay')).not.toBeNull();
      await h.api.knowledgePageAction(document.querySelector(selector) as HTMLElement);
      expect(document.querySelector('.knowledge-overlay')).toBeNull();
      expect(document.querySelector('.knowledge-pending .knowledge-page-card')).not.toBeNull();
    }
    expect(h.calls).toEqual([]);
  });

  it('Apply inside the real overlay posts, and the overlay is gone once the change is', async () => {
    const h = harness((p) => (p.endsWith('/apply') ? { ok: true } : listsOf([])(p)), { realOverlay: true });
    h.state.knowledge.changes = { counts: {}, changes: [longChange()] };
    const expand = pageWithCard();
    await h.api.knowledgePageAction(expand);
    await h.api.knowledgePageAction(document.querySelector('.knowledge-overlay-foot [data-knowledge-action="apply"]') as HTMLElement);
    expect(h.calls.find((call) => call.options?.method === 'POST')!.options?.body).toEqual({ anyway: false, confirmFlagged: true });
    expect(document.querySelector('.knowledge-overlay')).toBeNull();
  });
});

describe('the wiring', () => {
  it('one page listener, scoped to the page, so a chat card is never handled twice', () => {
    expect(dashboard).toContain("const button = event.target.closest('.knowledge-settings [data-knowledge-action], .knowledge-overlay [data-knowledge-action]');");
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
