// @vitest-environment jsdom
//
// Capture-health UI (dashboard.js): the top-bar chip, the Connections cards,
// and the connection page alert. The pure render helpers are evaluated
// straight from the shipped source against a small state object, so these
// tests exercise real behavior without bootstrapping the whole SPA.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

// jsdom's import.meta.url is not a file URL; tests run from the package root.
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

type Helpers = {
  captureIssueDetail(issue: unknown): string;
  slackCardModel(count: number | null): { status: string; tone: string; detail: string };
  sharepointSyncCardModel(): { status: string; tone: string; detail: string };
  graspSyncCardModel(): { status: string; tone: string; detail: string };
  updateGlobalHealth(): void;
  profileCaptureIssueAlert(profileId: string): string;
};

function load(state: Record<string, unknown>): Helpers {
  const source = [
    constLine('icon'), constLine('esc'), constLine('attr'), constLine('number'),
    topLevel('relativeTime'), topLevel('whenPhrase'),
    topLevel('captureIssueFor'), topLevel('captureSourceHealth'), topLevel('captureIssueDetail'),
    topLevel('slackCardModel'), topLevel('sharepointSyncCardModel'), topLevel('graspSyncCardModel'),
    topLevel('updateGlobalHealth'),
    dashboard.match(/\nconst CAPTURE_SOURCE_BY_PROFILE = .*\n/)![0],
    topLevel('profileCaptureIssueAlert'),
    'return { captureIssueDetail, slackCardModel, sharepointSyncCardModel, graspSyncCardModel, updateGlobalHealth, profileCaptureIssueAlert };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', source)(state) as Helpers;
}

const HOUR = 3600_000;
const sharepointIssue = () => ({
  source: 'sharepoint',
  name: 'SharePoint documents',
  kind: 'unexpected_response',
  cause: 'The connection answered in a format BotBoy can’t read',
  nextAction: 'This usually follows a connector update. Update BotBoy (./start.sh --update); if it continues, report it.',
  since: new Date(Date.now() - 6 * 24 * HOUR).toISOString(),
  lastSuccessAt: new Date(Date.now() - 6 * 24 * HOUR - HOUR).toISOString(),
  failures: 288,
  reason: 'sharepoint_list_shared_with_me returned non-JSON output (=== UNTRUSTED CONTENT BOUNDARY ===',
  href: '#/connections/document-sync',
});

describe('capture-health UI', () => {
  let state: Record<string, any>;

  beforeEach(() => {
    document.body.innerHTML = '<a class="system-chip" href="#/pipeline"><span class="status-dot" id="global-health-dot"></span><span id="global-health-label">Checking system health</span></a>';
    state = {
      health: { totalFailures: 506 },
      captureHealth: { sources: [], issues: [], error: '' },
      slack: { configured: ['C1', 'C2'], error: '' },
      sharepointSync: { status: { enabled: true, sources: [{ id: 's1' }], queue: { queued: 0, failed: 0 }, gates: {}, lastRun: { at: new Date().toISOString(), status: 'completed' } }, error: '' },
      graspSync: { status: { enabled: true, intervalMinutes: 5, lastRun: null }, error: '' },
    };
  });

  it('the chip names a source that stopped syncing and links to its page', () => {
    state.captureHealth.issues = [sharepointIssue()];
    load(state).updateGlobalHealth();
    const label = document.getElementById('global-health-label')!;
    const chip = label.closest('a')!;
    expect(label.textContent).toBe('SharePoint documents not syncing');
    expect(document.getElementById('global-health-dot')!.className).toContain('warn');
    expect(chip.getAttribute('href')).toBe('#/connections/document-sync');
    expect(chip.title).toContain('Update BotBoy');
    expect(chip.title).toContain('last synced 6 days ago');
  });

  it('an all-time count of item failures no longer keeps the chip amber', () => {
    load(state).updateGlobalHealth();
    const label = document.getElementById('global-health-label')!;
    expect(label.textContent).toBe('All sources syncing');
    expect(document.getElementById('global-health-dot')!.className).toContain('good');
    expect(label.closest('a')!.title).toContain('506 item-level pipeline failures');
  });

  it('cards and the connection page show the same warning with its next action', () => {
    state.captureHealth.issues = [
      sharepointIssue(),
      { ...sharepointIssue(), source: 'slack', name: 'Slack', kind: 'midway_auth', cause: 'Your Midway session expired', nextAction: 'Run mwinit.', href: '#/connections/slack' },
    ];
    const helpers = load(state);
    expect(helpers.sharepointSyncCardModel()).toMatchObject({ status: 'Not syncing', tone: 'warn' });
    const slack = helpers.slackCardModel(2);
    expect(slack).toMatchObject({ status: 'Not syncing', tone: 'warn' });
    expect(slack.detail).toContain('Your Midway session expired');
    expect(slack.detail).toContain('Run mwinit.');
    expect(helpers.graspSyncCardModel().status).toBe('Scheduled');
    const alert = helpers.profileCaptureIssueAlert('slack');
    expect(alert).toContain('Slack is not syncing.');
    expect(helpers.profileCaptureIssueAlert('sql-context')).toBe('');
  });

  it('a healthy Slack card says when capture last succeeded', () => {
    state.captureHealth.sources = [{ source: 'slack', lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 }];
    expect(load(state).slackCardModel(2)).toEqual({ status: 'Connected', tone: 'good', detail: '2 conversations configured · checked just now' });
  });

  it('loads capture health with the core data and refetches it when the version changes', () => {
    const loadCore = topLevel('loadCore');
    expect(loadCore).toContain("request('/capture-health')");
    expect(loadCore).toContain('applyCaptureHealthResult(captureHealthResult);');
    const poll = topLevel('pollVersion');
    expect(poll).toContain('state.lastCaptureHealthVersion = payload.captureHealthVersion ?? null;');
    expect(poll).toContain('await refreshCaptureHealth();');
    expect(poll).toContain('renderRoute({ preserveScroll: true });');
  });
});
