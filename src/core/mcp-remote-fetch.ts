/**
 * The only network path for remote MCP servers (MCP_REMOTE_TRANSPORTS_PLAN.md
 * MR1). The SDK transports and their OAuth helpers receive this function as
 * their `fetch`, so every request a remote server causes passes here:
 * initialize, tool calls, the SSE stream, session DELETE, and discovery.
 *
 * Rules (Identity, §3 of the plan):
 *   - https:// anywhere; http:// only for a server on this Mac.
 *   - Never BotBoy's own port or its browser control (CDP) port, on any host,
 *     so no DNS name or rebinding can point a server at them.
 *   - Never a link-local or cloud metadata address, as a literal or after
 *     resolving the host.
 *   - Redirects only within the same origin; a hop to a sign-in host becomes
 *     a classified error instead of a redirect loop.
 *   - The server's saved headers go only to the server's own origin.
 *   - A POST response larger than the cap fails that one call.
 */

import dns from 'node:dns';
import net from 'node:net';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export type RemoteMcpRequestErrorCode =
  | 'destination_blocked'
  | 'redirect_blocked'
  | 'sign_in_redirect'
  | 'too_many_redirects'
  | 'response_too_large';

export class RemoteMcpRequestError extends Error {
  readonly code: RemoteMcpRequestErrorCode;
  /** Host of a sign-in redirect, for owner-facing copy. */
  readonly signInHost?: string;
  constructor(code: RemoteMcpRequestErrorCode, message: string, signInHost?: string) {
    super(message);
    this.name = 'RemoteMcpRequestError';
    this.code = code;
    if (signInHost) this.signInHost = signInHost;
  }
}

export interface DestinationPolicy {
  /** BotBoy's own HTTP port. */
  appPort: number;
  /** The debug Chrome (CDP) port BotBoy drives. */
  cdpPort: number;
}

export const DEFAULT_REMOTE_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Hosts that answer with a sign-in page rather than an MCP endpoint. */
const SIGN_IN_HOST_PATTERNS = [
  /^midway-auth\.amazon\.com$/,
  /(^|\.)federate\.amazon\.com$/,
  /^login\.microsoftonline\.com$/,
  /^login\.live\.com$/,
  /^accounts\.google\.com$/,
  /(^|\.)okta\.com$/,
  /(^|\.)auth0\.com$/,
  /^(login|signin|sso|auth|id)\./,
];

export function isSignInHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SIGN_IN_HOST_PATTERNS.some(pattern => pattern.test(host));
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Expand an IPv6 literal to eight 4-digit groups for exact comparison. */
function expandIpv6(address: string): string | null {
  if (!net.isIPv6(address)) return null;
  const [head, tail = ''] = address.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = address.includes('::') ? (tail ? tail.split(':') : []) : [];
  if (headParts.some(part => part.includes('.')) || tailParts.some(part => part.includes('.'))) return null;
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts];
  return parts.map(part => part.padStart(4, '0')).join(':');
}

/** Why an address is refused, or null when it is allowed. */
export function blockedAddressReason(address: string): string | null {
  let ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const [first, second] = ip.split('.').map(Number);
    if (first === 169 && second === 254) return 'a link-local or cloud metadata address';
    return null;
  }
  const expanded = expandIpv6(ip);
  if (expanded) {
    if (/^fe[89ab]/.test(expanded)) return 'a link-local address';
    if (expanded === 'fd00:0ec2:0000:0000:0000:0000:0000:0254') return 'the cloud metadata address';
  }
  return null;
}

/** Why a URL is refused before any lookup, or null when it may be tried. */
export function remoteDestinationProblem(url: URL, policy: DestinationPolicy): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `BotBoy connects to MCP servers over https:// only (got ${url.protocol})`;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && !isLoopbackHost(host)) {
    return 'plain http:// is allowed only for a server on this Mac; use https://';
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (port === policy.appPort) return `port ${port} is BotBoy's own app, which an MCP server may not use`;
  if (port === policy.cdpPort) return `port ${port} is BotBoy's browser control port, which an MCP server may not use`;
  if (net.isIP(host)) {
    const reason = blockedAddressReason(host);
    if (reason) return `${host} is ${reason}`;
  }
  if (/^metadata(\.google\.internal)?$/i.test(host)) return `${host} is a cloud metadata host`;
  return null;
}

