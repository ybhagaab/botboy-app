import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaSourceDeps } from '../core/media-sources.js';
import type { VisualRenderer } from '../core/visual-render.js';
import { addSvgPngFallbacks, checkDocumentMedia, diagramAlt, findDocumentMedia, prepareExportMedia } from './document-media.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000030000000208020000', 'hex'), Buffer.alloc(16)]);

let tmp: string;
let sources: MediaSourceDeps;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'document-media-'));
  const home = path.join(tmp, 'home');
  const privateRoot = path.join(home, '.personal-productivity-tracker');
  sources = { homeDir: home, filesDir: path.join(privateRoot, 'files'), attachmentsDir: path.join(privateRoot, 'chat-attachments') };
  fs.mkdirSync(sources.filesDir, { recursive: true });
  fs.writeFileSync(path.join(sources.filesDir, 'chart.png'), PNG);
  fs.writeFileSync(path.join(sources.filesDir, 'shape.svg'), '<svg viewBox="0 0 10 10"/>');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Draws every job as a tiny SVG plus a PNG that names it, or fails the ones whose source says "broken". */
const fakeRender: VisualRenderer = async jobs => new Map(jobs.map(job => [job.id, job.source.includes('broken')
  ? { ok: false as const, error: 'Parse error on line 2' }
  : { ok: true as const, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" data-job="${job.id}"/>`, png: Buffer.from(`png:${job.id}`), width: 40, height: 20 }]));

describe('finding pictures and diagrams in a document', () => {
  it('finds image lines and ```mermaid / ```svg blocks, and nothing inside code', () => {
    const markdown = [
      '# Title',
      'See ![Pie chart](/api/files/chart.png "Share") and ![](<shots/a b.png>).',
      '',
      '```mermaid',
      'flowchart LR',
      '  A-->B',
      '```',
      '',
      '~~~svg',
      '<svg viewBox="0 0 1 1"/>',
      '~~~',
      '',
      'Code: `![not a picture](x.png)`',
      '```js',
      'const s = "![also not](y.png)";',
      '```',
      '````markdown',
      '```mermaid',
      'not a diagram either',
      '```',
      '````',
    ].join('\n');
    const refs = findDocumentMedia(markdown);
    expect(refs.map(ref => (ref.kind === 'image' ? `image:${ref.line}:${ref.src}:${ref.alt}:${ref.title}` : `diagram:${ref.line}:${ref.lang}`))).toEqual([
      'image:2:/api/files/chart.png:Pie chart:"Share"',
      'image:2:shots/a b.png::',
      'diagram:4:mermaid',
      'diagram:9:svg',
    ]);
    const [first, , flow] = refs;
    expect(markdown.slice(first.start, first.end)).toBe('![Pie chart](/api/files/chart.png "Share")');
    expect(markdown.slice(flow.start, flow.end)).toBe('```mermaid\nflowchart LR\n  A-->B\n```');
    expect(flow.kind === 'diagram' && flow.source).toBe('flowchart LR\n  A-->B');
  });

  it('an unclosed block is not a diagram', () => {
    expect(findDocumentMedia('```mermaid\nflowchart LR\n A-->B')).toEqual([]);
  });

  it('names a diagram by its accTitle or title, else by number', () => {
    const base = { kind: 'diagram' as const, line: 1, start: 0, end: 0 };
    expect(diagramAlt({ ...base, lang: 'mermaid', source: 'flowchart LR\naccTitle: Release flow\nA-->B' }, 1)).toBe('Release flow');
    expect(diagramAlt({ ...base, lang: 'mermaid', source: 'pie title Share of traffic\n "a": 1' }, 2)).toBe('Share of traffic');
    expect(diagramAlt({ ...base, lang: 'mermaid', source: '---\ntitle: "Front"\n---\nflowchart LR\nA-->B' }, 3)).toBe('Front');
    expect(diagramAlt({ ...base, lang: 'svg', source: '<svg><title>Logo</title></svg>' }, 4)).toBe('Logo');
    expect(diagramAlt({ ...base, lang: 'mermaid', source: 'flowchart LR\nA-->B' }, 5)).toBe('Diagram 5');
  });
});

describe('preparing an export', () => {
  it('copies BotBoy’s pictures into media/, draws diagrams there, and leaves other sources as written', async () => {
    const workDir = path.join(tmp, 'work');
    fs.mkdirSync(workDir);
    const outside = path.join(tmp, 'elsewhere.png');
    fs.writeFileSync(outside, PNG);
    const markdown = [
      '![Chart](/api/files/chart.png)',
      '![Shape](shape.svg "Logo")',
      '![Web](https://example.com/a.png)',
      `![Outside](${outside})`,
      'Gone: ![Old screenshot](/api/files/old.png) here.',
      '```mermaid',
      'flowchart LR',
      'A-->B',
      '```',
      'After.',
      '```mermaid',
      'broken',
      '```',
    ].join('\n');
    const prepared = await prepareExportMedia(markdown, workDir, { sources, render: fakeRender });
    expect(prepared.markdown.split('\n')).toEqual([
      '![Chart](media/picture-1.png)',
      '![Shape](media/picture-2.svg "Logo")',
      '![Web](https://example.com/a.png)',
      `![Outside](${outside})`,
      'Gone: *Old screenshot* here.',
      '',
      '![Diagram 1](media/diagram-1.svg)',
      '',
      'After.',
      '```mermaid',
      'broken',
      '```',
    ]);
    expect(fs.readFileSync(path.join(workDir, 'media', 'picture-1.png'))).toEqual(PNG);
    // The SVG picture is written as drawn (sized), and both SVGs have a PNG for Word.
    const shape = fs.readFileSync(path.join(workDir, 'media', 'picture-2.svg'));
    const diagram = fs.readFileSync(path.join(workDir, 'media', 'diagram-1.svg'));
    expect(shape.toString()).toContain('data-job="p2"');
    expect(prepared.pngForSvg.get(createHash('sha256').update(shape).digest('hex'))?.toString()).toBe('png:p2');
    expect(prepared.pngForSvg.get(createHash('sha256').update(diagram).digest('hex'))?.toString()).toBe('png:d1');
    expect(prepared.summary).toMatchObject({ pictures: 5, diagrams: 2, embedded: 3 });
    expect(prepared.summary.problems.map(problem => `${problem.kind}:${problem.line}`)).toEqual(['picture:5', 'diagram:11']);
  });

  it('touches nothing when a document has no pictures or diagrams', async () => {
    const render = vi.fn(fakeRender);
    const prepared = await prepareExportMedia('# Plain\n\nText only.', tmp, { sources, render });
    expect(prepared).toMatchObject({ markdown: '# Plain\n\nText only.', summary: { pictures: 0, diagrams: 0, embedded: 0, problems: [] } });
    expect(render).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'media'))).toBe(false);
  });
});

describe('Word’s fallback pictures for SVG', () => {
  const svg = Buffer.from('<svg/>');
  const sha = createHash('sha256').update(svg).digest('hex');
  const parts = {
    documentXml: [
      '<w:document xmlns:r="r">',
      '<a:blip r:embed="rId9" />',
      '<a:blip><a:extLst><a:ext uri="{96DAC541}"><asvg:svgBlip xmlns:asvg="x" r:embed="rId12" /></a:ext></a:extLst></a:blip>',
      '<a:blip r:embed="rId20"><a:extLst><asvg:svgBlip r:embed="rId21" /></a:extLst></a:blip>',
      '</w:document>',
    ].join(''),
    relsXml: '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/rId9.png" /><Relationship Id="rId12" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/rId12.svg" /><Relationship Id="rId21" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/rId21.svg" /></Relationships>',
    contentTypesXml: '<Types><Default Extension="svg" ContentType="image/svg+xml" /></Types>',
  };

  it('points each SVG picture without one at a PNG, the way Word saves an SVG, and adds the part', () => {
    const result = addSvgPngFallbacks(parts, new Map([['media/rId12.svg', svg], ['media/rId21.svg', svg]]), new Map([[sha, Buffer.from('PNG')]]));
    expect(result.added).toBe(1);
    // The raster picture's self-closing blip is left alone and does not swallow the SVG one after it.
    expect(result.documentXml).toContain('<a:blip r:embed="rId9" />');
    expect(result.documentXml).toContain('<a:blip r:embed="rIdBotboyPng1"><a:extLst><a:ext uri="{96DAC541}"><asvg:svgBlip xmlns:asvg="x" r:embed="rId12" />');
    // A blip that already has its picture keeps it.
    expect(result.documentXml).toContain('<a:blip r:embed="rId20">');
    expect(result.relsXml).toContain('<Relationship Id="rIdBotboyPng1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/rId12-botboy.png" />');
    expect(result.relsXml.match(/rIdBotboyPng/g)).toHaveLength(1);
    expect(result.contentTypesXml).toContain('<Default Extension="png" ContentType="image/png" />');
    expect(result.files).toEqual([{ path: 'word/media/rId12-botboy.png', data: Buffer.from('PNG') }]);
    // png already declared: not twice.
    const again = addSvgPngFallbacks({ ...parts, contentTypesXml: result.contentTypesXml }, new Map([['media/rId12.svg', svg]]), new Map([[sha, Buffer.from('PNG')]]));
    expect(again.contentTypesXml.match(/Extension="png"/g)).toHaveLength(1);
  });

  it('leaves the package exactly as it was when no SVG has a PNG', () => {
    const result = addSvgPngFallbacks(parts, new Map([['media/rId12.svg', Buffer.from('<svg other/>')]]), new Map([[sha, Buffer.from('PNG')]]));
    expect(result).toEqual({ ...parts, files: [], added: 0 });
  });

  it('leaves it as it was when every SVG picture already has its PNG (no part nobody points at)', () => {
    const withEmbeds = { ...parts, documentXml: parts.documentXml.replace('<a:blip><a:extLst>', '<a:blip r:embed="rId30"><a:extLst>') };
    const result = addSvgPngFallbacks(withEmbeds, new Map([['media/rId12.svg', svg], ['media/rId21.svg', svg]]), new Map([[sha, Buffer.from('PNG')]]));
    expect(result).toEqual({ ...withEmbeds, files: [], added: 0 });
  });
});

describe('what a save receipt says about pictures and diagrams', () => {
  it('counts what shows, names what will not, and draws each diagram once to check it', async () => {
    const render = vi.fn(fakeRender);
    const check = await checkDocumentMedia([
      '![Chart](chart.png)',
      '![Web](https://example.com/a.png)',
      '![Gone](/api/files/gone.png)',
      '```mermaid',
      'flowchart LR',
      '```',
      '```svg',
      'broken',
      '```',
    ].join('\n'), { sources, render });
    expect(check).toMatchObject({ pictures: 3, diagrams: 2, shown: 1, diagramsChecked: true });
    expect(check!.problems.map(problem => `${problem.kind}:${problem.line}:${/does not draw|cannot show|leave it out/.exec(problem.message)?.[0]}`)).toEqual([
      'picture:2:cannot show', 'picture:3:leave it out', 'diagram:7:does not draw',
    ]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][1]).toMatchObject({ png: false });
  });

  it('says so when Chrome is not there to check diagrams, and is null for a plain document', async () => {
    const noChrome: VisualRenderer = async jobs => new Map(jobs.map(job => [job.id, { ok: false as const, error: 'Drawing diagrams needs Google Chrome, which BotBoy did not find on this Mac.' }]));
    expect(await checkDocumentMedia('```mermaid\nflowchart LR\n```', { sources, render: noChrome })).toMatchObject({ diagrams: 1, problems: [], diagramsChecked: false });
    expect(await checkDocumentMedia('# Just words', { sources, render: noChrome })).toBeNull();
  });
});
