import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor, type ToolExecutor } from './tool-executor.js';
import type { McpManager, McpCallResult, McpCallOptions } from './mcp-types.js';

/**
 * Guided SharePoint writes (sharepoint-writes R2): the three purpose-built
 * tools re-verify LIVE server state before writing and are the only path
 * that sets guidedFlow. The fake manager records options so the tests can
 * prove exactly which calls carried the waiver.
 */

type Call = { tool: string; args: Record<string, unknown>; options: McpCallOptions };

describe('tool-executor SharePoint guided writes', () => {
  let storage: StorageLayer;
  let executor: ToolExecutor;
  let calls: Call[];
  let respond: (tool: string, args: Record<string, unknown>) => McpCallResult;

  const ok = (text: string): McpCallResult => ({ text, isError: false } as McpCallResult);

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    calls = [];
    respond = () => ok('{}');
    const manager = {
      callTool: async (_id: string, tool: string, args: Record<string, unknown>, options: McpCallOptions = {}) => {
        calls.push({ tool, args, options });
        return respond(tool, args);
      },
    } as unknown as McpManager;
    executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { mcpManager: manager });
  });
  afterEach(() => storage.close());

  async function run(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await executor.executeTool({
      id: 't1',
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    return result.content;
  }

  const THREAD = JSON.stringify([
    { id: '4', author: 'Ng, Hui Jun', text: 'Can we clarify the rollout order?' },
    { id: '5', author: 'Bhagat, AB', text: 'Yes — updating the section.', parentId: '4' },
  ]);

  describe('sharepoint_reply_comment', () => {
    it('requires ownerRequested', async () => {
      const out = await run('sharepoint_reply_comment', { serverRelativeUrl: '/sites/t/Shared Documents/a.docx', commentId: '4', text: 'On it.' });
      expect(out).toMatch(/ownerRequested must be true/);
      expect(calls).toHaveLength(0);
    });

    it('aborts when the comment vanished from the live thread — and never writes', async () => {
      respond = (tool) => tool === 'sharepoint_read_docx_comments' ? ok(THREAD) : ok('{}');
      const out = await run('sharepoint_reply_comment', {
        serverRelativeUrl: '/sites/t/Shared Documents/a.docx', commentId: '99', text: 'Reply.', ownerRequested: true,
      });
      expect(out).toMatch(/comment thread changed/);
      expect(out).toContain('4: Ng, Hui Jun');
      expect(calls.map(c => c.tool)).toEqual(['sharepoint_read_docx_comments']);
    });

    it('replies through the guided waiver when the comment exists', async () => {
      respond = (tool) => tool === 'sharepoint_read_docx_comments' ? ok(THREAD) : ok('Reply added (watermarked)');
      const out = await run('sharepoint_reply_comment', {
        serverRelativeUrl: '/sites/t/Shared Documents/a.docx', siteUrl: 'https://amazon.sharepoint.com/sites/t',
        commentId: '4', text: 'Done — see revised section.', ownerRequested: true,
      });
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('replied');
      expect(parsed.note).toMatch(/watermark/i);
      const write = calls.find(c => c.tool === 'sharepoint_reply_docx_comment')!;
      expect(write.args).toMatchObject({ serverRelativeUrl: '/sites/t/Shared Documents/a.docx', siteUrl: 'https://amazon.sharepoint.com/sites/t', commentId: '4' });
      expect(write.options.guidedFlow).toBe(true);
      expect(write.options.ownerApproved).toBe(true);
      // The verification read runs WITHOUT the waiver.
      const read = calls.find(c => c.tool === 'sharepoint_read_docx_comments')!;
      expect(read.options.guidedFlow).toBeUndefined();
    });
  });

  describe('sharepoint_add_comment', () => {
    it('rejects non-docx targets', async () => {
      const out = await run('sharepoint_add_comment', { serverRelativeUrl: '/personal/u/Documents/n.md', anchorText: 'x', text: 'y', ownerRequested: true });
      expect(out).toMatch(/only supported on \.docx/);
      expect(calls).toHaveLength(0);
    });

    it('aborts when the anchor is not in the current document', async () => {
      respond = () => ok('# Doc\n\nThe rollout starts in EU.');
      const out = await run('sharepoint_add_comment', {
        serverRelativeUrl: '/sites/t/Shared Documents/a.docx', anchorText: 'launch begins in NA', text: 'Proposal.', ownerRequested: true,
      });
      expect(out).toMatch(/anchor text not found/);
      expect(calls.map(c => c.tool)).toEqual(['sharepoint_read_file']);
    });

    it('adds the comment when the anchor matches (whitespace-insensitively) and passes the original anchor', async () => {
      respond = (tool) => tool === 'sharepoint_read_file' ? ok('# Doc\n\nThe rollout   starts\nin EU next quarter.') : ok('Comment added');
      const out = await run('sharepoint_add_comment', {
        serverRelativeUrl: '/sites/t/Shared Documents/a.docx', anchorText: 'rollout starts in EU', text: 'Suggest adding NA dates.', ownerRequested: true,
      });
      expect(JSON.parse(out).status).toBe('commented');
      const write = calls.find(c => c.tool === 'sharepoint_add_docx_comment')!;
      expect(write.args.anchorText).toBe('rollout starts in EU');
      expect(write.options.guidedFlow).toBe(true);
    });
  });

  describe('sharepoint_update_document', () => {
    const CURRENT = '# Notes\n\n- item one\n';
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');

    it('refuses Office formats, routing docx to the body editor and others to comments', async () => {
      const docx = await run('sharepoint_update_document', { serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx', content: 'x', ownerRequested: true });
      expect(docx).toMatch(/text-family files only/);
      expect(docx).toMatch(/sharepoint_edit_docx_body/);
      const pptx = await run('sharepoint_update_document', { serverRelativeUrl: '/personal/u_amazon_com/Documents/deck.pptx', content: 'x', ownerRequested: true });
      expect(pptx).toMatch(/sharepoint_add_comment/);
      expect(calls).toHaveLength(0);
    });

    it('rejects unsupported paths and team-site paths without siteUrl', async () => {
      const weird = await run('sharepoint_update_document', { serverRelativeUrl: '/sites/t/CustomLib/n.md', content: 'x', ownerRequested: true });
      expect(weird).toMatch(/unsupported document path/);
      const noSite = await run('sharepoint_update_document', { serverRelativeUrl: '/sites/t/Shared Documents/n.md', content: 'x', ownerRequested: true });
      expect(noSite).toMatch(/siteUrl is required/);
      expect(calls).toHaveLength(0);
    });

    it('aborts on content-sha drift without writing', async () => {
      respond = () => ok(CURRENT);
      const out = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/notes.md',
        content: '# Notes\n\n- item one\n- item two\n',
        baseContentSha: sha('stale earlier content'),
        ownerRequested: true,
      });
      expect(out).toMatch(/document changed since it was read/);
      expect(calls.map(c => c.tool)).toEqual(['sharepoint_read_file']);
    });

    it('requires baseContentSha for existing documents and reports the current sha', async () => {
      respond = () => ok(CURRENT);
      const out = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/notes.md', content: 'new', ownerRequested: true,
      });
      expect(out).toMatch(/baseContentSha is required/);
      expect(out).toContain(sha(CURRENT));
    });

    it('writes when the sha matches, mapping the OneDrive path to write_file args', async () => {
      const next = '# Notes\n\n- item one\n- item two\n';
      respond = (tool) => tool === 'sharepoint_read_file' ? ok(CURRENT) : ok('{"saved":true,"WebUrl":"https://..."}');
      const out = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/notes.md',
        content: next, baseContentSha: sha(CURRENT), ownerRequested: true,
      });
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('updated');
      expect(parsed.newContentSha).toBe(sha(next));
      const write = calls.find(c => c.tool === 'sharepoint_write_file')!;
      expect(write.args).toMatchObject({ libraryName: 'Documents', fileName: 'notes.md', folderPath: 'BotBoyTests', content: next });
      expect(write.args.personal).toBeUndefined(); // personal default true on the server
      expect(write.options.guidedFlow).toBe(true);
      expect(write.options.ownerApproved).toBe(true);
    });

    it('REGRESSION (live find 2026-08-25): a not-found isError RESULT (not exception) is a read failure, never content to hash', async () => {
      respond = (tool) => tool === 'sharepoint_read_file'
        ? ({ text: 'Error: File /BotBoyTests/new.md was not found (404)', isError: true } as McpCallResult)
        : ok('{"saved":true}');
      const blocked = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/new.md', content: 'fresh', ownerRequested: true,
      });
      expect(blocked).toMatch(/could not verify the current document state/);
      const created = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/new.md', content: 'fresh', createIfMissing: true, ownerRequested: true,
      });
      expect(JSON.parse(created).status).toBe('created');

      // isError reads abort the comment guards too.
      respond = () => ({ text: 'Error: transient auth failure', isError: true } as McpCallResult);
      const badThread = await run('sharepoint_reply_comment', {
        serverRelativeUrl: '/sites/t/Shared Documents/a.docx', commentId: '4', text: 'x', ownerRequested: true,
      });
      expect(badThread).toMatch(/could not read the current comment thread/);
      const badDoc = await run('sharepoint_add_comment', {
        serverRelativeUrl: '/sites/t/Shared Documents/a.docx', anchorText: 'x', text: 'y', ownerRequested: true,
      });
      expect(badDoc).toMatch(/could not read the current document/);
      expect(calls.filter(c => c.tool === 'sharepoint_reply_docx_comment' || c.tool === 'sharepoint_add_docx_comment')).toHaveLength(0);
    });

    it('creates only when createIfMissing is set AND the read failed as not-found (kept flow)', async () => {
      respond = (tool) => {
        if (tool === 'sharepoint_read_file') throw new Error('File /personal/u/Documents/new.md was not found (404)');
        return ok('{"saved":true}');
      };
      const blocked = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/new.md', content: 'fresh', ownerRequested: true,
      });
      expect(blocked).toMatch(/could not verify the current document state/);

      const created = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/new.md', content: 'fresh', createIfMissing: true, ownerRequested: true,
      });
      expect(JSON.parse(created).status).toBe('created');

      // A non-404 failure never creates, even with the flag.
      respond = (tool) => {
        if (tool === 'sharepoint_read_file') throw new Error('Silent authorize did not return a code');
        return ok('{"saved":true}');
      };
      const authFail = await run('sharepoint_update_document', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/new.md', content: 'fresh', createIfMissing: true, ownerRequested: true,
      });
      expect(authFail).toMatch(/could not verify the current document state/);
      expect(calls.filter(c => c.tool === 'sharepoint_write_file')).toHaveLength(1);
    });
  });

  describe('sharepoint_edit_docx_body (R4)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-edit-tool-')); });
    afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

    const DOC_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:t>The rollout </w:t></w:r><w:r><w:t>starts in EU</w:t></w:r><w:r><w:t> next quarter.</w:t></w:r></w:p>'
      + '<w:sectPr/></w:body></w:document>';
    const COMMENTS_XML = '<w:comments><w:comment w:id="1">must survive</w:comment></w:comments>';

    /** Build a docx-shaped zip fixture the fake download can serve. */
    function buildFixture(): string {
      const src = path.join(dir, 'fixture-src');
      mkdirSync(path.join(src, 'word'), { recursive: true });
      writeFileSync(path.join(src, '[Content_Types].xml'), '<Types/>');
      writeFileSync(path.join(src, 'word', 'document.xml'), DOC_XML);
      writeFileSync(path.join(src, 'word', 'comments.xml'), COMMENTS_XML);
      const zipPath = path.join(dir, 'fixture.docx');
      execFileSync('zip', ['-X', '-q', '-r', zipPath, '.'], { cwd: src });
      return zipPath;
    }

    /** Fake server: savePath downloads copy the fixture; uploads snapshot the
     * edited archive (the handler deletes its staging file afterwards). */
    function docxRespond(opts: { uploaded: { path?: string }; readBackText: () => string }): typeof respond {
      const fixture = buildFixture();
      return (tool, args) => {
        if (tool === 'sharepoint_read_file' && args.savePath) {
          copyFileSync(fixture, String(args.savePath));
          return ok('{"saved":true}');
        }
        if (tool === 'sharepoint_read_file') return ok(opts.readBackText());
        if (tool === 'sharepoint_write_file') {
          const snapshot = path.join(dir, 'uploaded.docx');
          copyFileSync(String(args.sourcePath), snapshot);
          opts.uploaded.path = snapshot;
          return ok('{"Name":"a.docx","WebUrl":"https://..."}');
        }
        throw new Error(`unexpected ${tool}`);
      };
    }

    it('gates, rejects non-docx, and validates operations', async () => {
      const gate = await run('sharepoint_edit_docx_body', { serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx', operation: 'replaceText', findText: 'x', replaceWith: 'y' });
      expect(gate).toMatch(/ownerRequested must be true/);
      const notDocx = await run('sharepoint_edit_docx_body', { serverRelativeUrl: '/personal/u_amazon_com/Documents/a.md', operation: 'replaceText', findText: 'x', replaceWith: 'y', ownerRequested: true });
      expect(notDocx).toMatch(/edits \.docx files/);
      const badOp = await run('sharepoint_edit_docx_body', { serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx', operation: 'rewriteEverything', ownerRequested: true });
      expect(badOp).toMatch(/operation must be replaceText or appendParagraphs/);
      expect(calls).toHaveLength(0);
    });

    it('mode=propose (DEFAULT) stages a pending edit without ANY MCP call and returns the reader link', async () => {
      const out = await run('sharepoint_edit_docx_body', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/a.docx',
        operation: 'replaceText', findText: 'starts in EU next quarter, follows NA', replaceWith: 'begins in NA in Q1',
        purpose: 'align with the new rollout order', ownerRequested: true,
      });
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('staged');
      expect(parsed.readerLink).toMatch(/^#\/doc\//);
      expect(calls).toHaveLength(0); // nothing touches SharePoint
      const row = storage.getDb().prepare('SELECT kind, status, origin_note FROM document_pending_edits').get() as any;
      expect(row.kind).toBe('botboy');
      expect(row.status).toBe('pending');
      expect(row.origin_note).toBe('align with the new rollout order');
    });

    it('replaceText edits across split runs, uploads under the waiver, preserves comments, verifies read-back', async () => {
      const uploaded: { path?: string } = {};
      respond = docxRespond({ uploaded, readBackText: () => 'The rollout begins in NA next quarter.' });
      const out = await run('sharepoint_edit_docx_body', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/a.docx',
        operation: 'replaceText', findText: 'starts in EU', replaceWith: 'begins in NA', mode: 'direct', ownerRequested: true,
      });
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('edited');
      expect(parsed.verifiedOnReadBack).toBe(true);
      expect(parsed.note).toMatch(/version history/);

      const write = calls.find(c => c.tool === 'sharepoint_write_file')!;
      expect(write.options.guidedFlow).toBe(true);
      expect(write.options.ownerApproved).toBe(true);
      expect(write.args.fileName).toBe('a.docx');
      expect(write.args.folderPath).toBe('BotBoyTests');

      // The uploaded archive: body edited, comments byte-identical.
      const editedXml = execFileSync('unzip', ['-p', uploaded.path!, 'word/document.xml']).toString('utf8');
      expect(editedXml).toContain('begins in NA');
      expect(editedXml).not.toContain('starts in EU');
      const comments = execFileSync('unzip', ['-p', uploaded.path!, 'word/comments.xml']).toString('utf8');
      expect(comments).toBe(COMMENTS_XML);
      // Staging file cleaned up.
      const staging = String(write.args.sourcePath);
      expect(existsSync(staging)).toBe(false);
    });

    it('aborts on not-found and ambiguous passages without uploading', async () => {
      const uploaded: { path?: string } = {};
      respond = docxRespond({ uploaded, readBackText: () => '' });
      const missing = await run('sharepoint_edit_docx_body', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx',
        operation: 'replaceText', findText: 'passage that never existed', replaceWith: 'x', mode: 'direct', ownerRequested: true,
      });
      expect(missing).toMatch(/passage not found/);
      const vague = await run('sharepoint_edit_docx_body', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx',
        operation: 'replaceText', findText: 'e', replaceWith: 'x', mode: 'direct', ownerRequested: true,
      });
      expect(vague).toMatch(/matches \d+ places/);
      expect(calls.filter(c => c.tool === 'sharepoint_write_file')).toHaveLength(0);
    });

    it('appendParagraphs adds paragraphs and verifies via the last one', async () => {
      const uploaded: { path?: string } = {};
      respond = docxRespond({ uploaded, readBackText: () => 'The rollout starts in EU next quarter.\n\nDecision: NA launch after readiness review.' });
      const out = await run('sharepoint_edit_docx_body', {
        serverRelativeUrl: '/personal/u_amazon_com/Documents/a.docx',
        operation: 'appendParagraphs', paragraphs: ['Meeting notes 2026-08-25:', 'Decision: NA launch after readiness review.'], mode: 'direct', ownerRequested: true,
      });
      expect(JSON.parse(out).status).toBe('edited');
      const editedXml = execFileSync('unzip', ['-p', uploaded.path!, 'word/document.xml']).toString('utf8');
      expect(editedXml).toContain('Meeting notes 2026-08-25:');
      expect(editedXml.indexOf('Decision: NA launch')).toBeLessThan(editedXml.indexOf('<w:sectPr'));
    });
  });
});
