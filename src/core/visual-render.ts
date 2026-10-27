/**
 * Diagrams and pictures drawn by BotBoy's own headless Chrome (docs/maps/document-media.md).
 *
 * One Chrome run draws a batch of jobs and answers in the page's DOM:
 *   mermaid  Mermaid source → SVG with plain SVG text labels (htmlLabels off), so Word,
 *            Google and every other viewer can draw it, then a PNG.
 *   svg      SVG text → a sized SVG (explicit width and height, scripts and on* handlers
 *            removed), then a PNG. An SVG that holds HTML (foreignObject) is refused: no
 *            document viewer draws it.
 *   image    a picture as a data URL (WebP, say) → PNG.
 * PNGs are drawn at `scale` (2 = crisp on Word pages and Retina screens); width and height
 * are reported at 1x, in CSS pixels.
 *
 * The page is a local file under a CSP that allows no network at all. Model-written SVG is
 * only ever loaded as an <img> (images run no scripts) and Mermaid runs with
 * securityLevel 'strict'. Chrome is the same one the PDF export prints with; without it every
 * job fails with an error that says so.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type VisualRenderKind = 'mermaid' | 'svg' | 'image';

export interface VisualRenderJob {
  id: string;
  kind: VisualRenderKind;
  /** mermaid: the diagram source; svg: the SVG text; image: a data: URL. */
  source: string;
}

export type VisualRenderResult =
  | { ok: true; svg?: string; png?: Buffer; width: number; height: number }
  | { ok: false; error: string };

export interface VisualRenderOptions {
  /** PNG density (default 2). */
  scale?: number;
  /** false: only the SVG (a quick syntax and size check). Default true. */
  png?: boolean;
  timeoutMs?: number;
}

export type VisualRenderer = (jobs: readonly VisualRenderJob[], options?: VisualRenderOptions) => Promise<Map<string, VisualRenderResult>>;

export const NO_CHROME_MESSAGE = 'Drawing diagrams needs Google Chrome, which BotBoy did not find on this Mac.';
const MAX_JOBS_PER_RUN = 40;
const DEFAULT_TIMEOUT_MS = 90_000;

function chromeCandidates(): string[] {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ];
}

function run(file: string, args: string[], options: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let chromeFound: string | null = null;

/** The Chrome to draw with (cached once found; a missing Chrome is looked for again next time). */
export async function resolveRenderChrome(): Promise<string | null> {
  if (chromeFound) return chromeFound;
  for (const candidate of chromeCandidates()) {
    try {
      await run(candidate, ['--version'], { timeout: 10_000 });
      chromeFound = candidate;
      return candidate;
    } catch {
      // the next candidate
    }
  }
  return null;
}

/** Mermaid's browser build, from node_modules (the same file the UI vendors). */
function mermaidScriptPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');
  } catch {
    return null;
  }
}

