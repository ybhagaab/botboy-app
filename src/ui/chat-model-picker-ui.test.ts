// @vitest-environment jsdom
//
// The chat model picker with every kind of connection (Claude slice C, Gate C step 1): the team gateway, an OpenAI key and
// an Anthropic (Claude) key give THREE provider groups, in that order, each holding only its own models under plain
// titles; removing the Claude key drops its group, and a lone Claude connection renders a plain list. Rendered by the
// shipped `refreshChatModelCatalog` of app.js against a catalog of the shape `GET /api/chat/models` serves. The service
// side (what the groups are, in which order) is `ai-model-settings.test.ts › three picker groups`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');

/** app.js from the picker constants through the end of `refreshChatModelCatalog`, evaluated against a stub `api`. */
function loadPicker(catalogs: unknown[]) {
  const start = app.indexOf("const CHAT_MODEL_KEY = 'botboy.chat.model';");
  expect(start, 'missing the picker section').toBeGreaterThanOrEqual(0);
  const fn = app.indexOf('async function refreshChatModelCatalog()');
  const end = app.indexOf('\n}\n', fn) + 2;
  expect(fn).toBeGreaterThan(start);
  const source = `${app.slice(start, end)}\nreturn { refresh: refreshChatModelCatalog, update: updateChatModelTitle };`;
  const queue = [...catalogs];
  const stored = new Map<string, string>();
  const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
  const api = async (apiPath: string) => {
    expect(apiPath).toBe('/chat/models');
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  // eslint-disable-next-line no-new-func
  return new Function('api', 'localStorage', 'Option', source)(api, localStorage, Option) as { refresh(): Promise<void>; update(select: HTMLSelectElement): void };
}

const model = (key: string, label: string, group: string, extra: Record<string, unknown> = {}) => ({ key, label, group, isDefault: false, preview: false, ...extra });
const TEAM = { id: 'team', label: 'Team gateway' };
const OPENAI = { id: 'openai', label: 'OpenAI' };
const CLAUDE = { id: 'anthropic', label: 'Anthropic (Claude)' };
const teamModels = [model('team.terra', 'GPT-5.6 Terra', 'team', { isDefault: true }), model('team.luna', 'GPT-5.6 Luna', 'team')];
const openAiModels = [model('openai.gpt-5.6-terra', 'gpt-5.6-terra', 'openai'), model('openai.gpt-4o', 'gpt-4o', 'openai')];
const claudeModels = [
  model('anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5', 'anthropic', { thinkingOff: 'lowest_effort' }),
  model('anthropic.claude-haiku-5-5', 'Claude Haiku 5.5', 'anthropic', { thinkingOff: 'native_without_tools' }),
];
const catalog = (groups: unknown[], models: unknown[], defaultKey: string) => ({ defaultKey, groups, models, configured: true });

const groupsOf = () => [...document.querySelectorAll<HTMLOptGroupElement>('#chat-model optgroup')];
const labelsIn = (group: HTMLOptGroupElement) => [...group.querySelectorAll('option')].map((option) => option.textContent);

describe('the chat model picker groups', () => {
  beforeEach(() => {
    document.body.innerHTML = '<select id="chat-model"></select><select id="chat-effort" title="base"><option value="off">Off</option></select>';
  });

  it('shows three groups, Team gateway, OpenAI and Anthropic (Claude), each with only its own models under plain titles', async () => {
    const picker = loadPicker([catalog([TEAM, OPENAI, CLAUDE], [...teamModels, ...openAiModels, ...claudeModels], 'team.terra')]);
    await picker.refresh();
    expect(groupsOf().map((group) => group.label)).toEqual(['Team gateway', 'OpenAI', 'Anthropic (Claude)']);
    expect(groupsOf().map(labelsIn)).toEqual([
      ['Model · GPT-5.6 Terra (default)', 'Model · GPT-5.6 Luna'],
      ['Model · gpt-5.6-terra', 'Model · gpt-4o'],
      ['Model · Claude Sonnet 5.5', 'Model · Claude Haiku 5.5'],
    ]);
    // Titles carry no provider text; the group heading does that.
    for (const option of document.querySelectorAll('#chat-model option')) expect(option.textContent).not.toMatch(/Anthropic|OpenAI|Team gateway/);
    expect(document.querySelectorAll('#chat-model > option')).toHaveLength(0);
    const select = document.getElementById('chat-model') as HTMLSelectElement;
    expect(select.value).toBe('team.terra');
    expect(select.disabled).toBe(false);
  });

  it('names the provider of the current choice in the picker tooltip, and the thinking tooltip follows a Claude choice', async () => {
    const picker = loadPicker([catalog([TEAM, OPENAI, CLAUDE], [...teamModels, ...openAiModels, ...claudeModels], 'team.terra')]);
    await picker.refresh();
    const select = document.getElementById('chat-model') as HTMLSelectElement;
    expect(select.title).toBe('Which model answers this chat. Background work uses the models chosen in Settings → AI model. Current: Team gateway.');
    select.value = 'anthropic.claude-sonnet-5-5';
    picker.update(select);
    expect(select.title).toContain('Current: Anthropic (Claude).');
    select.value = 'openai.gpt-4o';
    picker.update(select);
    expect(select.title).toContain('Current: OpenAI.');
  });

  it('drops the Claude group when its key is removed, keeps the other two, and brings it back when the key is saved again', async () => {
    const all = catalog([TEAM, OPENAI, CLAUDE], [...teamModels, ...openAiModels, ...claudeModels], 'team.terra');
    const without = catalog([TEAM, OPENAI], [...teamModels, ...openAiModels], 'team.terra');
    // One picker, three answers of /chat/models in a row, as the version poll would trigger them.
    const picker = loadPicker([all, without, all]);
    await picker.refresh();
    expect(groupsOf().map((group) => group.label)).toEqual(['Team gateway', 'OpenAI', 'Anthropic (Claude)']);
    await picker.refresh();
    expect(groupsOf().map((group) => group.label)).toEqual(['Team gateway', 'OpenAI']);
    expect(document.querySelector('#chat-model option[value^="anthropic."]')).toBeNull();
    await picker.refresh();
    expect(groupsOf().map((group) => group.label)).toEqual(['Team gateway', 'OpenAI', 'Anthropic (Claude)']);
    expect(labelsIn(groupsOf()[2])).toEqual(['Model · Claude Sonnet 5.5', 'Model · Claude Haiku 5.5']);
  });

  it('renders a lone Claude connection as a plain list (headings appear only with more than one group)', async () => {
    const picker = loadPicker([catalog([CLAUDE], claudeModels, 'anthropic.claude-sonnet-5-5')]);
    await picker.refresh();
    expect(groupsOf()).toHaveLength(0);
    expect([...document.querySelectorAll('#chat-model > option')].map((option) => option.textContent)).toEqual(['Model · Claude Sonnet 5.5', 'Model · Claude Haiku 5.5']);
    expect((document.getElementById('chat-model') as HTMLSelectElement).value).toBe('anthropic.claude-sonnet-5-5');
  });
});
