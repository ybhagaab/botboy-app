/**
 * Google Forms in chat (google-workspace.md, "Forms"): gdrive_read shows a
 * form as numbered items with their ids (responses: true shows the answers),
 * and gdrive_edit on a form adds, changes, moves and deletes questions, sections and
 * text, sets the title and description, and publishes.
 *
 * Forms the API creates start unpublished (Google, after 2026-06-30): they
 * take no answers until published. Publishing, unpublishing, opening and
 * closing reach responders, so they are owner-turn actions ("reach"); who may
 * answer is gdrive_share with responder: true. Item positions in one call are
 * planned in order, each against the form as the earlier edits leave it.
 */

import type { ToolResult } from './tool-executor.js';
import { GDRIVE_FORM_MIME, type DriveFile } from './gdrive-api.js';
import { redactSecrets } from './sensitive-files.js';
import type { FormItem, FormQuestion, FormResponse, GoogleForm } from './google-workspace-api.js';
import { googleErrorFailure, googleResult, invalid, numberedLines, untrustedEnvelope, type GoogleTier } from './google-tool-support.js';
import { accountEmail, failedResult, type GoogleToolEnv, type LocatedFile } from './google-tool-env.js';

export const QUESTION_TYPES = ['short_answer', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'linear_scale', 'date', 'time', 'rating'] as const;
export const FORM_ACTIONS = ['set_info', 'add_question', 'add_section', 'add_text', 'update_question', 'delete_item', 'move_item'] as const;
const PUBLISH = { publish: { isPublished: true, isAcceptingResponses: true }, unpublish: { isPublished: false, isAcceptingResponses: false }, open: { isPublished: true, isAcceptingResponses: true }, close: { isPublished: true, isAcceptingResponses: false } } as const;

export function formsEditTier(args: Record<string, unknown>): GoogleTier {
  return args.publish !== undefined && args.publish !== null && args.publish !== '' ? 'reach' : 'write';
}

function questionKind(question: FormQuestion | undefined): string {
  if (!question) return 'question';
  if (question.textQuestion) return question.textQuestion.paragraph ? 'paragraph' : 'short answer';
  if (question.choiceQuestion) return question.choiceQuestion.type === 'CHECKBOX' ? 'checkboxes' : question.choiceQuestion.type === 'DROP_DOWN' ? 'dropdown' : 'multiple choice';
  if (question.scaleQuestion) return `linear scale ${question.scaleQuestion.low ?? 1}–${question.scaleQuestion.high ?? 5}`;
  if (question.dateQuestion) return question.dateQuestion.includeTime ? 'date and time' : 'date';
  if (question.timeQuestion) return question.timeQuestion.duration ? 'duration' : 'time';
  if (question.ratingQuestion) return `rating 1–${question.ratingQuestion.ratingScaleLevel ?? 5}`;
  if (question.fileUploadQuestion) return 'file upload';
  return 'question';
}

/** One line per item: "N: [item id] kind, required: Title — options: A | B". */
export function formViewLines(form: GoogleForm): string[] {
  const state = form.publishSettings?.publishState;
  const lines = [
    `Form: ${form.info?.title ?? ''} — ${state ? (state.isPublished ? (state.isAcceptingResponses ? 'published, taking answers' : 'published, closed to answers') : 'not published (takes no answers)') : 'publish state unknown'}${form.settings?.quizSettings?.isQuiz ? ', quiz' : ''}`,
    ...(form.info?.description ? [`Description: ${form.info.description.replace(/\n/g, '⏎')}`] : []),
  ];
  (form.items ?? []).forEach((item, i) => {
    let kind = 'item';
    let detail = '';
    if (item.questionItem) {
      const question = item.questionItem.question;
      kind = `${questionKind(question)}${question?.required ? ', required' : ''}`;
      const options = question?.choiceQuestion?.options;
      if (options?.length) detail = ` — options: ${options.map(option => (option.isOther ? 'Other' : option.value ?? '')).join(' | ')}`;
    } else if (item.questionGroupItem) {
      kind = 'grid';
      detail = ` — rows: ${(item.questionGroupItem.questions ?? []).map(question => question.rowQuestion?.title ?? '').join(' | ')}`;
    } else if (item.pageBreakItem) kind = 'section';
    else if (item.textItem) kind = 'text';
    else if (item.imageItem) kind = 'image';
    else if (item.videoItem) kind = 'video';
    lines.push(`${i + 1}. [item ${item.itemId ?? '?'}] ${kind}: ${(item.title ?? '').replace(/\n/g, '⏎')}${item.description ? ` (${item.description.replace(/\n/g, '⏎')})` : ''}${detail}`);
  });
  return lines;
}

