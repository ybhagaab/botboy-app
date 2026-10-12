/**
 * Connect attempt timeout for every outbound connection the server makes.
 *
 * Node 20 opens a connection with "happy eyeballs" (autoSelectFamily): each
 * address of a host gets `autoSelectFamilyAttemptTimeout` (250 ms by default)
 * to finish its TCP handshake before the next one is tried. On a route where
 * the handshake to Google takes longer (measured on the owner's Mac, Node
 * 20.19: IPv4 to oauth2.googleapis.com ~310 ms while IPv6 fails at once with
 * EHOSTUNREACH), EVERY fetch to Google died with AggregateError
 * ETIMEDOUT + EHOSTUNREACH after ~255 ms while curl worked. That broke Drive
 * consent, Gmail token refreshes, Slack, and remote MCP servers alike.
 *
 * Raising the limit is safe: a healthy route still connects at once, and only a
 * slow one gets the time it needs. The rule here: BotBoy keeps at least
 * DEFAULT_NET_ATTEMPT_TIMEOUT_MS (a larger value set by the owner through
 * NODE_OPTIONS stays), and BOTBOY_NET_ATTEMPT_TIMEOUT_MS overrides it exactly
 * (clamped to 250..10000 ms).
 *
 * Applies to the server process (fetch, the Slack client, MCP remote
 * transports). Child processes start with Node's own default. The boot module
 * `network-defaults-boot.ts` calls this once; index.ts imports it first.
 */

import net from 'node:net';

export const NET_ATTEMPT_TIMEOUT_ENV = 'BOTBOY_NET_ATTEMPT_TIMEOUT_MS';
/** The value Node ships with (--network-family-autoselection-attempt-timeout). */
export const NODE_DEFAULT_ATTEMPT_TIMEOUT_MS = 250;
export const DEFAULT_NET_ATTEMPT_TIMEOUT_MS = 2000;
export const MIN_NET_ATTEMPT_TIMEOUT_MS = 250;
export const MAX_NET_ATTEMPT_TIMEOUT_MS = 10_000;

/** The slice of `node:net` this module touches; older Node versions lack both functions. */
export interface AttemptTimeoutApi {
  setDefaultAutoSelectFamilyAttemptTimeout?: (value: number) => void;
  getDefaultAutoSelectFamilyAttemptTimeout?: () => number;
}

export type NetworkDefaultsResult =
  | { status: 'set'; timeoutMs: number; previousMs: number | null }
  | { status: 'kept'; timeoutMs: number; previousMs: number }
  | { status: 'unsupported' };

/** The limit BotBoy wants: the owner's override clamped to 250..10000 ms, else 2000 ms. */
export function wantedAttemptTimeoutMs(env: NodeJS.ProcessEnv = process.env): { ms: number; fromEnv: boolean } {
  const raw = env[NET_ATTEMPT_TIMEOUT_ENV];
  const parsed = typeof raw === 'string' && /^\s*\d{1,9}\s*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return { ms: DEFAULT_NET_ATTEMPT_TIMEOUT_MS, fromEnv: false };
  return { ms: Math.min(MAX_NET_ATTEMPT_TIMEOUT_MS, Math.max(MIN_NET_ATTEMPT_TIMEOUT_MS, parsed)), fromEnv: true };
}

/**
 * Sets the process-wide connect attempt timeout once and logs one line (no
 * secrets). A no-op on a Node that cannot set it.
 */
export function applyNetworkDefaults(deps: {
  env?: NodeJS.ProcessEnv;
  net?: AttemptTimeoutApi;
  log?: (line: string) => void;
} = {}): NetworkDefaultsResult {
  const api = deps.net ?? net;
  const log = deps.log ?? ((line: string) => console.log(line));
  if (typeof api.setDefaultAutoSelectFamilyAttemptTimeout !== 'function') {
    log('[Net] connect attempt timeout cannot be changed on this Node version; Node default stays');
    return { status: 'unsupported' };
  }
  const previous = typeof api.getDefaultAutoSelectFamilyAttemptTimeout === 'function'
    ? api.getDefaultAutoSelectFamilyAttemptTimeout()
    : null;
  const wanted = wantedAttemptTimeoutMs(deps.env ?? process.env);
  if (!wanted.fromEnv && previous !== null && previous >= wanted.ms) {
    log(`[Net] connect attempt timeout ${previous} ms (already set; BotBoy keeps it)`);
    return { status: 'kept', timeoutMs: previous, previousMs: previous };
  }
  api.setDefaultAutoSelectFamilyAttemptTimeout(wanted.ms);
  log(`[Net] connect attempt timeout ${wanted.ms} ms (Node default ${NODE_DEFAULT_ATTEMPT_TIMEOUT_MS}${wanted.fromEnv ? `; set by ${NET_ATTEMPT_TIMEOUT_ENV}` : ''})`);
  return { status: 'set', timeoutMs: wanted.ms, previousMs: previous };
}
