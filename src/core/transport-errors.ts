/**
 * What a failed network request tells us, for the two OAuth exchanges that use
 * a single-use code (Google, Slack): which errno codes it carried, and whether
 * the request provably never reached the server (then ONE retry is safe).
 *
 * Node nests the codes: fetch throws `TypeError: fetch failed` whose `cause`
 * holds the errno; a failed happy-eyeballs connect is an AggregateError whose
 * `errors` list one entry per address (the owner's Mac: ETIMEDOUT for IPv4 and
 * EHOSTUNREACH for IPv6, both with syscall `connect`); an axios error (Slack's
 * client) keeps the original under `cause`. Messages never carry a token.
 */

/** Errnos that mean the connection never opened, so nothing was sent. */
export const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Codes that allow ONE retry of a single-use exchange: the never-connected set
 * plus ETIMEDOUT (a connect attempt that ran out of time) and ECONNRESET
 * (reset before any response). If the server did see the first request, the
 * retry only earns `invalid_grant`, which is no worse than not retrying.
 */
export const CONNECT_PHASE_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  ...NEVER_CONNECTED_CODES, 'ETIMEDOUT', 'ECONNRESET',
]);

/** One pause before the single retry. */
export const CONNECT_RETRY_BACKOFF_MS = 1500;

const MAX_DEPTH = 4;
const MAX_CODES = 6;

function cleanCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/[^A-Z0-9_]/gi, '').slice(0, 40);
  return code ? code : null;
}

/**
 * Every errno-style code on an error and the errors it wraps (`cause`,
 * `original`, `errors[]`), first seen first, without repeats.
 */
export function transportCodesOf(error: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH || seen.has(value) || found.length >= MAX_CODES) return;
    seen.add(value);
    const node = value as { code?: unknown; cause?: unknown; original?: unknown; errors?: unknown };
    const code = cleanCode(node.code);
    if (code && !found.includes(code)) found.push(code);
    visit(node.cause, depth + 1);
    visit(node.original, depth + 1);
    if (Array.isArray(node.errors)) for (const inner of node.errors.slice(0, MAX_CODES)) visit(inner, depth + 1);
  };
  visit(error, 0);
  return found;
}

/** True when every code is one that proves the request did not reach the server. */
export function allConnectPhase(codes: readonly string[]): boolean {
  return codes.length > 0 && codes.every(code => CONNECT_PHASE_RETRYABLE_CODES.has(code));
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * Runs `run`; when it fails for a reason `shouldRetry` accepts, waits
 * `backoffMs` and runs it once more (at most `retries` times). Any other
 * failure, and the last failure, are thrown unchanged.
 */
export async function retryAfterBackoff<T>(
  run: () => Promise<T>,
  options: {
    shouldRetry: (error: unknown) => boolean;
    backoffMs?: number;
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown) => void;
  },
): Promise<T> {
  const retries = options.retries ?? 1;
  const pause = options.sleep ?? sleepMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= retries || !options.shouldRetry(error)) throw error;
      options.onRetry?.(error);
      await pause(options.backoffMs ?? CONNECT_RETRY_BACKOFF_MS);
    }
  }
}
