/**
 * Sentry session priming for Datanet-backed MCP servers (a2-analytics).
 *
 * The Datanet service (datanet-service.amazon.com) sits behind Sentry SSO
 * with `acr_values=kerberos`: a PLAIN Midway cookie is not enough, and the
 * a2-analytics server's own bootstrap (curl with the Midway jar) succeeds
 * only when the jar already carries amzn_sso_* session rows for the service.
 * `mwinit` alone never writes those rows; `mwinit -o -s` does, and so does
 * any authenticated Kerberos hop against the service itself.
 *
 * That second fact is the whole point of this module: on a machine with a
 * live Kerberos ticket (normal on a logged-in Amazon Mac), one silent
 * `curl --negotiate` GET mints the Sentry session cookies INTO the shared
 * jar without any owner interaction (verified live 2026-08-27 against
 * jobRunResults). So the correct first response to a Sentry-shaped auth
 * failure is a quiet re-prime — the owner-facing mwinit terminal is the
 * fallback when Kerberos itself is gone, not the first move.
 *
 * Security posture: fixed argv (no shell), the jar path is code-owned, no
 * cookie VALUES are ever read into messages — callers only learn ok/failed.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Fixed prime target: any authenticated GET on the service works. The
 * probe endpoint is harmless without a run id and still exercises Sentry. */
const DATANET_SERVICE_ORIGIN = 'https://datanet-service.amazon.com';
const PRIME_PATH = '/';
const PRIME_TIMEOUT_MS = 30_000;

export type SentryPrimeOutcome =
  | { ok: true }
  | { ok: false; reason: 'no_kerberos' | 'curl_failed' | 'timeout' };

/**
 * Auth-failure signatures specific to the Datanet/Sentry path, beyond the
 * generic 401/403 shapes the Midway sentinel already matches. The a2 server
 * wraps failures in its own JSON envelope, so these appear inside
 * `message`/tool text rather than as transport errors.
 */
export function isSentryAuthShapedError(text: string | null | undefined): boolean {
  if (!text) return false;
  return /SentryRedirectException|sentry\.amazon\.com\/SSO\/redirect|HTTP Status 401|Non-JSON response.{0,40}(401|<!doctype)|NotAuthorizedException|mwinit/i.test(text);
}

/** True when the shared Midway jar already holds an unexpired Sentry session
 * row for the Datanet service (cheap pre-check to skip needless primes).
 * Only domains, names, and expiries are read — never values. */
export function hasLiveDatanetSentryCookie(
  cookiePath = path.join(os.homedir(), '.midway', 'cookie'),
  nowMs = Date.now(),
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(cookiePath, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    let entry = line.trim();
    if (!entry) continue;
    if (entry.startsWith('#HttpOnly_')) entry = entry.slice('#HttpOnly_'.length);
    else if (entry.startsWith('#')) continue;
    const fields = entry.split(/\t+|\s{2,}|\s/).filter(Boolean);
    if (fields.length < 6) continue;
    const [domain, , , , expiryRaw, name] = fields;
    if (!domain.toLowerCase().includes('datanet-service.amazon.com')) continue;
    if (!/^amzn_sso/i.test(name)) continue;
    const expiry = Number(expiryRaw);
    // Session cookies are written with expiry 0 — treat as live; Sentry
    // enforces its own server-side lifetime.
    if (expiry === 0) return true;
    if (Number.isFinite(expiry) && expiry * 1000 > nowMs) return true;
  }
  return false;
}

/**
 * Silently mint/refresh the Sentry session cookies in the shared Midway jar
 * using the local Kerberos ticket. Resolves ok when the hop completed and a
 * live session row is present afterwards. Never throws.
 */
export function primeDatanetSentrySession(
  cookiePath = path.join(os.homedir(), '.midway', 'cookie'),
  runner: typeof spawn = spawn,
): Promise<SentryPrimeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: SentryPrimeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // --negotiate -u : = SPNEGO with the ambient Kerberos ticket; -b/-c on
    // the SAME jar so the minted rows land where the a2 bootstrap reads.
    const child = runner('curl', [
      '-s', '-o', '/dev/null',
      '--negotiate', '-u', ':',
      '--location-trusted',
      '--max-time', String(Math.floor(PRIME_TIMEOUT_MS / 1000) - 5),
      '-b', cookiePath, '-c', cookiePath,
      `${DATANET_SERVICE_ORIGIN}${PRIME_PATH}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500);
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, reason: 'timeout' });
    }, PRIME_TIMEOUT_MS);
    child.on('error', () => finish({ ok: false, reason: 'curl_failed' }));
    child.on('exit', () => {
      if (hasLiveDatanetSentryCookie(cookiePath)) {
        finish({ ok: true });
        return;
      }
      // curl exits 0 even on a 401 without --fail; distinguish "no ticket"
      // for the caller so the sentinel can pick the right owner guidance.
      const noTicket = /gss|kerberos|credentials?\s+cache|no credentials/i.test(stderrTail);
      finish({ ok: false, reason: noTicket ? 'no_kerberos' : 'curl_failed' });
    });
  });
}
