import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderVisuals } from './visual-render.js';

// Real headless Chrome (the same one the PDF export prints with); skipped on a Mac without it.
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].some(file => fs.existsSync(file));

function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.toString('hex', 0, 8)).toBe('89504e470d0a1a0a');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe.skipIf(!chrome)('drawing diagrams with BotBoy’s headless Chrome', () => {
  it('draws Mermaid with plain SVG text labels, a sized SVG, and a PNG at twice the size', async () => {
    const results = await renderVisuals([
      { id: 'flow', kind: 'mermaid', source: 'flowchart LR\n  A[Draft] --> B{Review}\n  B -->|ok| C[Publish]' },
      { id: 'pie', kind: 'mermaid', source: 'pie title Share\n  "Web" : 60\n  "App" : 40' },
    ]);
    for (const id of ['flow', 'pie']) {
      const result = results.get(id)!;
      expect(result.ok, id).toBe(true);
      if (!result.ok) continue;
      // Word and Google draw SVG text, not HTML inside SVG.
      expect(result.svg).not.toContain('foreignObject');
      expect(result.svg).toMatch(new RegExp(`<svg[^>]*width="${result.width}"`));
      expect(pngSize(result.png!)).toEqual({ width: result.width * 2, height: result.height * 2 });
    }
    const flow = results.get('flow')!;
    if (flow.ok) for (const label of ['Draft', 'Review', 'Publish', 'ok']) expect(flow.svg).toContain(`>${label}<`);
  }, 60_000);

  it('reports each broken drawing with its reason, and draws the others', async () => {
    const results = await renderVisuals([
      { id: 'bad', kind: 'mermaid', source: 'flowchart LR\n A-->' },
      { id: 'html', kind: 'svg', source: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><foreignObject width="10" height="10"/></svg>' },
      { id: 'nosize', kind: 'svg', source: '<svg><rect width="10" height="10"/></svg>' },
      { id: 'notsvg', kind: 'svg', source: '<div>hi</div>' },
      { id: 'good', kind: 'svg', source: '<svg viewBox="0 0 40 20"><rect width="40" height="20" fill="#36c"/></svg>' },
    ]);
    expect(results.get('bad')).toMatchObject({ ok: false, error: expect.stringMatching(/Parse error/) });
    expect(results.get('html')).toMatchObject({ ok: false, error: expect.stringMatching(/foreignObject/) });
    expect(results.get('nosize')).toMatchObject({ ok: false, error: expect.stringMatching(/viewBox/) });
    expect(results.get('notsvg')).toMatchObject({ ok: false, error: expect.stringMatching(/not an SVG/) });
    expect(results.get('good')).toMatchObject({ ok: true, width: 40, height: 20 });
  }, 60_000);

  it('removes scripts and event handlers from an SVG, and adds the namespace it needs', async () => {
    const result = (await renderVisuals([{ id: 's', kind: 'svg', source: '<svg viewBox="0 0 30 30" onload="alert(1)"><script>alert(2)</script><circle cx="15" cy="15" r="9" onclick="x()"/></svg>' }], { png: false })).get('s')!;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).not.toMatch(/script|onload|onclick/);
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result.png).toBeUndefined();
  }, 60_000);

  it('turns a picture (here a PNG data URL) into a PNG at its own size', async () => {
    const first = (await renderVisuals([{ id: 'p', kind: 'svg', source: '<svg viewBox="0 0 12 8"><rect width="12" height="8" fill="#e33"/></svg>' }], { scale: 1 })).get('p')!;
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const converted = (await renderVisuals([{ id: 'img', kind: 'image', source: `data:image/png;base64,${first.png!.toString('base64')}` }], { scale: 1 })).get('img')!;
    expect(converted).toMatchObject({ ok: true, width: 12, height: 8 });
  }, 60_000);
});
