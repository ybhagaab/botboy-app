import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'node:zlib';
import { deleteWorkingFile } from './job-working-files.js';

/**
 * A job deletes its own working files (owner approval 2026-10-29): one regular file in the files workspace, made since the
 * job started, whose gzip copy BotBoy has checked byte for byte. Nothing else.
 */
describe('deleteWorkingFile', () => {
  let filesDir: string;
  let jobStartedAt: string;
  beforeEach(() => {
    filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-files-'));
    fs.mkdirSync(path.join(filesDir, 'etl-results'));
    jobStartedAt = new Date(Date.now() - 60_000).toISOString();
  });
  afterEach(() => fs.rmSync(filesDir, { recursive: true, force: true }));

  const write = (name: string, content: string | Buffer) => {
    const file = path.join(filesDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const raw = `uuid\n${Array.from({ length: 2000 }, (_, i) => `device-${i}`).join('\n')}\n`;

  it('deletes the raw export once its gzip copy holds the same bytes, and says how much it freed', async () => {
    const file = write('etl-results/adhoc_1.tsv', raw);
    write('etl-results/adhoc_1.tsv.gz', gzipSync(raw));
    const result = await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_1.tsv', keptCopy: 'etl-results/adhoc_1.tsv.gz' });
    expect(result).toMatchObject({ ok: true, deleted: 'etl-results/adhoc_1.tsv', keptCopy: 'etl-results/adhoc_1.tsv.gz', bytesFreed: Buffer.byteLength(raw) });
    expect(result.ok && result.freeBytesAfter).toBeGreaterThan(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.gz`)).toBe(true);
  });

  it('absolute paths in the files workspace work too', async () => {
    const file = write('study/part.tsv', raw);
    write('study/part.tsv.gz', gzipSync(raw));
    expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: file, keptCopy: `${file}.gz` })).toMatchObject({ ok: true, deleted: 'study/part.tsv' });
  });

  it('a copy that differs, or is not gzip, deletes nothing', async () => {
    const file = write('etl-results/adhoc_2.tsv', raw);
    write('etl-results/adhoc_2.tsv.gz', gzipSync(`${raw}extra\n`));
    expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_2.tsv', keptCopy: 'etl-results/adhoc_2.tsv.gz' }))
      .toMatchObject({ ok: false, code: 'copy_differs' });
    write('etl-results/broken.tsv.gz', 'this is not gzip');
    expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_2.tsv', keptCopy: 'etl-results/broken.tsv.gz' }))
      .toMatchObject({ ok: false, code: 'copy_differs' });
    write('etl-results/adhoc_2.copy.tsv', raw);
    expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_2.tsv', keptCopy: 'etl-results/adhoc_2.copy.tsv' }))
      .toMatchObject({ ok: false, code: 'copy_not_gzip' });
    expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_2.tsv', keptCopy: 'etl-results/adhoc_2.tsv' }))
      .toMatchObject({ ok: false, code: 'copy_not_gzip' });
    expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_2.tsv', keptCopy: 'etl-results/missing.tsv.gz' }))
      .toMatchObject({ ok: false, code: 'not_a_file', nextAction: expect.stringContaining('gzip copy') });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('a file from before the job started is not the job\'s own', async () => {
    const file = write('etl-results/old.tsv', raw);
    write('etl-results/old.tsv.gz', gzipSync(raw));
    const later = new Date(Date.now() + 60_000).toISOString(); // the job started after the file was made
    expect(await deleteWorkingFile({ filesDir, jobStartedAt: later, path: 'etl-results/old.tsv', keptCopy: 'etl-results/old.tsv.gz' }))
      .toMatchObject({ ok: false, code: 'not_made_in_this_job' });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('nothing outside the files workspace, no folders and no links are ever deleted', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'job-files-outside-'));
    try {
      const foreign = path.join(outside, 'owner.tsv');
      fs.writeFileSync(foreign, raw);
      fs.writeFileSync(`${foreign}.gz`, gzipSync(raw));
      expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: foreign, keptCopy: `${foreign}.gz` })).toMatchObject({ ok: false, code: 'not_in_workspace' });
      expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: '../owner.tsv', keptCopy: 'x.gz' })).toMatchObject({ ok: false });
      // A link inside the workspace that points outside it.
      fs.symlinkSync(foreign, path.join(filesDir, 'link.tsv'));
      write('link.tsv.gz', gzipSync(raw));
      expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'link.tsv', keptCopy: 'link.tsv.gz' })).toMatchObject({ ok: false, code: 'not_in_workspace' });
      // A link to a file inside the workspace is still a link.
      const inside = write('etl-results/real.tsv', raw);
      fs.symlinkSync(inside, path.join(filesDir, 'inner-link.tsv'));
      expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'inner-link.tsv', keptCopy: 'link.tsv.gz' })).toMatchObject({ ok: false, code: 'not_a_file' });
      expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results', keptCopy: 'link.tsv.gz' })).toMatchObject({ ok: false, code: 'not_a_file' });
      expect(fs.existsSync(foreign)).toBe(true);
      expect(fs.existsSync(inside)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a file that changes while its copy is checked is not deleted', async () => {
    const file = write('etl-results/adhoc_4.tsv', raw);
    write('etl-results/adhoc_4.tsv.gz', gzipSync(raw));
    const real = fs.realpathSync.native(file);
    const statSync = fs.statSync;
    let reads = 0;
    // The file's third stat is the one taken after the check (resolve, before, after): it has grown by then.
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stat = statSync(target, options) as fs.Stats;
      return String(target) === real && ++reads === 3 ? { ...stat, size: stat.size + 1 } : stat;
    }) as typeof fs.statSync);
    try {
      expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_4.tsv', keptCopy: 'etl-results/adhoc_4.tsv.gz' }))
        .toMatchObject({ ok: false, code: 'changed_while_checked' });
    } finally {
      spy.mockRestore();
    }
    expect(reads).toBe(3);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('a stopped turn deletes nothing', async () => {
    const file = write('etl-results/adhoc_3.tsv', raw);
    write('etl-results/adhoc_3.tsv.gz', gzipSync(raw));
    const controller = new AbortController();
    controller.abort();
    expect(await deleteWorkingFile({ filesDir, jobStartedAt, path: 'etl-results/adhoc_3.tsv', keptCopy: 'etl-results/adhoc_3.tsv.gz', signal: controller.signal }))
      .toMatchObject({ ok: false, code: 'stopped' });
    expect(fs.existsSync(file)).toBe(true);
  });
});
