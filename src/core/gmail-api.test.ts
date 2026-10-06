import { describe, expect, it } from 'vitest';
import {
  GMAIL_MAX_UPLOAD_BYTES,
  GMAIL_READONLY_SCOPE,
  GoogleApiError,
  createGmailClient,
  refreshAccessToken,
  revokeToken,
  type GoogleEndpoints,
} from './gmail-api.js';

/** The Gmail REST wire contract BotBoy relies on, against a scripted server. */
const ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.test/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth.test/token',
  revokeUrl: 'https://oauth.test/revoke',
  apiBase: 'https://gmail.test/',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function scripted(routes: Array<(url: URL, init?: RequestInit) => Response | undefined>) {
  const calls: Array<{ url: URL; auth?: string; method?: string }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization, method: init?.method });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    return json({ error: { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] } }, 404);
  };
  return { calls, fetchImpl };
}

function clientFor(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, tokens = ['token-a', 'token-b', 'token-c']) {
  let index = 0;
  let invalidations = 0;
  const client = createGmailClient({
    fetchImpl,
    endpoints: ENDPOINTS,
    accessToken: async () => tokens[Math.min(index, tokens.length - 1)],
    invalidateAccessToken: () => { invalidations++; index++; },
  });
  return { client, invalidations: () => invalidations };
}

