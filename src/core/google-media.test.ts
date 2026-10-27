import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withGdriveChatTools } from './gdrive-chat-tools.js';
import { fakeGmailConnection, type FakeGmailAccount } from './gmail-connection.fake.js';
import { createFakeDrive, type FakeDrive } from './gdrive-api.fake.js';
import { DOCX_MIME, GDRIVE_DOC_MIME } from './gdrive-api.js';
import { GoogleApiError } from './gmail-api.js';
import { createFakeWorkspace, type FakeWorkspace } from './google-workspace.fake.js';
import { pictureSpecOf, preparePicture, withPictureLinks } from './google-media.js';
import { planSlideEdits } from './gslides-model.js';
import type { ToolExecutionContext } from './tool-executor.js';

const call = (name: string, args: object) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
/** The owner's chat turn, saying the temporary link is fine (gdrive_share's anyone-with-the-link rule). */
const live = (): ToolExecutionContext => ({ callerKind: 'interactive', currentUserMessage: 'add the chart, a temporary public link is fine', ownerRequestId: 'req-1' } as ToolExecutionContext);
/** The owner's chat turn without those words. */
const liveWithoutWords = (): ToolExecutionContext => ({ callerKind: 'interactive', currentUserMessage: 'add the chart', ownerRequestId: 'req-1' } as ToolExecutionContext);
const job: ToolExecutionContext = { callerKind: 'continuation', currentUserMessage: '[AUTOMATIC CONTINUATION]', jobMandate: { jobId: 'job-1', goal: 'build the deck' } } as ToolExecutionContext;
const chrome = fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

/** A PNG header Google and BotBoy read the size from. */
function png(width: number, height: number): Buffer {
  const head = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([head, size, Buffer.from('0802000000', 'hex'), Buffer.alloc(32)]);
}

let tmp: string;
let drive: FakeDrive;
let workspace: FakeWorkspace;
let filesDir: string;

