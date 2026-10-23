import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleGuidanceBlock, googleWriteConfirmed, withGdriveChatTools } from './gdrive-chat-tools.js';
import { fakeGmailConnection, type FakeGmailAccount } from './gmail-connection.fake.js';
import { createFakeDrive, type FakeDrive } from './gdrive-api.fake.js';
import { GDRIVE_DOC_MIME, GDRIVE_FOLDER_MIME, GDRIVE_FORM_MIME, GDRIVE_SHEET_MIME, GDRIVE_SLIDES_MIME } from './gdrive-api.js';
import { GoogleApiError } from './gmail-api.js';
import { createFakeWorkspace, type FakeWorkspace } from './google-workspace.fake.js';
import { createPromptManager } from './prompt-manager.js';
import type { ToolExecutionContext } from './tool-executor.js';

const call = (name: string, args: object) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const live = (message = 'please do it'): ToolExecutionContext => ({ callerKind: 'interactive', currentUserMessage: message, ownerRequestId: 'req-1' } as ToolExecutionContext);
const job: ToolExecutionContext = { callerKind: 'continuation', currentUserMessage: '[AUTOMATIC CONTINUATION]', jobMandate: { jobId: 'job-1', goal: 'tidy the plan' } } as ToolExecutionContext;
// Built at run time from split pieces (as in gmail-attachments.test.ts), so no token-shaped literal lives in the repository.
const FAKE_GITHUB_TOKEN = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');

let tmp: string;
let drive: FakeDrive;
let workspace: FakeWorkspace;
let account: FakeGmailAccount;

