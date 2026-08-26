import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  replaceTextInDocumentXml,
  appendParagraphsToDocumentXml,
  readZipEntry,
  replaceZipEntry,
  DOCUMENT_XML_ENTRY,
} from './docx-body-editor.js';

/**
 * Surgical docx body editing (sharepoint-writes R4). The replace transform
 * must survive Word's run-splitting (one visual sentence scattered across
 * many <w:t> nodes) and the zip rewrite must leave every other archive
 * entry byte-identical — that is what keeps comments and styles alive.
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
const XML_TAIL = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>';

function doc(...paragraphs: string[]): string {
  return XML_HEAD + paragraphs.join('') + XML_TAIL;
}
function p(...runs: string[]): string {
  return `<w:p>${runs.join('')}</w:p>`;
}
function r(text: string, props = ''): string {
  return `<w:r>${props}<w:t>${text}</w:t></w:r>`;
}

describe('replaceTextInDocumentXml', () => {
  it('replaces a passage inside a single run', () => {
    const xml = doc(p(r('The rollout starts in EU next quarter.')));
    const result = replaceTextInDocumentXml(xml, 'starts in EU', 'starts in NA');
    expect(result.status).toBe('replaced');
    expect(result.xml).toContain('The rollout starts in NA next quarter.');
    expect(result.xml).not.toContain('starts in EU');
  });

  it('replaces a passage SPLIT across runs, inheriting the first run formatting and keeping tails', () => {
    // Word-style split: "The rollout " | "starts in " | "EU next" | " quarter."
    const xml = doc(p(
      r('The rollout '),
      r('starts in ', '<w:rPr><w:b/></w:rPr>'),
      r('EU next'),
      r(' quarter.'),
    ));
    const result = replaceTextInDocumentXml(xml, 'starts in EU', 'begins in NA');
    expect(result.status).toBe('replaced');
    // First matched run carries the replacement; bold formatting survives.
    expect(result.xml).toContain('<w:rPr><w:b/></w:rPr>');
    expect(result.xml).toContain('begins in NA');
    // The matched tail run keeps its unmatched suffix (" next").
    const texts = [...result.xml!.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]);
    expect(texts.join('')).toBe('The rollout begins in NA next quarter.');
  });

  it('decodes entities for matching and re-encodes the replacement', () => {
    const xml = doc(p(r('Catalog &amp; Backend teams align.')));
    const result = replaceTextInDocumentXml(xml, 'Catalog & Backend', 'Catalog & Search <v2>');
    expect(result.status).toBe('replaced');
    expect(result.xml).toContain('Catalog &amp; Search &lt;v2&gt;');
    expect(result.xml).not.toContain('<v2>');
  });

  it('reports not_found and ambiguous without producing xml', () => {
    const xml = doc(
      p(r('The plan ships this week.')),
      p(r('The plan ships this week.')),
    );
    expect(replaceTextInDocumentXml(xml, 'no such passage', 'x').status).toBe('not_found');
    const dup = replaceTextInDocumentXml(xml, 'The plan ships', 'x');
    expect(dup.status).toBe('ambiguous');
    expect(dup.occurrences).toBe(2);
    expect(dup.xml).toBeUndefined();
  });

  it('marks modified text nodes xml:space="preserve" so spliced spaces survive Word', () => {
    const xml = doc(p(r('alpha '), r('beta gamma'), r(' delta')));
    const result = replaceTextInDocumentXml(xml, 'beta gamma delta', 'omega');
    expect(result.status).toBe('replaced');
    expect(result.xml).toMatch(/<w:t xml:space="preserve">/);
    const texts = [...result.xml!.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]);
    expect(texts.join('')).toBe('alpha omega');
  });
});

describe('appendParagraphsToDocumentXml', () => {
  it('inserts before the trailing sectPr and escapes content', () => {
    const xml = doc(p(r('Existing.')));
    const out = appendParagraphsToDocumentXml(xml, ['Notes <from> BotBoy & co.']);
    const sectAt = out.indexOf('<w:sectPr');
    const addedAt = out.indexOf('Notes &lt;from&gt; BotBoy &amp; co.');
    expect(addedAt).toBeGreaterThan(-1);
    expect(addedAt).toBeLessThan(sectAt);
  });

  it('throws on a non-body document rather than corrupting it', () => {
    expect(() => appendParagraphsToDocumentXml('<xml>not word</xml>', ['x'])).toThrow(/w:body/);
  });
});

describe('extractCommentAnchors', () => {
  it('recovers each comment range passage across split runs and paragraphs, entity-decoded and capped', async () => {
    const { extractCommentAnchors } = await import('./docx-body-editor.js');
    const xml = doc(
      `<w:p><w:commentRangeStart w:id="1"/>${r('The rollout ')}${r('starts in EU')}<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>${r(' next quarter.')}</w:p>`,
      `<w:p><w:commentRangeStart w:id="7"/>${r('Catalog &amp; Backend align')}</w:p>`,
      `<w:p>${r(' across teams.')}<w:commentRangeEnd w:id="7"/></w:p>`,
    );
    const anchors = extractCommentAnchors(xml);
    expect(anchors.get('1')).toBe('The rollout starts in EU');
    expect(anchors.get('7')).toBe('Catalog & Backend align across teams.');
    expect(anchors.has('99')).toBe(false);

    const long = doc(`<w:p><w:commentRangeStart w:id="2"/>${r('x'.repeat(400))}<w:commentRangeEnd w:id="2"/></w:p>`);
    expect(extractCommentAnchors(long).get('2')!.length).toBeLessThanOrEqual(161); // cap + ellipsis
  });
});

describe('applyDocxBodyEdits (shared apply core, workbench R3.5)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-apply-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  function buildDocx(bodyXml: string): string {
    const src = path.join(dir, `src-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(path.join(src, 'word'), { recursive: true });
    writeFileSync(path.join(src, '[Content_Types].xml'), '<Types/>');
    writeFileSync(path.join(src, 'word', 'document.xml'), bodyXml);
    writeFileSync(path.join(src, 'word', 'comments.xml'), '<w:comments>keep</w:comments>');
    const zipPath = path.join(src, 'fixture.docx');
    execFileSync('zip', ['-X', '-q', '-r', zipPath, '.'], { cwd: src });
    return zipPath;
  }

  function fakeManager(fixture: string, readBack: () => string) {
    const calls: Array<{ tool: string; args: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const uploaded: { path?: string } = {};
    const manager = {
      callTool: async (_id: string, tool: string, args: Record<string, unknown>, options: Record<string, unknown> = {}) => {
        calls.push({ tool, args, options });
        if (tool === 'sharepoint_read_file' && args.savePath) {
          const { copyFileSync } = await import('fs');
          copyFileSync(fixture, String(args.savePath));
          return { text: '{}', isError: false };
        }
        if (tool === 'sharepoint_read_file') return { text: readBack(), isError: false };
        if (tool === 'sharepoint_write_file') {
          const { copyFileSync } = await import('fs');
          const snapshot = path.join(dir, 'uploaded.docx');
          copyFileSync(String(args.sourcePath), snapshot);
          uploaded.path = snapshot;
          return { text: '{"saved":true}', isError: false };
        }
        throw new Error(`unexpected ${tool}`);
      },
    };
    return { manager: manager as never, calls, uploaded };
  }

  it('applies multiple edits sequentially in ONE upload; conflicts isolate per edit', async () => {
    const { applyDocxBodyEdits } = await import('./docx-body-editor.js');
    const fixture = buildDocx(doc(
      p(r('The rollout starts in EU next quarter.')),
      p(r('Owners confirm readiness before launch.')),
    ));
    const { manager, calls, uploaded } = fakeManager(fixture, () => 'The rollout begins in NA in Q1. Owners confirm readiness before launch, sign-off recorded. Appendix: decisions.');
    const result = await applyDocxBodyEdits(manager, { serverRelativeUrl: '/personal/u_amazon_com/Documents/T/a.docx' }, [
      { id: 'e1', operation: 'replaceText', findText: 'starts in EU next quarter', replaceWith: 'begins in NA in Q1' },
      { id: 'e2', operation: 'replaceText', findText: 'a passage that does not exist anywhere', replaceWith: 'x' },
      { id: 'e3', operation: 'replaceText', findText: 'confirm readiness before launch.', replaceWith: 'confirm readiness before launch, sign-off recorded.' },
      { id: 'e4', operation: 'appendParagraphs', paragraphs: ['Appendix: decisions.'] },
    ]);
    expect(result.uploaded).toBe(true);
    expect(result.verifiedOnReadBack).toBe(true);
    expect(result.perEdit).toEqual([
      { id: 'e1', applied: true },
      { id: 'e2', applied: false, reason: expect.stringMatching(/not found/) },
      { id: 'e3', applied: true },
      { id: 'e4', applied: true },
    ]);
    // Exactly ONE upload, carrying the guided waiver.
    const writes = calls.filter(c => c.tool === 'sharepoint_write_file');
    expect(writes).toHaveLength(1);
    expect(writes[0].options.guidedFlow).toBe(true);
    expect(writes[0].options.ownerApproved).toBe(true);
    // All three applied edits are in the uploaded archive; comments intact.
    const xml = execFileSync('unzip', ['-p', uploaded.path!, 'word/document.xml']).toString('utf8');
    expect(xml).toContain('begins in NA in Q1');
    expect(xml).toContain('sign-off recorded');
    expect(xml).toContain('Appendix: decisions.');
    expect(execFileSync('unzip', ['-p', uploaded.path!, 'word/comments.xml']).toString('utf8')).toBe('<w:comments>keep</w:comments>');
  });

  it('uploads NOTHING when every edit conflicts', async () => {
    const { applyDocxBodyEdits } = await import('./docx-body-editor.js');
    const fixture = buildDocx(doc(p(r('Only sentence here.'))));
    const { manager, calls } = fakeManager(fixture, () => '');
    const result = await applyDocxBodyEdits(manager, { serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx' }, [
      { id: 'e1', operation: 'replaceText', findText: 'text that vanished from the document', replaceWith: 'x' },
    ]);
    expect(result.uploaded).toBe(false);
    expect(result.perEdit[0].applied).toBe(false);
    expect(calls.filter(c => c.tool === 'sharepoint_write_file')).toHaveLength(0);
  });

  it('surfaces download failures without touching per-edit state', async () => {
    const { applyDocxBodyEdits } = await import('./docx-body-editor.js');
    const manager = {
      callTool: async () => ({ text: 'Error: Silent authorize did not return a code', isError: true }),
    } as never;
    const result = await applyDocxBodyEdits(manager, { serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx' }, [
      { id: 'e1', operation: 'replaceText', findText: 'anything at all in this document', replaceWith: 'x' },
    ]);
    expect(result.uploaded).toBe(false);
    expect(result.error).toMatch(/could not download/);
    expect(result.perEdit).toEqual([]);
  });
});

describe('zip entry replacement (system zip/unzip)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-docx-edit-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('rewrites only word/document.xml — comments and other entries stay byte-identical', async () => {
    // Build a real docx-shaped zip with a comments entry and media.
    const src = path.join(dir, 'src');
    mkdirSync(path.join(src, 'word', 'media'), { recursive: true });
    writeFileSync(path.join(src, '[Content_Types].xml'), '<Types/>');
    writeFileSync(path.join(src, 'word', 'document.xml'), doc(p(r('The rollout starts in EU next quarter.'))));
    const commentsXml = '<w:comments><w:comment w:id="1" w:author="Ng, Hui Jun">keep me intact</w:comment></w:comments>';
    writeFileSync(path.join(src, 'word', 'comments.xml'), commentsXml);
    writeFileSync(path.join(src, 'word', 'media', 'image1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const zipPath = path.join(dir, 'target.docx');
    execFileSync('zip', ['-X', '-q', '-r', zipPath, '.'], { cwd: src });

    const xml = await readZipEntry(zipPath, DOCUMENT_XML_ENTRY);
    const replaced = replaceTextInDocumentXml(xml, 'starts in EU', 'starts in NA');
    expect(replaced.status).toBe('replaced');
    await replaceZipEntry(zipPath, DOCUMENT_XML_ENTRY, replaced.xml!);

    expect(await readZipEntry(zipPath, DOCUMENT_XML_ENTRY)).toContain('starts in NA');
    expect(await readZipEntry(zipPath, 'word/comments.xml')).toBe(commentsXml);
    const media = execFileSync('unzip', ['-p', zipPath, 'word/media/image1.png']);
    expect(Buffer.compare(media, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))).toBe(0);
  });
});

/**
 * Markdown → docx builder (authoring-bridge A2): the generated package must
 * be a structurally valid zip whose document.xml carries the content with
 * the promised degradations (lists as prefixed paragraphs, tables as text
 * rows). unzip -t is the package-validity gate; Word Online is the live one.
 */
