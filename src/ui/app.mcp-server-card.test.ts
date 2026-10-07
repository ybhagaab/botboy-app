// @vitest-environment jsdom
//
// Chat MCP server cards (app.js, MCP_REMOTE_TRANSPORTS_PLAN.md MR1). The card
// helpers and their delegated click listener are evaluated straight from the
// shipped source against a stub api(), like app.gmail-draft-card.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');

function topLevel(name: string): string {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = app.indexOf('\n}\n', start);
  return app.slice(start, end + 2);
}

function constLine(name: string): string {
  const match = app.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}

function cardClickListener(): string {
  const start = app.indexOf("document.addEventListener('click', async (event) => {\n  const button = event.target.closest('[data-mcp-card-action]');");
  expect(start, 'missing the MCP card click listener').toBeGreaterThanOrEqual(0);
  return app.slice(start, app.indexOf('\n});\n', start) + 4);
}

type ApiCall = { path: string; options?: { method?: string; body?: unknown } };
const holder: { api: (path: string, options?: ApiCall['options']) => Promise<any> } = { api: async () => ({}) };
let hydrateChatCards: (root: Element) => void;
let calls: ApiCall[];

const PROFILE = {
  id: 'custom-docs', kind: 'custom', displayName: 'Docs <b>Search</b>', enabled: false, state: 'stopped', needsReview: true,
  tools: [], lastError: null, custom: true, customDefinition: { transport: 'auto', endpointHost: 'docs.example.com', about: {}, missingValues: ['header Authorization'] },
};
const CONFIG = {
  id: 'custom-docs', name: 'Docs <b>Search</b>', transport: 'auto', command: '', args: [], url: 'https://docs.example.com/mcp',
  env: [],
  headers: [
    { name: 'Authorization', secret: true, required: true, saved: false, template: 'Bearer {value}' },
    { name: 'X-Region', secret: false, required: false, saved: true, value: 'eu' },
  ],
  about: { publisher: 'example.com', description: 'Search <img src=x onerror=alert(1)> the docs', source: 'registry:com.example/docs@1.0.0', website: 'javascript:alert(1)' },
  origin: 'assistant', reviewed: false, missingValues: ['header Authorization'],
};

beforeAll(() => {
  const source = [
    constLine('LESSON_MARKER_RE'), constLine('GMAIL_DRAFT_MARKER_RE'), constLine('MCP_SERVER_MARKER_RE'),
    topLevel('hydrateChatCards'), topLevel('fillLessonCard'), topLevel('lessonEsc'), topLevel('paintLessonCard'),
    topLevel('fillGmailDraftCard'), topLevel('gmailDraftWhen'), topLevel('gmailFileSize'), topLevel('paintGmailDraftCard'),
    topLevel('fillMcpServerCard'), topLevel('mcpCardTransport'), topLevel('paintMcpServerCard'),
    cardClickListener(),
    'return { hydrateChatCards };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  ({ hydrateChatCards } = new Function('api', source)((p: string, o?: ApiCall['options']) => {
    calls.push({ path: p, options: o });
    return holder.api(p, o);
  }));
});

/** A stub server: the profile and definition the card reads, plus scripted action answers. */
function serve(profile: Record<string, unknown>, config: Record<string, unknown>, answers: Record<string, unknown> = {}) {
  holder.api = async (p: string) => {
    if (p in answers) return answers[p];
    if (p === '/mcp/profiles/custom-docs') return { profile };
    if (p === '/mcp/servers/custom-docs/config') return { config };
    return { error: 'unexpected' };
  };
}

beforeEach(() => {
  calls = [];
  serve(PROFILE, CONFIG);
});

async function settle() {
  for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0));
}

async function cardFor(markerHtml = '<p>Added it.</p><p>[[mcp-server:custom-docs]]</p>'): Promise<HTMLElement> {
  document.body.innerHTML = `<div id="chat-messages"><div class="chat-msg assistant">${markerHtml}</div></div>`;
  hydrateChatCards(document.getElementById('chat-messages')!);
  await settle();
  return document.querySelector('.mcp-server-card') as HTMLElement;
}

const button = (card: HTMLElement, action: string) => card.querySelector(`[data-mcp-card-action="${action}"]`) as HTMLButtonElement;

