import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureMediaSources } from '../core/media-sources.js';
import { exportDocument, markdownToWordForGoogle } from './document-exporter.js';

// Real pandoc and Chrome, as an owner's Mac has them; skipped where either is missing.
function found(candidates: string[]): boolean {
  return candidates.some(candidate => {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  });
}
const tools = found(['pandoc', path.join(os.homedir(), 'homebrew/bin/pandoc'), '/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc'])
  && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const ICON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'botboy_icon_192.png');
const PNG = fs.existsSync(ICON) ? fs.readFileSync(ICON) : null;

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'export-media-'));
  const home = path.join(tmp, 'home');
  const filesDir = path.join(home, '.personal-productivity-tracker', 'files');
  fs.mkdirSync(path.join(filesDir, 'shots'), { recursive: true });
  // A real PNG: the renderer draws one from an SVG when the repository has no icon to borrow.
  if (PNG) fs.writeFileSync(path.join(filesDir, 'shots', 'screen.png'), PNG);
  fs.writeFileSync(path.join(filesDir, 'shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="10" y="10" width="180" height="80" rx="12" fill="#2a6fdb"/><text x="100" y="58" font-size="22" text-anchor="middle" fill="#fff">Shape</text></svg>');
  configureMediaSources({ homeDir: home, filesDir, attachmentsDir: path.join(home, '.personal-productivity-tracker', 'chat-attachments') });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CONTENT = [
  '# Release plan',
  '',
  PNG ? '![Screen](/api/files/shots/screen.png)' : '',
  '',
  '![Blue shape](shape.svg)',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Draft] --> B{Review}',
  '  B -->|ok| C[Publish]',
  '```',
  'A missing one: ![Gone](/api/files/gone.png).',
].join('\n');

function zipNames(file: string): string[] {
  return execFileSync('/usr/bin/unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function zipText(file: string, member: string): string {
  return execFileSync('/usr/bin/unzip', ['-p', file, member], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

describe.skipIf(!tools)('exports with pictures and diagrams (real pandoc and Chrome)', () => {
  it('Word embeds every picture, and each SVG (the diagram too) carries a PNG for readers that cannot draw SVG', async () => {
    const out = await exportDocument({ title: 'Release plan', content: CONTENT, format: 'docx' });
    const file = path.join(tmp, 'out.docx');
    fs.writeFileSync(file, out.data);
    const media = zipNames(file).filter(name => name.startsWith('word/media/') && !name.endsWith('/'));
    expect(media.filter(name => name.endsWith('.svg'))).toHaveLength(2);
    expect(media.filter(name => name.endsWith('-botboy.png'))).toHaveLength(2);
    if (PNG) expect(media.filter(name => name.endsWith('.png') && !name.endsWith('-botboy.png'))).toHaveLength(1);
    const document = zipText(file, 'word/document.xml');
    expect(document.match(/<a:blip r:embed="rIdBotboyPng\d+">/g)).toHaveLength(2);
    expect(document).not.toMatch(/<a:blip>/);
    // Pandoc names pictures by their source: only the export folder's relative names, never a path on this Mac.
    expect(document).not.toContain(tmp);
    expect(document).toContain('Gone');
    expect(out.media).toMatchObject({ pictures: PNG ? 3 : 2, diagrams: 1, embedded: PNG ? 3 : 2 });
    expect(out.media!.problems).toHaveLength(1);
  }, 120_000);

  it('HTML and PDF embed them too, and a missing picture no longer fails the export', async () => {
    const html = await exportDocument({ title: 'Release plan', content: CONTENT, format: 'html' });
    const text = html.data.toString('utf8');
    expect(text.match(/src="data:image\/svg\+xml;base64,/g)).toHaveLength(2);
    if (PNG) expect(text).toContain('src="data:image/png;base64,');
    expect(text).toContain('<em>Gone</em>');
    const pdf = await exportDocument({ title: 'Release plan', content: CONTENT, format: 'pdf' });
    expect(pdf.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.media).toMatchObject({ diagrams: 1 });
  }, 120_000);

  it('a Word file for Google has the pictures without BotBoy’s house style; plain Markdown gets none', async () => {
    const word = await markdownToWordForGoogle(CONTENT);
    expect(word).not.toBeNull();
    const file = path.join(tmp, 'google.docx');
    fs.writeFileSync(file, word!.data);
    expect(zipNames(file).filter(name => name.endsWith('-botboy.png'))).toHaveLength(2);
    expect(zipText(file, 'word/document.xml')).not.toContain('<w:lnNumType');
    expect(await markdownToWordForGoogle('# No pictures\n\nJust words.')).toBeNull();
  }, 120_000);
});
