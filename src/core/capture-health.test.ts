import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { classifyCaptureFailure, createCaptureHealth, sanitizeCaptureReason } from './capture-health.js';

// Real error texts seen from BotBoy's connectors (URLs shortened).
const MIDWAY_401 = 'Error: Request to IDP URL https://midway-auth.amazon.com/SSO/redirect?client_id=abc&state=xyz&nonce=123 did not redirect. Status code: 401. You may need to authenticate by running mwinit.';
const SHAREPOINT_NOTICE = 'sharepoint_list_shared_with_me returned non-JSON output (=== UNTRUSTED CONTENT BOUNDARY ===\nThe following content comes from';

describe('classifyCaptureFailure', () => {
  it('names the fix the owner must run for a Midway session expiry, ahead of its 401', () => {
    expect(classifyCaptureFailure(MIDWAY_401)).toBe('midway_auth');
    expect(classifyCaptureFailure('AuthorizationClientError.authenticationRequired')).toBe('midway_auth');
  });

  it('separates rate limits, sign-in rejections, network failures, and format changes', () => {
    expect(classifyCaptureFailure('bad response: {"ok":false,"error":"ratelimited"}')).toBe('rate_limited');
    expect(classifyCaptureFailure('r1 status: 429')).toBe('rate_limited');
    expect(classifyCaptureFailure('bad response: {"ok":false,"error":"invalid_auth"}')).toBe('service_auth');
    expect(classifyCaptureFailure('Silent authorize did not return a code (AADSTS50058)')).toBe('service_auth');
    expect(classifyCaptureFailure('sharepoint_list_shared_with_me failed: Error: getaddrinfo ENOTFOUND amazon-my.sharepoint.com')).toBe('network');
    expect(classifyCaptureFailure('inbox: MCP error -32603: API request failed with status 504')).toBe('network');
    expect(classifyCaptureFailure(SHAREPOINT_NOTICE)).toBe('unexpected_response');
    expect(classifyCaptureFailure('docx comments response was not JSON')).toBe('unexpected_response');
    expect(classifyCaptureFailure('SharePoint connection: profile incompatible')).toBe('unexpected_response');
  });

  it('LIVE (2026-10-03): GRASP’s expired-session reply is a sign-in failure, not unknown', () => {
    const graspExpired = 'inbox: get_emails failed: Authentication failed — your session has expired or no valid tokens are available.\n\nTo fix this, run the following command in another terminal:\n  grasp-mcp login\n\nThen retry this operation. No server restart is needed.';
    expect(classifyCaptureFailure(graspExpired)).toBe('service_auth');
    // Its first reply in the same outage named mwinit, which stays Midway.
    expect(classifyCaptureFailure('inbox: API request failed with status 401: {"message":"Unauthenticated","desc":"You should authenticate (may use mwinit)"}')).toBe('midway_auth');
  });

  it('classifies the Gmail client’s own failure texts', () => {
    // gmail-api.ts › send / tokenError / apiError
    expect(classifyCaptureFailure('Gmail message failed: network error')).toBe('network');
    expect(classifyCaptureFailure('Gmail history failed: network error (ECONNRESET)')).toBe('network');
    expect(classifyCaptureFailure('Gmail message list timed out after 30s')).toBe('network');
    expect(classifyCaptureFailure('Gmail token refresh failed (HTTP 400 invalid_grant: Token has been expired or revoked.). Google ended BotBoy’s access to this account (revoked, expired, or the password changed). Choose Reconnect.')).toBe('service_auth');
    expect(classifyCaptureFailure('Gmail message failed (HTTP 403 userRateLimitExceeded: User-rate limit exceeded)')).toBe('rate_limited');
    expect(classifyCaptureFailure('Gmail message failed (HTTP 429 rateLimitExceeded)')).toBe('rate_limited');
    expect(classifyCaptureFailure('Gmail profile failed (HTTP 503 backendError)')).toBe('network');
    expect(classifyCaptureFailure('Gmail history returned an unreadable (non-JSON) response (HTTP 502)')).toBe('network');
  });

  it('recognizes a connection that is not running, and leaves the rest unknown', () => {
    expect(classifyCaptureFailure('no active transport — start the Slack MCP connection')).toBe('connector_down');
    expect(classifyCaptureFailure('SharePoint connection: profile stopped')).toBe('connector_down');
    expect(classifyCaptureFailure('something odd happened')).toBe('unknown');
  });
});

