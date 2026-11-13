/**
 * Datanet result downloads (docs/maps/datanet-etl.md › "Large results"; owner approval 2026-10-29).
 *
 * Found on a 1.8 GB export (job #3, 2026-10-29): the a2 connector answers every tool call within 5 minutes (its mcp-server.py
 * `TOOL_TIMEOUT_SECONDS`), but a download it has started keeps running in a thread of its own, and its `download_results`
 * writes the TSV in one pass only after every part of the result has arrived. So a large result "times out" and then lands by
 * itself, and asking again starts another full download into the same file. Two rules follow:
 *   - One download per run. A download that timed out is awaited: its file is watched until it has been written after the
 *     download began and its size and modification time have held still (the connector writes it in seconds). A file BotBoy
 *     already took in whole, still unchanged on disk, is reused.
 *   - Results are read in chunks. The header, the preview rows, the true row count and the SHA-256 come from one streaming
 *     pass, so a result larger than any one string Node can hold (512 MB on Node 20) reads like any other, without blocking
 *     the event loop.
 * State is in memory: the connector is BotBoy's own child process, so a restart ends any download it was running.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

/** How long BotBoy waits for a timed-out download's file before asking the connector for the download again. */
export const DOWNLOAD_LANDING_WINDOW_MS = 30 * 60_000;
/** A landed file must keep its size and modification time this long before it is read. */
export const DOWNLOAD_SETTLE_MS = 20_000;
/** File times and the clock come from one machine; this only absorbs rounding. */
const CLOCK_SLACK_MS = 2_000;
/** The words BotBoy's own download timeout carries (etl-adhoc.ts › createEtlToolCall); isDownloadTimeout recognises them. */
export const DOWNLOAD_STILL_RUNNING = 'the download may still be running';
/** A preview line longer than this is cut (a preview, not data: the file on disk is untouched). */
const MAX_PREVIEW_LINE_BYTES = 4 * 1024 * 1024;

/** A download that did not finish within the call: BotBoy's own deadline, or the connector's `{"error": "Timeout"}` reply. */
export function isDownloadTimeout(text: string | null | undefined): boolean {
  const value = String(text ?? '');
  return value.includes(DOWNLOAD_STILL_RUNNING)
    || /\btimed out after \d+ min\b/i.test(value)
    || /exceeded \d+\s*s timeout/i.test(value)
    || /"error"\s*:\s*"Timeout"/.test(value);
}

interface Landing {
  runId: string;
  output: string;
  startedAt: number;
  /** The file as last seen: it lands once it has held still for DOWNLOAD_SETTLE_MS. */
  seen?: { size: number; mtimeMs: number; at: number };
}
interface Downloaded { runId: string; output: string; size: number; mtimeMs: number }

/** Keyed by the resolved output path: every caller that asks for one file shares one download. */
const landings = new Map<string, Landing>();
const downloaded = new Map<string, Downloaded>();

export type DownloadOutcome =
  | { state: 'downloaded'; output: string; reused: boolean }
  | { state: 'landing'; output: string; startedAt: number; sinceMs: number }
  | { state: 'failed'; output: string; error: string; expired?: boolean };

function statFile(file: string): fs.Stats | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function oneLine(text: string, max = 400): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** What a landing shows now: landed (complete), still waiting, or expired with nothing written. */
function checkLanding(landing: Landing, now: number): 'landed' | 'waiting' | 'expired' {
  const stat = statFile(landing.output);
  if (stat && stat.mtimeMs >= landing.startedAt - CLOCK_SLACK_MS) {
    const seen = landing.seen;
    if (seen && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) {
      if (now - seen.at >= DOWNLOAD_SETTLE_MS) return 'landed';
    } else {
      landing.seen = { size: stat.size, mtimeMs: stat.mtimeMs, at: now };
    }
    return 'waiting';
  }
  return now - landing.startedAt >= DOWNLOAD_LANDING_WINDOW_MS ? 'expired' : 'waiting';
}

