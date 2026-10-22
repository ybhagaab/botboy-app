import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, LlmClient } from '../core/llm-client.js';
import { createPromptManager } from '../core/prompt-manager.js';
import type { DocumentParser } from '../core/document-parser.js';
import type { ToolExecutionContext, ToolExecutor } from '../core/tool-executor.js';
import { withProductDocumentChatTools } from './chat-tools.js';
import { createContextResolver } from './context-resolver.js';
import { createDocumentValidator } from './document-validator.js';
import { createProductDocumentService } from './document-service.js';
import { DOCUMENT_READ_BUDGET_CHARS } from './document-read.js';
import { createGlossaryResolver } from './glossary-resolver.js';
import { createProductDocumentStore } from './product-document-store.js';
import { createProfileRegistry } from './profile-registry.js';
import { createSteChecker } from './ste-checker.js';
import type { SteBundleLoader } from './types.js';
import { createWritingConfigStore } from './writing-config.js';

/**
 * read_product_document and edit_product_document (owner report 2026-10-21):
 * BotBoy opened its own Documents reader in Chrome to see a document it had
 * saved, and rewrote the whole document for every one-line change.
 */
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

const LAUNCH = [
  '# MX Player S2S launch',
  '',
  'Partner events now arrive from our servers. [c1]',
  '',
  '| Team | Contributors | Contribution |',
  '|---|---|---|',
  '| Data engineering | Zeng Wang | Pipeline |',
  '| Paid marketing | Aditya Singhal | Campaigns [c2] |',
  '',
  'Thanks to everyone who helped.',
].join('\n');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-doc-edit-'));
  cleanup.push(home);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO projects (id, title, status) VALUES ('proj-s2s', 'S2S launch', 'active');
  `);
  const registry = createProfileRegistry();
  const parser: DocumentParser = {
    parse(filePath) { return { success: true, text: fs.readFileSync(filePath, 'utf8'), filePath, fileType: path.extname(filePath) }; },
    getSupportedFormats: () => ['.md', '.txt'],
  };
  const steBundleLoader: SteBundleLoader = {
    load: () => ({ ready: false, available: false, approved: false, path: path.join(home, 'missing.json'), diagnostics: ['absent'] }),
  };
  const calls: ChatCompletionRequest[] = [];
  const llmClient = {
    isAvailable: () => true,
    getActiveModel: () => 'test-model',
    chatCompletion: async (input: ChatCompletionRequest) => {
      calls.push(input);
      return { content: JSON.stringify({ conformant: true, summary: 'Fine.', findings: [] }), toolCalls: null, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'stop' as const };
    },
  } as unknown as LlmClient;
  let clock = Date.parse('2026-10-20T06:00:00.000Z');
  let ids = 0;
  const service = createProductDocumentService({
    llmClient,
    promptManager: createPromptManager(),
    registry,
    configStore: createWritingConfigStore(db, { homeDir: home }),
    contextResolver: createContextResolver(parser, { homeDir: home }),
    glossaryResolver: createGlossaryResolver(),
    validator: createDocumentValidator({ registry, steChecker: createSteChecker(), steBundleLoader }),
    steBundleLoader,
    store: createProductDocumentStore(db),
    resolveProject: (projectId) => db.prepare('SELECT id, title, status FROM projects WHERE id = ?').get(projectId) as any ?? null,
    now: () => new Date((clock += 60_000)),
    createArtifactId: () => `art-${String(++ids).padStart(3, '0')}`,
  });
  const base: ToolExecutor = { executeTool: vi.fn(async (call) => ({ toolCallId: call.id, content: `base ${call.function.name}`, isError: false })) };
  const tools = withProductDocumentChatTools(base, service);
  const owner: ToolExecutionContext = { callerKind: 'interactive', currentUserMessage: 'remove the contribution column' };
  const run = async (name: string, args: Record<string, unknown>) => {
    const outcome = await tools.executeTool({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, owner);
    let body: any = null;
    try { body = JSON.parse(outcome.content); } catch { /* a pass-through tool's plain text */ }
    return { ...outcome, body };
  };
  return { db, service, calls, run, base };
}

async function savedLaunch(f: ReturnType<typeof fixture>) {
  const saved = await f.service.saveAuthoredDocument({
    projectId: 'proj-s2s',
    title: 'MX Player S2S launch email',
    content: LAUNCH,
    profileId: 'communication/email.v1',
    maturity: 'alignment',
    citations: [
      { id: 'c1', label: 'Wei Zhuo Slack feedback', source: 'slack', date: '2026-10-20' },
      { id: 'c2', label: 'Marketing launch thread', source: 'email' },
      { id: 'c9', label: 'Never placed in the text' },
    ],
  });
  f.calls.length = 0;
  return saved;
}

describe('read_product_document', () => {
  it('reads a version as numbered lines with its version, project, and the citations its lines use', async () => {
    const f = fixture();
    const saved = await savedLaunch(f);
    const { body, isError } = await f.run('read_product_document', { artifactId: `#/documents/${saved.artifactId}` });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      ok: true,
      artifactId: saved.artifactId,
      title: 'MX Player S2S launch email',
      documentsUrl: `#/documents/${saved.artifactId}`,
      projectId: 'proj-s2s',
      profileId: 'communication/email.v1',
      maturity: 'alignment',
      version: { number: 1, of: 1, newest: true },
      totalLines: 10,
      startLine: 1,
      endLine: 10,
      nextStartLine: null,
      readNote: 'Lines 1–10 of 10: the whole document.',
      citationCount: 3,
      citations: [
        { id: 'c1', label: 'Wei Zhuo Slack feedback', source: 'slack', date: '2026-10-20' },
        { id: 'c2', label: 'Marketing launch thread', source: 'email' },
      ],
    });
    expect(body.lines).toBe(LAUNCH.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n'));
    expect(body.editHint).toMatch(/edit_product_document with this artifactId/);
    // A range, and the citations of that range only.
    const range = (await f.run('read_product_document', { artifactId: saved.artifactId, startLine: 5, endLine: 8 })).body;
    expect(range).toMatchObject({ startLine: 5, endLine: 8, nextStartLine: 9, readNote: 'Lines 5–8 of 10. Read on with startLine 9.', citations: [{ id: 'c2' }] });
    expect(range.lines.split('\n')[0]).toBe('5: | Team | Contributors | Contribution |');
    expect((await f.run('read_product_document', { artifactId: saved.artifactId, startLine: 11 })).body)
      .toMatchObject({ ok: false, error: 'startLine 11 is past the end: this version has 10 lines.' });
    expect((await f.run('read_product_document', { artifactId: saved.artifactId, startLine: 0 })).body)
      .toMatchObject({ ok: false, error: 'startLine and endLine must be whole numbers, 1 or more.' });
    expect((await f.run('read_product_document', { artifactId: 'art-404' })).body)
      .toMatchObject({ ok: false, code: 'not_found', nextAction: expect.stringMatching(/without artifactId, with words from the title/) });
  });

  it('reads a long document in parts that join back exactly, never cut silently, and a giant line cut with a note', async () => {
    const f = fixture();
    const rows = Array.from({ length: 1_400 }, (_, index) => `| Title ${index + 1} | Episode ${index % 40 + 1} | “quoted” ✓ 😀 |`);
    const content = ['# India playback titles', '', ...rows, '', `![chart](data:image/png;base64,${'A'.repeat(60_000)})`, 'End.'].join('\n');
    const saved = await f.service.saveAuthoredDocument({ unassigned: true, title: 'India playback titles', content });
    let startLine = 1;
    const joined: string[] = [];
    let parts = 0;
    for (;;) {
      const outcome = await f.run('read_product_document', { artifactId: saved.artifactId, startLine });
      expect(outcome.content.length).toBeLessThanOrEqual(DOCUMENT_READ_BUDGET_CHARS);
      const part = outcome.body;
      parts += 1;
      const lines = part.lines.split('\n');
      if (part.lineCut) {
        expect(part.lineCut).toMatchObject({ line: startLine, chars: 60_000 + '![chart](data:image/png;base64,)'.length });
        expect(part.lineCut.note).toMatch(/longer than one read; only its start is shown/);
        joined.push(content.split('\n')[startLine - 1]);
      } else {
        lines.forEach((line: string, offset: number) => {
          expect(line.startsWith(`${startLine + offset}: `)).toBe(true);
          joined.push(line.slice(`${startLine + offset}: `.length));
        });
      }
      if (part.nextStartLine === null) {
        expect(part.readNote).toMatch(/This is the end of the document\.$/);
        break;
      }
      expect(part.readNote).toMatch(new RegExp(`Read on with startLine ${part.nextStartLine}\\.$`));
      startLine = part.nextStartLine;
      expect(parts).toBeLessThan(20);
    }
    expect(parts).toBeGreaterThan(2);
    expect(joined.join('\n')).toBe(content);
  });

  it('lists recent documents by title words, each with its newest version', async () => {
    const f = fixture();
    const first = await savedLaunch(f);
    const second = await f.service.saveAuthoredDocument({ parentArtifactId: first.artifactId, title: 'MX Player S2S launch email', content: `${LAUNCH}\n\nP.S.` });
    await f.service.saveAuthoredDocument({ unassigned: true, title: 'India playback titles', content: '# Titles' });
    const listed = (await f.run('read_product_document', { query: 'S2S launch' })).body;
    expect(listed).toMatchObject({
      ok: true,
      mode: 'list',
      query: 'S2S launch',
      matched: 1,
      documents: [{ title: 'MX Player S2S launch email', newestArtifactId: second.artifactId, versions: 2, projectId: 'proj-s2s', documentsUrl: `#/documents/${second.artifactId}` }],
    });
    expect((await f.run('read_product_document', {})).body.documents.map((document: any) => document.title))
      .toEqual(['India playback titles', 'MX Player S2S launch email']);
    expect((await f.run('read_product_document', { query: 'budget memo' })).body).toMatchObject({ matched: 0, documents: [], note: expect.stringMatching(/Try other title words/) });
    // An older version says which one is newest.
    expect((await f.run('read_product_document', { artifactId: first.artifactId })).body).toMatchObject({
      version: { number: 1, of: 2, newest: false, newestArtifactId: second.artifactId },
      editHint: `This is not the newest version: edit_product_document needs the newest, ${second.artifactId}.`,
    });
  });
});

