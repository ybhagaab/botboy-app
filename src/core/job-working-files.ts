/**
 * A job deletes its own working files (owner approval 2026-10-29; docs/maps/job-continuations.md › "Disk").
 *
 * Big data work fits the Mac's disk by taking one part at a time and compressing each part; the raw copy then only takes
 * space (job #3 kept a 1.8 GB raw export beside its 1.0 GB gzip copy, believing it could not delete files). A job may delete
 * such a file itself, and nothing else:
 *   - the file is a regular file inside the files workspace (links resolved, no folders),
 *   - it was made since the job started (a result the job downloaded, or a file it wrote),
 *   - its gzip copy, also in the files workspace, holds exactly the same bytes: BotBoy decompresses it and compares the size
 *     and SHA-256 with the file itself before anything is deleted, and the file must not change while it is checked.
 * In an automatic job turn this is the only way to delete a file (job-mandate.ts refuses deleting commands in run_command).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';

export const JOB_WORKING_FILE_TOOL_NAMES = ['delete_working_file'] as const;
/** The verification streams two files of up to a few GB: the executor allows this long. */
export const DELETE_WORKING_FILE_TIMEOUT_MS = 10 * 60_000;
/** File times and the job's start come from one machine; this only absorbs rounding. */
const CLOCK_SLACK_MS = 2_000;

export type DeleteWorkingFileCode =
  | 'not_in_workspace' | 'not_a_file' | 'not_made_in_this_job' | 'copy_not_gzip' | 'copy_differs' | 'changed_while_checked' | 'stopped' | 'delete_failed';

export type DeleteWorkingFileResult =
  | { ok: true; deleted: string; keptCopy: string; bytesFreed: number; sha256: string; freeBytesAfter: number | null }
  | { ok: false; code: DeleteWorkingFileCode; error: string; nextAction: string };

type Refusal = Extract<DeleteWorkingFileResult, { ok: false }>;
const refuse = (code: DeleteWorkingFileCode, error: string, nextAction: string): Refusal => ({ ok: false, code, error, nextAction });

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** A path the model gave, as the real file inside the files workspace, or why not. */
function resolveInWorkspace(root: string, given: unknown): { real: string; shown: string } | { error: Refusal } {
  const raw = String(given ?? '').trim();
  if (!raw) return { error: refuse('not_a_file', 'No file was named.', 'Give the path of the file in the files workspace.') };
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
  let link: fs.Stats;
  let real: string;
  try {
    link = fs.lstatSync(absolute);
    real = fs.realpathSync.native(absolute);
  } catch {
    return { error: refuse('not_a_file', `${raw} does not exist.`, 'Check the path (relative to the files workspace) and try again.') };
  }
  if (!within(root, real)) {
    return { error: refuse('not_in_workspace', `${raw} is outside BotBoy's files workspace.`, 'Only a job\'s own working files in the files workspace can be deleted; leave this file for the owner.') };
  }
  if (link.isSymbolicLink() || !fs.statSync(real).isFile()) {
    return { error: refuse('not_a_file', `${raw} is not a plain file (a folder or a link).`, 'Name one regular file; folders and links are never deleted.') };
  }
  return { real, shown: path.relative(root, real) };
}

async function digest(source: Readable, signal?: AbortSignal): Promise<{ bytes: number; sha256: string } | 'stopped'> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of source) {
    if (signal?.aborted) {
      source.destroy();
      return 'stopped';
    }
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

function gunzipped(file: string): Readable {
  const gunzip = createGunzip();
  const reader = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  reader.on('error', error => gunzip.destroy(error));
  return reader.pipe(gunzip);
}

function freeBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export async function deleteWorkingFile(input: {
  /** BotBoy's files workspace (~/.personal-productivity-tracker/files). */
  filesDir: string;
  /** When the job started (ISO): only a file made since then is the job's own. */
  jobStartedAt: string;
  path: unknown;
  keptCopy: unknown;
  signal?: AbortSignal;
}): Promise<DeleteWorkingFileResult> {
  let root: string;
  try {
    root = fs.realpathSync.native(input.filesDir);
  } catch {
    return refuse('not_in_workspace', 'BotBoy\'s files workspace is missing.', 'Keep the file; nothing was deleted.');
  }
  const target = resolveInWorkspace(root, input.path);
  if ('error' in target) return target.error;
  const copy = resolveInWorkspace(root, input.keptCopy);
  if ('error' in copy) return { ...copy.error, nextAction: `${copy.error.nextAction} The copy must be the file's gzip copy (.gz) in the files workspace.` };
  if (!/\.gz$/i.test(copy.real) || copy.real === target.real) {
    return refuse('copy_not_gzip', `${copy.shown} is not a gzip copy (.gz) of ${target.shown}.`, `Compress it first (for example gzip -k ${target.shown}), then name the .gz file as keptCopy.`);
  }
  const before = fs.statSync(target.real);
  const startedAt = Date.parse(input.jobStartedAt);
  const born = before.birthtimeMs > 0 ? before.birthtimeMs : Number.NaN;
  if (!Number.isFinite(startedAt) || !(born >= startedAt - CLOCK_SLACK_MS)) {
    return refuse('not_made_in_this_job', `${target.shown} was not made during this job (it existed before the job started).`, 'Only files this job downloaded or wrote can be deleted; leave this one for the owner.');
  }
  let original: { bytes: number; sha256: string } | 'stopped';
  let unpacked: { bytes: number; sha256: string } | 'stopped';
  try {
    [original, unpacked] = await Promise.all([
      digest(fs.createReadStream(target.real, { highWaterMark: 1 << 20 }), input.signal),
      digest(gunzipped(copy.real), input.signal),
    ]);
  } catch (error: any) {
    return refuse('copy_differs', `${copy.shown} could not be read as gzip (${String(error?.message ?? error).slice(0, 160)}).`, `Make a fresh copy (gzip -k ${target.shown}) and try again; ${target.shown} was not deleted.`);
  }
  if (original === 'stopped' || unpacked === 'stopped') return refuse('stopped', 'The turn stopped while the copy was checked.', 'Nothing was deleted.');
  if (original.bytes !== unpacked.bytes || original.sha256 !== unpacked.sha256) {
    return refuse('copy_differs', `${copy.shown} does not hold the same bytes as ${target.shown} (${unpacked.bytes} bytes decompressed vs ${original.bytes}).`, `Make a fresh copy (gzip -k ${target.shown}) and try again; ${target.shown} was not deleted.`);
  }
  const after = fs.statSync(target.real);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    return refuse('changed_while_checked', `${target.shown} changed while its copy was checked.`, 'Wait until nothing writes to it, compress it again, and try again; nothing was deleted.');
  }
  try {
    fs.unlinkSync(target.real);
  } catch (error: any) {
    return refuse('delete_failed', `${target.shown} could not be deleted (${String(error?.code ?? error?.message ?? error)}).`, 'Keep it; tell the owner if the disk is short.');
  }
  return {
    ok: true,
    deleted: target.shown,
    keptCopy: copy.shown,
    bytesFreed: before.size,
    sha256: original.sha256,
    freeBytesAfter: freeBytes(root),
  };
}
