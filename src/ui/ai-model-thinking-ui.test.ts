// @vitest-environment jsdom
//
// Thinking "Off" on Claude models (design D5, slice B): a badge with an exact tooltip on the Settings → AI model
// model rows and role captions (dashboard.js), and a tooltip note on the chat panel's Thinking control (app.js).
// Rendered from the shipped source against a small state object, like ai-model-key-card-ui.test.ts. No option is
// relabeled, models of the other providers render exactly as before, and a value the server never sends renders nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');
const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');

function topLevel(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}
function constLine(source: string, name: string): string {
  const match = source.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}
function constObject(source: string, name: string): string {
  const start = source.indexOf(`\nconst ${name} = {`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n};\n', start);
  return source.slice(start, end + 4);
}

// The exact copy of design D5.
const COPY = {
  lowest_effort: 'Always thinks a little; Off uses its lowest effort.',
  native_without_tools: 'Off works for background work; in chat, with tools on, it thinks a little.',
  unavailable: 'No thinking control.',
} as const;

function loadDashboard(state: Record<string, any> = { aiModel: { roleBusy: '', saving: false, removing: false } }) {
  const source = [
    constLine(dashboard, 'icon'), constLine(dashboard, 'esc'), constLine(dashboard, 'attr'),
    constObject(dashboard, 'AI_MODEL_ROLE_COPY'),
    constLine(dashboard, 'AI_MODEL_THINKING_LEVELS'),
    constObject(dashboard, 'AI_MODEL_THINKING_OFF'),
    topLevel(dashboard, 'aiModelContextLabel'), topLevel(dashboard, 'aiModelThinkingBadge'),
    topLevel(dashboard, 'aiModelModelList'), topLevel(dashboard, 'aiModelRoleOptions'), topLevel(dashboard, 'aiModelRoleRow'),
    'return { list: aiModelModelList, row: aiModelRoleRow, badge: aiModelThinkingBadge, copy: AI_MODEL_THINKING_OFF, levels: AI_MODEL_THINKING_LEVELS };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', source)(state) as {
    list(connection: unknown): string;
    row(status: unknown, roleId: string): string;
    badge(value: unknown): string;
    copy: Record<string, { badge: string; text: string }>;
    levels: string[][];
  };
}

