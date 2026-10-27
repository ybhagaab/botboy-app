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
import { DOCX_MIME, GDRIVE_DOC_MIME, type DriveFile } from './gdrive-api.js';
import { GoogleApiError } from './gmail-api.js';
import { redactSecrets } from './sensitive-files.js';
import { parseExactEdits } from './exact-text-edits.js';
import {
  buildDocView,
  inlinePictureCount,
  orderDocBlocks,
  pictureOverlapsEdit,
  planDocAppend,
  planDocEdits,
  planDocPictureInserts,
  type DocEditFailure,
  type DocEditPlan,
  type DocRequestBlock,
} from './gdocs-model.js';
import type { DocsDocument, GoogleWorkspaceClients } from './google-workspace-api.js';
import { googleErrorFailure, googleResult, invalid, numberedLines, untrustedEnvelope, type GoogleFailure } from './google-tool-support.js';
import { accountEmail, failedResult, type GoogleToolEnv, type LocatedFile } from './google-tool-env.js';
import { isPictureFetchFailure, pictureLinksNote, pictureSpecOf, pictureWidthPt, preparePicture, temporaryLinkConsent, withPictureLinks, type PreparedPicture } from './google-media.js';

/** A Doc's text width on a Letter page with 1in margins: the widest a picture goes by default. */
const DOC_TEXT_WIDTH_PT = 468;

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

/** A picture edit, checked and ready: {action: "insert_image", after | at: "end", image, width}. */
interface PictureEdit {
  index: number;
  after?: string;
  atEnd: boolean;
  picture: PreparedPicture;
  widthPt?: number;
}

/** Edit numbers in a failure, from the text edits' own list back to the call's list. */
function renumbered<T extends { message: string; index?: number }>(failure: T, original: readonly number[]): T {
  return {
    ...failure,
    message: failure.message.replace(/edits\[(\d+)\]/g, (match, n) => (original[Number(n)] === undefined ? match : `edits[${original[Number(n)]}]`)),
    ...(failure.index !== undefined && original[failure.index] !== undefined ? { index: original[failure.index] } : {}),
  };
}

function plan(
  doc: DocsDocument,
  edits: Array<{ find: string; replace: string }> | null,
  textIndexes: readonly number[],
  append: string,
  markdown: boolean,
  pictures: readonly PictureEdit[],
  uris: readonly string[],
): (DocEditPlan & { pictureLines: Array<{ index: number; line: number }> }) | DocEditFailure {
  const blocks: DocRequestBlock[] = [];
  const changes: DocEditPlan['changes'] = [];
  if (append) {
    const appended = planDocAppend(doc, append, { markdown });
    if (!appended.ok) return appended;
    // The end of the document comes first (an append wins a tie), so edits further up keep their indexes.
    blocks.push(...(appended.blocks ?? []).map(block => ({ ...block, order: Number.MAX_SAFE_INTEGER })));
    changes.push(...appended.changes.map(change => ({ ...change, index: -1 })));
  }
  const textBlocks: DocRequestBlock[] = [];
  if (edits) {
    const planned = planDocEdits(doc, edits, { markdown });
    if (!planned.ok) return renumbered(planned, textIndexes);
    textBlocks.push(...(planned.blocks ?? []).map(block => ({ ...block, order: textIndexes[block.order] ?? block.order })));
    blocks.push(...textBlocks);
    changes.push(...planned.changes.map(change => ({ ...change, index: textIndexes[change.index] ?? change.index })));
  }
  let pictureLines: Array<{ index: number; line: number }> = [];
  if (pictures.length) {
    const planned = planDocPictureInserts(doc, pictures.map((picture, i) => ({ index: picture.index, ...(picture.after !== undefined ? { after: picture.after } : {}), atEnd: picture.atEnd, uri: uris[i], ...(picture.widthPt ? { widthPt: picture.widthPt } : {}) })));
    if (!planned.ok) return planned;
    for (const block of planned.blocks) {
      const clash = pictureOverlapsEdit(block, textBlocks);
      if (clash) {
        return { ok: false, code: 'edits_overlap', index: block.order, message: `edits[${block.order}] puts a picture where edits[${clash.order}] changes the text (that edit takes in the paragraph's line break). Insert the picture in a second call.` };
      }
    }
    blocks.push(...planned.blocks);
    pictureLines = planned.lines;
  }
  return { ok: true, requests: orderDocBlocks(blocks), changes, pictureLines };
}

function isPictureEdit(edit: unknown): edit is Record<string, unknown> {
  return Boolean(edit) && typeof edit === 'object' && !Array.isArray(edit) && (edit as Record<string, unknown>).action === 'insert_image';
}

