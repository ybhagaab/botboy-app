import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { validateVisualizationSpec } from '../core/analytics-dashboard.js';

const source = readFileSync(path.join(process.cwd(), 'src/ui/analytics-html-view.js'), 'utf8');

function load() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost:7778/' });
  dom.window.eval(source);
  return dom.window as unknown as { BotBoyHtmlViews: any };
}

/** HTML views (2026-10-09): the model's page runs sandboxed; its data comes only from BotBoy. */
describe('analytics html views', () => {
  it('wraps the page in a CSP that blocks every network request and loads only BotBoy vendor scripts', () => {
    const doc = load().BotBoyHtmlViews.srcdoc({ config: { html: '<div id="x"></div>' } }, { mode: 'dark', colors: {} });
    expect(doc).toMatch(/http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http:\/\/localhost:7778\/vendor\/;/);
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("frame-src 'none'");
    // The CSP comes before the model's markup, so the page cannot run first.
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<div id="x">'));
  });

  it('hands the page sibling rows as objects by column, by key, and only the inputs it names', () => {
    const views = load().BotBoyHtmlViews;
    const dashboard = { widgets: [
      { id: 'w1', kind: 'html', title: 'Page', config: { html: '<p></p>', inputs: ['daily'] } },
      { id: 'w2', kind: 'table', title: 'Daily', config: { key: 'daily', hidden: true, dataSource: { kind: 'data_room_query', datasetId: 'ds_a' } }, result: { columns: ['day', 'n'], rows: [['2026-10-01', 3]], rowCount: 40, refreshedAt: 't', source: { versionId: 'dsv_1' } } },
      { id: 'w3', kind: 'metric', title: 'Other', config: { key: 'other' }, result: { columns: ['v'], rows: [[1]] } },
    ] };
    const data = views.datasetsFor(dashboard, ['daily']);
    expect(Object.keys(data)).toEqual(['daily']);
    expect(data.daily).toMatchObject({ rows: [{ day: '2026-10-01', n: 3 }], rowCount: 40, shownRows: 1, source: { kind: 'data_room_query', datasetId: 'ds_a', versionId: 'dsv_1' } });
    expect(Object.keys(views.datasetsFor(dashboard, undefined))).toEqual(['daily', 'other']);
  });

  it('mounts one sandboxed frame per view (scripts only: no same-origin, popups, or navigation)', () => {
    const win = load() as any;
    const container = win.document.createElement('div');
    container.dataset.analyticsHtml = 'w1';
    container.innerHTML = '<div class="analytics-html-slot"></div>';
    win.document.body.appendChild(container);
    win.BotBoyHtmlViews.mount({ widgets: [{ id: 'w1', kind: 'html', title: 'Page', config: { html: '<p>hi</p>' } }] });
    const frame = container.querySelector('iframe');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc).toContain('<p>hi</p>');
  });

  it('Vega specs may use expressions (interpreter), still never data or URLs', () => {
    expect(() => validateVisualizationSpec({ mark: 'bar', transform: [{ calculate: 'datum.a / datum.b', as: 'share' }, { filter: 'datum.share > 0.2' }], params: [{ name: 'p', expr: 'width / 2' }] })).not.toThrow();
    expect(() => validateVisualizationSpec({ mark: 'bar', data: { values: [] } })).toThrow(/not allowed/);
    expect(() => validateVisualizationSpec({ mark: 'bar', encoding: { href: { field: 'u' } } })).toThrow(/not allowed/);
    expect(() => validateVisualizationSpec({ mark: 'image', encoding: { url: { value: 'https://x' } } })).toThrow();
  });
});

describe('chat visuals', () => {
  it('turns ```mermaid / ```svg / ```visual blocks into sandboxed frames and keeps ```html as code', () => {
    const win = load() as any;
    const bubble = win.document.createElement('div');
    bubble.innerHTML = [
      '<pre><code class="language-mermaid">flowchart LR\nA--&gt;B</code></pre>',
      '<pre><code class="language-svg">&lt;svg&gt;&lt;circle r="4"/&gt;&lt;/svg&gt;</code></pre>',
      '<pre><code class="language-visual">&lt;div id="v"&gt;&lt;/div&gt;</code></pre>',
      '<pre><code class="language-html">&lt;p&gt;code&lt;/p&gt;</code></pre>',
    ].join('');
    win.document.body.appendChild(bubble);
    win.BotBoyHtmlViews.mountChatVisuals(bubble);
    win.BotBoyHtmlViews.mountChatVisuals(bubble); // idempotent
    const frames = [...bubble.querySelectorAll('iframe')] as any[];
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(frame.srcdoc).toContain("connect-src 'none'");
    }
    expect(frames[0].srcdoc).toContain('<pre class="mermaid">flowchart LR\nA--&gt;B</pre>');
    expect(frames[0].srcdoc).toContain('/vendor/mermaid.min.js');
    expect(frames[1].srcdoc).toContain('<svg><circle r="4"/></svg>');
    expect(bubble.querySelectorAll('.chat-visual-source pre')).toHaveLength(3);
    expect(bubble.querySelector('code.language-html')?.closest('figure')).toBeNull();
  });
});

describe('html view checks', () => {
  it('the page scan flags 1,000%+ ratios and NaN, and botboy.warn targets data-bb-metric', async () => {
    const win = load() as any;
    const doc = win.BotBoyHtmlViews.srcdoc({ config: { html: '<div data-bb-metric="Streams">344566900.0% of prior</div><div data-bb-metric="Clicks">0</div><p>Rate NaN</p><p>Share 43.8%</p>' } }, { mode: 'light', colors: {} });
    const view = new JSDOM(doc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<script src=[^>]*><\/script>/g, ''), { runScripts: 'dangerously' });
    const posts: any[] = [];
    Object.defineProperty(view.window, 'parent', { value: { postMessage: (message: unknown) => posts.push(message) } });
    (view.window as any).ResizeObserver = class { observe() {} };
    // re-run the helper with the stubbed parent
    const helper = doc.match(/<script>([\s\S]*?)<\/script>/)![1];
    view.window.eval(helper);
    view.window.eval(`botboy.warn({ metric: 'Clicks', message: 'Clicks has no rows for 2026-09' })`);
    await new Promise(resolve => setTimeout(resolve, 600));
    const report = posts.filter(message => message.type === 'issues').pop();
    expect(report.issues.map((issue: any) => [issue.metric, issue.source])).toEqual([['Clicks', 'view'], ['Streams', 'auto'], ['Rate NaN', 'auto']].map(([metric, source]) => [metric === 'Rate NaN' ? expect.any(String) : metric, source]));
    expect(view.window.document.querySelector('[data-bb-metric="Clicks"]')!.classList.contains('bb-issue')).toBe(true);
    expect(view.window.document.querySelector('[data-bb-metric="Streams"]')!.getAttribute('data-bb-issue')).toMatch(/base is zero/);
  });
});
