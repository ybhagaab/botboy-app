// @vitest-environment jsdom
//
// Connections → Add/Edit MCP server (dashboard.js, MCP_REMOTE_TRANSPORTS_PLAN.md
// MR1): local and remote definitions in one form, secret values shown only as
// the keep-mask, and the definition sent back in the API's input shape. The
// helpers are evaluated straight from the shipped source, like
// gmail-sync-ui.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEEP_SECRET_MASK, normalizeCustomServerInput, parseCustomConfig } from '../core/mcp-custom-config.js';

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

type Helpers = { renderMcpServerForm(options?: { editing?: boolean; profileId?: string }): string; collectMcpServerForm(): Record<string, unknown> };

function load(state: Record<string, unknown>): Helpers {
  const source = [
    constLine('icon'), constLine('esc'), constLine('attr'), constLine('MCP_KEEP_SECRET_MASK'),
    topLevel('pageHead'), topLevel('loadingView'), topLevel('errorView'),
    topLevel('mcpEntryLine'), topLevel('collectMcpServerForm'), topLevel('renderMcpServerForm'),
    'function loadCustomServerConfig() {}',
    'return { renderMcpServerForm, collectMcpServerForm };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', source)(state) as Helpers;
}

const REMOTE_VIEW = {
  id: 'custom-docs', name: 'Docs', transport: 'auto', command: '', args: [], url: 'https://docs.example.com/mcp',
  env: [],
  headers: [
    { name: 'Authorization', secret: true, required: true, saved: true, template: 'Bearer {value}' },
    { name: 'X-Region', secret: false, required: false, saved: true, value: 'eu' },
    { name: 'X-Api-Key', secret: true, required: true, saved: false },
  ],
  about: {}, origin: 'assistant', reviewed: true, missingValues: ['header X-Api-Key'],
};

function mount(html: string): HTMLFormElement {
  document.body.innerHTML = html;
  return document.getElementById('mcp-server-form') as HTMLFormElement;
}

