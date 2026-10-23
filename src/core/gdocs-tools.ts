/**
 * Google Docs in chat (google-workspace.md, "Docs"): gdrive_read shows a Doc
 * as numbered lines (gdocs-model.ts), and gdrive_edit on a Doc changes parts
 * of it in place, the same granularity as read_product_document /
 * edit_product_document.
 *
 *   gdrive_edit {fileId, edits?: [{find, replace}], append?, content?, revisionId?, markdown?}
 *     edits   exact finds from the read (each once, not overlapping), one
 *             atomic write that Google refuses if the Doc changed since the
 *             read (requiredRevisionId); if someone edited in between, BotBoy
 *             reads again and plans once more, then reads back to verify.
 *     append  Markdown lines added after the last paragraph.
 *     content the whole document as Markdown, replacing everything (keeps the
 *             file, its link, sharing and history); needs the revisionId of
 *             the read so newer edits by others are never overwritten.
 */

import type { ToolResult } from './tool-executor.js';
import { GDRIVE_DOC_MIME, type DriveFile } from './gdrive-api.js';
import { GoogleApiError } from './gmail-api.js';
import { redactSecrets } from './sensitive-files.js';
import { parseExactEdits } from './exact-text-edits.js';
import { buildDocView, planDocAppend, planDocEdits, type DocEditFailure, type DocEditPlan } from './gdocs-model.js';
import type { DocsDocument, GoogleWorkspaceClients } from './google-workspace-api.js';
import { googleErrorFailure, googleResult, invalid, numberedLines, untrustedEnvelope, type GoogleFailure } from './google-tool-support.js';
import { accountEmail, failedResult, type GoogleToolEnv, type LocatedFile } from './google-tool-env.js';

const MAX_APPEND_CHARS = 200_000;
const MAX_CONTENT_CHARS = 1_000_000;

function docsOf(env: GoogleToolEnv, accountId: string): GoogleWorkspaceClients['docs'] | null {
  return env.workspaceFor(accountId)?.docs ?? null;
}

/** gdrive_read for a Google Doc: numbered lines from the Docs API, with the revision an edit needs. */
export async function readDoc(env: GoogleToolEnv, accountId: string, file: DriveFile, fallback: () => Promise<ToolResult>): Promise<ToolResult> {
  const docs = docsOf(env, accountId);
  if (!docs) return fallback();
  let doc: DocsDocument;
  try {
    doc = await docs.get(file.id);
  } catch (error) {
    const failure = googleErrorFailure(error, false, 'Google Docs read');
    // Reading still works through Drive's export; editing waits for the API.
    if (failure.code === 'api_not_enabled' || failure.code === 'reconnect_for_scope') {
      const plain = await fallback();
      try {
        const parsed = JSON.parse(plain.content);
        parsed.result = { ...(parsed.result ?? {}), editing: `Not available yet: ${failure.message} ${failure.nextAction}` };
        return { ...plain, content: JSON.stringify(parsed, null, 1) };
      } catch {
        return plain;
      }
    }
    return failedResult(env, failure);
  }
  const view = buildDocView(doc);
  const lines = numberedLines(view.text.split('\n').map(line => redactSecrets(line)), { startLine: env.args.startLine, endLine: env.args.endLine });
  if (!lines.ok) return failedResult(env, lines.failure);
  return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id, webViewLink: file.webViewLink }, {
    ok: true,
    fileId: file.id,
    name: redactSecrets(file.name ?? doc.title ?? ''),
    kind: 'doc',
    account: accountEmail(env, accountId),
    webViewLink: file.webViewLink,
    modifiedTime: file.modifiedTime,
    revisionId: doc.revisionId,
    startLine: lines.startLine,
    endLine: lines.endLine,
    totalLines: lines.totalLines,
    nextStartLine: lines.nextStartLine,
    readNote: `${lines.readNote} Headings show as #, list items as - or 1., tables as | cells |, images as [image]; bold, italic and links are not shown. Only the first tab of a multi-tab Doc is shown.`,
    editHint: 'To change text, copy it exactly from these lines (without the "N: " prefix) into gdrive_edit edits with this fileId; to add at the end use append.',
    lines: lines.lines,
  }));
}

function planFailure(plan: DocEditFailure): GoogleFailure {
  return {
    code: plan.code,
    message: plan.message,
    effect: 'none',
    nextAction: plan.code === 'edit_not_found' || plan.code === 'edit_not_unique'
      ? 'Read the Doc again with gdrive_read, copy the exact text, and call once more; nothing changed.'
      : 'Change the edit as the message says and call once more; nothing changed.',
  };
}

function plan(doc: DocsDocument, edits: Array<{ find: string; replace: string }> | null, append: string, markdown: boolean): DocEditPlan | DocEditFailure {
  const requests: unknown[] = [];
  const changes: DocEditPlan['changes'] = [];
  if (append) {
    const appended = planDocAppend(doc, append, { markdown });
    if (!appended.ok) return appended;
    // The end of the document comes first: edits further up keep their indexes.
    requests.push(...appended.requests);
    changes.push(...appended.changes.map(change => ({ ...change, index: -1 })));
  }
  if (edits) {
    const planned = planDocEdits(doc, edits, { markdown });
    if (!planned.ok) return planned;
    requests.push(...planned.requests);
    changes.push(...planned.changes);
  }
  return { ok: true, requests, changes };
}

