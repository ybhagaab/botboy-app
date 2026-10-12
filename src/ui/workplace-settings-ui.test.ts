// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Source seams and rendered helpers for Settings → Workplace (dashboard.js)
// and the empty chat model catalog (app.js). Server behavior is covered by
// the workplace router, manager, and chat-tool tests.
const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}
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
function constBlock(name: string): string {
  const start = dashboard.indexOf(`\nconst ${name} = {`);
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0);
  return dashboard.slice(start, dashboard.indexOf('\n};\n', start) + 4);
}
function loadPage(state: Record<string, unknown>): { render(): string } {
  const source = [
    constLine('icon'), constLine('esc'), constLine('attr'), constLine('WORKPLACE_ICON'), constBlock('WORKPLACE_SIGNAL_LABELS'),
    topLevel('pageHead'), topLevel('amazonEmployeeOn'), topLevel('workplaceSourceLine'), topLevel('workplaceFooterLine'),
    topLevel('renderWorkplaceSettings'),
    'return { render: renderWorkplaceSettings };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', source)(state);
}
const footer = { text: 'Amazon Confidential', source: 'kept', setBy: 'migration' };

describe('Settings → Workplace page', () => {
  it('routes and links the page inside Settings', () => {
    expect(dashboard).toContain("if (parts[0] === 'settings' && parts[1] === 'workplace') return { view: 'workplace-settings' };");
    expect(dashboard).toContain("'ai-model-settings', 'workplace-settings'].includes(route.view)");
    expect(dashboard).toContain('href="#/settings/workplace"');
    expect(dashboard).toContain("if (state.route.view === 'workplace-settings') html = renderWorkplaceSettings();");
  });

  it('renders an accessible switch, the source line, the hidden list, and the footer field', () => {
    const page = loadPage({
      workplace: {
        amazonEmployee: false, known: true, saving: false, footerSaving: false, notice: null, footerError: null,
        status: {
          amazonEmployee: false, source: 'detected', signals: ['midway_cookie', 'amazon_toolbox'],
          hiddenConnections: [{ id: 'slack', displayName: 'Slack', setUp: true }, { id: 'sharepoint', displayName: 'SharePoint', setUp: false }],
          exportFooter: footer,
        },
      },
    }).render();
    document.body.innerHTML = page;
    const toggle = document.querySelector('[data-action="workplace-toggle"]')!;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('aria-describedby')).toBe('workplace-amazon-help');
    expect(document.getElementById('workplace-amazon-help')!.textContent).toContain('Applies right away, no restart.');
    expect(page).toContain('Detected on this Mac (Midway sign-in found, Amazon Toolbox found)');
    expect(page).toContain('Hidden while off: Slack. They resume when you turn this on.');
    const input = document.getElementById('workplace-footer') as HTMLInputElement;
    expect(document.querySelector('label[for="workplace-footer"]')!.textContent).toBe('Footer text');
    expect(input.maxLength).toBe(120);
    expect(input.value).toBe('Amazon Confidential');
    expect(document.body.textContent).toContain("Now: 'Amazon Confidential' (kept from before this update)");
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  it('shows "set by you" and no footer text copy', () => {
    const render = (exportFooter: unknown) => {
      document.body.innerHTML = loadPage({
        workplace: { amazonEmployee: true, known: true, status: { amazonEmployee: true, source: 'owner', updatedAt: '2026-10-11T00:00:00.000Z', signals: [], hiddenConnections: [], exportFooter } },
      }).render();
      return document.body.textContent ?? '';
    };
    expect(render({ text: '', source: 'default' })).toContain('Now: no footer text');
    expect(render({ text: 'Internal', source: 'owner' })).toContain("Now: 'Internal' (set by you)");
    expect(render({ text: '', source: 'default' })).toContain('Set by you on');
  });
});

describe('UI gated by Amazon Employee', () => {
  it('drops the Outlook and SharePoint capture cards and the Amazon-only pages while off', () => {
    expect(dashboard).toContain("const AMAZON_ONLY_CAPTURE_CARDS = ['grasp-sync', 'sharepoint-sync'];");
    expect(between(dashboard, 'function renderConnections() {', '\nfunction ')).toContain('amazonEmployeeOn() || !AMAZON_ONLY_CAPTURE_CARDS.includes(action)');
    expect(dashboard).toContain("amazonEmployeeOn() ? renderGraspSyncSettings() : amazonOnlyView('Outlook mail & calendar')");
    expect(dashboard).toContain("amazonEmployeeOn() ? renderSharePointSyncSettings() : amazonOnlyView('SharePoint documents')");
    expect(dashboard).toContain("amazonEmployeeOn() ? renderPublisherSettings() : amazonOnlyView('Dashboard sharing')");
  });

  it('opens the Slack token panel before the Amazon-only view on the Slack profile route', () => {
    const route = between(dashboard, "  if (state.route.view === 'profile-settings') {", "  if (state.route.view === 'dashboards')");
    expect(route.indexOf("showIntegration('slack')")).toBeGreaterThan(0);
    expect(route.indexOf("showIntegration('slack')")).toBeLessThan(route.indexOf('amazonOnlyView('));
  });

  it('hides document publication controls and analytics sharing while off, keeping publication history', () => {
    // Off: publication stays hidden unless Google Drive is connected (A7); SharePoint is never offered off.
    expect(dashboard).toContain('const publishButton = editing || !publicationView || !(amazonEmployeeOn() || drivePublishAvailable())');
    expect(dashboard).toContain('const publicationPanel = !editing && publicationView && (amazonEmployeeOn() || drivePublishAvailable())');
    expect(dashboard).toContain("${amazonEmployeeOn() ? `<option value=\"sharepoint\"");
    expect(dashboard).toContain("${amazonEmployeeOn() ? `${publishedAction}${shareAction}` : ''}");
    expect(dashboard).toContain('${publicationFact ?');
  });

  it('puts the knowledge directory card on the SQL page only while off, without preset generation', () => {
    const mcpSettings = between(dashboard, 'function renderMcpSettings() {', '\nfunction ');
    const aside = between(mcpSettings, '<aside class="mcp-side">', '</aside>');
    expect(aside).toContain("${renderAnalyticsContextCard('sql-context')}");
    const card = topLevel('renderAnalyticsContextCard');
    expect(card).toContain("const onSqlOff = profileId === 'sql-context' && !amazonEmployeeOn();");
    expect(card).toContain('ctx && onA2 ? renderEtlOnboardingSection(ctx.onboarding)');
    expect(topLevel('renderAnalyticsKnowledgeDirSection')).not.toContain('analytics-context-generate');
    expect(topLevel('loadAnalyticsContextConfig')).toContain("['profile-settings', 'mcp-settings'].includes(state.route.view)");
    const save = between(dashboard, "if (action === 'analytics-context-save') {", "if (action === '");
    expect(save).toContain("['profile-settings', 'mcp-settings'].includes(state.route.view)");
  });

  it('repaints gated views when the workplace version changes on the poll', () => {
    expect(dashboard).toContain('state.lastWorkplaceVersion = payload.workplaceVersion ?? null;');
    const apply = topLevel('applyWorkplaceVersionChange');
    for (const view of ['connections', 'workplace-settings', 'documents', 'analytics-dashboard', 'mcp-settings', 'profile-settings', 'publisher-settings']) {
      expect(apply).toContain(`'${view}'`);
    }
  });

  it('states the D4 model-context copy for keys and imports', () => {
    expect(dashboard).toContain('Data Room tables BotBoy reads for you are sent too.');
    expect(dashboard).not.toContain('Data Room table values stay on this Mac.');
    expect(dashboard).toContain('Model context: any connected AI model can read these rows.');
  });
});

describe('chat model picker with an empty catalog', () => {
  it('renders one disabled hint before the GPT-5.6 fallback, after the stale guard, and keeps the tail owner', () => {
    const fn = between(app, 'async function refreshChatModelCatalog()', '\nfunction initChatModelControl');
    const guard = fn.indexOf('requestId !== chatModelCatalogRequest');
    const empty = fn.indexOf('configured === false');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(empty);
    expect(fn).toContain("'Model · Add a model in Settings → AI model'");
    const emptyReturn = fn.indexOf('return;', empty);
    expect(emptyReturn).toBeLessThan(fn.indexOf('GPT-5.6 Terra'));
    expect(fn.indexOf('GPT-5.6 Terra')).toBeGreaterThan(fn.indexOf('} catch (error) {'));
    expect(fn.slice(fn.lastIndexOf('}'))).toBeDefined();
    expect(fn).toContain("select.disabled = lastAiModelState === 'not_configured';");
    expect(fn.lastIndexOf("select.disabled = lastAiModelState === 'not_configured';")).toBeGreaterThan(fn.indexOf('} catch (error) {'));
  });
});
