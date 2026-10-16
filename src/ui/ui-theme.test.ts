// @vitest-environment jsdom
//
// ui-theme.js (docs/maps/ui-themes.md): what the browser will and will not apply, the preview that ends where it started, and the
// markup of the chat card and the Appearance rows. The script is evaluated straight from the shipped source.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEME_TOKENS, THEME_TOKEN_NAMES, deriveTheme, themeSwatch, type ThemeTokens } from '../core/ui-theme-engine.js';

const source = readFileSync(path.join(process.cwd(), 'src/ui/ui-theme.js'), 'utf8');
type Theme = { id: string; mode: 'dark' | 'light'; tokens: Record<string, string> };
type Api = {
  TOKEN_NAMES: string[]; validTokens(t: unknown): boolean; validTheme(t: unknown): boolean; apply(t: Theme): boolean; applyView(v: unknown): boolean;
  setBuiltin(mode: string, options?: { persist?: boolean }): boolean; current(): { id: string; mode: string; custom: boolean }; currentMode(): string;
  startPreview(t: Theme, name: string, hooks?: { onKeep?: () => void }): boolean; endPreview(revert?: boolean): boolean; previewing(): string | null;
  swatchHtml(c: unknown): string; cardHtml(p: any, h: any, o?: any): string; rowHtml(r: any, h: any, u?: any): string;
};
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const helpers = { esc, attr: esc };
const ID = 'th_0123456789ab';
let ui: Api;
const root = document.documentElement;

function theme(mode: 'dark' | 'light' = 'dark', accent = '#2dd4bf', id = ID): Theme {
  const derived = deriveTheme({ mode, accent });
  if (!derived.ok) throw new Error(derived.message);
  return { id, mode, tokens: derived.tokens };
}
const inline = () => root.getAttribute('style') ?? '';

beforeEach(() => {
  root.removeAttribute('style');
  root.setAttribute('data-theme', 'dark');
  root.removeAttribute('data-botboy-choice');
  document.querySelectorAll('.theme-preview-bar').forEach((bar) => bar.remove());
  document.head.innerHTML = '<meta name="theme-color" content="#09090b">';
  document.body.innerHTML = '<button data-action="toggle-theme"><svg><use href="#i-sun"/></svg></button>';
  localStorage.clear();
  // eslint-disable-next-line no-new-func
  new Function(source)();
  ui = (window as unknown as { BotBoyTheme: Api }).BotBoyTheme;
});

describe('the allowlist', () => {
  it('knows exactly the tokens the server derives, in the same order', () => {
    expect(ui.TOKEN_NAMES).toEqual([...THEME_TOKEN_NAMES]);
  });

  it('accepts both shipped palettes and every derived theme, so server and browser agree on the formats', () => {
    expect(ui.validTokens(BUILTIN_THEME_TOKENS.dark)).toBe(true);
    expect(ui.validTokens(BUILTIN_THEME_TOKENS.light)).toBe(true);
    for (const accent of ['#2dd4bf', '#ef4444', '#f59e0b', '#8b5cf6']) {
      for (const mode of ['dark', 'light'] as const) expect(ui.validTheme(theme(mode, accent)), `${mode} ${accent}`).toBe(true);
    }
  });

  it('refuses a map with an extra, missing or malformed token, and a non-object', () => {
    const good = { ...BUILTIN_THEME_TOKENS.dark };
    expect(ui.validTokens({ ...good, topbar: '12px' })).toBe(false);
    const missing: Record<string, string> = { ...good };
    delete missing.hover;
    expect(ui.validTokens(missing)).toBe(false);
    for (const bad of ['url(https://evil.example/x)', '#09090b;position:fixed', 'red', '#FFF', 'var(--text)', '#09090b}body{display:none']) {
      expect(ui.validTokens({ ...good, bg: bad }), bad).toBe(false);
    }
    expect(ui.validTokens({ ...good, border: 'rgba(300,0,0,.5)' })).toBe(false);
    expect(ui.validTokens({ ...good, 'accent-rgb': '157,140,300' })).toBe(false);
    for (const bad of [null, undefined, 'bg', 7, [], []]) expect(ui.validTokens(bad)).toBe(false);
  });

  it('needs a real mode and a th_ id as well', () => {
    const base = theme();
    expect(ui.validTheme({ ...base, mode: 'sepia' })).toBe(false);
    expect(ui.validTheme({ ...base, id: 'th_nope' })).toBe(false);
    expect(ui.validTheme({ ...base, id: '"><script>' })).toBe(false);
    expect(ui.validTheme(null)).toBe(false);
  });
});