describe('sanitizeCaptureReason', () => {
  it('keeps only the host of URLs (nonces and state stay out) and redacts secret formats', () => {
    const cleaned = sanitizeCaptureReason(MIDWAY_401);
    expect(cleaned).toContain('<midway-auth.amazon.com>');
    expect(cleaned).not.toMatch(/nonce|state=|client_id/);
    const withToken = sanitizeCaptureReason(`Authorization: Bearer ${'a1B2'.repeat(10)}`);
    expect(withToken).toContain('[REDACTED]');
    expect(sanitizeCaptureReason('x'.repeat(1000))).toHaveLength(240);
  });
});

describe('capture health streaks', () => {
  let storage: StorageLayer;
  let clock: { value: number };
  const minutes = (count: number) => count * 60_000;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    clock = { value: Date.parse('2026-10-02T08:00:00Z') };
  });
  afterEach(() => storage.close());

  const make = () => createCaptureHealth({ db: storage.getDb(), now: () => clock.value });

  it('warns only once a streak outlasts the source cadence, and a success clears it', () => {
    const health = make();
    health.reportSuccess('sharepoint');
    clock.value += minutes(30);
    health.reportFailure('sharepoint', { kind: 'unexpected_response', reason: SHAREPOINT_NOTICE });
    expect(health.issues()).toEqual([]);

    clock.value += minutes(30);
    health.reportFailure('sharepoint', { kind: 'unexpected_response', reason: SHAREPOINT_NOTICE });
    const [issue] = health.issues();
    expect(issue).toMatchObject({
      source: 'sharepoint',
      name: 'SharePoint documents',
      kind: 'unexpected_response',
      failures: 2,
      since: '2026-10-02T08:30:00.000Z',
      lastSuccessAt: '2026-10-02T08:00:00.000Z',
      href: '#/connections/document-sync',
    });
    expect(issue.nextAction).toMatch(/Update BotBoy/);

    health.reportSuccess('sharepoint');
    expect(health.issues()).toEqual([]);
    expect(health.sources().find(entry => entry.source === 'sharepoint')).toMatchObject({
      consecutiveFailures: 0, failingSince: null, kind: null,
    });
  });

  it('raises a Midway expiry at once and exposes it to the sentinel', () => {
    const health = make();
    health.reportFailure('slack', { kind: 'midway_auth', reason: MIDWAY_401 });
    const [issue] = health.issues();
    expect(issue.kind).toBe('midway_auth');
    expect(issue.nextAction).toMatch(/mwinit/);
    expect(issue.reason).not.toMatch(/nonce/);
    expect(health.needsMidwayReauth('slack')).toBe(true);
    expect(health.needsMidwayReauth('grasp')).toBe(false);
    // A report from before the sentinel's last recovery does not count.
    expect(health.needsMidwayReauth('slack', clock.value)).toBe(false);
    expect(health.needsMidwayReauth('slack', clock.value - 1)).toBe(true);
  });

  it('tells the owner GRASP’s own sign-in fix, without a restart it says it does not need', () => {
    const health = make();
    health.reportFailure('grasp', { kind: 'service_auth', reason: 'Authentication failed — your session has expired or no valid tokens are available.' });
    clock.value += minutes(11);
    health.reportFailure('grasp', { kind: 'service_auth', reason: 'Authentication failed — your session has expired or no valid tokens are available.' });
    const [issue] = health.issues();
    expect(issue).toMatchObject({ source: 'grasp', kind: 'service_auth' });
    expect(issue.nextAction).toMatch(/mwinit/);
    expect(issue.nextAction).toMatch(/grasp-mcp login/);
    expect(issue.nextAction).not.toMatch(/Restart/);
  });

  it('sends a lasting Gmail sign-in failure to Reconnect, not to Midway', () => {
    const health = make();
    const reason = 'Gmail token refresh failed (HTTP 400 invalid_grant: Token has been expired or revoked.)';
    health.reportFailure('gmail', { kind: classifyCaptureFailure(reason), reason });
    expect(health.issues()).toEqual([]);
    clock.value += minutes(11);
    health.reportFailure('gmail', { kind: classifyCaptureFailure(reason), reason });
    const [issue] = health.issues();
    expect(issue).toMatchObject({ source: 'gmail', name: 'Gmail', kind: 'service_auth', href: '#/connections/gmail-sync', failures: 2 });
    expect(issue.nextAction).toMatch(/Connections → Gmail.*Reconnect/);
    expect(issue.nextAction).not.toMatch(/mwinit/);
    expect(health.needsMidwayReauth('gmail')).toBe(false);
    expect(health.sources().map(entry => entry.source)).toContain('gmail');
  });

  it('changes its version when a warning appears by age alone and when it clears', () => {
    const health = make();
    const initial = health.version();
    health.reportFailure('slack', { kind: 'network', reason: 'getaddrinfo ENOTFOUND slack.com' });
    clock.value += minutes(2);
    health.reportFailure('slack', { kind: 'network', reason: 'getaddrinfo ENOTFOUND slack.com' });
    expect(health.version()).toBe(initial);

    clock.value += minutes(4); // no new report: the streak is simply older now
    const warned = health.version();
    expect(warned).not.toBe(initial);
    expect(health.issues().map(issue => issue.source)).toEqual(['slack']);
    expect(health.version()).toBe(warned);

    health.reportSuccess('slack');
    expect(health.version()).not.toBe(warned);
  });

  it('keeps the streak and last success across a restart', () => {
    const first = make();
    first.reportSuccess('grasp');
    clock.value += minutes(5);
    first.reportFailure('grasp', { kind: 'service_auth', reason: 'HTTP 401 Unauthorized' });
    clock.value += minutes(11);
    first.reportFailure('grasp', { kind: 'service_auth', reason: 'HTTP 401 Unauthorized' });

    const restarted = make();
    const [issue] = restarted.issues();
    expect(issue).toMatchObject({ source: 'grasp', failures: 2, kind: 'service_auth' });
    expect(issue.lastSuccessAt).toBe('2026-10-02T08:00:00.000Z');
  });
});

