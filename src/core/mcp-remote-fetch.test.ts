import { describe, expect, it, vi } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  RemoteMcpRequestError,
  blockedAddressReason,
  createGuardedFetch,
  isSignInHost,
  remoteDestinationProblem,
  type FetchLike,
} from './mcp-remote-fetch.js';
import { classifyRemoteFailure, isLegacySseSignal } from './mcp-remote-transport.js';

const policy = { appPort: 7778, cdpPort: 9222 };
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function scripted(responses: Array<(url: URL, init: RequestInit) => Response>): { fetchImpl: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  return {
    calls,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next(url, init);
    },
  };
}

describe('destination policy', () => {
  it('refuses BotBoy and CDP ports on every host, metadata and link-local addresses, and plain http off this Mac', () => {
    const problem = (href: string) => remoteDestinationProblem(new URL(href), policy);
    expect(problem('https://mcp.example.com/mcp')).toBeNull();
    expect(problem('http://localhost:3000/mcp')).toBeNull();
    expect(problem('http://127.0.0.1:8080/mcp')).toBeNull();
    expect(problem('http://[::1]:8080/mcp')).toBeNull();
    expect(problem('https://10.0.0.5/mcp')).toBeNull();
    expect(problem('http://localhost:7778/api/mcp/servers')).toMatch(/BotBoy's own app/);
    expect(problem('http://127.0.0.1:9222/json')).toMatch(/browser control port/);
    expect(problem('https://rebind.example.com:7778/mcp')).toMatch(/BotBoy's own app/);
    expect(problem('https://169.254.169.254/latest/meta-data')).toMatch(/metadata/);
    expect(problem('https://[fe80::1]/mcp')).toMatch(/link-local/);
    expect(problem('https://[fd00:ec2::254]/mcp')).toMatch(/metadata/);
    expect(problem('https://metadata.google.internal/')).toMatch(/metadata host/);
    expect(problem('http://mcp.example.com/mcp')).toMatch(/plain http/);
    expect(problem('ftp://mcp.example.com/')).toMatch(/https:\/\/ only/);
  });

  it('knows metadata and link-local addresses in every spelling', () => {
    expect(blockedAddressReason('169.254.169.254')).toMatch(/metadata/);
    expect(blockedAddressReason('::ffff:169.254.169.254')).toMatch(/metadata/);
    expect(blockedAddressReason('fd00:ec2:0:0:0:0:0:254')).toMatch(/metadata/);
    expect(blockedAddressReason('FE80::abcd')).toMatch(/link-local/);
    expect(blockedAddressReason('93.184.216.34')).toBeNull();
    expect(blockedAddressReason('2606:4700::6810:84e5')).toBeNull();
  });

  it('refuses a public name that resolves to a metadata address', async () => {
    const { fetchImpl, calls } = scripted([() => new Response('{}', { status: 200 })]);
    const guarded = createGuardedFetch({
      serverUrl: 'https://evil.example.com/mcp',
      policy,
      fetchImpl,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });
    await expect(guarded('https://evil.example.com/mcp', { method: 'POST' })).rejects.toThrow(/resolves to 169\.254\.169\.254/);
    expect(calls).toHaveLength(0);
  });

  it('recognizes sign-in hosts', () => {
    expect(isSignInHost('midway-auth.amazon.com')).toBe(true);
    expect(isSignInHost('idp.federate.amazon.com')).toBe(true);
    expect(isSignInHost('login.microsoftonline.com')).toBe(true);
    expect(isSignInHost('mcp.example.com')).toBe(false);
  });
});

describe('guarded fetch', () => {
  it('sends saved headers to the server origin only', async () => {
    const { fetchImpl, calls } = scripted([() => new Response('{}', { status: 200 })]);
    const guarded = createGuardedFetch({
      serverUrl: 'https://mcp.example.com/mcp',
      policy,
      fetchImpl,
      lookup: publicLookup,
      headers: () => ({ Authorization: 'Bearer secret-1' }),
    });
    await guarded('https://mcp.example.com/mcp', { method: 'POST', headers: { 'content-type': 'application/json' } });
    await guarded('https://auth.example.org/.well-known/oauth-authorization-server', { method: 'GET' });
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer secret-1');
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(calls[1].init.headers).get('authorization')).toBeNull();
    expect(calls.every(call => call.init.redirect === 'manual')).toBe(true);
  });

  it('follows a same-origin 307 with the body and refuses cross-origin and sign-in redirects', async () => {
    const same = scripted([
      () => new Response(null, { status: 307, headers: { location: '/mcp/' } }),
      () => new Response('{"ok":true}', { status: 200 }),
    ]);
    const guarded = createGuardedFetch({ serverUrl: 'https://mcp.example.com/mcp', policy, fetchImpl: same.fetchImpl, lookup: publicLookup });
    const response = await guarded('https://mcp.example.com/mcp', { method: 'POST', body: '{"id":1}' });
    expect(await response.text()).toBe('{"ok":true}');
    expect(same.calls.map(call => [call.url, call.init.method, call.init.body])).toEqual([
      ['https://mcp.example.com/mcp', 'POST', '{"id":1}'],
      ['https://mcp.example.com/mcp/', 'POST', '{"id":1}'],
    ]);

    const cross = scripted([() => new Response(null, { status: 307, headers: { location: 'https://collector.example.net/mcp' } })]);
    const crossFetch = createGuardedFetch({ serverUrl: 'https://mcp.example.com/mcp', policy, fetchImpl: cross.fetchImpl, lookup: publicLookup, headers: () => ({ 'X-Api-Key': 'k' }) });
    await expect(crossFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'redirect_blocked' });
    expect(cross.calls).toHaveLength(1);

    const midway = scripted([() => new Response(null, { status: 302, headers: { location: 'https://midway-auth.amazon.com/SSO?client_id=x' } })]);
    const midwayFetch = createGuardedFetch({ serverUrl: 'https://mcp.helios.example.dev/mcp', policy, fetchImpl: midway.fetchImpl, lookup: publicLookup });
    await expect(midwayFetch('https://mcp.helios.example.dev/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'sign_in_redirect', signInHost: 'midway-auth.amazon.com' });
  });

  it('refuses a POST turned into a GET by a 302, and endless redirects', async () => {
    const downgrade = scripted([() => new Response(null, { status: 302, headers: { location: '/other' } })]);
    const guarded = createGuardedFetch({ serverUrl: 'https://mcp.example.com/mcp', policy, fetchImpl: downgrade.fetchImpl, lookup: publicLookup });
    await expect(guarded('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(/HTTP 302/);
    const loop = scripted([(url) => new Response(null, { status: 307, headers: { location: `${url.pathname}x` } })]);
    const looping = createGuardedFetch({ serverUrl: 'https://mcp.example.com/mcp', policy, fetchImpl: loop.fetchImpl, lookup: publicLookup });
    await expect(looping('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('fails one POST answer above the cap and leaves GET streams uncapped', async () => {
    const big = 'x'.repeat(4096);
    const { fetchImpl } = scripted([() => new Response(big, { status: 200 })]);
    const guarded = createGuardedFetch({ serverUrl: 'https://mcp.example.com/mcp', policy, fetchImpl, lookup: publicLookup, maxResponseBytes: 1024 });
    const response = await guarded('https://mcp.example.com/mcp', { method: 'POST', body: '{}' });
    await expect(response.text()).rejects.toThrow(/more than BotBoy accepts/);
    const declared = scripted([() => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } })]);
    const declaredFetch = createGuardedFetch({ serverUrl: 'https://mcp.example.com/mcp', policy, fetchImpl: declared.fetchImpl, lookup: publicLookup, maxResponseBytes: 1024 });
    await expect(declaredFetch('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'response_too_large' });
    const stream = await guarded('https://mcp.example.com/mcp', { method: 'GET' });
    expect((await stream.text()).length).toBe(4096);
  });

  it('refuses blocked destinations before any request', async () => {
    const send = vi.fn();
    const guarded = createGuardedFetch({ serverUrl: 'http://localhost:7778/api', policy, fetchImpl: send as unknown as FetchLike, lookup: publicLookup });
    await expect(guarded('http://localhost:7778/api', { method: 'POST' })).rejects.toBeInstanceOf(RemoteMcpRequestError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('remote failure classification', () => {
  const url = 'https://mcp.example.com/mcp';
  it('names the next action and stops reconnecting for owner-fixable failures', () => {
    expect(classifyRemoteFailure(new StreamableHTTPError(401, 'Error POSTing to endpoint: no'), { url })).toMatchObject({ kind: 'auth', retry: 'owner', status: 401 });
    expect(classifyRemoteFailure(new StreamableHTTPError(403, 'x'), { url })).toMatchObject({ kind: 'auth', retry: 'owner' });
    expect(classifyRemoteFailure(new StreamableHTTPError(404, 'x'), { url }).message).toMatch(/most servers end in \/mcp/);
    expect(classifyRemoteFailure(new SseError(410, 'gone', undefined as never), { url })).toMatchObject({ kind: 'gone', retry: 'owner' });
    expect(classifyRemoteFailure(new Error('Error POSTing to endpoint (HTTP 401): denied'), { url })).toMatchObject({ kind: 'auth' });
    expect(classifyRemoteFailure(new RemoteMcpRequestError('sign_in_redirect', 'The server sent BotBoy to a sign-in page at midway-auth.amazon.com.', 'midway-auth.amazon.com'), { url }))
      .toMatchObject({ kind: 'sign_in', retry: 'owner', message: expect.stringContaining('AIM bundle') });
    expect(classifyRemoteFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), { url })).toMatchObject({ kind: 'blocked', retry: 'owner' });
  });

  it('backs off for network and server trouble', () => {
    expect(classifyRemoteFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), { url })).toMatchObject({ kind: 'network', retry: 'backoff', message: expect.stringContaining("can't find mcp.example.com") });
    expect(classifyRemoteFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), { url })).toMatchObject({ kind: 'network', retry: 'backoff' });
    expect(classifyRemoteFailure(new StreamableHTTPError(503, 'x'), { url })).toMatchObject({ kind: 'server', retry: 'backoff' });
    expect(classifyRemoteFailure(new StreamableHTTPError(429, 'x'), { url })).toMatchObject({ kind: 'server', retry: 'backoff' });
    expect(classifyRemoteFailure(new Error('MCP error -32001: Request timed out'), { url })).toMatchObject({ kind: 'network', retry: 'backoff' });
  });

  it('treats 400, 404, and 405 at initialize as the legacy SSE signal', () => {
    for (const status of [400, 404, 405]) expect(isLegacySseSignal(new StreamableHTTPError(status, 'x'))).toBe(true);
    for (const status of [401, 403, 410, 500]) expect(isLegacySseSignal(new StreamableHTTPError(status, 'x'))).toBe(false);
    expect(isLegacySseSignal(new Error('HTTP 404'))).toBe(false);
  });
});