describe('Gmail REST client', () => {
  it('calls the documented read-only endpoints with their parameters and normalizes the answers', async () => {
    const { calls, fetchImpl } = scripted([
      url => (url.pathname === '/gmail/v1/users/me/profile' ? json({ emailAddress: 'Jane.Doe@Gmail.com', historyId: 98765, messagesTotal: '12' }) : undefined),
      url => (url.pathname === '/gmail/v1/users/me/messages' ? json({ messages: [{ id: 'a1', threadId: 't1' }, { nope: true }], nextPageToken: 'p2', resultSizeEstimate: 2 }) : undefined),
      url => (url.pathname === '/gmail/v1/users/me/messages/a%2F1' ? json({ id: 'a/1', threadId: 't1', labelIds: ['INBOX'], payload: { mimeType: 'text/plain' } }) : undefined),
      url => (url.pathname === '/gmail/v1/users/me/history' ? json({
        history: [
          { id: '101', messages: [{ id: 'x' }], messagesAdded: [{ message: { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] } }, { message: {} }] },
          { id: 102 },
        ],
        historyId: '105',
      }) : undefined),
      url => (url.pathname === '/gmail/v1/users/me/settings/sendAs' ? json({ sendAs: [{ sendAsEmail: 'Jane.Doe@gmail.com', isPrimary: true }, { sendAsEmail: ' JANE@doe.dev ' }, {}] }) : undefined),
    ]);
    const { client } = clientFor(fetchImpl);

    expect(await client.getProfile()).toEqual({ emailAddress: 'jane.doe@gmail.com', historyId: '98765', messagesTotal: 12 });
    expect(await client.listMessages({ q: 'after:1 -in:drafts', pageToken: 'p1', maxResults: 500 }))
      .toEqual({ messages: [{ id: 'a1', threadId: 't1' }], nextPageToken: 'p2', resultSizeEstimate: 2 });
    expect((await client.getMessage('a/1')).id).toBe('a/1');
    expect(await client.listHistory({ startHistoryId: '100', maxResults: 500 })).toEqual({
      records: [
        { id: '101', messagesAdded: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'] }] },
        { id: '102', messagesAdded: [] },
      ],
      nextPageToken: undefined,
      historyId: '105',
    });
    expect(await client.listSendAsAddresses()).toEqual(['jane.doe@gmail.com', 'jane@doe.dev']);

    const [, list, get, history] = calls;
    expect(Object.fromEntries(list.url.searchParams)).toEqual({ q: 'after:1 -in:drafts', pageToken: 'p1', maxResults: '500', includeSpamTrash: 'false' });
    expect(Object.fromEntries(get.url.searchParams)).toEqual({ format: 'full' });
    expect(Object.fromEntries(history.url.searchParams)).toEqual({ startHistoryId: '100', maxResults: '500', historyTypes: 'messageAdded' });
    expect(calls.every(call => call.method === 'GET' && call.auth === 'Bearer token-a')).toBe(true);
  });

  it('retries a 401 once with a fresh token, then gives up with a clear error', async () => {
    let profileCalls = 0;
    const { calls, fetchImpl } = scripted([
      url => {
        if (url.pathname !== '/gmail/v1/users/me/profile') return undefined;
        profileCalls++;
        return profileCalls === 1 ? json({ error: { code: 401, message: 'Invalid Credentials' } }, 401) : json({ emailAddress: 'a@b.com', historyId: '1' });
      },
    ]);
    const retried = clientFor(fetchImpl);
    expect((await retried.client.getProfile()).emailAddress).toBe('a@b.com');
    expect(retried.invalidations()).toBe(1);
    expect(calls.map(call => call.auth)).toEqual(['Bearer token-a', 'Bearer token-b']);

    // Google's own 401 body shape.
    const alwaysDenied = scripted([() => json({
      error: {
        code: 401, message: 'Request had invalid authentication credentials.',
        errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError' }], status: 'UNAUTHENTICATED',
      },
    }, 401)]);
    const denied = clientFor(alwaysDenied.fetchImpl);
    const error = await denied.client.getProfile().catch(caught => caught);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 401, code: 'authError' });
    expect(error.message).toBe('Gmail profile failed (HTTP 401 authError: Request had invalid authentication credentials.)');
    expect(alwaysDenied.calls).toHaveLength(2);
  });

  it('reduces Google errors to status, reason, and a redacted message', async () => {
    const leaked = `ya29.${'a1B2c3D4'.repeat(6)}`;
    const { fetchImpl } = scripted([
      url => (url.pathname.endsWith('/messages/quota') ? json({ error: { code: 403, message: `User-rate limit exceeded for ${leaked}`, errors: [{ reason: 'userRateLimitExceeded' }] } }, 403) : undefined),
      url => (url.pathname.endsWith('/messages/html') ? new Response('<html>502 Bad Gateway</html>', { status: 502 }) : undefined),
      url => (url.pathname.endsWith('/messages/empty') ? json({ id: 'empty' }) : undefined),
    ]);
    const { client } = clientFor(fetchImpl);

    const quota = await client.getMessage('quota').catch(caught => caught);
    expect(quota).toMatchObject({ status: 403, code: 'userRateLimitExceeded' });
    expect(quota.message).toContain('Gmail message failed (HTTP 403 userRateLimitExceeded');
    expect(quota.message).not.toContain(leaked);

    expect(await client.getMessage('missing').catch(caught => caught)).toMatchObject({ status: 404, code: 'notFound' });
    expect(await client.getMessage('html').catch(caught => caught)).toMatchObject({ status: 502, code: 'unreadable_response' });
    expect(await client.getMessage('empty').catch(caught => caught)).toMatchObject({ status: 200, code: 'unreadable_response' });

    const offline = clientFor(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    const network = await offline.client.getProfile().catch(caught => caught);
    expect(network).toMatchObject({ status: 0, code: 'network', message: 'Gmail profile failed: network error (ENOTFOUND)' });
  });

  it('posts token refreshes and revokes as forms and keeps the token out of errors', async () => {
    const forms: Array<Record<string, string>> = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      forms.push({ url: input, contentType: String((init?.headers as Record<string, string>)['Content-Type']), ...form });
      if (input === ENDPOINTS.revokeUrl) return json({ error: 'invalid_token' }, 400);
      return form.refresh_token === 'good'
        ? json({ access_token: 'fresh', expires_in: 1800, scope: GMAIL_READONLY_SCOPE })
        : json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    };

    expect(await refreshAccessToken(fetchImpl, ENDPOINTS, { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'good' }))
      .toEqual({ accessToken: 'fresh', expiresInSeconds: 1800, refreshToken: undefined, scope: GMAIL_READONLY_SCOPE });
    const failure = await refreshAccessToken(fetchImpl, ENDPOINTS, { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'dead-refresh' }).catch(caught => caught);
    expect(failure).toMatchObject({ status: 400, code: 'invalid_grant' });
    expect(failure.message).toBe('Gmail token refresh failed (HTTP 400 invalid_grant: Token has been expired or revoked.)');
    expect(failure.message).not.toContain('dead-refresh');
    expect(forms[0]).toMatchObject({ url: ENDPOINTS.tokenUrl, contentType: 'application/x-www-form-urlencoded', grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'good' });

    expect(await revokeToken(fetchImpl, ENDPOINTS, 'old-token')).toBe(false);
    expect(forms.at(-1)).toMatchObject({ url: ENDPOINTS.revokeUrl, token: 'old-token' });
  });
});