interface QuestionInput {
  type?: unknown; title?: unknown; description?: unknown; required?: unknown; options?: unknown; other?: unknown;
  low?: unknown; high?: unknown; lowLabel?: unknown; highLabel?: unknown; includeTime?: unknown; levels?: unknown;
}

/** A Forms API question from the tool's flat shape. */
export function questionFrom(input: QuestionInput, where: string): { ok: true; item: FormItem } | { ok: false; message: string } {
  const type = String(input.type ?? '');
  if (!(QUESTION_TYPES as readonly string[]).includes(type)) return { ok: false, message: `${where}.type must be one of: ${QUESTION_TYPES.join(', ')}.` };
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 1000) return { ok: false, message: `${where}.title is the question (1 to 1,000 characters).` };
  const question: FormQuestion = { required: input.required === true };
  if (type === 'short_answer' || type === 'paragraph') question.textQuestion = { paragraph: type === 'paragraph' };
  if (type === 'multiple_choice' || type === 'checkboxes' || type === 'dropdown') {
    const options = Array.isArray(input.options) ? input.options.map(option => String(option ?? '').trim()).filter(Boolean) : [];
    if (!options.length || options.length > 200) return { ok: false, message: `${where}.options is a list of 1 to 200 choices.` };
    if (new Set(options).size !== options.length) return { ok: false, message: `${where}.options must not repeat a choice.` };
    if (input.other === true && type === 'dropdown') return { ok: false, message: `${where}: a dropdown cannot have an "Other" choice.` };
    question.choiceQuestion = {
      type: type === 'checkboxes' ? 'CHECKBOX' : type === 'dropdown' ? 'DROP_DOWN' : 'RADIO',
      options: [...options.map(value => ({ value })), ...(input.other === true ? [{ isOther: true }] : [])],
    };
  }
  if (type === 'linear_scale') {
    const low = input.low === undefined ? 1 : Number(input.low);
    const high = input.high === undefined ? 5 : Number(input.high);
    if (![0, 1].includes(low) || !Number.isInteger(high) || high < 2 || high > 10) return { ok: false, message: `${where}: low is 0 or 1 and high is 2 to 10.` };
    question.scaleQuestion = { low, high, ...(typeof input.lowLabel === 'string' ? { lowLabel: input.lowLabel } : {}), ...(typeof input.highLabel === 'string' ? { highLabel: input.highLabel } : {}) };
  }
  if (type === 'date') question.dateQuestion = { includeTime: input.includeTime === true, includeYear: true };
  if (type === 'time') question.timeQuestion = { duration: false };
  if (type === 'rating') {
    const levels = input.levels === undefined ? 5 : Number(input.levels);
    if (!Number.isInteger(levels) || levels < 3 || levels > 10) return { ok: false, message: `${where}.levels is 3 to 10.` };
    question.ratingQuestion = { ratingScaleLevel: levels, iconType: 'STAR' };
  }
  return { ok: true, item: { title, ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}), questionItem: { question } } };
}

export interface FormPlan {
  ok: true;
  requests: unknown[];
  summary: Array<{ edit: number; action: string; item?: string; at?: number }>;
}