describe('buildDocxFromMarkdown', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  async function build(markdown: string) {
    const { buildDocxFromMarkdown } = await import('./docx-body-editor.js');
    const built = await buildDocxFromMarkdown(markdown);
    tempDirs.push(built.tempDir);
    return built;
  }

  it('builds a valid package whose document.xml carries headings, inline formatting, lists, and degraded tables', async () => {
    const { filePath } = await build([
      '# Rollout Plan',
      '',
      'The **EU storefront** moves first, with *phased* validation.',
      '',
      '- catalog sync',
      '- merchandising',
      '',
      '1. freeze schema',
      '2. dual-write',
      '',
      '| Phase | Owner |',
      '| --- | --- |',
      '| One | AB |',
    ].join('\n'));

    // Package validity: unzip agrees it is a well-formed archive.
    execFileSync('unzip', ['-t', '-q', filePath]);
    const xml = await readZipEntry(filePath, DOCUMENT_XML_ENTRY);
    expect(xml).toContain('<w:body>');
    // Heading: bold + sized runs.
    expect(xml).toMatch(/<w:b\/>.*Rollout Plan/s);
    expect(xml).toContain('<w:sz w:val="40"/>');
    // Inline bold/italic split into distinct runs.
    expect(xml).toMatch(/<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">EU storefront<\/w:t>/);
    expect(xml).toMatch(/<w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">phased<\/w:t>/);
    // Lists as literal prefixes; ordered keeps its number.
    expect(xml).toContain('• catalog sync');
    expect(xml).toContain('1. freeze schema');
    // Table rows degrade to joined text; the separator row vanishes.
    expect(xml).toContain('Phase — Owner');
    expect(xml).not.toContain('---');
    // Trailing sectPr stays last so Word accepts the body.
    expect(xml).toMatch(/<w:sectPr\/><\/w:body>/);
  });

  it('multi-line plain blocks join into one paragraph; empty input yields a valid single-space doc', async () => {
    const { filePath } = await build('line one\nline two continues the paragraph');
    const xml = await readZipEntry(filePath, DOCUMENT_XML_ENTRY);
    expect(xml).toContain('line one line two continues the paragraph');

    const empty = await build('');
    const emptyXml = await readZipEntry(empty.filePath, DOCUMENT_XML_ENTRY);
    expect(emptyXml).toContain('<w:t xml:space="preserve"> </w:t>');
  });

  it('escapes XML-hostile characters in content', async () => {
    const { filePath } = await build('Ampersand & angle <brackets> stay literal.');
    const xml = await readZipEntry(filePath, DOCUMENT_XML_ENTRY);
    expect(xml).toContain('Ampersand &amp; angle &lt;brackets&gt; stay literal.');
  });
});