const defaultLookup: HostLookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

async function assertResolvedAllowed(hostname: string, lookup: HostLookup): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) || isLoopbackHost(host)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    // An unresolvable name fails in fetch with the resolver's own error,
    // which the failure classifier turns into "can't find <host>".
    return;
  }
  for (const { address } of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) {
      throw new RemoteMcpRequestError('destination_blocked', `${host} resolves to ${address}, ${reason}; BotBoy does not connect there`);
    }
  }
}

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

/** Wrap a response body so it fails once more than `limit` bytes arrive. */
function capResponse(response: Response, limit: number): Response {
  if (!response.body) return response;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    void response.body.cancel().catch(() => {});
    throw new RemoteMcpRequestError('response_too_large', `The server's answer is ${declared} bytes, more than BotBoy accepts from one call (${limit} bytes).`);
  }
  let seen = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new RemoteMcpRequestError('response_too_large', `The server's answer passed ${limit} bytes, more than BotBoy accepts from one call.`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export interface GuardedFetchOptions {
  /** The server's MCP endpoint; its origin alone receives `headers`. */
  serverUrl: string | URL;
  policy: DestinationPolicy;
  /** Saved header values, read at request time. */
  headers?: () => Record<string, string>;
  maxResponseBytes?: number;
  lookup?: HostLookup;
  fetchImpl?: FetchLike;
}

export function createGuardedFetch(options: GuardedFetchOptions): FetchLike {
  const serverOrigin = new URL(String(options.serverUrl)).origin;
  const lookup = options.lookup ?? defaultLookup;
  const baseFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const limit = options.maxResponseBytes ?? DEFAULT_REMOTE_RESPONSE_LIMIT_BYTES;

  return async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    let url = requestUrl(input as string | URL | Request);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    for (let hop = 0; ; hop += 1) {
      const problem = remoteDestinationProblem(url, options.policy);
      if (problem) throw new RemoteMcpRequestError('destination_blocked', `BotBoy will not connect to ${url.host}: ${problem}.`);
      await assertResolvedAllowed(url.hostname, lookup);

      const headers = new Headers(init.headers);
      if (url.origin === serverOrigin) {
        for (const [name, value] of Object.entries(options.headers?.() ?? {})) headers.set(name, value);
      }
      const response = await baseFetch(url, { ...init, method, body, headers, redirect: 'manual' });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) return method === 'GET' ? response : capResponse(response, limit);

      void response.body?.cancel().catch(() => {});
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        if (isSignInHost(next.hostname)) {
          throw new RemoteMcpRequestError('sign_in_redirect', `The server sent BotBoy to a sign-in page at ${next.host}.`, next.host);
        }
        throw new RemoteMcpRequestError('redirect_blocked', `The server redirected BotBoy to ${next.host}; BotBoy follows redirects only within ${url.host}. Use the final address as the server URL if that is intended.`);
      }
      if (hop + 1 > MAX_REDIRECTS) {
        throw new RemoteMcpRequestError('too_many_redirects', `The server at ${url.host} redirected more than ${MAX_REDIRECTS} times.`);
      }
      // 307/308 keep the method and body. Other redirects of a POST would
      // turn it into a GET, which an MCP endpoint cannot answer.
      if (response.status !== 307 && response.status !== 308) {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new RemoteMcpRequestError('redirect_blocked', `The server answered BotBoy's ${method} with a redirect (HTTP ${response.status}) to ${next.pathname}. Use that address as the server URL.`);
        }
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        body = undefined;
      }
      url = next;
    }
  };
}
