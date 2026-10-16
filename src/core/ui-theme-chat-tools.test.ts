// ui_theme_propose (docs/maps/ui-themes.md): who may call it, what it stages, what it can never do, and the card marker the reply keeps.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor } from './tool-executor.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createUiThemes, type UiThemes } from './ui-theme.js';
import {
  UI_THEME_CHAT_TOOL_NAMES, UI_THEME_GUIDANCE_BLOCK, asksAboutAppearance, uiThemeCardMarker, uiThemeIdFromToolResult, withUiThemeCards, withUiThemeChatTools,
} from './ui-theme-chat-tools.js';
import { JOB_SCOPE_TOOLS } from './job-mandate.js';

const call = (args: Record<string, unknown> | string, name = 'ui_theme_propose'): ToolCall => ({
  id: 'call-1', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const live = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  callerKind: 'interactive', currentUserMessage: 'make me a teal theme', uiThemeTurn: true, ownerRequestId: 'req-1', ...over,
});
const body = (result: { content: string }) => JSON.parse(result.content);

describe('ui_theme_propose', () => {
  let storage: StorageLayer;
  let themes: UiThemes;
  let baseCalls: string[];
  let executor: ToolExecutor;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    let n = 1;
    themes = createUiThemes({ db: storage.getDb(), newId: () => (n++).toString(16).padStart(12, '0') });
    baseCalls = [];
    const base: ToolExecutor = { executeTool: vi.fn(async (c: ToolCall) => { baseCalls.push(c.function.name); return { toolCallId: c.id, content: 'base', isError: false }; }) };
    executor = withUiThemeChatTools(base, { themes });
  });
  afterEach(() => storage.close());

  it('hands every other tool to the base executor untouched', async () => {
    const result = await executor.executeTool(call({}, 'search_items'), live());
    expect(result.content).toBe('base');
    expect(baseCalls).toEqual(['search_items']);
    expect(baseCalls).not.toContain('ui_theme_propose');
  });

  it('stages a proposal and changes nothing the owner sees', async () => {
    const result = await executor.executeTool(call({ name: 'Evergreen', mode: 'dark', accent: '#2dd4bf' }), live());
    expect(result.isError).toBe(false);
    const out = body(result);
    expect(out).toMatchObject({ ok: true, status: 'staged', effect: 'none', name: 'Evergreen', mode: 'dark', accent: '#2dd4bf', existing: false });
    expect(out.proposalId).toMatch(/^th_[0-9a-f]{12}$/);
    expect(out.card).toBe(`[[theme:${out.proposalId}]]`);
    expect(out.nextAction).toContain(out.card);
    expect(out.nextAction).toMatch(/cannot apply it/);
    expect(out.readability.checksPassed).toBe(out.readability.checks);
    expect(out.swatch).toHaveLength(5);
    expect(themes.view()).toMatchObject({ active: null, themes: [] });
    expect(themes.proposal(out.proposalId)).toMatchObject({ status: 'pending' });
    expect(baseCalls).toEqual([]);
  });

  it('tells the model when the server adjusted a colour, so the reply can say so', async () => {
    const out = body(await executor.executeTool(call({ name: 'Warm red', mode: 'dark', accent: '#ef4444' }), live()));
    expect(out.adjustments).toEqual([expect.objectContaining({ token: 'accent', from: '#ef4444' })]);
    expect(out.nextAction).toMatch(/accent was adjusted slightly/);
  });

  describe('authority', () => {
    it.each([
      ['a background run', { callerKind: 'background' as const }],
      ['a continuation', { callerKind: 'continuation' as const }],
      ['a task the owner started (it is not a live turn)', { callerKind: 'background' as const, ownerStartedRun: true }],
      ['a turn with no owner message', { currentUserMessage: '   ' }],
    ])('is refused for %s, and stages nothing', async (_label, over) => {
      const result = await executor.executeTool(call({ name: 'Evergreen', mode: 'dark', accent: '#2dd4bf' }), live(over));
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ ok: false, code: 'owner_turn_required', effect: 'none' });
      expect(themes.version()).toBe(0);
    });

    it('is refused on a turn that is not about how BotBoy looks', async () => {
      const result = await executor.executeTool(call({ name: 'Evergreen', mode: 'dark', accent: '#2dd4bf' }), live({ uiThemeTurn: undefined }));
      expect(body(result)).toMatchObject({ ok: false, code: 'not_requested' });
      expect(themes.version()).toBe(0);
    });

    it('is refused with no context at all', async () => {
      expect(body(await executor.executeTool(call({ name: 'x', mode: 'dark', accent: '#2dd4bf' })))).toMatchObject({ code: 'owner_turn_required' });
    });

    it('does nothing when themes are not wired', async () => {
      const bare = withUiThemeChatTools({ executeTool: vi.fn() } as unknown as ToolExecutor, {});
      expect(body(await bare.executeTool(call({ name: 'x', mode: 'dark', accent: '#2dd4bf' }), live()))).toMatchObject({ code: 'themes_unavailable' });
    });

    it('is not a job tool: a continuation never even sees it', () => {
      expect(JOB_SCOPE_TOOLS.has('ui_theme_propose')).toBe(false);
    });
  });

  describe('arguments', () => {
    it('refuses anything but the four choices, so no CSS, token or file can be passed', async () => {
      for (const extra of [{ css: 'body{display:none}' }, { tokens: { bg: '#000000' } }, { path: 'src/ui/dashboard.css' }, { bgRaised: '#101010' }]) {
        const result = await executor.executeTool(call({ name: 'Evergreen', mode: 'dark', accent: '#2dd4bf', ...extra }), live());
        expect(body(result)).toMatchObject({ ok: false, code: 'invalid_arguments', effect: 'none' });
        expect(body(result).nextAction).toMatch(/only name, mode, accent/);
      }
      expect(themes.version()).toBe(0);
    });

    it('refuses arguments that are not one JSON object', async () => {
      expect(body(await executor.executeTool(call('{nope'), live()))).toMatchObject({ code: 'invalid_arguments' });
      expect(body(await executor.executeTool(call('[1,2]'), live()))).toMatchObject({ code: 'invalid_arguments' });
      expect(body(await executor.executeTool(call('null'), live()))).toMatchObject({ code: 'invalid_arguments' });
    });

    it('answers a seed that cannot be made readable with the colours that would work', async () => {
      const result = await executor.executeTool(call({ name: 'Lemon', mode: 'light', accent: '#ffeb3b' }), live());
      const out = body(result);
      expect(result.isError).toBe(true);
      expect(out).toMatchObject({ ok: false, code: 'accent_unreadable', effect: 'none' });
      expect(out.suggestion.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(out.nextAction).toContain(out.suggestion.accent);
      // Sending the suggestion back works.
      const retry = body(await executor.executeTool(call({ name: 'Lemon', mode: 'light', accent: out.suggestion.accent }), live()));
      expect(retry).toMatchObject({ ok: true, status: 'staged' });
    });

    it('says what is wrong with a name or a colour and what to send instead', async () => {
      expect(body(await executor.executeTool(call({ name: '', mode: 'dark', accent: '#2dd4bf' }), live()))).toMatchObject({ code: 'invalid_name' });
      expect(body(await executor.executeTool(call({ name: 'x', mode: 'blue', accent: '#2dd4bf' }), live()))).toMatchObject({ code: 'invalid_mode' });
      const color = body(await executor.executeTool(call({ name: 'x', mode: 'dark', accent: 'teal' }), live()));
      expect(color).toMatchObject({ code: 'invalid_color' });
      expect(color.nextAction).toMatch(/hex colour like/);
    });
  });

  describe('limits', () => {
    it('allows five proposals in one request, then stops, and a new request starts again', async () => {
      const propose = (index: number, requestId = 'req-1') => executor.executeTool(
        call({ name: `Option ${index}`, mode: 'dark', accent: `#${(index + 16).toString(16).padStart(2, '0')}c5e0` }), live({ ownerRequestId: requestId }),
      );
      for (let index = 0; index < 5; index += 1) expect(body(await propose(index)).ok).toBe(true);
      expect(body(await propose(5))).toMatchObject({ ok: false, code: 'too_many_proposals' });
      expect(body(await propose(6, 'req-2')).ok).toBe(true);
    });

    it('does not count a repeated request as a new proposal', async () => {
      const same = () => executor.executeTool(call({ name: 'Evergreen', mode: 'dark', accent: '#2dd4bf' }), live());
      const ids = new Set<string>();
      for (let index = 0; index < 8; index += 1) ids.add(body(await same()).proposalId);
      expect(ids.size).toBe(1);
    });
  });
});

