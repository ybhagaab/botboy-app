import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  attachmentReceipt,
  reattachStored,
  resolveAttachments,
  storedAttachment,
  type AttachmentPolicy,
  type AttachmentProblems,
} from './gmail-attachments.js';
import { MAX_ATTACHMENT_BYTES } from './gmail-mime.js';

/**
 * What BotBoy may attach to an email (GMAIL_CHAT_TOOLS_PLAN.md §13), against a
 * temporary home: files by path, chat images by id, and every refusal.
 */

// Synthetic secrets are built at run time from split prefixes (as in
// sensitive-files.test.ts), so no token-shaped literal lives in the repository.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function chars(count: number, seed: number): string {
  const random = seeded(seed);
  let out = '';
  for (let index = 0; index < count; index++) out += ALNUM[Math.floor(random() * ALNUM.length)];
  return out;
}
const FAKE_GITHUB_TOKEN = ['gh', 'p_', chars(36, 1)].join('');

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ASSET = { chat: `va_${'a'.repeat(32)}`, screenshot: `va_${'b'.repeat(32)}`, chat2: `va_${'c'.repeat(32)}` };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');

function fakeImages() {
  const images: Record<string, { mime: 'image/png' | 'image/jpeg'; ownerKind: 'chat_attachment' | 'browser_screenshot'; bytes: Buffer }> = {
    [ASSET.chat]: { mime: 'image/png', ownerKind: 'chat_attachment', bytes: PNG },
    [ASSET.screenshot]: { mime: 'image/png', ownerKind: 'browser_screenshot', bytes: PNG },
    [ASSET.chat2]: { mime: 'image/jpeg', ownerKind: 'chat_attachment', bytes: JPEG },
  };
  return {
    readOriginal(assetId: string, versionId?: string) {
      const image = images[assetId];
      const version = `vav_${assetId.slice(3)}`;
      if (!image || (versionId && versionId !== version)) throw new Error('VISUAL_ASSET_NOT_FOUND');
      return {
        record: { assetId, versionId: version, ordinal: 1, sha256: sha(image.bytes), bytes: image.bytes.length, mime: image.mime, width: 1, height: 1, ownerKind: image.ownerKind, originalUrl: '', createdAt: '' },
        buffer: image.bytes,
      };
    },
  };
}

