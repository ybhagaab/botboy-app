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