describe('edit_product_document', () => {
  it('saves exact replacements as the next version, keeping everything else, and runs no model review', async () => {
    const f = fixture();
    const saved = await savedLaunch(f);
    const outcome = await f.run('edit_product_document', {
      artifactId: saved.artifactId,
      ownerRequested: true,
      edits: [
        { find: '| Team | Contributors | Contribution |\n|---|---|---|', replace: '| Team | Contributors |\n|---|---|' },
        { find: '| Data engineering | Zeng Wang | Pipeline |', replace: '| Data engineering | Zeng Wang |' },
        { find: '| Paid marketing | Aditya Singhal | Campaigns [c2] |', replace: '| Marketing | Aditya Singhal, Meghna [c3] |' },
      ],
      citations: [{ id: 'c3', label: 'Phone Tool aliases', source: 'web', url: 'https://phonetool.example/aliases' }],
    });
    expect(outcome.isError).toBe(false);
    const edited = f.service.getArtifact(outcome.body.artifactId)!;
    const expected = LAUNCH
      .replace('| Team | Contributors | Contribution |\n|---|---|---|', '| Team | Contributors |\n|---|---|')
      .replace('| Data engineering | Zeng Wang | Pipeline |', '| Data engineering | Zeng Wang |')
      .replace('| Paid marketing | Aditya Singhal | Campaigns [c2] |', '| Marketing | Aditya Singhal, Meghna [c3] |');
    expect(edited.content).toBe(expected);
    expect(edited).toMatchObject({
      parentArtifactId: saved.artifactId,
      projectId: 'proj-s2s',
      profileId: 'communication/email.v1',
      maturity: 'alignment',
      title: 'MX Player S2S launch email',
      revisionOrigin: 'chat_authored',
      state: 'ready_for_review',
      conformanceReview: { status: 'unavailable', correctionApplied: false, summary: expect.stringMatching(/^Not run for this version: it is a targeted edit/) },
    });
    // c2 lost its last marker and left with it; c9 was never placed, so it stays; c3 is new.
    expect(edited.citations?.map((citation) => citation.id)).toEqual(['c1', 'c9', 'c3']);
    expect(f.calls).toHaveLength(0);
    expect(outcome.body).toMatchObject({
      ok: true,
      persisted: true,
      parentArtifactId: saved.artifactId,
      version: { number: 2, of: 2 },
      editsApplied: 3,
      changes: [
        { edit: 0, line: 5, lineText: '| Team | Contributors |\n|---|---|' },
        { edit: 1, line: 7, lineText: '| Data engineering | Zeng Wang |' },
        { edit: 2, line: 8, lineText: '| Marketing | Aditya Singhal, Meghna [c3] |' },
      ],
      totalLines: 10,
      contentChars: expected.length,
      charsChanged: expected.length - LAUNCH.length,
      citationsAdded: ['c3'],
      citationsDropped: ['c2'],
      documentsUrl: `#/documents/${outcome.body.artifactId}`,
      conformance: expect.stringMatching(/^Not run: a targeted edit gets the quick advisory checks only/),
      next: expect.stringMatching(/^Saved as version 2 of 2\. Link the owner to #\/documents\//),
    });
    expect(outcome.body.validationStatus).toBeDefined();
    expect(f.service.getVersionChain(saved.artifactId).map((member) => member.artifactId)).toEqual([outcome.body.artifactId, saved.artifactId]);
  });

  it('refuses an older version, a missing or repeated find, an unchanged result and no owner request, and saves nothing', async () => {
    const f = fixture();
    const saved = await savedLaunch(f);
    const next = (await f.run('edit_product_document', { artifactId: saved.artifactId, ownerRequested: true, edits: [{ find: 'Thanks to everyone who helped.', replace: 'Thank you all.' }] })).body;
    const count = () => Number((f.db.prepare('SELECT COUNT(*) AS n FROM product_document_artifacts').get() as any).n);
    const before = count();
    const refusals: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ artifactId: saved.artifactId, edits: [{ find: 'Partner', replace: 'Our partner' }] },
        { code: 'not_newest', newestArtifactId: next.artifactId, nextAction: `Read ${next.artifactId} with read_product_document, then send the edits against its text. Nothing was saved.` }],
      [{ artifactId: next.artifactId, edits: [{ find: 'Thanks to everyone who helped.', replace: 'x' }] },
        { code: 'edit_not_found', index: 0, error: `edits[0].find does not occur in version ${next.artifactId}.`, nextAction: expect.stringMatching(/^Read the document again with read_product_document and copy edits\[0\]\.find exactly/) }],
      [{ artifactId: next.artifactId, edits: [{ find: ' | ', replace: ' / ' }] }, { code: 'edit_not_unique', index: 0, nextAction: expect.stringMatching(/^Make edits\[0\]\.find longer/) }],
      [{ artifactId: next.artifactId, edits: [{ find: 'Thank you all.', replace: 'Thank you all.' }] }, { code: 'no_change' }],
      [{ artifactId: next.artifactId, edits: [] }, { code: 'invalid_edits' }],
      [{ artifactId: next.artifactId, edits: [{ find: LAUNCH.slice(0, 20), replace: '' }, { find: 'x'.repeat(5), replace: '' }] }, { code: 'edit_not_found', index: 1 }],
      [{ artifactId: 'art-404', edits: [{ find: 'a', replace: 'b' }] }, { code: 'not_found' }],
      [{ artifactId: next.artifactId, title: '   ', edits: [{ find: 'Thank you all.', replace: 'Thanks.' }] }, { code: 'invalid_input' }],
    ];
    for (const [args, expected] of refusals) {
      const outcome = await f.run('edit_product_document', { ownerRequested: true, ...args });
      expect(outcome.isError, JSON.stringify(args).slice(0, 120)).toBe(true);
      expect(outcome.body, JSON.stringify(args).slice(0, 120)).toMatchObject({ ok: false, persisted: false, ...expected });
    }
    const noOwner = await f.run('edit_product_document', { artifactId: next.artifactId, edits: [{ find: 'Thank you all.', replace: 'Thanks.' }] });
    expect(noOwner.body).toMatchObject({ ok: false, error: expect.stringMatching(/^ownerRequested must be true/) });
    expect(count()).toBe(before);
    // Deleting a whole document is the owner's, on the Documents page.
    expect((await f.run('edit_product_document', { artifactId: next.artifactId, ownerRequested: true, edits: [{ find: f.service.getArtifact(next.artifactId)!.content, replace: '  ' }] })).body)
      .toMatchObject({ code: 'invalid_edits', error: 'The edits would leave the document empty.' });
  });

  it('runs the quick checks on the new text, and refuses a document over the size or citation limit', async () => {
    const f = fixture();
    const saved = await savedLaunch(f);
    const edited = (await f.run('edit_product_document', { artifactId: saved.artifactId, ownerRequested: true, edits: [{ find: 'Thanks to everyone who helped.', replace: 'Thank you all.' }] })).body;
    const artifact = f.service.getArtifact(edited.artifactId)!;
    expect(artifact.validation.status).not.toBe('not_checked');
    expect(edited.validationStatus).toBe(artifact.validation.status);

    const big = await f.service.saveAuthoredDocument({ unassigned: true, title: 'Big', content: `# Big\n${'x'.repeat(399_980)}\nEND` });
    expect((await f.run('edit_product_document', { artifactId: big.artifactId, ownerRequested: true, edits: [{ find: 'END', replace: 'END'.repeat(20) }] })).body)
      .toMatchObject({ code: 'too_large', error: expect.stringMatching(/the limit is 400,000/) });

    const cited = await f.service.saveAuthoredDocument({
      unassigned: true,
      title: 'Cited',
      content: `# Cited\n${Array.from({ length: 50 }, (_, index) => `Fact ${index}. [c${index}]`).join('\n')}`,
      citations: Array.from({ length: 50 }, (_, index) => ({ id: `c${index}`, label: `Source ${index}` })),
    });
    expect(cited.citations).toHaveLength(50);
    expect((await f.run('edit_product_document', {
      artifactId: cited.artifactId,
      ownerRequested: true,
      edits: [{ find: 'Fact 49. [c49]', replace: 'Fact 49. [c49] [c50]' }],
      citations: [{ id: 'c50', label: 'One more source' }],
    })).body).toMatchObject({ code: 'too_many_citations', nextAction: expect.stringMatching(/Reuse an existing citation id/) });
  });

  it('reports only the markers the edit added without a citation, not ones the document already had', async () => {
    const f = fixture();
    const legacy = await f.service.saveAuthoredDocument({ unassigned: true, title: 'Legacy', content: '# Legacy\nOld claim. [c7]\nNew claim here.' });
    const edited = (await f.run('edit_product_document', { artifactId: legacy.artifactId, ownerRequested: true, edits: [{ find: 'New claim here.', replace: 'New claim here. [c4]' }] })).body;
    expect(edited.markersWithoutCitation).toEqual(['c4']);
  });

  it('renames, reports markers that have no citation, and is offered beside save in the chat tools', async () => {
    const f = fixture();
    const saved = await savedLaunch(f);
    const outcome = await f.run('edit_product_document', {
      artifactId: saved.artifactId,
      ownerRequested: true,
      title: 'MX Player S2S launch: final email',
      edits: [{ find: 'Thanks to everyone who helped.', replace: 'Telemetry guidance from Jared and Asher. [c4]' }],
    });
    expect(outcome.body).toMatchObject({
      title: 'MX Player S2S launch: final email',
      previousTitle: 'MX Player S2S launch email',
      markersWithoutCitation: ['c4'],
      markersNote: expect.stringMatching(/no citation, so the reader shows them as plain text/),
    });
    // A pasted reader link works as the id, and other tools pass through to the base executor.
    expect((await f.run('read_product_document', { artifactId: `/documents/${encodeURIComponent(outcome.body.artifactId)}` })).body.version).toMatchObject({ number: 2, newest: true });
    expect((await f.run('get_today', {}))).toMatchObject({ content: 'base get_today' });
    const names = createPromptManager().getToolDefinitions('chat').map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining(['save_product_document', 'read_product_document', 'edit_product_document', 'write_file', 'read_file', 'edit_file']));
  });
});
