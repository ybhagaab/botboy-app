import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLACK_METHOD_SCOPES,
  SLACK_USER_SCOPES,
  SlackOAuthError,
  buildSlackAuthorizeUrl,
  createSlackOAuthStateStore,
  exchangeSlackCode,
  parseFinishPaste,
  slackRedirectUri,
} from './slack-oauth.js';
import { createSlackCredentialStore, validateSlackClient } from './slack-credentials.js';
import { FAKE_SLACK_USER_TOKEN, startFakeSlack, type FakeSlackServer } from './slack-oauth.fake.js';
import { PACKAGE_ROOT, releaseAllowlist, releaseFiles } from './release-allowlist.testutil.js';

const CLIENT = { clientId: '1234567890.9876543210', clientSecret: '0123456789abcdef0123456789abcdef' };

describe('Sign in with Slack: state', () => {
  it('is single use, expires after ten minutes, and rejects unknown values', () => {
    let now = 1_000;
    const states = createSlackOAuthStateStore({ now: () => now });
    const a = states.issue('http://x/cb');
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(states.take(a)).toEqual({ redirectUri: 'http://x/cb' });
    expect(states.take(a)).toBeNull();
    const b = states.issue('http://x/cb');
    now += 10 * 60_000;
    expect(states.take(b)).toBeNull();
    expect(states.take('nope')).toBeNull();
  });
});

describe('Sign in with Slack: authorize URL and redirect', () => {
  it('asks for user_scope only, never scope', () => {
    const url = new URL(buildSlackAuthorizeUrl({ clientId: CLIENT.clientId, redirectUri: 'http://127.0.0.1:7778/api/slack/oauth/callback', state: 's1' }));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('user_scope')).toBe(SLACK_USER_SCOPES.join(','));
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:7778/api/slack/oauth/callback');
  });

  it('builds the redirect from the port for both modes', () => {
    expect(slackRedirectUri(7790, 'http_loopback', '/slack/oauth/callback')).toBe('http://127.0.0.1:7790/api/slack/oauth/callback');
    expect(slackRedirectUri(7790, 'https_paste', '/slack/oauth/callback')).toBe('https://127.0.0.1:7790/api/slack/oauth/callback');
  });
});

describe('Sign in with Slack: Finish sign-in paste', () => {
  it('reads code and state from a pasted URL', () => {
    const states = createSlackOAuthStateStore();
    const state = states.issue('https://127.0.0.1:1/api/slack/oauth/callback');
    expect(parseFinishPaste(`https://127.0.0.1:1/api/slack/oauth/callback?code=abc123456&state=${state}`, states)).toEqual({ code: 'abc123456', state });
  });
  it('fails closed on a URL without state (state_mismatch)', () => {
    const states = createSlackOAuthStateStore();
    states.issue('x');
    expect(() => parseFinishPaste('https://127.0.0.1:1/cb?code=abc123456', states)).toThrow(expect.objectContaining({ code: 'state_mismatch' }));
  });
  it('accepts a bare code only with exactly one live state (else state_required)', () => {
    const states = createSlackOAuthStateStore();
    expect(() => parseFinishPaste('abc123456', states)).toThrow(expect.objectContaining({ code: 'state_required' }));
    const only = states.issue('x');
    expect(parseFinishPaste('abc123456', states)).toEqual({ code: 'abc123456', state: only });
    states.issue('y');
    expect(() => parseFinishPaste('abc123456', states)).toThrow(expect.objectContaining({ code: 'state_required' }));
  });
  it('rejects over-long or empty input (invalid_paste)', () => {
    const states = createSlackOAuthStateStore();
    expect(() => parseFinishPaste('', states)).toThrow(expect.objectContaining({ code: 'invalid_paste' }));
    expect(() => parseFinishPaste(`https://x/?code=${'a'.repeat(5000)}`, states)).toThrow(expect.objectContaining({ code: 'invalid_paste' }));
  });
});