/** Plan edits in order; each item position counts on the form as the earlier edits leave it. */
export function planFormEdits(form: GoogleForm, edits: readonly Record<string, unknown>[]): FormPlan | { ok: false; message: string } {
  if (!Array.isArray(edits) || edits.length > 100) return { ok: false, message: 'edits must be a list of at most 100 edits.' };
  const items: Array<{ id: string | null; item: FormItem }> = (form.items ?? []).map(item => ({ id: item.itemId ?? null, item }));
  // An item number means the form as read (like slide numbers); at and to count the form as the earlier edits leave it.
  const asRead = items.map(entry => entry.id);
  const requests: unknown[] = [];
  const summary: FormPlan['summary'] = [];
  const itemIndex = (ref: unknown, where: string): number | string => {
    let id: string | null;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref ?? ''))) {
      const n = Number(ref);
      if (!Number.isInteger(n) || n < 1 || n > asRead.length) return `${where} ${ref} does not exist; the form had ${asRead.length} items when read.`;
      id = asRead[n - 1];
    } else {
      id = String(ref ?? '').trim();
    }
    const at = items.findIndex(entry => entry.id !== null && entry.id === id);
    if (at >= 0) return at;
    return asRead.includes(id) ? `${where} was deleted earlier in this call.` : `${where} "${String(id).slice(0, 60)}" is not an item id from the read.`;
  };
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const where = `edits[${index}]`;
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return { ok: false, message: `${where} must be an object with an action.` };
    const action = String(edit.action ?? '');
    if (!(FORM_ACTIONS as readonly string[]).includes(action)) return { ok: false, message: `${where}.action must be one of: ${FORM_ACTIONS.join(', ')}.` };
    if (action === 'set_info') {
      const fields: string[] = [];
      const info: Record<string, string> = {};
      if (typeof edit.title === 'string') { info.title = edit.title.trim(); fields.push('title'); }
      if (typeof edit.description === 'string') { info.description = edit.description; fields.push('description'); }
      if (!fields.length || (fields.includes('title') && !info.title)) return { ok: false, message: `${where}: set_info needs title (not empty) and/or description.` };
      requests.push({ updateFormInfo: { info, updateMask: fields.join(',') } });
      summary.push({ edit: index, action });
      continue;
    }
    const position = (fallback: number): number | string => {
      if (edit.at === undefined) return fallback;
      const at = Number(edit.at);
      if (!Number.isInteger(at) || at < 1 || at > items.length + 1) return `${where}.at is a position from 1 to ${items.length + 1}.`;
      return at - 1;
    };
    if (action === 'add_question' || action === 'add_section' || action === 'add_text') {
      let item: FormItem;
      if (action === 'add_question') {
        const built = questionFrom(edit as QuestionInput, where);
        if (!built.ok) return built;
        item = built.item;
      } else {
        const title = typeof edit.title === 'string' ? edit.title.trim() : '';
        if (!title) return { ok: false, message: `${where}.title is required.` };
        item = { title, ...(typeof edit.description === 'string' && edit.description.trim() ? { description: edit.description.trim() } : {}), ...(action === 'add_section' ? { pageBreakItem: {} } : { textItem: {} }) };
      }
      const at = position(items.length);
      if (typeof at === 'string') return { ok: false, message: at };
      requests.push({ createItem: { item, location: { index: at } } });
      items.splice(at, 0, { id: null, item });
      summary.push({ edit: index, action, at: at + 1 });
      continue;
    }
    const found = itemIndex(edit.item, `${where}.item`);
    if (typeof found === 'string') return { ok: false, message: found };
    const target = items[found];
    if (target.id === null) return { ok: false, message: `${where}.item was added in this call; change it in a second call once it exists.` };
    if (action === 'delete_item') {
      requests.push({ deleteItem: { location: { index: found } } });
      items.splice(found, 1);
      summary.push({ edit: index, action, item: target.id });
      continue;
    }
    if (action === 'move_item') {
      const to = Number(edit.to);
      if (!Number.isInteger(to) || to < 1 || to > items.length) return { ok: false, message: `${where}.to is the new position, 1 to ${items.length}.` };
      requests.push({ moveItem: { originalLocation: { index: found }, newLocation: { index: to - 1 } } });
      items.splice(found, 1);
      items.splice(to - 1, 0, target);
      summary.push({ edit: index, action, item: target.id, at: to });
      continue;
    }
    // update_question: only the fields given change.
    const question = target.item.questionItem?.question;
    const masks: string[] = [];
    const next: FormItem = JSON.parse(JSON.stringify(target.item));
    if (typeof edit.title === 'string') { if (!edit.title.trim()) return { ok: false, message: `${where}.title may not be empty.` }; next.title = edit.title.trim(); masks.push('title'); }
    if (typeof edit.description === 'string') { next.description = edit.description; masks.push('description'); }
    if (edit.required !== undefined) {
      if (!question) return { ok: false, message: `${where}: item ${target.id} is not a question; only questions are required or not.` };
      next.questionItem!.question!.required = edit.required === true;
      masks.push('questionItem.question.required');
    }
    if (edit.options !== undefined) {
      if (!question?.choiceQuestion) return { ok: false, message: `${where}: item ${target.id} has no choices to set.` };
      const options: string[] = Array.isArray(edit.options) ? (edit.options as unknown[]).map((option: unknown) => String(option ?? '').trim()).filter(Boolean) : [];
      if (!options.length || new Set(options).size !== options.length) return { ok: false, message: `${where}.options is a list of distinct choices.` };
      const keepOther = question.choiceQuestion.options?.some(option => option.isOther) && edit.other !== false;
      next.questionItem!.question!.choiceQuestion!.options = [...options.map((value: string) => ({ value })), ...(keepOther || edit.other === true ? [{ isOther: true }] : [])];
      masks.push('questionItem.question.choiceQuestion.options');
    }
    if (!masks.length) return { ok: false, message: `${where}: give title, description, required and/or options to change.` };
    delete (next as { itemId?: string }).itemId;
    requests.push({ updateItem: { item: { ...next, itemId: target.id }, location: { index: found }, updateMask: masks.join(',') } });
    target.item = next;
    summary.push({ edit: index, action, item: target.id });
  }
  return { ok: true, requests, summary };
}

