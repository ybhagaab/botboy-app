import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveClient } from './gdrive-api.js';
import { GoogleApiError } from './gmail-api.js';
import { createGoogleWorkspaceClients } from './google-workspace-api.js';
import { googleErrorFailure } from './google-tool-support.js';

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

function stub(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const entry: Seen = { url, method: String(init?.method ?? 'GET'), headers: { ...(init?.headers as Record<string, string> ?? {}) }, body: init?.body === undefined ? '' : Buffer.isBuffer(init.body) ? init.body.toString('utf8') : String(init.body) };
    seen.push(entry);
    return answer(entry);
  });
  return { seen, fetchImpl };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('Workspace REST clients', () => {
  it('sends Docs, Slides and Forms writes with the revision guard, and Forms publish with its mask', async () => {
    const { seen, fetchImpl } = stub(() => json({ replies: [] }));
    const clients = createGoogleWorkspaceClients({ fetchImpl: fetchImpl as any, accessToken: async () => 'tok' });
    await clients.docs.batchUpdate('doc/1', [{ insertText: { location: { index: 1 }, text: 'x' } }], 'rev-9');
    await clients.slides.batchUpdate('deck1', [], 'srev-2');
    await clients.forms.setPublishState('form1', { isPublished: true, isAcceptingResponses: false });
    expect(seen[0]).toMatchObject({ url: 'https://docs.googleapis.com/v1/documents/doc%2F1:batchUpdate', method: 'POST' });
    expect(JSON.parse(seen[0].body)).toEqual({ requests: [{ insertText: { location: { index: 1 }, text: 'x' } }], writeControl: { requiredRevisionId: 'rev-9' } });
    expect(seen[0].headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(seen[1].body).writeControl).toEqual({ requiredRevisionId: 'srev-2' });
    expect(seen[2].url).toBe('https://forms.googleapis.com/v1/forms/form1:setPublishSettings');
    expect(JSON.parse(seen[2].body)).toEqual({ publishSettings: { publishState: { isPublished: true, isAcceptingResponses: false } }, updateMask: 'publishState' });
  });

  it('writes Sheets values as the owner types them, and appends as new rows', async () => {
    const { seen, fetchImpl } = stub(() => json({}));
    const { sheets } = createGoogleWorkspaceClients({ fetchImpl: fetchImpl as any, accessToken: async () => 'tok' });
    await sheets.valuesBatchUpdate('s1', [{ range: "'My tab'!B2", values: [['=A2*2']] }], 'USER_ENTERED');
    await sheets.valuesAppend('s1', 'Sheet1', [['a', 1]], 'RAW');
    await sheets.valuesBatchGet('s1', ['Sheet1!A1:B2', 'Notes'], 'FORMULA');
    expect(JSON.parse(seen[0].body)).toEqual({ valueInputOption: 'USER_ENTERED', data: [{ range: "'My tab'!B2", majorDimension: 'ROWS', values: [['=A2*2']] }] });
    expect(seen[1].url).toBe('https://sheets.googleapis.com/v4/spreadsheets/s1/values/Sheet1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS');
    const read = new URL(seen[2].url);
    expect(read.searchParams.getAll('ranges')).toEqual(['Sheet1!A1:B2', 'Notes']);
    expect(read.searchParams.get('valueRenderOption')).toBe('FORMULA');
  });

  it('creates Calendar events with the update rule and a Meet request flag', async () => {
    const { seen, fetchImpl } = stub(() => json({ id: 'e1' }));
    const { calendar } = createGoogleWorkspaceClients({ fetchImpl: fetchImpl as any, accessToken: async () => 'tok' });
    await calendar.insertEvent('me@example.com', { id: 'e1', summary: 'x' }, { sendUpdates: 'all', conference: true });
    expect(seen[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/me%40example.com/events?sendUpdates=all&conferenceDataVersion=1');
  });
});

describe('Drive client additions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shares with the notification choice, moves with add/remove parents, and copies with a key', async () => {
    const { seen, fetchImpl } = stub(() => json({ id: 'p1', type: 'user', role: 'reader' }));
    const drive = createDriveClient({ fetchImpl: fetchImpl as any, accessToken: async () => 'tok' });
    await drive.createPermission('f1', { type: 'user', role: 'reader', emailAddress: 'ana@example.com' }, { sendNotificationEmail: false, emailMessage: 'Have a look' });
    await drive.updateFile('f1', {}, { add: ['fold2'], remove: ['root'] });
    await drive.copyFile('f1', { name: 'Copy', appProperties: { botboyCreate: 'k1' } });
    const share = new URL(seen[0].url);
    expect(share.pathname).toBe('/drive/v3/files/f1/permissions');
    expect(share.searchParams.get('sendNotificationEmail')).toBe('false');
    expect(share.searchParams.get('emailMessage')).toBe('Have a look');
    const move = new URL(seen[1].url);
    expect([move.searchParams.get('addParents'), move.searchParams.get('removeParents')]).toEqual(['fold2', 'root']);
    expect(JSON.parse(seen[2].body)).toEqual({ name: 'Copy', appProperties: { botboyCreate: 'k1' } });
  });

  it('uploads in resumable chunks: starts a session, follows 308s, and asks how far Google got after a lost answer', async () => {
    let chunk = 0;
    const { seen, fetchImpl } = stub((entry) => {
      if (entry.url.includes('uploadType=resumable')) return new Response('', { status: 200, headers: { Location: 'https://upload.test/session/1' } });
      if (entry.headers['Content-Range'] === 'bytes */10') return new Response('', { status: 308, headers: { Range: 'bytes=0-4' } });
      chunk++;
      if (chunk === 1) return new Response('', { status: 308, headers: { Range: 'bytes=0-4' } });
      return json({ id: 'new1', name: 'a.bin', mimeType: 'application/octet-stream' });
    });
    const drive = createDriveClient({ fetchImpl: fetchImpl as any, accessToken: async () => 'tok' });
    const session = await drive.startUpload({ metadata: { name: 'a.bin' }, mediaMimeType: 'application/octet-stream', size: 10 });
    expect(session).toBe('https://upload.test/session/1');
    expect(seen[0].headers['X-Upload-Content-Length']).toBe('10');
    expect(await drive.uploadChunk(session, Buffer.alloc(5), 0, 10)).toEqual({ next: 5 });
    expect(await drive.uploadStatus(session, 10)).toEqual({ next: 5 });
    expect(await drive.uploadChunk(session, Buffer.alloc(5), 5, 10)).toEqual({ done: { id: 'new1', name: 'a.bin', mimeType: 'application/octet-stream' } });
    expect(seen[1].headers['Content-Range']).toBe('bytes 0-4/10');
    expect(seen[3].headers['Content-Range']).toBe('bytes 5-9/10');
  });

  it('streams a download to disk, never over an existing file, and stops past the size limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dl-'));
    try {
      const { fetchImpl } = stub(() => new Response(Buffer.from('0123456789'), { status: 200 }));
      const drive = createDriveClient({ fetchImpl: fetchImpl as any, accessToken: async () => 'tok' });
      const target = path.join(dir, 'a.bin');
      expect(await drive.downloadTo('f1', target)).toBe(10);
      expect(fs.readFileSync(target, 'utf8')).toBe('0123456789');
      await expect(drive.downloadTo('f1', target)).rejects.toThrow(/EEXIST/);
      await expect(drive.downloadTo('f1', path.join(dir, 'b.bin'), { maxBytes: 4 })).rejects.toThrow(/larger than 4 bytes/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Google errors name what to do next', () => {
  it('an API that is off names the API and the link to turn it on', async () => {
    const { fetchImpl } = stub(() => json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Docs API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/docs.googleapis.com/overview?project=123 then retry.', errors: [{ reason: 'accessNotConfigured' }] } }, 403));
    const { docs } = createGoogleWorkspaceClients({ fetchImpl: fetchImpl as any, accessToken: async () => 'tok' });
    const error = await docs.get('d1').catch(e => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    const failure = googleErrorFailure(error, false, 'Google Docs read');
    expect(failure).toMatchObject({ code: 'api_not_enabled', effect: 'none' });
    expect(failure.message).toContain('Google Docs API');
    expect(failure.nextAction).toContain('https://console.developers.google.com/apis/api/docs.googleapis.com/overview?project=123');
  });

  it('a missing scope asks for Connect Google Drive; a timeout on a write is an unknown effect', () => {
    expect(googleErrorFailure(new GoogleApiError('Drive share failed (HTTP 403 insufficientPermissions: Request had insufficient authentication scopes.)', 403, 'insufficientPermissions'), true, 'x').code).toBe('reconnect_for_scope');
    expect(googleErrorFailure(new GoogleApiError('Google Docs edit timed out', 0, 'timeout'), true, 'x')).toMatchObject({ effect: 'unknown', nextAction: expect.stringMatching(/Do not send this again/) });
    expect(googleErrorFailure(new GoogleApiError('Google Docs edit timed out', 0, 'timeout'), false, 'x').effect).toBe('none');
    expect(googleErrorFailure(new GoogleApiError('x (HTTP 403 insufficientFilePermissions)', 403, 'insufficientFilePermissions'), true, 'x').code).toBe('no_permission');
    expect(googleErrorFailure(new GoogleApiError('x (HTTP 404 notFound)', 404, 'notFound'), true, 'x').code).toBe('not_found');
  });
});