describe('Sign in with Slack: exchange against a fake Slack', () => {
  let fake: FakeSlackServer;
  let logs: string[];
  beforeEach(async () => {
    fake = await startFakeSlack();
    logs = [];
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
  });
  afterEach(async () => { vi.restoreAllMocks(); await fake.close(); });
  const run = () => exchangeSlackCode({ ...CLIENT, code: 'the-code-1', redirectUri: 'https://127.0.0.1:7/api/slack/oauth/callback', slackApiUrl: fake.url });

  it('returns the user token and identity, sending the exact redirect_uri', async () => {
    const result = await run();
    expect(result).toEqual({ token: FAKE_SLACK_USER_TOKEN, identity: { user: 'owner', team: 'Acme' } });
    const access = fake.requests.find(r => r.method === 'oauth.v2.access')!;
    expect(access.body.redirect_uri).toBe('https://127.0.0.1:7/api/slack/oauth/callback');
    expect(access.body.code).toBe('the-code-1');
    const joined = logs.join('\n');
    expect(joined).not.toContain(FAKE_SLACK_USER_TOKEN);
    expect(joined).not.toContain(CLIENT.clientSecret);
    expect(joined).not.toContain('the-code-1');
  });
  it('maps ok:false to exchange_failed', async () => {
    fake.access = { ok: false, error: 'invalid_code' };
    await expect(run()).rejects.toMatchObject({ code: 'exchange_failed' });
  });
  it('maps access_denied from Slack to exchange_failed without saving anything', async () => {
    fake.access = { ok: false, error: 'access_denied' };
    await expect(run()).rejects.toBeInstanceOf(SlackOAuthError);
  });
  it('refuses a rotating token (rotation_enabled)', async () => {
    fake.access = { ok: true, authed_user: { access_token: 'xoxe.xoxp-1-abc', refresh_token: 'xoxe-1-r', expires_in: 43200 } };
    await expect(run()).rejects.toMatchObject({ code: 'rotation_enabled' });
  });
  it('fails when auth.test rejects the token (auth_test_failed)', async () => {
    fake.authTest = () => ({ ok: false, error: 'invalid_auth' });
    await expect(run()).rejects.toMatchObject({ code: 'auth_test_failed' });
  });
});

/**
 * The sign-in code is single use. A call that never reached Slack (a reset,
 * a refused or unreachable connection) is sent once more; after Slack answered
 * or the deadline passed it is not. A transport failure is named as one:
 * before, it read "Slack refused the sign-in (request_failed)".
 */