function remember(runId: string, output: string): boolean {
  const stat = statFile(output);
  if (!stat) return false;
  downloaded.set(path.resolve(output), { runId, output, size: stat.size, mtimeMs: stat.mtimeMs });
  return true;
}

function stillSame(entry: Downloaded): boolean {
  const stat = statFile(entry.output);
  return Boolean(stat && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs);
}

/**
 * The run's result in `dir`, when BotBoy already has it (taken in whole and unchanged) or is still receiving it there, under
 * any file name: every caller for the run in that folder shares one download (the chat tool writes run_<id>.tsv, the
 * runners adhoc_<id>.tsv). A file that has landed is taken here, whoever started its download; an expired wait is left to
 * the read that started it, which reports it (downloadResult).
 */
export function knownResult(runId: string, dir: string, now: () => number = Date.now): DownloadOutcome | null {
  const folder = path.resolve(dir);
  const inFolder = (output: string) => path.dirname(path.resolve(output)) === folder;
  for (const entry of downloaded.values()) {
    if (entry.runId !== runId || !inFolder(entry.output)) continue;
    if (stillSame(entry)) return { state: 'downloaded', output: entry.output, reused: true };
  }
  for (const [key, landing] of landings) {
    if (landing.runId !== runId || !inFolder(landing.output)) continue;
    const t = now();
    const state = checkLanding(landing, t);
    if (state === 'expired') continue;
    if (state === 'landed') {
      landings.delete(key);
      if (remember(landing.runId, landing.output)) return { state: 'downloaded', output: landing.output, reused: false };
      continue;
    }
    return { state: 'landing', output: landing.output, startedAt: landing.startedAt, sinceMs: Math.max(0, t - landing.startedAt) };
  }
  return null;
}

/**
 * One download of a run's result into `output`, shared by every caller. `download` is one call of the connector's
 * `datanet_download_results` for exactly this file.
 */
export async function downloadResult(input: {
  runId: string;
  output: string;
  download: () => Promise<{ isError: boolean; text: string }>;
  now?: () => number;
}): Promise<DownloadOutcome> {
  const now = input.now ?? Date.now;
  const key = path.resolve(input.output);
  const done = downloaded.get(key);
  if (done) {
    if (stillSame(done)) return { state: 'downloaded', output: input.output, reused: true };
    downloaded.delete(key); // changed or removed since: a fresh download
  }
  const waiting = landings.get(key);
  if (waiting) {
    const state = checkLanding(waiting, now());
    if (state === 'landed') {
      landings.delete(key);
      remember(input.runId, input.output);
      return { state: 'downloaded', output: input.output, reused: false };
    }
    if (state === 'waiting') return { state: 'landing', output: input.output, startedAt: waiting.startedAt, sinceMs: Math.max(0, now() - waiting.startedAt) };
    landings.delete(key);
    return {
      state: 'failed',
      output: input.output,
      expired: true,
      error: `no file arrived within ${Math.round(DOWNLOAD_LANDING_WINDOW_MS / 60_000)} minutes of the download starting (the connector's background download never wrote it)`,
    };
  }
  // Registered before the call, so a caller that comes in meanwhile waits for this download instead of starting its own.
  const landing: Landing = { runId: input.runId, output: input.output, startedAt: now() };
  landings.set(key, landing);
  let reply: { isError: boolean; text: string };
  try {
    reply = await input.download();
  } catch (error) {
    if (landings.get(key) === landing) landings.delete(key);
    throw error;
  }
  if (isDownloadTimeout(reply.text)) {
    if (landings.get(key) === landing) checkLanding(landing, now()); // a file written meanwhile starts its settle time now
    return { state: 'landing', output: input.output, startedAt: landing.startedAt, sinceMs: Math.max(0, now() - landing.startedAt) };
  }
  if (landings.get(key) === landing) landings.delete(key);
  if (reply.isError) return { state: 'failed', output: input.output, error: oneLine(reply.text) };
  if (!remember(input.runId, input.output)) {
    return { state: 'failed', output: input.output, error: `the connector wrote no file (${oneLine(reply.text, 200)})` };
  }
  return { state: 'downloaded', output: input.output, reused: false };
}

