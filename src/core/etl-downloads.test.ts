import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import {
  DOWNLOAD_LANDING_WINDOW_MS,
  DOWNLOAD_SETTLE_MS,
  DOWNLOAD_STILL_RUNNING,
  downloadResult,
  isDownloadTimeout,
  knownResult,
  landingError,
  landingNextAction,
  readHeadLines,
  resetEtlDownloadsForTests,
  summarizeResultFile,
} from './etl-downloads.js';

/**
 * Datanet result downloads (etl-downloads.ts, docs/maps/datanet-etl.md): one download per run, waiting for a download that
 * outlasted the connector's 5 minutes, and a streaming read that gives exactly what reading the file whole gave.
 */

/** What etl-adhoc.ts › downloadRun computed before 2026-10-29: the whole file as one string. */
function wholeRead(file: string, maxRows: number) {
  const bytes = fs.readFileSync(file);
  const lines = bytes.toString('utf8').split('\n').filter(line => line.length > 0);
  const body = lines.slice(1);
  return {
    columns: (lines[0] ?? '').split('\t'),
    rows: body.slice(0, maxRows).map(line => line.split('\t')),
    rowCount: body.length,
    truncated: body.length > maxRows,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-downloads-'));
  resetEtlDownloadsForTests();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetEtlDownloadsForTests();
});

describe('summarizeResultFile: one streaming pass, the same answer as reading the file whole', () => {
  const cases: Record<string, string> = {
    'header and rows': 'dt\tstreamers\n2026-09-01\t1234\n2026-09-02\t2345\n',
    'no trailing newline': 'a\tb\n1\t2\n3\t4',
    'empty lines anywhere': '\n\nuuid\n\nx1\n\n\nx2\n\n',
    'CRLF kept in values': 'a\tb\r\n1\t2\r\n',
    'multi-byte text': 'name\tcity\nZoë\tMünchen\n🙂\t東京\nłódź\t\u00e9t\u00e9\n',
    'header only': 'uuid\n',
    'empty file': '',
    'only newlines': '\n\n\n',
    'tabs and empty cells': 'a\tb\tc\n\t\t\n1\t\t3\n',
  };
  for (const [name, content] of Object.entries(cases)) {
    it(`${name}: identical for every chunk size`, async () => {
      const file = path.join(dir, 'r.tsv');
      fs.writeFileSync(file, content);
      for (const maxRows of [0, 1, 2, 200]) {
        const expected = wholeRead(file, maxRows);
        for (const chunkBytes of [1, 2, 3, 5, 7, 64, 1 << 20]) {
          expect(await summarizeResultFile(file, maxRows, { chunkBytes })).toEqual(expected);
        }
      }
    });
  }

  it('a larger result: the true row count, the first rows only, the same hash', async () => {
    const file = path.join(dir, 'big.tsv');
    const ids = Array.from({ length: 120_000 }, (_, i) => `device-${i.toString(16).padStart(8, '0')}-ü`);
    fs.writeFileSync(file, `uuid\n${ids.join('\n')}\n`);
    const summary = await summarizeResultFile(file, 200, { chunkBytes: 4093 });
    expect(summary).toEqual(wholeRead(file, 200));
    expect(summary.rowCount).toBe(120_000);
    expect(summary.rows).toHaveLength(200);
    expect(summary.truncated).toBe(true);
  });

  it('never decodes the file as one string (the read that failed above 512 MB on 2026-10-29)', async () => {
    const file = path.join(dir, 'r.tsv');
    fs.writeFileSync(file, 'uuid\nx\ny\n');
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const toString = vi.spyOn(Buffer.prototype, 'toString');
    await summarizeResultFile(file, 1);
    expect(readFileSync).not.toHaveBeenCalled();
    // Only the header and the one preview row are ever decoded.
    expect(toString.mock.calls.length).toBeLessThanOrEqual(2);
    readFileSync.mockRestore();
    toString.mockRestore();
  });
});

describe('readHeadLines', () => {
  it('a small file gives what reading it whole gave', () => {
    const file = path.join(dir, 'r.tsv');
    fs.writeFileSync(file, 'a\tb\n1\t2\n3\t4\n');
    expect(readHeadLines(file, 6)).toEqual(fs.readFileSync(file, 'utf8').split('\n').slice(0, 6));
  });
  it('reads at most its window and drops a line the window cut', () => {
    const file = path.join(dir, 'wide.tsv');
    fs.writeFileSync(file, `${'h'.repeat(10)}\n${'x'.repeat(100)}\n${'y'.repeat(100)}\n`);
    expect(readHeadLines(file, 6, 50)).toEqual(['h'.repeat(10)]);
    expect(readHeadLines(file, 1, 50)).toEqual(['h'.repeat(10)]);
  });
});