const PAGE_SCRIPT = String.raw`
(async function () {
  var jobs = JSON.parse(atob(document.getElementById('botboy-jobs').textContent));
  var options = JSON.parse(atob(document.getElementById('botboy-options').textContent));
  var results = {};
  var SVG_NS = 'http://www.w3.org/2000/svg';
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false,
      flowchart: { htmlLabels: false }, fontFamily: 'Helvetica, Arial, sans-serif' });
  }
  function px(value) {
    var match = /^\s*([0-9.]+)\s*(px|pt|in|cm|mm|pc)?\s*$/.exec(String(value || ''));
    if (!match) return NaN;
    var n = parseFloat(match[1]);
    var unit = match[2] || 'px';
    return unit === 'pt' ? n * 4 / 3 : unit === 'in' ? n * 96 : unit === 'cm' ? n * 96 / 2.54 : unit === 'mm' ? n * 96 / 25.4 : unit === 'pc' ? n * 16 : n;
  }
  function sized(svgText) {
    var source = String(svgText);
    if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(source)) throw new Error('This is not an SVG drawing: it must start with <svg>.');
    if (!/<svg[^>]*\sxmlns\s*=/i.test(source)) source = source.replace(/<svg/i, '<svg xmlns="' + SVG_NS + '"');
    var doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    var error = doc.getElementsByTagName('parsererror')[0];
    if (error) throw new Error('The SVG is not well-formed XML: ' + String(error.textContent || '').trim().slice(0, 200));
    var root = doc.documentElement;
    if (!root || root.localName !== 'svg') throw new Error('The drawing must have <svg> as its outer element.');
    if (root.getElementsByTagNameNS(SVG_NS, 'foreignObject').length || root.getElementsByTagName('foreignObject').length) {
      throw new Error('The SVG holds HTML (foreignObject), which Word and Google cannot draw; write the text with <text> elements instead.');
    }
    Array.prototype.slice.call(root.getElementsByTagName('script')).forEach(function (node) { node.parentNode.removeChild(node); });
    Array.prototype.slice.call(root.getElementsByTagName('*')).concat([root]).forEach(function (node) {
      Array.prototype.slice.call(node.attributes).forEach(function (attribute) { if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name); });
    });
    var box = String(root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    var hasBox = box.length === 4 && box[2] > 0 && box[3] > 0;
    var w = /%/.test(root.getAttribute('width') || '') ? NaN : px(root.getAttribute('width'));
    var h = /%/.test(root.getAttribute('height') || '') ? NaN : px(root.getAttribute('height'));
    if (!(w > 0) && hasBox) w = (h > 0 ? h * box[2] / box[3] : box[2]);
    if (!(h > 0) && hasBox) h = (w > 0 ? w * box[3] / box[2] : box[3]);
    if (!(w > 0) || !(h > 0)) throw new Error('The SVG needs a viewBox, or a width and a height, so BotBoy knows its size.');
    if (!hasBox) root.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    // Mermaid sets max-width in a style; the explicit size now decides.
    root.style.removeProperty('max-width');
    if (!root.getAttribute('style')) root.removeAttribute('style');
    return { svg: new XMLSerializer().serializeToString(root), width: w, height: h };
  }
  function draw(url, w, h) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var width = w || img.naturalWidth;
          var height = h || img.naturalHeight;
          if (!(width > 0) || !(height > 0)) throw new Error('The picture has no size.');
          var scale = Math.max(0.05, Math.min(options.scale, 8000 / width, 8000 / height, Math.sqrt(48e6 / (width * height))));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve({ png: canvas.toDataURL('image/png'), width: Math.round(width), height: Math.round(height) });
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () { reject(new Error('Chrome could not draw this picture.')); };
      img.src = url;
    });
  }
  function svgUrl(svg) { return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); }
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    try {
      if (job.kind === 'image') {
        var picture = await draw(job.source, 0, 0);
        results[job.id] = { ok: true, png: picture.png, width: picture.width, height: picture.height };
        continue;
      }
      var text = job.source;
      if (job.kind === 'mermaid') {
        if (!window.mermaid) throw new Error('Mermaid is not installed with this BotBoy.');
        text = (await mermaid.render('botboy_diagram_' + i, job.source)).svg;
      }
      var drawn = sized(text);
      var result = { ok: true, svg: drawn.svg, width: drawn.width, height: drawn.height };
      if (options.png) result.png = (await draw(svgUrl(drawn.svg), drawn.width, drawn.height)).png;
      results[job.id] = result;
    } catch (error) {
      results[job.id] = { ok: false, error: String(error && error.message || error).replace(/\s+$/, '').slice(0, 600) };
    }
  }
  document.getElementById('botboy-out').textContent = btoa(unescape(encodeURIComponent(JSON.stringify(results))));
  document.title = 'botboy-done';
})();
`;

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function pageHtml(jobs: readonly VisualRenderJob[], options: { scale: number; png: boolean }, mermaidUrl: string | null): string {
  const csp = "default-src 'none'; script-src file: 'unsafe-inline' 'unsafe-eval'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    mermaidUrl && jobs.some(job => job.kind === 'mermaid') ? `<script src="${mermaidUrl}"></script>` : '',
    '</head><body>',
    `<script type="text/plain" id="botboy-jobs">${base64Json(jobs)}</script>`,
    `<script type="text/plain" id="botboy-options">${base64Json(options)}</script>`,
    '<pre id="botboy-out"></pre>',
    `<script>${PAGE_SCRIPT}</script>`,
    '</body></html>',
  ].join('');
}

