import { describe, expect, it } from 'vitest';
import {
  KEEP_SECRET_MASK,
  customServerIdentity,
  headerTemplateOf,
  isPlaceholderValue,
  looksSecret,
  missingRequiredValues,
  normalizeCustomServerInput,
  parseCustomConfig,
  renderHeaderValue,
  serializeCustomConfig,
  validateRemoteUrl,
  valueKey,
  type CustomServerConfig,
} from './mcp-custom-config.js';

const assistant = { origin: 'assistant' as const };
const user = { origin: 'user' as const };

function stored(input: unknown, origin: 'user' | 'assistant' = 'user'): CustomServerConfig {
  const normalized = normalizeCustomServerInput(input, { origin });
  return {
    version: 2,
    transport: normalized.transport,
    command: normalized.command,
    args: normalized.args,
    url: normalized.url,
    env: normalized.env,
    headers: normalized.headers,
    about: normalized.about,
    origin,
    reviewed: origin === 'user',
  };
}

describe('secret names', () => {
  it('flags credential names by whole word parts, not substrings', () => {
    for (const name of ['OPENAI_API_KEY', 'accessToken', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'Authorization', 'X-API-Key', 'NOTION_TOKEN', 'clientSecret', 'DB_PASSWORD', 'Cookie', 'SLACK_BOT_TOKEN']) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ['KEYCHAIN_DIR', 'LOG_LEVEL', 'AUTH_MODE', 'MONKEY_COUNT', 'REGION', 'FASTMCP_LOG_LEVEL', 'X-Request-Id']) {
      expect(looksSecret(name), name).toBe(false);
    }
  });

  it('treats empty values, placeholders, and the saved-secret mask as no value', () => {
    for (const value of ['', '  ', '${env:API_KEY}', '${input:token}', '<YOUR_TOKEN>', '{api_key}', 'YOUR_API_KEY_HERE', 'replace-me', '****', KEEP_SECRET_MASK]) {
      expect(isPlaceholderValue(value), value).toBe(true);
    }
    for (const value of ['sk-live-123', 'Bearer abc', 'false', 'https://example.com']) {
      expect(isPlaceholderValue(value), value).toBe(false);
    }
  });

  it('turns a header with one slot into a template the owner fills with just the key', () => {
    expect(headerTemplateOf('Bearer {smithery_api_key}')).toBe('Bearer {value}');
    expect(headerTemplateOf('Bearer <TOKEN>')).toBe('Bearer {value}');
    expect(headerTemplateOf('Bearer ${env:GITHUB_TOKEN}')).toBe('Bearer {value}');
    expect(headerTemplateOf('{token}')).toBeNull();
    expect(headerTemplateOf('Bearer abc')).toBeNull();
    expect(renderHeaderValue({ template: 'Bearer {value}' }, 'abc')).toBe('Bearer abc');
    // A pasted full value is sent as typed, never doubled.
    expect(renderHeaderValue({ template: 'Bearer {value}' }, 'Bearer abc')).toBe('Bearer abc');
    expect(renderHeaderValue({}, 'abc')).toBe('abc');
  });
});

describe('local definitions', () => {
  it('keeps the stdio contract and splits a command typed with its flags', () => {
    const plain = normalizeCustomServerInput({ name: 'Notion', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] }, user);
    expect(plain).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], url: '' });
    const typed = normalizeCustomServerInput({ name: 'Notion', command: 'npx -y @notionhq/notion-mcp-server', args: ['--port', '0'] }, user);
    expect(typed).toMatchObject({ command: 'npx', args: ['-y', '@notionhq/notion-mcp-server', '--port', '0'] });
    expect(() => normalizeCustomServerInput({ name: 'x', command: 'bin/server' }, user)).toThrow('executable name or an absolute path');
    expect(() => normalizeCustomServerInput({ name: 'x', command: 'npx', headers: { Authorization: 'x' } }, user)).toThrow('remote servers only');
  });

  it('refuses a secret value written by the assistant and names the next action', () => {
    expect(() => normalizeCustomServerInput({ name: 'x', command: 'npx', env: { OPENAI_API_KEY: 'sk-live-123' } }, assistant))
      .toThrow(/OPENAI_API_KEY is a secret: leave its value empty and ask the owner to type it into the server's card/);
    // An explicitly listed secret counts too.
    expect(() => normalizeCustomServerInput({ name: 'x', command: 'npx', env: { WORKSPACE: 'abc' }, secret: ['WORKSPACE'] }, assistant))
      .toThrow(/WORKSPACE is a secret/);
    const empty = normalizeCustomServerInput({ name: 'x', command: 'npx', env: { OPENAI_API_KEY: '', REGION: 'us-east-1' } }, assistant);
    expect(empty.env).toEqual([
      { name: 'OPENAI_API_KEY', secret: true, hasValue: false, required: true },
      { name: 'REGION', secret: false, hasValue: true, required: false },
    ]);
    // Only the non-secret value is saved; the secret waits for the owner.
    expect([...empty.values.entries()]).toEqual([[valueKey('env', 'REGION'), 'us-east-1']]);
  });

  it('accepts secret values from the owner, who is the author on the form', () => {
    const owner = normalizeCustomServerInput({ name: 'x', command: 'npx', env: { OPENAI_API_KEY: 'sk-live-123' } }, user);
    expect(owner.values.get('env-OPENAI_API_KEY')).toBe('sk-live-123');
    expect(owner.env[0]).toMatchObject({ secret: true, hasValue: true });
  });
});

