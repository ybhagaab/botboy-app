// @vitest-environment jsdom
//
// Settings → AI model key cards (dashboard.js), rendered from the shipped source
// against a small state object, like gmail-sync-ui.test.ts. The Anthropic (Claude)
// card (slice A1) checks and stores a key; since slice A2 registers its connection
// it reads that connection like the others: Ready or Needs attention, the model
// list, and a removal that stops chats on its models. The OpenAI and DeepSeek
// cards must read exactly as before.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');

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
function constObject(name: string): string {
  const start = dashboard.indexOf(`\nconst ${name} = {`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  const end = dashboard.indexOf('\n};\n', start);
  return dashboard.slice(start, end + 4);
}
function constBlock(name: string): string {
  const start = dashboard.indexOf(`\nconst ${name} = [`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  const end = dashboard.indexOf('\n];\n', start);
  return dashboard.slice(start, end + 4);
}

interface Harness {
  providers: Record<string, any>[];
  card(status: Record<string, unknown>, providerId: string): string;
  save(form: HTMLFormElement): Promise<void>;
  remove(providerId: string): Promise<void>;
  toasts: [string, string | undefined][];
  confirms: string[];
  requests: { path: string; method?: string; body?: unknown }[];
  announced: number;
}

function load(state: Record<string, any>, answer: (path: string, init: any) => unknown | Promise<unknown>): Harness {
  const toasts: Harness['toasts'] = [];
  const confirms: string[] = [];
  const requests: Harness['requests'] = [];
  const harness = { toasts, confirms, requests, announced: 0 } as Harness;
  const win = { confirm: (message: string) => { confirms.push(message); return true; }, dispatchEvent: () => { harness.announced += 1; return true; } };
  const source = [
    constLine('icon'), constLine('esc'), constLine('attr'),
    topLevel('relativeTime'), topLevel('mcpField'),
    constBlock('AI_MODEL_KEY_PROVIDERS'),
    constObject('AI_MODEL_THINKING_OFF'), topLevel('aiModelThinkingBadge'),
    topLevel('aiModelErrorText'), topLevel('aiModelContextLabel'), topLevel('aiModelIssueAlert'), topLevel('aiModelModelList'),
    topLevel('aiModelKeyCard'), topLevel('announceAiModelChange'), topLevel('saveAiModelKey'), topLevel('removeAiModelKey'),
    `return { providers: AI_MODEL_KEY_PROVIDERS, card: (status, id) => aiModelKeyCard(status, AI_MODEL_KEY_PROVIDERS.find(p => p.id === id)), save: saveAiModelKey, remove: removeAiModelKey };`,
  ].join('\n');
  const request = async (requestPath: string, init: any = {}) => {
    requests.push({ path: requestPath, method: init.method, body: init.body });
    return answer(requestPath, init);
  };
  const toast = (message: string, kind?: string) => { toasts.push([message, kind]); };
  const renderRoute = () => {};
  // eslint-disable-next-line no-new-func
  const built = new Function('state', 'request', 'toast', 'renderRoute', 'window', 'CustomEvent', source)(
    state, request, toast, renderRoute, win, class { constructor(public type: string) {} },
  ) as Pick<Harness, 'providers' | 'card' | 'save' | 'remove'>;
  return Object.assign(harness, built);
}

const SAVED = { keySuffix: '…abcd', savedAt: '2026-10-13T08:00:00.000Z', verifiedAt: new Date().toISOString() };
const baseState = (): Record<string, any> => ({
  aiModel: { status: null, saving: false, removing: false, savingProvider: '', saveError: null, requestId: 0, loading: false, error: '' },
  route: { view: 'ai-model-settings' },
});
const status = (extra: Record<string, unknown> = {}) => ({ connections: [], roles: {}, ...extra });

function formFor(providerId: string, apiKey: string): HTMLFormElement {
  document.body.innerHTML = `<form class="ai-model-key-form" data-provider="${providerId}"><input name="apiKey" value="${apiKey}"></form>`;
  return document.querySelector('form') as HTMLFormElement;
}

describe('Anthropic (Claude) key card', () => {
  let state: Record<string, any>;
  beforeEach(() => {
    state = baseState();
  });

  it('is the third key card, with its own placeholder, help and button, and a password field', () => {
    const harness = load(state, () => null);
    expect(harness.providers.map(provider => provider.id)).toEqual(['openai', 'deepseek', 'anthropic']);
    const html = harness.card(status(), 'anthropic');
    document.body.innerHTML = html;
    const form = document.querySelector('form.ai-model-key-form') as HTMLFormElement;
    expect(form.dataset.provider).toBe('anthropic');
    const input = form.querySelector('input[name="apiKey"]') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.placeholder).toBe('sk-ant-…');
    expect(input.required).toBe(true);
    expect(form.querySelector('h2')!.textContent).toBe('Anthropic (Claude)');
    expect(form.textContent).toContain('platform.claude.com/settings/keys');
    expect(form.textContent).toContain('BotBoy offers every Claude model the key can use, in chat and in Background work.');
    expect(form.textContent).not.toMatch(/not offered|yet/i);
    expect(form.querySelector('button[type="submit"]')!.textContent).toBe('Check and save key');
    // Nothing on an unsaved card claims readiness or models.
    expect(form.textContent).not.toMatch(/Ready|Needs attention|turn on|available/i);
    expect(form.querySelector('[data-action="ai-model-remove"]')).toBeNull();
    expect(form.querySelector('.ai-model-models')).toBeNull();
    expect(form.textContent).toContain('is sent to Anthropic (Claude) under your account');
  });

  const claude = (extra: Record<string, unknown> = {}) => ({
    id: 'anthropic', label: 'Anthropic (Claude)', healthy: true,
    models: [
      { key: 'anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', images: true, contextWindow: 1_000_000 },
      { key: 'anthropic.claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', images: true, contextWindow: 200_000 },
    ],
    ...extra,
  });

  it('shows the key suffix, verified time, Ready, and the Claude models once its connection exists', () => {
    const harness = load(state, () => null);
    document.body.innerHTML = harness.card(status({ anthropic: SAVED, connections: [claude()] }), 'anthropic');
    const form = document.querySelector('form') as HTMLFormElement;
    expect(form.querySelector('.card-meta')!.textContent).toContain('Key …abcd');
    expect(form.querySelector('.card-meta')!.textContent).toMatch(/verified (just now|\d+ ?(s|m|min|minute)|a few)/i);
    const pill = form.querySelector('.pill')!;
    expect(pill.textContent).toBe('Ready');
    expect(pill.classList.contains('good')).toBe(true);
    expect(form.querySelector('.ai-model-models summary')!.textContent).toBe('2 models available');
    expect(form.querySelector('.ai-model-models')!.textContent).toContain('Claude Sonnet 5.5');
    expect(form.querySelector('.ai-model-models')!.textContent).toContain('1M context');
    expect(form.querySelector('.ai-model-models')!.textContent).toContain('200K context');
    expect(form.textContent).not.toMatch(/not offered|stored it privately|Key checked/);
    expect(form.querySelector('[data-action="ai-model-remove"][data-provider="anthropic"]')!.textContent).toBe('Remove key');
    expect(form.querySelector('button[type="submit"]')!.textContent).toBe('Replace key');
  });

  it('says Needs attention, with the issue and its next action, when the connection is unhealthy or reports one', () => {
    const harness = load(state, () => null);
    document.body.innerHTML = harness.card(status({ anthropic: SAVED, connections: [claude({ healthy: false })] }), 'anthropic');
    expect(document.querySelector('.pill')!.textContent).toBe('Needs attention');
    expect(document.querySelector('.pill')!.classList.contains('warn')).toBe(true);
    const issue = { code: 'auth_rejected', message: 'Anthropic rejected the saved API key.', nextAction: 'Create or copy a current key at platform.claude.com/settings/keys and save it here again.', at: '2026-10-13T00:00:00.000Z' };
    document.body.innerHTML = harness.card(status({ anthropic: SAVED, connections: [claude({ issue })] }), 'anthropic');
    expect(document.querySelector('.pill')!.textContent).toBe('Needs attention');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Anthropic rejected the saved API key.');
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('platform.claude.com/settings/keys');
    // A saved key without a connection (a list that yielded no model) is not "Ready" either.
    document.body.innerHTML = harness.card(status({ anthropic: SAVED }), 'anthropic');
    expect(document.querySelector('.pill')!.textContent).toBe('Needs attention');
    expect(document.querySelector('.ai-model-models')).toBeNull();
  });

  it('shows a wrong-shape key error with its next action, only on this card', () => {
    state.aiModel.saveError = {
      provider: 'anthropic',
      message: 'That does not look like an Anthropic API key.',
      nextAction: 'Paste the full key from platform.claude.com/settings/keys. It starts with "sk-ant-".',
    };
    const harness = load(state, () => null);
    document.body.innerHTML = harness.card(status(), 'anthropic');
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('That does not look like an Anthropic API key.');
    expect(alert.textContent).toContain('Paste the full key from platform.claude.com/settings/keys');
    document.body.innerHTML = harness.card(status(), 'openai');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('disables the controls while a save is running and labels the busy card', () => {
    state.aiModel.saving = true;
    state.aiModel.savingProvider = 'anthropic';
    const harness = load(state, () => null);
    document.body.innerHTML = harness.card(status(), 'anthropic');
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('button[type="submit"]')!.textContent).toBe('Checking key…');
    document.body.innerHTML = harness.card(status(), 'openai');
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('button[type="submit"]')!.textContent).toBe('Save and turn on');
  });

  it('saves through the same route, announces the change, and toasts that the models are ready in chat and Background work', async () => {
    const harness = load(state, () => status({ anthropic: SAVED, connections: [claude()] }));
    await harness.save(formFor('anthropic', 'typed-key-value'));
    expect(harness.requests).toEqual([{ path: '/settings/ai-model/anthropic', method: 'PUT', body: { apiKey: 'typed-key-value' } }]);
    expect(harness.toasts).toEqual([['Anthropic (Claude) key checked and saved. Its models are ready in chat and in Background work.', undefined]]);
    expect(state.aiModel.status.anthropic.keySuffix).toBe('…abcd');
    expect(harness.announced).toBe(1);
    expect(JSON.stringify(state)).not.toContain('typed-key-value');
  });

  it('keeps the server error and next action on a failed save, with its own failure toast, and no key in state', async () => {
    const failure = Object.assign(new Error('HTTP 400'), {
      payload: { error: 'Anthropic rejected this API key. It may be expired, revoked or malformed.' },
      nextAction: 'Copy a current key from platform.claude.com/settings/keys and try again.',
    });
    const harness = load(state, () => { throw failure; });
    await harness.save(formFor('anthropic', 'typed-key-value'));
    expect(state.aiModel.saveError).toEqual({
      provider: 'anthropic',
      message: 'Anthropic rejected this API key. It may be expired, revoked or malformed.',
      nextAction: 'Copy a current key from platform.claude.com/settings/keys and try again.',
    });
    expect(harness.toasts).toEqual([['Could not save the Anthropic (Claude) key', 'bad']]);
    expect(JSON.stringify(state)).not.toContain('typed-key-value');
  });

  it('confirms removal with the same wording as the other providers: chats on its models stop, background work moves', async () => {
    state.aiModel.status = status({ anthropic: SAVED, connections: [claude()] });
    const harness = load(state, () => status());
    await harness.remove('anthropic');
    expect(harness.confirms).toHaveLength(1);
    expect(harness.confirms[0]).toBe('Remove the saved Anthropic (Claude) key (…abcd)?\n\nChats on its models stop, and background work moves to another connected model.');
    expect(harness.requests).toEqual([{ path: '/settings/ai-model/anthropic', method: 'DELETE', body: undefined }]);
    expect(harness.toasts).toEqual([['Anthropic (Claude) key removed', undefined]]);
    expect(state.aiModel.status.anthropic).toBeUndefined();
  });

  it('does nothing on remove when no Anthropic key is saved', async () => {
    state.aiModel.status = status();
    const harness = load(state, () => status());
    await harness.remove('anthropic');
    expect(harness.confirms).toEqual([]);
    expect(harness.requests).toEqual([]);
  });
});

describe('OpenAI and DeepSeek key cards are unchanged', () => {
  const connection = (id: string, extra: Record<string, unknown> = {}) => ({
    id, label: id === 'openai' ? 'OpenAI' : 'DeepSeek', healthy: true, models: [{ key: `${id}.m1`, label: 'Model One', images: true, contextWindow: 128_000 }], ...extra,
  });

  it('keep their placeholder, help, button and the Ready / Needs attention pills', () => {
    const harness = load(baseState(), () => null);
    document.body.innerHTML = harness.card(status(), 'openai');
    expect((document.querySelector('input[name="apiKey"]') as HTMLInputElement).placeholder).toBe('sk-…');
    expect(document.querySelector('form')!.textContent).toContain('and offers its models right away');
    expect(document.querySelector('button[type="submit"]')!.textContent).toBe('Save and turn on');

    document.body.innerHTML = harness.card(status({ openai: SAVED, connections: [connection('openai')] }), 'openai');
    expect(document.querySelector('.pill')!.textContent).toBe('Ready');
    expect(document.querySelector('.pill')!.classList.contains('good')).toBe(true);
    expect(document.querySelector('.ai-model-models summary')!.textContent).toBe('1 model available');
    expect(document.querySelector('form')!.textContent).not.toContain('not offered');

    document.body.innerHTML = harness.card(status({ deepseek: SAVED, connections: [connection('deepseek', { healthy: false })] }), 'deepseek');
    expect(document.querySelector('.pill')!.textContent).toBe('Needs attention');
    expect(document.querySelector('.pill')!.classList.contains('warn')).toBe(true);
  });

  it('keep their toast and removal wording', async () => {
    const state = baseState();
    state.aiModel.status = status({ openai: SAVED });
    const harness = load(state, () => status({ openai: SAVED, connections: [connection('openai')] }));
    await harness.save(formFor('openai', 'sk-typed-openai-key-0000'));
    expect(harness.toasts[0]).toEqual(['OpenAI is on. Its models are ready in chat and in Background work.', undefined]);
    await harness.remove('openai');
    expect(harness.confirms[0]).toBe('Remove the saved OpenAI key (…abcd)?\n\nChats on its models stop, and background work moves to another connected model.');
  });
});
