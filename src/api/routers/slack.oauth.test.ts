import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlackRouter, SLACK_OAUTH_CALLBACK_PATH } from './slack.js';
import { createSlackCredentialStore } from '../../core/slack-credentials.js';
import { createSlackOAuthStateStore, slackRedirectUri, SLACK_USER_SCOPES } from '../../core/slack-oauth.js';
import { FAKE_SLACK_USER_TOKEN, startFakeSlack, type FakeSlackServer } from '../../core/slack-oauth.fake.js';
import { readLocalEnvValue } from '../../core/local-env.js';
import type { RouterDeps, SlackOAuthService } from './deps.js';

const CLIENT = { clientId: '1234567890.9876543210', clientSecret: '0123456789abcdef0123456789abcdef' };
const ORIGIN = 'http://127.0.0.1';

describe('Sign in with Slack routes', () => {
  let home: string;
  let previousHome: string | undefined;
  let fake: FakeSlackServer;
  let oauth: SlackOAuthService;
  let reload: ReturnType<typeof vi.fn>;
  let app: express.Express;
  let saved: string[];

  beforeEach(async () => {
    previousHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-oauth-route-'));
    process.env.HOME = home;
    fake = await startFakeSlack();
    saved = [];
    oauth = {
      credentials: createSlackCredentialStore({ privateRoot: path.join(home, '.personal-productivity-tracker') }),
      states: createSlackOAuthStateStore(),
      redirectUri: mode => slackRedirectUri(4567, mode, SLACK_OAUTH_CALLBACK_PATH),
      slackApiUrl: fake.url,
      onTokenSaved: token => { saved.push(token); },
    };
    reload = vi.fn().mockResolvedValue({ captureMode: 'poll' });
    const monitor = { reloadUserToken: reload, getCaptureMode: () => 'poll' } as unknown as RouterDeps['slackMonitor'];
    app = express();
    app.use(express.json());
    app.use('/api', createSlackRouter({ nodeManager: {} as any, slackOAuth: oauth, slackMonitor: monitor }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.close();
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // supertest binds an ephemeral port; the owner origin must name it.
  const owner = (req: request.Test) => req.set('Sec-Fetch-Site', 'same-origin');
  async function ownerCall(method: 'put' | 'post', url: string, body?: object) {
    // Origin must match the local port; supertest exposes it via the request URL.
    const req = (request(app) as any)[method](url) as request.Test;
    const port = new URL(req.url).port;
    return owner(req.set('Origin', `${ORIGIN}:${port}`)).send(body ?? {});
  }

  it('rejects client save, start, and finish without the same-origin owner UI', async () => {
    expect((await request(app).put('/api/slack/oauth/client').send(CLIENT)).status).toBe(403);
    expect((await request(app).post('/api/slack/oauth/start').send({})).status).toBe(403);
    expect((await request(app).post('/api/slack/oauth/finish').send({ pasted: 'abc12345' })).status).toBe(403);
    expect(oauth.credentials.read().client).toBeUndefined();
  });

  it('start needs a saved client (409 slack_client_missing)', async () => {
    const res = await ownerCall('post', '/api/slack/oauth/start');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slack_client_missing');
  });

  it('client view shows redirect URL and scopes, never the secret', async () => {
    expect((await ownerCall('put', '/api/slack/oauth/client', CLIENT)).status).toBe(200);
    const view = await request(app).get('/api/slack/oauth/client');
    expect(view.body.redirectUri).toBe('http://127.0.0.1:4567/api/slack/oauth/callback');
    expect(view.body.userScopes).toEqual([...SLACK_USER_SCOPES]);
    expect(JSON.stringify(view.body)).not.toContain(CLIENT.clientSecret);
    const bad = await ownerCall('put', '/api/slack/oauth/client', { clientId: 'x', clientSecret: CLIENT.clientSecret });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('clientId');
  });

  it('callback with a bad or reused state saves nothing', async () => {
    await ownerCall('put', '/api/slack/oauth/client', CLIENT);
    const res = await request(app).get(`/api${SLACK_OAUTH_CALLBACK_PATH}?code=c1234567&state=forged`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Sign-in expired');
    expect(readLocalEnvValue('SLACK_USER_TOKEN')).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it('callback success saves the token, reloads without restart, and shows the identity', async () => {
    await ownerCall('put', '/api/slack/oauth/client', CLIENT);
    const start = await ownerCall('post', '/api/slack/oauth/start');
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const res = await request(app).get(`/api${SLACK_OAUTH_CALLBACK_PATH}?code=c1234567&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Connected as owner in Acme');
    expect(res.text).not.toContain(FAKE_SLACK_USER_TOKEN);
    expect(readLocalEnvValue('SLACK_USER_TOKEN')).toBe(FAKE_SLACK_USER_TOKEN);
    expect(fs.statSync(path.join(home, '.personal-productivity-tracker', '.env')).mode & 0o777).toBe(0o600);
    expect(reload).toHaveBeenCalledWith(FAKE_SLACK_USER_TOKEN);
    expect(saved).toEqual([FAKE_SLACK_USER_TOKEN]);
    const status = await request(app).get('/api/slack/token/status');
    expect(status.body).toMatchObject({ configured: true, restartPending: false, connectedVia: 'oauth', identity: { user: 'owner', team: 'Acme' } });
    expect(JSON.stringify(status.body)).not.toContain(FAKE_SLACK_USER_TOKEN);
    // The state is single use: replaying the callback saves nothing more.
    const replay = await request(app).get(`/api${SLACK_OAUTH_CALLBACK_PATH}?code=c1234567&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(400);
  });

  it('a Slack that cannot be reached is named as such on the callback page, and nothing is saved', async () => {
    await ownerCall('put', '/api/slack/oauth/client', CLIENT);
    const start = await ownerCall('post', '/api/slack/oauth/start');
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    fake.dropNext = 2; // the first try and its one retry both reset
    const res = await request(app).get(`/api${SLACK_OAUTH_CALLBACK_PATH}?code=c1234567&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Sign-in failed');
    expect(res.text).toContain('Couldn&#39;t reach Slack to finish the sign-in (network error). Nothing was saved. Choose Sign in with Slack again.');
    expect(res.text).not.toContain('refused');
    expect(readLocalEnvValue('SLACK_USER_TOKEN')).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(fake.requests.filter(r => r.method === 'oauth.v2.access')).toHaveLength(2);
  });

  it('a reset that the single retry recovers from still signs in', async () => {
    await ownerCall('put', '/api/slack/oauth/client', CLIENT);
    const start = await ownerCall('post', '/api/slack/oauth/start');
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    fake.dropNext = 1;
    const res = await request(app).get(`/api${SLACK_OAUTH_CALLBACK_PATH}?code=c1234567&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Connected as owner in Acme');
    expect(readLocalEnvValue('SLACK_USER_TOKEN')).toBe(FAKE_SLACK_USER_TOKEN);
  });

  it('a rotating token is refused and nothing is saved', async () => {
    fake.access = { ok: true, authed_user: { access_token: 'xoxp-1-a', refresh_token: 'r', expires_in: 10 } };
    await ownerCall('put', '/api/slack/oauth/client', CLIENT);
    const start = await ownerCall('post', '/api/slack/oauth/start');
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const res = await request(app).get(`/api${SLACK_OAUTH_CALLBACK_PATH}?code=c1234567&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('token rotation');
    expect(readLocalEnvValue('SLACK_USER_TOKEN')).toBeUndefined();
  });

  it('https paste flow sends the byte-identical https redirect_uri', async () => {
    await ownerCall('put', '/api/slack/oauth/client', { ...CLIENT, redirectMode: 'https_paste' });
    const start = await ownerCall('post', '/api/slack/oauth/start');
    const authorize = new URL(start.body.authorizeUrl);
    const redirect = authorize.searchParams.get('redirect_uri')!;
    expect(redirect).toBe('https://127.0.0.1:4567/api/slack/oauth/callback');
    const pasted = `${redirect}?code=c7654321&state=${authorize.searchParams.get('state')}`;
    const res = await ownerCall('post', '/api/slack/oauth/finish', { pasted });
    expect(res.status).toBe(200);
    expect(res.body.identity).toEqual({ user: 'owner', team: 'Acme' });
    expect(fake.requests.find(r => r.method === 'oauth.v2.access')!.body.redirect_uri).toBe(redirect);
  });

  it('finish with a mismatched state fails closed', async () => {
    await ownerCall('put', '/api/slack/oauth/client', CLIENT);
    await ownerCall('post', '/api/slack/oauth/start');
    const res = await ownerCall('post', '/api/slack/oauth/finish', { pasted: 'https://127.0.0.1:4567/api/slack/oauth/callback?code=c1234567&state=other' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('state_mismatch');
    expect(readLocalEnvValue('SLACK_USER_TOKEN')).toBeUndefined();
  });

  it('token PUT reloads the monitor and drops restartRequired', async () => {
    const res = await request(app).put('/api/slack/token').send({ token: FAKE_SLACK_USER_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('restartRequired');
    expect(reload).toHaveBeenCalledWith(FAKE_SLACK_USER_TOKEN);
    const status = await request(app).get('/api/slack/token/status');
    expect(status.body.connectedVia).toBe('token');
  });

  it('a reload failure keeps the token and reports reloadError', async () => {
    reload.mockRejectedValueOnce(new Error('socket boom'));
    const res = await request(app).put('/api/slack/token').send({ token: FAKE_SLACK_USER_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.reloadError).toContain('restart BotBoy');
    expect(readLocalEnvValue('SLACK_USER_TOKEN')).toBe(FAKE_SLACK_USER_TOKEN);
  });
});
