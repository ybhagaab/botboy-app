// @vitest-environment jsdom
//
// The setup copy of Settings → AI model (Claude slice C): everywhere BotBoy tells someone with no AI model which
// key to add, it names EVERY provider card (OpenAI, DeepSeek and Anthropic (Claude)). With only a Claude key saved the
// connection is registered, the service reports `ready`, and neither the chat panel's notice nor the Settings page
// asks for another provider's key. The three texts are the chat panel notice (index.html), the Settings intro
// (dashboard.js › renderAiModelSettings) and the `ai_model_not_configured` next action (api/routers/chat.ts).
// Rendered from the shipped source against a small state object, like ai-model-key-card-ui.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const dashboard = read('src/ui/dashboard.js');
const app = read('src/ui/app.js');
const html = read('src/ui/index.html');
const chatRouter = read('src/api/routers/chat.ts');

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
function constBlock(source: string, name: string): string {
  const start = source.indexOf(`\nconst ${name} = [`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n];\n', start);
  return source.slice(start, end + 4);
}

/** "OpenAI, DeepSeek or Anthropic (Claude)", built from the key cards Settings really renders. */
function providerPhrase(): string {
  const labels = (new Function(`${constBlock(dashboard, 'AI_MODEL_KEY_PROVIDERS')}\nreturn AI_MODEL_KEY_PROVIDERS.map(provider => provider.label);`)() as string[]);
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

function loadSettingsPage() {
  const source = [
    constLine(dashboard, 'esc'),
    constBlock(dashboard, 'AI_MODEL_KEY_PROVIDERS'),
    topLevel(dashboard, 'renderAiModelSettings'),
    'return renderAiModelSettings;',
  ].join('\n');
  const noop = () => '';
  const state = { aiModel: { status: null as unknown, error: '', loading: false, saving: false, removing: false, roleError: null } };
  // eslint-disable-next-line no-new-func
  const render = new Function(
    'state', 'icon', 'pageHead', 'loadingView', 'errorView', 'loadAiModelStatus', 'aiModelRoleRow', 'aiModelIssueAlert', 'aiModelModelList', 'aiModelKeyCard',
    source,
  )(state, noop, noop, noop, noop, noop, () => '<div class="role-row"></div>', noop, noop, (_status: unknown, provider: { id: string }) => `<form data-provider="${provider.id}"></form>`) as () => string;
  return { render: (status: unknown) => { state.aiModel.status = status; return render(); } };
}

function loadPanelState() {
  const source = [topLevel(app, 'applyAiModelState'), 'return applyAiModelState;'].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(source)() as (value: string | null) => void;
}

const noticeElement = () => document.getElementById('chat-ai-model-notice') as HTMLElement;

describe('the setup copy names every provider card', () => {
  beforeEach(() => {
    const notice = html.match(/<div id="chat-ai-model-notice"[\s\S]*?<\/div>/);
    expect(notice, 'missing #chat-ai-model-notice').not.toBeNull();
    document.body.innerHTML = `${notice![0]}<select id="chat-model"></select>`;
  });

  it('reads "OpenAI, DeepSeek or Anthropic (Claude)", from the key cards Settings renders', () => {
    expect(providerPhrase()).toBe('OpenAI, DeepSeek or Anthropic (Claude)');
  });

  it('the chat panel notice asks for any of the three keys', () => {
    expect(noticeElement().textContent).toContain(`Add an ${providerPhrase()} API key in Settings to turn on chat and background organizing.`);
    expect(noticeElement().textContent).not.toContain('OpenAI or DeepSeek');
    expect(noticeElement().querySelector('a')!.getAttribute('href')).toBe('#/settings/ai-model');
  });

  it('the Settings page intro for an install with no AI model asks for any of the three keys', () => {
    const page = loadSettingsPage().render({ state: 'not_configured', connections: [] });
    expect(page).toContain('<strong>No AI model yet</strong>');
    expect(page).toContain(`Chat and background organizing are off until you add an ${providerPhrase()} API key below.`);
    expect(page).toContain('<span class="pill">Not set up</span>');
    expect(page).not.toContain('OpenAI or DeepSeek');
    // One key card per provider sits under the intro.
    expect(page.match(/data-provider="/g)).toHaveLength(3);
  });

  it('the 409 next action of a turn on an install with no AI model asks for any of the three keys', () => {
    expect(chatRouter).toContain(`nextAction: 'Open Settings → AI model and paste an ${providerPhrase()} API key. Chat and background organizing start right away.',`);
    expect(chatRouter).not.toContain('paste an OpenAI or DeepSeek');
  });
});

describe('with a Claude key saved nothing asks for another provider\'s key', () => {
  beforeEach(() => {
    const notice = html.match(/<div id="chat-ai-model-notice"[\s\S]*?<\/div>/)!;
    document.body.innerHTML = `${notice[0]}<select id="chat-model"></select>`;
  });

  it('keeps the chat notice hidden and the model picker enabled once the connection is registered (ready), and when it needs attention (unavailable)', () => {
    const apply = loadPanelState();
    apply('not_configured');
    expect(noticeElement().hidden).toBe(false);
    expect((document.getElementById('chat-model') as HTMLSelectElement).disabled).toBe(true);
    for (const value of ['ready', 'unavailable']) {
      apply(value);
      expect(noticeElement().hidden, value).toBe(true);
      expect((document.getElementById('chat-model') as HTMLSelectElement).disabled, value).toBe(false);
    }
  });

  it('renders the Settings page without the "No AI model yet" intro for a Claude-only setup', () => {
    const page = loadSettingsPage().render({
      state: 'ready',
      connections: [{ id: 'anthropic', label: 'Anthropic (Claude)', healthy: true, models: [] }],
      roles: { processing: { modelKey: 'anthropic.claude-haiku-5-5' }, documents: { modelKey: 'anthropic.claude-sonnet-5-5' } },
    });
    expect(page).not.toContain('No AI model yet');
    expect(page).not.toContain('Not set up');
    expect(page).not.toMatch(/add an OpenAI/i);
    expect(page).toContain('class="role-row"');
  });
});