async function runBatch(chrome: string, jobs: readonly VisualRenderJob[], options: { scale: number; png: boolean; timeoutMs: number }): Promise<Map<string, VisualRenderResult>> {
  const out = new Map<string, VisualRenderResult>();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botboy-visual-render-'));
  try {
    const script = mermaidScriptPath();
    const pagePath = path.join(workDir, 'render.html');
    await fs.writeFile(pagePath, pageHtml(jobs, options, script ? pathToFileURL(script).href : null), 'utf8');
    const { stdout } = await run(chrome, [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      '--hide-scrollbars',
      `--user-data-dir=${path.join(workDir, 'chrome-profile')}`,
      '--virtual-time-budget=60000',
      '--dump-dom',
      pathToFileURL(pagePath).href,
    ], { timeout: options.timeoutMs, maxBuffer: 1024 * 1024 * 1024 });
    const match = /<pre id="botboy-out">([A-Za-z0-9+/=]*)<\/pre>/.exec(stdout);
    if (!match || !match[1]) {
      for (const job of jobs) out.set(job.id, { ok: false, error: 'Chrome did not finish drawing (the page timed out).' });
      return out;
    }
    const parsed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Record<string, { ok: boolean; svg?: string; png?: string; width?: number; height?: number; error?: string }>;
    for (const job of jobs) {
      const entry = parsed[job.id];
      if (!entry) { out.set(job.id, { ok: false, error: 'Chrome returned nothing for this drawing.' }); continue; }
      if (!entry.ok) { out.set(job.id, { ok: false, error: String(entry.error || 'Drawing failed.') }); continue; }
      const png = typeof entry.png === 'string' && entry.png.startsWith('data:image/png;base64,')
        ? Buffer.from(entry.png.slice('data:image/png;base64,'.length), 'base64')
        : undefined;
      out.set(job.id, {
        ok: true,
        ...(typeof entry.svg === 'string' ? { svg: entry.svg } : {}),
        ...(png ? { png } : {}),
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
      });
    }
    return out;
  } catch (error) {
    const timedOut = (error as { killed?: boolean })?.killed === true;
    const message = timedOut ? 'Chrome took too long to draw these diagrams.' : `Chrome could not draw: ${String((error as Error)?.message ?? error).split('\n')[0].slice(0, 200)}`;
    for (const job of jobs) out.set(job.id, { ok: false, error: message });
    return out;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Draw every job (in batches of 40); a job's failure never fails the others. */
export const renderVisuals: VisualRenderer = async (jobs, options = {}) => {
  const out = new Map<string, VisualRenderResult>();
  if (!jobs.length) return out;
  const chrome = await resolveRenderChrome();
  if (!chrome) {
    for (const job of jobs) out.set(job.id, { ok: false, error: NO_CHROME_MESSAGE });
    return out;
  }
  const settings = { scale: Math.max(0.5, Math.min(4, options.scale ?? 2)), png: options.png !== false, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  for (let start = 0; start < jobs.length; start += MAX_JOBS_PER_RUN) {
    const batch = jobs.slice(start, start + MAX_JOBS_PER_RUN);
    for (const [id, result] of await runBatch(chrome, batch, settings)) out.set(id, result);
  }
  return out;
};
