// @vitest-environment jsdom
//
// Settings → Appearance (dashboard.js, docs/maps/ui-themes.md): the wiring into the Settings shell, the page, and every owner click
// on it. The functions are evaluated straight from the shipped source against a stub request(); the rows are the real ui-theme.js.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEME_TOKENS, deriveTheme, themeSwatch } from '../core/ui-theme-engine.js';

const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const themeScript = readFileSync(path.join(process.cwd(), 'src/ui/ui-theme.js'), 'utf8');
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

describe('wiring into the Settings shell', () => {
  it('routes #/settings/appearance to its own view and keeps Settings highlighted in the sidebar', () => {
    expect(dashboard).toContain("if (parts[0] === 'settings' && parts[1] === 'appearance') return { view: 'appearance-settings' };");
    expect(dashboard).toContain("|| (view === 'settings' && route.view === 'appearance-settings')");
  });

  it('loads on entering the route, renders, restores focus, and is linked from both Settings navs', () => {
    expect(dashboard).toContain("if (routeChanged && state.route.view === 'appearance-settings') void loadUiTheme({ render: true });");
    expect(dashboard).toContain("if (state.route.view === 'appearance-settings') html = renderAppearanceSettings();");
    expect(dashboard).toContain("if (state.route.view === 'appearance-settings') restoreAppearanceFocus();");
    const link = '<a class="button ghost" href="#/settings/appearance">${icon(\'sun\')} Appearance</a>';
    expect(topLevel('renderSettings')).toContain(link);
    expect(topLevel('renderWorkplaceSettings')).toContain(link);
    expect(topLevel('renderAppearanceSettings')).not.toContain('settings-nav');
  });

  it('every change is a button or a form on the page, and the form is the only submit', () => {
    for (const action of ['theme-apply', 'theme-rename', 'theme-rename-cancel', 'theme-delete', 'theme-delete-cancel', 'theme-delete-confirm', 'theme-reset']) {
      expect(dashboard, action).toContain(`if (action === '${action}')`);
    }
    expect(dashboard).toContain("event.target?.matches?.('[data-theme-rename-form]')");
  });

  it('the top-bar button also tells the server, so the next load and the other tabs follow', () => {
    const toggle = topLevel('toggleTheme');
    expect(toggle).toContain("request('/ui-theme/active', { method: 'PUT', body: { id: `builtin:${next}` } })");
    expect(toggle).toContain('window.BotBoyTheme.setBuiltin(next)');
    expect(toggle).toContain('.catch(() => {})');
  });

  it('the page opens on the server\'s choice and only falls back to the browser\'s own light or dark when the server has not spoken', () => {
    expect(dashboard).toContain("!document.documentElement.hasAttribute('data-botboy-choice') && (theme === 'light' || theme === 'dark')");
    expect(dashboard).toContain('void loadUiTheme();');
    expect(dashboard).toContain('window.BotBoyTheme?.syncControls();');
  });

  it('the version poll refetches when themeVersion moves, never in the middle of a request or a rename, and announces it to the cards', () => {
    expect(dashboard).toContain("const themeVersion = payload.themeVersion ?? null;");
    expect(dashboard).toContain('themeVersion !== null && state.lastThemeVersion !== null && themeVersion !== state.lastThemeVersion && !state.uiTheme.busy');
    expect(dashboard).toContain("!String(document.activeElement?.id || '').startsWith('theme-')");
    expect(dashboard).toContain("window.dispatchEvent(new CustomEvent('botboy:themes-changed'));");
  });
});

