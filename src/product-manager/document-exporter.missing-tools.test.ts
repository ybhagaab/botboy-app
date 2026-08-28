/**
 * Missing-tool behavior of the document exporter: the guided pandoc install
 * flow depends on (1) a structured `pandoc_missing` error code and (2) failed
 * binary resolution NOT being cached — pandoc can appear mid-session right
 * after the guided install, and a sticky null would keep every download
 * failing until a server restart.
 *
 * child_process is mocked module-wide; the exporter resolves execFile lazily
 * at call time by design so this partial mock works.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { DocumentExportError, exportDocument, isPandocInstalled } from './document-exporter.js';

function failAllBinaries() {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback?: (...cbArgs: unknown[]) => void) => {
    const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    // promisify(execFile) passes the callback last.
    const cb = callback ?? (_opts as (...cbArgs: unknown[]) => void);
    if (typeof cb === 'function') process.nextTick(() => cb(error));
    return {} as ReturnType<typeof import('node:child_process')['execFile']>;
  });
}

function succeedAllBinaries() {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, callback?: (...cbArgs: unknown[]) => void) => {
    const cb = callback ?? (_opts as (...cbArgs: unknown[]) => void);
    if (typeof cb === 'function') process.nextTick(() => cb(null, { stdout: 'ok', stderr: '' }));
    return {} as ReturnType<typeof import('node:child_process')['execFile']>;
  });
}

describe('document exporter with pandoc missing', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('throws DocumentExportError with the pandoc_missing code', async () => {
    failAllBinaries();
    const attempt = exportDocument({ title: 'Doc', content: '# Doc', format: 'docx' });
    await expect(attempt).rejects.toBeInstanceOf(DocumentExportError);
    await expect(attempt).rejects.toMatchObject({ code: 'pandoc_missing' });
  });

  it('does not cache failed resolution — pandoc installed mid-session is found', async () => {
    failAllBinaries();
    expect(await isPandocInstalled()).toBe(false);
    // The guided install just finished: the same process must now see it
    // without a restart.
    succeedAllBinaries();
    expect(await isPandocInstalled()).toBe(true);
  });
});
