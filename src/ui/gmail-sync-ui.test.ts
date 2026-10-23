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
type Helpers = {
  gmailSyncCardModel(): Card;
  renderGmailSyncSettings(): string;
  renderGdriveSection(account: Record<string, any>, busy: string): string;
  gdriveStateOf(conn: Record<string, any>): { key: string; label: string; tone: string };
};

function load(state: Record<string, unknown>): Helpers {
  const source = [
    constLine('icon'), constLine('esc'), constLine('attr'), constLine('number'), constLine('GMAIL_SIGN_IN_NOTICE_MS'),
    topLevel('relativeTime'), topLevel('whenPhrase'), topLevel('pageHead'),
    topLevel('captureIssueFor'), topLevel('captureIssueDetail'),
    topLevel('gmailAccountName'), topLevel('gmailMultiCardModel'),
    topLevel('gmailImportActive'), topLevel('gmailImportDate'), topLevel('renderGmailImportCard'),
    topLevel('amazonEmployeeOn'), topLevel('gmailSignInFresh'), topLevel('renderGmailSignInNotice'), topLevel('gdriveStateOf'),
    topLevel('renderGdriveSection'), topLevel('renderGmailAccountCard'), topLevel('gmailSyncCardModel'), topLevel('renderGmailSyncSettings'),
    'return { gmailSyncCardModel, renderGmailSyncSettings, renderGdriveSection, gdriveStateOf };',
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

/** The page status: the first account's fields plus `accounts` (one account here, built from the same fields). */
function status(overrides: Record<string, unknown> = {}) {
  const base: Record<string, any> = {
    enabled: true, running: false, intervalMinutes: 5, connection: connection(), noiseSenders: ['no-reply'],
    mailActive: true, backlog: 0, hasCursor: true, lastRun: null, ...overrides,
  };
  const conn = base.connection;
  base.accounts = overrides.accounts ?? (conn.connected ? [{
    id: 'default', label: '', email: conn.accountEmail, connection: conn, running: false, backlog: base.backlog,
    hasCursor: true, mailActive: true, lastRun: base.lastRun, captured: base.captured ?? { total: 0, received: 0, sent: 0, inProjects: 0 }, import: base.import ?? null,
  }] : []);
  return base;
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
    expect(document.querySelector('[data-action="gmail-sync-connect"][data-account="default"]')!.textContent).toContain('Reconnect');
    expect(document.querySelector('[data-action="gmail-sync-toggle"]')!.textContent).toBe('Pause automatic sync');
    expect(document.querySelector('[data-action="gmail-sync-disconnect"][data-account="default"]')).not.toBeNull();
    expect(document.querySelector('[data-action="gmail-sync-run"][data-account="default"]')).not.toBeNull();
    expect(document.querySelector('[data-action="gmail-sync-add-account"]')!.textContent).toContain('Add another account');
    expect(document.body.textContent).toContain('4 new');
    expect(document.body.textContent).not.toContain('ingested');
    expect(document.body.textContent).toContain('Update just now in 1.2s for jane.doe@gmail.com');
    expect(document.body.textContent).toContain('Suppressed (this sync replaces it)');

    state.gmailSync.busy = 'run:default';
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    expect(document.querySelector('[data-action="gmail-sync-run"][data-account="default"]')!.textContent).toContain('Syncing…');
    expect((document.querySelector('[data-action="gmail-sync-disconnect"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows what BotBoy holds beside the last run, and the 30-day window', () => {
    state.gmailSync.status = status({ captured: { total: 1800, received: 1300, sent: 500, inProjects: 42 } });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    const details = document.querySelector('.gmail-account .connection-details')!.textContent!;
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
    expect(document.body.textContent).toContain('BotBoy captured the last 30 days when you connected.');
    expect(start.getAttribute('data-account')).toBe('default');

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
    expect(dashboard).toContain("request('/gmail-sync/import', { method: 'POST', body: { months: 6, ...(accountId ? { accountId } : {}) } })");
    expect(dashboard).toContain("request(`/gmail-sync/import${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`, { method: 'DELETE' })");
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
    expect(document.querySelector('[data-action="gmail-sync-connect"][data-account="default"]')!.textContent).toContain('Reconnect');

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

  it('lists several accounts with their labels, totals, imports, and per-account controls', () => {
    const work = { id: 'ga_0123456789', label: 'Work', email: 'me@company.com', connection: connection({ accountEmail: 'me@company.com', canCompose: true }), running: false, backlog: 0, hasCursor: true, mailActive: true,
      lastRun: { at: new Date().toISOString(), status: 'completed', counters: { emitted: 3 } }, captured: { total: 40, received: 30, sent: 10, inProjects: 12 }, import: null };
    const personal = { id: 'default', label: 'Personal <b>me</b>', email: 'jane.doe@gmail.com', connection: connection({ canCompose: false, needsComposeGrant: true }), running: false, backlog: 5, hasCursor: true, mailActive: true,
      lastRun: null, captured: { total: 18, received: 13, sent: 5, inProjects: 0 }, import: { status: 'importing', months: 6, requestedAt: '', sinceIso: '2026-04-06T07:00:00.000Z', finishedAt: null, total: 200, checked: 50, captured: 10, duplicates: 0, filtered: 40, truncated: false } };
    state.gmailSync.status = status({ accounts: [personal, work] });
    expect(load(state).gmailSyncCardModel()).toEqual({
      status: 'Active', tone: 'good', detail: '2 accounts (Personal <b>me</b>, Work): 58 emails captured. Importing older mail for 1.',
    });
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    const cards = [...document.querySelectorAll('.gmail-account')] as HTMLElement[];
    expect(cards.map(card => card.dataset.gmailAccount)).toEqual(['default', 'ga_0123456789']);
    expect(document.querySelector('b')).toBeNull();
    expect((document.getElementById('gmail-sync-label-default') as HTMLInputElement).value).toBe('Personal <b>me</b>');
    expect(document.querySelector('label[for="gmail-sync-label-ga_0123456789"]')).not.toBeNull();
    expect(cards[0].textContent).toContain('Read only: choose Reconnect');
    expect(cards[0].querySelector('[data-action="gmail-sync-import-stop"]')!.getAttribute('data-account')).toBe('default');
    expect(cards[1].querySelector('[data-action="gmail-sync-import"]')!.getAttribute('data-account')).toBe('ga_0123456789');
    expect(cards[1].textContent).toContain('Captured40 emails (30 received, 10 sent)');
    expect(cards[1].textContent).toContain('Last sync just now: 3 new.');
    expect(cards[1].querySelector('[data-action="gmail-account-label"]')!.getAttribute('data-account')).toBe('ga_0123456789');
    // With several accounts the single-account last-run section is not shown.
    expect(document.body.textContent).not.toContain('Your own sent mail is kept without filters');

    // Any account needing Reconnect turns the Connections card into a warning naming it.
    state.gmailSync.status = status({ accounts: [personal, { ...work, connection: connection({ accountEmail: 'me@company.com', needsReconnect: true }) }] });
    expect(load(state).gmailSyncCardModel()).toMatchObject({ status: 'Reconnect needed', tone: 'warn' });
    expect(load(state).gmailSyncCardModel().detail).toContain('Work (me@company.com)');

    // Disconnect asks about deleting the captured mail separately; the label save reads the field first.
    const handler = dashboard.slice(dashboard.indexOf("if (action === 'gmail-sync-disconnect')"), dashboard.indexOf("if (action === 'gmail-sync-run')"));
    expect(handler).toContain('Also delete the');
    expect(handler).toContain('deleteMail');
    const label = dashboard.slice(dashboard.indexOf("if (action === 'gmail-account-label')"), dashboard.indexOf("if (action === 'gmail-sync-connect')"));
    expect(label.indexOf('field.value')).toBeLessThan(label.indexOf('gmailSyncAction('));
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

/**
 * Owner report 2026-10-12: "Active" beside "Google sign-in failed: network
 * error (ETIMEDOUT)". Health (the badge) and the result of a Connect attempt
 * are separate: the result shows only where the attempt was made, with its
 * time and a Dismiss button, and never as a banner beside a healthy badge.
 */
describe('Gmail sign-in notices: the badge and any message never contradict', () => {
  let state: Record<string, any>;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const DRIVE_FAILURE = "Couldn't connect Google Drive: BotBoy couldn't reach Google (timed out on a slow route to Google). Your current Gmail connection is unchanged. Press Connect Google Drive to try again.";
  const attempt = (overrides: Record<string, unknown> = {}) => ({
    action: 'drive_connect', kind: 'network', ok: false, at: ago(30_000), message: DRIVE_FAILURE,
    nextAction: 'Press Connect Google Drive to try again.', accountId: 'default', ...overrides,
  });
  const idle = { lastRun: { at: new Date().toISOString(), status: 'completed', mode: 'partial', counters: { emitted: 0 } }, captured: { total: 50, received: 44, sent: 6, inProjects: 0 } };
  const page = () => {
    document.body.innerHTML = load(state).renderGmailSyncSettings();
    return document.body;
  };

  beforeEach(() => {
    state = {
      gmailSync: { status: status(idle), error: '', busy: '' },
      captureHealth: { sources: [], issues: [], error: '' },
    };
  });

  it('shows no banner beside Active for the stale error an earlier server left in lastError (the owner report)', () => {
    state.gmailSync.status = status({ ...idle, connection: connection({ lastError: 'Google sign-in failed: network error (ETIMEDOUT)', needsReconnect: false }) });
    const body = page();
    expect(load(state).gmailSyncCardModel()).toMatchObject({ status: 'Active', tone: 'good' });
    expect(body.textContent).toContain('Active');
    expect(body.textContent).not.toContain('Google sign-in failed');
    expect(body.textContent).not.toContain('ETIMEDOUT');
    expect(body.querySelector('[data-gmail-signin]')).toBeNull();
  });

  it('shows a health message only while Google rejects the grant, as the Reconnect state, not as a second banner', () => {
    state.gmailSync.status = status({ connection: connection({ needsReconnect: true, lastError: 'Google ended BotBoy’s access to this account. Choose Reconnect.' }) });
    const body = page();
    expect(body.textContent).toContain('Reconnect needed');
    expect(body.textContent).toContain('Google ended BotBoy’s access');
    expect(body.querySelectorAll('[data-gmail-signin]')).toHaveLength(0);
  });

  it('puts a failed Drive Connect in the Drive section only, with its time and a Dismiss button', () => {
    const drive = attempt();
    state.gmailSync.status = status({ ...idle, connection: connection({ canReadDrive: false, canPublishDrive: false, signIn: { gmail: null, drive }, pageSignIn: null }) });
    const body = page();
    const notices = body.querySelectorAll('[data-gmail-signin]');
    expect(notices).toHaveLength(1);
    const notice = notices[0] as HTMLElement;
    expect(notice.getAttribute('data-gmail-signin')).toBe('drive_connect');
    expect(notice.closest('section')!.textContent).toContain('Google Drive');
    expect(notice.textContent).toContain(DRIVE_FAILURE);
    expect(notice.getAttribute('role')).toBe('status');
    const time = notice.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe(drive.at);
    expect(time.textContent).toBe('Just now');
    const dismiss = notice.querySelector('button[data-action="gmail-signin-dismiss"]') as HTMLButtonElement;
    expect(dismiss.dataset.account).toBe('default');
    expect(dismiss.dataset.signinAction).toBe('drive_connect');
    // Gmail's own card says Active, with nothing about the Drive attempt above its badge.
    expect(load(state).gmailSyncCardModel()).toMatchObject({ status: 'Active', tone: 'good' });
    const top = body.querySelector('section.card.pad')!;
    expect(top.textContent).not.toContain("Couldn't connect");
  });

  it('keeps the Connect Google Drive control rendered and enabled while a failure notice is visible', () => {
    state.gmailSync.status = status({ ...idle, connection: connection({ canReadDrive: false, canPublishDrive: false, signIn: { gmail: null, drive: attempt() }, pageSignIn: null }) });
    const body = page();
    expect(body.querySelector('[data-gmail-signin="drive_connect"]')).not.toBeNull();
    const connect = body.querySelector('button[data-action="gdrive-connect"]') as HTMLButtonElement;
    expect(connect).not.toBeNull();
    expect(connect.disabled).toBe(false);
    expect(connect.textContent).toContain('Connect Google Drive');
    expect(connect.dataset.account).toBe('default');
    // Only a request in flight disables it.
    state.gmailSync.busy = 'drive:default';
    expect((page().querySelector('button[data-action="gdrive-connect"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names Drive’s state: Not connected, Connect failed, read only, and read + publish', () => {
    const helpers = load(state);
    expect(helpers.gdriveStateOf({})).toEqual({ key: 'not_connected', label: 'Not connected', tone: '' });
    expect(helpers.gdriveStateOf({ signIn: { gmail: null, drive: null } }).label).toBe('Not connected');
    expect(helpers.gdriveStateOf({ signIn: { drive: attempt() } })).toEqual({ key: 'connect_failed', label: 'Connect failed — try again', tone: 'warn' });
    // A box left unticked is told by the notice; the state follows what Google granted.
    expect(helpers.gdriveStateOf({ signIn: { drive: attempt({ kind: 'drive_not_granted' }) } }).label).toBe('Not connected');
    expect(helpers.gdriveStateOf({ canReadDrive: true, signIn: { drive: attempt({ kind: 'drive_not_granted' }) } })).toEqual({ key: 'read_only', label: 'Connected (read only)', tone: 'warn' });
    expect(helpers.gdriveStateOf({ canPublishDrive: true }).label).toBe('Connected (publish only)');
    expect(helpers.gdriveStateOf({ canReadDrive: true, canPublishDrive: true, signIn: { drive: attempt() } })).toEqual({ key: 'connected', label: 'Connected (read + publish)', tone: 'good' });
    // A notice older than its 15 minutes does not turn the state into a failure.
    expect(helpers.gdriveStateOf({ signIn: { drive: attempt({ at: ago(16 * 60_000) }) } }).label).toBe('Not connected');

    const sectionOf = (conn: Record<string, any>) => {
      document.body.innerHTML = helpers.renderGdriveSection({ id: 'default', connection: conn }, '');
      return document.body;
    };
    expect(sectionOf({}).querySelector('[data-gdrive-state]')!.textContent).toBe('Not connected');
    expect(sectionOf({ signIn: { drive: attempt() } }).querySelector('[data-gdrive-state]')!.textContent).toBe('Connect failed — try again');
    const partial = sectionOf({ canReadDrive: true, signIn: { drive: attempt({ kind: 'drive_not_granted', message: 'Drive not granted in full: Google allowed reading Drive but not publishing to it. Press Connect Google Drive and tick both Drive boxes.' }) } });
    expect(partial.querySelector('[data-gdrive-state]')!.textContent).toBe('Connected (read only)');
    expect(partial.textContent).toContain('Drive not granted in full');
    expect(partial.querySelector('button[data-action="gdrive-connect"]')).not.toBeNull();
    // A grant from before full Drive access keeps its sources and offers the upgrade (google-workspace.md).
    const older = sectionOf({ canReadDrive: true, canPublishDrive: true, drive: { enabled: true, sources: { ownedByMe: true, sharedWithMe: false, folderIds: [] } } });
    expect(older.querySelector('[data-gdrive-state]')!.textContent).toBe('Connected (read + publish)');
    expect(older.querySelector('button[data-action="gdrive-connect"]')!.textContent).toContain('Allow full access');
    expect(older.querySelector('[data-gdrive-upgrade]')!.textContent).toContain('not create, edit, move or share');
    expect(older.querySelector('button[data-action="gdrive-save-sources"]')).not.toBeNull();
    const full = sectionOf({ canReadDrive: true, canPublishDrive: true, canEditDrive: true, canUseCalendar: true, drive: { enabled: true, sources: { ownedByMe: true, sharedWithMe: false, folderIds: [] } } });
    expect(full.querySelector('[data-gdrive-state]')!.textContent).toBe('Connected (full access + Calendar)');
    expect(full.querySelector('button[data-action="gdrive-connect"]')).toBeNull();
    expect(full.textContent).toContain('BotBoy creates, edits, moves, shares and trashes Drive files only when you ask');
    expect(full.querySelector('button[data-action="gdrive-save-sources"]')).not.toBeNull();
    const noCalendar = sectionOf({ canReadDrive: true, canPublishDrive: true, canEditDrive: true, drive: { enabled: true, sources: { ownedByMe: false, sharedWithMe: false, folderIds: [] } } });
    expect(noCalendar.querySelector('[data-gdrive-state]')!.textContent).toBe('Connected (full access)');
    expect(noCalendar.querySelector('button[data-action="gdrive-connect"]')!.textContent).toContain('Add Calendar');
  });

  it('shows a success notice in a good tone, and hides any notice older than 15 minutes', () => {
    const connected = attempt({ kind: 'ok', ok: true, message: 'Google Drive connected. Choose the Drive sources BotBoy should capture below.' });
    state.gmailSync.status = status({ ...idle, connection: connection({ canReadDrive: true, canPublishDrive: true, drive: { enabled: true, sources: { ownedByMe: false, sharedWithMe: false, folderIds: [] } }, signIn: { gmail: null, drive: connected }, pageSignIn: null }) });
    const notice = page().querySelector('[data-gmail-signin="drive_connect"]')!;
    expect(notice.classList.contains('good')).toBe(true);
    expect(notice.textContent).toContain('Google Drive connected.');

    state.gmailSync.status = status({ ...idle, connection: connection({ canReadDrive: false, canPublishDrive: false, signIn: { gmail: null, drive: attempt({ at: ago(16 * 60_000) }) }, pageSignIn: null }) });
    expect(page().querySelector('[data-gmail-signin]')).toBeNull();
  });

  it('shows a first connect’s failure on the page card, dismissable, and the Connections card says Connect failed', () => {
    const first = attempt({ action: 'gmail_connect', accountId: null, message: "Couldn't connect Gmail: BotBoy couldn't reach Google (timed out on a slow route to Google). Press Connect Gmail to try again." });
    state.gmailSync.status = status({ connection: connection({ connected: false, accountEmail: null, signIn: { gmail: null, drive: null }, pageSignIn: first }) });
    const body = page();
    const notice = body.querySelector('[data-gmail-signin="gmail_connect"]')!;
    expect(notice.textContent).toContain("Couldn't connect Gmail");
    expect((notice.querySelector('button[data-action="gmail-signin-dismiss"]') as HTMLButtonElement).dataset.account).toBe('');
    expect((body.querySelector('button[data-action="gmail-sync-connect"]') as HTMLButtonElement).disabled).toBe(false);
    expect(load(state).gmailSyncCardModel()).toEqual({ status: 'Connect failed', tone: 'warn', detail: 'The last sign-in did not finish. Open Gmail for details, then choose Connect Gmail to try again.' });

    // Dismissed (the server stops sending it): back to the plain not-connected card.
    state.gmailSync.status = status({ connection: connection({ connected: false, accountEmail: null, signIn: { gmail: null, drive: null }, pageSignIn: null }) });
    expect(load(state).gmailSyncCardModel()).toMatchObject({ status: 'Not connected' });
    // A connected account never reads Connect failed: the card and the page agree on health.
    state.gmailSync.status = status({ ...idle, connection: connection({ pageSignIn: first }) });
    expect(load(state).gmailSyncCardModel()).toMatchObject({ status: 'Active' });
  });

  it('shows an account’s failed Reconnect on its own card, not on the page card', () => {
    const reconnect = attempt({ action: 'gmail_connect', message: "Couldn't reconnect Gmail: BotBoy couldn't reach Google (timed out on a slow route to Google). Your current Gmail connection is unchanged. Press Reconnect to try again." });
    state.gmailSync.status = status({ ...idle, connection: connection({ signIn: { gmail: reconnect, drive: null }, pageSignIn: null }) });
    const body = page();
    const notice = body.querySelector('[data-gmail-signin="gmail_connect"]')!;
    expect(notice.closest('article.gmail-account')).not.toBeNull();
    expect(body.querySelectorAll('[data-gmail-signin]')).toHaveLength(1);
  });

  it('shows Drive’s own capture trouble in the Drive section, for example the Drive API not enabled', () => {
    const issue = {
      source: 'gdrive', name: 'Google Drive', kind: 'service_auth', cause: 'The service rejected BotBoy’s sign-in',
      nextAction: 'Enable the Google Drive API in the same Google Cloud project as your Gmail client (APIs & Services → Library → Google Drive API), then wait a minute.',
      since: new Date().toISOString(), lastSuccessAt: null, failures: 3, reason: '403 accessNotConfigured', href: '#/connections/gmail-sync',
    };
    state.captureHealth.issues = [issue];
    state.gmailSync.status = status({ ...idle, connection: connection({ canReadDrive: true, canPublishDrive: true, drive: { enabled: true, sources: { ownedByMe: true, sharedWithMe: false, folderIds: [] } } }) });
    const section = page().querySelector('[data-gdrive-account]')!;
    expect(section.textContent).toContain('Drive is not syncing.');
    expect(section.textContent).toContain('Enable the Google Drive API in the same Google Cloud project as your Gmail client');
    // Not connected: nothing to sync, so the section does not repeat an old issue.
    state.gmailSync.status = status({ ...idle, connection: connection({ canReadDrive: false, canPublishDrive: false }) });
    expect(page().textContent).not.toContain('Drive is not syncing.');
  });
});

/** The Dismiss button must reach the server route, and the page must not read the old error for anything. */
describe('Gmail sign-in notices: wiring', () => {
  it('Dismiss posts the notice’s account and action to /gmail-sync/sign-in/dismiss', () => {
    const handler = dashboard.slice(dashboard.indexOf("if (action === 'gmail-signin-dismiss')"), dashboard.indexOf("if (action === 'gdrive-save-sources')"));
    expect(handler).toContain("request('/gmail-sync/sign-in/dismiss', { method: 'POST', body: { ...(accountId ? { accountId } : {}), action: signInAction } })");
    expect(handler).toContain('target.dataset.signinAction');
  });

  it('no render path reads connection.lastError except the Reconnect health states', () => {
    const uses = dashboard.split('\n').filter(line => /connection\.lastError|conn\.lastError/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line, line).toMatch(/needsReconnect/);
  });
});