type Row = { id: string; name: string; mode: 'dark' | 'light'; swatch: string[]; builtin: boolean; active: boolean; createdAt: string | null };
const ID = 'th_0123456789ab';
const derived = (() => { const result = deriveTheme({ mode: 'dark', accent: '#2dd4bf' }); if (!result.ok) throw new Error(result.message); return result; })();
const saved = (over: Partial<Row> = {}): Row => ({ id: ID, name: 'Evergreen', mode: 'dark', swatch: themeSwatch(derived.tokens), builtin: false, active: false, createdAt: '2026-10-16T10:00:00.000Z', ...over });
const builtins = (activeId = 'builtin:dark'): Row[] => (['dark', 'light'] as const).map((mode) => ({
  id: `builtin:${mode}`, name: mode === 'dark' ? 'BotBoy Dark' : 'BotBoy Light', mode, swatch: themeSwatch(BUILTIN_THEME_TOKENS[mode]), builtin: true, active: activeId === `builtin:${mode}`, createdAt: null,
}));
const makeView = (over: Record<string, unknown> = {}) => ({
  version: 5, active: 'builtin:dark', activeTheme: { id: 'builtin:dark', name: 'BotBoy Dark', mode: 'dark', builtin: true }, activeTokens: null,
  builtins: builtins(), themes: [saved()], limits: { maxThemes: 12 }, ...over,
});

type Harness = {
  state: any; request: ReturnType<typeof vi.fn>; renderRoute: ReturnType<typeof vi.fn>;
  render(): string; load(options?: { render?: boolean }): Promise<void>; apply(id: string): Promise<unknown>; rename(form: HTMLFormElement): Promise<unknown>;
  remove(id: string): Promise<unknown>; reset(): Promise<unknown>; startRename(id: string): void; askDelete(id: string): void; cancel(id?: string): void;
  restoreFocus(): void; take(view: unknown): void;
};
function harness(initial: Record<string, unknown> = {}): Harness {
  const state: any = {
    route: { view: 'appearance-settings' }, lastThemeVersion: null,
    uiTheme: { data: null, error: '', notice: '', busy: false, renaming: '', confirmingDelete: '', pendingFocus: '', ...initial },
  };
  const request = vi.fn(async (_path: string, _options?: unknown): Promise<any> => makeView());
  const renderRoute = vi.fn();
  const source = [
    constLine('icon'), constLine('esc'), constLine('attr'), topLevel('pageHead'),
    topLevel('themeErrorText'), topLevel('loadUiTheme'), topLevel('takeUiThemeView'), topLevel('renderAppearanceSettings'), topLevel('restoreAppearanceFocus'),
    topLevel('themeRowName'), topLevel('changeUiTheme'), topLevel('applyUiTheme'), topLevel('startThemeRename'), topLevel('cancelThemeEdit'), topLevel('saveThemeRename'),
    topLevel('askThemeDelete'), topLevel('deleteUiTheme'), topLevel('resetUiTheme'),
    'return { render: renderAppearanceSettings, load: loadUiTheme, apply: applyUiTheme, rename: saveThemeRename, remove: deleteUiTheme, reset: resetUiTheme, startRename: startThemeRename, askDelete: askThemeDelete, cancel: cancelThemeEdit, restoreFocus: restoreAppearanceFocus, take: takeUiThemeView };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'request', 'renderRoute', source)(state, request, renderRoute);
  return { state, request, renderRoute, ...api };
}
const root = document.documentElement;
const html = (markup: string) => { const div = document.createElement('div'); div.innerHTML = markup; return div; };

beforeEach(() => {
  root.removeAttribute('style');
  root.setAttribute('data-theme', 'dark');
  root.removeAttribute('data-botboy-choice');
  document.head.innerHTML = '<meta name="theme-color" content="#09090b">';
  document.body.innerHTML = '';
  localStorage.clear();
  // eslint-disable-next-line no-new-func
  new Function(themeScript)();
});

describe('the page', () => {
  it('lists the shipped themes and the saved ones, marks the one in use, and links back to Settings', () => {
    const h = harness({ data: makeView({ active: ID, activeTheme: { id: ID, name: 'Evergreen', mode: 'dark', builtin: false }, activeTokens: derived.tokens, builtins: builtins(ID), themes: [saved({ active: true })] }) });
    const page = html(h.render());
    expect(page.querySelector('h1')!.textContent).toBe('Appearance');
    expect(page.querySelector('.breadcrumb a[href="#/settings"]')).not.toBeNull();
    const rows = [...page.querySelectorAll('.theme-row')];
    expect(rows.map((row) => row.querySelector('strong')!.textContent)).toEqual(['BotBoy Dark', 'BotBoy Light', 'Evergreen']);
    expect(rows.map((row) => row.classList.contains('active'))).toEqual([false, false, true]);
    expect(rows[2].textContent).toContain('In use');
    expect(page.querySelector('[data-action="theme-reset"]')).not.toBeNull();
    expect(page.querySelector('.theme-empty')).toBeNull();
  });

  it('with no saved themes it says how to get one; with the default in use there is nothing to reset', () => {
    const h = harness({ data: makeView({ themes: [] }) });
    const page = html(h.render());
    expect(page.querySelector('.theme-empty')!.textContent).toContain('make me a calm green dark theme');
    expect(page.querySelector('[data-action="theme-reset"]')).toBeNull();
    expect(page.querySelectorAll('.theme-row')).toHaveLength(2);
  });

  it('says so when the server has not been asked yet (no reset offered) and when it cannot be reached', () => {
    const unasked = html(harness({ data: makeView({ active: null }) }).render());
    expect(unasked.querySelector('[data-action="theme-reset"]')).toBeNull();
    const failed = html(harness({ data: null, error: 'This BotBoy server does not have themes yet. Update BotBoy, then reload this tab.' }).render());
    expect(failed.querySelector('[role="alert"]')!.textContent).toContain('does not have themes yet');
    expect(html(harness({ data: null }).render()).textContent).toContain('Loading themes…');
  });

  it('says when the saved themes are at the limit', () => {
    const themes = Array.from({ length: 12 }, (_, index) => saved({ id: `th_${index.toString(16).padStart(12, '0')}`, name: `Theme ${index}` }));
    expect(html(harness({ data: makeView({ themes }) }).render()).textContent).toContain('the most BotBoy keeps');
  });

  it('renders a rename form and a delete confirmation in place of the row\'s buttons, and escapes every name', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const data = makeView({ themes: [saved({ name: evil })] });
    const renaming = html(harness({ data, renaming: ID }).render());
    expect(renaming.querySelector('form[data-theme-rename-form]')).not.toBeNull();
    expect(renaming.querySelector('img')).toBeNull();
    const confirming = html(harness({ data, confirmingDelete: ID }).render());
    expect(confirming.querySelector('[data-action="theme-delete-confirm"]')).not.toBeNull();
    expect(confirming.querySelector('img')).toBeNull();
    expect(html(harness({ data }).render()).querySelector('img')).toBeNull();
  });

  it('shows the notice politely and an error loudly', () => {
    const page = html(harness({ data: makeView(), notice: 'Applied Evergreen.', error: 'The server said no.' }).render());
    expect(page.querySelector('[role="status"]')!.textContent).toBe('Applied Evergreen.');
    expect(page.querySelector('[role="alert"]')!.textContent).toBe('The server said no.');
  });
});

