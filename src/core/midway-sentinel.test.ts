import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage, getSetting, StorageLayer } from './storage.js';
// Partial mock: the silent Sentry prime spawns curl against the real
// Datanet service — tests control its outcome instead. The pure helpers
// (isSentryAuthShapedError, cookie inspection) stay real.
const primeState = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; reason: 'no_kerberos' | 'curl_failed' | 'timeout' },
  calls: [] as string[],
}));
vi.mock('./sentry-session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sentry-session.js')>();
  return {
    ...original,
    primeDatanetSentrySession: async (cookiePath?: string) => {
      primeState.calls.push(String(cookiePath ?? ''));
      return primeState.result;
    },
  };
});
import {
  DEVICE_CHECK_GRACE_MS,
  GRASP_ALERT_AFTER_RESTART_MS,
  GRASP_RESTART_AFTER_MS,
  HANG_ALERT_AFTER_RESTART_MS,
  HANG_RESTART_AFTER_MS,
  SESSION_EXPIRED_GRACE_MS,
  classifyMidwayFailure,
  createMidwaySentinel,
  isAuthLikeError,
  readMidwayCookieStatus,
  type MidwaySentinel,
} from './midway-sentinel.js';
import type { McpProfileSnapshot } from './mcp-types.js';
import { classifyCaptureFailure, type CaptureSourceHealth } from './capture-health.js';
import type { ChatNotice } from './chat-notices.js';

// ── Pure helpers ──

describe('isAuthLikeError', () => {
  it('matches auth-shaped failures', () => {
    expect(isAuthLikeError('HTTP 401 Unauthorized')).toBe(true);
    expect(isAuthLikeError('403 Forbidden from midway-auth')).toBe(true);
    expect(isAuthLikeError('Midway session expired, run mwinit')).toBe(true);
    expect(isAuthLikeError('session token invalid')).toBe(true);
    expect(isAuthLikeError('authentication required')).toBe(true);
    expect(isAuthLikeError('{"status":"error","message":"Unauthenticated"}')).toBe(true);
  });
  it('ignores non-auth failures and empty input', () => {
    expect(isAuthLikeError('ECONNREFUSED 127.0.0.1:443')).toBe(false);
    expect(isAuthLikeError('tool timed out after 30000ms')).toBe(false);
    expect(isAuthLikeError(null)).toBe(false);
    expect(isAuthLikeError(undefined)).toBe(false);
  });
});

describe('classifyMidwayFailure (the errors seen on the owner\'s Mac, 2026-10-26 to 10-29)', () => {
  it.each([
    ['MCP error -32603: failed to retrieve emails: API request failed with status 401: {"status":"error","message":"Unauthenticated","desc":"You should authenticate (may use mwinit)"}', 'auth'],
    ['Error: Request to IDP URL https://midway-auth.amazon.com/SSO/redirect did not redirect. Status code: 401. You may need to authenticate by running mwinit.', 'auth'],
    ['Error: r4 status: 401', 'auth'],
    ['Authentication failed — your session has expired or no valid tokens are available. To fix this, run the following command in another terminal: grasp-mcp login', 'grasp_signin'],
    ['MCP error -32001: Request timed out', 'timeout'],
    ['MCP error -32603: failed to retrieve emails: failed to execute request: Get "https://midway-api.us-east-2.prod.mail.grasp.amazon.dev/graph/api/v1.0/me"', 'network'],
    ["Error: Second Midway SAML round trip failed (Step 7, HTTP network error). Run 'mwinit -f' to refresh credentials.", 'network'],
    ['Error: getaddrinfo ENOTFOUND amazon.enterprise.slack.com', 'network'],
    ['MCP error -32603: failed to retrieve emails: API request failed with status 503', 'other'],
    ['', 'other'],
  ])('%s → %s', (error, kind) => {
    expect(classifyMidwayFailure(error)).toBe(kind);
  });
});

describe('readMidwayCookieStatus', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midway-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (content: string) => {
    const file = path.join(dir, 'cookie');
    fs.writeFileSync(file, content);
    return file;
  };
  const nowMs = 1_800_000_000_000; // fixed clock
  const epoch = (deltaSeconds: number) => Math.floor(nowMs / 1000) + deltaSeconds;

  it('reports a valid unexpired session cookie', () => {
    const file = write([
      '# Netscape HTTP Cookie File',
      `midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(3600)}\tsession\tSECRETVALUE`,
    ].join('\n'));
    const status = readMidwayCookieStatus(file, nowMs);
    expect(status.valid).toBe(true);
    expect(status.reason).toBe('ok');
    expect(status.sessionExpiresAt).toBe(epoch(3600) * 1000);
  });

  it('finds session cookies behind the #HttpOnly_ prefix', () => {
    const file = write(`#HttpOnly_midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(7200)}\tsession\tSECRET`);
    expect(readMidwayCookieStatus(file, nowMs).valid).toBe(true);
  });

  it('reports expired when the session cookie is in the past', () => {
    const file = write(`midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(-60)}\tsession\tSECRET`);
    const status = readMidwayCookieStatus(file, nowMs);
    expect(status.valid).toBe(false);
    expect(status.reason).toBe('expired');
  });

  it('ignores non-session and non-midway cookies', () => {
    const file = write([
      `midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(9999)}\tuser_name\tuser`,
      `.midway-auth.amazon.com\tTRUE\t/\tTRUE\t${epoch(9999)}\tamazon_enterprise_access\tposture`,
      `example.com\tFALSE\t/\tTRUE\t${epoch(9999)}\tsession\tother-site`,
    ].join('\n'));
    const status = readMidwayCookieStatus(file, nowMs);
    expect(status.valid).toBe(false);
    expect(status.reason).toBe('missing_session_cookie');
  });

  it('reports a missing cookie file', () => {
    const status = readMidwayCookieStatus(path.join(dir, 'does-not-exist'), nowMs);
    expect(status.valid).toBe(false);
    expect(status.reason).toBe('missing_file');
  });
});

// ── Flow with stubbed deps ──

function snapshot(partial: Partial<McpProfileSnapshot> & { id: string }): McpProfileSnapshot {
  return {
    kind: partial.id,
    displayName: partial.id,
    enabled: true,
    configured: true,
    state: 'running',
    restartCount: 0,
    lastError: null,
    lastStartedAt: null,
    lastHealthyAt: null,
    updatedAt: new Date(0).toISOString(),
    tools: [],
    installationState: 'installed',
    compatibilityState: 'compatible',
    requiredTools: [],
    missingTools: [],
    ...partial,
  } as McpProfileSnapshot;
}

