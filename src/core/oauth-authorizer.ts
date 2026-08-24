import type { LlmRequestAuthorizer } from './llm-client.js';

/**
 * OAuth 2.0 client-credentials authorizer for the authenticated LLM gateway.
 *
 * Teammates run BotBoy with a client id/secret pair instead of AWS
 * credentials. This module exchanges that pair at the issuer's token endpoint
 * (RFC 6749 §4.4 — Basic auth, form body) and caches the resulting bearer
 * token until shortly before expiry, so each LLM request reuses one JWT
 * instead of minting per call. `invalidate()` drops the cache; the LLM client
 * calls it once when a request comes back 401 (revoked client, rotated
 * secret) and retries with a freshly minted token.
 */
export interface OAuthClientCredentialsConfig {
  /** Issuer token endpoint, e.g. https://{domain}.auth.{region}.amazoncognito.com/oauth2/token */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional space-separated scopes, e.g. "botboy-llm/invoke". */
  scope?: string;
  /** Seconds subtracted from expires_in before a proactive refresh (default 60). */
  refreshSkewSeconds?: number;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Minimum cache lifetime so a tiny/absent expires_in cannot cause mint-per-request loops. */
const MIN_CACHE_MS = 30_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export function createOAuthClientCredentialsAuthorizer(
  config: OAuthClientCredentialsConfig,
): LlmRequestAuthorizer {
  const tokenUrl = config.tokenUrl.trim();
  const clientId = config.clientId.trim();
  const clientSecret = config.clientSecret.trim();
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error('OAuth authorizer requires tokenUrl, clientId, and clientSecret');
  }
  const skewMs = Math.max(0, config.refreshSkewSeconds ?? 60) * 1000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let cached: { token: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    if (config.scope?.trim()) params.set('scope', config.scope.trim());
    const resp = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // Token-endpoint error bodies describe the grant failure and never
      // contain the client secret; truncate defensively anyway.
      const detail = (await resp.text().catch(() => '')).slice(0, 200);
      throw new Error(`OAuth token request failed: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`);
    }
    const data = await resp.json() as TokenResponse;
    if (!data.access_token) {
      throw new Error('OAuth token response missing access_token');
    }
    const lifetimeMs = Math.max(MIN_CACHE_MS, (data.expires_in ?? 3600) * 1000 - skewMs);
    cached = { token: data.access_token, expiresAtMs: now() + lifetimeMs };
    return data.access_token;
  }

  async function currentToken(): Promise<string> {
    if (cached && now() < cached.expiresAtMs) return cached.token;
    // Single-flight: concurrent requests during a refresh share one mint.
    if (!inflight) {
      inflight = mint().finally(() => { inflight = null; });
    }
    return inflight;
  }

  const authorizer: LlmRequestAuthorizer = async () => ({
    Authorization: `Bearer ${await currentToken()}`,
  });
  authorizer.invalidate = () => { cached = null; };
  return authorizer;
}