describe('Gmail attachments', () => {
  let home: string;
  let policy: AttachmentPolicy;
  let problems: AttachmentProblems;

  function write(relative: string, content: string | Buffer = 'content'): string {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  }
  const resolve = (value: unknown) => resolveAttachments(value, policy, problems);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-attach-'));
    const privateRoot = path.join(home, '.personal-productivity-tracker');
    policy = { homeDir: home, privateRoot, filesDir: path.join(privateRoot, 'files'), images: fakeImages() };
    fs.mkdirSync(policy.filesDir, { recursive: true });
    problems = { issues: [], refusals: [] };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('reads files by absolute, ~/, and files-workspace paths, and chat images by id, with names and types', () => {
    const pdf = write('Documents/Q3 report.pdf', '%PDF-1.4 synthetic');
    write('Documents/notes.md', '# Notes');
    write('.personal-productivity-tracker/files/exports/q3.csv', 'month,total\n2026-09,4\n');
    const list = resolve([
      { path: pdf },
      { path: '~/Documents/notes.md', name: 'Meeting notes.md' },
      { path: 'exports/q3.csv' },
      { assetId: ASSET.chat },
      { assetId: ASSET.screenshot },
      { assetId: ASSET.chat2, name: 'Whiteboard.JPEG' },
    ]);
    expect(problems).toEqual({ issues: [], refusals: [] });
    expect(list.map(file => [file.name, file.mimeType, file.sizeBytes])).toEqual([
      ['Q3 report.pdf', 'application/pdf', 18],
      ['Meeting notes.md', 'text/markdown', 7],
      ['q3.csv', 'text/csv', 22],
      ['image.png', 'image/png', PNG.length],
      ['screenshot.png', 'image/png', PNG.length],
      ['Whiteboard.JPEG', 'image/jpeg', JPEG.length],
    ]);
    expect(list[0].content.toString()).toBe('%PDF-1.4 synthetic');
    expect(list[0].sha256).toBe(sha(Buffer.from('%PDF-1.4 synthetic')));
    // Sources are exact: the canonical file, or the image's id and version.
    expect(list[0].source).toEqual({ kind: 'file', path: fs.realpathSync.native(pdf) });
    expect(list[3].source).toEqual({ kind: 'image', assetId: ASSET.chat, versionId: `vav_${'a'.repeat(32)}` });
    expect(attachmentReceipt(list[3])).toEqual({ name: 'image.png', mimeType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG), from: ASSET.chat });
    // A second chat image without a name is numbered.
    const again = resolve([{ assetId: ASSET.chat }, { assetId: ASSET.chat2 }]);
    expect(again.map(file => file.name)).toEqual(['image.png', 'image-2.jpg']);
    expect(resolve(undefined)).toEqual([]);
    expect(resolve([])).toEqual([]);
  });

  it('refuses credentials, hidden files, app data, BotBoy private data, secrets in text, and Gmail-blocked types', () => {
    const refused = (entry: unknown) => {
      problems = { issues: [], refusals: [] };
      expect(resolve([entry])).toEqual([]);
      expect(problems.issues).toEqual([]);
      expect(problems.refusals).toHaveLength(1);
      return problems.refusals[0];
    };
    write('.personal-productivity-tracker/gmail.json', '{}');
    expect(refused({ path: path.join(home, '.personal-productivity-tracker/gmail.json') }).message).toMatch(/^This is BotBoy’s private data/);
    write('.ssh/id_ed25519', 'key');
    expect(refused({ path: '~/.ssh/id_ed25519' })).toEqual({ path: 'attachments[0].path', message: 'Stored with SSH keys (.ssh): BotBoy never emails credentials or keys' });
    write('project/.env', 'A=1');
    expect(refused({ path: '~/project/.env' }).message).toMatch(/^In a hidden location \(\.env\)/);
    write('project/prod.env', 'A=1');
    expect(refused({ path: '~/project/prod.env' }).message).toBe('File type of an environment file (.env): BotBoy never emails credentials or keys');
    write('project/token.json', '{}');
    expect(refused({ path: '~/project/token.json' }).message).toMatch(/^Named like an OAuth token file/);
    write('.config/tool/settings.yaml', 'a: 1');
    expect(refused({ path: '~/.config/tool/settings.yaml' }).message).toBe('In a hidden location (.config): BotBoy does not email hidden files');
    // A link is judged by where it leads, too.
    write('.aws/credentials', '[default]');
    fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
    fs.symlinkSync(path.join(home, '.aws/credentials'), path.join(home, 'Desktop/innocent.txt'));
    expect(refused({ path: '~/Desktop/innocent.txt' }).message).toBe('Stored with AWS credentials (.aws): BotBoy never emails credentials or keys');
    fs.symlinkSync(path.join(home, '.personal-productivity-tracker/gmail.json'), path.join(policy.filesDir, 'shared.json'));
    expect(refused({ path: 'shared.json' }).message).toMatch(/^This is BotBoy’s private data/);
    write('Library/Application Support/Browser/Cookies', 'sqlite');
    expect(refused({ path: '~/Library/Application Support/Browser/Cookies' }).message).toMatch(/^App data in ~\/Library/);
    write('Documents/config.txt', `deploy token: ${FAKE_GITHUB_TOKEN}\n`);
    expect(refused({ path: '~/Documents/config.txt' }).message).toBe('Contains what looks like a GitHub token: BotBoy never emails credentials');
    write('Downloads/setup.exe', 'MZ');
    expect(refused({ path: '~/Downloads/setup.exe' }).message).toMatch(/^Gmail blocks \.exe files/);
    // iCloud Drive lives in ~/Library and is the owner's documents.
    write('Library/Mobile Documents/com~apple~CloudDocs/plan.pdf', '%PDF');
    problems = { issues: [], refusals: [] };
    expect(resolve([{ path: '~/Library/Mobile Documents/com~apple~CloudDocs/plan.pdf' }]).map(file => file.name)).toEqual(['plan.pdf']);
    // Binary content is not scanned: a NUL early means binary.
    write('Documents/blob.bin', Buffer.concat([Buffer.from([0]), Buffer.from(FAKE_GITHUB_TOKEN)]));
    expect(resolve([{ path: '~/Documents/blob.bin' }])).toHaveLength(1);
    expect(problems.refusals).toEqual([]);
  });

  it('reports every fixable mistake in one pass and returns only the usable files', () => {
    write('Documents/ok.txt', 'fine');
    write('Documents/empty.txt', '');
    fs.mkdirSync(path.join(home, 'Documents/folder'), { recursive: true });
    const huge = write('Documents/huge.bin', '');
    fs.truncateSync(huge, MAX_ATTACHMENT_BYTES + 1);
    const list = resolve([
      'ok.txt',
      { path: '~/Documents/ok.txt', assetId: ASSET.chat },
      {},
      { path: '~/Documents/ok.txt', size: 4 },
      { path: 42 },
      { path: '~/Documents/missing.pdf' },
      { path: '~/Documents/folder' },
      { path: '~/Documents/empty.txt' },
      { path: '../../etc/hosts' },
      { path: '~/Documents/ok.txt', name: 'renamed.pdf' },
      { path: '~/Documents/huge.bin' },
    ]);
    expect(list).toEqual([]);
    expect(problems.refusals).toEqual([]);
    expect(problems.issues).toEqual([
      { path: 'attachments', message: 'at most 10 files in one email (got 11)' },
      { path: 'attachments[0]', message: 'must be an object: {"path": …} or {"assetId": …}, with an optional "name"' },
      { path: 'attachments[1]', message: 'give exactly one of path (a local file) or assetId (an image from this chat)' },
      { path: 'attachments[2]', message: 'give exactly one of path (a local file) or assetId (an image from this chat)' },
      { path: 'attachments[3]', message: 'unknown field "size"; use path or assetId, and name' },
      { path: 'attachments[4].path', message: 'must be a string' },
      { path: 'attachments[5].path', message: 'no file at this path; use the exact path the owner gave or a tool returned' },
      { path: 'attachments[6].path', message: 'is a folder: attach its files one by one, or zip it first' },
      { path: 'attachments[7].path', message: 'the file is empty' },
      { path: 'attachments[8].path', message: 'a relative path is read inside BotBoy’s files workspace and may not contain ..; use an absolute or ~/ path for other files' },
      { path: 'attachments[9].name', message: 'must end in .txt, like the file' },
    ]);

    problems = { issues: [], refusals: [] };
    expect(resolve([{ path: '~/Documents/huge.bin' }])).toEqual([]);
    expect(problems.issues).toEqual([{ path: 'attachments[0].path', message: 'the file is 25.1 MB; one email carries at most 25 MB of files' }]);

    problems = { issues: [], refusals: [] };
    const half = write('Documents/half-a.bin', '');
    fs.truncateSync(half, 13 * 1024 * 1024);
    fs.copyFileSync(half, path.join(home, 'Documents/half-b.bin'));
    expect(resolve([{ path: half }, { path: '~/Documents/half-b.bin' }, { path: half }, { assetId: 'att_0123456789ab' }, { assetId: `va_${'f'.repeat(32)}` }])).toHaveLength(3);
    expect(problems.issues).toEqual([
      { path: 'attachments[3].assetId', message: 'must be the exact va_… id of an image in this conversation (its VISUAL ASSETS line or screenshot receipt)' },
      { path: 'attachments[4].assetId', message: 'no image with this id; use an exact va_… id from this conversation' },
      { path: 'attachments', message: 'half-a.bin is listed twice' },
      { path: 'attachments', message: 'one email carries at most 25 MB of files and these are 39 MB; attach fewer, or tell the owner to share the large ones another way' },
    ]);

    problems = { issues: [], refusals: [] };
    expect(resolve({ path: '~/Documents/ok.txt' })).toEqual([]);
    expect(problems.issues).toEqual([{ path: 'attachments', message: 'must be a list of {"path": …} or {"assetId": …} entries ([] for none)' }]);
  });

  it('reattaches a draft’s files only while their bytes are unchanged', () => {
    const notes = write('Documents/notes.txt', 'version 1');
    const stored = resolve([{ path: notes, name: 'Notes.txt' }, { assetId: ASSET.chat }]).map(storedAttachment);
    expect(stored).toHaveLength(2);
    // The ledger round-trips through JSON.
    const kept = JSON.parse(JSON.stringify(stored));

    problems = { issues: [], refusals: [] };
    const again = reattachStored(kept, policy, problems);
    expect(problems).toEqual({ issues: [], refusals: [] });
    expect(again.map(file => [file.name, file.sha256])).toEqual(stored.map(file => [file.name, file.sha256]));

    fs.writeFileSync(notes, 'version 2');
    problems = { issues: [], refusals: [] };
    expect(reattachStored(kept, policy, problems).map(file => file.name)).toEqual(['image.png']);
    expect(problems.issues).toEqual([{ path: 'attachments', message: 'Notes.txt (attached to the draft before) changed since the draft was saved; pass attachments again to attach the current files, or [] for none' }]);

    fs.rmSync(notes);
    problems = { issues: [], refusals: [] };
    reattachStored(kept, policy, problems);
    expect(problems.issues).toEqual([{
      path: 'attachments',
      message: 'Notes.txt (attached to the draft before): no file at this path; use the exact path the owner gave or a tool returned; pass attachments again to attach the current files, or [] for none',
    }]);

    problems = { issues: [], refusals: [] };
    expect(reattachStored([{ name: 'x.txt' }], policy, problems)).toEqual([]);
    expect(problems.issues[0].message).toMatch(/could not be read back/);
    expect(reattachStored(undefined, policy, problems)).toEqual([]);
  });
});
