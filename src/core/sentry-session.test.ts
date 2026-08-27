import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hasLiveDatanetSentryCookie,
  isSentryAuthShapedError,
  primeDatanetSentrySession,
} from './sentry-session.js';

const NOW = 1_800_000_000_000; // fixed clock, epoch ms

function jarWith(lines: string[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-jar-')), 'cookie');
  fs.writeFileSync(file, ['# Netscape HTTP Cookie File', ...lines, ''].join('\n'));
  return file;
}

describe('isSentryAuthShapedError', () => {
  it('matches the live signatures observed against datanet-service', () => {
    // Each of these appeared verbatim during the 2026-08-27 spike.
    expect(isSentryAuthShapedError('{"__type":"com.amazon.sentry.sso#SentryRedirectException","Location":"https://sentry.amazon.com/SSO/redirect?..."}')).toBe(true);
    expect(isSentryAuthShapedError('Non-JSON response: <!doctype html><html lang="en"><head><title>HTTP Status 401 – Unauthorized</title>')).toBe(true);
    expect(isSentryAuthShapedError('NotAuthorizedException')).toBe(true);
    expect(isSentryAuthShapedError("hint: run 'mwinit -o -s' and retry")).toBe(true);
  });

  it('ignores ordinary failures and empty input', () => {
    expect(isSentryAuthShapedError('Job run 123 not found')).toBe(false);
    expect(isSentryAuthShapedError('timeout waiting for tool result')).toBe(false);
    expect(isSentryAuthShapedError(null)).toBe(false);
    expect(isSentryAuthShapedError(undefined)).toBe(false);
  });
});

describe('hasLiveDatanetSentryCookie', () => {
  it('finds an unexpired amzn_sso row for the datanet service, including HttpOnly-prefixed', () => {
    const future = Math.floor(NOW / 1000) + 3600;
    const jar = jarWith([
      `#HttpOnly_datanet-service.amazon.com\tFALSE\t/\tTRUE\t${future}\tamzn_sso_rfp\tvalue`,
    ]);
    expect(hasLiveDatanetSentryCookie(jar, NOW)).toBe(true);
  });

  it('treats expiry 0 as a live session cookie', () => {
    const jar = jarWith([
      `datanet-service.amazon.com\tFALSE\t/\tTRUE\t0\tamzn_sso_token\tvalue`,
    ]);
    expect(hasLiveDatanetSentryCookie(jar, NOW)).toBe(true);
  });

  it('rejects expired rows, other domains, other cookie names, and a missing file', () => {
    const past = Math.floor(NOW / 1000) - 60;
    expect(hasLiveDatanetSentryCookie(jarWith([
      `datanet-service.amazon.com\tFALSE\t/\tTRUE\t${past}\tamzn_sso_rfp\tvalue`,
    ]), NOW)).toBe(false);
    const future = Math.floor(NOW / 1000) + 3600;
    expect(hasLiveDatanetSentryCookie(jarWith([
      `#HttpOnly_.midway-auth.amazon.com\tTRUE\t/\tTRUE\t${future}\tsession\tvalue`,
      `datanet-service.amazon.com\tFALSE\t/\tTRUE\t${future}\tother_cookie\tvalue`,
    ]), NOW)).toBe(false);
    expect(hasLiveDatanetSentryCookie('/nonexistent/jar', NOW)).toBe(false);
  });
});

describe('primeDatanetSentrySession', () => {
  const fakeRunner = (behavior: { exitCode?: number; stderr?: string; error?: boolean }) => {
    return ((_cmd: string, _args: string[]) => {
      const listeners = new Map<string, (...a: any[]) => void>();
      const stderrListeners = new Map<string, (...a: any[]) => void>();
      setTimeout(() => {
        if (behavior.error) { listeners.get('error')?.(new Error('spawn ENOENT')); return; }
        if (behavior.stderr) stderrListeners.get('data')?.(Buffer.from(behavior.stderr));
        listeners.get('exit')?.(behavior.exitCode ?? 0);
      }, 5);
      return {
        stderr: { on: (event: string, callback: (...a: any[]) => void) => stderrListeners.set(event, callback) },
        on: (event: string, callback: (...a: any[]) => void) => listeners.set(event, callback),
        kill: () => undefined,
      } as any;
    }) as any;
  };

  it('resolves ok when the hop minted a live session row', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jar = jarWith([
      `datanet-service.amazon.com\tFALSE\t/\tTRUE\t${future}\tamzn_sso_rfp\tvalue`,
    ]);
    const outcome = await primeDatanetSentrySession(jar, fakeRunner({}));
    expect(outcome).toEqual({ ok: true });
  });

  it('reports no_kerberos when curl stderr names a missing credentials cache', async () => {
    const jar = jarWith([]);
    const outcome = await primeDatanetSentrySession(jar, fakeRunner({
      stderr: 'gss_init_sec_context failed: No credentials cache found',
    }));
    expect(outcome).toEqual({ ok: false, reason: 'no_kerberos' });
  });

  it('reports curl_failed when the hop completes without minting a row', async () => {
    const jar = jarWith([]);
    const outcome = await primeDatanetSentrySession(jar, fakeRunner({}));
    expect(outcome).toEqual({ ok: false, reason: 'curl_failed' });
  });

  it('never throws when curl itself cannot spawn', async () => {
    const jar = jarWith([]);
    const outcome = await primeDatanetSentrySession(jar, fakeRunner({ error: true }));
    expect(outcome).toEqual({ ok: false, reason: 'curl_failed' });
  });
});