function loadApp() {
  const source = [
    constLine(app, 'CHAT_THINKING_OFF_MODES'), constLine(app, 'CHAT_THINKING_OFF_NOTE'),
    'let chatModelThinkingOff = new Map();',
    topLevel(app, 'chatEffortTitle'), topLevel(app, 'updateChatEffortTitle'), topLevel(app, 'parseChatModelCatalog'),
    `return {
      parse: parseChatModelCatalog,
      title: chatEffortTitle,
      update: updateChatEffortTitle,
      setModes: modes => { chatModelThinkingOff = new Map(Object.entries(modes)); },
    };`,
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(source)() as {
    parse(value: unknown): { models: { key: string; thinkingOff: string; label: string; isDefault: boolean; preview: boolean; group: string }[] } | null;
    title(base: string, mode: unknown): string;
    update(): void;
    setModes(modes: Record<string, string>): void;
  };
}

const claudeConnection = (models: Record<string, unknown>[]) => ({ id: 'anthropic', label: 'Anthropic (Claude)', healthy: true, models });
const row = (key: string, label: string, thinkingOff?: unknown) => ({
  key: `anthropic.${key}`, label, images: true, contextWindow: 1_000_000, ...(thinkingOff === undefined ? {} : { thinkingOff }),
});

describe('model rows on a connection card', () => {
  it('puts a badge with the exact D5 tooltip on an always-on and on a switchable Claude model, and nothing on a native one', () => {
    const { list } = loadDashboard();
    document.body.innerHTML = list(claudeConnection([
      row('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'lowest_effort'),
      row('claude-haiku-5-5', 'Claude Haiku 5.5', 'native_without_tools'),
      row('claude-opus-4-5', 'Claude Opus 4.5', 'native'),
      row('claude-3-haiku', 'Claude Haiku 3', 'unavailable'),
    ]));
    const items = [...document.querySelectorAll('.ai-model-models li')];
    expect(items).toHaveLength(4);
    const badgeOf = (index: number) => items[index].querySelector('.ai-model-thinking');
    expect(badgeOf(0)!.getAttribute('title')).toBe(COPY.lowest_effort);
    expect(badgeOf(0)!.firstChild!.textContent).toBe('Always thinks');
    expect(badgeOf(1)!.getAttribute('title')).toBe(COPY.native_without_tools);
    expect(badgeOf(1)!.firstChild!.textContent).toBe('Thinks in chat');
    expect(badgeOf(2)).toBeNull();
    expect(badgeOf(3)!.getAttribute('title')).toBe(COPY.unavailable);
    expect(badgeOf(3)!.firstChild!.textContent).toBe('No thinking');
    // The model title and its facts are where they were; the badge sits beside the title.
    expect(items[0].querySelector('span')!.firstChild!.textContent).toBe('Claude Sonnet 5.5');
    expect(items[0].querySelector('small:not(.ai-model-thinking)')!.textContent).toBe('Reads images · 1M context');
  });

  it('gives a screen reader the same sentence, and keeps the badge a plain pill (no new control)', () => {
    const { list } = loadDashboard();
    document.body.innerHTML = list(claudeConnection([row('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'lowest_effort')]));
    const badge = document.querySelector('.ai-model-thinking') as HTMLElement;
    expect(badge.tagName).toBe('SMALL');
    expect(badge.classList.contains('pill')).toBe(true);
    expect(badge.querySelector('.visually-hidden')!.textContent).toBe(`. ${COPY.lowest_effort}`);
    expect(badge.textContent).toBe(`Always thinks. ${COPY.lowest_effort}`);
    expect(badge.querySelector('button, a, input, select, [tabindex]')).toBeNull();
    expect(css).toMatch(/\.ai-model-thinking\s*\{/);
  });

  it('renders models of the other providers exactly as before: no badge, the same markup', () => {
    const { list } = loadDashboard();
    const html = list({ id: 'openai', label: 'OpenAI', models: [{ key: 'openai.m1', label: 'Model One', images: true, contextWindow: 128_000 }] });
    expect(html).toBe('<details class="ai-model-models"><summary>1 model available</summary><ul><li><span>Model One</span><small>Reads images · 128K context</small></li></ul></details>');
  });

  it('renders nothing for a value the server never sends, however odd, and never throws', () => {
    const { list, badge } = loadDashboard();
    for (const value of ['', 'native', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'LOWEST_EFFORT', 'x', 42, null, undefined, {}, ['lowest_effort']]) {
      expect(badge(value), String(value)).toBe('');
      expect(list(claudeConnection([row('claude-x', 'Claude X', value as string)])), String(value)).not.toContain('ai-model-thinking');
    }
  });

  it('keeps the exact D5 copy as the single source of the badge text', () => {
    const { copy } = loadDashboard();
    expect(Object.keys(copy)).toEqual(['lowest_effort', 'native_without_tools', 'unavailable']);
    for (const [mode, text] of Object.entries(COPY)) expect(copy[mode].text).toBe(text);
  });
});

describe('role captions', () => {
  const status = (role: Record<string, unknown>) => ({
    connections: [claudeConnection([row('claude-haiku-5-5', 'Claude Haiku 5.5', 'native_without_tools')])],
    roles: { processing: { modelKey: 'anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', connectionId: 'anthropic', connectionLabel: 'Anthropic (Claude)', thinking: 'off', chosen: false, images: true, ...role } },
  });

  it('adds the badge to the caption of a role served by a Claude model, with the exact copy, and leaves the rest of the row alone', () => {
    const { row: roleRow } = loadDashboard();
    for (const [mode, text] of Object.entries(COPY)) {
      document.body.innerHTML = roleRow(status({ thinkingOff: mode }), 'processing');
      const caption = document.querySelector('.ai-model-role-caption') as HTMLElement;
      expect(caption.firstChild!.textContent).toBe('Automatic: using Claude Haiku 5.5 (Anthropic (Claude)).');
      expect(caption.querySelector('.ai-model-thinking')!.getAttribute('title')).toBe(text);
    }
    document.body.innerHTML = roleRow(status({ thinkingOff: 'native' }), 'processing');
    expect(document.querySelector('.ai-model-thinking')).toBeNull();
    expect(document.querySelector('.ai-model-role-caption')!.textContent).toBe('Automatic: using Claude Haiku 5.5 (Anthropic (Claude)).');
  });

  it('shows no badge for a role served by another provider and does not relabel any option', () => {
    const { row: roleRow, levels } = loadDashboard();
    document.body.innerHTML = roleRow(status({ modelKey: 'openai.gpt-5.6-terra', label: 'GPT-5.6 Terra', connectionId: 'openai', connectionLabel: 'OpenAI' }), 'processing');
    expect(document.querySelector('.ai-model-thinking')).toBeNull();
    // Per-option relabeling is out: the Thinking select reads the same for a model that always thinks.
    document.body.innerHTML = roleRow(status({ thinkingOff: 'lowest_effort', thinking: 'low' }), 'processing');
    const options = [...document.querySelectorAll('select[data-ai-model-field="thinking"] option')].map(option => option.textContent);
    expect(options).toEqual(levels.map(([, label]) => `Thinking · ${label}`));
    expect(options).toEqual(['Thinking · Off', 'Thinking · Low', 'Thinking · High', 'Thinking · Max']);
    expect((document.querySelector('select[data-ai-model-field="thinking"] option:checked') as HTMLOptionElement).value).toBe('low');
  });

  it('keeps the image note and the unavailable-choice caption, each followed by the badge', () => {
    const { row: roleRow } = loadDashboard();
    document.body.innerHTML = roleRow(status({ images: false, thinkingOff: 'unavailable', unavailableChoice: 'anthropic.gone' }), 'processing');
    const caption = document.querySelector('.ai-model-role-caption')!;
    expect(caption.firstChild!.textContent).toBe('Your choice is not available right now, so BotBoy is using Claude Haiku 5.5 (Anthropic (Claude)). This model cannot read images, so screenshots and image attachments are not inspected.');
    expect(caption.querySelector('.ai-model-thinking')!.getAttribute('title')).toBe(COPY.unavailable);
  });
});

describe('chat panel: Thinking control tooltip', () => {
  const BASE = 'How much reasoning BotBoy spends before answering. Off answers fastest; Max thinks longest. Document-writing turns always think at max.';
  const NOTE = 'With tools on, Claude may still think briefly at Off.';
  let chat: ReturnType<typeof loadApp>;
  beforeEach(() => {
    document.body.innerHTML = `<select id="chat-model"><option value="team.terra">Terra</option><option value="anthropic.sonnet">Sonnet</option><option value="anthropic.haiku">Haiku</option><option value="anthropic.opus45">Opus 4.5</option><option value="anthropic.old">Old</option></select><select id="chat-effort" title="${BASE}"><option value="off">Thinking · Off</option></select>`;
    chat = loadApp();
    chat.setModes({ 'team.terra': '', 'anthropic.sonnet': 'lowest_effort', 'anthropic.haiku': 'native_without_tools', 'anthropic.opus45': 'native', 'anthropic.old': 'unavailable' });
  });
  const selectModel = (key: string) => { (document.getElementById('chat-model') as HTMLSelectElement).value = key; chat.update(); };
  const effortTitle = () => (document.getElementById('chat-effort') as HTMLElement).title;

  it('adds the exact note for a model that still thinks a little at Off, and only then', () => {
    selectModel('anthropic.sonnet');
    expect(effortTitle()).toBe(`${BASE} ${NOTE}`);
    selectModel('anthropic.haiku');
    expect(effortTitle()).toBe(`${BASE} ${NOTE}`);
    for (const key of ['anthropic.opus45', 'anthropic.old', 'team.terra']) {
      selectModel(key);
      expect(effortTitle(), key).toBe(BASE);
    }
  });

  it('never stacks the note, and goes back to the base text when the model changes or the catalog is empty', () => {
    selectModel('anthropic.sonnet');
    selectModel('anthropic.sonnet');
    selectModel('anthropic.haiku');
    expect(effortTitle()).toBe(`${BASE} ${NOTE}`);
    selectModel('team.terra');
    expect(effortTitle()).toBe(BASE);
    chat.setModes({});
    selectModel('anthropic.sonnet');
    expect(effortTitle()).toBe(BASE);
  });

  it('is harmless when the controls are missing', () => {
    document.body.innerHTML = '';
    expect(() => chat.update()).not.toThrow();
    document.body.innerHTML = `<select id="chat-effort" title="${BASE}"></select>`;
    chat.update();
    expect(effortTitle()).toBe(BASE);
  });

  it('words the note per mode in one pure function', () => {
    expect(chat.title('base', 'lowest_effort')).toBe(`base ${NOTE}`);
    expect(chat.title('base', 'native_without_tools')).toBe(`base ${NOTE}`);
    for (const mode of ['native', 'unavailable', '', undefined, null, 'x']) expect(chat.title('base', mode), String(mode)).toBe('base');
  });

  it('copies thinkingOff from the catalog for the four known words and drops anything else', () => {
    const catalog = chat.parse({
      defaultKey: 'anthropic.sonnet',
      groups: [{ id: 'anthropic', label: 'Anthropic (Claude)' }],
      models: [
        { key: 'anthropic.sonnet', label: 'Claude Sonnet 5.5', isDefault: true, preview: false, group: 'anthropic', thinkingOff: 'lowest_effort' },
        { key: 'anthropic.haiku', label: 'Claude Haiku 5.5', isDefault: false, preview: false, group: 'anthropic', thinkingOff: 'native_without_tools' },
        { key: 'anthropic.opus45', label: 'Claude Opus 4.5', isDefault: false, preview: false, group: 'anthropic', thinkingOff: 'native' },
        { key: 'anthropic.old', label: 'Claude Haiku 3', isDefault: false, preview: false, group: 'anthropic', thinkingOff: 'unavailable' },
        { key: 'anthropic.junk', label: 'Junk', isDefault: false, preview: false, group: 'anthropic', thinkingOff: 'constructor' },
        { key: 'team.terra', label: 'GPT-5.6 Terra', isDefault: false, preview: false },
      ],
    })!;
    expect(catalog.models.map(model => [model.key, model.thinkingOff])).toEqual([
      ['anthropic.sonnet', 'lowest_effort'], ['anthropic.haiku', 'native_without_tools'], ['anthropic.opus45', 'native'],
      ['anthropic.old', 'unavailable'], ['anthropic.junk', ''], ['team.terra', ''],
    ]);
    // The fields that were copied before are unchanged.
    expect(catalog.models[0]).toMatchObject({ label: 'Claude Sonnet 5.5', isDefault: true, preview: false, group: 'anthropic' });
  });
});

describe('wiring in app.js (source seams)', () => {
  it('fills the thinking map from the catalog, resets it when there is no catalog, and refreshes the tooltip on every model change', () => {
    const refresh = app.slice(app.indexOf('async function refreshChatModelCatalog()'), app.indexOf('function initChatModelControl'));
    expect(refresh).toContain('chatModelThinkingOff = new Map(catalog.models.map(model => [model.key, model.thinkingOff]));');
    // Reset in the "nothing set up" branch and in the static fallback; refreshed after every catalog load.
    expect(refresh.match(/chatModelThinkingOff = new Map\(\);/g)).toHaveLength(2);
    expect(refresh.match(/updateChatEffortTitle\(\);/g)).toHaveLength(2);
    const init = app.slice(app.indexOf('function initChatModelControl()'), app.indexOf('// ── AI model readiness'));
    expect(init).toContain('updateChatEffortTitle();');
    // The control itself is not rebuilt or relabeled here: only its tooltip changes.
    expect(app).not.toMatch(/chat-effort[^\n]*\.(textContent|innerHTML|replaceChildren)/);
  });
});

// Slice B review LOW 1: `.ai-model-models li small` (the facts beside a model title) sets --faint, and at specificity
// (0,1,2) it outranks `.pill` (0,1,0), so the thinking badge on a connection-card row rendered at about 3.0:1. One more
// rule gives the badge --muted again. jsdom does not compute styles, so this works out the cascade for `color` from the
// shipped CSS text (top-level rules; at-rule blocks such as media queries are skipped) against the markup dashboard.js
// really renders, inside the ancestors a model row has on the Settings page.
describe('badge text colour on connection-card rows', () => {
  const ROW_RULE = '.ai-model-models li small';
  const BADGE_RULE = '.ai-model-models li small.ai-model-thinking';
  type Rule = { selector: string; body: string; order: number };
  /** Top-level rules of dashboard.css in source order (comments removed, at-rule blocks skipped). */
  const rules = (): Rule[] => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found: Rule[] = [];
    let at = 0;
    while (at < text.length) {
      const open = text.indexOf('{', at);
      if (open < 0) break;
      const prelude = text.slice(at, open).trim();
      let depth = 1;
      let end = open + 1;
      while (end < text.length && depth > 0) {
        if (text[end] === '{') depth += 1;
        else if (text[end] === '}') depth -= 1;
        end += 1;
      }
      if (!prelude.startsWith('@')) found.push({ selector: prelude, body: text.slice(open + 1, end - 1), order: found.length });
      at = end;
    }
    return found;
  };
  /** The declarations of the first rule whose selector is exactly `selector`, without whitespace. */
  const declarations = (selector: string): string | null => {
    const rule = rules().find((entry) => entry.selector === selector);
    return rule ? rule.body.replace(/\s+/g, '') : null;
  };
  /** [ids, classes + attributes + pseudo-classes, elements] of one selector. */
  const specificity = (selector: string): [number, number, number] => {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)(?!not\b|is\b|where\b)[\w-]+/g) ?? []).length;
    const elements = selector.split(/[\s>+~]+/).filter((compound) => /^[a-z]/i.test(compound)).length;
    return [ids, classes, elements];
  };
  /** The `color` that wins for `element`: !important, then specificity, then source order. */
  const cascadedColor = (element: Element): { value: string; selector: string } | null => {
    let best: { key: number[]; value: string; selector: string } | null = null;
    for (const rule of rules()) {
      const declared = rule.body.match(/(?:^|;)\s*color\s*:\s*([^;!]+?)\s*(!important)?\s*(?:;|$)/);
      if (!declared) continue;
      for (const selector of rule.selector.split(/,(?![^(]*\))/).map((part) => part.trim())) {
        let hit = false;
        try { hit = element.matches(selector); } catch { hit = false; }
        if (!hit) continue;
        const key = [declared[2] ? 1 : 0, ...specificity(selector), rule.order];
        const beats = !best || key.some((part, index) => part !== best!.key[index] && key.slice(0, index).every((earlier, k) => earlier === best!.key[k]) && part > best!.key[index]);
        if (beats) best = { key, value: declared[1], selector };
      }
    }
    return best ? { value: best.value, selector: best.selector } : null;
  };
  /** A model row as the Settings page has it: list inside a key card inside the AI model section. */
  const rowOnPage = (thinkingOff: string) => {
    const { list } = loadDashboard();
    document.body.innerHTML = `<main id="workspace"><section class="ai-model-settings"><form class="card mcp-form ai-model-key-form"><div class="mcp-form-body">${list(claudeConnection([row('claude-sonnet-5-5', 'Claude Sonnet 5.5', thinkingOff)]))}</div></form></section></main>`;
    return {
      badge: document.querySelector('.ai-model-models li small.ai-model-thinking')!,
      facts: document.querySelector('.ai-model-models li small:not(.ai-model-thinking)')!,
    };
  };

  it('has a badge rule on --muted beside the row rule that colours the facts', () => {
    expect(declarations(ROW_RULE)).toMatch(/(^|;)color:/);
    expect(declarations(BADGE_RULE)).toBe('color:var(--muted);');
    // --muted is the colour the pill itself defines, so the override restores the badge's own text colour.
    expect(declarations('.pill')).toContain('color:var(--muted);');
  });

  it('the badge rule outranks the row rule', () => {
    expect(specificity(ROW_RULE)).toEqual([0, 1, 2]);
    expect(specificity(BADGE_RULE)).toEqual([0, 2, 2]);
  });

  it('the colour that wins for the badge on a model row is --muted, from the badge rule, and the facts beside it keep the row rule', () => {
    const { badge, facts } = rowOnPage('lowest_effort');
    expect(badge).not.toBeNull();
    expect(badge.matches(BADGE_RULE)).toBe(true);
    expect(cascadedColor(badge)).toEqual({ value: 'var(--muted)', selector: BADGE_RULE });
    expect(facts.matches(BADGE_RULE)).toBe(false);
    expect(cascadedColor(facts)).toMatchObject({ selector: ROW_RULE });
  });

  it('leaves the role-caption badge alone: it sits outside .ai-model-models, so it keeps the pill colour', () => {
    const { row: roleRow } = loadDashboard();
    document.body.innerHTML = roleRow({
      connections: [claudeConnection([row('claude-haiku-5-5', 'Claude Haiku 5.5', 'native_without_tools')])],
      roles: { processing: { modelKey: 'anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', connectionId: 'anthropic', connectionLabel: 'Anthropic (Claude)', thinking: 'off', chosen: false, images: true, thinkingOff: 'native_without_tools' } },
    }, 'processing');
    const badge = document.querySelector('.ai-model-role-caption .ai-model-thinking')!;
    expect(badge).not.toBeNull();
    expect(badge.closest('.ai-model-models')).toBeNull();
    expect(cascadedColor(badge)).toEqual({ value: 'var(--muted)', selector: '.pill' });
  });
});
