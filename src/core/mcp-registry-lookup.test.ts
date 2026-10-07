import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpServerFinder,
  parseAimCatalog,
  publisherOfNamespace,
  registryCandidate,
  searchWords,
} from './mcp-registry-lookup.js';
import { normalizeCustomServerInput } from './mcp-custom-config.js';

/**
 * mcp_find_server (MCP_REMOTE_TRANSPORTS_PLAN.md MR1): registry entries map
 * to add objects the add tool accepts as they are, secrets are never
 * pre-filled, and a slow or missing source never hides the other one.
 */

const entry = (server: Record<string, unknown>) => ({ server, _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } } });

const NOTION = entry({
  name: 'com.notion/mcp',
  description: 'Official Notion MCP server',
  version: '1.0.1',
  remotes: [
    { type: 'sse', url: 'https://mcp.notion.com/sse' },
    { type: 'streamable-http', url: 'https://mcp.notion.com/mcp' },
  ],
});
const SMITHERY_NOTION = entry({
  name: 'ai.smithery/smithery-notion',
  description: 'A Notion workspace is a collaborative environment',
  version: '1.0.0',
  remotes: [{
    type: 'streamable-http',
    url: 'https://server.smithery.ai/@smithery/notion/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer {smithery_api_key}', isSecret: true, isRequired: true, description: 'Bearer token' }],
  }],
});
const BRAVE = entry({
  name: 'io.github.brave/brave-search-mcp-server',
  description: 'Brave Search MCP Server: web results, images, videos.',
  version: '2.1.3',
  packages: [{
    registryType: 'npm',
    identifier: '@brave/brave-search-mcp-server',
    version: '2.1.3',
    transport: { type: 'stdio' },
    environmentVariables: [{ name: 'BRAVE_API_KEY', isSecret: true, isRequired: true, default: 'should-not-appear' }],
  }],
});
const ARMORY = entry({
  name: 'com.mcparmory/notion',
  description: 'Create, update, and manage pages, databases, and workspace users',
  version: '1.0.2',
  packages: [
    { registryType: 'pypi', identifier: 'mcparmory-notion', version: '1.0.2', runtimeHint: 'uvx', transport: { type: 'stdio' } },
    { registryType: 'oci', identifier: 'ghcr.io/mcparmory/notion:1.0.2', runtimeHint: 'docker', transport: { type: 'stdio' }, environmentVariables: [{ name: 'NOTION_TOKEN', isSecret: true }] },
    { registryType: 'npm', identifier: 'notion-http', version: '1.0.0', transport: { type: 'streamable-http', url: 'http://localhost:{port}/mcp' } },
  ],
  remotes: [{ type: 'streamable-http', url: 'https://{tenant}.mcparmory.com/mcp' }],
});
const SECRET_ARGUMENT = entry({
  name: 'io.github.someone/token-cli',
  description: 'Takes its token on the command line',
  version: '0.1.0',
  packages: [
    { registryType: 'npm', identifier: 'token-cli', version: '0.1.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'named', name: '--token', isSecret: true, default: 'demo-token-value' }] },
    { registryType: 'npm', identifier: 'needs-path', version: '1.0.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', valueHint: 'directory', isRequired: true }] },
    { registryType: 'npm', identifier: 'flagged', version: '2.0.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'named', name: '--read-only', value: 'true' }, { type: 'positional', value: 'serve' }] },
  ],
});
const ELSEWHERE = entry({
  name: 'com.example/tools',
  description: 'Example tools',
  remotes: [{ type: 'streamable-http', url: 'https://gateway.other-host.dev/example/mcp' }],
});