function make(wordFromMarkdown?: any) {
  drive = createFakeDrive('jane@gmail.com', { fullAccess: true });
  workspace = createFakeWorkspace(drive);
  const account: FakeGmailAccount = { id: 'default', email: 'jane@gmail.com', canEditDrive: true, canUseCalendar: true, client: {} as any };
  const home = path.join(tmp, 'home');
  const privateRoot = path.join(home, '.personal-productivity-tracker');
  filesDir = path.join(privateRoot, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.writeFileSync(path.join(filesDir, 'chart.png'), png(800, 400));
  const executor = withGdriveChatTools({ executeTool: vi.fn() } as any, {
    connection: fakeGmailConnection([account]),
    drive: { clientFor: () => drive, readFile: vi.fn() } as any,
    workspaceFor: () => workspace,
    local: { homeDir: home, privateRoot, filesDir },
    now: () => Date.UTC(2026, 9, 24, 9, 0, 0),
    ...(wordFromMarkdown ? { wordFromMarkdown } : {}),
  });
  const run = async (name: string, args: object, context: ToolExecutionContext = live()) => {
    const result = await executor.executeTool(call(name, args), context);
    const parsed = JSON.parse(result.content);
    return { isError: result.isError, body: parsed.trust ? parsed.result : parsed };
  };
  return { run, home };
}

const ops = (op: string) => drive.calls.filter(entry => entry.op === op);

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-media-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function newDoc(run: ReturnType<typeof make>['run']): Promise<string> {
  const created = await run('gdrive_files', { action: 'create', kind: 'doc', name: 'Plan', content: '# Plan\nRevenue grew.\n- First point\n- Second point\n## Next', ownerRequested: true });
  expect(created.body).toMatchObject({ ok: true, from: 'markdown' });
  return created.body.fileId;
}

describe('pictures in Google Docs', () => {
  it('puts a picture in its own normal, centred paragraph after the one named, through a link that lives only for the insert', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    const result = await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', after: 'Plan', image: { path: '/api/files/chart.png' } }], ownerRequested: true });
    expect(result.body).toMatchObject({ ok: true, status: 'applied', picturesAdded: 1, verified: true, temporaryPictures: { uploaded: 1, removed: 1 } });
    expect(result.body.temporaryPictures.stillShared).toBeUndefined();
    expect(workspace.docs.lines(fileId).map(line => line.replace(/:list\d+/, ''))).toEqual([
      'HEADING_1||Plan', 'NORMAL_TEXT||[image]', 'NORMAL_TEXT||Revenue grew.', 'NORMAL_TEXT|ul0|First point', 'NORMAL_TEXT|ul0|Second point', 'HEADING_2||Next',
    ]);
    // The picture went up as a temporary file, was shared by link only for the insert, then unshared and trashed.
    const upload = ops('createFile').find(entry => (entry.args[0] as any).appProperties?.botboyTemporaryPicture)!;
    expect(upload.args[0]).toMatchObject({ name: expect.stringMatching(/^BotBoy picture \(temporary\)/), mediaMimeType: 'image/png', appProperties: { botboyTemporaryPicture: '1' } });
    const tempId = [...drive.files.values()].find(file => file.appProperties?.botboyTemporaryPicture)!.id;
    expect(ops('createPermission')[0].args.slice(0, 2)).toEqual([tempId, { type: 'anyone', role: 'reader', allowFileDiscovery: false }]);
    expect(ops('deletePermission')).toHaveLength(1);
    expect((drive.permissions.get(tempId) ?? []).filter(permission => permission.type === 'anyone')).toEqual([]);
    expect(drive.files.get(tempId)!.trashed).toBe(true);
    expect(workspace.docs.pictures(fileId)).toEqual([`https://drive.google.com/uc?export=view&id=${tempId}`]);
    // Its width: the picture's own (800 px = 600 pt) held to the page's text width.
    const request = (workspace.docs.calls.find(entry => entry.op === 'batchUpdate')!.requests as any[]).find(entry => entry.insertInlineImage);
    expect(request.insertInlineImage.objectSize).toEqual({ width: { magnitude: 468, unit: 'PT' } });
  });

  it('a picture after a list item or at the end is not a list item, and pictures keep their order', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    const result = await run('gdrive_edit', {
      fileId,
      edits: [
        { action: 'insert_image', after: 'First point', image: 'chart.png', width: 200 },
        { action: 'insert_image', after: 'First point', image: { url: 'https://example.com/b.png' } },
        { action: 'insert_image', at: 'end', image: { url: 'https://example.com/c.png' } },
        { find: 'Revenue grew.', replace: 'Revenue grew 15%.' },
      ],
      ownerRequested: true,
    });
    expect(result.body).toMatchObject({ ok: true, picturesAdded: 3, verified: true });
    expect(workspace.docs.lines(fileId).map(line => line.replace(/:list\d+/, ''))).toEqual([
      'HEADING_1||Plan', 'NORMAL_TEXT||Revenue grew 15%.', 'NORMAL_TEXT|ul0|First point', 'NORMAL_TEXT||[image]', 'NORMAL_TEXT||[image]', 'NORMAL_TEXT|ul0|Second point', 'HEADING_2||Next', 'NORMAL_TEXT||[image]',
    ]);
    const pictures = workspace.docs.pictures(fileId);
    expect(pictures[0]).toMatch(/^https:\/\/drive\.google\.com\/uc\?export=view&id=/);
    expect(pictures.slice(1)).toEqual(['https://example.com/b.png', 'https://example.com/c.png']);
    // A public link goes to Google as it is: one upload, for the local picture only.
    expect(ops('createFile').filter(entry => (entry.args[0] as any).appProperties?.botboyTemporaryPicture)).toHaveLength(1);
  });

  it('when Google cannot fetch from the first address it tries the other; when neither works nothing changes and the link is still removed', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    workspace.docs.refuseImageUri = uri => uri.includes('drive.google.com');
    const retried = await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', after: 'Revenue grew.', image: 'chart.png' }], ownerRequested: true });
    expect(retried.body).toMatchObject({ ok: true, picturesAdded: 1 });
    expect(workspace.docs.pictures(fileId)[0]).toMatch(/^https:\/\/lh3\.googleusercontent\.com\/d\//);
    workspace.docs.refuseImageUri = () => true;
    const before = workspace.docs.lines(fileId);
    const failed = await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', after: 'Revenue grew.', image: 'chart.png' }], ownerRequested: true });
    expect(failed.body).toMatchObject({ ok: false, code: 'picture_fetch_failed', effect: 'none', temporaryPictures: { uploaded: 1, removed: 1 } });
    expect(workspace.docs.lines(fileId)).toEqual(before);
    expect([...drive.files.values()].filter(file => file.appProperties?.botboyTemporaryPicture && !file.trashed)).toEqual([]);
  });

  it('if the sharing cannot be removed, the receipt says so with the file to fix', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    drive.failNext('deletePermission', new GoogleApiError('Drive unshare failed (HTTP 500)', 500, 'backendError'));
    const result = await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', after: 'Plan', image: 'chart.png' }], ownerRequested: true });
    expect(result.body).toMatchObject({ ok: true, temporaryPictures: { uploaded: 1, removed: 0, stillShared: [expect.any(String)], warning: expect.stringMatching(/Anyone with the link/) } });
  });

  it('checks the picture before anything changes: one source, a picture, BotBoy’s upload rules', async () => {
    const { run, home } = make();
    const fileId = await newDoc(run);
    fs.writeFileSync(path.join(filesDir, 'notes.txt'), 'words');
    fs.mkdirSync(path.join(home, '.secret'), { recursive: true });
    fs.writeFileSync(path.join(home, '.secret', 'p.png'), png(10, 10));
    const cases: Array<[object, string]> = [
      [{ action: 'insert_image', after: 'Plan' }, 'invalid_arguments'],
      [{ action: 'insert_image', after: 'Plan', image: { path: 'chart.png', url: 'https://x/y.png' } }, 'invalid_arguments'],
      [{ action: 'insert_image', image: 'chart.png' }, 'invalid_arguments'],
      [{ action: 'insert_image', after: 'Plan', image: 'notes.txt' }, 'picture_not_usable'],
      [{ action: 'insert_image', after: 'Plan', image: { url: 'http://example.com/a.png' } }, 'picture_not_usable'],
      [{ action: 'insert_image', after: 'Plan', image: { path: path.join(home, '.secret', 'p.png') } }, 'upload_not_allowed'],
    ];
    for (const [edit, code] of cases) {
      const result = await run('gdrive_edit', { fileId, edits: [edit], ownerRequested: true });
      expect(result.body.code, JSON.stringify(edit)).toBe(code);
    }
    expect(ops('createFile').filter(entry => (entry.args[0] as any).appProperties?.botboyTemporaryPicture)).toEqual([]);
    expect((await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', after: 'Plan', image: 'chart.png' }], append: '- more', ownerRequested: true })).body.code).toBe('invalid_arguments');
  });

  it('refuses a picture where a text edit takes in that paragraph’s line break', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    const result = await run('gdrive_edit', { fileId, edits: [{ find: 'grew.\n- First', replace: 'grew. First' }, { action: 'insert_image', after: 'Revenue grew.', image: { url: 'https://example.com/a.png' } }], ownerRequested: true });
    expect(result.body).toMatchObject({ code: 'edits_overlap', message: expect.stringMatching(/edits\[1\] puts a picture where edits\[0\]/) });
  });

  it('a picture BotBoy holds needs the owner’s own words for its temporary link; nothing is uploaded or shared without them', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    const before = workspace.docs.lines(fileId);
    for (const image of ['chart.png', { mermaid: 'flowchart LR\n A-->B' }]) {
      if (typeof image === 'object' && !chrome) continue;
      const refused = await run('gdrive_edit', { fileId, edits: [{ find: 'Revenue grew.', replace: 'Revenue grew 15%.' }, { action: 'insert_image', after: 'Plan', image }], ownerRequested: true }, liveWithoutWords());
      expect(refused.body).toMatchObject({ ok: false, code: 'owner_words_required', effect: 'none', nextAction: expect.stringMatching(/temporary public link/) });
    }
    // The whole call stopped before anything changed, the text edit included.
    expect(workspace.docs.lines(fileId)).toEqual(before);
    expect(ops('createFile').filter(entry => (entry.args[0] as any).appProperties?.botboyTemporaryPicture)).toEqual([]);
    expect(ops('createPermission')).toEqual([]);
    // A public link the owner gives is not BotBoy sharing anything: no words needed.
    expect((await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', at: 'end', image: { url: 'https://example.com/a.png' } }], ownerRequested: true }, liveWithoutWords())).body).toMatchObject({ ok: true, picturesAdded: 1 });
    expect(ops('createPermission')).toEqual([]);
  });

  it('a job inserts a picture from a public link like any other edit, but never lends one of BotBoy’s pictures a link', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    expect((await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', at: 'end', image: { url: 'https://example.com/a.png' } }], ownerRequested: true }, job)).body).toMatchObject({ ok: true, picturesAdded: 1 });
    // A job's trigger text is not the owner's words, whatever it says.
    const sayingPublic = { ...job, currentUserMessage: '[AUTOMATIC CONTINUATION] share it publicly' } as ToolExecutionContext;
    const before = workspace.docs.lines(fileId);
    for (const context of [job, sayingPublic]) {
      const refused = await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', at: 'end', image: 'chart.png' }], ownerRequested: true }, context);
      expect(refused.body).toMatchObject({ ok: false, code: 'outside_job_mandate', effect: 'none' });
    }
    expect(workspace.docs.lines(fileId)).toEqual(before);
    expect(ops('createFile').filter(entry => (entry.args[0] as any).appProperties?.botboyTemporaryPicture)).toEqual([]);
    expect(ops('createPermission')).toEqual([]);
  });

  it.skipIf(!chrome)('draws a Mermaid diagram into a PNG for Google (real Chrome)', async () => {
    const { run } = make();
    const fileId = await newDoc(run);
    const result = await run('gdrive_edit', { fileId, edits: [{ action: 'insert_image', after: 'Plan', image: { mermaid: 'flowchart LR\n A[Draft] --> B[Publish]' } }], ownerRequested: true });
    expect(result.body).toMatchObject({ ok: true, picturesAdded: 1, changes: [expect.objectContaining({ picture: true, from: 'mermaid' })] });
    const upload = ops('createFile').find(entry => (entry.args[0] as any).appProperties?.botboyTemporaryPicture)!;
    expect((upload.args[0] as any).media.toString('hex', 0, 8)).toBe('89504e470d0a1a0a');
  }, 60_000);
});

describe('Docs from Markdown with pictures go through Word', () => {
  it('creates the Doc from the Word file when the Markdown has pictures or diagrams, and from Markdown otherwise', async () => {
    const word = vi.fn(async (markdown: string) => (markdown.includes('![') ? { data: Buffer.from('PK-docx'), media: { pictures: 1, diagrams: 0, embedded: 1, problems: [] } } : null));
    const { run } = make(word);
    const withPicture = await run('gdrive_files', { action: 'create', kind: 'doc', name: 'Report', content: '# Report\n\n![Chart](chart.png)', ownerRequested: true });
    expect(withPicture.body).toMatchObject({ ok: true, from: 'markdown', via: 'word', pictures: 1 });
    const upload = ops('createFile').at(-1)!.args[0] as any;
    expect(upload).toMatchObject({ mimeType: GDRIVE_DOC_MIME, mediaMimeType: DOCX_MIME });
    expect(upload.media.toString()).toBe('PK-docx');
    const plain = await run('gdrive_files', { action: 'create', kind: 'doc', name: 'Plain', content: '# Plain', ownerRequested: true });
    expect(plain.body.via).toBeUndefined();
    expect((ops('createFile').at(-1)!.args[0] as any).mediaMimeType).toBe('text/markdown');
  });

  it('replacing a Doc’s whole content with pictures sends Word too', async () => {
    const word = vi.fn(async (markdown: string) => (markdown.includes('![') ? { data: Buffer.from('PK-docx'), media: { pictures: 1, diagrams: 1, embedded: 2, problems: [] } } : null));
    const { run } = make(word);
    const fileId = await newDoc(run);
    const revisionId = (await run('gdrive_read', { fileId })).body.revisionId;
    const replaced = await run('gdrive_edit', { fileId, content: '# New\n\n![Chart](chart.png)', revisionId, ownerRequested: true });
    expect(ops('updateMedia').at(-1)!.args[1]).toMatchObject({ mediaMimeType: DOCX_MIME });
    // The fake cannot convert Word, so the Doc shows fewer pictures than were sent: the receipt says to check.
    expect(replaced.body).toMatchObject({ ok: true, status: 'replaced', pictures: 1, diagrams: 1, verified: false, warning: expect.stringMatching(/check it with gdrive_read/) });
  });
});

describe('shapes, lines and pictures in Google Slides', () => {
  async function deck(run: ReturnType<typeof make>['run']): Promise<string> {
    const created = await run('gdrive_files', { action: 'create', kind: 'slides', name: 'Flow', ownerRequested: true });
    expect(created.body).toMatchObject({ ok: true, kind: 'slides' });
    return created.body.fileId;
  }

  it('draws two shapes joined by an arrow, places a picture, and reads them back with where they sit', async () => {
    const { run } = make();
    const fileId = await deck(run);
    const result = await run('gdrive_edit', {
      fileId,
      edits: [
        { action: 'add_shape', slide: 1, ref: 'a', shape: 'rounded', x: 60, y: 150, width: 160, height: 80, text: 'Draft', fill: '#e8f0fe', outline: '#1a73e8', fontSize: 18, bold: true },
        { action: 'add_shape', slide: 1, ref: 'b', shape: 'decision', x: 420, y: 140, width: 160, height: 100, text: 'Review' },
        { action: 'add_line', slide: 1, start: 'a', end: 'b' },
        { action: 'add_image', slide: 1, image: 'chart.png', x: 500, y: 20, width: 160 },
      ],
      ownerRequested: true,
    });
    expect(result.body).toMatchObject({ ok: true, status: 'applied', verified: true, temporaryPictures: { uploaded: 1, removed: 1 } });
    const [shapeA, shapeB, line, picture] = result.body.changes;
    expect(shapeA).toMatchObject({ action: 'add_shape', ref: 'a', newElementId: expect.stringMatching(/^botboy_sh_/), box: { x: 60, y: 150, w: 160, h: 80 } });
    expect(shapeB).toMatchObject({ ref: 'b' });
    // The arrow runs from A's right edge to B's left edge, at each one's middle.
    expect(line).toMatchObject({ action: 'add_line', box: { x: 220, y: 190, w: 200, h: 0 } });
    // The picture keeps its shape: 800×400 at 160 wide is 80 high.
    expect(picture).toMatchObject({ action: 'add_image', box: { x: 500, y: 20, w: 160, h: 80 } });
    const slide = workspace.slides.decks.get(fileId)!.slides[0];
    const shape = slide.elements.find(element => element.objectId === shapeA.newElementId)!;
    expect(shape).toMatchObject({ shapeType: 'ROUND_RECTANGLE', text: 'Draft' });
    expect(shape.props?.shape).toMatchObject({ shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 232 / 255 } } } }, contentAlignment: 'MIDDLE' });
    expect(shape.props?.text).toMatchObject({ fontSize: { magnitude: 18, unit: 'PT' }, bold: true });
    expect(slide.elements.find(element => element.objectId === shapeB.newElementId)!.shapeType).toBe('FLOW_CHART_DECISION');
    const arrow = slide.elements.find(element => element.objectId === line.newElementId)!;
    expect(arrow).toMatchObject({ kind: 'line', category: 'STRAIGHT' });
    expect(arrow.props?.line).toMatchObject({ endArrow: 'FILL_ARROW', startArrow: 'NONE' });
    expect(slide.elements.find(element => element.objectId === picture.newElementId)!.url).toMatch(/^https:\/\/drive\.google\.com\/uc\?export=view&id=/);
    const read = await run('gdrive_read', { fileId });
    expect(read.body.slideSize).toBe('720×405 points');
    expect(read.body.lines).toContain(`shape round_rectangle [id ${shapeA.newElementId}] @60,150 160×80: Draft`);
    expect(read.body.lines).toContain(`[image id ${picture.newElementId}] @500,20 160×80`);
  });

  it('a picture BotBoy holds needs the owner’s own words in Slides too, and the shapes in the same call wait', async () => {
    const { run } = make();
    const fileId = await deck(run);
    const elementsBefore = workspace.slides.decks.get(fileId)!.slides[0].elements.length;
    const refused = await run('gdrive_edit', {
      fileId,
      edits: [{ action: 'add_shape', slide: 1, shape: 'rectangle', x: 60, y: 60, width: 100, height: 50 }, { action: 'add_image', slide: 1, image: 'chart.png', x: 300, y: 60, width: 160 }],
      ownerRequested: true,
    }, liveWithoutWords());
    expect(refused.body).toMatchObject({ ok: false, code: 'owner_words_required', effect: 'none' });
    expect(workspace.slides.decks.get(fileId)!.slides[0].elements).toHaveLength(elementsBefore);
    expect(ops('createPermission')).toEqual([]);
    const inJob = await run('gdrive_edit', { fileId, edits: [{ action: 'add_image', slide: 1, image: 'chart.png' }], ownerRequested: true }, job);
    expect(inJob.body).toMatchObject({ ok: false, code: 'outside_job_mandate', effect: 'none' });
    expect(ops('createFile').filter(entry => (entry.args[0] as any).appProperties?.botboyTemporaryPicture)).toEqual([]);
  });

  it('a line that runs up and to the left is the same line, mirrored', () => {
    const deckRead = { presentationId: 'd', slides: [{ objectId: 's1', pageElements: [] }] } as any;
    const plan = planSlideEdits(deckRead, [{ action: 'add_line', slide: 1, start: [300, 200], end: [100, 50], line: 'bent', arrow: 'both', dash: 'dash', weight: 2, outline: '#ff0000' }], () => 'abc');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [create, style] = plan.requests as any[];
    expect(create.createLine).toMatchObject({
      objectId: 'botboy_l_abc',
      category: 'BENT',
      elementProperties: {
        pageObjectId: 's1',
        size: { width: { magnitude: 200 * 12700, unit: 'EMU' }, height: { magnitude: 150 * 12700, unit: 'EMU' } },
        transform: { scaleX: -1, scaleY: -1, translateX: 300 * 12700, translateY: 200 * 12700, unit: 'EMU' },
      },
    });
    expect(style.updateLineProperties.lineProperties).toMatchObject({ startArrow: 'FILL_ARROW', endArrow: 'FILL_ARROW', dashStyle: 'DASH', weight: { magnitude: 2, unit: 'PT' }, lineFill: { solidFill: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } } } });
  });

  it('says what is wrong with a shape or line before anything changes, and deletes an element', async () => {
    const { run } = make();
    const fileId = await deck(run);
    const bad: Array<[object, RegExp]> = [
      [{ action: 'add_shape', slide: 1, shape: 'blob' }, /not one BotBoy knows/],
      [{ action: 'add_shape', slide: 1, x: 900, y: 10 }, /off the slide/],
      [{ action: 'add_shape', slide: 1, fill: 'blue' }, /fill is a colour/],
      [{ action: 'add_line', slide: 1, start: [0, 0], end: 'nowhere' }, /not an element id/],
      [{ action: 'add_line', slide: 1, start: [5, 5], end: [5, 5] }, /same point/],
      [{ action: 'add_image', slide: 1 }, /image is required|names exactly one/],
      [{ action: 'delete_element', element: 'missing' }, /element is required/],
    ];
    for (const [edit, message] of bad) {
      const result = await run('gdrive_edit', { fileId, edits: [edit], ownerRequested: true });
      expect(result.body.message, JSON.stringify(edit)).toMatch(message);
    }
    const added = await run('gdrive_edit', { fileId, edits: [{ action: 'add_shape', slide: 1, shape: 'ellipse', text: 'Go' }], ownerRequested: true });
    const id = added.body.changes[0].newElementId;
    expect(added.body.changes[0].box).toEqual({ x: 260, y: 152.5, w: 200, h: 100 });
    const removed = await run('gdrive_edit', { fileId, edits: [{ action: 'delete_element', element: id }], ownerRequested: true });
    expect(removed.body).toMatchObject({ ok: true, changes: [{ action: 'delete_element', element: id }] });
    expect(workspace.slides.decks.get(fileId)!.slides[0].elements.some(element => element.objectId === id)).toBe(false);
  });

  it('a picture Google cannot fetch from the first address goes in from the other', async () => {
    const { run } = make();
    const fileId = await deck(run);
    workspace.slides.refuseImageUrl = url => url.includes('drive.google.com');
    const result = await run('gdrive_edit', { fileId, edits: [{ action: 'add_image', slide: 1, image: 'chart.png' }], ownerRequested: true });
    expect(result.body).toMatchObject({ ok: true, verified: true });
    const picture = workspace.slides.decks.get(fileId)!.slides[0].elements.find(element => element.kind === 'image')!;
    expect(picture.url).toMatch(/^https:\/\/lh3\.googleusercontent\.com\/d\//);
    // 800×400 px is 600×300 pt: held to 90% of the slide's width (648 pt) it stays 600×300, centred.
    expect(result.body.changes[0].box).toEqual({ x: 60, y: 52.5, w: 600, h: 300 });
  });
});