describe('remote definitions', () => {
  it('reads url and the common type spellings', () => {
    expect(normalizeCustomServerInput({ name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp' }, assistant)).toMatchObject({ transport: 'auto', url: 'https://mcp.deepwiki.com/mcp', command: '' });
    expect(normalizeCustomServerInput({ name: 'x', type: 'streamable-http', url: 'https://a.example/mcp' }, assistant).transport).toBe('http');
    expect(normalizeCustomServerInput({ name: 'x', type: 'http', url: 'https://a.example/mcp' }, assistant).transport).toBe('http');
    expect(normalizeCustomServerInput({ name: 'x', transport: 'sse', url: 'https://a.example/sse' }, assistant).transport).toBe('sse');
    expect(() => normalizeCustomServerInput({ name: 'x', type: 'websocket', url: 'https://a.example' }, assistant)).toThrow('not supported');
    expect(() => normalizeCustomServerInput({ name: 'x', command: 'npx', url: 'https://a.example' }, assistant)).toThrow('not both');
    expect(() => normalizeCustomServerInput({ name: 'x' }, assistant)).toThrow('command is required for a local server, or url for a remote server');
  });

  it('allows https anywhere and plain http only on this Mac', () => {
    expect(validateRemoteUrl('https://mcp.example.com/mcp#frag')).toBe('https://mcp.example.com/mcp');
    expect(validateRemoteUrl('http://localhost:3000/mcp')).toBe('http://localhost:3000/mcp');
    expect(validateRemoteUrl('http://127.0.0.1:3000/mcp')).toBe('http://127.0.0.1:3000/mcp');
    expect(() => validateRemoteUrl('http://mcp.example.com/mcp')).toThrow('https://');
    expect(() => validateRemoteUrl('ftp://mcp.example.com')).toThrow('https://');
    expect(() => validateRemoteUrl('https://user:pass@mcp.example.com/mcp')).toThrow('user name or password');
    expect(() => validateRemoteUrl('https://mcp.example.com/mcp?api_key=abc')).toThrow('credential in its query');
    expect(validateRemoteUrl('https://mcp.example.com/mcp?profile=work')).toBe('https://mcp.example.com/mcp?profile=work');
  });

  it('keeps header names, flags credentials, and refuses headers BotBoy owns', () => {
    const remote = normalizeCustomServerInput({
      name: 'Smithery GitHub',
      url: 'https://server.smithery.ai/@smithery-ai/github/mcp',
      headers: { Authorization: 'Bearer {smithery_api_key}', 'X-Region': 'eu' },
    }, assistant);
    expect(remote.headers).toEqual([
      { name: 'Authorization', secret: true, hasValue: false, required: true, template: 'Bearer {value}' },
      { name: 'X-Region', secret: false, hasValue: true, required: false },
    ]);
    expect(() => normalizeCustomServerInput({ name: 'x', url: 'https://a.example', headers: { 'Mcp-Session-Id': 'x' } }, user)).toThrow('set by BotBoy itself');
    expect(() => normalizeCustomServerInput({ name: 'x', url: 'https://a.example', headers: { 'Bad Header': 'x' } }, user)).toThrow('not valid');
    expect(() => normalizeCustomServerInput({ name: 'x', url: 'https://a.example', headers: { 'X-A': 'one\ntwo' } }, user)).toThrow('one line');
    expect(() => normalizeCustomServerInput({ name: 'x', url: 'https://a.example', headers: { Authorization: 'Bearer sk-real' } }, assistant)).toThrow(/Authorization is a secret/);
  });
});

describe('updates', () => {
  it('keeps saved secret values while their name stays, and keeps omitted fields', () => {
    const previous = stored({ name: 'x', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer real' } });
    expect(previous.headers[0]).toMatchObject({ hasValue: true, secret: true });
    const renamed = normalizeCustomServerInput({ name: 'Renamed' }, { origin: 'assistant', previous, previousName: 'x' });
    expect(renamed).toMatchObject({ name: 'Renamed', transport: 'auto', url: 'https://a.example/mcp' });
    expect(renamed.headers[0]).toMatchObject({ name: 'Authorization', hasValue: true });
    const sameNameEmpty = normalizeCustomServerInput({ headers: { Authorization: '' } }, { origin: 'assistant', previous, previousName: 'x' });
    expect(sameNameEmpty.headers[0].hasValue).toBe(true);
    expect(sameNameEmpty.values.size).toBe(0);
    const removed = normalizeCustomServerInput({ headers: {} }, { origin: 'assistant', previous, previousName: 'x' });
    expect(removed.headers).toEqual([]);
    // The owner's mask round-trip keeps the value too.
    const masked = normalizeCustomServerInput({ headers: { Authorization: KEEP_SECRET_MASK } }, { origin: 'user', previous, previousName: 'x' });
    expect(masked.headers[0].hasValue).toBe(true);
    expect(masked.values.size).toBe(0);
  });

  it('needs a new review only when what runs or where it connects changes', () => {
    const local = stored({ name: 'x', command: 'npx', args: ['-y', 'pkg@1'] });
    const moreEnv = stored({ name: 'x', command: 'npx', args: ['-y', 'pkg@1'], env: { LOG_LEVEL: 'debug' } });
    const otherPackage = stored({ name: 'x', command: 'npx', args: ['-y', 'other@1'] });
    expect(customServerIdentity(moreEnv)).toBe(customServerIdentity(local));
    expect(customServerIdentity(otherPackage)).not.toBe(customServerIdentity(local));
    const remote = stored({ name: 'x', url: 'https://a.example/mcp' });
    const newPath = stored({ name: 'x', url: 'https://a.example/v2/mcp', type: 'sse' });
    const newHost = stored({ name: 'x', url: 'https://b.example/mcp' });
    expect(customServerIdentity(newPath)).toBe(customServerIdentity(remote));
    expect(customServerIdentity(newHost)).not.toBe(customServerIdentity(remote));
    expect(customServerIdentity(remote)).not.toBe(customServerIdentity(local));
  });
});

describe('stored rows', () => {
  it('reads version-1 rows with inline env values as local servers waiting for the Keychain move', () => {
    const legacy = parseCustomConfig(JSON.stringify({ name: 'Old', command: 'uvx', args: ['pkg'], env: { API_KEY: 'k', LOG_LEVEL: 'info' }, origin: 'assistant', reviewed: false }));
    expect(legacy).toMatchObject({ version: 2, transport: 'stdio', command: 'uvx', args: ['pkg'], origin: 'assistant', reviewed: false, legacyEnv: { API_KEY: 'k', LOG_LEVEL: 'info' } });
    expect(legacy.env).toEqual([
      { name: 'API_KEY', secret: true, hasValue: true, required: false },
      { name: 'LOG_LEVEL', secret: false, hasValue: true, required: false },
    ]);
    // Rows from before review tracking stay user-authored and reviewed.
    expect(parseCustomConfig(JSON.stringify({ command: 'x' }))).toMatchObject({ origin: 'user', reviewed: true });
  });

  it('round-trips version 2 without carrying values', () => {
    const config = stored({ name: 'x', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer {t}' } }, 'assistant');
    const raw = serializeCustomConfig({ ...config, detectedTransport: 'sse' });
    expect(raw).not.toContain('Bearer {t}');
    const back = parseCustomConfig(raw);
    expect(back).toMatchObject({ transport: 'auto', url: 'https://a.example/mcp', detectedTransport: 'sse', origin: 'assistant', reviewed: false });
    expect(back.headers[0]).toEqual({ name: 'Authorization', secret: true, hasValue: false, required: true, template: 'Bearer {value}' });
    expect(missingRequiredValues(back)).toEqual(['header Authorization']);
  });
});
