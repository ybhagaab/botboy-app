// @vitest-environment jsdom
//
// Browser capture UI (dashboard.js): the Connections card model, the owner
// Pause/Resume action, the top-bar chip, and the version-poll handler. The
// functions are evaluated from the shipped source (source-seam style), so the
// tests exercise real behavior without bootstrapping the whole SPA.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  browserCaptureCardModel(detail: string): { status: string; tone: string; detail: string; paused: boolean };
  updateGlobalHealth(): void;
  refreshBrowserCapture(): Promise<void>;
  setBrowserCapturePaused(paused: boolean): Promise<void>;
  applyBrowserCaptureResult(result: unknown): void;
};

function load(state: Record<string, unknown>, deps: { request?: (path: string, options?: any) => Promise<any>; renderRoute?: (options?: any) => void; toast?: (m: string, tone?: string) => void } = {}): Helpers {
  const source = [
    constLine('icon'), constLine('esc'), constLine('number'),
    topLevel('relativeTime'), topLevel('whenPhrase'), topLevel('captureIssueDetail'),
    topLevel('applyBrowserCaptureResult'), topLevel('refreshBrowserCapture'), topLevel('setBrowserCapturePaused'),
    topLevel('browserCaptureCardModel'), topLevel('updateGlobalHealth'),
    'return { browserCaptureCardModel, updateGlobalHealth, refreshBrowserCapture, setBrowserCapturePaused, applyBrowserCaptureResult };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('state', 'request', 'renderRoute', 'toast', source)(
    state, deps.request ?? (async () => ({})), deps.renderRoute ?? (() => {}), deps.toast ?? (() => {}),
  ) as Helpers;
}

const idle = (extra: Record<string, unknown> = {}) => ({
  paused: false, intervalMs: 30000, baseIntervalMs: 30000, slowedReason: null, version: 0, ...extra,
});