describe('registry entries become add objects', () => {
  it('names the verified publisher of a namespace', () => {
    expect(publisherOfNamespace('com.notion/mcp')).toBe('notion.com');
    expect(publisherOfNamespace('ai.smithery/smithery-notion')).toBe('smithery.ai');
    expect(publisherOfNamespace('io.github.brave/brave-search-mcp-server')).toBe('github.com/brave');
  });

  it('maps remotes with Streamable HTTP first and keeps a header template for the owner', () => {
    const notion = registryCandidate(NOTION)!;
    expect(notion).toMatchObject({ source: 'mcp-registry', id: 'com.notion/mcp', publisher: 'notion.com', version: '1.0.1' });
    expect(notion.options.map(option => [option.add.type, option.add.url, option.host])).toEqual([
      ['http', 'https://mcp.notion.com/mcp', 'mcp.notion.com'],
      ['sse', 'https://mcp.notion.com/sse', 'mcp.notion.com'],
    ]);
    expect(notion.options[0].add.about).toMatchObject({ publisher: 'notion.com', source: 'registry:com.notion/mcp@1.0.1' });

    const smithery = registryCandidate(SMITHERY_NOTION)!;
    expect(smithery.options[0].add).toMatchObject({
      headers: { Authorization: 'Bearer {smithery_api_key}' },
      secret: ['Authorization'],
      required: ['Authorization'],
    });
    expect(registryCandidate(ELSEWHERE)!.options[0].label).toMatch(/third party, not example\.com/);
  });

  it('maps packages to pinned npx, uvx, and docker launches and never pre-fills a secret', () => {
    const brave = registryCandidate(BRAVE)!;
    expect(brave.options[0].add).toMatchObject({
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server@2.1.3'],
      env: { BRAVE_API_KEY: '' },
      secret: ['BRAVE_API_KEY'],
      required: ['BRAVE_API_KEY'],
    });
    expect(JSON.stringify(brave)).not.toContain('should-not-appear');

    const armory = registryCandidate(ARMORY)!;
    expect(armory.options.map(option => [option.add.command, option.add.args])).toEqual([
      ['uvx', ['mcparmory-notion==1.0.2']],
      ['docker', ['run', '-i', '--rm', '-e', 'NOTION_TOKEN', 'ghcr.io/mcparmory/notion:1.0.2']],
    ]);
    // What BotBoy cannot run yet is said, not silently dropped.
    expect(armory.skipped).toEqual([
      'https://{tenant}.mcparmory.com/mcp (its address needs values filled in)',
      'npm package notion-http (it starts its own local web server)',
    ]);
  });

  it('never puts a secret on the command line, and skips a package whose required argument has no value', () => {
    const candidate = registryCandidate(SECRET_ARGUMENT)!;
    expect(candidate.options.map(option => option.add.args)).toEqual([['-y', 'flagged@2.0.0', '--read-only', 'true', 'serve']]);
    expect(candidate.skipped).toEqual([
      'npm package token-cli (it needs arguments BotBoy cannot fill)',
      'npm package needs-path (it needs arguments BotBoy cannot fill)',
    ]);
  });

  it('produces add objects the add tool accepts from BotBoy as they are', () => {
    for (const fixture of [NOTION, SMITHERY_NOTION, BRAVE, ARMORY, ELSEWHERE, SECRET_ARGUMENT]) {
      for (const option of registryCandidate(fixture)!.options) {
        const normalized = normalizeCustomServerInput(option.add, { origin: 'assistant' });
        expect(normalized.values.size, option.label).toBe(0);
      }
    }
  });

  it('reads search words without filler', () => {
    expect(searchWords('Add the official Notion MCP server')).toEqual(['notion']);
    expect(searchWords('AWS Knowledge')).toEqual(['aws', 'knowledge']);
  });
});