describe('charts in Google Sheets', () => {
  async function sheet(run: ReturnType<typeof make>['run']): Promise<string> {
    const created = await run('gdrive_files', { action: 'create', kind: 'sheet', name: 'Sales', rows: [['Month', 'Web', 'App'], ['Jan', 10, 4], ['Feb', 12, 6], ['Mar', 15, 9]], ownerRequested: true });
    return created.body.fileId;
  }

  it('adds a native column chart over the data, lists it in the read, and deletes it', async () => {
    const { run } = make();
    const fileId = await sheet(run);
    const added = await run('gdrive_edit', { fileId, edits: [{ action: 'add_chart', chart: 'column', range: 'A1:C4', title: 'Sales by month', stacked: true }], ownerRequested: true });
    expect(added.body).toMatchObject({ ok: true, chartsAdded: [expect.any(Number)], changes: [{ action: 'add_chart', chart: 'column', range: 'Sheet1!A1:C4' }] });
    const chartId = added.body.chartsAdded[0];
    const [stored] = workspace.sheets.books.get(fileId)!.tabs[0].charts!;
    expect(stored.spec).toMatchObject({ title: 'Sales by month', basicChart: { chartType: 'COLUMN', headerCount: 1, stackedType: 'STACKED' } });
    expect(stored.spec.basicChart.domains[0].domain.sourceRange.sources[0]).toEqual({ sheetId: 0, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 });
    expect(stored.spec.basicChart.series.map((entry: any) => entry.series.sourceRange.sources[0].startColumnIndex)).toEqual([1, 2]);
    // Next to the data by default: column D, the data's first row.
    expect(stored.position.overlayPosition.anchorCell).toEqual({ sheetId: 0, rowIndex: 0, columnIndex: 4 });
    const read = await run('gdrive_read', { fileId });
    expect(read.body.charts).toEqual([{ chartId, title: 'Sales by month', type: 'column' }]);
    const removed = await run('gdrive_edit', { fileId, edits: [{ action: 'delete_chart', chartId }], ownerRequested: true });
    expect(removed.body).toMatchObject({ ok: true });
    expect(workspace.sheets.books.get(fileId)!.tabs[0].charts).toEqual([]);
    expect((await run('gdrive_edit', { fileId, edits: [{ action: 'delete_chart', chartId }], ownerRequested: true })).body.message).toMatch(/no chart/);
  });

  it('a bar chart targets the bottom axis, a donut takes one value column without the header, and bad requests say why', async () => {
    const { run } = make();
    const fileId = await sheet(run);
    expect((await run('gdrive_edit', { fileId, edits: [{ action: 'add_chart', chart: 'bar', range: 'A1:B4', anchor: 'F10' }], ownerRequested: true })).body.ok).toBe(true);
    expect((await run('gdrive_edit', { fileId, edits: [{ action: 'add_chart', chart: 'donut', range: 'A1:B4' }], ownerRequested: true })).body.ok).toBe(true);
    const [bar, donut] = workspace.sheets.books.get(fileId)!.tabs[0].charts!;
    expect(bar.position.overlayPosition.anchorCell).toMatchObject({ rowIndex: 9, columnIndex: 5 });
    expect(donut.spec.pieChart).toMatchObject({ pieHole: 0.5, domain: { sourceRange: { sources: [{ startRowIndex: 1, endRowIndex: 4, startColumnIndex: 0 }] } } });
    const bad: Array<[object, RegExp]> = [
      [{ action: 'add_chart', chart: 'pie', range: 'A1:C4' }, /one value column/],
      [{ action: 'add_chart', chart: 'radar', range: 'A1:C4' }, /chart is one of/],
      [{ action: 'add_chart', range: 'A:C' }, /header row/],
      [{ action: 'add_chart', range: 'A1:A4' }, /value column/],
    ];
    for (const [edit, message] of bad) {
      expect((await run('gdrive_edit', { fileId, edits: [edit], ownerRequested: true })).body.message, JSON.stringify(edit)).toMatch(message);
    }
  });
});

