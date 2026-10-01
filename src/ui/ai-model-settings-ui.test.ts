import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source seams for Settings → AI model (dashboard.js) and the chat panel's
// model picker and readiness wiring (app.js). Server behavior is covered by
// the router, settings-service, and chat tests; these pin the SPA contracts
// that keep keys out of browser state, show every connection's models, and
// keep the picker in step with Settings.
const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('Settings → AI model SPA seams', () => {
  it('routes, links, loads, and renders the page inside the existing Settings shell', () => {
    expect(dashboard).toContain("if (parts[0] === 'settings' && parts[1] === 'ai-model') return { view: 'ai-model-settings' };");
    expect(dashboard).toContain("['publisher-settings', 'llm-usage-settings', 'ai-model-settings'].includes(route.view)");
    expect(dashboard).toContain('<a class="button ghost" href="#/settings/ai-model">');
    expect(dashboard).toContain("if (routeChanged && state.route.view === 'ai-model-settings') void loadAiModelStatus();");
    expect(dashboard).toContain("if (state.route.view === 'ai-model-settings') html = renderAiModelSettings();");
  });

  it('never keeps a key in browser state and reads it before the busy repaint recreates the field', () => {
    const initial = between(dashboard, '  aiModel: {', '\n');
    expect(initial).not.toMatch(/apiKey|key:/i);

    const save = between(dashboard, 'async function saveAiModelKey(form)', '\nasync function removeAiModelKey');
    const read = save.indexOf('form.elements.apiKey');
    expect(read).toBeGreaterThan(-1);
    expect(save.indexOf('renderRoute(')).toBeGreaterThan(read);
    expect(save).toContain("request(`/settings/ai-model/${provider.id}`, { method: 'PUT', body: { apiKey } })");
    expect(save).toContain('AI_MODEL_KEY_PROVIDERS.find(entry => entry.id === form.dataset.provider)');
    expect(save).not.toMatch(/state\.aiModel\.\w+\s*=\s*apiKey/);
    expect(save).not.toMatch(/localStorage|sessionStorage/);
    // Latest-wins: a status read that began before the change cannot overwrite it.
    expect(save.indexOf('state.aiModel.requestId += 1')).toBeGreaterThan(save.indexOf("method: 'PUT'"));
    expect(save).toContain('announceAiModelChange();');
  });

  it('renders an OpenAI and a DeepSeek key form with password fields, visible errors, and confirmed removal', () => {
    expect(dashboard).toContain("id: 'openai',");
    expect(dashboard).toContain("id: 'deepseek',");
    const card = between(dashboard, 'function aiModelKeyCard(status, provider)', '\nfunction renderAiModelSettings()');
    expect(card).toContain("mcpField('apiKey', `${provider.label} API key`, ''");
    expect(card).toContain("type: 'password'");
    expect(card).toContain("autocomplete: 'off'");
    expect(card).toContain('role="alert"');
    expect(card).toContain('data-action="ai-model-remove" data-provider="${provider.id}"');
    expect(card).toContain('class="card mcp-form ai-model-key-form" data-provider="${provider.id}"');
    expect(card).toContain('is sent to ${esc(provider.label)} under your account');
    expect(dashboard).toContain("if (event.target?.matches('.ai-model-key-form')) {");
    expect(dashboard).toContain("if (action === 'ai-model-remove') void removeAiModelKey(target.dataset.provider);");

    const remove = between(dashboard, 'async function removeAiModelKey(providerId)', '\n}\n');
    expect(remove.indexOf('window.confirm(')).toBeGreaterThan(-1);
    expect(remove.indexOf("request(`/settings/ai-model/${provider.id}`, { method: 'DELETE' })"))
      .toBeGreaterThan(remove.indexOf('window.confirm('));
  });

  it('chooses the organizing and document-writing models and Thinking levels right away', () => {
    const row = between(dashboard, 'function aiModelRoleRow(status, roleId)', '\nfunction aiModelKeyCard');
    expect(row).toContain('data-ai-model-role="${roleId}" data-ai-model-field="modelKey"');
    expect(row).toContain('data-ai-model-role="${roleId}" data-ai-model-field="thinking"');
    const options = between(dashboard, 'function aiModelRoleOptions(connections, role)', '\nfunction aiModelRoleRow');
    // One tree: provider headings over plain model titles, plus Automatic.
    expect(options).toContain('<optgroup label="${attr(connection.label)}">');
    expect(options).toContain('<option value="" ${chosenKey ? \'\' : \'selected\'}>Automatic</option>');
    expect(dashboard).toContain("if (event.target?.matches?.('[data-ai-model-role]')) {");
    const save = between(dashboard, 'async function saveAiModelRole(select)', '\n}\n');
    expect(save).toContain("request(`/settings/ai-model/roles/${role}`, { method: 'PUT', body })");
    expect(save).toContain("{ modelKey: select.value || null }");
    expect(save).toContain('announceAiModelChange();');
  });

  it('refreshes an open Settings page from the version poll without reloading the tab', () => {
    const poll = between(dashboard, 'const previousAiModelVersion = state.lastAiModelVersion;', 'void loadAiModelStatus();');
    expect(poll).toContain('state.lastAiModelVersion = payload.aiModelVersion ?? null;');
    expect(poll).toContain('state.lastAiModelState = payload.aiModelState ?? null;');
    const refresh = between(dashboard, '// Another tab (or a provider credential problem) changed the AI model:', 'void loadAiModelStatus();');
    expect(refresh).toContain('!state.aiModel.saving && !state.aiModel.removing');
    expect(refresh).not.toContain('location.reload');
  });

  it('groups the chat picker by provider without provider text in model titles', () => {
    const catalog = between(app, 'async function refreshChatModelCatalog()', '\nfunction initChatModelControl');
    expect(catalog).toContain("document.createElement('optgroup')");
    expect(catalog).toContain('catalog.groups.length > 1');
    const option = between(app, 'function chatModelOption(model)', '\n}\n');
    expect(option).toContain('`Model · ${model.label}');
    expect(option).not.toMatch(/group|provider/i);
    // Provider-qualified keys (fine-tune ids carry colons) and legacy keys.
    expect(app).toContain('/^[A-Za-z0-9._:-]{1,200}$/');
    expect(app).toContain('const legacy = `team.${stored}`;');
    expect(app).toContain('updateChatModelTitle(select);');
  });

  it('keeps the chat picker and setup notice in step with Settings', () => {
    expect(app).toContain('observeAiModel(versionPayload);');
    expect(app).toContain('initAiModelReadiness();');
    expect(app).toContain("window.addEventListener('botboy:ai-model-changed'");
    expect(dashboard).toContain("window.dispatchEvent(new CustomEvent('botboy:ai-model-changed'))");
    expect(app).toContain('if (resp.status === 409) void refreshAiModelReadiness();');

    const observe = between(app, 'function observeAiModel(payload)', '\nasync function refreshAiModelReadiness');
    // The first observation only seeds the counter; a change refreshes the catalog.
    expect(observe).toContain('lastAiModelVersion !== null && version !== lastAiModelVersion');
    expect(observe).toContain('void refreshChatModelCatalog();');
    const apply = between(app, 'function applyAiModelState(value)', '\nfunction observeAiModel');
    expect(apply).toContain("value === 'not_configured'");
    expect(apply).toContain('notice.hidden = !notConfigured');
    const catalog = between(app, 'async function refreshChatModelCatalog()', '\nfunction initChatModelControl');
    expect(catalog).toContain('requestId !== chatModelCatalogRequest');

    expect(html).toMatch(/<div id="chat-ai-model-notice"[^>]*role="status"[^>]*hidden>/);
    expect(html).toContain('Add an OpenAI or DeepSeek API key in Settings');
    expect(html).toContain('href="#/settings/ai-model"');
    // Display rules must not override the hidden attribute.
    expect(css).toContain('.chat-ai-model-notice:not([hidden])');
    expect(css).not.toMatch(/\.chat-ai-model-notice\s*\{[^}]*display/);
  });
});
