/**
 * Google Slides in chat (google-workspace.md, "Slides"): gdrive_read shows a
 * deck as slides with element ids (gslides-model.ts); gdrive_edit on a deck replaces
 * text, sets a text box or the speaker notes, and adds, deletes, moves or
 * duplicates slides, in one atomic write against the revision it read.
 */

import type { ToolResult } from './tool-executor.js';
import { GDRIVE_SLIDES_MIME, type DriveFile } from './gdrive-api.js';
import { redactSecrets } from './sensitive-files.js';
import type { Presentation } from './google-workspace-api.js';
import { outlineToSlides, planSlideEdits, slideViews, slidesViewLines } from './gslides-model.js';
import { googleErrorFailure, googleResult, invalid, numberedLines, untrustedEnvelope } from './google-tool-support.js';
import { accountEmail, failedResult, type GoogleToolEnv, type LocatedFile } from './google-tool-env.js';

export async function readSlides(env: GoogleToolEnv, accountId: string, file: DriveFile, fallback: () => Promise<ToolResult>): Promise<ToolResult> {
  const slides = env.workspaceFor(accountId)?.slides;
  if (!slides) return fallback();
  let deck: Presentation;
  try {
    deck = await slides.get(file.id);
  } catch (error) {
    const failure = googleErrorFailure(error, false, 'Google Slides read');
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
  const views = slideViews(deck);
  const lines = numberedLines(slidesViewLines(views).map(line => redactSecrets(line)), { startLine: env.args.startLine, endLine: env.args.endLine });
  if (!lines.ok) return failedResult(env, lines.failure);
  return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id, webViewLink: file.webViewLink }, {
    ok: true,
    fileId: file.id,
    name: redactSecrets(file.name ?? deck.title ?? ''),
    kind: 'slides',
    account: accountEmail(env, accountId),
    webViewLink: file.webViewLink,
    slides: views.length,
    revisionId: deck.revisionId,
    startLine: lines.startLine,
    endLine: lines.endLine,
    totalLines: lines.totalLines,
    nextStartLine: lines.nextStartLine,
    readNote: `${lines.readNote} Each slide line names its number and id; each element line its kind and id; ⏎ is a line break inside a text box.`,
    editHint: 'Change slides with gdrive_edit (fileId, edits: [{action: "replace_text", find, replace}] or set_text {element, text}, add_slide, delete_slide, move_slide, duplicate_slide, set_notes; slide = its number in this read or its id).',
    lines: lines.lines,
  }));
}

export async function slidesEdit(env: GoogleToolEnv, located: LocatedFile): Promise<ToolResult> {
  if (!Array.isArray(env.args.edits)) return failedResult(env, invalid('A deck takes edits: a list of {action, …} edits (replace_text, set_text, add_slide, …).'));
  const { accountId, file } = located;
  if (file.mimeType !== GDRIVE_SLIDES_MIME) return failedResult(env, invalid('This file is not Google Slides.'));
  const slides = env.workspaceFor(accountId)?.slides;
  if (!slides) return failedResult(env, { code: 'unavailable', message: 'Google Slides editing is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  for (let attempt = 0; attempt < 2; attempt++) {
    let deck: Presentation;
    try {
      deck = await slides.get(file.id);
    } catch (error) {
      return failedResult(env, googleErrorFailure(error, false, 'Google Slides read'));
    }
    const plan = planSlideEdits(deck, env.args.edits as Record<string, unknown>[]);
    if (!plan.ok) return failedResult(env, invalid(plan.message, undefined, 'Read the deck again with gdrive_read if a slide or element is unclear, fix that edit, and call once more; nothing changed.'));
    let replies: any[] = [];
    try {
      replies = (await slides.batchUpdate(file.id, plan.requests, deck.revisionId)).replies ?? [];
    } catch (error) {
      const failure = googleErrorFailure(error, true, 'Google Slides edit');
      if (failure.code === 'changed_since_read' && attempt === 0) continue;
      if (failure.effect === 'unknown') return failedResult(env, { ...failure, nextAction: 'Do not send this again: read the deck with gdrive_read to see whether the change is there, then tell the owner.' });
      return failedResult(env, failure);
    }
    // Google's count of replaced text, per replace_text edit, in request order.
    const counts = replies.map(reply => reply?.replaceAllText?.occurrencesChanged).filter(count => count !== undefined);
    let replaceIndex = 0;
    return googleResult(env.call, {
      ok: true,
      tool: 'gdrive_edit',
      status: 'applied',
      account: accountEmail(env, accountId),
      fileId: file.id,
      name: redactSecrets(file.name ?? ''),
      webViewLink: file.webViewLink,
      changes: plan.summary.map(entry => (entry.action === 'replace_text' ? { ...entry, replaced: counts[replaceIndex++] ?? entry.found } : entry)),
      ...(attempt > 0 ? { note: 'Someone edited the deck while BotBoy worked; BotBoy read it again and applied the edits to the newer version.' } : {}),
    });
  }
  return failedResult(env, { code: 'changed_since_read', message: 'The deck kept changing while BotBoy tried to edit it, so nothing was changed.', effect: 'none', nextAction: 'Read it again with gdrive_read and try once more.' });
}

/** gdrive_files action create kind slides with content: the outline becomes slides, and the empty first slide of a new deck goes. */
export async function fillSlidesFromOutline(env: GoogleToolEnv, accountId: string, presentationId: string, outline: string): Promise<{ slides: number }> {
  const slides = env.workspaceFor(accountId)?.slides;
  if (!slides) throw new Error('Google Slides is unavailable in this BotBoy build.');
  const wanted = outlineToSlides(outline);
  if (!wanted.length) return { slides: 0 };
  const deck = await slides.get(presentationId);
  const blank = (deck.slides ?? []).map(slide => slide.objectId);
  const edits: Record<string, unknown>[] = wanted.map((slide, i) => ({ action: 'add_slide', layout: slide.layout, at: blank.length + i + 1, ...(slide.title ? { title: slide.title } : {}), ...(slide.body ? { body: slide.body } : {}) }));
  for (const id of blank) edits.push({ action: 'delete_slide', slide: id });
  const plan = planSlideEdits(deck, edits);
  if (!plan.ok) throw new Error(plan.message);
  await slides.batchUpdate(presentationId, plan.requests, deck.revisionId);
  return { slides: wanted.length };
}
