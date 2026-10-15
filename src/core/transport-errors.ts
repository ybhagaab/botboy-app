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
 *
 * The same codes word a provider failure for the people who read it (D2 of the DeepSeek diagnosability fixes): a bare
 * `fetch failed` hid ETIMEDOUT, ENOTFOUND or a certificate failure, which are different fixes. See
 * `withTransportCodes` and `transportFailureDetail`.
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

/**
 * Certificate failures that mean something between this Mac and the provider presents ITS OWN certificate: a
 * TLS-inspecting proxy or a security product. Node trusts its bundled authorities, not the macOS keychain where such a
 * product installs its own, so every request fails the same way. (start.sh › doctor_ai_model_rows keeps the same list.)
 */
export const TLS_INTERCEPTION_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED',
]);

/** What a certificate-interception code means, in words. */
export const TLS_INTERCEPTION_WORDS = "a proxy or security product on this network replaces the provider's TLS certificate, and BotBoy does not trust the replacement";

export function hasTlsInterceptionCode(codes: readonly string[]): boolean {
  return codes.some(code => TLS_INTERCEPTION_CODES.has(code));
}

/**
 * The cause of a failed request as one credential-free phrase: `ETIMEDOUT+EHOSTUNREACH`, or for a certificate
 * interception `DEPTH_ZERO_SELF_SIGNED_CERT: a proxy or security product … `. Empty when no code is known.
 * Codes only: no URL, header or key ever passes through here.
 */
export function transportFailureDetail(codes: readonly string[]): string {
  if (!codes.length) return '';
  const joined = codes.join('+');
  return hasTlsInterceptionCode(codes) ? `${joined}: ${TLS_INTERCEPTION_WORDS}` : joined;
}

/**
 * An error's message with its network cause appended: `fetch failed` → `fetch failed (ETIMEDOUT+EHOSTUNREACH)`.
 * Unchanged when the error carries no code, and idempotent: a message that already names every code (an earlier
 * call, or Node's own `connect ECONNREFUSED 127.0.0.1:9`) is returned as it is.
 */
export function messageWithTransportCodes(error: unknown): string {
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? error ?? '');
  const codes = transportCodesOf(error);
  const detail = transportFailureDetail(codes);
  if (!detail || codes.every(code => message.includes(code))) return message;
  return message ? `${message} (${detail})` : detail;
}

/**
 * The same error object with its message extended by `messageWithTransportCodes`. The object itself is kept (name,
 * `cause`, `code`, stack), so every check on it still works; only the words people read gain the cause that Node
 * keeps one level down (`TypeError: fetch failed` hides the errno in `cause`).
 */
export function withTransportCodes<T>(error: T): T {
  if (!error || typeof error !== 'object') return error;
  const record = error as { message?: unknown };
  if (typeof record.message !== 'string') return error;
  const described = messageWithTransportCodes(error);
  if (described !== record.message) {
    try { record.message = described; } catch { /* a frozen error keeps the message it has */ }
  }
  return error;
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