const AIM_LIST = JSON.stringify({
  registryBundles: [
    { bundleId: 'asana-mcp', name: 'Asana MCP Server [In development]', description: 'Comprehensive MCP server for Asana.', isInstalled: false, authTypes: [] },
    { bundleId: 'enterprise-asana-mcp', name: 'Enterprise Asana MCP Server [Recommended]', description: 'Seamlessly manage Asana tasks.', isInstalled: false, authTypes: ['midway'] },
    { bundleId: 'builder-mcp', name: 'Amazon Software Builder MCP [Recommended]', description: 'Internal Amazon tooling.', isInstalled: true, authTypes: [] },
    { bundleId: 'bad id with spaces', name: 'Broken', description: '', isInstalled: false, authTypes: [] },
  ],
  totalCount: 4,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('the finder', () => {
  let dir: string;
  let cacheFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-find-'));
    cacheFile = path.join(dir, 'cache', 'aim-mcp-catalog.json');
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('searches each word once, keeps entries that match every word, and caches the registry for ten minutes', async () => {
    const urls: string[] = [];
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const term = new URL(url).searchParams.get('search');
      return jsonResponse({ servers: term === 'notion' ? [SMITHERY_NOTION, NOTION, ARMORY] : [BRAVE] });
    });
    const finder = createMcpServerFinder({ fetchImpl: fetchImpl as unknown as typeof fetch, listAimCatalog: async () => null, cacheFile, now: () => clock });
    const found = await finder.find('notion');
    expect(urls).toEqual(['https://registry.modelcontextprotocol.io/v0.1/servers?search=notion&limit=30&version=latest']);
    // The service's own namespace ranks first.
    expect(found.candidates.map(candidate => candidate.id)).toEqual(['com.notion/mcp', 'ai.smithery/smithery-notion', 'com.mcparmory/notion']);
    expect(found.sources).toEqual({
      'mcp-registry': { status: 'ok', matches: 3 },
      aim: { status: 'not_installed', message: expect.stringMatching(/aim is not installed/) },
    });

    await finder.find('notion');
    expect(urls).toHaveLength(1);
    clock += 10 * 60_000 + 1;
    await finder.find('notion');
    expect(urls).toHaveLength(2);

    // No entry matches both words, so each word's best matches come back.
    const both = await finder.find('notion brave');
    expect(both.candidates.map(candidate => candidate.id)).toEqual([
      'com.notion/mcp', 'io.github.brave/brave-search-mcp-server', 'ai.smithery/smithery-notion', 'com.mcparmory/notion',
    ]);
    const brave = await finder.find('brave search');
    expect(brave.candidates.map(candidate => candidate.id)).toEqual(['io.github.brave/brave-search-mcp-server']);
  });

  it('ranks AIM bundles by match and support level, names their setup, and caches the list privately', async () => {
    const listAimCatalog = vi.fn(async () => AIM_LIST);
    const finder = createMcpServerFinder({
      fetchImpl: (async () => jsonResponse({ servers: [] })) as unknown as typeof fetch,
      listAimCatalog,
      cacheFile,
    });
    const found = await finder.find('asana');
    expect(found.candidates.map(candidate => [candidate.id, candidate.supportLevel])).toEqual([
      ['enterprise-asana-mcp', 'Recommended'],
      ['asana-mcp', 'In development'],
    ]);
    expect(found.candidates[0]).toMatchObject({
      source: 'aim',
      title: 'Enterprise Asana MCP Server',
      publisher: 'Amazon AIM registry',
      installed: false,
      options: [{
        setup: ['mwinit (only when the Midway session has expired)', 'aim mcp install enterprise-asana-mcp'],
        add: { command: 'aim', args: ['mcp', 'start-server', 'enterprise-asana-mcp'], about: { source: 'aim:enterprise-asana-mcp' } },
      }],
    });
    expect(normalizeCustomServerInput(found.candidates[0].options[0].add, { origin: 'assistant' }).command).toBe('aim');
    expect(found.sources.aim).toEqual({ status: 'ok', matches: 2 });
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);

    // A second finder (a restart) reads the cache instead of listing again.
    const again = createMcpServerFinder({ fetchImpl: (async () => jsonResponse({ servers: [] })) as unknown as typeof fetch, listAimCatalog, cacheFile });
    const installed = await again.find('builder');
    expect(installed.candidates[0]).toMatchObject({ id: 'builder-mcp', installed: true });
    expect(installed.candidates[0].options[0].setup).toBeUndefined();
    expect(listAimCatalog).toHaveBeenCalledTimes(1);
  });

  it('reports a slow first AIM listing as loading, then serves it once it lands', async () => {
    let finish: (value: string) => void = () => {};
    const listAimCatalog = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const finder = createMcpServerFinder({
      fetchImpl: (async () => jsonResponse({ servers: [] })) as unknown as typeof fetch,
      listAimCatalog,
      cacheFile,
      aimWaitMs: 20,
    });
    const first = await finder.find('asana');
    expect(first.sources.aim).toMatchObject({ status: 'loading', message: expect.stringMatching(/Search again shortly/) });
    finish(AIM_LIST);
    await vi.waitFor(() => expect(fs.existsSync(cacheFile)).toBe(true));
    const second = await finder.find('asana');
    expect(second.candidates[0].id).toBe('enterprise-asana-mcp');
    expect(listAimCatalog).toHaveBeenCalledTimes(1);
  });

  it('refreshes a day-old AIM catalog in the background while serving the cached one', async () => {
    let clock = 5_000_000;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(parseAimCatalog(AIM_LIST, clock - 25 * 60 * 60_000)));
    const listAimCatalog = vi.fn(async () => JSON.stringify({ registryBundles: [{ bundleId: 'asana-next', name: 'Asana Next [Supported]', description: 'Asana', isInstalled: false, authTypes: [] }] }));
    const finder = createMcpServerFinder({ fetchImpl: (async () => jsonResponse({ servers: [] })) as unknown as typeof fetch, listAimCatalog, cacheFile, now: () => clock });
    const stale = await finder.find('asana');
    expect(stale.candidates[0].id).toBe('enterprise-asana-mcp');
    await vi.waitFor(() => expect(listAimCatalog).toHaveBeenCalledTimes(1));
    clock += 1;
    await vi.waitFor(async () => expect((await finder.find('asana')).candidates[0].id).toBe('asana-next'));
  });

  it('keeps one source\'s results when the other fails, and says why', async () => {
    const finder = createMcpServerFinder({
      fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
      listAimCatalog: async () => AIM_LIST,
      cacheFile,
    });
    const found = await finder.find('asana');
    expect(found.sources['mcp-registry']).toEqual({ status: 'unavailable', message: 'The official MCP Registry could not be searched: fetch failed' });
    expect(found.candidates.map(candidate => candidate.id)).toContain('enterprise-asana-mcp');

    const broken = createMcpServerFinder({
      fetchImpl: (async () => jsonResponse({ error: 'down' }, 503)) as unknown as typeof fetch,
      listAimCatalog: async () => { throw new Error('aim mcp list failed: Midway session expired'); },
      cacheFile: path.join(dir, 'other.json'),
    });
    const none = await broken.find('asana');
    expect(none.candidates).toEqual([]);
    expect(none.sources).toEqual({
      'mcp-registry': { status: 'unavailable', message: 'The official MCP Registry could not be searched: the registry answered HTTP 503' },
      aim: { status: 'unavailable', message: 'aim mcp list failed: Midway session expired' },
    });
  });
});
