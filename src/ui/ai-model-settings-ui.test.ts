import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source seams for Settings → AI model (dashboard.js) and the chat panel's
// readiness wiring (app.js). Server behavior is covered by the router,
// settings-service, and chat-gate tests; these pin the SPA contracts that
// keep the key out of browser state and the picker in step with the provider.
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

  it('never keeps the key in browser state and reads it before the busy repaint recreates the field', () => {
    const initial = between(dashboard, '  aiModel: {', '\n');
    expect(initial).not.toMatch(/key/i);

    const save = between(dashboard, 'async function saveAiModelKey(form)', '\nasync function removeAiModelKey');
    const read = save.indexOf('form.elements.apiKey');
    expect(read).toBeGreaterThan(-1);
    expect(save.indexOf('renderRoute(')).toBeGreaterThan(read);
    expect(save).toContain("request('/settings/ai-model/openai', { method: 'PUT', body: { apiKey } })");
    expect(save).not.toMatch(/state\.aiModel\.\w+\s*=\s*apiKey/);
    expect(save).not.toMatch(/localStorage|sessionStorage/);
    // Latest-wins: a status read that began before the change cannot overwrite it.
    expect(save.indexOf('state.aiModel.requestId += 1')).toBeGreaterThan(save.indexOf("method: 'PUT'"));
    expect(save).toContain('announceAiModelChange();');
  });

  it('renders a password field with autofill off, visible errors, and a confirmed remove', () => {
    const render = between(dashboard, 'function renderAiModelSettings()', '\n/** Tell the chat panel');
    expect(render).toContain("mcpField('apiKey', 'OpenAI API key', ''");
    expect(render).toContain("type: 'password'");
    expect(render).toContain("autocomplete: 'off'");
    expect(render).toContain('role="alert"');
    expect(render).toContain('data-action="ai-model-remove"');
    expect(render).toContain('is sent to OpenAI under your account');
    expect(dashboard).toContain("if (event.target?.matches('.ai-model-key-form')) {");
    expect(dashboard).toContain("if (action === 'ai-model-remove') void removeAiModelKey();");

    const remove = between(dashboard, 'async function removeAiModelKey()', '\n}\n');
    expect(remove.indexOf('window.confirm(')).toBeGreaterThan(-1);
    expect(remove.indexOf("request('/settings/ai-model/openai', { method: 'DELETE' })"))
      .toBeGreaterThan(remove.indexOf('window.confirm('));
  });

  it('refreshes an open Settings page from the version poll without reloading the tab', () => {
    const poll = between(dashboard, 'const previousAiModelVersion = state.lastAiModelVersion;', 'void loadAiModelStatus();');
    expect(poll).toContain('state.lastAiModelVersion = payload.aiModelVersion ?? null;');
    expect(poll).toContain('state.lastAiModelState = payload.aiModelState ?? null;');
    const refresh = between(dashboard, '// Another tab (or a provider credential problem) changed the AI model:', 'void loadAiModelStatus();');
    expect(refresh).toContain('!state.aiModel.saving && !state.aiModel.removing');
    expect(refresh).not.toContain('location.reload');
  });

  it('keeps the chat picker and setup notice in step with the active provider', () => {
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
    expect(html).toContain('href="#/settings/ai-model"');
    // Display rules must not override the hidden attribute.
    expect(css).toContain('.chat-ai-model-notice:not([hidden])');
    expect(css).not.toMatch(/\.chat-ai-model-notice\s*\{[^}]*display/);
  });
});
