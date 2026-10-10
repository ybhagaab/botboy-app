/*
 * HTML views for analytics dashboards (docs/maps/analytics.md, kind=html).
 *
 * The model writes the page: any HTML, CSS, and JavaScript. It runs in a
 * sandboxed iframe (allow-scripts only: opaque origin, no BotBoy cookies or
 * API, no popups or navigation) under a CSP BotBoy prepends, which blocks
 * every network request and allows only BotBoy's own vendored chart scripts
 * (eval stays on for chart libraries: the page can only reach itself).
 * A page cannot loosen that CSP: policies only add up.
 *
 * Data never comes from the page. BotBoy posts the sibling widgets' rows in
 * after load and again after every refresh; the page reads them through
 * window.botboy. Live iframes are parked across re-renders (moveBefore keeps
 * their state), so a poll repaint never resets the owner's filters.
 */
(function () {
  const VIEWS = new Map(); // widgetId -> { frame, htmlKey, dataKey }
  const CHAT_FRAMES = new Set(); // chat visuals: height and error messages only
  const MAX_HEIGHT = 8000;

  function cssVars() {
    const styles = getComputedStyle(document.documentElement);
    const v = name => styles.getPropertyValue(name).trim();
    return {
      mode: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      colors: {
        bg: v('--bg'), surface: v('--surface'), surface2: v('--surface-2'), text: v('--text'), soft: v('--soft'),
        muted: v('--muted'), accent: v('--accent'), border: v('--border'), good: v('--green'), warn: v('--yellow'),
        bad: v('--red'), blue: v('--blue'),
      },
    };
  }

  function hashText(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    return `${text.length}:${h}`;
  }

  /** Every non-view widget with a result, keyed by config.key (else a title slug). */
  function datasetsFor(dashboard, inputs) {
    const out = {};
    for (const widget of dashboard.widgets || []) {
      if (widget.kind === 'html' || widget.kind === 'text') continue;
      const key = widget.config?.key || String(widget.title || widget.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
      if (Array.isArray(inputs) && inputs.length && !inputs.includes(key)) continue;
      const result = widget.result;
      const columns = Array.isArray(result?.columns) ? result.columns.map(String) : [];
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      out[key] = {
        title: widget.title,
        subtitle: widget.subtitle || '',
        columns,
        rows: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row?.[index] ?? null]))),
        rowCount: Number(result?.rowCount ?? rows.length),
        shownRows: rows.length,
        refreshedAt: result?.refreshedAt || null,
        error: widget.lastError || null,
        source: widget.config?.dataSource
          ? { kind: widget.config.dataSource.kind, datasetId: widget.config.dataSource.datasetId || null, versionId: result?.source?.versionId || null }
          : widget.sql ? { kind: 'warehouse_sql' } : null,
      };
    }
    return out;
  }

  function policy() {
    return `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${location.origin}/vendor/; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'`;
  }

  /**
   * Inside a view: window.botboy.warn({metric, message, severity, target})
   * reports a suspect figure (target: an element or a selector; else every
   * [data-bb-metric="<metric>"]). It is outlined in place and listed on the
   * dashboard's Warnings & issues panel. botboy.clearWarnings() starts over
   * (call it at the top of each render). BotBoy also scans the rendered text
   * itself: NaN, Infinity, undefined, and percentages of 1,000% or more.
   */
  const ISSUE_HELPER = String.raw`
      var manual = [], auto = [], scanTimer = null;
      var issueStyle = document.createElement('style');
      issueStyle.textContent = '.bb-issue{outline:2px solid var(--bb-warn,#f3ba63)!important;outline-offset:2px;border-radius:6px;position:relative}.bb-issue.bb-issue-error{outline-color:var(--bb-bad,#f0777d)!important}.bb-issue-badge{position:absolute;top:-9px;right:-9px;z-index:5;width:18px;height:18px;border-radius:50%;background:var(--bb-warn,#f3ba63);color:#1c1926;font:700 12px/18px Inter,sans-serif;text-align:center;cursor:help}.bb-issue-error>.bb-issue-badge{background:var(--bb-bad,#f0777d)}';
      document.head.appendChild(issueStyle);
      function targetsOf(issue){
        var t = issue.target;
        try {
          if (t && t.nodeType === 1) return [t];
          if (typeof t === 'string') return Array.prototype.slice.call(document.querySelectorAll(t));
          if (issue.metric) return Array.prototype.slice.call(document.querySelectorAll('[data-bb-metric="' + String(issue.metric).replace(/["\\]/g, '\\$&') + '"]'));
        } catch (e) {}
        return [];
      }
      function paint(){
        Array.prototype.forEach.call(document.querySelectorAll('.bb-issue'), function(el){ el.classList.remove('bb-issue', 'bb-issue-error'); el.removeAttribute('data-bb-issue'); var b = el.querySelector(':scope > .bb-issue-badge'); if (b) b.remove(); });
        var all = manual.concat(auto);
        all.forEach(function(issue, index){
          targetsOf(issue).forEach(function(el){
            el.classList.add('bb-issue'); if (issue.severity === 'error') el.classList.add('bb-issue-error');
            var text = (el.getAttribute('data-bb-issue') ? el.getAttribute('data-bb-issue') + '\n' : '') + issue.message;
            el.setAttribute('data-bb-issue', text); el.title = text;
            if (!el.querySelector(':scope > .bb-issue-badge')) { var badge = document.createElement('span'); badge.className = 'bb-issue-badge'; badge.textContent = '!'; badge.setAttribute('aria-label', 'Warning: ' + issue.message); el.appendChild(badge); }
          });
        });
        try { parent.postMessage({ botboyHtmlView: 1, type: 'issues', issues: all.map(function(i){ return { metric: String(i.metric || ''), message: String(i.message || '').slice(0, 400), severity: i.severity === 'error' ? 'error' : 'warn', source: i.source || 'view' }; }).slice(0, 60) }, '*'); } catch (e) {}
      }
      function label(el){
        var holder = el.closest('[data-bb-metric]');
        if (holder) return holder.getAttribute('data-bb-metric');
        var box = el.closest('section,article,li,div'); var head = box && box.querySelector('h1,h2,h3,h4,h5,h6,[class*=label],[class*=title]');
        return head ? String(head.textContent || '').trim().slice(0, 60) : '';
      }
      function scan(){
        auto = [];
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function(n){ return n.parentElement && !n.parentElement.closest('script,style,.bb-issue-badge') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
        var seen = new Set();
        for (var node = walker.nextNode(); node; node = walker.nextNode()) {
          var text = node.nodeValue || '', reason = '';
          if (/\b(NaN|Infinity|undefined)\b/.test(text)) reason = 'Shows "' + text.trim().slice(0, 40) + '": a calculation had no valid input.';
          else { var m = text.match(/(-?[\d,]+(?:\.\d+)?)\s*%/); if (m && Math.abs(parseFloat(m[1].replace(/,/g, ''))) >= 1000) reason = 'Shows ' + m[0].trim() + ': a ratio this large usually means its base is zero or the wrong metric.'; }
          if (!reason) continue;
          // Mark the figure's box (card, cell, row), not the inline text inside it.
          var el = node.parentElement.closest('[data-bb-metric]') || node.parentElement;
          while (el && el.parentElement && el !== document.body && getComputedStyle(el).display.indexOf('inline') === 0) el = el.parentElement;
          if (seen.has(el)) continue; seen.add(el);
          auto.push({ metric: label(el), message: reason, severity: 'warn', target: el, source: 'auto' });
        }
        paint();
      }
      function schedule(){ clearTimeout(scanTimer); scanTimer = setTimeout(scan, 400); }
      new MutationObserver(function(records){ if (records.some(function(r){ return !(r.target.classList && r.target.classList.contains('bb-issue-badge')) && !(r.type === 'attributes'); })) schedule(); }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      window.addEventListener('message', function(event){
        if (event.source !== parent || !event.data || event.data.botboyHtmlView !== 1 || event.data.type !== 'focus') return;
        var metric = String(event.data.metric || '');
        var el = Array.prototype.find.call(document.querySelectorAll('.bb-issue'), function(node){ return !metric || node.getAttribute('data-bb-metric') === metric || String(node.getAttribute('data-bb-issue') || '').indexOf(metric) >= 0 || String(node.textContent || '').indexOf(metric) >= 0; }) || document.querySelector('.bb-issue');
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        el.animate([{ outlineWidth: '2px' }, { outlineWidth: '6px' }, { outlineWidth: '2px' }], { duration: 900, iterations: 2 });
      });
      api.warn = function(issue){ if (issue && issue.message) { manual.push({ metric: issue.metric, message: issue.message, severity: issue.severity, target: issue.target, source: 'view' }); schedule(); } };
      api.clearWarnings = function(){ manual = []; schedule(); };
  `;

  function srcdoc(widget, theme) {
    const origin = location.origin;
    const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${origin}/vendor/; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'`;
    const c = theme.colors;
    const helper = `(function(){
      var listeners = [], resolveReady, ready = new Promise(function(r){ resolveReady = r; });
      var api = { data: {}, theme: null, ready: ready, onData: function(fn){ listeners.push(fn); if (api.theme) { try { fn(api.data, api.theme); } catch (e) { report(e); } } } };
      function report(e){ try { parent.postMessage({ botboyHtmlView: 1, type: 'error', message: String(e && e.message || e).slice(0, 300) }, '*'); } catch (x) {} }
      window.addEventListener('error', function(e){ report(e.error || e.message); });
      window.addEventListener('unhandledrejection', function(e){ report(e.reason); });
      window.addEventListener('message', function(event){
        if (event.source !== parent || !event.data || event.data.botboyHtmlView !== 1 || event.data.type !== 'data') return;
        api.data = event.data.datasets || {}; api.theme = event.data.theme || null;
        if (api.theme) { var s = document.documentElement.style; var k = api.theme.colors || {};
          [['bg','--bb-bg'],['surface','--bb-surface'],['surface2','--bb-surface-2'],['text','--bb-text'],['soft','--bb-soft'],['muted','--bb-muted'],['accent','--bb-accent'],['border','--bb-border'],['good','--bb-good'],['warn','--bb-warn'],['bad','--bb-bad'],['blue','--bb-blue']].forEach(function(p){ if (k[p[0]]) s.setProperty(p[1], k[p[0]]); });
          document.documentElement.dataset.theme = api.theme.mode; }
        resolveReady(api.data);
        listeners.forEach(function(fn){ try { fn(api.data, api.theme); } catch (e) { report(e); } });
      });
      function size(){ var h = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)); parent.postMessage({ botboyHtmlView: 1, type: 'height', height: h }, '*'); }
      new ResizeObserver(size).observe(document.documentElement);
      window.addEventListener('load', size);
      ${ISSUE_HELPER}
      window.botboy = api;
      parent.postMessage({ botboyHtmlView: 1, type: 'ready' }, '*');
    })();`;
    const base = `:root{--bb-bg:${c.bg};--bb-surface:${c.surface};--bb-surface-2:${c.surface2};--bb-text:${c.text};--bb-soft:${c.soft};--bb-muted:${c.muted};--bb-accent:${c.accent};--bb-border:${c.border};--bb-good:${c.good};--bb-warn:${c.warn};--bb-bad:${c.bad};--bb-blue:${c.blue};color-scheme:${theme.mode};}
html,body{margin:0;background:transparent;color:var(--bb-text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.45}`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}</style><script>${helper}<\/script><script src="${origin}/vendor/vega.min.js"><\/script><script src="${origin}/vendor/vega-lite.min.js"><\/script><script src="${origin}/vendor/vega-embed.min.js"><\/script></head><body>${String(widget.config?.html || '')}</body></html>`;
  }

  function post(view, dashboard, widget) {
    const datasets = datasetsFor(dashboard, widget.config?.inputs);
    const theme = cssVars();
    const dataKey = hashText(JSON.stringify(datasets)) + theme.mode;
    if (view.ready && view.dataKey === dataKey) return;
    view.pending = { datasets, theme, dataKey };
    if (!view.ready) return;
    view.frame.contentWindow?.postMessage({ botboyHtmlView: 1, type: 'data', datasets, theme }, '*');
    view.dataKey = dataKey;
  }

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.botboyHtmlView !== 1) return;
    for (const frame of CHAT_FRAMES) {
      if (!frame.isConnected) { CHAT_FRAMES.delete(frame); continue; }
      if (frame.contentWindow !== event.source) continue;
      if (data.type === 'height' && Number.isFinite(data.height)) frame.style.height = `${Math.min(1600, Math.max(60, data.height + 4))}px`;
      if (data.type === 'error') {
        const note = frame.parentElement?.querySelector('.chat-visual-error');
        if (note) { note.hidden = false; note.textContent = `This visual hit a script error: ${String(data.message || '')}`; }
      }
      return;
    }
    for (const [widgetId, view] of VIEWS) {
      if (view.frame.contentWindow !== event.source) continue;
      if (data.type === 'ready') {
        view.ready = true;
        if (view.pending) {
          view.frame.contentWindow.postMessage({ botboyHtmlView: 1, type: 'data', datasets: view.pending.datasets, theme: view.pending.theme }, '*');
          view.dataKey = view.pending.dataKey;
        }
      } else if (data.type === 'height' && Number.isFinite(data.height)) {
        view.frame.style.height = `${Math.min(MAX_HEIGHT, Math.max(80, data.height + 4))}px`;
      } else if (data.type === 'issues' && Array.isArray(data.issues)) {
        view.issues = data.issues.slice(0, 60).map(issue => ({
          metric: String(issue?.metric || '').slice(0, 80),
          message: String(issue?.message || '').slice(0, 400),
          severity: issue?.severity === 'error' ? 'error' : 'warn',
          source: issue?.source === 'auto' ? 'auto' : 'view',
        }));
        window.dispatchEvent(new CustomEvent('botboy:view-issues', { detail: { widgetId, issues: view.issues } }));
      } else if (data.type === 'error') {
        const note = view.frame.parentElement?.querySelector('.analytics-html-error');
        if (note) { note.hidden = false; note.textContent = `This view hit a script error: ${String(data.message || '')}`; }
        console.warn(`[html view ${widgetId}]`, data.message);
      }
    }
  });

  /** Before a repaint: move live frames out of the DOM that is about to be replaced. */
  function park() {
    let lot = document.getElementById('analytics-html-parking');
    if (!lot) {
      lot = document.createElement('div');
      lot.id = 'analytics-html-parking';
      lot.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:10px;overflow:hidden;visibility:hidden';
      document.body.appendChild(lot);
    }
    for (const view of VIEWS.values()) {
      if (!view.frame.isConnected || view.frame.parentElement === lot) continue;
      if (typeof lot.moveBefore === 'function') lot.moveBefore(view.frame, null);
      else lot.appendChild(view.frame);
    }
  }

  /** After a repaint: put each view's frame in its container (new frame only when the page changed). */
  function mount(dashboard) {
    const seen = new Set();
    for (const container of document.querySelectorAll('[data-analytics-html]')) {
      const widget = (dashboard.widgets || []).find(item => item.id === container.dataset.analyticsHtml);
      if (!widget) continue;
      seen.add(widget.id);
      const htmlKey = hashText(String(widget.config?.html || ''));
      let view = VIEWS.get(widget.id);
      if (view && view.htmlKey !== htmlKey) { view.frame.remove(); VIEWS.delete(widget.id); view = null; }
      if (!view) {
        const frame = document.createElement('iframe');
        frame.className = 'analytics-html-frame';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('title', String(widget.title || 'Dashboard view'));
        frame.style.height = '320px';
        view = { frame, htmlKey, dataKey: '', ready: false, pending: null };
        VIEWS.set(widget.id, view);
        frame.srcdoc = srcdoc(widget, cssVars());
      }
      const slot = container.querySelector('.analytics-html-slot') || container;
      if (view.frame.parentElement !== slot) {
        if (typeof slot.moveBefore === 'function' && view.frame.isConnected) slot.moveBefore(view.frame, null);
        else slot.appendChild(view.frame);
      }
      post(view, dashboard, widget);
    }
    for (const [widgetId, view] of VIEWS) {
      if (!seen.has(widgetId)) { view.frame.remove(); VIEWS.delete(widgetId); }
    }
  }

  // ── Chat visuals: ```visual (an HTML page), ```svg, ```mermaid ──
  // The same sandbox as dashboard views, with no data at all: the reply's
  // own markup is the whole page. The fenced source stays one click away.
  const CHAT_LANGUAGES = { visual: 'visual', html_visual: 'visual', svg: 'svg', mermaid: 'mermaid' };

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function chatSrcdoc(kind, source, theme) {
    const origin = location.origin;
    const c = theme.colors;
    const sizer = `<script>(function(){function size(){parent.postMessage({botboyHtmlView:1,type:'height',height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0))},'*');}new ResizeObserver(size).observe(document.documentElement);addEventListener('load',size);addEventListener('error',function(e){parent.postMessage({botboyHtmlView:1,type:'error',message:String(e.message||e.error||'')},'*');});})();<\/script>`;
    const base = `<style>:root{--bb-bg:${c.bg};--bb-surface:${c.surface};--bb-text:${c.text};--bb-muted:${c.muted};--bb-accent:${c.accent};--bb-border:${c.border};--bb-good:${c.good};--bb-warn:${c.warn};--bb-bad:${c.bad};--bb-blue:${c.blue};color-scheme:${theme.mode}}html,body{margin:0;background:transparent;color:var(--bb-text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.45}svg{max-width:100%;height:auto}</style>`;
    let body = source;
    let scripts = '';
    if (kind === 'mermaid') {
      body = `<pre class="mermaid">${escapeHtml(source)}</pre>`;
      scripts = `<script src="${origin}/vendor/mermaid.min.js"><\/script><script>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:${JSON.stringify(theme.mode === 'light' ? 'default' : 'dark')},fontFamily:'Inter, sans-serif'});mermaid.run({querySelector:'.mermaid'}).catch(function(e){parent.postMessage({botboyHtmlView:1,type:'error',message:String(e&&e.message||e)},'*');});<\/script>`;
    } else if (kind === 'visual') {
      scripts = `<script src="${origin}/vendor/vega.min.js"><\/script><script src="${origin}/vendor/vega-lite.min.js"><\/script><script src="${origin}/vendor/vega-embed.min.js"><\/script>`;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy()}">${base}${sizer}${kind === 'visual' ? scripts : ''}</head><body>${body}${kind === 'mermaid' ? scripts : ''}</body></html>`;
  }

  /** Turns finished replies' visual code blocks into live sandboxed views. */
  function mountChatVisuals(root) {
    if (!root?.querySelectorAll) return;
    for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
      const pre = code.parentElement;
      if (!pre || pre.dataset.visualMounted || pre.closest('.streaming-live')) continue;
      const language = (String(code.className).match(/language-([\w-]+)/) || [])[1]?.toLowerCase().replace(/-/g, '_');
      const kind = CHAT_LANGUAGES[language || ''];
      if (!kind) continue;
      pre.dataset.visualMounted = '1';
      const source = code.textContent || '';
      const figure = document.createElement('figure');
      figure.className = `chat-visual chat-visual-${kind}`;
      const frame = document.createElement('iframe');
      frame.className = 'chat-visual-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', kind === 'mermaid' ? 'Diagram' : 'Visual');
      frame.style.height = '160px';
      frame.srcdoc = chatSrcdoc(kind, source, cssVars());
      frame._botboyVisual = { kind, source, mode: cssVars().mode };
      CHAT_FRAMES.add(frame);
      const error = document.createElement('div');
      error.className = 'chat-visual-error';
      error.hidden = true;
      const details = document.createElement('details');
      details.className = 'chat-visual-source';
      const summary = document.createElement('summary');
      summary.textContent = 'Show source';
      details.append(summary);
      pre.replaceWith(figure);
      details.append(pre);
      figure.append(frame, error, details);
    }
  }

  // The saved theme applies after first paint, and the owner can switch it:
  // chat visuals redraw in the new theme; dashboard views get it posted.
  new MutationObserver(() => {
    const theme = cssVars();
    for (const frame of CHAT_FRAMES) {
      const visual = frame._botboyVisual;
      if (!frame.isConnected || !visual || visual.mode === theme.mode) continue;
      visual.mode = theme.mode;
      frame.srcdoc = chatSrcdoc(visual.kind, visual.source, theme);
    }
    for (const view of VIEWS.values()) {
      if (!view.ready || !view.pending) continue;
      view.pending = { ...view.pending, theme, dataKey: '' };
      view.frame.contentWindow?.postMessage({ botboyHtmlView: 1, type: 'data', datasets: view.pending.datasets, theme }, '*');
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /** Issues each live view last reported (widgetId → list). */
  function viewIssues() {
    const out = new Map();
    for (const [widgetId, view] of VIEWS) if (view.issues?.length) out.set(widgetId, view.issues);
    return out;
  }

  /** From the Warnings panel: point the view at the flagged figure. */
  function focusIssue(widgetId, metric) {
    const view = VIEWS.get(widgetId);
    view?.frame.contentWindow?.postMessage({ botboyHtmlView: 1, type: 'focus', metric }, '*');
  }

  window.BotBoyHtmlViews = { focusIssue, park, mount, datasetsFor, srcdoc, chatSrcdoc, mountChatVisuals, viewIssues, ISSUE_HELPER };
})();