describe('google-media helpers', () => {
  it('reads a bare string as a va_ id, a public link or a path', () => {
    expect(pictureSpecOf(`va_${'a'.repeat(32)}`)).toEqual({ ok: true, spec: { assetId: `va_${'a'.repeat(32)}` } });
    expect(pictureSpecOf('https://example.com/a.png')).toEqual({ ok: true, spec: { url: 'https://example.com/a.png' } });
    expect(pictureSpecOf('shots/a.png')).toEqual({ ok: true, spec: { path: 'shots/a.png' } });
    expect(pictureSpecOf({}).ok).toBe(false);
  });

  it('refuses a picture larger than Google’s 25 megapixels', async () => {
    make();
    fs.writeFileSync(path.join(filesDir, 'huge.png'), png(6000, 5000));
    const prepared = await preparePicture({ path: 'huge.png' }, { homeDir: path.join(tmp, 'home'), privateRoot: path.join(tmp, 'home', '.personal-productivity-tracker'), filesDir });
    expect(prepared).toMatchObject({ ok: false, failure: { code: 'picture_not_usable', message: expect.stringMatching(/25 megapixels/) } });
  });

  it('removes the sharing and trashes the file even when the insert throws', async () => {
    make();
    const picture = { kind: 'bytes' as const, buffer: png(4, 4), mime: 'image/png' as const, width: 4, height: 4, from: 'x' };
    await expect(withPictureLinks(drive, [picture], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const temp = [...drive.files.values()].find(file => file.appProperties?.botboyTemporaryPicture)!;
    expect(temp.trashed).toBe(true);
    expect((drive.permissions.get(temp.id) ?? []).filter(permission => permission.type === 'anyone')).toEqual([]);
  });
});