describe('the card marker', () => {
  let storage: StorageLayer;
  let themes: UiThemes;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    themes = createUiThemes({ db: storage.getDb() });
  });
  afterEach(() => storage.close());
  const stage = (name: string, accent: string) => {
    const result = themes.propose({ name, mode: 'dark', accent });
    if (!result.ok) throw new Error(result.message);
    return result.value.proposal.id;
  };

  it('reads the proposal id from a receipt, and from nothing else', () => {
    const id = stage('Evergreen', '#2dd4bf');
    expect(uiThemeIdFromToolResult('ui_theme_propose', JSON.stringify({ ok: true, proposalId: id }))).toBe(id);
    expect(uiThemeIdFromToolResult('ui_theme_propose', JSON.stringify({ ok: false, code: 'invalid_color' }))).toBeNull();
    expect(uiThemeIdFromToolResult('ui_theme_propose', JSON.stringify({ proposalId: 'th_nope' }))).toBeNull();
    expect(uiThemeIdFromToolResult('ui_theme_propose', 'not json')).toBeNull();
    expect(uiThemeIdFromToolResult('search_items', JSON.stringify({ proposalId: id }))).toBeNull();
  });

  it('appends the marker the reply is missing, once, and leaves a reply that already has it alone', () => {
    const id = stage('Evergreen', '#2dd4bf');
    const reply = 'Here is a teal look.';
    const withCard = withUiThemeCards(reply, [id, id], themes);
    expect(withCard).toBe(`${reply}\n\n${uiThemeCardMarker(id)}`);
    expect(withUiThemeCards(withCard, [id], themes)).toBe(withCard);
    expect(withUiThemeCards(`${reply}\n${uiThemeCardMarker(id)}\nMore.`, [id], themes)).toBe(`${reply}\n${uiThemeCardMarker(id)}\nMore.`);
  });

  it('adds one marker per proposal, skips a discarded one and an unknown one, and does nothing with no store', () => {
    const a = stage('A', '#2dd4bf');
    const b = stage('B', '#22c55e');
    const c = stage('C', '#f97316');
    themes.discard(c);
    const out = withUiThemeCards('Pick one.', [a, b, c, 'th_ffffffffffff'], themes);
    expect(out).toBe(`Pick one.\n\n${uiThemeCardMarker(a)}\n${uiThemeCardMarker(b)}`);
    expect(withUiThemeCards('Pick one.', [], themes)).toBe('Pick one.');
    expect(withUiThemeCards('Pick one.', [a], undefined)).toBe('Pick one.');
  });
});

