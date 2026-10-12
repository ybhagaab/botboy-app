/**
 * A fake Slack Web API for Sign in with Slack tests: answers oauth.v2.access
 * and auth.test on a loopback port and records every request body.
 */

import http from 'http';
import type { AddressInfo } from 'net';

export interface FakeSlackServer {
  url: string;
  requests: Array<{ method: string; body: Record<string, string>; authorization: string }>;
  /** Next oauth.v2.access answer. */
  access: Record<string, unknown>;
  /** auth.test answer per token. */
  authTest: (token: string) => Record<string, unknown>;
  /** The next N requests are read, then their connection is dropped without an answer (a reset). */
  dropNext: number;
  /** Requests are read but never answered (the client's deadline decides). */
  hang: boolean;
  close(): Promise<void>;
}

export const FAKE_SLACK_USER_TOKEN = 'xoxp-fake-0000-token';

export async function startFakeSlack(): Promise<FakeSlackServer> {
  const fake: Omit<FakeSlackServer, 'url' | 'close'> = {
    requests: [],
    access: { ok: true, authed_user: { id: 'U1', access_token: FAKE_SLACK_USER_TOKEN, token_type: 'user' }, team: { id: 'T1', name: 'Team' } },
    authTest: token => (token === FAKE_SLACK_USER_TOKEN ? { ok: true, user: 'owner', team: 'Acme' } : { ok: false, error: 'invalid_auth' }),
    dropNext: 0,
    hang: false,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\/+/, '').split('?')[0];
      const body = Object.fromEntries(new URLSearchParams(raw));
      const authorization = String(req.headers.authorization ?? '');
      fake.requests.push({ method, body, authorization });
      if (fake.hang) return;
      if (fake.dropNext > 0) {
        fake.dropNext--;
        req.socket.destroy();
        return;
      }
      let answer: Record<string, unknown>;
      if (method === 'oauth.v2.access') answer = fake.access;
      else if (method === 'auth.test') answer = fake.authTest(authorization.replace(/^Bearer\s+/i, '') || body.token || '');
      else answer = { ok: false, error: 'unknown_method' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  }) as FakeSlackServer;
}