function answersText(response: FormResponse, titles: Map<string, string>): string {
  const parts: string[] = [];
  for (const [questionId, answer] of Object.entries(response.answers ?? {})) {
    const values = answer.textAnswers?.answers?.map(entry => entry.value ?? '') ?? answer.fileUploadAnswers?.answers?.map(entry => `[file ${entry.fileName ?? entry.fileId ?? ''}]`) ?? [];
    parts.push(`${titles.get(questionId) ?? questionId}: ${values.join(', ').replace(/\n/g, '⏎')}`);
  }
  return parts.join(' ; ');
}

export async function readForm(env: GoogleToolEnv, accountId: string, file: DriveFile): Promise<ToolResult> {
  const forms = env.workspaceFor(accountId)?.forms;
  if (!forms) return failedResult(env, { code: 'unavailable', message: 'Google Forms is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  let form: GoogleForm;
  try {
    form = await forms.get(file.id);
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, false, 'Google Forms read'));
  }
  const base = {
    ok: true,
    fileId: file.id,
    name: redactSecrets(file.name ?? form.info?.title ?? ''),
    kind: 'form',
    account: accountEmail(env, accountId),
    webViewLink: file.webViewLink,
    ...(form.responderUri ? { responderUri: form.responderUri } : {}),
    revisionId: form.revisionId,
  };
  if (env.args.responses === true) {
    const titles = new Map<string, string>();
    for (const item of form.items ?? []) {
      const id = item.questionItem?.question?.questionId;
      if (id) titles.set(id, item.title ?? id);
      for (const question of item.questionGroupItem?.questions ?? []) if (question.questionId) titles.set(question.questionId, `${item.title ?? ''} / ${question.rowQuestion?.title ?? ''}`);
    }
    const responses: FormResponse[] = [];
    try {
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const listed = await forms.listResponses(file.id, { pageSize: 500, ...(pageToken ? { pageToken } : {}) });
        responses.push(...listed.responses);
        pageToken = listed.nextPageToken;
        if (!pageToken) break;
      }
    } catch (error) {
      return failedResult(env, googleErrorFailure(error, false, 'Google Forms responses'));
    }
    responses.sort((a, b) => String(a.lastSubmittedTime ?? '').localeCompare(String(b.lastSubmittedTime ?? '')));
    const lines = numberedLines(responses.map(response => redactSecrets(`${response.lastSubmittedTime ?? response.createTime ?? ''}${response.respondentEmail ? ` ${response.respondentEmail}` : ''} — ${answersText(response, titles)}`)), { startLine: env.args.startLine, endLine: env.args.endLine });
    if (!lines.ok) return failedResult(env, lines.failure);
    return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id }, {
      ...base,
      responses: responses.length,
      startLine: lines.startLine,
      endLine: lines.endLine,
      nextStartLine: lines.nextStartLine,
      readNote: `${lines.readNote} One line per response, oldest first: time, respondent (when collected), then "question: answer" pairs.`,
      lines: lines.lines,
    }));
  }
  const lines = numberedLines(formViewLines(form).map(line => redactSecrets(line)), { startLine: env.args.startLine, endLine: env.args.endLine });
  if (!lines.ok) return failedResult(env, lines.failure);
  return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id }, {
    ...base,
    items: (form.items ?? []).length,
    startLine: lines.startLine,
    endLine: lines.endLine,
    nextStartLine: lines.nextStartLine,
    readNote: `${lines.readNote} Item lines: "N. [item id] kind: title". Answers: gdrive_read with responses: true.`,
    editHint: 'Change it with gdrive_edit (fileId, edits: [{action: "add_question", type, title, options}] or update_question / delete_item / move_item with item = its number in this read or its id).',
    lines: lines.lines,
  }));
}

