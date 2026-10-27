/**
 * Pictures and diagrams in BotBoy's documents (docs/maps/document-media.md).
 *
 * A document is Markdown. A picture is an image line, ![description](source), whose
 * source is a picture BotBoy holds (core/media-sources.ts: a file in its files
 * workspace, a chat image or screenshot va_…, a chat attachment att_…). A diagram is a
 * ```mermaid or ```svg block. The reader shows both (app.js › markdownImageUrl,
 * analytics-html-view.js › mountDocumentVisuals) and every export embeds them
 * (prepareExportMedia): pictures are copied into the export's own folder (pandoc runs
 * there), diagrams are drawn by BotBoy's headless Chrome (core/visual-render.ts) as SVG,
 * which HTML and PDF keep as vectors, and Word gets each SVG with a PNG fallback
 * (addSvgPngFallbacks), so Word, SharePoint, Google Drive's converter and older viewers
 * all show them.
 *
 * Sources that are not BotBoy's (an https link, a path elsewhere on this Mac) are left
 * exactly as they were written, so the exporter treats them as it always has.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { IMAGE_EXTENSION, resolveBotboyImage, type MediaSourceDeps, type ResolvedBotboyImage } from '../core/media-sources.js';
import { renderVisuals, type VisualRenderer, type VisualRenderJob } from '../core/visual-render.js';

export type DiagramLanguage = 'mermaid' | 'svg';

export interface DocumentImageRef {
  kind: 'image';
  alt: string;
  src: string;
  /** The title part, quotes included (`"…"`), or ''. */
  title: string;
  line: number;
  /** Character offsets of the whole ![…](…) in the Markdown. */
  start: number;
  end: number;
}

export interface DocumentDiagramRef {
  kind: 'diagram';
  lang: DiagramLanguage;
  source: string;
  line: number;
  /** Character offsets of the whole fenced block (opening fence to closing fence). */
  start: number;
  end: number;
}

export type DocumentMediaRef = DocumentImageRef | DocumentDiagramRef;

const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^<>\n]+>|[^\s()<>]+)(?:\s+("[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const DIAGRAM_LANGUAGES = new Set<string>(['mermaid', 'svg']);

/** Inline code spans become spaces, so an image written as code is not a picture. */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, match => ' '.repeat(match.length));
}

/** Every picture and diagram in a document, in order. Code blocks hold no pictures. */
export function findDocumentMedia(markdown: string): DocumentMediaRef[] {
  const text = String(markdown ?? '');
  const refs: DocumentMediaRef[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let fence: { char: string; length: number; lang: string; start: number; line: number; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        if (DIAGRAM_LANGUAGES.has(fence.lang)) {
          refs.push({ kind: 'diagram', lang: fence.lang as DiagramLanguage, source: fence.body.join('\n'), line: fence.line, start: fence.start, end: lineStart + raw.length });
        }
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length, lang: (open[2].trim().split(/\s+/)[0] ?? '').toLowerCase(), start: lineStart, line: i + 1, body: [] };
      continue;
    }
    const masked = maskInlineCode(line);
    for (const match of masked.matchAll(IMAGE)) {
      const at = match.index ?? 0;
      const original = line.slice(at, at + match[0].length);
      const parsed = new RegExp(IMAGE.source).exec(original);
      if (!parsed) continue;
      refs.push({
        kind: 'image',
        alt: parsed[1],
        src: parsed[2].startsWith('<') ? parsed[2].slice(1, -1).trim() : parsed[2],
        title: parsed[3] ?? '',
        line: i + 1,
        start: lineStart + at,
        end: lineStart + at + match[0].length,
      });
    }
  }
  return refs;
}

/** A diagram's description: its accTitle or title, else "Diagram N". */
export function diagramAlt(ref: DocumentDiagramRef, n: number): string {
  if (ref.lang === 'mermaid') {
    const accessible = /^\s*accTitle\s*:\s*(.+)$/m.exec(ref.source);
    if (accessible) return accessible[1].trim().slice(0, 200);
    const front = /^\s*title\s*:\s*(.+)$/m.exec(ref.source);
    if (front) return front[1].trim().replace(/^["']|["']$/g, '').slice(0, 200);
    const inline = /\btitle\s+"([^"\n]+)"|\btitle\s+([^\n"]+)$/m.exec(ref.source);
    if (inline) return (inline[1] ?? inline[2]).trim().slice(0, 200);
  } else {
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(ref.source);
    if (title) return title[1].trim();
  }
  return `Diagram ${n}`;
}