export async function docsEdit(env: GoogleToolEnv, located: LocatedFile): Promise<ToolResult> {
  const hasEdits = env.args.edits !== undefined;
  const append = typeof env.args.append === 'string' ? env.args.append : '';
  const content = typeof env.args.content === 'string' ? env.args.content : null;
  const markdown = env.args.markdown !== false;
  if (content !== null && (hasEdits || append)) return failedResult(env, invalid('content replaces the whole document; send it alone, without edits or append.'));
  if (content === null && !hasEdits && !append) return failedResult(env, invalid('Send edits (exact find/replace pairs), append (lines to add at the end), or content (the whole new document).'));
  if (append.length > MAX_APPEND_CHARS) return failedResult(env, invalid(`append is at most ${MAX_APPEND_CHARS.toLocaleString('en-US')} characters.`));
  let edits: Array<{ find: string; replace: string }> | null = null;
  if (hasEdits) {
    const parsed = parseExactEdits(env.args.edits);
    if (!parsed.ok) return failedResult(env, invalid(parsed.message));
    edits = parsed.edits;
  }
  const { accountId, drive, file } = located;
  if (file.mimeType !== GDRIVE_DOC_MIME) return failedResult(env, invalid('This file is not a Google Doc.'));
  const docs = docsOf(env, accountId);
  if (!docs) return failedResult(env, { code: 'unavailable', message: 'Google Docs editing is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  const name = redactSecrets(file.name ?? '');

  if (content !== null) {
    if (!content.trim() || content.length > MAX_CONTENT_CHARS) return failedResult(env, invalid(`content is the whole new document as Markdown (1 to ${MAX_CONTENT_CHARS.toLocaleString('en-US')} characters).`));
    const revisionId = typeof env.args.revisionId === 'string' ? env.args.revisionId.trim() : '';
    if (!revisionId) return failedResult(env, invalid('Replacing the whole document needs revisionId from your gdrive_read of it, so newer edits by others are never overwritten.', undefined, 'Read it with gdrive_read, then call again with its revisionId.'));
    try {
      const current = await docs.get(file.id);
      if (current.revisionId !== revisionId) {
        return failedResult(env, { code: 'changed_since_read', message: 'The Doc changed after the read you are working from, so BotBoy did not replace it: nothing changed.', effect: 'none', nextAction: 'Read it again with gdrive_read, fold the new changes in, and call again with the new revisionId.' });
      }
      await drive.updateMedia(file.id, { media: Buffer.from(content, 'utf8'), mediaMimeType: 'text/markdown' });
      const after = await docs.get(file.id);
      const lines = buildDocView(after).text.split('\n').length;
      return googleResult(env.call, {
        ok: true, tool: 'gdrive_edit', status: 'replaced', account: accountEmail(env, accountId), fileId: file.id, name, webViewLink: file.webViewLink,
        revisionId: after.revisionId, lines, verified: lines > 0,
        note: 'The whole document was replaced from Markdown; the file keeps its link, sharing and version history (File → Version history in Docs).',
      });
    } catch (error) {
      return failedResult(env, googleErrorFailure(error, true, 'Google Docs edit'));
    }
  }

  // Targeted edits: read, plan, write once against that revision; one fresh read if someone edited in between.
  for (let attempt = 0; attempt < 2; attempt++) {
    let doc: DocsDocument;
    try {
      doc = await docs.get(file.id);
    } catch (error) {
      return failedResult(env, googleErrorFailure(error, false, 'Google Docs read'));
    }
    const planned = plan(doc, edits, append, markdown);
    if (!planned.ok) return failedResult(env, planFailure(planned));
    try {
      await docs.batchUpdate(file.id, planned.requests, doc.revisionId);
    } catch (error) {
      const failure = googleErrorFailure(error, true, 'Google Docs edit');
      if (failure.code === 'changed_since_read' && attempt === 0) continue;
      if (failure.effect === 'unknown') {
        return failedResult(env, { ...failure, nextAction: 'Do not send this again: read the Doc with gdrive_read to see whether the change is there, then tell the owner.' });
      }
      return failedResult(env, failure);
    }
    // Read back: every new text must now be in the Doc.
    let verified = false;
    let revisionId: string | undefined;
    try {
      const after = await docs.get(file.id);
      revisionId = after.revisionId;
      const text = buildDocView(after).text;
      verified = planned.changes.every(change => !change.inserted || text.includes(change.inserted.split('\n')[0]));
    } catch {
      verified = false;
    }
    return googleResult(env.call, {
      ok: true,
      tool: 'gdrive_edit',
      status: 'applied',
      account: accountEmail(env, accountId),
      fileId: file.id,
      name,
      webViewLink: file.webViewLink,
      ...(revisionId ? { revisionId } : {}),
      changes: planned.changes.map(change => ({
        ...(change.index >= 0 ? { edit: change.index } : { append: true }),
        line: change.line,
        ...(change.inserted ? { text: change.inserted.length > 160 ? `${change.inserted.slice(0, 159)}…` : change.inserted } : { deleted: true }),
      })),
      verified,
      ...(attempt > 0 ? { note: 'Someone edited the Doc while BotBoy worked; BotBoy read it again and applied the edits to the newer version.' } : {}),
      ...(verified ? {} : { warning: 'BotBoy could not confirm every change in a fresh read; check the Doc with gdrive_read before telling the owner it is done.' }),
    });
  }
  return failedResult(env, { code: 'changed_since_read', message: 'The Doc kept changing while BotBoy tried to edit it, so nothing was changed.', effect: 'none', nextAction: 'Read it again with gdrive_read and try once more, or tell the owner someone is editing it now.' });
}

export { GoogleApiError };