const MIN = 60_000;
const GRASP_401 = 'MCP error -32603: failed to retrieve emails: API request failed with status 401: {"status":"error","message":"Unauthenticated","desc":"You should authenticate (may use mwinit)"}';
const GRASP_TOKENS = 'Authentication failed — your session has expired or no valid tokens are available. To fix this, run grasp-mcp login';
const NETWORK = 'MCP error -32603: failed to retrieve emails: failed to execute request: Get "https://midway-api.us-east-2.prod.mail.grasp.amazon.dev/"';
const TIMEOUT = 'MCP error -32001: Request timed out';
const MIDWAY_IDP_401 = 'Error: Request to IDP URL https://midway-auth.amazon.com/SSO/redirect did not redirect. Status code: 401. You may need to authenticate by running mwinit.';
const SERVER_500 = 'Error: Request failed with status code 500';

describe('midway sentinel flow', () => {
  let storage: StorageLayer;
  let dir: string;
  let cookiePath: string;
  let clock: { value: number };
  let profiles: McpProfileSnapshot[];
  let captureSources: CaptureSourceHealth[];
  let idle: number | null;
  let terminalCurrent: any;
  let openedTerminals: any[];
  let lifecycle: string[];
  let callCounter: number;

  const fakeMcpManager = () => ({
    listProfiles: async () => profiles,
    stopProfile: async (id: string) => { lifecycle.push(`stop:${id}`); return snapshot({ id, state: 'stopped' }); },
    startProfile: async (id: string) => { lifecycle.push(`start:${id}`); return snapshot({ id, state: 'running' }); },
  }) as any;
  const fakeChatTerminal = () => ({
    current: () => terminalCurrent,
    open: (input: any) => {
      const session = { id: `term-${openedTerminals.length + 1}`, status: 'running', exitCode: null, title: input.title };
      openedTerminals.push({ ...input, id: session.id });
      terminalCurrent = session;
      return session;
    },
    // The owner is still at the terminal: the wait never settles within a test.
    waitForEnd: () => new Promise(() => {}),
  }) as any;

  /** Every sentinel a test made: afterEach lets their checks finish and stops them, so nothing reaches the next test. */
  let made: MidwaySentinel[] = [];
  const makeSentinel = ({ mcpManager, ...options }: { active?: () => boolean; mcpManager?: any } = {}): MidwaySentinel => {
    const sentinel = createMidwaySentinel(
      {
        db: storage.getDb(), mcpManager: mcpManager ?? fakeMcpManager(), chatTerminal: fakeChatTerminal(),
        captureHealth: { sources: () => captureSources }, ownerIdleSeconds: async () => idle,
      },
      { cookiePath, now: () => clock.value, ...options },
    );
    made.push(sentinel);
    return sentinel;
  };
  const writeCookie = (deltaSeconds: number) => {
    fs.writeFileSync(cookiePath, `midway-auth.amazon.com\tFALSE\t/\tTRUE\t${Math.floor(clock.value / 1000) + deltaSeconds}\tsession\tX`);
  };
  const sqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  /** One audited call of a connection, at the fake clock unless told otherwise. */
  const call = (serverId: string, status: 'completed' | 'failed', error: string | null = null, at = clock.value) => {
    storage.getDb().prepare(`INSERT INTO mcp_tool_calls (id, server_id, tool_name, risk, arguments_sha256, status, error, created_at)
      VALUES (?, ?, 'get_emails', 'read', 'x', ?, ?, ?)`).run(`call-${++callCounter}`, serverId, status, error, sqliteUtc(at));
  };
  /** Advances the clock minute by minute, with a call of this connection each minute, ticking every minute. */
  const run = async (sentinel: MidwaySentinel, minutes: number, serverId: string, status: 'completed' | 'failed', error: string | null = null) => {
    for (let i = 0; i < minutes; i++) {
      clock.value += MIN;
      call(serverId, status, error);
      await sentinel.tick();
    }
  };
  /** Advances the clock minute by minute with no calls at all (an on-demand connection nobody is using). */
  const idleFor = async (sentinel: MidwaySentinel, minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      clock.value += MIN;
      await sentinel.tick();
    }
  };
  const notices = (): Array<{ content: string; notice: ChatNotice }> => (storage.getDb()
    .prepare("SELECT content, notice_json FROM chat_messages WHERE role = 'assistant' ORDER BY rowid").all() as any[])
    .map(row => ({ content: row.content, notice: JSON.parse(row.notice_json) }));
  const allRows = () => storage.getDb().prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midway-flow-'));
    cookiePath = path.join(dir, 'cookie');
    clock = { value: 1_800_000_000_000 };
    profiles = [snapshot({ id: 'slack' }), snapshot({ id: 'grasp-m365' }), snapshot({ id: 'sql-context' })];
    captureSources = [];
    idle = 3_600; // away from the Mac unless a test says otherwise
    terminalCurrent = null;
    openedTerminals = [];
    lifecycle = [];
    callCounter = 0;
    primeState.result = { ok: true };
    primeState.calls = [];
    made = [];
  });
  afterEach(async () => {
    await Promise.all(made.map(sentinel => sentinel.settled()));
    for (const sentinel of made) sentinel.stop();
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stays silent while every connection works, even with an expired cookie file', async () => {
    writeCookie(-3600);
    await run(makeSentinel(), 30, 'grasp-m365', 'completed');
    expect(allRows().n).toBe(0);
    expect(openedTerminals).toHaveLength(0);
  });

  it('a network outage is not a sign-in problem: no notice and no terminal, however long it lasts (the Mac offline overnight)', async () => {
    writeCookie(-3600);
    idle = 0;
    await run(makeSentinel(), 120, 'grasp-m365', 'failed', NETWORK);
    expect(allRows().n).toBe(0);
    expect(openedTerminals).toHaveLength(0);
  });

  it('an ordinary failure with a valid session is the connection manager\'s business', async () => {
    writeCookie(8 * 3600);
    await run(makeSentinel(), 60, 'grasp-m365', 'failed', 'MCP error -32603: API request failed with status 503');
    expect(allRows().n).toBe(0);
  });

  it('DEVICE CHECK: 401s with a valid session wait 20 minutes, and a gap that heals in 15 posts nothing (owner\'s Mac 2026-10-29 10:10–10:25)', async () => {
    writeCookie(4 * 3600);
    idle = 0;
    const sentinel = makeSentinel();
    call('grasp-m365', 'completed');
    await run(sentinel, 15, 'grasp-m365', 'failed', GRASP_401);
    expect(allRows().n).toBe(0);
    await run(sentinel, 3, 'grasp-m365', 'completed');
    expect(allRows().n).toBe(0);
    expect(openedTerminals).toHaveLength(0);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2')).toMatchObject({ episode: null });
  });

  it('DEVICE CHECK that lasts: one notice after 20 minutes, no terminal, never a repeat, and one "working again" when it heals', async () => {
    writeCookie(6 * 3600);
    idle = 0;
    const sentinel = makeSentinel();
    await run(sentinel, 20, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(0);
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    const [first] = notices();
    expect(first.notice).toMatchObject({
      key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'Amazon device check failing', labels: ['GRASP'],
      next: 'Usually clears on its own. If it keeps failing, run mwinit.', action: { kind: 'midway_reauth', label: 'Re-authenticate' },
    });
    expect(first.notice.detail).toContain('Your Midway session is valid until');
    expect(first.content).toBe('Amazon device check failing (GRASP). Usually clears on its own. If it keeps failing, run mwinit.');
    expect(openedTerminals).toHaveLength(0); // a device check waits for the owner's button
    await run(sentinel, 180, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    await run(sentinel, 2, 'grasp-m365', 'completed');
    expect(notices().map(row => [row.notice.state, row.notice.title])).toEqual([
      ['open', 'Amazon device check failing'],
      ['resolved', 'Amazon sign-in working again'],
    ]);
  });

  it('SESSION EXPIRED: one notice after 5 minutes; the terminal waits until the owner is at the Mac and opens once; a new session restarts what still fails', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    await run(sentinel, 5, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(0);
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].notice).toMatchObject({ title: 'Midway sign-in needed', labels: ['GRASP'], next: 'Run mwinit. Capture catches up on its own afterwards.' });
    expect(notices()[0].notice.detail).toContain('Your Midway session expired at');
    expect(openedTerminals).toHaveLength(0); // the owner is away: nothing opens overnight
    await run(sentinel, 120, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    expect(openedTerminals).toHaveLength(0);
    idle = 30; // back at the Mac
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_401);
    expect(openedTerminals).toEqual([expect.objectContaining({ command: 'mwinit', title: 'Midway re-authentication' })]);
    terminalCurrent = { ...terminalCurrent, status: 'timed_out', exitCode: 0 }; // not finished
    await run(sentinel, 30, 'grasp-m365', 'failed', GRASP_401);
    expect(openedTerminals).toHaveLength(1); // once per episode; the notice's button opens it again
    expect(notices()).toHaveLength(1); // and no "still pending" note
    writeCookie(20 * 3600); // signed in again, from anywhere
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_401);
    expect(lifecycle).toEqual(['stop:grasp-m365', 'start:grasp-m365']);
    await run(sentinel, 1, 'grasp-m365', 'completed');
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'resolved', severity: 'success', title: 'Amazon sign-in working again', labels: ['GRASP'] });
  });

  it('a device check that turns into an expired session gets one more notice, and never more', async () => {
    writeCookie(30 * 60);
    const sentinel = makeSentinel();
    await run(sentinel, 21, 'grasp-m365', 'failed', GRASP_401);
    expect(notices().map(row => row.notice.title)).toEqual(['Amazon device check failing']);
    await run(sentinel, 15, 'grasp-m365', 'failed', GRASP_401);
    expect(notices().map(row => row.notice.title)).toEqual(['Amazon device check failing', 'Midway sign-in needed']);
    await run(sentinel, 60, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(2);
  });
  it('the waits are the approved policy (MIDWAY_NOTICES_PLAN.md §5)', () => {
    expect({ SESSION_EXPIRED_GRACE_MS, DEVICE_CHECK_GRACE_MS, GRASP_RESTART_AFTER_MS, GRASP_ALERT_AFTER_RESTART_MS, HANG_RESTART_AFTER_MS, HANG_ALERT_AFTER_RESTART_MS })
      .toEqual({
        SESSION_EXPIRED_GRACE_MS: 5 * MIN, DEVICE_CHECK_GRACE_MS: 20 * MIN, GRASP_RESTART_AFTER_MS: 5 * MIN,
        GRASP_ALERT_AFTER_RESTART_MS: 10 * MIN, HANG_RESTART_AFTER_MS: 10 * MIN, HANG_ALERT_AFTER_RESTART_MS: 10 * MIN,
      });
  });

  it('with Amazon Employee off the sentinel does nothing at all', async () => {
    writeCookie(-60);
    idle = 0;
    await run(makeSentinel({ active: () => false }), 30, 'grasp-m365', 'failed', GRASP_401);
    expect(allRows().n).toBe(0);
    expect(openedTerminals).toHaveLength(0);
    expect(getSetting(storage.getDb(), 'midway_sentinel.v2')).toBeNull();
  });

  it('GRASP SIGN-IN: GRASP restarts after 5 minutes and signs in again from Midway; nothing is posted', async () => {
    writeCookie(8 * 3600);
    idle = 0;
    const sentinel = makeSentinel();
    await run(sentinel, 5, 'grasp-m365', 'failed', GRASP_TOKENS);
    expect(lifecycle).toEqual([]);
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_TOKENS);
    expect(lifecycle).toEqual(['stop:grasp-m365', 'start:grasp-m365']);
    await run(sentinel, 3, 'grasp-m365', 'completed');
    expect(allRows().n).toBe(0);
    expect(openedTerminals).toHaveLength(0);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2')).toMatchObject({ episode: null });
  });

  it('GRASP SIGN-IN that a restart does not fix: one notice 10 minutes later pointing at the GRASP page, never the terminal', async () => {
    writeCookie(8 * 3600);
    idle = 0;
    const sentinel = makeSentinel();
    await run(sentinel, 6, 'grasp-m365', 'failed', GRASP_TOKENS);
    expect(lifecycle).toEqual(['stop:grasp-m365', 'start:grasp-m365']);
    await run(sentinel, 9, 'grasp-m365', 'failed', GRASP_TOKENS);
    expect(notices()).toHaveLength(0);
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_TOKENS);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].notice).toMatchObject({
      key: 'midway', title: 'GRASP sign-in lost', labels: [], next: 'Open GRASP and run Authorize Personal Access.',
      action: { kind: 'open_route', label: 'Open GRASP', route: '#/connections/grasp-m365' },
    });
    expect(notices()[0].notice.detail).toContain('BotBoy restarted it at');
    await run(sentinel, 120, 'grasp-m365', 'failed', GRASP_TOKENS);
    expect(notices()).toHaveLength(1);
    expect(lifecycle).toHaveLength(2); // one restart per episode
    expect(openedTerminals).toHaveLength(0);
    await run(sentinel, 1, 'grasp-m365', 'completed');
    expect(notices().map(row => row.notice.state)).toEqual(['open', 'resolved']);
  });

  it('NOT RESPONDING: a connection whose every call times out restarts after 10 minutes; a restart that helps posts nothing', async () => {
    writeCookie(8 * 3600);
    idle = 0;
    const sentinel = makeSentinel();
    await run(sentinel, 10, 'slack', 'failed', TIMEOUT);
    expect(lifecycle).toEqual([]);
    await run(sentinel, 1, 'slack', 'failed', TIMEOUT);
    expect(lifecycle).toEqual(['stop:slack', 'start:slack']);
    await idleFor(sentinel, 2); // the restarted server has not answered yet: the hang (and its restart time) stays
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').hangs.slack).toMatchObject({ restartedAt: clock.value - 2 * MIN });
    await run(sentinel, 2, 'slack', 'completed');
    expect(allRows().n).toBe(0);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').hangs).toEqual({});
  });

  it('NOT RESPONDING after a restart, owner at the Mac: one notice 10 minutes after the restart, then "responding again"', async () => {
    writeCookie(8 * 3600);
    idle = 10;
    const sentinel = makeSentinel();
    await run(sentinel, 11, 'slack', 'failed', TIMEOUT); // restarted at minute 11
    await run(sentinel, 9, 'slack', 'failed', TIMEOUT);
    expect(notices()).toHaveLength(0);
    await run(sentinel, 1, 'slack', 'failed', TIMEOUT);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].notice).toMatchObject({
      key: 'connection:slack', topic: 'connection', state: 'open', severity: 'warning', title: 'Slack not responding', labels: [],
      action: { kind: 'open_route', label: 'Open Slack', route: '#/connections/slack' },
    });
    expect(notices()[0].notice.next).toMatch(/^BotBoy restarted it at .+\. If it keeps failing, open the Slack connection\.$/);
    expect(openedTerminals).toHaveLength(0);
    await run(sentinel, 1, 'slack', 'completed');
    expect(notices().map(row => [row.notice.key, row.notice.state, row.notice.title])).toEqual([
      ['connection:slack', 'open', 'Slack not responding'],
      ['connection:slack', 'resolved', 'Slack responding again'],
    ]);
  });

  it('NOT RESPONDING while the owner is away: restarts at most every 30 minutes and posts nothing until they are back', async () => {
    writeCookie(8 * 3600);
    const sentinel = makeSentinel();
    await run(sentinel, 11, 'slack', 'failed', TIMEOUT); // first restart at minute 11
    await run(sentinel, 80, 'slack', 'failed', TIMEOUT); // minutes 12–91: restarts at 41 and 71
    expect(lifecycle.filter(entry => entry === 'start:slack')).toHaveLength(3);
    expect(notices()).toHaveLength(0);
    idle = 60;
    await run(sentinel, 1, 'slack', 'failed', TIMEOUT);
    expect(notices().map(row => row.notice.title)).toEqual(['Slack not responding']);
    await run(sentinel, 30, 'slack', 'failed', TIMEOUT);
    expect(notices()).toHaveLength(1);
  });

  it('a restart of BotBoy never re-alerts: the episode is kept in app_settings', async () => {
    writeCookie(6 * 3600);
    await run(makeSentinel(), 21, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    const restarted = makeSentinel();
    await run(restarted, 60, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    await run(restarted, 1, 'grasp-m365', 'completed');
    expect(notices().map(row => row.notice.state)).toEqual(['open', 'resolved']);
  });

  it('SLACK reports Midway 401s inside successful calls: capture health opens the episode, and its recovery closes it', async () => {
    writeCookie(-60);
    const since = new Date(clock.value + MIN).toISOString();
    captureSources = [{
      source: 'slack', lastSuccessAt: null, lastFailureAt: since, failingSince: since, consecutiveFailures: 4, kind: 'midway_auth',
      reason: 'Status code: 401. You may need to authenticate by running mwinit.',
    }];
    const sentinel = makeSentinel();
    await run(sentinel, 5, 'slack', 'completed');
    expect(notices()).toHaveLength(0);
    await run(sentinel, 1, 'slack', 'completed');
    expect(notices().map(row => [row.notice.title, row.notice.labels])).toEqual([['Midway sign-in needed', ['Slack']]]);
    expect(notices()[0].notice.next).toBe('Run mwinit. Capture catches up on its own afterwards.');
    captureSources = [{ ...captureSources[0], consecutiveFailures: 0, kind: null, failingSince: null }];
    await run(sentinel, 1, 'slack', 'completed');
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'resolved', title: 'Amazon sign-in working again', labels: ['Slack'] });
  });

  it('a capture streak from before BotBoy restarted the connection is stale until the source polls again', async () => {
    writeCookie(8 * 3600);
    const sentinel = makeSentinel();
    await run(sentinel, 11, 'slack', 'failed', TIMEOUT); // the hang watchdog restarts Slack at minute 11
    const before = new Date(clock.value - 30_000).toISOString();
    captureSources = [{ source: 'slack', lastSuccessAt: null, lastFailureAt: before, failingSince: before, consecutiveFailures: 2, kind: 'midway_auth', reason: '401' }];
    await idleFor(sentinel, 30);
    expect(notices()).toHaveLength(0);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toBeNull();
  });

  it('LIVE (2026-11-12): SharePoint losing the network while it signs in never joins the sign-in notice', async () => {
    writeCookie(8 * 3600);
    profiles.push(snapshot({ id: 'sharepoint' }));
    const callError = "Error: Midway SAML authentication failed (Step 3, HTTP network error). Run 'mwinit -f' to refresh credentials. If on a Cloud Desktop, use 'mwinit -o'. Target: https://amazon.sharepoint.com";
    const discoveryReason = `sharepoint_list_shared_with_me failed: ${callError}`;
    const sentinel = makeSentinel();
    let failingSince: string | null = null;
    let reports = 0;
    const minute = async (calls: Array<[string, 'completed' | 'failed', string | null]>) => {
      clock.value += MIN;
      for (const [serverId, status, error] of calls) call(serverId, status, error);
      // Its discovery reports the failed call to capture health right after it, with the classifier's kind (sharepoint-sync.ts).
      const reportedAt = new Date(clock.value + 500).toISOString();
      failingSince ??= reportedAt;
      captureSources = [{
        source: 'sharepoint', lastSuccessAt: null, lastFailureAt: reportedAt, failingSince, consecutiveFailures: ++reports,
        kind: classifyCaptureFailure(discoveryReason), reason: discoveryReason,
      }];
      await sentinel.tick();
    };
    for (let i = 0; i < 21; i++) await minute([['slack', 'failed', MIDWAY_IDP_401], ['grasp-m365', 'failed', GRASP_401], ['sharepoint', 'failed', callError]]);
    expect(notices().map(row => [row.notice.title, row.notice.labels])).toEqual([['Amazon device check failing', ['Slack', 'GRASP']]]);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode.profiles).toEqual(['slack', 'grasp-m365']);
    await minute([['slack', 'completed', null], ['grasp-m365', 'completed', null], ['sharepoint', 'failed', callError]]);
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'resolved', title: 'Amazon sign-in working again', labels: ['Slack', 'GRASP'] });
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toBeNull();
  });

  it('DATANET: a Sentry failure with a valid session re-primes silently and restarts Datanet, at most every 10 minutes; no notice', async () => {
    writeCookie(8 * 3600);
    profiles.push(snapshot({ id: 'a2-analytics' }));
    const sentinel = makeSentinel();
    await run(sentinel, 30, 'a2-analytics', 'failed', 'Error: r4 status: 401');
    expect(primeState.calls).toEqual([cookiePath, cookiePath, cookiePath]);
    expect(lifecycle.filter(entry => entry === 'start:a2-analytics')).toHaveLength(3);
    expect(allRows().n).toBe(0);
  });

  it('DATANET: one failed call re-primes once; the old failure in the call log never triggers another restart', async () => {
    writeCookie(8 * 3600);
    profiles.push(snapshot({ id: 'a2-analytics' }));
    const sentinel = makeSentinel();
    await run(sentinel, 1, 'a2-analytics', 'failed', 'Error: r4 status: 401');
    await idleFor(sentinel, 90);
    expect(primeState.calls).toHaveLength(1);
    expect(lifecycle).toEqual(['stop:a2-analytics', 'start:a2-analytics']);
    expect(allRows().n).toBe(0);
  });

  it('DATANET whose re-prime fails: after 20 minutes one "Datanet sign-in needed" notice with mwinit -o -s', async () => {
    writeCookie(8 * 3600);
    profiles.push(snapshot({ id: 'a2-analytics' }));
    primeState.result = { ok: false, reason: 'no_kerberos' };
    const sentinel = makeSentinel();
    await run(sentinel, 20, 'a2-analytics', 'failed', 'Error: r4 status: 401');
    expect(notices()).toHaveLength(0);
    expect(lifecycle).toEqual([]); // no blind restart on a dead sign-in
    await run(sentinel, 1, 'a2-analytics', 'failed', 'Error: r4 status: 401');
    expect(notices()).toHaveLength(1);
    expect(notices()[0].notice).toMatchObject({
      title: 'Datanet sign-in needed', labels: ['Datanet'], next: 'Run mwinit -o -s.', action: { kind: 'midway_reauth' },
    });
    expect(notices()[0].notice.detail).toContain('mwinit -o -s renews the Datanet sign-in too');
    expect(openedTerminals).toHaveLength(0);
    expect(sentinel.openReauth()).toMatchObject({ ok: true, command: 'mwinit -o -s' });
    // GRASP joining with 401s is Amazon's device check: worse than Datanet alone, so one more notice naming both.
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_401);
    expect(notices().map(row => [row.notice.title, row.notice.labels])).toEqual([
      ['Datanet sign-in needed', ['Datanet']],
      ['Amazon device check failing', ['Datanet', 'GRASP']],
    ]);
    expect(notices()[1].notice.next).toBe('Usually clears on its own. If it keeps failing, run mwinit -o -s.');
  });

  it('DATANET with the Midway session expired: the notice and the terminal use mwinit -o -s', async () => {
    writeCookie(-60);
    profiles.push(snapshot({ id: 'a2-analytics' }));
    idle = 0;
    const sentinel = makeSentinel();
    await run(sentinel, 6, 'a2-analytics', 'failed', 'Error: r4 status: 401');
    expect(primeState.calls).toHaveLength(0); // the silent prime needs a valid session
    expect(notices().map(row => [row.notice.title, row.notice.next])).toEqual([['Midway sign-in needed', 'Run mwinit -o -s.']]);
    expect(openedTerminals).toEqual([expect.objectContaining({ command: 'mwinit -o -s' })]);
  });

  it('a non-sign-in Datanet failure stays the connection manager\'s problem: no prime, no restart, no notice', async () => {
    writeCookie(8 * 3600);
    profiles.push(snapshot({ id: 'a2-analytics', state: 'failed', lastError: 'FATAL no Python >=3.10' }));
    await run(makeSentinel(), 30, 'a2-analytics', 'failed', 'FATAL no Python >=3.10');
    expect(primeState.calls).toHaveLength(0);
    expect(lifecycle).toHaveLength(0);
    expect(allRows().n).toBe(0);
  });

  it('Re-authenticate opens the mwinit terminal, never beside a running one, and the tick then does not open a second', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    await run(sentinel, 6, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    terminalCurrent = { id: 'other', status: 'running', exitCode: null };
    expect(sentinel.openReauth()).toMatchObject({ ok: false, code: 'terminal_busy' });
    expect(openedTerminals).toHaveLength(0);
    terminalCurrent = null;
    expect(sentinel.openReauth()).toEqual({ ok: true, sessionId: 'term-1', command: 'mwinit' });
    expect(openedTerminals).toEqual([expect.objectContaining({ command: 'mwinit', title: 'Midway re-authentication' })]);
    terminalCurrent = { ...terminalCurrent, status: 'exited', exitCode: 1 }; // closed without signing in
    idle = 0; // the owner is at the Mac now
    await run(sentinel, 10, 'grasp-m365', 'failed', GRASP_401);
    expect(openedTerminals).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it('the terminal never opens beside a terminal that is already running', async () => {
    writeCookie(-60);
    idle = 0;
    terminalCurrent = { id: 'busy', status: 'running', exitCode: null };
    const sentinel = makeSentinel();
    await run(sentinel, 10, 'grasp-m365', 'failed', GRASP_401);
    expect(openedTerminals).toHaveLength(0);
    expect(notices()).toHaveLength(1);
    terminalCurrent = { ...terminalCurrent, status: 'exited', exitCode: 0 };
    await run(sentinel, 1, 'grasp-m365', 'failed', GRASP_401);
    expect(openedTerminals).toHaveLength(1);
  });

  it('a connection that is down while the session is expired counts as the expiry; with a valid session it does not', async () => {
    const down = () => snapshot({ id: 'slack', state: 'failed', lastError: 'MCP server exited with code 1', updatedAt: sqliteUtc(clock.value) });
    writeCookie(-60);
    profiles = [down()];
    const sentinel = makeSentinel();
    await idleFor(sentinel, 4);
    expect(notices()).toHaveLength(0);
    await idleFor(sentinel, 1);
    expect(notices().map(row => [row.notice.title, row.notice.labels])).toEqual([['Midway sign-in needed', ['Slack']]]);

    storage.getDb().prepare('DELETE FROM chat_messages').run();
    storage.getDb().prepare("DELETE FROM app_settings WHERE key = 'midway_sentinel.v2'").run();
    writeCookie(8 * 3600);
    profiles = [down()];
    await idleFor(makeSentinel(), 60);
    expect(allRows().n).toBe(0);
  });

  it('after a new sign-in the episode stays open until the restarted connection answers; no answer is not "working again"', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    sentinel.registerRecheck('grasp-m365', () => { lifecycle.push('check:grasp-m365'); }); // asked to check; no answer comes
    await run(sentinel, 6, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    writeCookie(20 * 3600);
    await idleFor(sentinel, 1);
    await sentinel.settled();
    expect(lifecycle).toEqual(['stop:grasp-m365', 'start:grasp-m365', 'check:grasp-m365']);
    await idleFor(sentinel, 10); // the old failures are stale, and nothing new has come in
    expect(notices().map(row => row.notice.title)).toEqual(['Midway sign-in needed', 'Signed in again']);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toMatchObject({ profiles: ['grasp-m365'] });
    await run(sentinel, 1, 'grasp-m365', 'completed');
    expect(notices().map(row => row.notice.title)).toEqual(['Midway sign-in needed', 'Signed in again', 'Amazon sign-in working again']);
  });

  // ── After a sign-in (owner's Mac 2026-11-11: signed in at 22:59; SharePoint answered at 23:10 on its own schedule; Slack
  //    returned HTTP 500 until 23:22; the 19:15 notice still named only SharePoint and still said to run mwinit) ──

  /** A check BotBoy can run on demand: a second later, the connection answers. */
  const answer = (id: string, status: 'completed' | 'failed', error: string | null = null) => () => {
    lifecycle.push(`check:${id}`);
    clock.value += 1_000;
    call(id, status, error);
  };
  /** Advances the clock minute by minute; each minute every listed connection makes one call, then the sentinel ticks. */
  const runEach = async (sentinel: MidwaySentinel, minutes: number, calls: Array<[string, 'completed' | 'failed', string | null]>) => {
    for (let i = 0; i < minutes; i++) {
      clock.value += MIN;
      for (const [serverId, status, error] of calls) call(serverId, status, error);
      await sentinel.tick();
    }
  };
  /** The owner signs in again a minute later; the sentinel's tick and the checks it starts run to the end. */
  const signIn = async (sentinel: MidwaySentinel) => {
    writeCookie(20 * 3600);
    clock.value += MIN;
    await sentinel.tick();
    await sentinel.settled();
  };

  it('a connection that starts failing after the notice gets one more notice naming every connection, once each', async () => {
    writeCookie(-60);
    profiles.push(snapshot({ id: 'sharepoint' }));
    const sentinel = makeSentinel();
    await runEach(sentinel, 6, [['sharepoint', 'failed', MIDWAY_IDP_401]]);
    expect(notices().map(row => [row.notice.title, row.notice.labels])).toEqual([['Midway sign-in needed', ['SharePoint']]]);
    await runEach(sentinel, 30, [['sharepoint', 'failed', MIDWAY_IDP_401], ['slack', 'failed', MIDWAY_IDP_401]]);
    await runEach(sentinel, 30, [['sharepoint', 'failed', MIDWAY_IDP_401], ['slack', 'failed', MIDWAY_IDP_401], ['grasp-m365', 'failed', GRASP_401]]);
    expect(notices().map(row => [row.notice.state, row.notice.title, row.notice.labels])).toEqual([
      ['open', 'Midway sign-in needed', ['SharePoint']],
      ['open', 'Midway sign-in needed', ['SharePoint', 'Slack']],
      ['open', 'Midway sign-in needed', ['SharePoint', 'Slack', 'GRASP']],
    ]);
  });

  it('LIVE: the failing connections restart and check at once, the line says BotBoy saw the sign-in, and the result names what still fails for another reason', async () => {
    writeCookie(-60);
    profiles.push(snapshot({ id: 'sharepoint' }));
    const sentinel = makeSentinel();
    sentinel.registerRecheck('sharepoint', answer('sharepoint', 'completed'));
    sentinel.registerRecheck('slack', answer('slack', 'failed', SERVER_500));
    sentinel.registerRecheck('grasp-m365', answer('grasp-m365', 'completed'));
    await runEach(sentinel, 6, [['slack', 'failed', MIDWAY_IDP_401], ['grasp-m365', 'failed', GRASP_401], ['sharepoint', 'failed', MIDWAY_IDP_401]]);
    await runEach(sentinel, 2, [['slack', 'failed', MIDWAY_IDP_401], ['grasp-m365', 'completed', null], ['sharepoint', 'failed', MIDWAY_IDP_401]]);
    expect(notices().map(row => row.notice.labels)).toEqual([['Slack', 'GRASP', 'SharePoint']]);

    await signIn(sentinel);
    // Only what still failed restarts, then each one checks at once; GRASP already worked again.
    expect(lifecycle).toEqual(['stop:slack', 'start:slack', 'stop:sharepoint', 'start:sharepoint', 'check:slack', 'check:sharepoint']);
    const [, seen, result] = notices().map(row => row.notice);
    expect(seen).toMatchObject({ key: 'midway', state: 'info', title: 'Signed in again', labels: ['Slack', 'SharePoint'], next: 'Checking Slack and SharePoint now.' });
    expect(seen.action).toBeUndefined();
    expect(seen.detail).toContain('Already working: GRASP.');
    expect(result).toMatchObject({
      key: 'midway', state: 'resolved', severity: 'success', title: 'Amazon sign-in working again',
      labels: ['GRASP', 'SharePoint', 'Slack still failing'],
    });
    expect(result.detail).toContain('Signed in again at');
    expect(result.detail).toMatch(/Working again at .+: GRASP, SharePoint\. Capture catches up on its own\./);
    expect(result.detail).toContain('Slack still fails for another reason: the service is returning errors ("Error: Request failed with status code 500"). Signing in again does not fix this');
    expect(result.detail).not.toMatch(/mwinit/);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toBeNull();
    // Slack's own failure is its connection page's business now: more of it posts nothing here.
    await run(sentinel, 30, 'slack', 'failed', SERVER_500);
    expect(notices()).toHaveLength(3);
  });

  it('a sign-in that does not fix every connection: the notice then names only what still refuses, after what the sign-in fixed', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    sentinel.registerRecheck('grasp-m365', answer('grasp-m365', 'completed'));
    sentinel.registerRecheck('slack', answer('slack', 'failed', MIDWAY_IDP_401));
    await runEach(sentinel, 6, [['slack', 'failed', MIDWAY_IDP_401], ['grasp-m365', 'failed', GRASP_401]]);
    expect(notices()).toHaveLength(1);
    await signIn(sentinel);
    expect(notices().map(row => [row.notice.state, row.notice.title, row.notice.labels])).toEqual([
      ['open', 'Midway sign-in needed', ['Slack', 'GRASP']],
      ['info', 'Signed in again', ['Slack', 'GRASP']],
      ['open', 'Amazon device check failing', ['Slack']],
    ]);
    const update = notices()[2].notice;
    expect(update.detail).toMatch(/^Signed in again at .+\.\nWorking again: GRASP\.\nYour Midway session is valid until/);
    // The refusal is dated from after the sign-in, not from when the expired session began.
    const clockText = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    expect(update.detail).toContain(`Since ${clockText(clock.value)}, Amazon's device check has refused these connections.`);
    expect(update.action).toMatchObject({ kind: 'midway_reauth', label: 'Re-authenticate' });
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toMatchObject({ cause: 'device_check', profiles: ['slack'] });
    await run(sentinel, 30, 'slack', 'failed', MIDWAY_IDP_401);
    expect(notices()).toHaveLength(3);
    // The owner is now told "device check": a session that expires again is worse, so one more notice says so.
    writeCookie(-60);
    await run(sentinel, 1, 'slack', 'failed', MIDWAY_IDP_401);
    expect(notices().map(row => row.notice.title).slice(3)).toEqual(['Midway sign-in needed']);
    // Signing in again starts over: BotBoy says it saw it, checks, and reports once more.
    await signIn(sentinel);
    expect(notices().map(row => [row.notice.state, row.notice.title]).slice(4)).toEqual([
      ['info', 'Signed in again'],
      ['open', 'Amazon device check failing'],
    ]);
    await run(sentinel, 1, 'slack', 'completed');
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'resolved', title: 'Amazon sign-in working again', labels: ['Slack'] });
  });

  it('after a sign-in, a connection whose calls only time out is named with that reason, and one already working gets no "signed in again" line', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    sentinel.registerRecheck('grasp-m365', answer('grasp-m365', 'failed', TIMEOUT));
    await run(sentinel, 6, 'grasp-m365', 'failed', GRASP_401);
    await signIn(sentinel);
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'resolved', title: 'Signed in again', labels: ['GRASP still failing'] });
    expect(notices().at(-1)!.notice.detail).toContain('GRASP still fails for another reason: its requests time out ("MCP error -32001: Request timed out")');

    // A sign-in when everything already works again: no "checking" line, straight to the result.
    storage.getDb().prepare('DELETE FROM chat_messages').run();
    storage.getDb().prepare("DELETE FROM app_settings WHERE key = 'midway_sentinel.v2'").run();
    writeCookie(-60);
    const second = makeSentinel();
    await run(second, 6, 'grasp-m365', 'failed', GRASP_401);
    await run(second, 1, 'grasp-m365', 'completed');
    expect(notices().map(row => row.notice.state)).toEqual(['open', 'resolved']); // recovered on its own, before any sign-in
    storage.getDb().prepare('DELETE FROM chat_messages').run();
    await run(second, 6, 'grasp-m365', 'failed', GRASP_401);
    call('grasp-m365', 'completed', null, clock.value + 1_000);
    await signIn(second);
    expect(notices().map(row => [row.notice.state, row.notice.title])).toEqual([
      ['open', 'Midway sign-in needed'],
      ['resolved', 'Amazon sign-in working again'],
    ]);
  });

  it('after a sign-in, a connection that turns from refusing it to failing another way leaves the Midway notice', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    sentinel.registerRecheck('slack', answer('slack', 'failed', MIDWAY_IDP_401));
    await run(sentinel, 6, 'slack', 'failed', MIDWAY_IDP_401);
    await signIn(sentinel);
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'open', title: 'Amazon device check failing', labels: ['Slack'] });
    await run(sentinel, 1, 'slack', 'failed', SERVER_500);
    const last = notices().at(-1)!.notice;
    expect(last).toMatchObject({ state: 'resolved', title: 'Signed in again', labels: ['Slack still failing'] });
    expect(last.detail).toContain('Slack still fails for another reason: the service is returning errors');
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toBeNull();
  });

  it('a connection BotBoy cannot check on its own (Datanet) does not hold up the result: it is checked again on next use', async () => {
    writeCookie(-60);
    profiles.push(snapshot({ id: 'a2-analytics' }));
    const sentinel = makeSentinel();
    sentinel.registerRecheck('grasp-m365', answer('grasp-m365', 'completed'));
    await runEach(sentinel, 6, [['grasp-m365', 'failed', GRASP_401], ['a2-analytics', 'failed', 'Error: r4 status: 401']]);
    expect(notices().map(row => row.notice.labels)).toEqual([['GRASP', 'Datanet']]);
    await signIn(sentinel);
    expect(primeState.calls).toHaveLength(1); // Datanet re-primed silently with the fresh session
    const result = notices().at(-1)!.notice;
    expect(result).toMatchObject({ state: 'resolved', title: 'Amazon sign-in working again', labels: ['GRASP'] });
    expect(result.detail).toContain('Datanet is checked again on next use.');
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toBeNull();
  });

  it('a connection that went quiet during the outage is asked to check too, without a restart', async () => {
    writeCookie(-60);
    profiles.push(snapshot({ id: 'sharepoint' }));
    const sentinel = makeSentinel();
    sentinel.registerRecheck('sharepoint', answer('sharepoint', 'completed'));
    sentinel.registerRecheck('slack', answer('slack', 'completed'));
    await runEach(sentinel, 6, [['slack', 'failed', MIDWAY_IDP_401], ['sharepoint', 'failed', MIDWAY_IDP_401]]);
    // SharePoint makes no call for over two hours (its failures fall out of the window); Slack keeps failing.
    await run(sentinel, 125, 'slack', 'failed', MIDWAY_IDP_401);
    expect(notices()).toHaveLength(1);
    await signIn(sentinel);
    expect(lifecycle).toEqual(['stop:slack', 'start:slack', 'check:slack', 'check:sharepoint']);
    expect(notices()[1].notice).toMatchObject({ title: 'Signed in again', labels: ['Slack', 'SharePoint'] });
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'resolved', labels: ['Slack', 'SharePoint'] });
  });

  it('without a new sign-in, a connection that turns to another failure keeps the episode open until it works', async () => {
    writeCookie(6 * 3600);
    const sentinel = makeSentinel();
    await run(sentinel, 21, 'grasp-m365', 'failed', GRASP_401);
    expect(notices().map(row => row.notice.title)).toEqual(['Amazon device check failing']);
    await run(sentinel, 30, 'grasp-m365', 'failed', 'MCP error -32603: failed to retrieve emails: API request failed with status 503');
    expect(notices()).toHaveLength(1);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toMatchObject({ profiles: ['grasp-m365'] });
    await run(sentinel, 1, 'grasp-m365', 'completed');
    expect(notices().at(-1)!.notice).toMatchObject({ state: 'resolved', title: 'Amazon sign-in working again', labels: ['GRASP'] });
  });

  it('a sign-in during the wait before any notice stays silent, and its check still runs at once', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    sentinel.registerRecheck('grasp-m365', answer('grasp-m365', 'completed'));
    await run(sentinel, 3, 'grasp-m365', 'failed', GRASP_401);
    await signIn(sentinel);
    expect(lifecycle).toEqual(['stop:grasp-m365', 'start:grasp-m365', 'check:grasp-m365']);
    expect(allRows().n).toBe(0);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toBeNull();
  });

  it('any restart checks the connection at once (here the hang watchdog), but only once it is running again', async () => {
    writeCookie(8 * 3600);
    const sentinel = makeSentinel();
    sentinel.registerRecheck('slack', answer('slack', 'completed'));
    await run(sentinel, 11, 'slack', 'failed', TIMEOUT);
    await sentinel.settled();
    expect(lifecycle).toEqual(['stop:slack', 'start:slack', 'check:slack']);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').hangs).toEqual({}); // its answer ended the hang at once

    lifecycle = [];
    const starting = makeSentinel({ mcpManager: { ...fakeMcpManager(), startProfile: async (id: string) => { lifecycle.push(`start:${id}`); return snapshot({ id, state: 'starting' }); } } });
    starting.registerRecheck('slack', answer('slack', 'completed'));
    await run(starting, 11, 'slack', 'failed', TIMEOUT);
    await starting.settled();
    expect(lifecycle).toEqual(['stop:slack', 'start:slack']);
  });

  it('a check that answers while a tick still runs gets a tick of its own after that one', async () => {
    writeCookie(8 * 3600);
    let releaseGrasp!: () => void;
    const sentinel = makeSentinel({
      mcpManager: {
        ...fakeMcpManager(),
        startProfile: async (id: string) => {
          lifecycle.push(`start:${id}`);
          if (id === 'grasp-m365') await new Promise<void>(resolve => { releaseGrasp = resolve; });
          return snapshot({ id, state: 'running' });
        },
      },
    });
    sentinel.registerRecheck('slack', answer('slack', 'completed'));
    // Both connections time out from the first minute, so one tick restarts both: Slack first, then GRASP, which starts slowly.
    await runEach(sentinel, HANG_RESTART_AFTER_MS / MIN, [['slack', 'failed', TIMEOUT], ['grasp-m365', 'failed', TIMEOUT]]);
    expect(lifecycle).toEqual([]);
    clock.value += MIN;
    call('slack', 'failed', TIMEOUT);
    call('grasp-m365', 'failed', TIMEOUT);
    const restarting = sentinel.tick();
    await new Promise(resolve => setImmediate(resolve));
    // Slack has answered while the tick that read its old failures still waits for GRASP to start.
    expect(lifecycle).toEqual(['stop:slack', 'start:slack', 'check:slack', 'stop:grasp-m365', 'start:grasp-m365']);
    releaseGrasp();
    await restarting;
    await sentinel.settled();
    // The tick after that one read Slack's answer and ended its hang; GRASP has not answered yet.
    expect(Object.keys(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').hangs)).toEqual(['grasp-m365']);
  });

  it('a tick asked for while one runs waits for that one, and never runs beside it', async () => {
    writeCookie(8 * 3600);
    let release!: () => void;
    let reads = 0;
    const sentinel = makeSentinel({
      mcpManager: {
        ...fakeMcpManager(),
        listProfiles: async () => {
          if (++reads === 1) await new Promise<void>(resolve => { release = resolve; });
          return profiles;
        },
      },
    });
    const first = sentinel.tick();
    let secondDone = false;
    const second = sentinel.tick().then(() => { secondDone = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(secondDone).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    expect(reads).toBe(1);
  });

  it('with the session expired, a connection that only times out is a hang and a 503 is an ordinary failure: no sign-in notice', async () => {
    writeCookie(-60);
    const sentinel = makeSentinel();
    await run(sentinel, 30, 'slack', 'failed', TIMEOUT);
    await run(sentinel, 30, 'grasp-m365', 'failed', 'MCP error -32603: failed to retrieve emails: API request failed with status 503');
    expect(notices()).toHaveLength(0);
    expect(getSetting<any>(storage.getDb(), 'midway_sentinel.v2').episode).toBeNull();
  });

  it('an unknown idle time counts as away: the terminal waits for the button', async () => {
    writeCookie(-60);
    idle = null;
    await run(makeSentinel(), 30, 'grasp-m365', 'failed', GRASP_401);
    expect(notices()).toHaveLength(1);
    expect(openedTerminals).toHaveLength(0);
  });
});