/** Markdown-safe description text (no brackets that would end the image). */
function altText(text: string): string {
  return String(text ?? '').replace(/[[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface DocumentMediaProblem {
  line: number;
  kind: 'picture' | 'diagram';
  message: string;
  nextAction?: string;
}

export interface DocumentMediaCheck {
  pictures: number;
  diagrams: number;
  /** Pictures the reader shows and every export embeds. */
  shown: number;
  problems: DocumentMediaProblem[];
  /** False when diagrams were not drawn to check them (no Chrome). */
  diagramsChecked: boolean;
}

/**
 * What a save or edit receipt says about a document's pictures and diagrams: each
 * picture is resolved, and each diagram is drawn once (SVG only) so a syntax error
 * is reported now, not at export. Null when the document has neither.
 */
export async function checkDocumentMedia(markdown: string, options: { sources?: Partial<MediaSourceDeps>; render?: VisualRenderer } = {}): Promise<DocumentMediaCheck | null> {
  const refs = findDocumentMedia(markdown);
  if (!refs.length) return null;
  const problems: DocumentMediaProblem[] = [];
  let pictures = 0;
  let shown = 0;
  const jobs: VisualRenderJob[] = [];
  const diagramLines = new Map<string, number>();
  for (const ref of refs) {
    if (ref.kind === 'image') {
      pictures++;
      const resolved = resolveBotboyImage(ref.src, options.sources);
      if (resolved.ok) { shown++; continue; }
      const outside = resolved.code === 'outside_botboy' || resolved.code === 'external';
      problems.push({
        line: ref.line,
        kind: 'picture',
        message: outside ? `${resolved.message} The reader cannot show it and exports keep it only if that source stays reachable.` : `${resolved.message} The reader and exports leave it out.`,
        nextAction: resolved.nextAction,
      });
      continue;
    }
    const id = `d${jobs.length + 1}`;
    jobs.push({ id, kind: ref.lang, source: ref.source });
    diagramLines.set(id, ref.line);
  }
  let diagramsChecked = true;
  if (jobs.length) {
    const results = await (options.render ?? renderVisuals)(jobs, { png: false, timeoutMs: 60_000 });
    for (const job of jobs) {
      const result = results.get(job.id);
      if (result?.ok) continue;
      const error = result && !result.ok ? result.error : 'Not drawn.';
      if (/Google Chrome/.test(error)) { diagramsChecked = false; continue; }
      problems.push({
        line: diagramLines.get(job.id) ?? 0,
        kind: 'diagram',
        message: `This ${job.kind === 'mermaid' ? 'Mermaid' : 'SVG'} diagram does not draw: ${error}`,
        nextAction: 'Fix the block with edit_product_document (the reader shows it as code until it draws).',
      });
    }
  }
  return { pictures, diagrams: jobs.length, shown, problems, diagramsChecked };
}

export interface ExportMediaSummary {
  pictures: number;
  diagrams: number;
  /** Pictures and diagrams now embedded by BotBoy (others are left as written). */
  embedded: number;
  problems: DocumentMediaProblem[];
}

export interface PreparedExportMedia {
  markdown: string;
  /** sha256 of each SVG written into media/ → its PNG, for Word's fallback picture. */
  pngForSvg: Map<string, Buffer>;
  summary: ExportMediaSummary;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Rewrite a document for pandoc in `workDir`: BotBoy's pictures are copied into
 * workDir/media and named by relative path; diagrams are drawn there as SVG; a
 * picture whose file is gone becomes its description in italics (pandoc would
 * otherwise fail the whole HTML and PDF export). Run pandoc with cwd = workDir.
 */
export async function prepareExportMedia(markdown: string, workDir: string, options: { sources?: Partial<MediaSourceDeps>; render?: VisualRenderer } = {}): Promise<PreparedExportMedia> {
  const refs = findDocumentMedia(markdown);
  const summary: ExportMediaSummary = { pictures: 0, diagrams: 0, embedded: 0, problems: [] };
  const pngForSvg = new Map<string, Buffer>();
  if (!refs.length) return { markdown, pngForSvg, summary };
  const mediaDir = path.join(workDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const jobs: VisualRenderJob[] = [];
  /** What to do with each job's drawing once it comes back. */
  const after = new Map<string, (drawn: { ok: true; svg?: string; png?: Buffer } | { ok: false; error: string }) => Promise<void>>();
  let pictureNumber = 0;
  let diagramNumber = 0;

  for (const ref of refs) {
    if (ref.kind === 'image') {
      summary.pictures++;
      const resolved = resolveBotboyImage(ref.src, options.sources);
      const alt = altText(ref.alt);
      if (!resolved.ok) {
        if (resolved.code === 'external' || resolved.code === 'outside_botboy') continue;
        summary.problems.push({ line: ref.line, kind: 'picture', message: `${resolved.message} The export shows its description instead.` });
        replacements.push({ start: ref.start, end: ref.end, text: `*${alt || 'Picture'}*` });
        continue;
      }
      pictureNumber++;
      const bytes = await fs.readFile(resolved.path);
      const image: ResolvedBotboyImage = resolved;
      const stem = `picture-${pictureNumber}`;
      const titled = ref.title ? ` ${ref.title}` : '';
      if (image.type === 'svg' || image.type === 'webp') {
        // An SVG is sized (and drawn for Word's fallback); a WebP becomes a PNG, which Word and Google take.
        const id = `p${pictureNumber}`;
        jobs.push({ id, kind: image.type === 'svg' ? 'svg' : 'image', source: image.type === 'svg' ? bytes.toString('utf8') : `data:image/webp;base64,${bytes.toString('base64')}` });
        const replacementIndex = replacements.push({ start: ref.start, end: ref.end, text: '' }) - 1;
        after.set(id, async drawn => {
          if (image.type === 'svg') {
            const svg = drawn.ok && drawn.svg ? Buffer.from(drawn.svg, 'utf8') : bytes;
            await fs.writeFile(path.join(mediaDir, `${stem}.svg`), svg);
            if (drawn.ok && drawn.png) pngForSvg.set(sha256(svg), drawn.png);
            if (!drawn.ok) summary.problems.push({ line: ref.line, kind: 'picture', message: `This SVG picture could not be drawn for Word: ${drawn.error}` });
            replacements[replacementIndex].text = `![${alt}](media/${stem}.svg${titled})`;
          } else if (drawn.ok && drawn.png) {
            await fs.writeFile(path.join(mediaDir, `${stem}.png`), drawn.png);
            replacements[replacementIndex].text = `![${alt}](media/${stem}.png${titled})`;
          } else {
            await fs.writeFile(path.join(mediaDir, `${stem}.webp`), bytes);
            summary.problems.push({ line: ref.line, kind: 'picture', message: `This WebP picture could not be converted, so Word may not show it: ${drawn.ok ? 'no PNG' : drawn.error}` });
            replacements[replacementIndex].text = `![${alt}](media/${stem}.webp${titled})`;
          }
          summary.embedded++;
        });
        continue;
      }
      await fs.writeFile(path.join(mediaDir, `${stem}.${IMAGE_EXTENSION[image.type]}`), bytes);
      replacements.push({ start: ref.start, end: ref.end, text: `![${alt}](media/${stem}.${IMAGE_EXTENSION[image.type]}${titled})` });
      summary.embedded++;
      continue;
    }
    summary.diagrams++;
    diagramNumber++;
    const id = `d${diagramNumber}`;
    const stem = `diagram-${diagramNumber}`;
    const alt = altText(diagramAlt(ref, diagramNumber));
    jobs.push({ id, kind: ref.lang, source: ref.source });
    const lineRef = ref.line;
    const block = { start: ref.start, end: ref.end };
    after.set(id, async drawn => {
      if (!drawn.ok || !drawn.svg) {
        summary.problems.push({ line: lineRef, kind: 'diagram', message: `This diagram did not draw, so the export shows its source: ${drawn.ok ? 'no drawing' : drawn.error}` });
        return;
      }
      const svg = Buffer.from(drawn.svg, 'utf8');
      await fs.writeFile(path.join(mediaDir, `${stem}.svg`), svg);
      if (drawn.png) pngForSvg.set(sha256(svg), drawn.png);
      // Blank lines around it: the picture is a paragraph of its own whatever surrounds the block.
      replacements.push({ start: block.start, end: block.end, text: `\n![${alt}](media/${stem}.svg)\n` });
      summary.embedded++;
    });
  }

  if (jobs.length) {
    const drawn = await (options.render ?? renderVisuals)(jobs, { scale: 2 });
    for (const job of jobs) {
      await after.get(job.id)?.(drawn.get(job.id) ?? { ok: false, error: 'Not drawn.' });
    }
  }

  let out = markdown;
  for (const replacement of replacements.filter(entry => entry.text !== '' || entry.end === entry.start).sort((a, b) => b.start - a.start)) {
    out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
  }
  return { markdown: out, pngForSvg, summary };
}

export interface DocxPackageParts {
  documentXml: string;
  relsXml: string;
  contentTypesXml: string;
}

const IMAGE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

function attribute(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
}

/**
 * Word draws an SVG picture from `asvg:svgBlip`, which pandoc writes with no picture
 * for readers that cannot draw SVG (older Word, LibreOffice, Google's converter). Each
 * SVG whose PNG we drew gets one: a media part, an image relationship, and the blip's
 * r:embed pointing at it, the way Word itself saves an SVG.
 */
export function addSvgPngFallbacks(
  parts: DocxPackageParts,
  svgByTarget: ReadonlyMap<string, Buffer>,
  pngForSvg: ReadonlyMap<string, Buffer>,
): DocxPackageParts & { files: Array<{ path: string; data: Buffer }>; added: number } {
  const fallbackFor = new Map<string, { id: string; target: string; png: Buffer }>();
  let k = 0;
  for (const tag of parts.relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const target = attribute(tag, 'Target');
    if (attribute(tag, 'Type') !== IMAGE_RELATIONSHIP || !/\.svg$/i.test(target)) continue;
    const svg = svgByTarget.get(target);
    const png = svg ? pngForSvg.get(sha256(svg)) : undefined;
    if (png) fallbackFor.set(attribute(tag, 'Id'), { id: `rIdBotboyPng${++k}`, target: target.replace(/\.svg$/i, '-botboy.png'), png });
  }
  const used = new Map<string, { id: string; target: string; png: Buffer }>();
  // A raster picture's blip is self-closing (<a:blip r:embed="…" />): it must not swallow the next picture's blip.
  const documentXml = parts.documentXml.replace(/<a:blip\b([^>]*?)(\/>|>([\s\S]*?)<\/a:blip>)/g, (whole, attributes: string, close: string, inner: string | undefined) => {
    if (close === '/>' || inner === undefined || /\sr:embed=/.test(attributes)) return whole;
    const svgId = /<asvg:svgBlip\b[^>]*\sr:embed="([^"]+)"/.exec(inner)?.[1];
    const fallback = svgId ? fallbackFor.get(svgId) : undefined;
    if (!fallback) return whole;
    used.set(fallback.id, fallback);
    return `<a:blip r:embed="${fallback.id}"${attributes}>${inner}</a:blip>`;
  });
  // Nothing referenced: the package stays exactly as it was (no dangling parts).
  if (!used.size) return { ...parts, files: [], added: 0 };
  const relationships = [...used.values()].map(entry => `<Relationship Id="${entry.id}" Type="${IMAGE_RELATIONSHIP}" Target="${entry.target}" />`).join('');
  const contentTypesXml = /<Default\s+Extension="png"/i.test(parts.contentTypesXml)
    ? parts.contentTypesXml
    : parts.contentTypesXml.replace('</Types>', '<Default Extension="png" ContentType="image/png" /></Types>');
  return {
    documentXml,
    relsXml: parts.relsXml.replace('</Relationships>', `${relationships}</Relationships>`),
    contentTypesXml,
    files: [...used.values()].map(entry => ({ path: `word/${entry.target}`, data: entry.png })),
    added: used.size,
  };
}
