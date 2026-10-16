// @vitest-environment jsdom
//
// The theme card in chat (app.js + ui-theme.js, docs/maps/ui-themes.md). The card code is evaluated straight from the shipped
// source against a stub api(); the renderer and the preview are the real ui-theme.js. The owner's three decisions are the buttons:
// Preview changes this page in memory, Keep saves it, Discard drops it. The model that proposed it can do none of them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveTheme, themeSwatch } from '../core/ui-theme-engine.js';

const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');
const themeScript = readFileSync(path.join(process.cwd(), 'src/ui/ui-theme.js'), 'utf8');
function constLine(name: string): string {
  const match = app.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}
function topLevel(name: string): string {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  return app.slice(start, app.indexOf('\n}\n', start) + 2);
}
/** The whole theme section: from its banner to the lesson card's click listener that follows it. */
function themeSection(): string {
  const start = app.indexOf('// ── Themes: the chat card for a theme BotBoy proposed');
  const end = app.indexOf("document.addEventListener('click', async (event) => {\n  const button = event.target.closest('[data-lesson-action]');");
  expect(start, 'missing the theme section').toBeGreaterThanOrEqual(0);
  expect(end, 'missing the lesson listener after it').toBeGreaterThan(start);
  return app.slice(start, end);
}

type ApiCall = { path: string; options?: { method?: string; body?: unknown } };
const holder: { api: (path: string, options?: ApiCall['options']) => Promise<any> } = { api: async () => ({}) };
let hydrateChatCards: (root: Element) => void;
let calls: ApiCall[];

const ID = 'th_0123456789ab';
const derived = (() => { const result = deriveTheme({ mode: 'dark', accent: '#2dd4bf' }); if (!result.ok) throw new Error(result.message); return result; })();
const proposal = (over: Record<string, unknown> = {}) => ({
  id: ID, name: 'Evergreen', mode: 'dark', status: 'pending', swatch: themeSwatch(derived.tokens), accent: '#2dd4bf', background: null,
  checks: derived.checks, adjustments: [], expiresAt: '2026-10-23T10:00:00.000Z', tokens: derived.tokens, active: false, ...over,
});
const view = (over: Record<string, unknown> = {}) => ({
  version: 4, active: ID, activeTheme: { id: ID, name: 'Evergreen', mode: 'dark', builtin: false }, activeTokens: derived.tokens,
  builtins: [], themes: [{ id: ID, name: 'Evergreen', mode: 'dark', swatch: themeSwatch(derived.tokens), builtin: false, active: true, createdAt: '2026-10-16T10:00:00.000Z' }],
  limits: { maxThemes: 12 }, ...over,
});
const root = document.documentElement;
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
const chat = () => document.getElementById('chat') as HTMLElement;
const bar = () => document.querySelector('.theme-preview-bar') as HTMLElement | null;