describe('applying a theme', () => {
  it('sets only allowlisted properties as inline style, with the mode and the choice on <html>', () => {
    const t = theme('light', '#0d9488');
    expect(ui.apply(t)).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.getAttribute('data-botboy-choice')).toBe(ID);
    const declarations = inline().split(';').map((part) => part.trim()).filter(Boolean);
    expect(declarations).toHaveLength(THEME_TOKEN_NAMES.length);
    for (const name of THEME_TOKEN_NAMES) expect(root.style.getPropertyValue(`--${name}`), name).toBe(t.tokens[name]);
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(t.tokens.bg);
    expect(ui.current()).toEqual({ id: ID, mode: 'light', custom: true });
  });

  it('refuses a theme whole: one bad value means nothing at all is applied', () => {
    const t = theme();
    const hostile = { ...t, tokens: { ...t.tokens, text: 'url(https://evil.example/x)' } };
    expect(ui.apply(hostile)).toBe(false);
    expect(inline()).toBe('');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.hasAttribute('data-botboy-choice')).toBe(false);
  });

  it('a shipped palette removes exactly what the theme set, and remembers the choice in this browser', () => {
    root.style.setProperty('--unrelated', '1px');
    ui.apply(theme());
    expect(ui.setBuiltin('light')).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.getAttribute('data-botboy-choice')).toBe('builtin:light');
    for (const name of THEME_TOKEN_NAMES) expect(root.style.getPropertyValue(`--${name}`), name).toBe('');
    expect(root.style.getPropertyValue('--unrelated')).toBe('1px');
    expect(localStorage.getItem('botboy-theme')).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#f4f4f6');
    expect(ui.setBuiltin('sepia')).toBe(false);
    expect(ui.current()).toEqual({ id: 'builtin:light', mode: 'light', custom: false });
  });

  it('keeps the topbar button honest: the sun while dark, the moon while light', () => {
    const href = () => document.querySelector('[data-action="toggle-theme"] use')!.getAttribute('href');
    ui.setBuiltin('light');
    expect(href()).toBe('#i-moon');
    ui.apply(theme('dark'));
    expect(href()).toBe('#i-sun');
  });

  it('tells the page when the theme changed', () => {
    const seen = vi.fn();
    window.addEventListener('botboy:theme-changed', (event) => seen((event as CustomEvent).detail));
    ui.apply(theme());
    ui.setBuiltin('dark', { persist: false });
    expect(seen).toHaveBeenNthCalledWith(1, { id: ID, mode: 'dark', builtin: false });
    expect(seen).toHaveBeenNthCalledWith(2, { id: 'builtin:dark', mode: 'dark', builtin: true });
    expect(localStorage.getItem('botboy-theme')).toBeNull();
  });
});

describe('showing what the server holds', () => {
  const view = (over: Record<string, unknown>) => ({ version: 3, active: null, activeTheme: { id: 'builtin:dark', name: 'BotBoy Dark', mode: 'dark', builtin: true }, activeTokens: null, builtins: [], themes: [], ...over });

  it('changes nothing for a server nobody has asked yet, so the browser keeps its own light or dark', () => {
    ui.setBuiltin('light');
    expect(ui.applyView(view({ active: null }))).toBe(false);
    expect(ui.currentMode()).toBe('light');
    expect(ui.applyView(null)).toBe(false);
    expect(ui.applyView({})).toBe(false);
  });

  it('applies a saved theme from its tokens, and a shipped one by name', () => {
    const t = theme('dark', '#22c55e');
    expect(ui.applyView(view({ active: t.id, activeTheme: { id: t.id, name: 'Green', mode: 'dark', builtin: false }, activeTokens: t.tokens }))).toBe(true);
    expect(root.getAttribute('data-botboy-choice')).toBe(t.id);
    expect(ui.applyView(view({ active: 'builtin:light', activeTheme: { id: 'builtin:light', name: 'BotBoy Light', mode: 'light', builtin: true } }))).toBe(true);
    expect(ui.current()).toEqual({ id: 'builtin:light', mode: 'light', custom: false });
    expect(localStorage.getItem('botboy-theme')).toBe('light');
  });

  it('refuses a saved theme whose tokens are off the allowlist', () => {
    const t = theme();
    expect(ui.applyView(view({ active: t.id, activeTheme: { id: t.id, name: 'x', mode: 'dark', builtin: false }, activeTokens: { ...t.tokens, bg: 'url(x)' } }))).toBe(false);
    expect(inline()).toBe('');
  });
});