describe('loading', () => {
  it('takes what the server holds, applies it to the page, and remembers its revision', async () => {
    const h = harness();
    h.request.mockResolvedValue(makeView({ version: 9, active: ID, activeTheme: { id: ID, name: 'Evergreen', mode: 'dark', builtin: false }, activeTokens: derived.tokens }));
    await h.load();
    expect(h.request).toHaveBeenCalledWith('/ui-theme');
    expect(h.state.uiTheme.data.version).toBe(9);
    expect(h.state.lastThemeVersion).toBe(9);
    expect(root.getAttribute('data-botboy-choice')).toBe(ID);
    expect(h.renderRoute).not.toHaveBeenCalled();
  });

  it('repaints the open page only when asked to', async () => {
    const h = harness();
    await h.load({ render: true });
    expect(h.renderRoute).toHaveBeenCalledWith({ preserveScroll: true });
    const away = harness();
    away.state.route = { view: 'today' };
    await away.load({ render: true });
    expect(away.renderRoute).not.toHaveBeenCalled();
  });

  it('a server that has not been asked yet changes nothing about the page', async () => {
    const h = harness();
    localStorage.setItem('botboy-theme', 'light');
    root.setAttribute('data-theme', 'light');
    h.request.mockResolvedValue(makeView({ active: null }));
    await h.load();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.hasAttribute('data-botboy-choice')).toBe(false);
  });

  it('an older server (404) or a failure leaves the page as it is and says why', async () => {
    const h = harness();
    h.request.mockRejectedValue(Object.assign(new Error('HTTP 404'), { status: 404 }));
    await h.load();
    expect(h.state.uiTheme.data).toBeNull();
    expect(h.state.uiTheme.error).toContain('does not have themes yet');
    h.request.mockRejectedValue(Object.assign(new Error('HTTP 500'), { status: 500 }));
    await h.load();
    expect(h.state.uiTheme.error).toContain('HTTP 500');
  });

  it('a view that arrives from a chat card or another tab replaces the page\'s copy', () => {
    const h = harness({ data: makeView({ version: 5 }) });
    h.take(makeView({ version: 8, themes: [] }));
    expect(h.state.uiTheme.data.version).toBe(8);
    expect(h.state.lastThemeVersion).toBe(8);
    expect(h.renderRoute).toHaveBeenCalledWith({ preserveScroll: true });
    h.take({ nope: true });
    expect(h.state.uiTheme.data.version).toBe(8);
  });
});