describe('when the tool is offered', () => {
  it.each([
    'make me a new theme', 'can you change the color scheme', 'switch to dark mode', 'try a light theme please', 'what about a different palette',
    'change the accent color to teal', 'give BotBoy a new look and feel', 'restyle the app', 'make the ui greener, colors feel off', 'I want a different appearance',
    'change the colours of the dashboard',
  ])('yes: %j', (message) => {
    expect(asksAboutAppearance(message)).toBe(true);
  });

  it.each([
    'what are my open tasks', 'summarize the Slack thread about the launch', 'what color is the pill for overdue tasks?', 'send an email to Dana about the budget',
    'build a dashboard of weekly sales by region', 'fix the layout bug in the sidebar',
  ])('no: %j', (message) => {
    expect(asksAboutAppearance(message)).toBe(false);
  });

  it('the guidance tells the model it only stages, and names the card marker', () => {
    expect(UI_THEME_GUIDANCE_BLOCK).toMatch(/only STAGES/);
    expect(UI_THEME_GUIDANCE_BLOCK).toContain('[[theme:th_');
    expect(UI_THEME_GUIDANCE_BLOCK).toMatch(/Never recolour the UI by editing/);
    expect(UI_THEME_GUIDANCE_BLOCK).toMatch(/only wants dark or light mode, point to the sun or moon button/);
    expect(UI_THEME_CHAT_TOOL_NAMES).toEqual(['ui_theme_propose']);
  });
});