function make(overrides: Partial<FakeGmailAccount> = {}) {
  drive = createFakeDrive('jane@gmail.com', { fullAccess: true });
  workspace = createFakeWorkspace(drive);
  account = { id: 'default', email: 'jane@gmail.com', canEditDrive: true, canUseCalendar: true, client: {} as any, ...overrides };
  const readFile = vi.fn(async (_id: string, fileId: string) => {
    const file = await drive.getFile(fileId);
    const withheld = file.name === 'credentials.json';
    const content = withheld ? 'Content withheld' : `SOURCE: Google Drive\nFile: ${file.name}\n\n${drive.files.get(fileId)!.content.toString('utf8')}`;
    return { file, content, tier: withheld ? 'withheld' : 'full', withheld };
  });
  const base = { executeTool: vi.fn(async () => ({ toolCallId: 'c1', content: 'base', isError: false })) };
  const home = path.join(tmp, 'home');
  const privateRoot = path.join(home, '.personal-productivity-tracker');
  fs.mkdirSync(path.join(privateRoot, 'files'), { recursive: true });
  const executor = withGdriveChatTools(base as any, {
    connection: fakeGmailConnection([account]),
    drive: { clientFor: () => drive, readFile } as any,
    workspaceFor: () => workspace,
    local: { homeDir: home, privateRoot, filesDir: path.join(privateRoot, 'files') },
    now: () => Date.UTC(2026, 9, 23, 9, 0, 0),
  });
  /** null = no context at all; omitted = a live owner turn. */
  const run = async (name: string, args: object, context?: ToolExecutionContext | null) => {
    const result = await executor.executeTool(call(name, args), context === null ? undefined : context ?? live());
    const parsed = JSON.parse(result.content);
    return { isError: result.isError, body: parsed.trust ? { ...parsed.result, envelope: true } : parsed };
  };
  return { executor, base, readFile, run, home, privateRoot };
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tools-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('who may use the Google tools', () => {
  it('refuses BotBoy’s own background runs, and lets a task the owner started only read', async () => {
    const { run } = make();
    drive.put({ id: 'note1xxxxx', name: 'Notes.txt', content: Buffer.from('hello') });
    expect((await run('gdrive_read', { fileId: 'note1xxxxx' }, { callerKind: 'background' } as ToolExecutionContext)).body.code).toBe('owner_turn_required');
    expect((await run('gdrive_read', { fileId: 'note1xxxxx' }, null)).body.code).toBe('owner_turn_required');
    const ownerRun = { ownerStartedRun: true, currentUserMessage: 'edit passage' } as ToolExecutionContext;
    expect((await run('gdrive_read', { fileId: 'note1xxxxx' }, ownerRun)).isError).toBe(false);
    expect((await run('gdrive_files', { action: 'rename', fileId: 'note1xxxxx', name: 'x', ownerRequested: true }, ownerRun)).body.code).toBe('owner_turn_required');
  });

  it('writes need ownerRequested; a job may write like the document tools, but never share, comment or publish', async () => {
    const { run } = make();
    drive.put({ id: 'note1xxxxx', name: 'Notes.txt', content: Buffer.from('hello') });
    expect((await run('gdrive_files', { action: 'rename', fileId: 'note1xxxxx', name: 'New' })).body.code).toBe('owner_request_required');
    const renamed = await run('gdrive_files', { action: 'rename', fileId: 'note1xxxxx', name: 'Renamed.txt', ownerRequested: true }, job);
    expect(renamed.body).toMatchObject({ ok: true, status: 'renamed' });
    expect((await run('gdrive_read', { fileId: 'note1xxxxx' }, job)).isError).toBe(false);
    for (const args of [
      { action: 'add', fileId: 'note1xxxxx', email: 'ana@example.com', role: 'reader', ownerRequested: true },
      { action: 'comment', fileId: 'note1xxxxx', text: 'hi', ownerRequested: true },
    ]) {
      expect((await run('gdrive_share', args, job)).body.code).toBe('outside_job_mandate');
    }
    expect((await run('gdrive_edit', { fileId: 'note1xxxxx', publish: 'publish', ownerRequested: true }, job)).body.code).toBe('outside_job_mandate');
    expect((await run('gdrive_share', { action: 'list', fileId: 'note1xxxxx' }, job)).isError).toBe(false);
  });

  it('names the next step when the account can only read Drive, or has no Calendar', async () => {
    const { run } = make({ canEditDrive: false, canReadDrive: true, canPublishDrive: true, canUseCalendar: false });
    const created = await run('gdrive_files', { action: 'create', kind: 'doc', name: 'Plan', ownerRequested: true });
    expect(created.body).toMatchObject({ code: 'drive_edit_not_allowed', effect: 'none', nextAction: expect.stringMatching(/Connect Google Drive/) });
    expect((await run('gcalendar', { action: 'events' })).body.code).toBe('calendar_not_connected');
  });

  it('passes other tools through untouched', async () => {
    const { executor, base } = make();
    await executor.executeTool(call('query_db', {}), live());
    expect(base.executeTool).toHaveBeenCalledTimes(1);
  });
});

describe('gdrive_search', () => {
  it('finds by words, lists a folder and the trash, and wraps results as untrusted data', async () => {
    const { run } = make();
    drive.put({ id: 'fold1xxxxx', name: 'Plans', mimeType: GDRIVE_FOLDER_MIME });
    drive.put({ id: 'doc11xxxxx', name: 'Launch plan', mimeType: GDRIVE_DOC_MIME, parents: ['fold1xxxxx'] });
    drive.put({ id: 'old11xxxxx', name: 'Old plan', trashed: true });
    const words = await run('gdrive_search', { query: 'Launch' });
    expect(words.body.envelope).toBe(true);
    expect(words.body.files.map((file: any) => [file.fileId, file.kind])).toEqual([['doc11xxxxx', 'doc']]);
    expect((await run('gdrive_search', { folderId: 'fold1xxxxx' })).body.files.map((file: any) => file.fileId)).toEqual(['doc11xxxxx']);
    expect((await run('gdrive_search', { trashed: true })).body.files.map((file: any) => file.fileId)).toEqual(['old11xxxxx']);
    expect((await run('gdrive_search', {})).body.code).toBe('invalid_arguments');
    expect((await run('gdrive_search', { query: 'x', limit: 51 })).body.code).toBe('invalid_arguments');
  });
});

describe('Docs', () => {
  async function doc(run: ReturnType<typeof make>['run']) {
    const created = await run('gdrive_files', { action: 'create', kind: 'doc', name: 'Plan', content: '# Plan\nRevenue grew 12%.\n## Goals\n- Ship Drive tools', ownerRequested: true });
    expect(created.body).toMatchObject({ ok: true, status: 'created', kind: 'doc', from: 'markdown' });
    return created.body.fileId as string;
  }

  it('creates a Google Doc from Markdown, reads it as numbered lines, and edits a part in place', async () => {
    const { run } = make();
    const fileId = await doc(run);
    const read = await run('gdrive_read', { fileId });
    expect(read.body).toMatchObject({ envelope: true, kind: 'doc', revisionId: 'rev-1', totalLines: 4 });
    expect(read.body.lines).toBe('1: # Plan\n2: Revenue grew 12%.\n3: ## Goals\n4: - Ship Drive tools');
    const edited = await run('gdrive_edit', { fileId, edits: [{ find: 'grew 12%', replace: 'grew 15%' }], append: '- Then Sheets', ownerRequested: true });
    expect(edited.body).toMatchObject({ ok: true, status: 'applied', verified: true });
    expect(workspace.docs.lines(fileId).map(line => line.replace(/:list\d+/, ''))).toEqual([
      'HEADING_1||Plan', 'NORMAL_TEXT||Revenue grew 15%.', 'HEADING_2||Goals', 'NORMAL_TEXT|ul0|Ship Drive tools', 'NORMAL_TEXT|ul0|Then Sheets',
    ]);
    expect(googleWriteConfirmed('gdrive_edit', JSON.stringify(edited.body))).toBe(true);
  });

  it('a find that is not in the Doc changes nothing and says what to do', async () => {
    const { run } = make();
    const fileId = await doc(run);
    const failed = await run('gdrive_edit', { fileId, edits: [{ find: 'Nowhere', replace: 'x' }], ownerRequested: true });
    expect(failed.body).toMatchObject({ ok: false, code: 'edit_not_found', effect: 'none', nextAction: expect.stringMatching(/gdrive_read/) });
    expect(workspace.docs.calls.filter(entry => entry.op === 'batchUpdate')).toHaveLength(0);
  });

  it('replacing the whole Doc needs the revision of the read, and refuses one someone changed since', async () => {
    const { run } = make();
    const fileId = await doc(run);
    expect((await run('gdrive_edit', { fileId, content: '# New', ownerRequested: true })).body.code).toBe('invalid_arguments');
    workspace.docs.touch(fileId);
    expect((await run('gdrive_edit', { fileId, content: '# New', revisionId: 'rev-1', ownerRequested: true })).body.code).toBe('changed_since_read');
    const replaced = await run('gdrive_edit', { fileId, content: '# Fresh start\nOne line.', revisionId: 'rev-2', ownerRequested: true });
    expect(replaced.body).toMatchObject({ ok: true, status: 'replaced' });
    expect(workspace.docs.lines(fileId)).toEqual(['HEADING_1||Fresh start', 'NORMAL_TEXT||One line.']);
  });

  it('when someone edits between BotBoy’s read and its write, it reads again and applies the edit once', async () => {
    const { run } = make();
    const fileId = await doc(run);
    const original = workspace.docs.get.bind(workspace.docs);
    let reads = 0;
    workspace.docs.get = async (id: string) => { const result = await original(id); if (++reads === 1) workspace.docs.touch(id); return result; };
    const edited = await run('gdrive_edit', { fileId, edits: [{ find: 'Goals', replace: 'Targets' }], ownerRequested: true });
    expect(edited.body).toMatchObject({ ok: true, note: expect.stringMatching(/read it again/) });
    expect(workspace.docs.lines(fileId)[2]).toBe('HEADING_2||Targets');
  });
});

describe('Sheets', () => {
  async function sheet(run: ReturnType<typeof make>['run']) {
    const created = await run('gdrive_files', { action: 'create', kind: 'sheet', name: 'Budget', rows: [['Region', 'Revenue'], ['EMEA', 1200], ['APAC', 900]], ownerRequested: true });
    expect(created.body).toMatchObject({ ok: true, kind: 'sheet', from: 'rows' });
    return created.body.fileId as string;
  }

  it('reads rows with cell addresses, sets cells guarded by expect, appends, and adds a tab', async () => {
    const { run } = make();
    const fileId = await sheet(run);
    const read = await run('gdrive_read', { fileId });
    expect(read.body).toMatchObject({ kind: 'sheet', sheet: 'Sheet1' });
    expect(read.body.lines.split('\n').slice(0, 4)).toEqual(['cols: ' + read.body.lines.split('\n')[0].slice(6), '1: Region | Revenue', '2: EMEA | 1200', '3: APAC | 900']);
    const stale = await run('gdrive_edit', { fileId, edits: [{ action: 'set', range: 'B2', values: [[1500]], expect: [[1000]] }], ownerRequested: true });
    expect(stale.body).toMatchObject({ code: 'changed_since_read', mismatches: [{ cell: 'B2', expected: '1000', actual: '1200' }] });
    const edited = await run('gdrive_edit', {
      fileId,
      edits: [
        { action: 'set', range: 'B2', values: [[1500]], expect: [[1200]] },
        { action: 'append', values: [['LATAM', 300]] },
        { action: 'add_sheet', name: 'Notes' },
        { action: 'set', range: 'Notes!A1', values: [['=SUM(Sheet1!B2:B4)']] },
      ],
      ownerRequested: true,
    });
    expect(edited.body).toMatchObject({ ok: true, status: 'applied', updatedCells: 2 });
    expect(workspace.sheets.cell(fileId, 'Sheet1', 'B2')?.typed).toBe(1500);
    expect(workspace.sheets.cell(fileId, 'Sheet1', 'A4')?.typed).toBe('LATAM');
    expect(workspace.sheets.cell(fileId, 'Notes', 'A1')?.typed).toBe('=SUM(Sheet1!B2:B4)');
    // Structure first, then values.
    const ops = workspace.sheets.calls.map(entry => entry.op).filter(op => op !== 'get' && op !== 'valuesBatchGet');
    expect(ops.slice(-3)).toEqual(['batchUpdate', 'valuesBatchUpdate', 'valuesAppend']);
  });

  it('grows the grid first when a write reaches past the tab’s last row or column (Google refuses it otherwise)', async () => {
    const { run } = make();
    const fileId = await sheet(run);
    const edited = await run('gdrive_edit', { fileId, edits: [{ action: 'set', range: 'AB1', values: [['far right']] }, { action: 'set', range: 'A1002', values: [['far down']] }], ownerRequested: true });
    expect(edited.body).toMatchObject({ ok: true, status: 'applied', updatedCells: 2 });
    expect(workspace.sheets.cell(fileId, 'Sheet1', 'AB1')?.typed).toBe('far right');
    expect(workspace.sheets.cell(fileId, 'Sheet1', 'A1002')?.typed).toBe('far down');
    const appended = (workspace.sheets.calls.find(entry => entry.op === 'batchUpdate')!.args[1] as any[]).map(request => request.appendDimension);
    expect(appended).toEqual([{ sheetId: 0, dimension: 'COLUMNS', length: 2 }, { sheetId: 0, dimension: 'ROWS', length: 2 }]);
    // A read past the tab's end says so instead of asking Google for a range it refuses.
    expect((await run('gdrive_read', { fileId, startLine: 5000 })).body.code).toBe('invalid_arguments');
  });

  it('refuses a bad edit before anything changes', async () => {
    const { run } = make();
    const fileId = await sheet(run);
    const before = workspace.sheets.calls.length;
    const failed = await run('gdrive_edit', { fileId, edits: [{ action: 'set', range: 'B2', values: [[1]] }, { action: 'rename_sheet', sheet: 'Nope', name: 'X' }], ownerRequested: true });
    expect(failed.body).toMatchObject({ code: 'invalid_arguments', message: expect.stringMatching(/edits\[1\].*no tab named "Nope"/) });
    expect(workspace.sheets.calls.slice(before).map(entry => entry.op)).toEqual(['get']);
  });
});

describe('Slides', () => {
  it('builds a deck from an outline, reads slides with ids, and edits text and order in one write', async () => {
    const { run } = make();
    const created = await run('gdrive_files', { action: 'create', kind: 'slides', name: 'Review', content: '# Q3 review\n# Agenda\n- Wins\n- Next\n# Thanks', ownerRequested: true });
    expect(created.body).toMatchObject({ ok: true, kind: 'slides', slidesAdded: 3 });
    const fileId = created.body.fileId as string;
    const read = await run('gdrive_read', { fileId });
    expect(read.body).toMatchObject({ kind: 'slides', slides: 3, revisionId: expect.any(String) });
    expect(read.body.lines).toMatch(/1: Slide 1 \(id botboy_s_\w+, layout title\)/);
    expect(read.body.lines).toMatch(/body \[id botboy_b_\w+\]: Wins⏎Next/);
    const edited = await run('gdrive_edit', {
      fileId,
      edits: [{ action: 'replace_text', find: 'Wins', replace: 'Big wins' }, { action: 'move_slide', slide: 3, to: 1 }, { action: 'set_notes', slide: 2, text: 'Say hello' }],
      ownerRequested: true,
    });
    expect(edited.body).toMatchObject({ ok: true, status: 'applied', changes: [{ action: 'replace_text', replaced: 1 }, { action: 'move_slide' }, { action: 'set_notes' }] });
    const deck = workspace.slides.decks.get(fileId)!;
    expect(deck.slides.map(slide => slide.elements[0]?.text)).toEqual(['Thanks', 'Q3 review', 'Agenda']);
    expect(deck.slides[2].elements[1].text).toBe('Big wins\nNext');
    // Slide numbers mean the deck as read: slide 2 was Agenda, now third.
    expect(deck.slides[2].notesText).toBe('Say hello');
    expect(deck.slides[1].notesText).toBe('');
  });
});

describe('Forms', () => {
  it('creates a form with questions (unpublished), edits items, reads answers, and publishes only in the owner’s turn', async () => {
    const { run } = make();
    const created = await run('gdrive_files', {
      action: 'create', kind: 'form', name: 'Team survey', content: 'Tell us how it went',
      questions: [{ type: 'short_answer', title: 'Your name', required: true }, { type: 'multiple_choice', title: 'Rating', options: ['Good', 'Okay', 'Bad'] }],
      ownerRequested: true,
    });
    expect(created.body).toMatchObject({ ok: true, kind: 'form', questions: 2, published: false });
    const fileId = created.body.fileId as string;
    expect(drive.files.get(fileId)?.mimeType).toBe(GDRIVE_FORM_MIME);
    const read = await run('gdrive_read', { fileId });
    expect(read.body.lines).toMatch(/1: Form: Team survey — not published/);
    expect(read.body.lines).toMatch(/1\. \[item it\d+\] short answer, required: Your name/);
    expect(read.body.lines).toMatch(/options: Good \| Okay \| Bad/);
    const edited = await run('gdrive_edit', { fileId, edits: [{ action: 'update_question', item: 2, options: ['Great', 'Fine'] }, { action: 'add_section', title: 'Part 2' }], publish: 'publish', ownerRequested: true });
    expect(edited.body).toMatchObject({ ok: true, publish: 'publish', publishState: { isPublished: true, isAcceptingResponses: true } });
    workspace.forms.responses.set(fileId, [{ responseId: 'r1', lastSubmittedTime: '2026-10-23T08:00:00Z', answers: { [workspace.forms.forms.get(fileId)!.items![0].questionItem!.question!.questionId!]: { textAnswers: { answers: [{ value: 'Ana' }] } } } }]);
    const answers = await run('gdrive_read', { fileId, responses: true });
    expect(answers.body).toMatchObject({ responses: 1 });
    expect(answers.body.lines).toBe('1: 2026-10-23T08:00:00Z — Your name: Ana');
  });

  it('a question that does not fit creates no form', async () => {
    const { run } = make();
    const failed = await run('gdrive_files', { action: 'create', kind: 'form', name: 'Bad', questions: [{ type: 'multiple_choice', title: 'Pick' }], ownerRequested: true });
    expect(failed.body).toMatchObject({ code: 'invalid_arguments', message: expect.stringMatching(/options/) });
    expect(workspace.forms.forms.size).toBe(0);
  });
});

describe('gdrive_files', () => {
  it('a repeat of the same create in one request returns the first file, and an unclear answer is resolved by the file’s key', async () => {
    const { run } = make();
    const first = await run('gdrive_files', { action: 'create', kind: 'folder', name: 'Q4', ownerRequested: true });
    const again = await run('gdrive_files', { action: 'create', kind: 'folder', name: 'Q4', ownerRequested: true });
    expect(again.body).toMatchObject({ fileId: first.body.fileId, repeated: true });
    expect([...drive.files.values()].filter(file => file.name === 'Q4')).toHaveLength(1);
    drive.failNext('createFolder', new GoogleApiError('Drive folder create timed out', 0, 'timeout'), { afterEffect: true });
    const lost = await run('gdrive_files', { action: 'create', kind: 'folder', name: 'Q5', ownerRequested: true });
    expect(lost.body).toMatchObject({ ok: true, status: 'created', note: expect.stringMatching(/found the new file by its key/) });
    expect([...drive.files.values()].filter(file => file.name === 'Q5')).toHaveLength(1);
  });

  it('uploads any local file in chunks, converts on request, and replaces a file’s content in place', async () => {
    const { run, home } = make();
    const docs = path.join(home, 'Documents');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'data.json'), JSON.stringify({ a: 1 }));
    fs.writeFileSync(path.join(docs, 'table.csv'), 'a,b\n1,2\n');
    const uploaded = await run('gdrive_files', { action: 'upload', path: '~/Documents/data.json', ownerRequested: true });
    expect(uploaded.body).toMatchObject({ ok: true, status: 'uploaded', name: 'data.json', mimeType: 'application/json', verified: 'sha256' });
    const converted = await run('gdrive_files', { action: 'upload', path: path.join(docs, 'table.csv'), convertTo: 'sheet', ownerRequested: true });
    expect(converted.body).toMatchObject({ ok: true, kind: 'sheet', name: 'table', verified: 'converted' });
    expect(workspace.sheets.cell(converted.body.fileId, 'Sheet1', 'B2')?.typed).toBe(2);
    fs.writeFileSync(path.join(docs, 'data.json'), JSON.stringify({ a: 2 }));
    const replaced = await run('gdrive_files', { action: 'upload', path: path.join(docs, 'data.json'), replaceFileId: uploaded.body.fileId, ownerRequested: true });
    expect(replaced.body).toMatchObject({ ok: true, status: 'replaced', fileId: uploaded.body.fileId });
    expect(drive.files.get(uploaded.body.fileId)!.content.toString()).toBe('{"a":2}');
  });

  it('never uploads credentials, hidden files, BotBoy’s private data, or a file holding a secret', async () => {
    const { run, home, privateRoot } = make();
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(home, 'id_rsa'), 'x');
    fs.writeFileSync(path.join(privateRoot, 'tracker.db'), 'x');
    fs.writeFileSync(path.join(home, 'keys.txt'), `deploy token: ${FAKE_GITHUB_TOKEN}`);
    for (const file of ['~/.ssh/notes.txt', '~/id_rsa', path.join(privateRoot, 'tracker.db'), '~/keys.txt']) {
      const refused = await run('gdrive_files', { action: 'upload', path: file, ownerRequested: true });
      expect(refused.body.code, file).toBe('upload_not_allowed');
    }
    expect(drive.calls.filter(entry => entry.op === 'startUpload')).toHaveLength(0);
  });

  it('downloads into BotBoy’s files (Google files exported), or a named folder, never over an existing file', async () => {
    const { run, home, privateRoot } = make();
    drive.put({ id: 'img11xxxxx', name: 'photo.png', mimeType: 'image/png', content: Buffer.from([137, 80, 78, 71]) });
    drive.put({ id: 'doc22xxxxx', name: 'Brief', mimeType: GDRIVE_DOC_MIME, exports: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': Buffer.from('docx-bytes'), 'application/pdf': Buffer.from('pdf') } });
    const image = await run('gdrive_files', { action: 'download', fileId: 'img11xxxxx' });
    expect(image.body).toMatchObject({ ok: true, status: 'downloaded', filesPath: path.join('gdrive', 'photo.png'), bytes: 4 });
    const again = await run('gdrive_files', { action: 'download', fileId: 'img11xxxxx' });
    expect(again.body.filesPath).toBe(path.join('gdrive', 'photo (2).png'));
    const exported = await run('gdrive_files', { action: 'download', fileId: 'doc22xxxxx' });
    expect(exported.body).toMatchObject({ exportedAs: 'docx', filesPath: path.join('gdrive', 'Brief.docx') });
    expect(fs.readFileSync(path.join(privateRoot, 'files', 'gdrive', 'Brief.docx'), 'utf8')).toBe('docx-bytes');
    fs.mkdirSync(path.join(home, 'Downloads'));
    // Saving outside BotBoy's files is a write: it needs ownerRequested.
    expect((await run('gdrive_files', { action: 'download', fileId: 'doc22xxxxx', format: 'pdf', saveTo: '~/Downloads' })).body.code).toBe('owner_request_required');
    const saved = await run('gdrive_files', { action: 'download', fileId: 'doc22xxxxx', format: 'pdf', saveTo: '~/Downloads', ownerRequested: true });
    expect(saved.body.path).toBe(path.join(home, 'Downloads', 'Brief.pdf'));
    expect((await run('gdrive_files', { action: 'download', fileId: 'doc22xxxxx', saveTo: privateRoot, ownerRequested: true })).body.code).toBe('download_not_allowed');
  });

  it('a downloaded file that holds a secret is removed again', async () => {
    const { run, privateRoot } = make();
    drive.put({ id: 'env11xxxxx', name: 'config.txt', mimeType: 'text/plain', content: Buffer.from(`token: ${FAKE_GITHUB_TOKEN}`) });
    const held = await run('gdrive_files', { action: 'download', fileId: 'env11xxxxx' });
    expect(held.body.code).toBe('download_not_allowed');
    expect(fs.readdirSync(path.join(privateRoot, 'files', 'gdrive'))).toEqual([]);
  });

  it('an upload or a copy repeated in one request after a restart finds the first one in Drive too', async () => {
    const first = make();
    const docsDir = path.join(first.home, 'Documents');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'data.json'), '{"a":1}');
    drive.put({ id: 'word2xxxxx', name: 'R.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('docx') });
    const upload = { action: 'upload', path: '~/Documents/data.json', ownerRequested: true };
    const copy = { action: 'copy', fileId: 'word2xxxxx', convertTo: 'doc', ownerRequested: true };
    const uploaded = await first.run('gdrive_files', upload);
    const copied = await first.run('gdrive_files', copy);
    expect(copied.body).toMatchObject({ ok: true, status: 'copied', kind: 'doc', convertedTo: 'doc' });
    const restarted = withGdriveChatTools({ executeTool: vi.fn() } as any, {
      connection: fakeGmailConnection([account]),
      drive: { clientFor: () => drive, readFile: vi.fn() } as any,
      workspaceFor: () => workspace,
      local: { homeDir: first.home, privateRoot: first.privateRoot, filesDir: path.join(first.privateRoot, 'files') },
    });
    const again = async (args: object) => JSON.parse((await restarted.executeTool(call('gdrive_files', args), live())).content);
    expect(await again(upload)).toMatchObject({ ok: true, fileId: uploaded.body.fileId, repeated: true });
    expect(await again(copy)).toMatchObject({ ok: true, fileId: copied.body.fileId, repeated: true });
    expect([...drive.files.values()].filter(file => file.name === 'data.json')).toHaveLength(1);
    expect(drive.calls.filter(entry => entry.op === 'copyFile')).toHaveLength(1);
  });

  it('the same create in one request after a restart finds the first one in Drive instead of making a second', async () => {
    const first = make();
    const created = await first.run('gdrive_files', { action: 'create', kind: 'doc', name: 'Notes', content: '# Notes', ownerRequested: true });
    // A new executor (BotBoy restarted) on the same Drive and the same owner request.
    const executor = withGdriveChatTools({ executeTool: vi.fn() } as any, {
      connection: fakeGmailConnection([account]),
      drive: { clientFor: () => drive, readFile: vi.fn() } as any,
      workspaceFor: () => workspace,
    });
    const again = JSON.parse((await executor.executeTool(call('gdrive_files', { action: 'create', kind: 'doc', name: 'Notes', content: '# Notes', ownerRequested: true }), live())).content);
    expect(again).toMatchObject({ ok: true, fileId: created.body.fileId, repeated: true });
    expect([...drive.files.values()].filter(file => file.name === 'Notes')).toHaveLength(1);
    // Another owner request is another create.
    const other = JSON.parse((await executor.executeTool(call('gdrive_files', { action: 'create', kind: 'doc', name: 'Notes', content: '# Notes', ownerRequested: true }), { ...live(), ownerRequestId: 'req-2' } as ToolExecutionContext)).content);
    expect(other.fileId).not.toBe(created.body.fileId);
  });

  it('moves a file to My Drive (root) without leaving it in no folder', async () => {
    const { run } = make();
    drive.put({ id: 'fold3xxxxx', name: 'Inbox', mimeType: GDRIVE_FOLDER_MIME });
    drive.put({ id: 'file9xxxxx', name: 'a.txt', parents: ['fold3xxxxx'] });
    drive.put({ id: 'file8xxxxx', name: 'b.txt', parents: ['root'] });
    expect((await run('gdrive_files', { action: 'move', fileIds: ['file9xxxxx', 'file8xxxxx'], folderId: 'root', ownerRequested: true })).body).toMatchObject({ ok: true, status: 'moved' });
    expect(drive.files.get('file9xxxxx')!.parents).toEqual(['root']);
    expect(drive.files.get('file8xxxxx')!.parents).toEqual(['root']);
    expect((await run('gdrive_files', { action: 'move', fileId: 'file9xxxxx', folderId: 'file8xxxxx', ownerRequested: true })).body.code).toBe('invalid_arguments');
  });

  it('renames, moves, copies (converting Office files), trashes and restores', async () => {
    const { run } = make();
    drive.put({ id: 'fold2xxxxx', name: 'Archive', mimeType: GDRIVE_FOLDER_MIME });
    drive.put({ id: 'word1xxxxx', name: 'Report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('docx') });
    expect((await run('gdrive_files', { action: 'move', fileId: 'word1xxxxx', folderId: 'fold2xxxxx', ownerRequested: true })).body).toMatchObject({ ok: true, status: 'moved' });
    expect(drive.files.get('word1xxxxx')!.parents).toEqual(['fold2xxxxx']);
    const copy = await run('gdrive_files', { action: 'copy', fileId: 'word1xxxxx', convertTo: 'doc', name: 'Report', ownerRequested: true });
    expect(copy.body).toMatchObject({ ok: true, status: 'copied', convertedTo: 'doc' });
    const trashed = await run('gdrive_files', { action: 'trash', fileIds: ['word1xxxxx', copy.body.fileId], ownerRequested: true });
    expect(trashed.body).toMatchObject({ ok: true, status: 'trashed', restore: expect.stringMatching(/30 days/) });
    expect(drive.files.get('word1xxxxx')!.trashed).toBe(true);
    await run('gdrive_files', { action: 'restore', fileId: 'word1xxxxx', ownerRequested: true });
    expect(drive.files.get('word1xxxxx')!.trashed).toBe(false);
  });
});

describe('gdrive_share', () => {
  it('shares with a person, and with anyone only when the owner’s own message says so', async () => {
    const { run } = make();
    drive.put({ id: 'doc33xxxxx', name: 'Brief', mimeType: GDRIVE_DOC_MIME });
    const person = await run('gdrive_share', { action: 'add', fileId: 'doc33xxxxx', email: 'Ana@Example.com', role: 'commenter', ownerRequested: true });
    expect(person.body).toMatchObject({ ok: true, status: 'shared', added: { type: 'user', role: 'commenter', email: 'ana@example.com' } });
    const refused = await run('gdrive_share', { action: 'add', fileId: 'doc33xxxxx', anyone: true, role: 'reader', ownerRequested: true }, live('share the brief with Ana'));
    expect(refused.body).toMatchObject({ code: 'owner_words_required', effect: 'none' });
    const open = await run('gdrive_share', { action: 'add', fileId: 'doc33xxxxx', anyone: true, role: 'reader', ownerRequested: true }, live('make it viewable by anyone with the link'));
    expect(open.body).toMatchObject({ ok: true, reach: expect.stringMatching(/Anyone with the link/) });
    const removed = await run('gdrive_share', { action: 'remove', fileId: 'doc33xxxxx', email: 'ana@example.com', ownerRequested: true });
    expect(removed.body.permissions.map((entry: any) => entry.type).sort()).toEqual(['anyone', 'user']);
    expect((await run('gdrive_share', { action: 'remove', fileId: 'doc33xxxxx', permissionId: 'owner', ownerRequested: true })).body.code).toBe('invalid_arguments');
  });

  it('reads and writes comments with BotBoy’s mark', async () => {
    const { run } = make();
    drive.put({ id: 'doc44xxxxx', name: 'Spec', mimeType: GDRIVE_DOC_MIME });
    const added = await run('gdrive_share', { action: 'comment', fileId: 'doc44xxxxx', text: 'Please check the numbers', quote: 'Revenue grew', ownerRequested: true });
    expect(added.body).toMatchObject({ ok: true, status: 'commented' });
    await run('gdrive_share', { action: 'resolve', fileId: 'doc44xxxxx', commentId: added.body.commentId, ownerRequested: true });
    const listed = await run('gdrive_share', { action: 'comments', fileId: 'doc44xxxxx' });
    expect(listed.body.comments).toEqual([expect.objectContaining({ text: '🤖 Please check the numbers', on: 'Revenue grew', resolved: true })]);
  });
});

describe('gcalendar', () => {
  it('lists, creates once (a repeat finds the same event), answers, and keeps guests out of jobs', async () => {
    const { run } = make();
    const created = await run('gcalendar', { action: 'create', summary: 'Plan review', start: '2026-10-24T15:00', durationMinutes: 30, timeZone: 'Asia/Kolkata', meet: true, ownerRequested: true });
    expect(created.body).toMatchObject({ ok: true, status: 'created', event: { summary: 'Plan review', start: '2026-10-24T15:00:00', end: '2026-10-24T15:30:00', timeZone: 'Asia/Kolkata', meet: expect.stringMatching(/^https:/) } });
    const again = await run('gcalendar', { action: 'create', summary: 'Plan review', start: '2026-10-24T15:00', durationMinutes: 30, timeZone: 'Asia/Kolkata', meet: true, ownerRequested: true });
    expect(again.body.event.eventId).toBe(created.body.event.eventId);
    expect(workspace.calendar.events.size).toBe(1);
    const allDay = await run('gcalendar', { action: 'create', summary: 'Offsite', start: '2026-10-30', ownerRequested: true });
    expect(allDay.body.event).toMatchObject({ start: '2026-10-30', end: '2026-10-31' });
    const listed = await run('gcalendar', { action: 'events', from: '2026-10-24', to: '2026-10-31' });
    expect(listed.body.events.map((event: any) => event.summary)).toEqual(['Plan review', 'Offsite']);
    // A job may change its own events, but not one with guests.
    expect((await run('gcalendar', { action: 'update', eventId: created.body.event.eventId, location: 'Room 4', ownerRequested: true }, job)).body).toMatchObject({ ok: true, status: 'updated' });
    expect((await run('gcalendar', { action: 'update', eventId: created.body.event.eventId, attendees: ['ana@example.com'], ownerRequested: true }, job)).body.code).toBe('outside_job_mandate');
    const invited = await run('gcalendar', { action: 'update', eventId: created.body.event.eventId, attendees: ['ana@example.com'], ownerRequested: true });
    expect(invited.body).toMatchObject({ ok: true, notified: ['ana@example.com'] });
    expect((await run('gcalendar', { action: 'delete', eventId: created.body.event.eventId, ownerRequested: true }, job)).body.code).toBe('outside_job_mandate');
    expect((await run('gcalendar', { action: 'delete', eventId: created.body.event.eventId, ownerRequested: true })).body).toMatchObject({ ok: true, status: 'deleted' });
  });

  it('refuses times it cannot read', async () => {
    const { run } = make();
    const bad = await run('gcalendar', { action: 'create', summary: 'x', start: 'tomorrow 3pm', ownerRequested: true });
    expect(bad.body).toMatchObject({ code: 'invalid_arguments', issues: [{ path: 'start' }] });
  });
});

describe('prompt: the Google tools and guidance follow the connection', () => {
  it('offers the Drive tools only with Drive, gcalendar only with Calendar, and says what BotBoy can do', () => {
    const manager = createPromptManager();
    const names = (context: object) => manager.getToolDefinitions('chat', context as any).map(def => def.function.name);
    expect(names({})).not.toContain('gdrive_search');
    expect(names({ driveConnected: true })).toEqual(expect.arrayContaining(['gdrive_search', 'gdrive_read', 'gdrive_edit', 'gdrive_files', 'gdrive_share']));
    expect(names({ driveConnected: true })).not.toContain('gcalendar');
    expect(names({ driveConnected: true, calendarConnected: true })).toContain('gcalendar');
    expect(names({ driveConnected: true, amazonEmployee: false })).toContain('gdrive_files');
    expect(manager.getSystemPrompt('chat', { nodes: [] } as any)).not.toContain('## Google Drive');
    const full = manager.getSystemPrompt('chat', { nodes: [], driveConnected: true, driveEditable: true, calendarConnected: true } as any);
    expect(full).toContain(googleGuidanceBlock({ edit: true, calendar: true }));
    expect(full).toContain('You CAN create Google Docs, Sheets, Slides decks, Forms and folders');
    expect(full).toContain('Never say BotBoy cannot create or edit Google files: call the tool, and if it fails, report its exact error.');
    const readOnly = manager.getSystemPrompt('chat', { nodes: [], driveConnected: true } as any);
    expect(readOnly).toContain('presses Connect Google Drive again');
    expect(readOnly).toContain('Calendar is not connected');
  });
});