export async function formsEdit(env: GoogleToolEnv, located: LocatedFile): Promise<ToolResult> {
  const publish = env.args.publish === undefined || env.args.publish === null || env.args.publish === '' ? null : String(env.args.publish);
  if (publish !== null && !(publish in PUBLISH)) return failedResult(env, invalid('publish is publish, unpublish, open or close.'));
  const edits = env.args.edits === undefined ? [] : env.args.edits;
  if (!Array.isArray(edits)) return failedResult(env, invalid('A form takes edits: a list of {action, …} edits (add_question, update_question, …).'));
  if (!edits.length && publish === null) return failedResult(env, invalid('Send edits and/or publish.'));
  const { accountId, file } = located;
  if (file.mimeType !== GDRIVE_FORM_MIME) return failedResult(env, invalid('This file is not a Google Form.'));
  const forms = env.workspaceFor(accountId)?.forms;
  if (!forms) return failedResult(env, { code: 'unavailable', message: 'Google Forms is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  let form: GoogleForm;
  try {
    form = await forms.get(file.id);
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, false, 'Google Forms read'));
  }
  const plan = planFormEdits(form, edits as Record<string, unknown>[]);
  if (!plan.ok) return failedResult(env, invalid(plan.message, undefined, 'Read the form again with gdrive_read if an item is unclear, fix that edit, and call once more; nothing changed.'));
  let published: unknown;
  try {
    if (plan.requests.length) await forms.batchUpdate(file.id, plan.requests, form.revisionId);
  } catch (error) {
    const failure = googleErrorFailure(error, true, 'Google Forms edit');
    return failedResult(env, failure.effect === 'unknown' ? { ...failure, nextAction: 'Do not send this again: read the form with gdrive_read to see whether the change is there.' } : failure);
  }
  if (publish !== null) {
    try {
      published = await forms.setPublishState(file.id, PUBLISH[publish as keyof typeof PUBLISH]);
    } catch (error) {
      const failure = googleErrorFailure(error, true, 'Google Forms publish');
      return failedResult(env, { ...failure, message: `${plan.requests.length ? 'The edits were applied, but ' : ''}${failure.message}`, ...(plan.requests.length ? { effect: failure.effect } : {}) });
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
    ...(form.responderUri ? { responderUri: form.responderUri } : {}),
    changes: plan.summary,
    ...(publish !== null ? { publish, publishState: (published as { publishState?: unknown })?.publishState ?? PUBLISH[publish as keyof typeof PUBLISH] } : {}),
    ...(publish === 'publish' ? { note: 'Published: people with responder access can answer. Choose who with gdrive_share action add responder: true (email, or anyone: true for a public link).' } : {}),
  });
}

/** gdrive_files action create kind form: the form, its description, and its first questions. */
export async function createFormWithQuestions(env: GoogleToolEnv, accountId: string, input: { name: string; description: string; questions: unknown }): Promise<{ formId: string; questions: number; responderUri?: string }> {
  const forms = env.workspaceFor(accountId)?.forms;
  if (!forms) throw new Error('Google Forms is unavailable in this BotBoy build.');
  const edits: Record<string, unknown>[] = [];
  if (input.description.trim()) edits.push({ action: 'set_info', description: input.description });
  if (input.questions !== undefined) {
    if (!Array.isArray(input.questions) || input.questions.length > 100) throw new Error('questions must be a list of at most 100 questions.');
    for (const question of input.questions) edits.push({ action: 'add_question', ...(question as Record<string, unknown>) });
  }
  // Validate before the form exists, so a bad question creates nothing.
  const dryRun = planFormEdits({ formId: 'new', items: [] }, edits);
  if (!dryRun.ok) throw Object.assign(new Error(dryRun.message), { botboyInvalid: true });
  const form = await forms.create({ title: input.name, documentTitle: input.name });
  if (dryRun.requests.length) await forms.batchUpdate(form.formId, dryRun.requests);
  return { formId: form.formId, questions: edits.filter(edit => edit.action === 'add_question').length, ...(form.responderUri ? { responderUri: form.responderUri } : {}) };
}