describe('MCP server form', () => {
  it('edits a remote server: secrets show only the keep-mask, and saving keeps them', () => {
    const state = { route: { view: 'mcp-edit' }, mcp: { serverForm: { config: REMOTE_VIEW, saving: false, error: '', loadingConfig: false } } };
    const helpers = load(state);
    const form = mount(helpers.renderMcpServerForm({ editing: true, profileId: 'custom-docs' }));
    expect((form.elements.namedItem('kind') as HTMLSelectElement).value).toBe('remote');
    expect(form.querySelector('[data-mcp-kind-section="local"]')!.hasAttribute('hidden')).toBe(true);
    expect(form.querySelector('[data-mcp-kind-section="remote"]')!.hasAttribute('hidden')).toBe(false);
    expect((form.elements.namedItem('headers') as HTMLTextAreaElement).value)
      .toBe(`Authorization: ${KEEP_SECRET_MASK}\nX-Region: eu\nX-Api-Key: `);
    expect((form.elements.namedItem('secret') as HTMLInputElement).value).toBe('Authorization, X-Api-Key');

    const payload = helpers.collectMcpServerForm();
    expect(payload).toEqual({
      name: 'Docs',
      secret: ['Authorization', 'X-Api-Key'],
      url: 'https://docs.example.com/mcp',
      transport: 'auto',
      headers: { Authorization: KEEP_SECRET_MASK, 'X-Region': 'eu', 'X-Api-Key': '' },
    });
    // The stored definition keeps the saved key and its template.
    const previous = parseCustomConfig(JSON.stringify({
      version: 2, transport: 'auto', command: '', args: [], url: 'https://docs.example.com/mcp', env: [],
      headers: [
        { name: 'Authorization', secret: true, hasValue: true, required: true, template: 'Bearer {value}' },
        { name: 'X-Region', secret: false, hasValue: true, required: false },
        { name: 'X-Api-Key', secret: true, hasValue: false, required: true },
      ],
      about: {}, origin: 'assistant', reviewed: true,
    }));
    const normalized = normalizeCustomServerInput(payload, { origin: 'user', previous, previousName: 'Docs' });
    expect(normalized.headers[0]).toMatchObject({ name: 'Authorization', hasValue: true, template: 'Bearer {value}' });
    expect([...normalized.values.keys()]).toEqual(['header-X-Region']);
  });

  it('adds a local server with arguments and environment lines, and rejects a malformed line', () => {
    const state = { route: { view: 'mcp-add' }, mcp: { serverForm: { config: null, saving: false, error: '', loadingConfig: false } } };
    const helpers = load(state);
    const form = mount(helpers.renderMcpServerForm());
    expect((form.elements.namedItem('kind') as HTMLSelectElement).value).toBe('local');
    (form.elements.namedItem('name') as HTMLInputElement).value = 'Brave';
    (form.elements.namedItem('command') as HTMLInputElement).value = 'npx';
    (form.elements.namedItem('args') as HTMLTextAreaElement).value = '-y\n@brave/brave-search-mcp-server@2.1.3\n';
    (form.elements.namedItem('env') as HTMLTextAreaElement).value = 'BRAVE_API_KEY=typed-by-owner\nLOG=info';
    expect(helpers.collectMcpServerForm()).toEqual({
      name: 'Brave', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'], env: { BRAVE_API_KEY: 'typed-by-owner', LOG: 'info' },
    });
    (form.elements.namedItem('env') as HTMLTextAreaElement).value = 'not a pair';
    expect(() => helpers.collectMcpServerForm()).toThrow('Environment lines use NAME=value. Fix: "not a pair"');
    (form.elements.namedItem('kind') as HTMLSelectElement).value = 'remote';
    (form.elements.namedItem('url') as HTMLInputElement).value = 'https://mcp.example.com/mcp';
    (form.elements.namedItem('headers') as HTMLTextAreaElement).value = 'no separator';
    expect(() => helpers.collectMcpServerForm()).toThrow('Header lines use Name: value. Fix: "no separator"');
  });

  it('shows the connection page definition with write-only fields and never a secret value', () => {
    const view = {
      ...REMOTE_VIEW,
      about: { publisher: 'example.com', source: 'registry:com.example/docs@1.0.0', website: 'javascript:alert(1)' },
      headers: [...REMOTE_VIEW.headers, { name: 'X-Note', secret: false, required: false, saved: true, value: '<img src=x onerror=alert(1)>' }],
    };
    const state = { route: { view: 'profile-settings', profileId: 'custom-docs' }, mcp: { customDefinitions: { 'custom-docs': { config: view } } } };
    const source = [
      constLine('icon'), constLine('esc'), constLine('attr'),
      topLevel('mcpTransportLabel'), topLevel('renderCustomDefinitionSection'),
      'function loadCustomDefinition() { throw new Error("should not reload a loaded definition"); }',
      'return { renderCustomDefinitionSection };',
    ].join('\n');
    // eslint-disable-next-line no-new-func
    const { renderCustomDefinitionSection } = new Function('state', source)(state) as { renderCustomDefinitionSection(id: string): string };
    document.body.innerHTML = renderCustomDefinitionSection('custom-docs');
    const facts = [...document.querySelectorAll('.mcp-fact')].map(fact => fact.textContent);
    expect(facts).toEqual([
      'RunsRemote, Streamable HTTP first, then SSE',
      'Addresshttps://docs.example.com/mcp',
      'Published byexample.com',
      'Found inregistry:com.example/docs@1.0.0',
      'Added byBotBoy, on your request',
    ]);
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    const fields = [...document.querySelectorAll('input[data-mcp-def-value]')] as HTMLInputElement[];
    expect(fields.map(input => [input.type, input.dataset.kind, input.dataset.name, input.value])).toEqual([
      ['password', 'header', 'Authorization', ''],
      ['password', 'header', 'X-Api-Key', ''],
    ]);
    expect(fields[0].placeholder).toBe('Type to replace the saved value');
    expect(fields[1].getAttribute('aria-label')).toBe('Value for X-Api-Key header');
    const rows = [...document.querySelectorAll('.mcp-def-value small')].map(row => row.textContent);
    expect(rows).toEqual(['Saved in Keychain · secret', '= eu', 'Needed · secret', '= <img src=x onerror=alert(1)>']);
    expect(document.querySelector('[data-action="mcp-custom-values-save"]')).not.toBeNull();
  });
});