describe('previewing', () => {
  const bar = () => document.querySelector('.theme-preview-bar') as HTMLElement | null;

  it('paints the proposal and shows a bar with Keep and Revert, in memory only', () => {
    const t = theme('light', '#0d9488');
    const onKeep = vi.fn();
    expect(ui.startPreview(t, 'Paper', { onKeep })).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.style.getPropertyValue('--accent')).toBe(t.tokens.accent);
    expect(ui.previewing()).toBe(ID);
    expect(bar()!.getAttribute('role')).toBe('region');
    expect(bar()!.textContent).toContain('Previewing Paper');
    expect([...bar()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Keep', 'Revert']);
    (bar()!.querySelector('.theme-preview-keep') as HTMLButtonElement).click();
    expect(onKeep).toHaveBeenCalledOnce();
    expect(localStorage.getItem('botboy-theme')).toBeNull();
  });

  it('Revert puts back exactly what was there: the style, the mode, the choice and the colour of the browser bar', () => {
    const before = theme('dark', '#f59e0b', 'th_aaaaaaaaaaaa');
    ui.apply(before);
    const styleBefore = inline();
    ui.startPreview(theme('light', '#0d9488'), 'Paper');
    expect(inline()).not.toBe(styleBefore);
    (bar()!.querySelector('.theme-preview-revert') as HTMLButtonElement).click();
    expect(inline()).toBe(styleBefore);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-botboy-choice')).toBe('th_aaaaaaaaaaaa');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(before.tokens.bg);
    expect(bar()).toBeNull();
    expect(ui.previewing()).toBeNull();
  });

  it('reverts to a plain shipped theme too (no inline style left behind)', () => {
    ui.startPreview(theme(), 'Evergreen');
    expect(inline()).not.toBe('');
    ui.endPreview(true);
    expect(root.getAttribute('style')).toBeNull();
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('shows the theme name as text, never as markup', () => {
    ui.startPreview(theme(), '<img src=x onerror=alert(1)>');
    expect(bar()!.querySelector('img')).toBeNull();
    expect(bar()!.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a second preview replaces the first and still reverts to the original', () => {
    ui.apply(theme('dark', '#f59e0b', 'th_aaaaaaaaaaaa'));
    const styleBefore = inline();
    ui.startPreview(theme('dark', '#22c55e', 'th_bbbbbbbbbbbb'), 'One');
    ui.startPreview(theme('light', '#0d9488', 'th_cccccccccccc'), 'Two');
    expect(document.querySelectorAll('.theme-preview-bar')).toHaveLength(1);
    expect(ui.previewing()).toBe('th_cccccccccccc');
    ui.endPreview(true);
    expect(inline()).toBe(styleBefore);
  });

  it('Keep without restoring leaves the preview on screen as the new truth', () => {
    const t = theme();
    ui.startPreview(t, 'Evergreen');
    expect(ui.endPreview(false)).toBe(true);
    expect(root.style.getPropertyValue('--accent')).toBe(t.tokens.accent);
    expect(bar()).toBeNull();
  });

  it('a saved theme that arrives while a preview is up waits, and is what Revert returns to', () => {
    ui.startPreview(theme('dark', '#22c55e', 'th_bbbbbbbbbbbb'), 'Preview');
    const arrived = theme('light', '#0d9488', 'th_aaaaaaaaaaaa');
    expect(ui.apply(arrived)).toBe(true);
    expect(ui.setBuiltin('light')).toBe(true);
    expect(root.getAttribute('data-botboy-choice')).toBe('th_bbbbbbbbbbbb');
    ui.endPreview(true);
    expect(root.getAttribute('data-botboy-choice')).toBe('builtin:light');
  });

  it('refuses to preview a theme that is off the allowlist, and shows nothing', () => {
    const t = theme();
    expect(ui.startPreview({ ...t, tokens: { ...t.tokens, bg: 'url(x)' } }, 'Bad')).toBe(false);
    expect(bar()).toBeNull();
    expect(inline()).toBe('');
    expect(ui.endPreview(true)).toBe(false);
  });

  it('tells the cards when a preview starts and ends', () => {
    const seen = vi.fn();
    window.addEventListener('botboy:theme-preview', (event) => seen((event as CustomEvent).detail));
    ui.startPreview(theme(), 'x');
    ui.endPreview(true);
    expect(seen).toHaveBeenNthCalledWith(1, { id: ID, active: true });
    expect(seen).toHaveBeenNthCalledWith(2, { id: ID, active: false });
  });
});

describe('the theme card', () => {
  const proposal = (over: Record<string, unknown> = {}) => ({
    id: ID, name: 'Evergreen', mode: 'dark', status: 'pending', swatch: themeSwatch(theme().tokens), accent: '#2dd4bf', background: null,
    checks: [{ id: 'a', label: 'A', ratio: 7, min: 4.5, ok: true }, { id: 'b', label: 'B', ratio: 5, min: 4.5, ok: true }], adjustments: [], active: false, ...over,
  });
  const html = (p: unknown, o?: unknown) => ui.cardHtml(p, helpers, o);
  const actions = (markup: string) => [...markup.matchAll(/data-theme-card-action="([a-z-]+)"/g)].map((m) => m[1]);

  it('a pending card offers Preview, Keep and Discard, says it is readable, and that nothing is saved yet', () => {
    const markup = html(proposal());
    expect(actions(markup)).toEqual(['preview', 'keep', 'discard']);
    expect(markup).toContain('Readable: all 2 text and contrast checks pass.');
    expect(markup).toContain('Nothing is saved until you press Keep.');
    expect(markup).toContain('Dark · accent #2dd4bf');
    expect((markup.match(/<i style="background:#[0-9a-f]{6}"><\/i>/g) ?? [])).toHaveLength(5);
  });

  it('while previewing, the first button stops the preview', () => {
    expect(actions(html(proposal(), { previewing: true }))).toEqual(['stop-preview', 'keep', 'discard']);
  });

  it('names a colour the server adjusted, and says how many checks pass when not all do', () => {
    const markup = html(proposal({ adjustments: [{ token: 'accent', from: '#ef4444', to: '#f15c5c', reason: 'Moved lighter so accent text stays readable.' }], checks: [{ ok: true }, { ok: false }] }));
    expect(markup).toContain('Accent moved from #ef4444 to #f15c5c. Moved lighter so accent text stays readable.');
    expect(markup).toContain('1 of 2 text checks pass.');
  });

  it('the other states carry no Keep or Discard', () => {
    expect(actions(html(proposal({ status: 'kept', active: false })))).toEqual(['apply']);
    expect(html(proposal({ status: 'kept', active: true }))).toContain('It is the theme in use now.');
    expect(actions(html(proposal({ status: 'kept', active: true })))).toEqual([]);
    expect(html(proposal({ status: 'discarded' }))).toContain('Discarded.');
    expect(html(proposal({ status: 'removed' }))).toContain('deleted from Settings → Appearance');
    expect(html(proposal({ status: 'nonsense' }))).toContain('no longer available');
    for (const status of ['kept', 'discarded', 'removed']) expect(actions(html(proposal({ status })))).not.toContain('keep');
  });

  it('every button says which theme it is about, escaped, so a screen reader hears "Keep Evergreen" and not just "Keep"', () => {
    const named = html(proposal({ name: 'Evergreen "Deep"' }));
    for (const verb of ['Preview', 'Keep', 'Discard']) expect(named).toContain(`aria-label="${verb} Evergreen &quot;Deep&quot;"`);
    expect(html(proposal({ name: 'Evergreen' }), { previewing: true })).toContain('aria-label="Stop previewing Evergreen"');
    expect(html(proposal({ name: 'Evergreen', status: 'kept', active: false }))).toContain('aria-label="Use Evergreen"');
  });

  it('escapes everything a model chose: the name, the colours, the reasons, the notice', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const markup = html(proposal({ name: evil, accent: evil, background: evil, adjustments: [{ token: 'background', from: evil, to: evil, reason: evil }] }), { notice: evil });
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('draws only valid colours in the swatch, and no style at all for anything else', () => {
    const markup = ui.swatchHtml(['#09090b', 'red', 'url(x)', '#12345', '#ABCDEF', '#aabbcc']);
    expect(markup.match(/background:(#[0-9a-f]{6})/g)).toEqual(['background:#09090b', 'background:#aabbcc']);
    expect(ui.swatchHtml(undefined)).toBe('<span class="theme-swatch" aria-hidden="true"></span>');
  });
});

describe('the Appearance rows', () => {
  const swatch = themeSwatch(BUILTIN_THEME_TOKENS.dark as ThemeTokens);
  const row = (over: Record<string, unknown> = {}) => ({ id: ID, name: 'Evergreen', mode: 'dark', swatch, builtin: false, active: false, createdAt: '2026-10-16T10:00:00.000Z', ...over });
  const html = (r: unknown, u?: unknown) => ui.rowHtml(r, helpers, u);

  it('a saved theme can be applied, renamed and deleted; the one in use shows a pill instead of Apply', () => {
    const idle = html(row());
    expect(idle).toContain('data-action="theme-apply"');
    expect(idle).toContain('data-action="theme-rename"');
    expect(idle).toContain('data-action="theme-delete"');
    expect(idle).toContain('Dark · made in chat, kept');
    const inUse = html(row({ active: true }));
    expect(inUse).toContain('<span class="pill accent">In use</span>');
    expect(inUse).not.toContain('data-action="theme-apply"');
    expect(inUse).toContain('theme-row active');
  });

  it('a shipped theme can only be applied', () => {
    const shipped = html(row({ id: 'builtin:light', name: 'BotBoy Light', mode: 'light', builtin: true, createdAt: null }));
    expect(shipped).toContain('data-action="theme-apply"');
    expect(shipped).toContain('Light · shipped with BotBoy');
    expect(shipped).not.toContain('theme-rename');
    expect(shipped).not.toContain('theme-delete');
  });

  it('renaming swaps the name for a form with the current name in it; deleting asks first', () => {
    const renaming = html(row(), { renaming: ID });
    expect(renaming).toContain('data-theme-rename-form');
    expect(renaming).toContain('value="Evergreen"');
    expect(renaming).toContain('maxlength="40"');
    expect(renaming).toContain('data-action="theme-rename-cancel"');
    const confirming = html(row(), { confirmingDelete: ID });
    expect(confirming).toContain('Delete this theme?');
    expect(confirming).toContain('data-action="theme-delete-confirm"');
    expect(confirming).toContain('data-action="theme-delete-cancel"');
    expect(confirming).not.toContain('data-action="theme-apply"');
  });

  it('each row button names its theme for a screen reader', () => {
    const markup = html(row({ name: 'Evergreen' }));
    for (const verb of ['Apply', 'Rename', 'Delete']) expect(markup).toContain(`aria-label="${verb} Evergreen"`);
    expect(html(row({ name: 'Evergreen' }), { confirmingDelete: ID })).toContain('aria-label="Delete Evergreen"');
  });

  it('every control is disabled while a request is in flight', () => {
    const busy = html(row(), { busy: true });
    expect([...busy.matchAll(/<button[^>]*>/g)].every((m) => m[0].includes(' disabled'))).toBe(true);
  });

  it('escapes the name wherever it appears', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    for (const ui2 of [undefined, { renaming: ID }, { confirmingDelete: ID }]) {
      const markup = html(row({ name: evil, id: ID }), ui2);
      expect(markup).not.toContain('<img');
    }
  });
});
