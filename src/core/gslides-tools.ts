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
import { outlineToSlides, pageBox, planSlideEdits, slideViews, slidesViewLines, type SlidePicture } from './gslides-model.js';
import { googleErrorFailure, googleResult, invalid, numberedLines, untrustedEnvelope } from './google-tool-support.js';
import { accountEmail, failedResult, type GoogleToolEnv, type LocatedFile } from './google-tool-env.js';
import { isPictureFetchFailure, pictureSpecOf, preparePicture, temporaryLinkConsent, withPictureLinks, type PreparedPicture } from './google-media.js';
import { withLinksNote } from './gdocs-tools.js';

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
  const page = pageBox(deck);
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
    slideSize: `${page.w}×${page.h} points`,
    revisionId: deck.revisionId,
    startLine: lines.startLine,
    endLine: lines.endLine,
    totalLines: lines.totalLines,
    nextStartLine: lines.nextStartLine,
    readNote: `${lines.readNote} Each slide line names its number and id; each element line its kind, id and "@x,y w×h" (points from the slide's top-left corner); ⏎ is a line break inside a text box.`,
    editHint: 'Change slides with gdrive_edit (fileId, edits: [{action: "replace_text", find, replace}] or set_text {element, text}, add_slide, delete_slide, move_slide, duplicate_slide, set_notes, add_image, add_shape, add_line, delete_element; slide = its number in this read or its id).',
    lines: lines.lines,
  }));
}

/** add_image edits, readied before anything changes: index → picture. */
async function readyPictures(env: GoogleToolEnv, edits: Record<string, unknown>[]): Promise<{ ok: true; pictures: Array<{ index: number; picture: PreparedPicture }> } | { ok: false; result: ToolResult }> {
  const pictures: Array<{ index: number; picture: PreparedPicture }> = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!edit || typeof edit !== 'object' || edit.action !== 'add_image') continue;
    if (pictures.length >= 10) return { ok: false, result: failedResult(env, invalid('At most 10 pictures in one call; add the rest in another call.')) };
    const spec = pictureSpecOf(edit.image, `edits[${index}].image`);
    if (!spec.ok) return { ok: false, result: failedResult(env, spec.failure) };
    const prepared = await preparePicture(spec.spec, env.local);
    if (!prepared.ok) return { ok: false, result: failedResult(env, { ...prepared.failure, message: `edits[${index}]: ${prepared.failure.message}` }) };
    pictures.push({ index, picture: prepared.picture });
  }
  // A picture BotBoy holds goes in through a temporary anyone-with-the-link copy: the owner's words first.
  const consent = temporaryLinkConsent(pictures.map(entry => entry.picture), env.context);
  if (consent) return { ok: false, result: failedResult(env, consent) };
  return { ok: true, pictures };
}

export async function slidesEdit(env: GoogleToolEnv, located: LocatedFile): Promise<ToolResult> {
  if (!Array.isArray(env.args.edits)) return failedResult(env, invalid('A deck takes edits: a list of {action, …} edits (replace_text, set_text, add_slide, …).'));
  const { accountId, file } = located;
  if (file.mimeType !== GDRIVE_SLIDES_MIME) return failedResult(env, invalid('This file is not Google Slides.'));
  const slides = env.workspaceFor(accountId)?.slides;
  if (!slides) return failedResult(env, { code: 'unavailable', message: 'Google Slides editing is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  const edits = env.args.edits as Record<string, unknown>[];
  const ready = await readyPictures(env, edits);
  if (!ready.ok) return ready.result;

  const run = async (addresses: string[][]): Promise<ToolResult> => {
    let choice = 0;
    let rereads = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      let deck: Presentation;
      try {
        deck = await slides.get(file.id);
      } catch (error) {
        return failedResult(env, googleErrorFailure(error, false, 'Google Slides read'));
      }
      const pictures = new Map<number, SlidePicture>(ready.pictures.map((entry, i) => {
        const candidates = addresses[i] ?? [];
        const picture = entry.picture;
        return [entry.index, { url: candidates[Math.min(choice, candidates.length - 1)], ...(picture.kind === 'bytes' ? { width: picture.width, height: picture.height } : {}) }];
      }));
      const plan = planSlideEdits(deck, edits, undefined, { pictures });
      if (!plan.ok) return failedResult(env, invalid(plan.message, undefined, 'Read the deck again with gdrive_read if a slide or element is unclear, fix that edit, and call once more; nothing changed.'));
      let replies: any[] = [];
      try {
        replies = (await slides.batchUpdate(file.id, plan.requests, deck.revisionId)).replies ?? [];
      } catch (error) {
        if (ready.pictures.length && choice === 0 && isPictureFetchFailure(error) && addresses.some(candidates => candidates.length > 1)) {
          // Google answered and wrote nothing (the batch is atomic): try each picture's other address.
          choice = 1;
          continue;
        }
        const failure = googleErrorFailure(error, true, 'Google Slides edit');
        if (failure.code === 'changed_since_read' && rereads === 0) { rereads++; continue; }
        if (failure.effect === 'unknown') return failedResult(env, { ...failure, nextAction: 'Do not send this again: read the deck with gdrive_read to see whether the change is there, then tell the owner.' });
        if (ready.pictures.length && isPictureFetchFailure(error)) {
          return failedResult(env, { ...failure, code: 'picture_fetch_failed', message: `Google could not fetch the picture to copy it: ${failure.message}`, nextAction: 'Nothing changed. Try once more; if it fails again, tell the owner.' });
        }
        return failedResult(env, failure);
      }
      // Google's count of replaced text, per replace_text edit, in request order.
      const counts = replies.map(reply => reply?.replaceAllText?.occurrencesChanged).filter(count => count !== undefined);
      let replaceIndex = 0;
      // Read back: every new picture, shape and line must now be on its slide.
      const added = plan.summary.filter(entry => entry.newElementId);
      let verified = true;
      if (added.length) {
        try {
          const after = await slides.get(file.id);
          const present = new Set(slideViews(after).flatMap(slide => slide.elements.map(element => element.objectId)));
          verified = added.every(entry => present.has(entry.newElementId!));
        } catch {
          verified = false;
        }
      }
      return googleResult(env.call, {
        ok: true,
        tool: 'gdrive_edit',
        status: 'applied',
        account: accountEmail(env, accountId),
        fileId: file.id,
        name: redactSecrets(file.name ?? ''),
        webViewLink: file.webViewLink,
        changes: plan.summary.map(entry => (entry.action === 'replace_text' ? { ...entry, replaced: counts[replaceIndex++] ?? entry.found } : entry)),
        ...(added.length ? { verified } : {}),
        ...(added.length && !verified ? { warning: 'BotBoy could not find every new element in a fresh read; check the deck with gdrive_read before telling the owner it is done.' } : {}),
        ...(rereads > 0 ? { note: 'Someone edited the deck while BotBoy worked; BotBoy read it again and applied the edits to the newer version.' } : {}),
      });
    }
    return failedResult(env, { code: 'changed_since_read', message: 'The deck kept changing while BotBoy tried to edit it, so nothing was changed.', effect: 'none', nextAction: 'Read it again with gdrive_read and try once more.' });
  };

  if (!ready.pictures.length) return run([]);
  try {
    const { value, links } = await withPictureLinks(located.drive, ready.pictures.map(entry => entry.picture), run);
    return withLinksNote(value, links);
  } catch (error) {
    return failedResult(env, { code: 'picture_upload_failed', message: `The picture could not be readied for Google: ${redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300)}`, effect: 'none', nextAction: 'Nothing changed in the deck. Try once more, or tell the owner.' });
  }
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
