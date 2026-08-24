import { describe, it, expect, vi } from 'vitest';
import { createOAuthClientCredentialsAuthorizer } from './oauth-authorizer.js';

/**
 * OAuth client-credentials authorizer: teammates without AWS access run
 * BotBoy against the authenticated gateway with a client id/secret. These
 * tests pin the token-endpoint wire contract (Basic auth + form body), the
 * cache/refresh behavior that keeps one JWT per 24h instead of per request,
 * and the invalidate() hook the LLM client uses to heal from revocation.
 */

function tokenResponse(token: string, expiresIn = 86400) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' }),
    text: async () => '',
  } as unknown as Response;
}

function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

describe('createOAuthClientCredentialsAuthorizer', () => {
  it('mints via Basic auth + client_credentials form body and returns a Bearer header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'client-a',
      clientSecret: 'secret-a',
      scope: 'botboy-llm/invoke',
      fetchImpl,
    });

    const headers = await auth({ url: 'https://gw.test/v1/responses', method: 'POST' });

    expect(headers).toEqual({ Authorization: 'Bearer tok-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://issuer.test/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const expectedBasic = Buffer.from('client-a:secret-a').toString('base64');
    expect(init.headers.Authorization).toBe(`Basic ${expectedBasic}`);
    const params = new URLSearchParams(init.body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('scope')).toBe('botboy-llm/invoke');
  });

  it('omits the scope parameter when not configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
    });
    await auth({ url: 'https://gw.test', method: 'GET' });
    const params = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(params.has('scope')).toBe(false);
  });

  it('caches the token across requests and refreshes once expiry (minus skew) passes', async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse('tok-1', 3600))
      .mockResolvedValueOnce(tokenResponse('tok-2', 3600));
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'c',
      clientSecret: 's',
      refreshSkewSeconds: 60,
      fetchImpl,
      now: () => clock,
    });
    const req = { url: 'https://gw.test', method: 'POST' as const };

    expect(await auth(req)).toEqual({ Authorization: 'Bearer tok-1' });
    clock += (3600 - 61) * 1000; // still inside the refresh window
    expect(await auth(req)).toEqual({ Authorization: 'Bearer tok-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 2_000; // past expires_in - skew
    expect(await auth(req)).toEqual({ Authorization: 'Bearer tok-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent first requests into one mint', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>(res => { release = res; });
    const fetchImpl = vi.fn().mockReturnValue(gate);
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
    });
    const req = { url: 'https://gw.test', method: 'POST' as const };

    const inFlight = Promise.all([auth(req), auth(req), auth(req)]);
    release(tokenResponse('tok-shared'));
    const results = await inFlight;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const h of results) expect(h).toEqual({ Authorization: 'Bearer tok-shared' });
  });

  it('invalidate() drops the cache so the next request mints fresh', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse('tok-revoked'))
      .mockResolvedValueOnce(tokenResponse('tok-fresh'));
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
    });
    const req = { url: 'https://gw.test', method: 'POST' as const };

    expect(await auth(req)).toEqual({ Authorization: 'Bearer tok-revoked' });
    auth.invalidate?.();
    expect(await auth(req)).toEqual({ Authorization: 'Bearer tok-fresh' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('applies the minimum cache floor when expires_in is tiny, preventing mint-per-request', async () => {
    let clock = 0;
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('tok-short', 5));
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
      now: () => clock,
    });
    const req = { url: 'https://gw.test', method: 'POST' as const };

    await auth(req);
    clock += 10_000; // past raw expires_in, inside the 30s floor
    await auth(req);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces token-endpoint failures without leaking the client secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      errorResponse(400, '{"error":"invalid_client"}'),
    );
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'c',
      clientSecret: 'super-secret-value',
      fetchImpl,
    });

    await expect(auth({ url: 'https://gw.test', method: 'POST' }))
      .rejects.toThrow(/OAuth token request failed: HTTP 400.*invalid_client/);
    try {
      await auth({ url: 'https://gw.test', method: 'POST' });
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-value');
    }
  });

  it('rejects a token response missing access_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ token_type: 'Bearer' }), text: async () => '',
    } as unknown as Response);
    const auth = createOAuthClientCredentialsAuthorizer({
      tokenUrl: 'https://issuer.test/oauth2/token',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
    });
    await expect(auth({ url: 'https://gw.test', method: 'POST' }))
      .rejects.toThrow('OAuth token response missing access_token');
  });

  it('requires tokenUrl, clientId, and clientSecret up front', () => {
    expect(() => createOAuthClientCredentialsAuthorizer({
      tokenUrl: ' ', clientId: 'c', clientSecret: 's',
    })).toThrow('OAuth authorizer requires tokenUrl, clientId, and clientSecret');
  });
});