describe('capture health while Amazon Employee is off (Settings → Workplace)', () => {
  let storage: StorageLayer;
  let clock: { value: number };
  let amazon: boolean;
  let token: boolean;
  const minutes = (count: number) => count * 60_000;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    clock = { value: Date.parse('2026-10-02T08:00:00Z') };
    amazon = true;
    token = true;
  });
  afterEach(() => storage.close());
  const make = () => createCaptureHealth({
    db: storage.getDb(), now: () => clock.value, amazonEmployee: () => amazon, slackTokenConfigured: () => token,
  });
  const streak = (health: ReturnType<typeof make>, source: 'slack' | 'grasp' | 'sharepoint' | 'gmail', kind: any) => {
    health.reportFailure(source, { kind, reason: 'x' });
    clock.value += minutes(40);
    health.reportFailure(source, { kind, reason: 'x' });
  };

  it('drops Outlook and SharePoint issues and maps Midway to the service sign-in copy', () => {
    const health = make();
    streak(health, 'grasp', 'midway_auth');
    streak(health, 'sharepoint', 'network');
    streak(health, 'slack', 'midway_auth');
    expect(health.issues().map(issue => issue.source).sort()).toEqual(['grasp', 'sharepoint', 'slack']);
    amazon = false;
    const issues = health.issues();
    expect(issues.map(issue => issue.source)).toEqual(['slack']);
    expect(issues[0]).toMatchObject({ kind: 'service_auth', nextAction: 'Open Connections → Slack → Manage and save a new Slack user token.' });
    expect(health.sources().find(entry => entry.source === 'grasp')!.consecutiveFailures).toBe(2);
  });

  it('never names mwinit or Midway for any source or kind while off', () => {
    amazon = false;
    const kinds = ['midway_auth', 'service_auth', 'rate_limited', 'network', 'connector_down', 'unexpected_response', 'unknown'] as const;
    for (const kind of kinds) {
      storage.close();
      storage = createStorage(':memory:');
      storage.initialize();
      const health = make();
      for (const source of ['slack', 'sharepoint', 'grasp', 'gmail'] as const) streak(health, source, kind);
      for (const issue of health.issues()) {
        expect(`${issue.cause} ${issue.nextAction}`, `${issue.source}/${kind}`).not.toMatch(/mwinit|Midway/i);
      }
    }
  });

  it('hides a stale Slack streak while off without a token, and shows it again with one or when on', () => {
    const health = make();
    streak(health, 'slack', 'connector_down');
    amazon = false;
    token = false;
    expect(health.issues()).toEqual([]);
    expect(health.sources().find(entry => entry.source === 'slack')!.consecutiveFailures).toBe(2);
    token = true;
    expect(health.issues()[0]).toMatchObject({ source: 'slack', nextAction: 'Open Connections → Slack → Manage and check the Slack user token.' });
    token = false;
    amazon = true;
    expect(health.issues().map(issue => issue.source)).toEqual(['slack']);
  });

  it('Sign in with Slack: a revoked OAuth token names sign-in again, never mwinit; a pasted token keeps its copy', () => {
    amazon = false;
    // OFF install, no token yet: the OAuth callback then saves one (no restart).
    token = false;
    let via: 'oauth' | 'token' | null = null;
    const health = createCaptureHealth({
      db: storage.getDb(), now: () => clock.value, amazonEmployee: () => amazon,
      slackTokenConfigured: () => token, slackConnectedVia: () => via,
    });
    expect(health.issues()).toEqual([]);
    token = true;
    via = 'oauth';
    const kind = classifyCaptureFailure('An API error occurred: token_revoked');
    expect(kind).toBe('service_auth');
    health.reportFailure('slack', { kind, reason: 'token_revoked' });
    clock.value += minutes(6);
    health.reportFailure('slack', { kind, reason: 'token_revoked' });
    const [issue] = health.issues();
    expect(issue).toMatchObject({ source: 'slack', nextAction: 'Open Connections → Slack and sign in with Slack again.' });
    expect(`${issue.cause} ${issue.nextAction}`).not.toMatch(/mwinit|Midway/i);
    amazon = true;
    expect(health.issues()[0].nextAction).toBe('Open Connections → Slack and sign in with Slack again.');
    amazon = false;
    via = 'token';
    expect(health.issues()[0].nextAction).toBe('Open Connections → Slack → Manage and save a new Slack user token.');
    expect(classifyCaptureFailure('missing_scope')).toBe('service_auth');
  });

  it('Google Drive is its own source with Reconnect, Connect Drive, and enable-API actions', () => {
    amazon = false;
    const health = make();
    const cases: Array<[string, RegExp]> = [
      ['invalid_grant: Token has been expired or revoked.', /Reconnect Google/],
      ['403 insufficientPermissions: Request had insufficient authentication scopes.', /Connect Google Drive/],
      ['403 accessNotConfigured: Google Drive API has not been used in project 1 before or it is disabled.', /Enable the Google Drive API/],
    ];
    for (const [reason, action] of cases) {
      health.reportSuccess('gdrive');
      health.reportFailure('gdrive', { kind: classifyCaptureFailure(reason), reason });
      clock.value += minutes(11);
      health.reportFailure('gdrive', { kind: classifyCaptureFailure(reason), reason });
      const issue = health.issues().find(entry => entry.source === 'gdrive');
      expect(issue, reason).toBeDefined();
      expect(issue!.nextAction).toMatch(action);
      expect(issue!.name).toBe('Google Drive');
    }
    health.reportFailure('gdrive', { kind: classifyCaptureFailure('403 rateLimitExceeded'), reason: 'rateLimitExceeded' });
    expect(health.sources().find(entry => entry.source === 'gdrive')!.kind).toBe('rate_limited');
  });
});