beforeAll(() => {
  const source = [
    constLine('LESSON_MARKER_RE'), constLine('GMAIL_DRAFT_MARKER_RE'), constLine('MCP_SERVER_MARKER_RE'), constLine('KNOWLEDGE_MARKER_RE'), constLine('THEME_MARKER_RE'),
    topLevel('hydrateChatCards'), topLevel('lessonEsc'),
    themeSection(),
    'return { hydrateChatCards };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  ({ hydrateChatCards } = new Function('api', source)((p: string, o?: ApiCall['options']) => {
    calls.push({ path: p, options: o });
    return holder.api(p, o);
  }));
});
beforeEach(() => {
  calls = [];
  root.removeAttribute('style');
  root.setAttribute('data-theme', 'dark');
  root.removeAttribute('data-botboy-choice');
  document.head.innerHTML = '<meta name="theme-color" content="#09090b">';
  document.body.innerHTML = '<div id="chat"></div>';
  // eslint-disable-next-line no-new-func
  new Function(themeScript)();
  holder.api = async (p: string) => (p === `/ui-theme/proposals/${ID}` ? proposal() : {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function cardFor(content = `Here is a teal look.\n\n[[theme:${ID}]]`): Promise<HTMLElement> {
  chat().innerHTML = `<div class="chat-msg assistant">${content.replace(/\n/g, '<br>')}</div>`;
  hydrateChatCards(chat());
  await flush();
  return chat().querySelector('.theme-chat-card') as HTMLElement;
}
const buttons = (card: HTMLElement) => [...card.querySelectorAll('button')].map((b) => b.dataset.themeCardAction);
const click = (card: HTMLElement, action: string) => (card.querySelector(`[data-theme-card-action="${action}"]`) as HTMLButtonElement).click();
const BTheme = () => (window as unknown as { BotBoyTheme: any }).BotBoyTheme;

describe('the marker becomes a card', () => {
  it('expands [[theme:th_…]], fetches the proposal once, and shows the owner what to decide', async () => {
    const card = await cardFor();
    expect(calls.map((c) => c.path)).toEqual([`/ui-theme/proposals/${ID}`]);
    expect(card.dataset.themeId).toBe(ID);
    expect(card.textContent).toContain('Evergreen');
    expect(card.textContent).toContain('Readable: all');
    expect(buttons(card)).toEqual(['preview', 'keep', 'discard']);
    expect(chat().textContent).not.toContain('[[theme:');
    // The page itself has not changed.
    expect(root.getAttribute('style')).toBeNull();
    expect(root.hasAttribute('data-botboy-choice')).toBe(false);
  });

  it('hydrates a card once however often the bubble is hydrated again', async () => {
    await cardFor();
    hydrateChatCards(chat());
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('says so, and offers no buttons, when the proposal is gone', async () => {
    holder.api = async () => ({ code: 'proposal_not_found', error: 'This theme proposal is no longer available.', nextAction: 'Ask BotBoy to make the theme again.' });
    const card = await cardFor();
    expect(card.textContent).toContain('no longer available');
    expect(buttons(card)).toEqual([]);
  });

  it('leaves a marker of another shape alone', async () => {
    chat().innerHTML = '<div class="chat-msg assistant">[[theme:th_nope]] and [[theme:th_0123456789abc]]</div>';
    hydrateChatCards(chat());
    await flush();
    expect(chat().querySelector('.theme-chat-card')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('Preview', () => {
  it('shows the theme on this page in memory, with a bar to keep or revert, and the card offers Stop preview', async () => {
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    expect(BTheme().previewing()).toBe(ID);
    expect(root.style.getPropertyValue('--accent')).toBe(derived.tokens.accent);
    expect(bar()!.textContent).toContain('Previewing Evergreen');
    expect(buttons(card)).toEqual(['stop-preview', 'keep', 'discard']);
    // Nothing was sent to the server.
    expect(calls.map((c) => c.options?.method ?? 'GET')).toEqual(['GET']);
  });

  it('Stop preview, and the bar\'s Revert, both put the page back and flip the card back to Preview', async () => {
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    click(card, 'stop-preview');
    await flush();
    expect(root.getAttribute('style')).toBeNull();
    expect(bar()).toBeNull();
    expect(buttons(card)).toEqual(['preview', 'keep', 'discard']);
    click(card, 'preview');
    await flush();
    (bar()!.querySelector('.theme-preview-revert') as HTMLButtonElement).click();
    await flush();
    expect(buttons(card)).toEqual(['preview', 'keep', 'discard']);
    expect(root.getAttribute('style')).toBeNull();
  });

  it('a card whose tokens are off the allowlist cannot be previewed: the page stays as it is and the card says so', async () => {
    holder.api = async () => proposal({ tokens: { ...derived.tokens, bg: 'url(https://evil.example/x)' } });
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    expect(root.getAttribute('style')).toBeNull();
    expect(bar()).toBeNull();
    expect(card.textContent).toContain('could not be previewed');
  });
});

describe('Keep', () => {
  it('posts the keep, shows what the server now holds, ends the preview, and paints the card as in use', async () => {
    holder.api = async (p, o) => {
      if (p === `/ui-theme/proposals/${ID}/keep`) return { alreadyKept: false, theme: { id: ID, name: 'Evergreen', active: true }, view: view() };
      return proposal();
    };
    const saved = vi.fn();
    window.addEventListener('botboy:theme-saved', (event) => saved((event as CustomEvent).detail));
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    click(card, 'keep');
    await flush();
    expect(calls.at(-1)).toEqual({ path: `/ui-theme/proposals/${ID}/keep`, options: { method: 'POST' } });
    expect(bar()).toBeNull();
    expect(BTheme().previewing()).toBeNull();
    expect(root.getAttribute('data-botboy-choice')).toBe(ID);
    expect(root.style.getPropertyValue('--accent')).toBe(derived.tokens.accent);
    expect(card.textContent).toContain('Kept.');
    expect(card.textContent).toContain('It is the theme in use now.');
    expect(buttons(card)).toEqual([]);
    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0]).toMatchObject({ version: 4, active: ID });
  });

  it('the bar\'s Keep does exactly what the card\'s Keep does', async () => {
    holder.api = async (p) => (p.endsWith('/keep') ? { theme: { id: ID, name: 'Evergreen' }, view: view() } : proposal());
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    (bar()!.querySelector('.theme-preview-keep') as HTMLButtonElement).click();
    await flush();
    expect(calls.filter((c) => c.path.endsWith('/keep'))).toHaveLength(1);
    expect(card.textContent).toContain('Kept.');
    expect(bar()).toBeNull();
  });

  it('a refusal keeps the card and the preview, re-enables the buttons, and says why and what to do', async () => {
    holder.api = async (p) => (p.endsWith('/keep')
      ? { code: 'theme_limit', error: 'There are already 12 saved themes.', nextAction: 'Delete one in Settings → Appearance, then keep this one.' }
      : proposal());
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    click(card, 'keep');
    await flush();
    expect(card.textContent).toContain('Could not keep it: There are already 12 saved themes. Delete one in Settings → Appearance');
    expect(card.querySelectorAll('button:disabled')).toHaveLength(0);
    expect(BTheme().previewing()).toBe(ID);
    expect(card.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('a network failure does the same', async () => {
    holder.api = async (p) => { if (p.endsWith('/keep')) throw new Error('offline'); return proposal(); };
    const card = await cardFor();
    click(card, 'keep');
    await flush();
    expect(card.textContent).toContain('Could not keep it: offline');
    expect(card.querySelectorAll('button:disabled')).toHaveLength(0);
  });
});

describe('Discard and Use this theme', () => {
  it('Discard posts, ends a preview of this card, and paints the discarded state with no buttons', async () => {
    holder.api = async (p) => (p.endsWith('/discard') ? { status: 'discarded' } : proposal());
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    click(card, 'discard');
    await flush();
    expect(calls.at(-1)).toEqual({ path: `/ui-theme/proposals/${ID}/discard`, options: { method: 'POST' } });
    expect(BTheme().previewing()).toBeNull();
    expect(root.getAttribute('style')).toBeNull();
    expect(card.textContent).toContain('Discarded.');
    expect(buttons(card)).toEqual([]);
  });

  it('a kept theme that is not in use can be used from its card (an object body, the id only)', async () => {
    holder.api = async (p, o) => {
      if (p === '/ui-theme/active') return view();
      return proposal({ status: 'kept', tokens: null, active: false });
    };
    const card = await cardFor();
    expect(buttons(card)).toEqual(['apply']);
    click(card, 'apply');
    await flush();
    expect(calls.at(-1)).toEqual({ path: '/ui-theme/active', options: { method: 'PUT', body: { id: ID } } });
    expect(root.getAttribute('data-botboy-choice')).toBe(ID);
    expect(card.textContent).toContain('It is the theme in use now.');
  });
});

describe('the card follows its theme', () => {
  it('reads itself again when the themes change, and repaints only when the answer differs', async () => {
    const card = await cardFor();
    const before = card.firstElementChild;
    window.dispatchEvent(new CustomEvent('botboy:themes-changed'));
    await flush();
    expect(calls).toHaveLength(2);
    expect(card.firstElementChild).toBe(before);
    holder.api = async () => proposal({ status: 'kept', tokens: null, active: true });
    window.dispatchEvent(new CustomEvent('botboy:themes-changed'));
    await flush();
    expect(card.textContent).toContain('Kept.');
    expect(buttons(card)).toEqual([]);
  });

  it('does not read a card that is being previewed, or one with a click in flight', async () => {
    const card = await cardFor();
    click(card, 'preview');
    await flush();
    const before = calls.length;
    window.dispatchEvent(new CustomEvent('botboy:themes-changed'));
    await flush();
    expect(calls).toHaveLength(before);
  });

  it('a refresh that fails keeps the card the owner is reading', async () => {
    const card = await cardFor();
    holder.api = async () => { throw new Error('offline'); };
    window.dispatchEvent(new CustomEvent('botboy:themes-changed'));
    await flush();
    expect(buttons(card)).toEqual(['preview', 'keep', 'discard']);
  });
});

describe('what a bubble cannot do', () => {
  it('a button that merely looks like a card button, outside a card, posts nothing', async () => {
    document.body.insertAdjacentHTML('beforeend', '<button data-theme-card-action="keep">Keep</button>');
    (document.querySelector('body > button') as HTMLButtonElement).click();
    await flush();
    expect(calls).toEqual([]);
  });

  it('text a model puts in a reply cannot become a button: only the marker makes a card, and the card draws from the server', async () => {
    const card = await cardFor('<button data-theme-card-action="keep">Keep</button> [[theme:th_0123456789ab]]');
    expect(card).not.toBeNull();
    // The forged button sits OUTSIDE the card, so it does nothing.
    (chat().querySelector('.chat-msg > button') as HTMLButtonElement | null)?.click();
    await flush();
    expect(calls.filter((c) => c.options?.method === 'POST')).toEqual([]);
  });
});