describe('MCP server card', () => {
  it('says what runs and where, who publishes it, and what to type, escaped and without a script link', async () => {
    const card = await cardFor();
    expect(calls.map(entry => entry.path).sort()).toEqual(['/mcp/profiles/custom-docs', '/mcp/servers/custom-docs/config']);
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(card.querySelector('.mcp-card-head')!.textContent).toBe('MCP server · Docs <b>Search</b>Waiting for your review');
    expect(card.querySelector('.mcp-card-where')!.textContent)
      .toBe('Connects to docs.example.com. Every call BotBoy makes sends its arguments there. Published by example.com.');
    expect(card.querySelector('img, script, b')).toBeNull();
    expect(card.textContent).toContain('Pressing Start approves it; BotBoy cannot press it for you.');
    // Only the secret header gets a field, a password one; the saved plain header does not.
    const fields = [...card.querySelectorAll('input')] as HTMLInputElement[];
    expect(fields.map(input => [input.type, input.dataset.mcpValueKind, input.dataset.mcpValueName])).toEqual([['password', 'header', 'Authorization']]);
    expect(fields[0].placeholder).toBe('Type only the key (sent as Bearer key)');
    expect(fields[0].autocomplete).toBe('off');
    const details = [...card.querySelectorAll('dt')].map(dt => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`);
    expect(details).toEqual([
      'Runs: Remote, Streamable HTTP first, then SSE',
      'Address: https://docs.example.com/mcp',
      'Value: Header Authorization: secret, not set',
      'Value: Header X-Region: eu',
      'Found in: registry:com.example/docs@1.0.0',
      'Added by: BotBoy, on your request',
    ]);
    expect(card.querySelector('a[href^="javascript"]')).toBeNull();
    expect((card.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('#/connections/custom-docs');
    expect([...card.querySelectorAll('button')].map(item => item.textContent)).toEqual(['Start', 'Save without starting']);
    expect(document.body.textContent).not.toContain('[[mcp-server:');
  });

  it('Start saves a typed key write-only first, clears it, and repaints the running server', async () => {
    const card = await cardFor();
    const running = { ...PROFILE, enabled: true, state: 'running', needsReview: false, tools: [{ name: 'search', risk: 'read' }, { name: 'create_page', risk: 'write' }] };
    const saved = { ...CONFIG, reviewed: true, missingValues: [], headers: [{ ...CONFIG.headers[0], saved: true }, CONFIG.headers[1]] };
    (card.querySelector('input') as HTMLInputElement).value = 'k-123';
    serve(running, saved, {
      '/mcp/servers/custom-docs/secrets': { config: saved },
      '/mcp/profiles/custom-docs/actions/start': { profile: running },
    });
    button(card, 'start').click();
    await settle();
    expect(calls.slice(2, 4)).toEqual([
      { path: '/mcp/servers/custom-docs/secrets', options: { method: 'PUT', body: { headers: { Authorization: 'k-123' } } } },
      { path: '/mcp/profiles/custom-docs/actions/start', options: { method: 'POST', body: {} } },
    ]);
    expect(card.innerHTML).not.toContain('k-123');
    expect(card.querySelector('.mcp-card-status')!.textContent).toBe('Running · 2 tools');
    expect(card.querySelector('.mcp-card-status')!.className).toContain('good');
    expect(card.textContent).toContain('2 tools: 1 read, 1 that change data and run only when you ask.');
    expect(card.querySelector('.mcp-card-note')!.textContent).toBe('Saved in your Keychain. Started. Ask BotBoy in chat to use it.');
    expect([...card.querySelectorAll('button')].map(item => item.textContent)).toEqual(['Test', 'Save', 'Stop']);
  });

  it('turns a missing-key refusal into the owner\'s next step', async () => {
    const card = await cardFor();
    serve({ ...PROFILE, needsReview: false, state: 'needs_configuration', lastError: 'Waiting for header Authorization. Type it on the server\'s card in chat or on its connection page, then press Start.' }, CONFIG, {
      '/mcp/profiles/custom-docs/actions/start': { error: 'Waiting for header Authorization. Type it on the server\'s card in chat or on its connection page, then press Start.' },
    });
    button(card, 'start').click();
    await settle();
    const alert = card.querySelector('.mcp-card-error') as HTMLElement;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('Type the value above first, then press Start.');
    // The model-facing pause message is not repeated to the owner.
    expect(card.querySelector('.mcp-card-state')).toBeNull();
    expect(card.querySelector('.mcp-card-status')!.textContent).toBe('Waiting for a value');
  });

  it('runs a local server\'s Test and shows a failed test as an error', async () => {
    const local = { ...CONFIG, transport: 'stdio', url: '', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'], headers: [], env: [{ name: 'BRAVE_API_KEY', secret: true, required: true, saved: true }], missingValues: [], about: {} };
    const running = { ...PROFILE, enabled: true, state: 'running', needsReview: false, tools: [{ name: 'brave_web_search', risk: 'read' }] };
    serve(running, local, { '/mcp/profiles/custom-docs/actions/test': { result: { compatibilityState: 'incompatible', message: 'The server answered, but listed no tools.' }, profile: running } });
    const card = await cardFor();
    expect(card.querySelector('.mcp-card-where')!.textContent).toBe('Runs npx -y @brave/brave-search-mcp-server@2.1.3 on this Mac.');
    expect((card.querySelector('input') as HTMLInputElement).placeholder).toBe('Saved. Type to replace it.');
    button(card, 'test').click();
    await settle();
    expect(calls.at(-3)).toEqual({ path: '/mcp/profiles/custom-docs/actions/test', options: { method: 'POST', body: {} } });
    expect(card.querySelector('.mcp-card-error')!.textContent).toBe('The server answered, but listed no tools.');
  });

  it('says so when the server no longer exists', async () => {
    holder.api = async () => ({ error: 'Unknown MCP profile' });
    const card = await cardFor();
    expect(card.textContent).toBe('This MCP server is no longer set up.');
  });
});
