import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage, StorageLayer } from './storage.js';

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
  createMidwaySentinel,
  isAuthLikeError,
  readMidwayCookieStatus,
  type MidwaySentinel,
} from './midway-sentinel.js';
import type { McpProfileSnapshot } from './mcp-types.js';

// ── Pure helpers ──

describe('isAuthLikeError', () => {
  it('matches auth-shaped failures', () => {
    expect(isAuthLikeError('HTTP 401 Unauthorized')).toBe(true);
    expect(isAuthLikeError('403 Forbidden from midway-auth')).toBe(true);
    expect(isAuthLikeError('Midway session expired, run mwinit')).toBe(true);
    expect(isAuthLikeError('session token invalid')).toBe(true);
    expect(isAuthLikeError('authentication required')).toBe(true);
  });
  it('ignores non-auth failures and empty input', () => {
    expect(isAuthLikeError('ECONNREFUSED 127.0.0.1:443')).toBe(false);
    expect(isAuthLikeError('tool timed out after 30000ms')).toBe(false);
    expect(isAuthLikeError(null)).toBe(false);
    expect(isAuthLikeError(undefined)).toBe(false);
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
    const file = write(
      `#HttpOnly_midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(7200)}\tsession\tSECRET`,
    );
    expect(readMidwayCookieStatus(file, nowMs).valid).toBe(true);
  });

  it('reports expired when the session cookie is in the past', () => {
    const file = write(
      `midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(-60)}\tsession\tSECRET`,
    );
    const status = readMidwayCookieStatus(file, nowMs);
    expect(status.valid).toBe(false);
    expect(status.reason).toBe('expired');
  });

  it('ignores non-session and non-midway cookies', () => {
    const file = write([
      `midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(9999)}\tuser_name\tuser`,
      `midway-auth.amazon.com\tFALSE\t/\tTRUE\t${epoch(9999)}\tkerberos_disabled\t1`,
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
    updatedAt: new Date().toISOString(),
    tools: [],
    installationState: 'installed',
    compatibilityState: 'compatible',
    requiredTools: [],
    missingTools: [],
    ...partial,
  } as McpProfileSnapshot;
}

describe('midway sentinel flow', () => {
  let storage: StorageLayer;
  let dir: string;
  let cookiePath: string;
  let clock: { value: number };

  // Controllable fakes
  let profiles: McpProfileSnapshot[];
  let agentCalls: string[];
  let agentReply: string;
  let terminalCurrent: any;
  let openedTerminals: any[];
  let waitForEndResult: () => Promise<any>;
  let lifecycle: string[];

  const fakeMcpManager = () => ({
    listProfiles: async () => profiles,
    stopProfile: async (id: string) => { lifecycle.push(`stop:${id}`); return snapshot({ id, state: 'stopped' }); },
    startProfile: async (id: string) => { lifecycle.push(`start:${id}`); return snapshot({ id, state: 'running' }); },
    testProfile: async (id: string) => {
      lifecycle.push(`test:${id}`);
      return { profileId: id, compatibilityState: 'compatible', discoveredToolCount: 20, requiredTools: [], missingTools: [], message: 'ok' };
    },
  }) as any;

  const fakeChatTerminal = () => ({
    current: () => terminalCurrent,
    open: (input: any) => {
      const session = { id: `term-${openedTerminals.length + 1}`, status: 'running', exitCode: null, title: input.title };
      openedTerminals.push({ ...input, id: session.id });
      terminalCurrent = session;
      return session;
    },
    waitForEnd: (_ms: number) => waitForEndResult(),
  }) as any;

  const fakeAgent = () => ({
    executeAction: async (instruction: string) => { agentCalls.push(instruction); return agentReply; },
  }) as any;

  const writeCookie = (deltaSeconds: number) => {
    fs.writeFileSync(cookiePath, `midway-auth.amazon.com\tFALSE\t/\tTRUE\t${Math.floor(clock.value / 1000) + deltaSeconds}\tsession\tX`);
  };

  const makeSentinel = (): MidwaySentinel => createMidwaySentinel(
    { db: storage.getDb(), mcpManager: fakeMcpManager(), chatTerminal: fakeChatTerminal(), agent: fakeAgent() },
    { cookiePath, now: () => clock.value },
  );

  const chatMessages = () => storage.getDb()
    .prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY rowid")
    .all()
    .map((row: any) => row.content as string);

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midway-flow-'));
    cookiePath = path.join(dir, 'cookie');
    clock = { value: 1_800_000_000_000 };
    profiles = [snapshot({ id: 'slack' }), snapshot({ id: 'grasp-m365' }), snapshot({ id: 'sql-context' })];
    agentCalls = [];
    agentReply = 'Heads up — your Midway session expired. Use the terminal below.';
    terminalCurrent = null;
    openedTerminals = [];
    lifecycle = [];
    primeState.result = { ok: true };
    primeState.calls = [];
    // Default: the owner is still at the terminal — the wait never settles
    // within the test, exactly like a blocked real waitForEnd call.
    waitForEndResult = () => new Promise(() => {});
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stays silent while every Midway profile is healthy', async () => {
    writeCookie(-3600); // even with an expired cookie, healthy profiles mean no episode
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(agentCalls).toHaveLength(0);
    expect(chatMessages()).toHaveLength(0);
    expect(openedTerminals).toHaveLength(0);
  });

  it('stays silent when a profile fails but the cookie is still valid (ordinary crash)', async () => {
    writeCookie(3600);
    profiles[0] = snapshot({ id: 'slack', state: 'failed' });
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(agentCalls).toHaveLength(0);
    expect(chatMessages()).toHaveLength(0);
  });

  it('notifies once, opens mwinit, and dedupes while the episode is open', async () => {
    writeCookie(-60);
    profiles[0] = snapshot({ id: 'slack', state: 'failed' });
    profiles[1] = snapshot({ id: 'grasp-m365', state: 'degraded' });
    const sentinel = makeSentinel();
    await sentinel.tick();

    expect(openedTerminals).toHaveLength(1);
    expect(openedTerminals[0].command).toBe('mwinit');
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]).toContain('SYSTEM EVENT');
    expect(agentCalls[0]).toContain('slack');
    expect(agentCalls[0]).toContain('grasp-m365');
    const messages = chatMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Midway session expired');

    // Second tick during the same episode: no duplicates.
    await sentinel.tick();
    expect(agentCalls).toHaveLength(1);
    expect(chatMessages()).toHaveLength(1);
    expect(openedTerminals).toHaveLength(1);
  });

  it('falls back to a deterministic message when the LLM turn fails', async () => {
    writeCookie(-60);
    agentReply = 'Error: model unavailable';
    profiles[0] = snapshot({ id: 'slack', state: 'failed', displayName: 'Amazon Slack through AI Community MCP' });
    const sentinel = makeSentinel();
    await sentinel.tick();
    const messages = chatMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('needs re-authentication');
    expect(messages[0]).toContain('Amazon Slack through AI Community MCP');
  });

  it('restarts affected profiles and confirms after a successful mwinit', async () => {
    writeCookie(-60);
    profiles[0] = snapshot({ id: 'slack', state: 'failed' });
    // Terminal completes successfully on the first wait, and by then the
    // cookie has been refreshed by the owner's mwinit run.
    waitForEndResult = async () => {
      writeCookie(3600);
      return { id: 'term-1', status: 'completed', exitCode: 0 };
    };
    const sentinel = makeSentinel();
    await sentinel.tick();
    await new Promise(resolve => setTimeout(resolve, 20)); // let the detached watcher settle

    expect(lifecycle).toEqual(['stop:slack', 'start:slack', 'test:slack']);
    const messages = chatMessages();
    expect(messages).toHaveLength(2); // notification + recovery confirmation
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[1]).toContain('restarted and re-tested');
  });

  it('reports honestly when mwinit fails and applies the cooldown', async () => {
    writeCookie(-60);
    profiles[0] = snapshot({ id: 'slack', state: 'failed' });
    waitForEndResult = async () => ({ id: 'term-1', status: 'failed', exitCode: 1 });
    const sentinel = makeSentinel();
    await sentinel.tick();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(lifecycle).toHaveLength(0); // no restart without a fresh cookie
    const messages = chatMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('still pending');

    // Still failing on the next tick, but inside the cooldown: quiet.
    await sentinel.tick();
    expect(chatMessages()).toHaveLength(2);

    // After the cooldown elapses the sentinel may notify again.
    clock.value += 31 * 60_000;
    profiles[0] = snapshot({ id: 'slack', state: 'failed' });
    await sentinel.tick();
    expect(chatMessages()).toHaveLength(3);
  });

  it('detects auth-shaped tool failures on a running profile', async () => {
    writeCookie(-60);
    // grasp stays "running" while its tools 401. mcp_tool_calls has a foreign
    // key to mcp_servers; storage.initialize() seeds the built-in rows.
    storage.getDb().prepare(`
      INSERT INTO mcp_tool_calls (id, server_id, tool_name, risk, arguments_sha256, status, error)
      VALUES ('t1', 'grasp-m365', 'get_emails', 'read', 'x', 'failed', 'HTTP 401 Unauthorized from Graph')
    `).run();
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(chatMessages()).toHaveLength(1);
    expect(agentCalls[0]).toContain('grasp-m365');
  });

  it('skips opening a terminal when one is already running', async () => {
    writeCookie(-60);
    profiles[0] = snapshot({ id: 'slack', state: 'failed' });
    terminalCurrent = { id: 'busy', status: 'running', exitCode: null };
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(openedTerminals).toHaveLength(0);
    expect(chatMessages()).toHaveLength(1);
  });

  // ── Datanet (a2-analytics) Sentry branch ──

  it('SENTRY SELF-HEAL: a2 auth failure with a VALID Midway cookie primes silently and restarts — no owner interruption', async () => {
    writeCookie(3600); // Midway itself is fine
    profiles.push(snapshot({
      id: 'a2-analytics',
      state: 'failed',
      lastError: '{"__type":"com.amazon.sentry.sso#SentryRedirectException","Location":"https://sentry.amazon.com/SSO/redirect?..."}',
    }));
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(primeState.calls).toHaveLength(1);
    expect(lifecycle).toEqual(['stop:a2-analytics', 'start:a2-analytics', 'test:a2-analytics']);
    expect(chatMessages()).toHaveLength(0);
    expect(openedTerminals).toHaveLength(0);
  });

  it('SENTRY ESCALATION: when the silent prime fails (no Kerberos), the owner gets a terminal running mwinit -o -s', async () => {
    writeCookie(3600);
    primeState.result = { ok: false, reason: 'no_kerberos' };
    profiles.push(snapshot({
      id: 'a2-analytics',
      state: 'failed',
      lastError: 'Non-JSON response: <!doctype html>… HTTP Status 401 – Unauthorized',
    }));
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(primeState.calls).toHaveLength(1);
    expect(lifecycle).toHaveLength(0); // no blind restart on dead auth
    expect(openedTerminals).toHaveLength(1);
    expect(openedTerminals[0].command).toBe('mwinit -o -s');
    expect(chatMessages()).toHaveLength(1);
  });

  it('NON-AUTH a2 failure with a valid cookie stays the manager\'s problem: no prime, no restart, no message', async () => {
    writeCookie(3600);
    profiles.push(snapshot({
      id: 'a2-analytics',
      state: 'failed',
      lastError: 'FATAL no Python >=3.10',
    }));
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(primeState.calls).toHaveLength(0);
    expect(lifecycle).toHaveLength(0);
    expect(chatMessages()).toHaveLength(0);
    expect(openedTerminals).toHaveLength(0);
  });

  it('FULL MIDWAY EXPIRY with a2 among the affected upgrades the terminal command to mwinit -o -s', async () => {
    writeCookie(-3600); // Midway expired — the generic episode path
    profiles[0] = snapshot({ id: 'slack', state: 'failed' });
    profiles.push(snapshot({ id: 'a2-analytics', state: 'failed', lastError: 'HTTP 401' }));
    const sentinel = makeSentinel();
    await sentinel.tick();
    expect(openedTerminals).toHaveLength(1);
    expect(openedTerminals[0].command).toBe('mwinit -o -s');
    expect(chatMessages()).toHaveLength(1);
  });

  it('SILENT PRIME COOLDOWN: a persistently auth-failing a2 does not re-prime every tick', async () => {
    writeCookie(3600);
    profiles.push(snapshot({
      id: 'a2-analytics',
      state: 'failed',
      lastError: 'NotAuthorizedException',
    }));
    const sentinel = makeSentinel();
    await sentinel.tick();
    clock.value += 45_000; // next poll, inside the 10-min cooldown
    await sentinel.tick();
    expect(primeState.calls).toHaveLength(1);
  });
});
