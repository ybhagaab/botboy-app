// @vitest-environment jsdom
//
// Connections → Gmail (dashboard.js): the card model and the settings page.
// The pure render helpers are evaluated straight from the shipped source
// against a small state object, like capture-health-ui.test.ts.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');

function topLevel(name: string): string {
  const start = dashboard.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = dashboard.indexOf('\n}\n', start);
  return dashboard.slice(start, end + 2);
}

function constLine(name: string): string {
  const match = dashboard.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}

type Card = { status: string; tone: string; detail: string };
type Helpers = { gmailSyncCardModel(): Card; renderGmailSyncSettings(): string };

function load(state: Record<string, unknown>): Helpers {
  const source = [
    constLine('icon'), constLine('esc'), constLine('attr'), constLine('number'),
    topLevel('relativeTime'), topLevel('whenPhrase'), topLevel('pageHead'),
    topLevel('captureIssueFor'), topLevel('captureIssueDetail'),
    topLevel('gmailImportActive'), topLevel('gmailImportDate'), topLevel('renderGmailImportCard'),
    topLevel('gmailSyncCardModel'), topLevel('renderGmailSyncSettings'),
    'return { gmailSyncCardModel, renderGmailSyncSettings };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', source)(state) as Helpers;
}

const REDIRECT = 'http://127.0.0.1:7778/api/gmail-sync/oauth/callback';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    clientConfigured: true, clientIdSuffix: '…ghijkl', connected: true, accountEmail: 'jane.doe@gmail.com',
    connectedAt: '2026-10-05T08:00:00.000Z', needsReconnect: false, lastError: null,
    redirectUri: REDIRECT, scope: 'https://www.googleapis.com/auth/gmail.readonly',
    ...overrides,
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true, running: false, intervalMinutes: 5, connection: connection(), noiseSenders: ['no-reply'],
    mailActive: true, backlog: 0, hasCursor: true, lastRun: null, ...overrides,
  };
}