/** The model-facing words for a result that is still landing. */
export function landingError(runId: string, sinceMs: number): string {
  const minutes = Math.max(1, Math.round(sinceMs / 60_000));
  return `Run ${runId} succeeded and its result is still downloading (${minutes} min so far). Datanet's connector stops waiting after 5 minutes, but it finishes a large download in the background and writes the file once every part has arrived.`;
}

export function landingNextAction(runId: string): string {
  return `Do not download it again or resubmit the run. BotBoy keeps checking for the file and continues the job when it lands; to use it in this turn, call wait_for {"kind":"etl_run","id":"${runId}","waitSeconds":300}.`;
}

export interface ResultFileSummary {
  columns: string[];
  /** The first `maxRows` rows, split on tabs. */
  rows: string[][];
  /** Non-empty lines after the header. */
  rowCount: number;
  truncated: boolean;
  bytes: number;
  sha256: string;
}

/**
 * One streaming pass over a downloaded TSV: the same header, preview rows, row count, size and SHA-256 that reading it whole
 * and splitting on "\n" gave (empty lines skipped), in bounded memory. Lines split on the byte 0x0A, which never occurs
 * inside a UTF-8 sequence, so this matches splitting the decoded text.
 */
export async function summarizeResultFile(file: string, maxRows: number, options: { chunkBytes?: number } = {}): Promise<ResultFileSummary> {
  const hash = createHash('sha256');
  const keepRows = Math.max(0, Math.floor(maxRows));
  let header: string | null = null;
  const rows: string[][] = [];
  let rowCount = 0;
  let bytes = 0;
  // The line being read: its length so far, and its bytes while it is one BotBoy keeps (the header or a preview row).
  let lineLength = 0;
  let parts: Buffer[] = [];
  let kept = 0;
  const keeping = () => header === null || rows.length < keepRows;
  const endLine = () => {
    if (lineLength > 0) {
      if (header === null) header = Buffer.concat(parts).toString('utf8');
      else {
        rowCount += 1;
        if (rows.length < keepRows) rows.push(Buffer.concat(parts).toString('utf8').split('\t'));
      }
    }
    lineLength = 0;
    parts = [];
    kept = 0;
  };
  const keepPart = (chunk: Buffer, start: number, end: number) => {
    if (end <= start || !keeping() || kept >= MAX_PREVIEW_LINE_BYTES) return;
    const slice = chunk.subarray(start, Math.min(end, start + (MAX_PREVIEW_LINE_BYTES - kept)));
    parts.push(Buffer.from(slice)); // a copy: the stream reuses nothing, but a slice would pin the whole chunk
    kept += slice.length;
  };
  const stream = fs.createReadStream(file, { highWaterMark: options.chunkBytes ?? 1 << 20 });
  for await (const data of stream) {
    const chunk = data as Buffer;
    hash.update(chunk);
    bytes += chunk.length;
    let start = 0;
    for (let newline = chunk.indexOf(10, start); newline !== -1; newline = chunk.indexOf(10, start)) {
      lineLength += newline - start;
      keepPart(chunk, start, newline);
      endLine();
      start = newline + 1;
    }
    lineLength += chunk.length - start;
    keepPart(chunk, start, chunk.length);
  }
  endLine();
  return {
    columns: (header ?? '').split('\t'),
    rows,
    rowCount,
    truncated: rowCount > keepRows,
    bytes,
    sha256: hash.digest('hex'),
  };
}

/** The first `maxLines` lines of a file, read from at most `maxBytes` of it: a preview never reads a whole result. */
export function readHeadLines(file: string, maxLines: number, maxBytes = 64 * 1024): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    // A full window may end inside a line: that last piece is not a line.
    if (read === maxBytes && lines.length > 1) lines.pop();
    return lines.slice(0, maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/** For tests: forget every download. */
export function resetEtlDownloadsForTests(): void {
  landings.clear();
  downloaded.clear();
}