export async function docsEdit(env: GoogleToolEnv, located: LocatedFile): Promise<ToolResult> {
  const hasEdits = env.args.edits !== undefined;
  const append = typeof env.args.append === 'string' ? env.args.append : '';
  const content = typeof env.args.content === 'string' ? env.args.content : null;
  const markdown = env.args.markdown !== false;
  if (content !== null && (hasEdits || append)) return failedResult(env, invalid('content replaces the whole document; send it alone, without edits or append.'));
  if (content === null && !hasEdits && !append) return failedResult(env, invalid('Send edits (exact find/replace pairs, or insert_image), append (lines to add at the end), or content (the whole new document).'));
  if (append.length > MAX_APPEND_CHARS) return failedResult(env, invalid(`append is at most ${MAX_APPEND_CHARS.toLocaleString('en-US')} characters.`));
  // Pictures ({action: "insert_image"}) travel in edits beside the {find, replace} pairs.
  const list = Array.isArray(env.args.edits) ? env.args.edits as unknown[] : null;
  const pictureEntries = (list ?? []).map((edit, index) => ({ edit, index })).filter(entry => isPictureEdit(entry.edit));
  const textIndexes = (list ?? []).map((edit, index) => (isPictureEdit(edit) ? -1 : index)).filter(index => index >= 0);
  let edits: Array<{ find: string; replace: string }> | null = null;
  if (hasEdits && (!list || textIndexes.length)) {
    const parsed = parseExactEdits(list ? textIndexes.map(index => list[index]) : env.args.edits);
    if (!parsed.ok) return failedResult(env, invalid(renumbered(parsed, textIndexes).message));
    edits = parsed.edits;
  }
  if (pictureEntries.length && append) return failedResult(env, invalid('Send append and pictures in separate calls: a picture goes after a paragraph that the append would move.'));
  if (pictureEntries.length > 10) return failedResult(env, invalid('At most 10 pictures in one call; insert the rest in another call.'));
  const pictures: PictureEdit[] = [];
  for (const entry of pictureEntries) {
    const index = entry.index;
    const edit = entry.edit as Record<string, unknown>;
    const after = typeof edit.after === 'string' && edit.after !== '' ? edit.after : undefined;
    const atEnd = edit.at === 'end';
    if (Boolean(after) === atEnd) return failedResult(env, invalid(`edits[${index}] (insert_image) needs after (the exact text of the paragraph it goes after, from gdrive_read) or at: "end", not both.`));
    const spec = pictureSpecOf(edit.image, `edits[${index}].image`);
    if (!spec.ok) return failedResult(env, spec.failure);
    const prepared = await preparePicture(spec.spec, env.local);
    if (!prepared.ok) return failedResult(env, { ...prepared.failure, message: `edits[${index}]: ${prepared.failure.message}` });
    pictures.push({ index, ...(after !== undefined ? { after } : {}), atEnd, picture: prepared.picture, ...(pictureWidthPt(prepared.picture, edit.width, DOC_TEXT_WIDTH_PT) ? { widthPt: pictureWidthPt(prepared.picture, edit.width, DOC_TEXT_WIDTH_PT) } : {}) });
  }
  // A picture BotBoy holds goes in through a temporary anyone-with-the-link copy: the owner's words first.
  const consent = temporaryLinkConsent(pictures.map(entry => entry.picture), env.context);
  if (consent) return failedResult(env, consent);
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
      // Pictures and diagrams in the Markdown go through Word, which Drive converts with them.
      const word = env.wordFromMarkdown ? await env.wordFromMarkdown(content) : null;
      await drive.updateMedia(file.id, word ? { media: word.data, mediaMimeType: DOCX_MIME } : { media: Buffer.from(content, 'utf8'), mediaMimeType: 'text/markdown' });
      const after = await docs.get(file.id);
      const lines = buildDocView(after).text.split('\n').length;
      const picturesIn = inlinePictureCount(after);
      const picturesArrived = !word || picturesIn >= word.media.embedded;
      return googleResult(env.call, {
        ok: true, tool: 'gdrive_edit', status: 'replaced', account: accountEmail(env, accountId), fileId: file.id, name, webViewLink: file.webViewLink,
        revisionId: after.revisionId, lines,
        ...(word ? { pictures: word.media.pictures, diagrams: word.media.diagrams, picturesInDoc: picturesIn, ...(word.media.problems.length ? { mediaProblems: word.media.problems.slice(0, 10) } : {}) } : {}),
        ...(picturesArrived ? {} : { warning: `The Doc shows ${picturesIn} pictures but ${word?.media.embedded ?? 0} were sent; check it with gdrive_read before telling the owner it is done.` }),
        verified: lines > 0 && picturesArrived,
        note: `The whole document was replaced from Markdown${word ? ' (through Word, so its pictures and diagrams came along)' : ''}; the file keeps its link, sharing and version history (File → Version history in Docs).`,
      });
    } catch (error) {
      return failedResult(env, googleErrorFailure(error, true, 'Google Docs edit'));
    }
  }

  // Targeted edits: read, plan, write once against that revision; one fresh read if someone edited in between.
  const run = async (addresses: string[][]): Promise<ToolResult> => {
    // Each picture's first address; the second only if Google refused to fetch from the first.
    let choice = 0;
    let rereads = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      let doc: DocsDocument;
      try {
        doc = await docs.get(file.id);
      } catch (error) {
        return failedResult(env, googleErrorFailure(error, false, 'Google Docs read'));
      }
      const uris = addresses.map(candidates => candidates[Math.min(choice, candidates.length - 1)]);
      const planned = plan(doc, edits, textIndexes, append, markdown, pictures, uris);
      if (!planned.ok) return failedResult(env, planFailure(planned));
      const picturesBefore = inlinePictureCount(doc);
      try {
        await docs.batchUpdate(file.id, planned.requests, doc.revisionId);
      } catch (error) {
        if (pictures.length && choice === 0 && isPictureFetchFailure(error) && addresses.some(candidates => candidates.length > 1)) {
          // Google answered and wrote nothing: the batch is atomic.
          choice = 1;
          continue;
        }
        const failure = googleErrorFailure(error, true, 'Google Docs edit');
        if (failure.code === 'changed_since_read' && rereads === 0) { rereads++; continue; }
        if (failure.effect === 'unknown') {
          return failedResult(env, { ...failure, nextAction: 'Do not send this again: read the Doc with gdrive_read to see whether the change is there, then tell the owner.' });
        }
        if (pictures.length && isPictureFetchFailure(error)) {
          return failedResult(env, { ...failure, code: 'picture_fetch_failed', message: `Google could not fetch the picture to copy it: ${failure.message}`, nextAction: 'Nothing changed. Try once more; if it fails again, tell the owner and offer to put the picture in a new Doc made from Word (gdrive_files create kind doc with Markdown that has the picture).' });
        }
        return failedResult(env, failure);
      }
      // Read back: every new text must now be in the Doc, and every picture.
      let verified = false;
      let revisionId: string | undefined;
      let picturesAdded = 0;
      try {
        const after = await docs.get(file.id);
        revisionId = after.revisionId;
        const text = buildDocView(after).text;
        picturesAdded = inlinePictureCount(after) - picturesBefore;
        verified = planned.changes.every(change => !change.inserted || text.includes(change.inserted.split('\n')[0])) && picturesAdded >= pictures.length;
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
        changes: [
          ...planned.changes.map(change => ({
            ...(change.index >= 0 ? { edit: change.index } : { append: true }),
            line: change.line,
            ...(change.inserted ? { text: change.inserted.length > 160 ? `${change.inserted.slice(0, 159)}…` : change.inserted } : { deleted: true }),
          })),
          ...planned.pictureLines.map(entry => ({ edit: entry.index, picture: true, afterLine: entry.line, from: pictures.find(picture => picture.index === entry.index)?.picture.from })),
        ],
        ...(pictures.length ? { picturesAdded } : {}),
        verified,
        ...(rereads > 0 ? { note: 'Someone edited the Doc while BotBoy worked; BotBoy read it again and applied the edits to the newer version.' } : {}),
        ...(verified ? {} : { warning: 'BotBoy could not confirm every change in a fresh read; check the Doc with gdrive_read before telling the owner it is done.' }),
      });
    }
    return failedResult(env, { code: 'changed_since_read', message: 'The Doc kept changing while BotBoy tried to edit it, so nothing was changed.', effect: 'none', nextAction: 'Read it again with gdrive_read and try once more, or tell the owner someone is editing it now.' });
  };
  if (!pictures.length) return run([]);
  try {
    const { value, links } = await withPictureLinks(located.drive, pictures.map(picture => picture.picture), run);
    return withLinksNote(value, links);
  } catch (error) {
    return failedResult(env, { ...googleErrorFailure(error, false, 'Drive upload'), message: `The picture could not be readied for Google: ${redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300)}`, effect: 'none', nextAction: 'Nothing changed in the Doc. Try once more, or tell the owner.' });
  }
}

/** A tool result with the temporary-picture receipt added. */
function withLinksNote(result: ToolResult, links: Parameters<typeof pictureLinksNote>[0]): ToolResult {
  const note = pictureLinksNote(links);
  if (!Object.keys(note).length) return result;
  try {
    const parsed = JSON.parse(result.content);
    return { ...result, content: JSON.stringify({ ...parsed, ...note }, null, 1) };
  } catch {
    return result;
  }
}

export { withLinksNote };

export { GoogleApiError };