describe('isDownloadTimeout', () => {
  it('recognises BotBoy\'s own timeout, the older wording, and the connector\'s Timeout reply', () => {
    expect(isDownloadTimeout(`Error: the Datanet download did not answer within 5 min; ${DOWNLOAD_STILL_RUNNING}.`)).toBe(true);
    expect(isDownloadTimeout('Error: the Datanet ETL call datanet_download_results timed out after 5 min — the transport, not the query.')).toBe(true);
    expect(isDownloadTimeout('{"error": "Timeout", "message": "Tool \'datanet_download_results\' exceeded 300s timeout.", "retryable": false}')).toBe(true);
  });
  it('anything else is not a timeout', () => {
    expect(isDownloadTimeout('saved to /x/adhoc_1.tsv')).toBe(false);
    expect(isDownloadTimeout('{"error": "No downloadable results for run 1"}')).toBe(false);
    expect(isDownloadTimeout('')).toBe(false);
    expect(isDownloadTimeout(null)).toBe(false);
  });
});

describe('downloadResult: one download per run', () => {
  const CONNECTOR_TIMEOUT = '{"error": "Timeout", "message": "Tool \'datanet_download_results\' exceeded 300s timeout.", "retryable": false}';
  let t: number;
  const now = () => t;
  /** Writes the file as the connector does, with its modification time at `at`. */
  const land = (file: string, content: string, at: number) => {
    fs.writeFileSync(file, content);
    fs.utimesSync(file, new Date(at), new Date(at));
  };
  beforeEach(() => { t = Date.now(); });

  it('a download that finishes in time is taken once, then reused while the file is unchanged', async () => {
    const output = path.join(dir, 'adhoc_1.tsv');
    const download = vi.fn(async () => { land(output, 'uuid\na\n', t); return { isError: false, text: `saved to ${output}` }; });
    expect(await downloadResult({ runId: '1', output, download, now })).toEqual({ state: 'downloaded', output, reused: false });
    expect(await downloadResult({ runId: '1', output, download, now })).toEqual({ state: 'downloaded', output, reused: true });
    expect(download).toHaveBeenCalledTimes(1);
    // The file changed (or went away): a fresh download.
    land(output, 'uuid\nb\nc\n', t + 5_000);
    await downloadResult({ runId: '1', output, download, now });
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('a download that outlasts the connector is waited for: never asked twice, taken once its file holds still', async () => {
    const output = path.join(dir, 'adhoc_2.tsv');
    const started = t;
    const download = vi.fn(async () => ({ isError: false, text: CONNECTOR_TIMEOUT }));
    expect(await downloadResult({ runId: '2', output, download, now })).toMatchObject({ state: 'landing', startedAt: started });
    t += 60_000;
    expect(await downloadResult({ runId: '2', output, download, now })).toMatchObject({ state: 'landing', sinceMs: 60_000 });
    // The connector's background download writes the file.
    land(output, 'uuid\na\nb\n', t);
    t += 1_000;
    expect(await downloadResult({ runId: '2', output, download, now })).toMatchObject({ state: 'landing' }); // first sighting
    t += DOWNLOAD_SETTLE_MS - 1;
    expect(await downloadResult({ runId: '2', output, download, now })).toMatchObject({ state: 'landing' });
    t += 1;
    expect(await downloadResult({ runId: '2', output, download, now })).toEqual({ state: 'downloaded', output, reused: false });
    expect(download).toHaveBeenCalledTimes(1);
    expect(await downloadResult({ runId: '2', output, download, now })).toMatchObject({ state: 'downloaded', reused: true });
  });

  it('a file still being written is not taken until it stops changing', async () => {
    const output = path.join(dir, 'adhoc_3.tsv');
    const download = vi.fn(async () => ({ isError: true, text: `Error: the Datanet download did not answer within 5 min; ${DOWNLOAD_STILL_RUNNING}.` }));
    await downloadResult({ runId: '3', output, download, now });
    land(output, 'uuid\na\n', t);
    t += 30_000;
    expect((await downloadResult({ runId: '3', output, download, now })).state).toBe('landing');
    land(output, 'uuid\na\nb\nc\n', t); // grew
    t += 30_000;
    expect((await downloadResult({ runId: '3', output, download, now })).state).toBe('landing');
    t += 30_000;
    expect((await downloadResult({ runId: '3', output, download, now })).state).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('an older file of the same name is not this download; nothing landing within the window starts a new one', async () => {
    const output = path.join(dir, 'adhoc_4.tsv');
    land(output, 'uuid\nold\n', t - 10 * 60_000);
    const download = vi.fn(async () => ({ isError: false, text: CONNECTOR_TIMEOUT }));
    await downloadResult({ runId: '4', output, download, now });
    t += DOWNLOAD_SETTLE_MS * 3;
    expect((await downloadResult({ runId: '4', output, download, now })).state).toBe('landing');
    t += DOWNLOAD_LANDING_WINDOW_MS;
    const expired = await downloadResult({ runId: '4', output, download, now });
    expect(expired).toMatchObject({ state: 'failed', expired: true });
    expect(expired.state === 'failed' && expired.error).toContain('30 minutes');
    expect(download).toHaveBeenCalledTimes(1);
    await downloadResult({ runId: '4', output, download, now });
    expect(download).toHaveBeenCalledTimes(2); // the next read asks again
  });

  it('a caller that comes in while the download call is still open waits for it instead of starting its own', async () => {
    const output = path.join(dir, 'adhoc_5.tsv');
    let finish!: () => void;
    const download = vi.fn(() => new Promise<{ isError: boolean; text: string }>((resolve) => {
      finish = () => { land(output, 'uuid\na\n', t); resolve({ isError: false, text: 'saved' }); };
    }));
    const first = downloadResult({ runId: '5', output, download, now });
    expect(await downloadResult({ runId: '5', output, download, now })).toMatchObject({ state: 'landing' });
    finish();
    expect(await first).toMatchObject({ state: 'downloaded', reused: false });
    expect(await downloadResult({ runId: '5', output, download, now })).toMatchObject({ state: 'downloaded', reused: true });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('an error is a failure (the next read asks again); a throw clears the download and passes through', async () => {
    const output = path.join(dir, 'adhoc_6.tsv');
    const failing = vi.fn(async () => ({ isError: true, text: 'Error: No downloadable results for run 6 (mimeType=TEXT)' }));
    expect(await downloadResult({ runId: '6', output, download: failing, now })).toMatchObject({ state: 'failed', error: expect.stringContaining('No downloadable results') });
    expect((await downloadResult({ runId: '6', output, download: failing, now })).state).toBe('failed');
    expect(failing).toHaveBeenCalledTimes(2);
    const silent = vi.fn(async () => ({ isError: false, text: 'ok' })); // said nothing went wrong, wrote nothing
    expect(await downloadResult({ runId: '6', output, download: silent, now })).toMatchObject({ state: 'failed', error: expect.stringContaining('wrote no file') });
    const throwing = vi.fn(async () => { throw new Error('connection closed'); });
    await expect(downloadResult({ runId: '6', output, download: throwing, now })).rejects.toThrow('connection closed');
    const after = vi.fn(async () => { land(output, 'uuid\n', t); return { isError: false, text: 'saved' }; });
    expect((await downloadResult({ runId: '6', output, download: after, now })).state).toBe('downloaded');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('knownResult finds another caller\'s file for the run in the same folder only', async () => {
    const output = path.join(dir, 'adhoc_7.tsv');
    await downloadResult({ runId: '7', output, download: async () => { land(output, 'uuid\na\n', t); return { isError: false, text: 'saved' }; }, now });
    expect(knownResult('7', dir, now)).toEqual({ state: 'downloaded', output, reused: true });
    expect(knownResult('7', path.join(dir, 'elsewhere'), now)).toBeNull();
    expect(knownResult('8', dir, now)).toBeNull();
    const landingOutput = path.join(dir, 'adhoc_9.tsv');
    await downloadResult({ runId: '9', output: landingOutput, download: async () => ({ isError: false, text: CONNECTOR_TIMEOUT }), now });
    t += 120_000;
    expect(knownResult('9', dir, now)).toMatchObject({ state: 'landing', output: landingOutput, sinceMs: 120_000 });
    fs.rmSync(output);
    expect(knownResult('7', dir, now)).toBeNull(); // gone from disk: not known any more
  });

  it('knownResult takes a landed file whoever started its download, and leaves an expired wait to the read that started it', async () => {
    const output = path.join(dir, 'run_10.tsv');
    const download = vi.fn(async () => ({ isError: false, text: CONNECTOR_TIMEOUT }));
    await downloadResult({ runId: '10', output, download, now });
    t += 60_000;
    land(output, 'uuid\na\n', t);
    expect(knownResult('10', dir, now)).toMatchObject({ state: 'landing', output }); // first sighting
    t += DOWNLOAD_SETTLE_MS - 1;
    expect(knownResult('10', dir, now)).toMatchObject({ state: 'landing', output });
    t += 1;
    expect(knownResult('10', dir, now)).toEqual({ state: 'downloaded', output, reused: false });
    expect(knownResult('10', dir, now)).toEqual({ state: 'downloaded', output, reused: true });
    expect(await downloadResult({ runId: '10', output, download, now })).toEqual({ state: 'downloaded', output, reused: true });
    expect(download).toHaveBeenCalledTimes(1);

    const late = path.join(dir, 'run_11.tsv');
    await downloadResult({ runId: '11', output: late, download, now });
    t += DOWNLOAD_LANDING_WINDOW_MS - 1;
    expect(knownResult('11', dir, now)).toMatchObject({ state: 'landing' });
    t += 1;
    expect(knownResult('11', dir, now)).toBeNull();
    expect(await downloadResult({ runId: '11', output: late, download, now })).toMatchObject({ state: 'failed', expired: true });
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('the words say the result is still downloading and what to do, never "the VPN dropped"', () => {
    expect(landingError('13165875416', 7 * 60_000)).toBe('Run 13165875416 succeeded and its result is still downloading (7 min so far). Datanet\'s connector stops waiting after 5 minutes, but it finishes a large download in the background and writes the file once every part has arrived.');
    expect(landingNextAction('13165875416')).toContain('Do not download it again or resubmit the run');
    expect(landingNextAction('13165875416')).toContain('wait_for {"kind":"etl_run","id":"13165875416","waitSeconds":300}');
  });
});