describe('the owner\'s clicks', () => {
  it('Apply sends the id only, shows the theme now, says so, and announces it to the chat cards', async () => {
    const h = harness({ data: makeView() });
    const announced = vi.fn();
    window.addEventListener('botboy:themes-changed', announced);
    h.request.mockResolvedValue(makeView({ version: 6, active: ID, activeTheme: { id: ID, name: 'Evergreen', mode: 'dark', builtin: false }, activeTokens: derived.tokens, builtins: builtins(ID), themes: [saved({ active: true })] }));
    await h.apply(ID);
    expect(h.request).toHaveBeenCalledWith('/ui-theme/active', { method: 'PUT', body: { id: ID } });
    expect(root.getAttribute('data-botboy-choice')).toBe(ID);
    expect(root.style.getPropertyValue('--accent')).toBe(derived.tokens.accent);
    expect(h.state.uiTheme).toMatchObject({ busy: false, notice: 'Applied Evergreen.', error: '' });
    expect(h.state.lastThemeVersion).toBe(6);
    expect(announced).toHaveBeenCalledOnce();
    expect(h.renderRoute).toHaveBeenCalledWith({ preserveScroll: true, userAction: true });
  });

  it('a second click while one is in flight does nothing', async () => {
    const h = harness({ data: makeView() });
    let release: (value: unknown) => void = () => {};
    h.request.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = h.apply(ID);
    expect(await h.apply(ID)).toBeNull();
    expect(h.request).toHaveBeenCalledOnce();
    release(makeView());
    await first;
    expect(h.state.uiTheme.busy).toBe(false);
  });

  it('a refusal keeps the page as it was and shows the server\'s reason and next step', async () => {
    const h = harness({ data: makeView() });
    h.request.mockRejectedValue(Object.assign(new Error('HTTP 404 — There is no such theme.'), { status: 404, payload: { error: 'There is no such theme.' }, nextAction: 'Pick a theme from Settings → Appearance.' }));
    expect(await h.apply('th_ffffffffffff')).toBeNull();
    expect(h.state.uiTheme.error).toBe('There is no such theme. Pick a theme from Settings → Appearance.');
    expect(h.state.uiTheme.busy).toBe(false);
    expect(h.state.uiTheme.data.version).toBe(5);
    expect(root.hasAttribute('data-botboy-choice')).toBe(false);
  });

  it('Rename opens the form, saves the typed name, and closes it', async () => {
    const h = harness({ data: makeView() });
    h.startRename(ID);
    expect(h.state.uiTheme).toMatchObject({ renaming: ID, confirmingDelete: '', pendingFocus: 'rename' });
    const form = html(h.render()).querySelector('form') as HTMLFormElement;
    (form.querySelector('input') as HTMLInputElement).value = '  Pine  ';
    h.request.mockResolvedValue({ theme: { id: ID, name: 'Pine' }, view: makeView({ version: 6, themes: [saved({ name: 'Pine' })] }) });
    await h.rename(form);
    expect(h.request).toHaveBeenCalledWith(`/ui-theme/themes/${ID}`, { method: 'PATCH', body: { name: 'Pine' } });
    expect(h.state.uiTheme).toMatchObject({ renaming: '', notice: 'Renamed.', error: '' });
    expect(h.state.uiTheme.data.themes[0].name).toBe('Pine');
  });

  it('an empty name asks for one and sends nothing', async () => {
    const h = harness({ data: makeView() });
    h.startRename(ID);
    const form = html(h.render()).querySelector('form') as HTMLFormElement;
    (form.querySelector('input') as HTMLInputElement).value = '   ';
    await h.rename(form);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.state.uiTheme.error).toBe('Type a name for the theme.');
    expect(h.state.uiTheme.renaming).toBe(ID);
  });

  it('Delete asks first, Cancel backs out, and Delete theme removes it', async () => {
    const h = harness({ data: makeView() });
    h.askDelete(ID);
    expect(h.state.uiTheme).toMatchObject({ confirmingDelete: ID, renaming: '' });
    h.cancel(ID);
    expect(h.state.uiTheme).toMatchObject({ confirmingDelete: '', renaming: '', pendingFocus: ID });
    expect(h.request).not.toHaveBeenCalled();
    h.request.mockResolvedValue(makeView({ version: 7, themes: [] }));
    await h.remove(ID);
    expect(h.request).toHaveBeenCalledWith(`/ui-theme/themes/${ID}`, { method: 'DELETE' });
    expect(h.state.uiTheme).toMatchObject({ notice: 'Deleted Evergreen.', confirmingDelete: '' });
    expect(h.state.uiTheme.data.themes).toEqual([]);
  });

  it('deleting the theme in use puts the page on the shipped theme the server fell back to', async () => {
    const h = harness({ data: makeView({ active: ID, themes: [saved({ active: true })] }) });
    root.setAttribute('data-botboy-choice', ID);
    h.request.mockResolvedValue(makeView({ version: 8, active: 'builtin:dark', themes: [] }));
    await h.remove(ID);
    expect(root.getAttribute('data-botboy-choice')).toBe('builtin:dark');
    expect(root.getAttribute('style')).toBeNull();
  });

  it('Use BotBoy Dark resets the choice and keeps the saved themes', async () => {
    const h = harness({ data: makeView({ active: ID }) });
    h.request.mockResolvedValue(makeView({ version: 9 }));
    await h.reset();
    expect(h.request).toHaveBeenCalledWith('/ui-theme/reset', { method: 'POST' });
    expect(h.state.uiTheme.notice).toBe('Back to BotBoy Dark.');
    expect(h.state.uiTheme.data.themes).toHaveLength(1);
  });

  it('puts focus back on the row (or the rename field) after a repaint', () => {
    const h = harness({ data: makeView() });
    document.body.innerHTML = h.render();
    h.state.uiTheme.pendingFocus = ID;
    h.restoreFocus();
    expect(document.activeElement?.closest('[data-theme-row]')?.getAttribute('data-theme-row')).toBe(ID);
    h.startRename(ID);
    document.body.innerHTML = h.render();
    h.restoreFocus();
    expect(document.activeElement?.id).toBe('theme-rename-input');
    h.state.uiTheme.busy = true;
    h.state.uiTheme.pendingFocus = ID;
    (document.activeElement as HTMLElement).blur();
    h.restoreFocus();
    expect(h.state.uiTheme.pendingFocus).toBe(ID);
  });
});