describe('Sign in with Slack: transport failures', () => {
  let fake: FakeSlackServer;
  let pauses: number[];
  let warnings: string[];
  beforeEach(async () => {
    fake = await startFakeSlack();
    pauses = [];
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  });
  afterEach(async () => { vi.restoreAllMocks(); await fake.close(); });
  const run = (extra: Partial<Parameters<typeof exchangeSlackCode>[0]> = {}) => exchangeSlackCode({
    ...CLIENT, code: 'the-code-1', redirectUri: 'https://127.0.0.1:7/api/slack/oauth/callback', slackApiUrl: fake.url,
    sleep: async ms => { pauses.push(ms); }, ...extra,
  });
  const accessCalls = () => fake.requests.filter(r => r.method === 'oauth.v2.access');

  it('sends the code once more after a reset before any answer, then signs in', async () => {
    fake.dropNext = 1;
    const result = await run();
    expect(result.token).toBe(FAKE_SLACK_USER_TOKEN);
    expect(accessCalls()).toHaveLength(2);
    expect(accessCalls()[1].body.code).toBe(accessCalls()[0].body.code);
    expect(pauses).toEqual([1500]);
    expect(warnings.join('\n')).toContain('could not reach Slack; trying once more');
  });

  it('stops after that one retry and says Slack could not be reached, with nothing saved', async () => {
    fake.dropNext = 2;
    const failure = await run().catch(error => error);
    expect(failure).toBeInstanceOf(SlackOAuthError);
    expect(failure.code).toBe('network_error');
    expect(failure.message).toBe("Couldn't reach Slack to finish the sign-in (network error). Nothing was saved. Choose Sign in with Slack again.");
    expect(accessCalls()).toHaveLength(2);
    expect(failure.message).not.toContain('refused');
  });

  it('names a refused connection as unreachable, after its one retry', async () => {
    const closed = await startFakeSlack();
    const deadAddress = closed.url;
    await closed.close();
    const failure = await run({ slackApiUrl: deadAddress }).catch(error => error);
    expect(failure.code).toBe('network_error');
    expect(failure.message).toMatch(/^Couldn't reach Slack to finish the sign-in \(network error\)\. Nothing was saved\./);
    expect(pauses).toEqual([1500]);
  });

  it('never sends the code again after Slack answered, even with a refusal', async () => {
    fake.access = { ok: false, error: 'invalid_code' };
    const failure = await run().catch(error => error);
    expect(failure.code).toBe('exchange_failed');
    expect(failure.message).toBe('Slack refused the sign-in (invalid_code).');
    expect(accessCalls()).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  it('never sends the code again after the deadline, and says Slack did not answer', async () => {
    fake.hang = true;
    const failure = await run({ timeoutMs: 150 }).catch(error => error);
    expect(failure.code).toBe('network_error');
    expect(failure.message).toMatch(/^Couldn't reach Slack to finish the sign-in \(Slack didn't answer within \d+ seconds\)\. Nothing was saved\./);
    expect(accessCalls()).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  it('retries the token check once (it only reads) and names a transport failure there too', async () => {
    const good = { ok: true, authed_user: { id: 'U1', access_token: FAKE_SLACK_USER_TOKEN, token_type: 'user' }, team: { id: 'T1', name: 'Team' } };
    // The sign-in succeeds; the next request, the token check, meets a reset.
    Object.defineProperty(fake, 'access', { configurable: true, get() { fake.dropNext = 1; return good; } });
    expect((await run()).identity).toEqual({ user: 'owner', team: 'Acme' });
    expect(accessCalls()).toHaveLength(1);
    expect(fake.requests.filter(r => r.method === 'auth.test')).toHaveLength(2);

    // Two resets: the token is not saved, and the words say Slack could not be reached.
    fake.requests.length = 0;
    Object.defineProperty(fake, 'access', { configurable: true, get() { fake.dropNext = 2; return good; } });
    const failure = await run().catch(error => error);
    expect(failure.code).toBe('network_error');
    expect(failure.message).toBe("Couldn't reach Slack to check the new token (network error). Nothing was saved. Choose Sign in with Slack again.");
    expect(accessCalls()).toHaveLength(1);
  });
});

describe('Slack app client storage', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-cred-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('validates the client and names the field', () => {
    expect(validateSlackClient(CLIENT)).toEqual(CLIENT);
    expect(() => validateSlackClient({ clientId: 'abc', clientSecret: CLIENT.clientSecret })).toThrow(expect.objectContaining({ field: 'clientId' }));
    expect(() => validateSlackClient({ clientId: CLIENT.clientId, clientSecret: 'short' })).toThrow(expect.objectContaining({ field: 'clientSecret' }));
    expect(() => validateSlackClient({ clientId: `${'1'.repeat(40)}.${'2'.repeat(40)}`, clientSecret: CLIENT.clientSecret })).toThrow(expect.objectContaining({ field: 'clientId' }));
  });
  it('writes slack.json 0600 and the public view never holds the secret', () => {
    const store = createSlackCredentialStore({ privateRoot: root });
    store.saveClient(CLIENT);
    store.recordConnection('oauth', { user: 'owner', team: 'Acme' });
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    const view = JSON.stringify(store.publicView());
    expect(view).not.toContain(CLIENT.clientSecret);
    expect(view).not.toContain(CLIENT.clientId);
    expect(store.publicView()).toMatchObject({ configured: true, clientIdSuffix: '…543210', connectedVia: 'oauth', redirectMode: 'http_loopback' });
    expect(createSlackCredentialStore({ privateRoot: root }).read().client).toEqual(CLIENT);
  });
});

describe('Slack method → scope guard', () => {
  it('every Slack Web API method BotBoy calls has its scope listed', () => {
    const pattern = /\b(conversations|users|reactions|chat|auth|team|search|files|bots)\.([a-zA-Z]+)\(/g;
    for (const rel of ['src/monitors/slack-monitor.ts', 'src/api/routers/slack.ts']) {
      const text = fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
      for (const match of text.matchAll(pattern)) {
        const method = `${match[1]}.${match[2]}`;
        expect(SLACK_METHOD_SCOPES, `${rel} calls ${method}`).toHaveProperty([method]);
      }
    }
    const scopes = new Set<string>(SLACK_USER_SCOPES);
    for (const needed of Object.values(SLACK_METHOD_SCOPES)) for (const scope of needed) expect(scopes.has(scope)).toBe(true);
  });
});

describe('No Slack client credential ships (repos-and-releases.md, D12)', () => {
  it('no allowlisted file holds a Slack token or a client id + secret pair', () => {
    const files = releaseFiles();
    expect(files.length).toBeGreaterThan(50);
    for (const rel of files) {
      const text = fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
      expect(/xox[pbae]-[0-9]{6,}-/.test(text), `${rel} holds a Slack token`).toBe(false);
      expect(/\b\d{6,}\.\d{6,}\b[\s\S]{0,200}\b[0-9a-f]{32}\b/i.test(text), `${rel} holds a Slack client pair`).toBe(false);
    }
  });
  it('slack.json and .env are never allowlisted', () => {
    const list = releaseAllowlist();
    expect(list.some(entry => /slack\.json|\.env\b/.test(entry))).toBe(false);
  });
});

describe('No Google client credential ships (Drive reuses the Gmail client; D12)', () => {
  it('no allowlisted file holds a Google client id or secret', () => {
    for (const rel of releaseFiles()) {
      const text = fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
      expect(/\b\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/.test(text), `${rel} holds a Google client id`).toBe(false);
      expect(/GOCSPX-[A-Za-z0-9_-]{20,}/.test(text), `${rel} holds a Google client secret`).toBe(false);
    }
  });
  it('the built-in Google slot stays empty and Drive adds no slot of its own', async () => {
    const { BOTBOY_GOOGLE_CLIENT } = await import('./gmail-builtin-client.js');
    expect(BOTBOY_GOOGLE_CLIENT).toEqual({ clientId: '', clientSecret: '' });
    const gdrive = fs.readFileSync(path.join(PACKAGE_ROOT, 'src/core/gdrive-api.ts'), 'utf8');
    expect(gdrive).not.toMatch(/clientSecret|client_secret/);
    expect(fs.readFileSync(path.join(PACKAGE_ROOT, 'src/core/slack-oauth.ts'), 'utf8')).not.toMatch(/clientSecret:\s*'[0-9a-f]{32}'/);
  });
});
