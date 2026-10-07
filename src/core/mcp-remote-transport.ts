/**
 * Remote MCP transports and their failures (MCP_REMOTE_TRANSPORTS_PLAN.md
 * MR1). Streamable HTTP is the current transport; HTTP+SSE is the deprecated
 * one some servers still speak. An `auto` server tries Streamable HTTP and
 * falls back to SSE when initialize answers 400, 404, or 405, the spec's
 * backwards-compatibility signal.
 *
 * Every failure maps to one kind with an owner-facing message that names the
 * next action, and to how BotBoy retries: `backoff` reconnects later on its
 * own (network, server errors), `owner` waits for the owner (credentials,
 * address, policy) so a wrong key never turns into a reconnect storm.
 */

import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { RemoteMcpRequestError, type FetchLike } from './mcp-remote-fetch.js';

export type RemoteTransportKind = 'http' | 'sse';
export type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport;

export function createRemoteTransport(kind: RemoteTransportKind, url: URL, fetch: FetchLike): RemoteTransport {
  return kind === 'http'
    ? new StreamableHTTPClientTransport(url, { fetch })
    : new SSEClientTransport(url, { fetch });
}

export function remoteTransportKind(transport: unknown): RemoteTransportKind | null {
  if (transport instanceof StreamableHTTPClientTransport) return 'http';
  if (transport instanceof SSEClientTransport) return 'sse';
  return null;
}

/** An old HTTP+SSE server refuses the Streamable HTTP initialize with one of these. */
export function isLegacySseSignal(error: unknown): boolean {
  return error instanceof StreamableHTTPError && [400, 404, 405].includes(Number(error.code));
}

/**
 * A Streamable HTTP server that forgot BotBoy's session answers 404 to a
 * request carrying the old session id. The server did not run that request.
 */
export function isSessionEnded(error: unknown, transport: unknown): boolean {
  return error instanceof StreamableHTTPError
    && Number(error.code) === 404
    && transport instanceof StreamableHTTPClientTransport
    && Boolean(transport.sessionId);
}

/** Ask a Streamable HTTP server to end the session; never waits past `timeoutMs`. */
export async function endRemoteSession(transport: unknown, timeoutMs = 2_000): Promise<void> {
  if (!(transport instanceof StreamableHTTPClientTransport) || !transport.sessionId) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    transport.terminateSession().catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
}

export type RemoteFailureKind =
  | 'network'
  | 'server'
  | 'auth'
  | 'sign_in'
  | 'not_found'
  | 'gone'
  | 'blocked'
  | 'protocol'
  | 'other';

export interface RemoteFailure {
  kind: RemoteFailureKind;
  /** Owner-facing message naming the next action. */
  message: string;
  status?: number;
  /** `owner` stops automatic reconnects until the owner acts. */
  retry: 'backoff' | 'owner';
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED',
]);
const NAME_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']);
const TLS_CODES = /^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH)/;

function causeCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    const code = Number(error.code);
    if (Number.isInteger(code) && code >= 100) return code;
  }
  const match = String((error as Error)?.message ?? '').match(/\bHTTP (\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

export function classifyRemoteFailure(error: unknown, context: { url: string }): RemoteFailure {
  let host = context.url;
  try { host = new URL(context.url).host; } catch { /* keep the raw value */ }

  if (error instanceof RemoteMcpRequestError) {
    if (error.code === 'sign_in_redirect') {
      return {
        kind: 'sign_in',
        retry: 'owner',
        message: `${error.message} BotBoy can't sign in to this address by itself. If it is an Amazon server, add it from its AIM bundle (ask BotBoy to look it up); otherwise follow the server's sign-in steps.`,
      };
    }
    if (error.code === 'response_too_large') return { kind: 'other', retry: 'backoff', message: error.message };
    return { kind: 'blocked', retry: 'owner', message: error.message };
  }
  if (error instanceof UnauthorizedError) {
    return { kind: 'auth', retry: 'owner', status: 401, message: `${host} needs a sign-in BotBoy does not have yet. Save the server's key on its card, or sign in when the card offers it.` };
  }

  const status = httpStatusOf(error);
  if (status === 401) {
    return { kind: 'auth', retry: 'owner', status, message: `${host} refused BotBoy's credentials (HTTP 401). Save the right key on the server's card, then start it again.` };
  }
  if (status === 403) {
    return { kind: 'auth', retry: 'owner', status, message: `${host} refused access (HTTP 403). Check that the saved key or account may use this server.` };
  }
  if (status === 404 || status === 405) {
    return { kind: 'not_found', retry: 'owner', status, message: `No MCP endpoint answered at ${context.url} (HTTP ${status}). Check the address; most servers end in /mcp.` };
  }
  if (status === 410) {
    return { kind: 'gone', retry: 'owner', status, message: `${host} retired this endpoint (HTTP 410). Use the server's current address (for an old /sse address, usually the same host with /mcp).` };
  }
  if (status === 400) {
    return { kind: 'protocol', retry: 'owner', status, message: `${host} rejected BotBoy's MCP request (HTTP 400). Check the address and the transport (Streamable HTTP or SSE).` };
  }
  if (status === 429) {
    return { kind: 'server', retry: 'backoff', status, message: `${host} is limiting how often BotBoy may call it (HTTP 429). BotBoy tries again later.` };
  }
  if (status !== undefined && status >= 500) {
    return { kind: 'server', retry: 'backoff', status, message: `${host} had a server error (HTTP ${status}). BotBoy tries again later.` };
  }
  if (error instanceof StreamableHTTPError && Number(error.code) === -1) {
    return { kind: 'protocol', retry: 'owner', message: `${host} answered, but not as an MCP server. Check the address.` };
  }

  const code = causeCode(error);
  if (NAME_CODES.has(code)) {
    return { kind: 'network', retry: 'backoff', message: `BotBoy can't find ${host}. Check the address, or connect to VPN if it is an internal server.` };
  }
  if (TLS_CODES.test(code)) {
    return { kind: 'blocked', retry: 'owner', message: `${host}'s security certificate isn't trusted (${code}). BotBoy connects only to servers with a valid certificate.` };
  }
  if (NETWORK_CODES.has(code) || /fetch failed|network|socket hang up|terminated/i.test(String((error as Error)?.message ?? ''))) {
    return { kind: 'network', retry: 'backoff', message: `BotBoy can't reach ${host} right now${code ? ` (${code})` : ''}. It tries again on its own; check VPN if the server is internal.` };
  }
  if (/request timed out/i.test(String((error as Error)?.message ?? ''))) {
    return { kind: 'network', retry: 'backoff', message: `${host} did not answer in time. BotBoy tries again later.` };
  }
  const text = String((error as Error)?.message ?? error ?? 'unknown error').slice(0, 300);
  return { kind: 'other', retry: 'backoff', message: `${host}: ${text}` };
}