describe('browser capture UI', () => {
  let state: Record<string, any>;
  beforeEach(() => {
    document.body.innerHTML = '<a class="system-chip" href="#/pipeline"><span class="status-dot" id="global-health-dot"></span><span id="global-health-label">Checking system health</span></a>'
      + '<button data-action="browser-capture-pause" data-pause="true">Pause</button>';
    state = {
      health: { totalFailures: 0 },
      captureHealth: { sources: [], issues: [], error: '' },
      folders: { changingOften: 0 },
      browserCapture: null,
      browserCaptureBusy: false,
    };
  });
  const chip = () => ({
    label: document.getElementById('global-health-label')!.textContent,
    dot: document.getElementById('global-health-dot')!.className,
    href: document.querySelector('a.system-chip')!.getAttribute('href'),
  });

  it('the card reads Available until the server says otherwise (also on an older server)', () => {
    const h = load(state);
    expect(h.browserCaptureCardModel('12 items')).toEqual({ status: 'Available', tone: 'good', detail: '12 items', paused: false });
    state.browserCapture = idle();
    expect(h.browserCaptureCardModel('12 items').status).toBe('Available');
  });

  it('the card says Paused by you (warn) and offers Resume', () => {
    state.browserCapture = idle({ paused: true });
    const card = load(state).browserCaptureCardModel('x');
    expect(card).toMatchObject({ status: 'Paused by you', tone: 'warn', paused: true });
  });

  it('the card says Slowed: memory pressure (warn) with the interval, and a busy Mac otherwise', () => {
    const h = load(state);
    state.browserCapture = idle({ slowedReason: 'memory pressure: warn', intervalMs: 120000 });
    expect(h.browserCaptureCardModel('x')).toMatchObject({ status: 'Slowed: memory pressure', tone: 'warn' });
    expect(h.browserCaptureCardModel('x').detail).toContain('every 2 min');
    state.browserCapture = idle({ slowedReason: 'high CPU load', intervalMs: 60000 });
    expect(h.browserCaptureCardModel('x').status).toBe('Slowed: busy Mac');
  });

  it('paused wins over slowed on the card', () => {
    state.browserCapture = idle({ paused: true, slowedReason: 'memory pressure: warn' });
    expect(load(state).browserCaptureCardModel('x').status).toBe('Paused by you');
  });

  it('the chip shows Browser capture paused by you before All sources syncing', () => {
    const h = load(state);
    h.updateGlobalHealth();
    expect(chip().label).toBe('All sources syncing');
    state.browserCapture = idle({ paused: true });
    h.updateGlobalHealth();
    expect(chip()).toMatchObject({ label: 'Browser capture paused by you', href: '#/connections' });
    expect(chip().dot).toContain('warn');
  });

  it('a source failure and files changing often keep priority over the pause', () => {
    state.browserCapture = idle({ paused: true });
    state.captureHealth.issues = [{ source: 'slack', name: 'Slack', href: '#/connections/slack', cause: 'c', nextAction: 'n' }];
    const h = load(state);
    h.updateGlobalHealth();
    expect(chip().label).toBe('Slack not syncing');
    state.captureHealth.issues = [];
    state.folders.changingOften = 2;
    h.updateGlobalHealth();
    expect(chip().label).toBe('2 files changing often');
  });

  it('refreshBrowserCapture reads /browser-capture, repaints the chip, and goes unknown on failure', async () => {
    const request = vi.fn().mockResolvedValueOnce(idle({ paused: true })).mockRejectedValueOnce(new Error('down'));
    const h = load(state, { request });
    await h.refreshBrowserCapture();
    expect(request).toHaveBeenCalledWith('/browser-capture');
    expect(state.browserCapture.paused).toBe(true);
    expect(chip().label).toBe('Browser capture paused by you');
    await h.refreshBrowserCapture();
    expect(state.browserCapture).toBeNull();
    expect(chip().label).toBe('All sources syncing');
  });

  it('Pause sends the PUT, updates the state, repaints, and restores focus to the button', async () => {
    const request = vi.fn().mockResolvedValue(idle({ paused: true }));
    const renderRoute = vi.fn(() => {
      // The repaint replaces the button, as the real render does.
      document.querySelector('[data-action="browser-capture-pause"]')!.replaceWith(Object.assign(document.createElement('button'), { textContent: 'Resume' }));
      document.querySelector('button')!.setAttribute('data-action', 'browser-capture-pause');
    });
    const h = load(state, { request, renderRoute });
    await h.setBrowserCapturePaused(true);
    expect(request).toHaveBeenCalledWith('/browser-capture/pause', { method: 'PUT', body: { paused: true } });
    expect(state.browserCapture.paused).toBe(true);
    expect(state.browserCaptureBusy).toBe(false);
    expect(renderRoute).toHaveBeenCalledWith({ preserveScroll: true, userAction: true });
    expect(document.activeElement).toBe(document.querySelector('[data-action="browser-capture-pause"]'));
    expect(chip().label).toBe('Browser capture paused by you');
  });

  it('a failed PUT keeps the old state, tells the owner, and frees the button', async () => {
    const toast = vi.fn();
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 403'), { payload: { error: 'needs the owner interface' } }));
    state.browserCapture = idle();
    const h = load(state, { request, toast });
    await h.setBrowserCapturePaused(true);
    expect(state.browserCapture.paused).toBe(false);
    expect(state.browserCaptureBusy).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('needs the owner interface'), 'bad');
  });

  it('ignores a second click while the first is in flight', async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const h = load(state, { request });
    const first = h.setBrowserCapturePaused(true);
    await h.setBrowserCapturePaused(true);
    expect(request).toHaveBeenCalledTimes(1);
    release(idle({ paused: true }));
    await first;
  });

  describe('shipped source seams', () => {
    it('wires the card button, its handler, and the version-poll refresh', () => {
      expect(dashboard).toContain('data-action="browser-capture-pause"');
      expect(dashboard).toContain("if (action === 'browser-capture-pause') void setBrowserCapturePaused(target.dataset.pause === 'true');");
      expect(dashboard).toContain('state.lastBrowserCaptureVersion = payload.browserCaptureVersion ?? null;');
      expect(dashboard).toMatch(/previousBrowserCaptureVersion !== null[\s\S]{0,200}await refreshBrowserCapture\(\);/);
      expect(dashboard).toContain("request('/browser-capture')");
    });
  });
});