describe('Gmail connection UI', () => {
  let state: Record<string, any>;

  beforeEach(() => {
    state = {
      gmailSync: { status: status(), error: '', busy: '' },
      captureHealth: { sources: [], issues: [], error: '' },
    };
  });

  it('walks the card through setup, connection, first sync, and activity', () => {
    state.gmailSync.status = status({ connection: connection({ clientConfigured: false, connected: false, accountEmail: null, clientIdSuffix: null }) });
    // Every shipped install starts here: BotBoy ships no Google client (D12).
    expect(load(state).gmailSyncCardModel()).toEqual({ status: 'Not connected', tone: '', detail: 'For Google accounts: add your own Google OAuth client to connect.' });

    state.gmailSync.status = status({ connection: connection({ connected: false, accountEmail: null }) });
    expect(load(state).gmailSyncCardModel().detail).toBe('OAuth client saved. Choose Connect to sign in to Google.');

    state.gmailSync.status = status();
    expect(load(state).gmailSyncCardModel()).toMatchObject({ status: 'Scheduled', tone: 'good' });

    state.gmailSync.status = status({
      backlog: 40,
      captured: { total: 18, received: 13, sent: 5, inProjects: 0 },
      lastRun: { at: new Date().toISOString(), status: 'completed', mode: 'full', counters: { emitted: 12 } },
    });
    expect(load(state).gmailSyncCardModel()).toEqual({
      status: 'Active', tone: 'good', detail: '18 emails captured from jane.doe@gmail.com. Last sync just now: 12 new; 40 more next run.',
    });

    // An idle 5-minute run reads as "no new mail", never as "0 captured".
    state.gmailSync.status = status({
      captured: { total: 18, received: 13, sent: 5, inProjects: 0 },
      lastRun: { at: new Date().toISOString(), status: 'completed', mode: 'partial', counters: { emitted: 0 } },
    });
    expect(load(state).gmailSyncCardModel().detail).toBe('18 emails captured from jane.doe@gmail.com. Last sync just now: no new mail.');

    // A server from before the totals still names the account.
    state.gmailSync.status = status({ lastRun: { at: new Date().toISOString(), status: 'completed', mode: 'partial', counters: { emitted: 2 } } });
    expect(load(state).gmailSyncCardModel().detail).toBe('Connected as jane.doe@gmail.com. Last sync just now: 2 new.');
  });

  it('shows Reconnect, pause, a lasting capture issue, and an unavailable API as warnings', () => {
    state.gmailSync.status = status({ connection: connection({ needsReconnect: true, lastError: 'Google ended BotBoy’s access to this account. Choose Reconnect.' }) });
    expect(load(state).gmailSyncCardModel()).toEqual({ status: 'Reconnect needed', tone: 'warn', detail: 'Google ended BotBoy’s access to this account. Choose Reconnect.' });

    state.gmailSync.status = status({ enabled: false });
    expect(load(state).gmailSyncCardModel()).toMatchObject({ status: 'Paused', tone: 'warn' });

    state.gmailSync.status = status();
    state.captureHealth.issues = [{
      source: 'gmail', name: 'Gmail', kind: 'network', cause: 'The service or network is not reachable',
      nextAction: 'Check your network or VPN. BotBoy retries automatically.', since: new Date().toISOString(),
      lastSuccessAt: null, failures: 3, reason: 'network error', href: '#/connections/gmail-sync',
    }];
    const issue = load(state).gmailSyncCardModel();
    expect(issue).toMatchObject({ status: 'Not syncing', tone: 'warn' });
    expect(issue.detail).toContain('Check your network or VPN.');

    state.gmailSync = { status: null, error: 'Gmail sync is unavailable.', busy: '' };
    expect(load(state).gmailSyncCardModel()).toEqual({ status: 'Unavailable', tone: 'warn', detail: 'Gmail sync is unavailable.' });
  });

  it('renders setup steps and the client form without ever showing a secret', () => {
    state.gmailSync.status = status({ connection: connection({ clientConfigured: false, connected: false, accountEmail: null, clientIdSuffix: null }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.querySelector('h1')!.textContent).toBe('Gmail');
    expect(document.getElementById('gmail-sync-client-secret')!.getAttribute('type')).toBe('password');
    expect((document.getElementById('gmail-sync-client-secret') as HTMLInputElement).value).toBe('');
    expect(document.querySelector('[data-action="gmail-sync-save-client"]')).not.toBeNull();
    expect(document.querySelector('[data-action="gmail-sync-connect"]')).toBeNull();
    expect(document.body.textContent).toContain('Desktop app');
    expect(document.body.textContent).toContain(REDIRECT);
    expect(document.body.textContent).toContain('gmail.readonly');
    // The credential-file delivery is retired (D11): the page never sends anyone for one.
    expect(document.body.textContent).not.toContain('credential file');
    // Every input is labelled.
    for (const input of document.querySelectorAll('input')) {
      expect(document.querySelector(`label[for="${input.id}"]`), `label for ${input.id}`).not.toBeNull();
    }
  });

  it('offers connect, reconnect, pause, disconnect, and sync controls by state', () => {
    state.gmailSync.status = status({ connection: connection({ connected: false, accountEmail: null }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.querySelector('[data-action="gmail-sync-connect"]')!.textContent).toContain('Connect Gmail');
    expect(document.querySelector('[data-action="gmail-sync-run"]')).toBeNull();
    expect(document.body.textContent).toContain('Client …ghijkl is saved on this Mac only.');

    state.gmailSync.status = status({
      lastRun: {
        at: new Date().toISOString(), status: 'completed', mode: 'partial', durationMs: 1200, accountEmail: 'jane.doe@gmail.com',
        counters: { listed: 9, received: 4, sent: 2, noise: 1, notAddressed: 1, skipped: 1, duplicates: 0, emitted: 6 },
      },
    });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.querySelector('[data-action="gmail-sync-connect"]')!.textContent).toContain('Reconnect');
    expect(document.querySelector('[data-action="gmail-sync-toggle"]')!.textContent).toBe('Pause automatic sync');
    expect(document.querySelector('[data-action="gmail-sync-disconnect"]')).not.toBeNull();
    expect(document.querySelector('[data-action="gmail-sync-run"]')).not.toBeNull();
    expect(document.body.textContent).toContain('4 new');
    expect(document.body.textContent).not.toContain('ingested');
    expect(document.body.textContent).toContain('Update just now in 1.2s for jane.doe@gmail.com');
    expect(document.body.textContent).toContain('Suppressed (this sync replaces it)');

    state.gmailSync.busy = 'run';
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.querySelector('[data-action="gmail-sync-run"]')!.textContent).toContain('Syncing…');
    expect((document.querySelector('[data-action="gmail-sync-disconnect"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows what BotBoy holds beside the last run, and the 30-day window', () => {
    state.gmailSync.status = status({ captured: { total: 1800, received: 1300, sent: 500, inProjects: 42 } });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    const details = document.querySelector('.connection-details')!.textContent!;
    expect(details).toContain('Captured1,800 emails (1,300 received, 500 sent)');
    expect(details).toContain('In projects42');
    expect(document.body.textContent).toContain('captures the last 30 days of mail when you connect, then new mail as it arrives');
    expect(document.body.textContent).toContain('searches and reads your whole mailbox');
  });

  it('offers Import the last 6 months, shows progress with Stop, and reports the finished import', () => {
    state.gmailSync.status = status({ import: null });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    const start = document.querySelector('[data-action="gmail-sync-import"]')!;
    expect(start.textContent).toContain('Import the last 6 months');
    expect(document.querySelector('[data-action="gmail-sync-import-stop"]')).toBeNull();
    expect(document.body.textContent).toContain('When you connect, BotBoy captures the last 30 days.');

    state.gmailSync.status = status({ import: { status: 'requested', months: 6, requestedAt: new Date().toISOString(), sinceIso: null, finishedAt: null, total: 0, checked: 0, captured: 0, duplicates: 0, filtered: 0, truncated: false } });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.body.textContent).toContain('BotBoy lists the last 6 months on its next sync');
    expect(document.querySelector('[data-action="gmail-sync-import-stop"]')!.textContent).toBe('Stop import');

    const importing = { status: 'importing', months: 6, requestedAt: new Date().toISOString(), sinceIso: '2026-04-06T07:00:00.000Z', finishedAt: null, total: 3900, checked: 120, captured: 30, duplicates: 10, filtered: 80, truncated: false };
    state.gmailSync.status = status({
      import: importing,
      captured: { total: 48, received: 40, sent: 8, inProjects: 3 },
      lastRun: { at: new Date().toISOString(), status: 'completed', mode: 'partial', counters: { emitted: 0 } },
    });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.body.textContent).toContain('120 of 3,900 checked, 30 captured. About 38 minutes left.');
    expect(document.body.textContent).toMatch(/Importing mail since \d{1,2} Apr 2026|Importing mail since Apr \d{1,2}, 2026/);
    expect(document.querySelector('[data-action="gmail-sync-import"]')).toBeNull();
    expect(load(state).gmailSyncCardModel().detail).toBe('48 emails captured from jane.doe@gmail.com. Last sync just now: no new mail. Importing older mail: 120 of 3,900 checked.');

    state.gmailSync.status = status({ import: { ...importing, status: 'done', checked: 3900, captured: 900, duplicates: 18, filtered: 2982, finishedAt: new Date().toISOString(), truncated: true } });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.body.textContent).toContain('just now: 900 captured, 18 already in BotBoy, 2,982 filtered out.');
    expect(document.body.textContent).toContain('BotBoy took the newest 10,000 messages');
    expect(document.querySelector('[data-action="gmail-sync-import"]')).not.toBeNull();

    state.gmailSync.status = status({ import: { ...importing, status: 'stopped', finishedAt: new Date().toISOString() } });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.body.textContent).toContain('Import stopped just now after 120 of 3,900 messages: 30 captured.');

    // Not connected: no import card at all.
    state.gmailSync.status = status({ connection: connection({ connected: false, accountEmail: null }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.querySelector('[data-action="gmail-sync-import"]')).toBeNull();

    // The controls are wired, and the open page refreshes while an import runs.
    expect(dashboard).toContain("request('/gmail-sync/import', { method: 'POST', body: { months: 6 } })");
    expect(dashboard).toContain("request('/gmail-sync/import', { method: 'DELETE' })");
    const poll = topLevel('pollVersion');
    expect(poll).toContain("state.route.view === 'gmail-sync-settings' && !state.gmailSync.busy && gmailImportActive(state.gmailSync.status)");
    expect(poll).toContain("startsWith('gmail-sync-')");
  });

  it('with BotBoy’s shared client shows only Connect, the unverified-app steps, and the own client under Advanced', () => {
    state.gmailSync.status = status({ connection: connection({ connected: false, accountEmail: null, clientSource: 'team', teamClientAvailable: true, ownClientConfigured: false }) });
    expect(load(state).gmailSyncCardModel().detail).toBe('Choose Connect Gmail and sign in to Google.');
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    const connect = document.querySelectorAll('[data-action="gmail-sync-connect"]');
    expect(connect).toHaveLength(1);
    expect(connect[0].textContent).toContain('Connect Gmail');
    expect(document.body.textContent).toContain('Google hasn’t verified this app');
    expect(document.body.textContent).toContain('the BotBoy owner never sees it or your mail');
    // The own-client form exists only inside the closed Advanced section.
    const advanced = document.querySelector('details') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')!.textContent).toBe('Advanced: use your own Google OAuth client');
    expect(advanced.querySelector('#gmail-sync-client-id')).not.toBeNull();
    expect(document.querySelectorAll('#gmail-sync-client-id')).toHaveLength(1);
    expect(advanced.querySelector('[data-action="gmail-sync-remove-client"]')).toBeNull();
    expect(document.body.textContent).toContain('gmail.compose');
  });

  it('asks a read-only connection to Reconnect for drafting and sending, and shows the access level', () => {
    state.gmailSync.status = status({ connection: connection({ clientSource: 'own', ownClientConfigured: true, canCompose: false, needsComposeGrant: true }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.body.textContent).toContain('cannot draft or send yet. Choose Reconnect and allow “Manage drafts and send emails”.');
    expect(document.body.textContent).toContain('Read only');
    expect(document.querySelector('[data-action="gmail-sync-connect"]')!.textContent).toContain('Reconnect');

    state.gmailSync.status = status({ connection: connection({ clientSource: 'own', ownClientConfigured: true, canCompose: true, needsComposeGrant: false }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.body.textContent).not.toContain('cannot draft or send yet');
    expect(document.body.textContent).toContain('Read, draft, and send');
    expect(document.body.textContent).toContain('It drafts or sends only when you ask in chat.');

    // A dead grant shows the reconnect warning alone, not the compose banner on top.
    state.gmailSync.status = status({ connection: connection({ needsReconnect: true, needsComposeGrant: true, lastError: 'Google ended BotBoy’s access.' }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.body.textContent).not.toContain('cannot draft or send yet');
  });

  it('labels removing an own client as a switch back when the shared client is there', () => {
    state.gmailSync.status = status({ connection: connection({ clientSource: 'own', ownClientConfigured: true, teamClientAvailable: true }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.querySelector('[data-action="gmail-sync-remove-client"]')!.textContent).toBe('Remove my client');
    expect(document.body.textContent).toContain('Remove it to use BotBoy’s shared Google client instead.');
    const handler = dashboard.slice(dashboard.indexOf("if (action === 'gmail-sync-remove-client')"), dashboard.indexOf("if (action === 'gmail-sync-connect')"));
    expect(handler).toContain('teamClientAvailable');
    expect(handler).toContain('BotBoy switches to its shared Google client');
  });

  it('offers the downloaded client JSON as a labelled file input', () => {
    state.gmailSync.status = status({ connection: connection({ clientConfigured: false, connected: false, accountEmail: null, clientIdSuffix: null }) });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    const file = document.getElementById('gmail-sync-client-file') as HTMLInputElement;
    expect(file.type).toBe('file');
    expect(file.accept).toContain('.json');
    expect(document.querySelector('label[for="gmail-sync-client-file"]')!.textContent).toContain('Desktop app client');
  });

  it('is wired into routing, the core load, the Connections grid, capture issues, and version refresh', () => {
    expect(topLevel('parseRoute')).toContain("parts[1] === 'gmail-sync') return { view: 'gmail-sync-settings' }");
    const core = topLevel('loadCore');
    expect(core).toContain("request('/gmail-sync/status')");
    expect(dashboard).toContain("['mail', 'Gmail', gmailSyncCard.status, gmailSyncCard.tone, gmailSyncCard.detail, 'gmail-sync']");
    expect(dashboard).toContain("'gmail-sync': 'gmail'");
    // The OAuth start is a top-level navigation to Google, never a popup or fetch.
    expect(dashboard).toMatch(/window\.location\.assign\(\w+\.authUrl\)/);
    expect(topLevel('pollVersion')).toContain('gmail-sync-settings');
    expect(dashboard).toContain("if (action === 'gmail-sync-save-client') void saveGmailClientFromForm();");
    expect(dashboard).toContain("if (action === 'gmail-sync-save-noise') void saveGmailNoiseFromForm();");
    expect(dashboard).toMatch(/event\.target\?\.id === 'gmail-sync-client-file'\) \{\s*void saveGmailClientFromFile\(event\.target\);/);
  });
});

/**
 * Saving reads the fields BEFORE the busy repaint, which recreates them
 * empty (owner report 2026-10-06: every Save client sent an empty ID).
 */
describe('Gmail client and noise saves', () => {
  type SaveHelpers = {
    parseGoogleClientJson(text: string): { clientId: string; clientSecret: string };
    saveGmailClientFromForm(): Promise<void>;
    saveGmailClientFromFile(input: HTMLInputElement): Promise<void>;
    saveGmailNoiseFromForm(): Promise<void>;
  };
  const FORM = '<input id="gmail-sync-client-id" type="text"><input id="gmail-sync-client-secret" type="password"><textarea id="gmail-sync-noise">no-reply</textarea>';
  const DESKTOP_JSON = JSON.stringify({
    installed: {
      client_id: ' 1234567890-abcdefghijkl.apps.googleusercontent.com ', project_id: 'p', client_secret: 'file-secret-value',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'],
    },
  });
  let state: Record<string, any>;
  let calls: Array<{ path: string; options: any }>;
  let toasts: string[];
  let helpers: SaveHelpers;

  beforeEach(() => {
    document.body.innerHTML = FORM;
    state = { gmailSync: { status: null, error: '', busy: '' } };
    calls = [];
    toasts = [];
    const request = async (path: string, options: unknown) => {
      calls.push({ path, options });
      return { status: { connection: { clientConfigured: true } } };
    };
    // The real busy repaint rebuilds the page from state: typed values vanish.
    const renderRoute = () => { document.body.innerHTML = FORM; };
    const toast = (message: string) => { toasts.push(message); };
    const source = [
      topLevel('gmailSyncAction'), topLevel('parseGoogleClientJson'), topLevel('saveGmailClient'),
      topLevel('saveGmailClientFromForm'), topLevel('saveGmailClientFromFile'), topLevel('saveGmailNoiseFromForm'),
      'return { parseGoogleClientJson, saveGmailClientFromForm, saveGmailClientFromFile, saveGmailNoiseFromForm };',
    ].join('\n');
    // eslint-disable-next-line no-new-func
    helpers = new Function('state', 'request', 'renderRoute', 'toast', source)(state, request, renderRoute, toast) as SaveHelpers;
  });

  const field = (id: string) => document.getElementById(id) as HTMLInputElement;

  it('sends the typed client ID and secret, not the repainted empty fields, and keeps the secret out of state', async () => {
    field('gmail-sync-client-id').value = ' 1234567890-abcdefghijkl.apps.googleusercontent.com ';
    field('gmail-sync-client-secret').value = 'typed-secret-value';
    await helpers.saveGmailClientFromForm();
    expect(calls).toEqual([{
      path: '/gmail-sync/client',
      options: { method: 'PUT', body: { clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'typed-secret-value' } },
    }]);
    expect(state.gmailSync.busy).toBe('');
    expect(JSON.stringify(state)).not.toContain('typed-secret-value');
    expect(toasts).toEqual(['OAuth client saved. Choose Connect Gmail to sign in.']);
  });

  it('saves the edited noise list, not the repainted saved one', async () => {
    (document.getElementById('gmail-sync-noise') as HTMLTextAreaElement).value = 'no-reply\n  deals@shop.example \n\n';
    await helpers.saveGmailNoiseFromForm();
    expect(calls).toEqual([{ path: '/gmail-sync/config', options: { method: 'PUT', body: { noiseSenders: ['no-reply', 'deals@shop.example'] } } }]);
  });

  it('reads the Desktop client from Google’s downloaded JSON and refuses a Web client file without a request', async () => {
    expect(helpers.parseGoogleClientJson(DESKTOP_JSON)).toEqual({
      clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'file-secret-value',
    });
    expect(() => helpers.parseGoogleClientJson(JSON.stringify({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 'y' } })))
      .toThrow(/Web application client/);
    expect(() => helpers.parseGoogleClientJson('not json')).toThrow(/not the JSON/);
    expect(() => helpers.parseGoogleClientJson(JSON.stringify({ installed: { client_id: 'x' } }))).toThrow(/no Desktop app client ID and secret/);

    const choose = (text: string) => {
      const input = document.createElement('input');
      input.type = 'file';
      Object.defineProperty(input, 'files', { value: [new File([text], 'client_secret_x.json', { type: 'application/json' })] });
      return input;
    };
    await helpers.saveGmailClientFromFile(choose(DESKTOP_JSON));
    expect(calls).toEqual([{
      path: '/gmail-sync/client',
      options: { method: 'PUT', body: { clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'file-secret-value' } },
    }]);

    await helpers.saveGmailClientFromFile(choose(JSON.stringify({ web: { client_id: 'x.apps.googleusercontent.com', client_secret: 'y' } })));
    expect(calls).toHaveLength(1);
    expect(toasts.at(-1)).toMatch(/^Gmail: That file is for a Web application client/);
  });

  it('GRASP’s noise save also reads the list before its busy repaint', () => {
    const start = dashboard.indexOf("if (action === 'grasp-sync-save-noise')");
    const handler = dashboard.slice(start, start + 700);
    expect(handler.indexOf("getElementById('grasp-sync-noise')")).toBeGreaterThan(0);
    expect(handler.indexOf("getElementById('grasp-sync-noise')")).toBeLessThan(handler.indexOf('graspSyncAction('));
  });
});