/** The gmail.compose wire contract (GMAIL_CHAT_TOOLS_PLAN.md §6) and the reads the chat tools use. */
describe('Gmail REST client: chat reads and compose', () => {
  function recording(routes: Array<(url: URL, method: string, body: any) => Response | undefined>) {
    const calls: Array<{ url: URL; method: string; body: any; auth?: string; contentType?: string }> = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = String(init?.method ?? 'GET');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body, auth: headers.Authorization, contentType: headers['Content-Type'] });
      for (const route of routes) {
        const response = route(url, method, body);
        if (response) return response;
      }
      return json({ error: { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] } }, 404);
    };
    return { calls, fetchImpl };
  }
  const base = '/gmail/v1/users/me';
  const message = (id: string, labelIds: string[] = []) => ({ id, threadId: 't1', labelIds });

  it('reads metadata with repeated metadataHeaders, threads in full, and widens a search into spam/trash only on request', async () => {
    const { calls, fetchImpl } = recording([
      (url) => (url.pathname === `${base}/messages/m1` ? json(message('m1', ['INBOX'])) : undefined),
      (url) => (url.pathname === `${base}/threads/t1` ? json({ id: 't1', historyId: 9, messages: [message('m1'), { id: 'broken' }, message('m2')] }) : undefined),
      (url) => (url.pathname === `${base}/messages` ? json({ messages: [], resultSizeEstimate: 0 }) : undefined),
    ]);
    const { client } = clientFor(fetchImpl);
    await client.getMessage('m1', { format: 'metadata', metadataHeaders: ['From', 'Subject'] });
    expect(calls[0].url.searchParams.get('format')).toBe('metadata');
    expect(calls[0].url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject']);
    // metadataHeaders only applies to the metadata format.
    await client.getMessage('m1', { format: 'full', metadataHeaders: ['From'] });
    expect(calls[1].url.searchParams.getAll('metadataHeaders')).toEqual([]);

    expect(await client.getThread('t1')).toEqual({ id: 't1', historyId: '9', messages: [message('m1'), message('m2')] });
    expect(calls[2].url.searchParams.get('format')).toBe('full');

    expect(await client.listMessages({ q: 'in:trash invoice', maxResults: 5, includeSpamTrash: true })).toEqual({ messages: [], nextPageToken: undefined, resultSizeEstimate: 0 });
    expect(calls[3].url.searchParams.get('includeSpamTrash')).toBe('true');
  });

  it('creates, updates, reads, deletes, and sends drafts and messages with the documented verbs, paths, and bodies', async () => {
    const draft = (id: string, messageId: string) => ({ id, message: { id: messageId, threadId: 't1', labelIds: ['DRAFT'] } });
    const { calls, fetchImpl } = recording([
      (url, method) => (method === 'POST' && url.pathname === `${base}/drafts` ? json(draft('r-1', 'm-a')) : undefined),
      (url, method) => (method === 'PUT' && url.pathname === `${base}/drafts/r-1` ? json(draft('r-1', 'm-b')) : undefined),
      (url, method) => (method === 'GET' && url.pathname === `${base}/drafts/r-1` ? json(draft('r-1', 'm-b')) : undefined),
      (url, method) => (method === 'DELETE' && url.pathname === `${base}/drafts/r-1` ? new Response(null, { status: 204 }) : undefined),
      (url, method) => (method === 'POST' && url.pathname === `${base}/drafts/send` ? json(message('m-sent', ['SENT'])) : undefined),
      (url, method) => (method === 'POST' && url.pathname === `${base}/messages/send` ? json(message('m-new', ['SENT'])) : undefined),
    ]);
    const { client } = clientFor(fetchImpl);

    expect(await client.createDraft({ raw: 'cmF3', threadId: 't1' })).toEqual(draft('r-1', 'm-a'));
    expect(await client.updateDraft('r-1', { raw: 'cmF3Mg' })).toEqual(draft('r-1', 'm-b'));
    expect(await client.getDraft('r-1')).toEqual(draft('r-1', 'm-b'));
    await expect(client.deleteDraft('r-1')).resolves.toBeUndefined();
    expect((await client.sendDraft('r-1')).id).toBe('m-sent');
    expect((await client.sendMessage({ raw: 'cmF3Mw' })).labelIds).toEqual(['SENT']);

    expect(calls.map(call => `${call.method} ${call.url.pathname.replace(base, '')}`)).toEqual([
      'POST /drafts', 'PUT /drafts/r-1', 'GET /drafts/r-1', 'DELETE /drafts/r-1', 'POST /drafts/send', 'POST /messages/send',
    ]);
    expect(calls[0].body).toEqual({ message: { raw: 'cmF3', threadId: 't1' } });
    expect(calls[1].body).toEqual({ id: 'r-1', message: { raw: 'cmF3Mg' } });
    expect(calls[2].url.searchParams.get('format')).toBe('full');
    expect(calls[4].body).toEqual({ id: 'r-1' });
    expect(calls[5].body).toEqual({ raw: 'cmF3Mw' });
    expect(calls.filter(call => call.body !== undefined).every(call => call.contentType === 'application/json')).toBe(true);
    expect(calls.every(call => call.auth === 'Bearer token-a')).toBe(true);
  });

  it('retries a 401 on a send once (Google rejects auth before processing) and names transport failures', async () => {
    let sends = 0;
    const { calls, fetchImpl } = recording([
      (url, method) => {
        if (method !== 'POST' || url.pathname !== `${base}/messages/send`) return undefined;
        sends++;
        return sends === 1 ? json({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401) : json(message('m-1', ['SENT']));
      },
    ]);
    const retried = clientFor(fetchImpl);
    expect((await retried.client.sendMessage({ raw: 'eA' })).id).toBe('m-1');
    expect(calls.map(call => call.auth)).toEqual(['Bearer token-a', 'Bearer token-b']);
    expect(retried.invalidations()).toBe(1);

    const reset = clientFor(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
    expect(await reset.client.sendMessage({ raw: 'eA' }).catch(error => error)).toMatchObject({ status: 0, code: 'network', transportCode: 'ECONNRESET' });

    const answered = recording([(url, method) => (method === 'POST' ? json({ unexpected: true }) : undefined)]);
    expect(await clientFor(answered.fetchImpl).client.sendMessage({ raw: 'eA' }).catch(error => error)).toMatchObject({ status: 200, code: 'unreadable_response' });
    expect(await clientFor(answered.fetchImpl).client.createDraft({ raw: 'eA' }).catch(error => error)).toMatchObject({ code: 'unreadable_response' });
  });
});

/**
 * Mail with attachments goes through Gmail's resumable upload
 * (developers.google.com/workspace/gmail/api/guides/uploads): open a session,
 * PUT the RFC 822 bytes, and after an interruption ask Google what it holds.
 */
describe('Gmail REST client: resumable upload for mail with attachments', () => {
  interface UploadCall { url: URL; method: string; headers: Record<string, string>; body?: string | Buffer; redirect?: string }
  type Responder = (call: UploadCall) => Response;
  const base = '/gmail/v1/users/me';
  const SESSION = 'https://gmail.test/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=s-1';
  const BYTES = Buffer.from('To: jane@x.com\r\nSubject: Report\r\nMIME-Version: 1.0\r\n\r\nbody bytes');

  function uploads(responders: Responder[]) {
    const calls: UploadCall[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const raw = init?.body;
      const call: UploadCall = {
        url: new URL(input),
        method: String(init?.method ?? 'GET'),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        ...(raw === undefined || raw === null ? {} : { body: typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array) }),
        ...(init?.redirect ? { redirect: init.redirect } : {}),
      };
      calls.push(call);
      const responder = responders.shift();
      if (!responder) throw new Error(`unexpected ${call.method} ${input}`);
      return responder(call);
    };
    return { calls, fetchImpl };
  }
  const opened = (location = SESSION): Responder => () => new Response(null, { status: 200, headers: { Location: location } });
  const incomplete = (range?: string): Responder => () => new Response(null, { status: 308, headers: range ? { Range: range } : {} });
  const dropped = (code = 'ECONNRESET'): Responder => () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };
  const sent = (id = 'm-up'): Responder => () => json({ id, threadId: 't9', labelIds: ['SENT'] });
  const failureOf = (run: Promise<unknown>) => run.then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as GoogleApiError);

  it('opens a session with the message size and thread, then PUTs the exact bytes to the session Google named', async () => {
    const { calls, fetchImpl } = uploads([opened(), sent()]);
    const { client } = clientFor(fetchImpl);
    expect(await client.sendMessage({ rfc822: BYTES, threadId: 't9' })).toEqual({ id: 'm-up', threadId: 't9', labelIds: ['SENT'] });

    const [start, put] = calls;
    expect(start.method).toBe('POST');
    expect(`${start.url.origin}${start.url.pathname}`).toBe(`https://gmail.test/upload${base}/messages/send`);
    expect(Object.fromEntries(start.url.searchParams)).toEqual({ uploadType: 'resumable' });
    expect(start.headers).toMatchObject({
      Authorization: 'Bearer token-a',
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'message/rfc822',
      'X-Upload-Content-Length': String(BYTES.length),
    });
    expect(JSON.parse(String(start.body))).toEqual({ threadId: 't9' });
    expect(put).toMatchObject({ method: 'PUT', headers: { Authorization: 'Bearer token-a', 'Content-Type': 'message/rfc822' } });
    expect(put.url.toString()).toBe(SESSION);
    expect(put.headers['Content-Range']).toBeUndefined();
    expect(Buffer.isBuffer(put.body) && put.body.equals(BYTES)).toBe(true);
    // No redirect is ever followed with the token or the message.
    expect(calls.every(call => call.redirect === 'manual')).toBe(true);
  });

  it('creates and updates drafts through the same upload, with Draft metadata', async () => {
    const draft = (messageId: string) => () => json({ id: 'r-1', message: { id: messageId, threadId: 't9', labelIds: ['DRAFT'] } });
    const { calls, fetchImpl } = uploads([opened(), draft('m-a'), opened(), draft('m-b'), opened(), draft('m-c')]);
    const { client } = clientFor(fetchImpl);
    expect((await client.createDraft({ rfc822: BYTES, threadId: 't9' })).message.id).toBe('m-a');
    expect((await client.updateDraft('r-1', { rfc822: BYTES })).message.id).toBe('m-b');
    expect((await client.createDraft({ rfc822: BYTES })).message.id).toBe('m-c');
    // Session opens; the session address Google returns carries an upload_id.
    const opens = calls.filter(call => call.url.searchParams.get('uploadType') === 'resumable' && !call.url.searchParams.has('upload_id'));
    expect(calls.filter(call => call.url.searchParams.has('upload_id')).every(call => call.method === 'PUT' && Buffer.isBuffer(call.body) && call.body.equals(BYTES))).toBe(true);
    expect(opens.map(call => `${call.method} ${call.url.pathname}`)).toEqual([
      `POST /upload${base}/drafts`, `PUT /upload${base}/drafts/r-1`, `POST /upload${base}/drafts`,
    ]);
    expect(opens.map(call => JSON.parse(String(call.body)))).toEqual([{ message: { threadId: 't9' } }, { id: 'r-1' }, {}]);
  });

  it('after an interruption asks Google what it holds and resumes from the next byte, once', async () => {
    const { calls, fetchImpl } = uploads([opened(), dropped(), incomplete('bytes=0-9'), sent()]);
    const { client } = clientFor(fetchImpl);
    expect((await client.sendMessage({ rfc822: BYTES })).id).toBe('m-up');
    const [, first, status, resume] = calls;
    expect(Buffer.isBuffer(first.body) && first.body.length).toBe(BYTES.length);
    expect(status).toMatchObject({ method: 'PUT', headers: { 'Content-Range': `bytes */${BYTES.length}` } });
    expect(status.body).toBeUndefined();
    expect(resume.headers['Content-Range']).toBe(`bytes 10-${BYTES.length - 1}/${BYTES.length}`);
    expect(Buffer.isBuffer(resume.body) && resume.body.equals(BYTES.subarray(10))).toBe(true);

    // Google holding nothing (no Range): the resume sends every byte, with its range.
    const fromZero = uploads([opened(), () => json({ error: { code: 503, message: 'Backend Error' } }, 503), incomplete(), sent()]);
    expect((await clientFor(fromZero.fetchImpl).client.sendMessage({ rfc822: BYTES })).id).toBe('m-up');
    expect(fromZero.calls[3].headers['Content-Range']).toBe(`bytes 0-${BYTES.length - 1}/${BYTES.length}`);
    expect(Buffer.isBuffer(fromZero.calls[3].body) && fromZero.calls[3].body.equals(BYTES)).toBe(true);
  });

  it('reports a send Google finished before the answer was lost, without sending again', async () => {
    const { calls, fetchImpl } = uploads([opened(), () => json({ error: { code: 503, message: 'Backend Error' } }, 503), sent('m-done')]);
    const { client } = clientFor(fetchImpl);
    expect((await client.sendMessage({ rfc822: BYTES })).id).toBe('m-done');
    expect(calls.filter(call => Buffer.isBuffer(call.body))).toHaveLength(1);
  });

  it('knows the effect whenever Google answers: a failed open, a rejection, or bytes Google lacks saved or sent nothing', async () => {
    const run = (responders: Responder[]) => {
      const server = uploads(responders);
      return { ...server, client: clientFor(server.fetchImpl).client };
    };
    const busyOpen = run([() => json({ error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }, 503)]);
    expect(await failureOf(busyOpen.client.sendMessage({ rfc822: BYTES }))).toMatchObject({ status: 503, code: 'backendError', effect: 'none' });
    const lostOpen = run([dropped()]);
    expect(await failureOf(lostOpen.client.sendMessage({ rfc822: BYTES }))).toMatchObject({ code: 'network', transportCode: 'ECONNRESET', effect: 'none' });

    const rejected = run([opened(), () => json({ error: { code: 400, message: 'Invalid To header', errors: [{ reason: 'invalidArgument' }] } }, 400)]);
    expect(await failureOf(rejected.client.sendMessage({ rfc822: BYTES }))).toMatchObject({ status: 400, code: 'invalidArgument', effect: 'none' });
    expect(rejected.calls).toHaveLength(2);

    const neverLeft = run([opened(), dropped('ENOTFOUND')]);
    expect(await failureOf(neverLeft.client.sendMessage({ rfc822: BYTES }))).toMatchObject({ code: 'network', effect: 'none' });
    expect(neverLeft.calls).toHaveLength(2);

    const twice = run([opened(), dropped(), incomplete('bytes=0-9'), dropped(), incomplete('bytes=0-19')]);
    expect(await failureOf(twice.client.sendMessage({ rfc822: BYTES }))).toMatchObject({ code: 'upload_incomplete', effect: 'none' });

    // Only a status Google never gave leaves the effect unknown.
    const silent = run([opened(), dropped(), dropped()]);
    expect(await failureOf(silent.client.sendMessage({ rfc822: BYTES }))).toMatchObject({ code: 'network', transportCode: 'ECONNRESET', effect: 'unknown' });
    const strange = run([opened(), dropped(), () => json({ error: { code: 410, message: 'Gone' } }, 410)]);
    expect(await failureOf(strange.client.sendMessage({ rfc822: BYTES }))).toMatchObject({ effect: 'unknown' });
    const unreadable = run([opened(), () => new Response('<html>ok</html>', { status: 200 })]);
    const garbled = await failureOf(unreadable.client.sendMessage({ rfc822: BYTES }));
    expect(garbled).toMatchObject({ status: 200, code: 'unreadable_response' });
    expect(garbled.effect).toBeUndefined();
  });

  it('retries a 401 on the open with a fresh token, and sends nothing to a session outside Google', async () => {
    const { calls, fetchImpl } = uploads([() => json({ error: { code: 401, message: 'Invalid Credentials' } }, 401), opened(), sent()]);
    const retried = clientFor(fetchImpl);
    expect((await retried.client.sendMessage({ rfc822: BYTES })).id).toBe('m-up');
    expect(calls.map(call => call.headers.Authorization)).toEqual(['Bearer token-a', 'Bearer token-b', 'Bearer token-b']);
    expect(retried.invalidations()).toBe(1);

    for (const location of ['https://evil.example/upload?upload_id=x', 'http://www.googleapis.com/upload?upload_id=x', '']) {
      const foreign = uploads([opened(location)]);
      const error = await failureOf(clientFor(foreign.fetchImpl).client.sendMessage({ rfc822: BYTES }));
      expect(error).toMatchObject({ code: 'unreadable_response', effect: 'none' });
      expect(foreign.calls).toHaveLength(1);
    }
    // Google's own upload host is a Google API address.
    const google = uploads([opened('https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=g'), sent()]);
    expect((await clientFor(google.fetchImpl).client.sendMessage({ rfc822: BYTES })).id).toBe('m-up');
    expect(google.calls[1].url.hostname).toBe('www.googleapis.com');

    const huge = uploads([]);
    const tooLarge = await failureOf(clientFor(huge.fetchImpl).client.sendMessage({ rfc822: Buffer.alloc(GMAIL_MAX_UPLOAD_BYTES + 1) }));
    expect(tooLarge).toMatchObject({ status: 413, code: 'message_too_large', effect: 'none' });
    expect(huge.calls).toHaveLength(0);
  });
});
