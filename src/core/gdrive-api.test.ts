import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleApiError } from './gmail-api.js';
import {
  GDRIVE_FILE_SCOPE,
  GDRIVE_READONLY_SCOPE,
  GDRIVE_REQUESTED_SCOPES,
  classifyWriteFailure,
  createDriveClient,
  driveFailureForHealth,
  escapeDriveQueryLiteral,
} from './gdrive-api.js';
import { createFakeDrive } from './gdrive-api.fake.js';
import { classifyCaptureFailure } from './capture-health.js';

describe('Drive scopes', () => {
  it('asks for drive.readonly + drive.file, never full drive', () => {
    expect(GDRIVE_REQUESTED_SCOPES).toEqual([GDRIVE_READONLY_SCOPE, GDRIVE_FILE_SCOPE]);
    expect(GDRIVE_REQUESTED_SCOPES).not.toContain('https://www.googleapis.com/auth/drive');
  });
});

describe('escapeDriveQueryLiteral', () => {
  it('escapes backslash then apostrophe, and round-trips against the fake', async () => {
    const name = "Owner's plan \\ v2.docx";
    expect(`name='${escapeDriveQueryLiteral(name)}'`).toBe("name='Owner\\'s plan \\\\ v2.docx'");
    const drive = createFakeDrive();
    drive.put({ id: 'a1', name, parents: ['folder1'] });
    drive.put({ id: 'a2', name: "Owner's plan", parents: ['folder1'] });
    const found = await drive.listFiles({ q: `'folder1' in parents and name='${escapeDriveQueryLiteral(name)}' and trashed=false` });
    expect(found.files.map(file => file.id)).toEqual(['a1']);
  });
});

describe('classifyWriteFailure', () => {
  const network = (code: string) => new GoogleApiError(`failed (${code})`, 0, 'network', code);
  it('never-connected and TLS causes are not_written', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED']) {
      expect(classifyWriteFailure(network(code)), code).toBe('not_written');
    }
  });
  it('lost-mid-request causes are unknown', () => {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']) expect(classifyWriteFailure(network(code)), code).toBe('unknown');
    expect(classifyWriteFailure(new GoogleApiError('timed out', 0, 'timeout'))).toBe('unknown');
    expect(classifyWriteFailure(new Error('abort'))).toBe('unknown');
  });
  it('readable 400/403/404 are not_written; 408/429/5xx and unreadable bodies are unknown', () => {
    for (const status of [400, 403, 404]) expect(classifyWriteFailure(new GoogleApiError('x', status, 'badRequest')), String(status)).toBe('not_written');
    for (const status of [408, 429, 500, 503]) expect(classifyWriteFailure(new GoogleApiError('x', status, 'backendError')), String(status)).toBe('unknown');
    expect(classifyWriteFailure(new GoogleApiError('x', 400, 'unreadable_response'))).toBe('unknown');
    expect(classifyWriteFailure(new GoogleApiError('x', 400, 'http_400'))).toBe('unknown');
  });
});

describe('driveFailureForHealth', () => {
  it('names the cause so capture health picks the next action', () => {
    const cases: Array<[unknown, string, RegExp]> = [
      [new GoogleApiError('Gmail token refresh failed (HTTP 400 invalid_grant)', 400, 'invalid_grant'), 'service_auth', /invalid_grant/],
      [new GoogleApiError('Drive file list failed (HTTP 403 insufficientPermissions: Request had insufficient authentication scopes.)', 403, 'insufficientPermissions'), 'service_auth', /insufficient scope/],
      [new GoogleApiError('Drive file list failed (HTTP 403 accessNotConfigured)', 403, 'accessNotConfigured'), 'service_auth', /accessNotConfigured/],
      [new GoogleApiError('Drive file list failed (HTTP 403 SERVICE_DISABLED)', 403, 'SERVICE_DISABLED'), 'service_auth', /accessNotConfigured/],
      [new GoogleApiError('Drive file list failed (HTTP 403 userRateLimitExceeded)', 403, 'userRateLimitExceeded'), 'rate_limited', /RateLimit/],
      [new GoogleApiError('Drive file list failed (HTTP 429 rateLimitExceeded)', 429, 'rateLimitExceeded'), 'rate_limited', /rateLimit/],
      [new GoogleApiError('failed: network error (ENOTFOUND)', 0, 'network', 'ENOTFOUND'), 'network', /network/],
    ];
    for (const [error, kind, reason] of cases) {
      const result = driveFailureForHealth(error);
      expect(result.kind, String(error)).toBe(kind);
      expect(result.reason).toMatch(reason);
    }
    expect(classifyCaptureFailure(driveFailureForHealth(cases[0][0]).reason)).toBe('service_auth');
  });
});

describe('createDriveClient over fetch', () => {
  afterEach(() => vi.restoreAllMocks());
  it('refreshes once on 401, never logs the token, and maps Google errors', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args.join(' ')); });
    const seen: string[] = [];
    let tokens = ['ya29.first-token', 'ya29.second-token'];
    let invalidated = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as any)?.Authorization));
      if (seen.length === 1) return new Response('{"error":{"code":401}}', { status: 401 });
      if (url.includes('/export')) return new Response(JSON.stringify({ error: { code: 403, message: 'too big ya29.first-token', errors: [{ reason: 'exportSizeLimitExceeded' }] } }), { status: 403 });
      return new Response(JSON.stringify({ files: [{ id: 'f1', name: 'a', mimeType: 'text/plain' }] }), { status: 200 });
    });
    const client = createDriveClient({
      fetchImpl: fetchImpl as any,
      accessToken: async () => tokens[0],
      invalidateAccessToken: () => { invalidated++; tokens = tokens.slice(1); },
    });
    const listed = await client.listFiles({ q: "trashed=false" });
    expect(listed.files[0].id).toBe('f1');
    expect(invalidated).toBe(1);
    expect(seen).toEqual(['Bearer ya29.first-token', 'Bearer ya29.second-token']);
    const error = await client.exportFile('f1', 'text/plain').catch(err => err);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.code).toBe('exportSizeLimitExceeded');
    expect(logs.join('\n')).not.toMatch(/ya29\./);
  });
});
