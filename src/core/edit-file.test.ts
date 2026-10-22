import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editFileHandler, readFileHandler } from './tool-executor.js';

/**
 * edit_file (owner report 2026-10-21): exact find/replace pairs in an existing
 * file of the files workspace. Everything it is not asked to change stays byte
 * for byte, and a refused edit writes nothing.
 */
let filesDir: string;
let privateRoot: string;

beforeEach(() => {
  privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-file-private-'));
  filesDir = path.join(privateRoot, 'files');
  fs.mkdirSync(filesDir);
});
afterEach(() => fs.rmSync(privateRoot, { recursive: true, force: true }));

const PAGE = '<html>\n<body>\n  <h1>Successful terminal reports</h1>\n  <p>Share: 91%</p>\n</body>\n</html>\n';
const write = (name: string, content: string | Buffer) => {
  const target = path.join(filesDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};
const edit = (filename: string, edits: unknown) => editFileHandler(filesDir, { filename, edits }, { privateRoot });

describe('edit_file', () => {
  it('changes only the exact text it names and reports where each change landed', () => {
    const target = write('previews/page.html', PAGE);
    fs.chmodSync(target, 0o640);
    const receipt = JSON.parse(edit('previews/page.html', [
      { find: 'Successful terminal reports', replace: 'Successful download reports' },
      { find: '<p>Share: 91%</p>', replace: '<p>Share of reported outcomes: 91%</p>\n  <p>Counts reports, not unique downloads.</p>' },
    ]));
    const after = PAGE
      .replace('Successful terminal reports', 'Successful download reports')
      .replace('<p>Share: 91%</p>', '<p>Share of reported outcomes: 91%</p>\n  <p>Counts reports, not unique downloads.</p>');
    expect(fs.readFileSync(target, 'utf8')).toBe(after);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(receipt).toMatchObject({
      path: target,
      filename: 'previews/page.html',
      url: '/api/files/previews/page.html',
      editsApplied: 2,
      changes: [
        { edit: 0, line: 3, lineText: '  <h1>Successful download reports</h1>' },
        { edit: 1, line: 4, lineText: '  <p>Share of reported outcomes: 91%</p>\n  <p>Counts reports, not unique downloads.</p>' },
      ],
      lineCount: after.split('\n').length,
      bytes: Buffer.byteLength(after),
      bytesChanged: Buffer.byteLength(after) - Buffer.byteLength(PAGE),
    });
    expect(fs.readdirSync(path.dirname(target))).toEqual(['page.html']);
  });

  it('refuses a missing or repeated find, an unchanged result and malformed edits, and writes nothing', () => {
    const target = write('page.html', PAGE);
    const before = fs.readFileSync(target);
    const cases: Array<[unknown, RegExp]> = [
      [[{ find: 'Not on the page', replace: 'x' }], /^Error: edits\[0\]\.find does not occur in page\.html\. Read the file again with read_file and copy edits\[0\]\.find exactly, without the "N: " line-number prefix\..* Nothing was changed\.$/],
      [[{ find: '<h1>', replace: '<h2>' }, { find: '  <', replace: '<' }], /^Error: edits\[1\]\.find occurs more than once\. Make edits\[1\]\.find longer.* Nothing was changed\.$/],
      [[{ find: '<h1>', replace: '<h1>' }], /^Error: the edits leave page\.html exactly as it is\. Nothing was changed\.$/],
      [[], /^Error: edits must be a list of 1 to 50 \{find, replace\} pairs\. Nothing was changed\.$/],
      [[{ find: '', replace: 'x' }], /non-empty find/],
    ];
    for (const [edits, message] of cases) expect(edit('page.html', edits), JSON.stringify(edits)).toMatch(message);
    expect(fs.readFileSync(target).equals(before)).toBe(true);
    expect(fs.readdirSync(filesDir)).toEqual(['page.html']);
  });

  it('only edits existing text files inside the workspace, never exports of official documents', () => {
    write('document-exports/abc/Launch.md', '# Launch\n');
    write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    write('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    fs.writeFileSync(path.join(privateRoot, 'ai-model.json'), '{"key":"secret"}');
    fs.symlinkSync(path.join(privateRoot, 'ai-model.json'), path.join(filesDir, 'link.json'));
    const one = [{ find: 'a', replace: 'b' }];
    expect(edit('document-exports/abc/Launch.md', [{ find: 'Launch', replace: 'Go' }])).toMatch(/export of an official Documents-page document\. Change the document with edit_product_document, then export it again/);
    expect(edit('missing.md', one)).toBe('Error: missing.md does not exist. Create it with write_file; edit_file only changes an existing file.');
    expect(edit('../ai-model.json', one)).toBe('Error: path traversal not allowed (..)');
    expect(edit('/etc/hosts', one)).toBe('Error: absolute paths not allowed');
    expect(edit('link.json', one)).toBe('Error: symlink paths are not allowed');
    expect(edit('image.png', one)).toBe('Error: image.png is not a text file. Nothing was changed.');
    expect(edit('latin1.txt', [{ find: 'caf', replace: 'CAF' }])).toMatch(/is not valid UTF-8 text/);
    expect(fs.readFileSync(path.join(filesDir, 'document-exports/abc/Launch.md'), 'utf8')).toBe('# Launch\n');
    expect(fs.readFileSync(path.join(privateRoot, 'ai-model.json'), 'utf8')).toBe('{"key":"secret"}');
  });

  it('edits a CRLF file with the line breaks read_file shows and keeps it CRLF', () => {
    const target = write('notes.txt', 'one\r\ntwo\r\nthree\r\n');
    const shown = readFileHandler(filesDir, { filename: 'notes.txt', startLine: 1, endLine: 2 }, { privateRoot });
    expect(shown.split('\n')[0]).toBe('1: one\r');
    expect(JSON.parse(edit('notes.txt', [{ find: 'one\ntwo', replace: 'one\nTWO\nmore' }]))).toMatchObject({ editsApplied: 1, changes: [{ line: 1 }] });
    expect(fs.readFileSync(target, 'utf8')).toBe('one\r\nTWO\r\nmore\r\nthree\r\n');
  });

  it('refuses a file over 10 MB without reading it into an edit', () => {
    const target = write('big.log', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    expect(edit('big.log', [{ find: 'aaaa', replace: 'b' }])).toBe('Error: big.log is 10,485,761 bytes; edit_file changes text files up to 10 MB. Nothing was changed.');
    expect(fs.statSync(target).size).toBe(10 * 1024 * 1024 + 1);
  });

  it('returns the Data Room source for an edited table, as write_file does', () => {
    write('etl-results/players.tsv', 'week\tplayers\n2026-W40\t12\n');
    expect(JSON.parse(edit('etl-results/players.tsv', [{ find: '\t12', replace: '\t13' }]))).toMatchObject({
      dataRoomSource: { kind: 'local_file', path: 'etl-results/players.tsv' },
    });
  });
});
